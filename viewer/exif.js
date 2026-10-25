/**
 * Just enough EXIF to pin a photo on the map before it has been uploaded.
 *
 * The desktop re-reads every file with Pillow when it ingests it and wins any
 * disagreement, so this is not the authority on anything. It exists so the pin
 * appears the moment you pick the photo, and so a photo whose original never
 * makes it across still has coordinates.
 *
 * It mirrors backend/photometa.py deliberately and in detail - the same tags,
 * the same rejections, the same clock. Where the two could differ they would
 * differ silently, which is the worst kind of bug this file can have:
 *
 *   - a capture time is a naive wall clock with no zone, and photometa.wall_ts
 *     normalises it through UTC (calendar.timegm) so a photo taken at 15:00
 *     reads back as 15:00 wherever it was shot. Date.UTC here, never local
 *     parsing, or every phone photo lands in the timeline offset by the phone's
 *     own timezone;
 *   - (0, 0) is a missing fix, not a location, and is rejected;
 *   - a fix outside -90..90 / -180..180 is rejected.
 *
 * What it does NOT handle: HEIC/AVIF (ISO-BMFF, not JPEG APP1), PNG, TIFF and
 * anything else that is not a JPEG. Those return null, the photo uploads
 * anyway, and its real coordinates arrive when the desktop ingests it.
 */
const GPS_IFD = 0x8825;
const EXIF_IFD = 0x8769;
const TAG_DATETIME = 306;
const TAG_DT_ORIGINAL = 36867;
const TAG_DT_DIGITIZED = 36868;

// EXIF value types, by byte width. 5 and 10 are RATIONAL pairs, handled apart.
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function ascii(view, offset, length) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

/** Walk the JPEG segment chain to the TIFF header inside APP1. */
function findTiff(view) {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return -1;  // not a JPEG
  let p = 2;
  while (p + 4 <= view.byteLength) {
    if (view.getUint8(p) !== 0xFF) return -1;
    const marker = view.getUint8(p + 1);
    // Start of scan or end of image: the metadata is behind us and the rest is
    // pixels, which can contain anything that looks like a marker.
    if (marker === 0xDA || marker === 0xD9) return -1;
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { p += 2; continue; }
    const length = view.getUint16(p + 2);
    if (length < 2) return -1;
    if (marker === 0xE1 && p + 10 <= view.byteLength && ascii(view, p + 4, 6) === 'Exif\0\0') {
      return p + 10;
    }
    p += 2 + length;
  }
  return -1;
}

function readValue(view, entry, tiff, little) {
  const type = view.getUint16(entry + 2, little);
  const count = view.getUint32(entry + 4, little);
  const width = TYPE_SIZE[type];
  if (!width || count === 0 || count > 0xFFFF) return null;

  const bytes = width * count;
  // Anything over four bytes lives elsewhere, at an offset from the TIFF header
  // rather than from the file - the single most common way to get this wrong.
  let at = entry + 8;
  if (bytes > 4) {
    at = tiff + view.getUint32(entry + 8, little);
    if (at < 0 || at + bytes > view.byteLength) return null;
  }

  if (type === 2) return ascii(view, at, count).replace(/\0.*$/, '');
  if (type === 5 || type === 10) {
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const num = little ? view.getUint32(at + i * 8, true) : view.getUint32(at + i * 8, false);
      const den = little ? view.getUint32(at + i * 8 + 4, true) : view.getUint32(at + i * 8 + 4, false);
      out.push(den === 0 ? 0 : num / den);           // matches ZeroDivisionError -> skip
    }
    return out;
  }
  if (type === 3) return view.getUint16(at, little);
  if (type === 4) return view.getUint32(at, little);
  if (type === 1 || type === 7) return view.getUint8(at);
  return null;
}

function readIfd(view, tiff, offset, little) {
  const out = {};
  if (offset < 0 || offset + 2 > view.byteLength) return out;
  const count = view.getUint16(offset, little);
  for (let i = 0; i < count; i += 1) {
    const entry = offset + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;
    out[view.getUint16(entry, little)] = readValue(view, entry, tiff, little);
  }
  return out;
}

/** deg + min/60 + sec/3600, as photometa._to_degrees does it.
 *
 *  Returned as a magnitude, with the hemisphere left to the Ref tags, which is
 *  what the format intends: a GPS rational is unsigned and "west" lives in
 *  GPSLongitudeRef, not in a minus sign. Some encoders write a negative degree
 *  anyway, and since the field is unsigned that arrives as a number just under
 *  2^32 - which sails past every range check as nonsense rather than as the
 *  west it meant. Reading it back as signed costs nothing for a correct file,
 *  where no component is ever anywhere near that big. */
function toDegrees(value) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const signed = (n) => (n >= 2147483648 ? n - 4294967296 : n);
  const [d, m, s] = value.map(signed);
  if (![d, m, s].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return Math.abs(d) + Math.abs(m) / 60 + Math.abs(s) / 3600;
}

/**
 * Mirrors photometa._parse_dt, including the shape of its failure.
 *
 * Python tries strptime("%Y:%m:%d %H:%M:%S") on the first 19 characters and,
 * on ANY failure, falls back to strptime("%Y:%m:%d") on the first 10 - so
 * "2021:06:04T15:00:00" parses as midnight, not as 15:00, because the format
 * has a literal space that a T does not match. Returning 15:00 here would be a
 * silent fifteen-hour disagreement with the desktop, so the separator is a
 * literal space and nothing else.
 */
function parseDT(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/\0/g, '').replace(/[/-]/g, ':').trim();
  if (!text || text.startsWith('0000')) return null;

  const full = /^(\d{4}):(\d{1,2}):(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})/.exec(text.slice(0, 19));
  if (full) {
    const ts = utc(+full[1], +full[2], +full[3], +full[4], +full[5], +full[6]);
    if (ts !== null) return ts;
  }
  const dateOnly = /^(\d{4}):(\d{1,2}):(\d{1,2})/.exec(text.slice(0, 10));
  if (!dateOnly) return null;
  return utc(+dateOnly[1], +dateOnly[2], +dateOnly[3], 0, 0, 0);
}

/** Date.UTC plus a round trip, so 2025:02:30 is rejected rather than rolled
 *  forward to 2 March the way Date.UTC would do on its own. strptime raises. */
function utc(y, mo, d, h, mi, s) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return Math.floor(ms / 1000);
}

/** Returns {lat, lon, altitude, taken_ts}, any of which may be null, or null
 *  if this is not a JPEG or carries no EXIF at all. */
function parseExifBuffer(buffer) {
  const view = new DataView(buffer);
  const tiff = findTiff(view);
  if (tiff < 0 || tiff + 8 > view.byteLength) return null;

  const order = view.getUint16(tiff, false);
  if (order !== 0x4949 && order !== 0x4D4D) return null;   // not II or MM
  const little = order === 0x4949;
  if (view.getUint16(tiff + 2, little) !== 42) return null;

  const ifd0 = readIfd(view, tiff, tiff + view.getUint32(tiff + 4, little), little);
  const sub = ifd0[EXIF_IFD] ? readIfd(view, tiff, tiff + ifd0[EXIF_IFD], little) : {};
  const gps = ifd0[GPS_IFD] ? readIfd(view, tiff, tiff + ifd0[GPS_IFD], little) : {};

  // `gps` is not a value, it is evidence about why there is no value:
  //
  //   absent      no GPS block at all - nothing ever wrote one
  //   zeroed      the block is there and its coordinates are exactly 0/0
  //   unreadable  the block is there and the coordinates would not parse
  //   ok          real coordinates, whatever the sanity checks then make of them
  //
  // `zeroed` is the one that names a cause. A camera does not write zeros, and a
  // photo taken without a fix does not get a block; zeros in place are what a
  // system writes when it blanks a location but must leave every byte offset in
  // the file where it was. That is exactly what Android does to a photo handed to
  // an app that may not see locations, and it is indistinguishable from "no fix"
  // unless the difference is looked for.
  const out = { lat: null, lon: null, altitude: null, taken_ts: null, gps: 'absent' };
  out.taken_ts = parseDT(sub[TAG_DT_ORIGINAL])
    ?? parseDT(sub[TAG_DT_DIGITIZED])
    ?? parseDT(ifd0[TAG_DATETIME]);

  let lat = toDegrees(gps[2]);
  let lon = toDegrees(gps[4]);
  if (!Object.keys(gps).length) out.gps = 'absent';
  else if (lat === null || lon === null) out.gps = 'unreadable';
  else if (lat === 0 && lon === 0) out.gps = 'zeroed';
  else out.gps = 'ok';

  if (lat !== null && lon !== null) {
    if (String(gps[1] || 'N').trim().toUpperCase().startsWith('S')) lat = -lat;
    if (String(gps[3] || 'E').trim().toUpperCase().startsWith('W')) lon = -lon;
    const sane = lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    // Null island is a missing fix, not a location - photometa rejects it and
    // so must this, or the map grows a pin off the coast of West Africa.
    if (sane && !(lat === 0 && lon === 0)) {
      out.lat = lat;
      out.lon = lon;
      const alt = Array.isArray(gps[6]) ? gps[6][0] : gps[6];
      if (typeof alt === 'number' && Number.isFinite(alt)) {
        out.altitude = Number(gps[5]) === 1 ? -alt : alt;
      }
    }
  }
  return out;
}

/** EXIF sits at the front of the file, so a slice is enough and a 50MB photo
 *  never has to be held in memory twice to find out where it was taken. */
async function readExif(file) {
  try {
    const head = await file.slice(0, 256 * 1024).arrayBuffer();
    return parseExifBuffer(head);
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------- video
//
// The same job for a clip, and the same mirroring rule: this reads exactly what
// backend/videometa.py reads, rejects exactly what it rejects, and stores the
// wall clock on the same scale, because where the two could differ they would
// differ silently.
//
// A video's metadata lives in its `moov` box, which sits at either end of the
// file - at the front in a finished recording, at the back in one written
// straight off a camera - so the top level is walked by its own box sizes
// rather than searched for. Only `moov` is ever read: a 200MB clip costs a
// couple of small reads to find out where and when it was taken.

const MOOV_MAX = 32 * 1024 * 1024;
const EPOCH_1904 = 2082844800;
const V_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'udta', 'meta', 'ilst']);
const V_WANTED = new Set(['mvhd', 'loci', '\xA9xyz', '\xA9day', 'data']);
const ISO6709 = /^([+-]\d{1,3}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)/;

const boxType = (view, at) => String.fromCharCode(
  view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3),
);

const printableType = (name) => [...name].every((c) => {
  const code = c.charCodeAt(0);
  return (code >= 0x20 && code <= 0x7E) || code === 0xA9;
});

/** `meta` is a full box in ISO and a plain one in QuickTime: four bytes of
 *  version and flags are there in an .mp4 and absent in a .mov, and reading the
 *  wrong one loses the whole subtree in silence. Which it is can be looked at. */
function metaSkip(view, start, end) {
  for (const skip of [4, 0]) {
    const at = start + skip;
    if (at + 8 <= end && printableType(boxType(view, at + 4))) return skip;
  }
  return 4;
}

function walkBoxes(view, start, end, depth, out) {
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at);
    const kind = boxType(view, at + 4);
    let head = 8;
    if (size === 1) {
      if (at + 16 > end) return;
      // Read as two 32-bit halves: the value cannot exceed MOOV_MAX by the time
      // it is used, so there is nothing to gain from a BigInt round trip.
      size = view.getUint32(at + 8) * 4294967296 + view.getUint32(at + 12);
      head = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < head || at + size > end) return;
    const body = [at + head, at + size];
    if (V_WANTED.has(kind)) (out[kind] = out[kind] || []).push(body);
    if (V_CONTAINERS.has(kind) && depth < 8) {
      const child = body[0] + (kind === 'meta' ? metaSkip(view, body[0], body[1]) : 0);
      walkBoxes(view, child, body[1], depth + 1, out);
    }
    at += size;
  }
}

function boxText(view, span, inIlst) {
  const [rawStart, end] = span;
  const start = rawStart + (inIlst ? 8 : 4);
  if (start >= end) return '';
  let out = '';
  for (let i = start; i < end; i += 1) out += String.fromCharCode(view.getUint8(i));
  try {
    out = decodeURIComponent(escape(out));   // the bytes are UTF-8
  } catch {
    /* not UTF-8: what was read is close enough for a coordinate string */
  }
  return out.replace(/\0/g, '').trim();
}

function fromIso6709(text) {
  const match = ISO6709.exec(text || '');
  if (!match) return null;
  return { lat: Number(match[1]), lon: Number(match[2]) };
}

/** 3GPP's own location box: version and flags, a language code, a
 *  null-terminated name, a role byte, then longitude, latitude and altitude as
 *  16.16 fixed point - the opposite order from every other box here. */
function fromLoci(view, span) {
  const [start, end] = span;
  let at = start + 4 + 2;
  while (at < end && view.getUint8(at) !== 0) at += 1;
  at += 2;  // the terminator, then the role byte
  if (at + 12 > end) return null;
  return { lon: view.getInt32(at) / 65536, lat: view.getInt32(at + 4) / 65536 };
}

/** Apple's `©day`: an ISO 8601 stamp carrying the phone's own offset. The
 *  offset is read and then thrown away, because this app stores the wall clock
 *  that was on the device - a clip shot at 15:00 reads back as 15:00 anywhere. */
function parseDay(text) {
  const m = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(text || '');
  if (!m) return null;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000);
}

function parseMvhd(view, span) {
  const [start, end] = span;
  if (start + 4 > end) return {};
  const version = view.getUint8(start);
  try {
    if (version === 1) {
      return {
        created: view.getUint32(start + 4) * 4294967296 + view.getUint32(start + 8),
        scale: view.getUint32(start + 20),
        length: view.getUint32(start + 24) * 4294967296 + view.getUint32(start + 28),
      };
    }
    return {
      created: view.getUint32(start + 4),
      scale: view.getUint32(start + 12),
      length: view.getUint32(start + 16),
    };
  } catch {
    return {};
  }
}

/** Read the file's top level until `moov`, and return it as a DataView. */
async function findMoov(file) {
  let at = 0;
  while (at + 8 <= file.size) {
    const header = new DataView(await file.slice(at, at + 16).arrayBuffer());
    if (header.byteLength < 8) return null;
    let size = header.getUint32(0);
    const kind = boxType(header, 4);
    let head = 8;
    if (size === 1) {
      if (header.byteLength < 16) return null;
      size = header.getUint32(8) * 4294967296 + header.getUint32(12);
      head = 16;
    } else if (size === 0) {
      size = file.size - at;
    }
    if (size < head || at + size > file.size) return null;
    if (kind === 'moov') {
      if (size - head > MOOV_MAX) return null;
      return new DataView(await file.slice(at + head, at + size).arrayBuffer());
    }
    at += size;
  }
  return null;
}

/** What a video says about itself: where, when, and how long.
 *
 *  Shaped like readExif's answer, plus `duration`, so a caller does not have to
 *  care which of the two it called. `gps` names why there is no fix, drawing the
 *  same distinction the photo reader draws, because the reasons want different
 *  reactions: `absent` is a clip recorded with location off, and `zeroed` is one
 *  whose coordinates were blanked on the way out of the phone.
 */
async function readVideoMeta(file) {
  let view = null;
  try {
    view = await findMoov(file);
  } catch {
    return null;
  }
  if (!view) return null;

  const boxes = {};
  try {
    walkBoxes(view, 0, view.byteLength, 0, boxes);
  } catch {
    return null;
  }

  const out = { taken_ts: null, lat: null, lon: null, duration: null, gps: 'absent' };
  const header = boxes.mvhd ? parseMvhd(view, boxes.mvhd[0]) : {};
  if (header.scale && header.length) out.duration = header.length / header.scale;

  let fix = null;
  let sawBox = false;
  for (const span of boxes['\xA9xyz'] || []) {
    sawBox = true;
    fix = fix || fromIso6709(boxText(view, span, false));
  }
  for (const span of boxes.data || []) {
    const text = boxText(view, span, true);
    if (ISO6709.test(text)) { sawBox = true; fix = fix || fromIso6709(text); }
  }
  for (const span of boxes.loci || []) {
    sawBox = true;
    fix = fix || fromLoci(view, span);
  }
  if (fix && Number.isFinite(fix.lat) && Number.isFinite(fix.lon)) {
    const sane = fix.lat >= -90 && fix.lat <= 90 && fix.lon >= -180 && fix.lon <= 180;
    if (fix.lat === 0 && fix.lon === 0) out.gps = 'zeroed';
    else if (!sane) out.gps = 'ok';        // present and refused, as a photo's is
    else { out.lat = fix.lat; out.lon = fix.lon; out.gps = 'ok'; }
  } else if (sawBox) {
    out.gps = 'unreadable';
  }

  for (const span of boxes['\xA9day'] || []) {
    const stamp = parseDay(boxText(view, span, false));
    if (stamp) { out.taken_ts = stamp; break; }
  }
  if (out.taken_ts === null && header.created > EPOCH_1904) {
    out.taken_ts = header.created - EPOCH_1904;
  }
  return out;
}
