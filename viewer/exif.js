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

/** deg + min/60 + sec/3600, as photometa._to_degrees does it. */
function toDegrees(value) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const [d, m, s] = value;
  if (![d, m, s].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return d + m / 60 + s / 3600;
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

  // `gps` is not a value, it is evidence: whether the file carries a GPS block
  // at all. A photo taken without a fix has the block with nothing usable in it;
  // a photo whose location was removed on the way out of a picker has no block.
  // Both read as "no coordinates", and they want completely different answers,
  // so the difference is reported rather than flattened.
  const out = { lat: null, lon: null, altitude: null, taken_ts: null, gps: false };
  out.taken_ts = parseDT(sub[TAG_DT_ORIGINAL])
    ?? parseDT(sub[TAG_DT_DIGITIZED])
    ?? parseDT(ifd0[TAG_DATETIME]);

  out.gps = Object.keys(gps).length > 0;
  let lat = toDegrees(gps[2]);
  let lon = toDegrees(gps[4]);
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
