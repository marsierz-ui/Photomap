/**
 * The viewer's EXIF reader against backend/photometa.py's behaviour.
 *
 * Fixtures are assembled here as byte arrays rather than checked in as image
 * files, so there is nothing binary in the repo and every field is visible in
 * the test that depends on it.
 *
 *   node tests/test_exif.mjs
 */
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('../viewer/exif.js', import.meta.url), 'utf8');
const { parseExifBuffer, parseDT } = await import(
  `data:text/javascript,${encodeURIComponent(`${src}\nexport { parseExifBuffer, parseDT };`)}`
);

const results = [];
function check(label, condition, detail = '') {
  results.push({ label, ok: !!condition });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
}

// --------------------------------------------------------------- fixture build

/** One IFD entry: tag, type, count, and either an inline value or an offset. */
function entry(bytes, little, tag, type, count, value) {
  const b = new DataView(new ArrayBuffer(12));
  b.setUint16(0, tag, little);
  b.setUint16(2, type, little);
  b.setUint32(4, count, little);
  b.setUint32(8, value, little);
  return new Uint8Array(b.buffer);
}

/** An entry whose value fits in the four-byte field and is therefore stored
 *  there rather than at an offset - which is how a real encoder writes
 *  GPSLatitudeRef ("N\0"), and the case the reader has to get right. */
function entryInline(little, tag, type, count, raw) {
  const out = entry(null, little, tag, type, count, 0);
  out.set(raw.slice(0, 4), 8);
  return out;
}

/**
 * A JPEG carrying one APP1/TIFF block: IFD0 (with pointers to the Exif SubIFD
 * and the GPS IFD), the SubIFD and the GPS IFD, plus a heap for the values that
 * do not fit in four bytes.
 */
function buildJpeg({ little = true, lat, lon, latRef = 'N', lonRef = 'E', dtOriginal,
                     dtDigitized, dateTime } = {}) {
  const heap = [];
  let heapAt = 0;
  const push = (bytes) => {
    const at = heapAt;
    heap.push(bytes);
    heapAt += bytes.length;
    return at;
  };
  const rational = (triple) => {
    const b = new DataView(new ArrayBuffer(24));
    triple.forEach(([n, d], i) => {
      b.setUint32(i * 8, n, little);
      b.setUint32(i * 8 + 4, d, little);
    });
    return push(new Uint8Array(b.buffer));
  };
  const str = (text) => push(new TextEncoder().encode(`${text}\0`));
  const dms = (deg) => {
    const d = Math.floor(deg);
    const m = Math.floor((deg - d) * 60);
    const s = Math.round(((deg - d) * 60 - m) * 60 * 100);
    return [[d, 1], [m, 1], [s, 100]];
  };

  const gps = [];
  if (lat !== undefined) {
    // The two refs are ASCII count 2, so they go inline; the coordinates are
    // three rationals each at 24 bytes, so they go on the heap.
    gps.push(['ref1', 2, 2, new TextEncoder().encode(`${latRef}\0`), true]);
    gps.push(['lat', 5, 3, rational(dms(Math.abs(lat)))]);
    gps.push(['ref3', 2, 2, new TextEncoder().encode(`${lonRef}\0`), true]);
    gps.push(['lon', 5, 3, rational(dms(Math.abs(lon)))]);
  }
  const sub = [];
  if (dtOriginal) sub.push([36867, 2, dtOriginal.length + 1, str(dtOriginal)]);
  if (dtDigitized) sub.push([36868, 2, dtDigitized.length + 1, str(dtDigitized)]);

  // Layout after the 8-byte TIFF header: IFD0, SubIFD, GPS IFD, then the heap.
  const ifd0Count = 1 + (sub.length ? 1 : 0) + (gps.length ? 1 : 0) + (dateTime ? 1 : 0);
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const subSize = sub.length ? 2 + sub.length * 12 + 4 : 0;
  const gpsSize = gps.length ? 2 + gps.length * 12 + 4 : 0;
  const ifd0At = 8;
  const subAt = ifd0At + ifd0Size;
  const gpsAt = subAt + subSize;
  const heapAtAbs = gpsAt + gpsSize;

  const parts = [];
  const header = new DataView(new ArrayBuffer(8));
  header.setUint16(0, little ? 0x4949 : 0x4D4D, false);
  header.setUint16(2, 42, little);
  header.setUint32(4, ifd0At, little);
  parts.push(new Uint8Array(header.buffer));

  const ifd0 = [];
  // 271 Make, an ordinary inline-ish entry so IFD0 is never empty.
  ifd0.push(entry(null, little, 271, 2, 6, heapAtAbs + str('Test')));
  if (dateTime) ifd0.push(entry(null, little, 306, 2, dateTime.length + 1, heapAtAbs + str(dateTime)));
  if (sub.length) ifd0.push(entry(null, little, 0x8769, 4, 1, subAt));
  if (gps.length) ifd0.push(entry(null, little, 0x8825, 4, 1, gpsAt));

  const block = (entries) => {
    const head = new DataView(new ArrayBuffer(2));
    head.setUint16(0, entries.length, little);
    const tail = new Uint8Array(4);
    return [new Uint8Array(head.buffer), ...entries, tail];
  };
  parts.push(...block(ifd0));
  if (sub.length) {
    parts.push(...block(sub.map(([t, ty, c, off]) => entry(null, little, t, ty, c, heapAtAbs + off))));
  }
  if (gps.length) {
    const tags = { ref1: 1, lat: 2, ref3: 3, lon: 4 };
    parts.push(...block(gps.map(([n, ty, c, off, inline]) => (inline
      ? entryInline(little, tags[n], ty, c, off)
      : entry(null, little, tags[n], ty, c, heapAtAbs + off)))));
  }
  parts.push(...heap);

  const tiff = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  parts.forEach((p) => { tiff.set(p, at); at += p.length; });

  const app1Len = 2 + 6 + tiff.length;
  const out = new Uint8Array(2 + 2 + app1Len + 2);
  const d = new DataView(out.buffer);
  d.setUint16(0, 0xFFD8, false);              // SOI
  d.setUint16(2, 0xFFE1, false);              // APP1
  d.setUint16(4, app1Len, false);
  out.set(new TextEncoder().encode('Exif\0\0'), 6);
  out.set(tiff, 12);
  d.setUint16(out.length - 2, 0xFFD9, false); // EOI
  return out.buffer;
}

// ------------------------------------------------------------------- position

const near = (a, b, eps = 1e-4) => a !== null && Math.abs(a - b) < eps;

let r = parseExifBuffer(buildJpeg({ lat: 51.5074, lon: 0.1278 }));
check('little-endian GPS reads back', near(r?.lat, 51.5074) && near(r?.lon, 0.1278),
      `${r?.lat}, ${r?.lon}`);

r = parseExifBuffer(buildJpeg({ little: false, lat: 51.5074, lon: 0.1278 }));
check('big-endian gives the same answer', near(r?.lat, 51.5074) && near(r?.lon, 0.1278),
      `${r?.lat}, ${r?.lon}`);

r = parseExifBuffer(buildJpeg({ lat: 33.8688, lon: 151.2093, latRef: 'S', lonRef: 'E' }));
check('S ref makes the latitude negative', near(r?.lat, -33.8688), `${r?.lat}`);

r = parseExifBuffer(buildJpeg({ lat: 40.7128, lon: 74.006, latRef: 'N', lonRef: 'W' }));
check('W ref makes the longitude negative', near(r?.lon, -74.006), `${r?.lon}`);

// photometa._gps: "null island: a missing fix, not a location".
r = parseExifBuffer(buildJpeg({ lat: 0, lon: 0 }));
check('(0,0) is rejected as a missing fix', r !== null && r.lat === null, `${r?.lat}`);

r = parseExifBuffer(buildJpeg({ dtOriginal: '2021:06:04 15:00:00' }));
check('no GPS IFD leaves coordinates null, not an error', r !== null && r.lat === null);

// ----------------------------------------------------------------- capture time

// The same constant is asserted in tests/test_writeback.py, so the Python and
// JavaScript readers cannot drift apart without one of the two failing.
const EXPECT = 1622818800;   // 2021-06-04T15:00:00Z

r = parseExifBuffer(buildJpeg({ dtOriginal: '2021:06:04 15:00:00' }));
check('DateTimeOriginal is read as UTC wall clock', r?.taken_ts === EXPECT,
      `${r?.taken_ts} vs ${EXPECT}`);

r = parseExifBuffer(buildJpeg({ dtDigitized: '2021:06:04 15:00:00' }));
check('falls back to DateTimeDigitized', r?.taken_ts === EXPECT, `${r?.taken_ts}`);

r = parseExifBuffer(buildJpeg({ dateTime: '2021:06:04 15:00:00' }));
check('falls back to IFD0 DateTime', r?.taken_ts === EXPECT, `${r?.taken_ts}`);

r = parseExifBuffer(buildJpeg({ dtOriginal: '2021:06:04 15:00:00', dtDigitized: '1999:01:01 01:01:01' }));
check('DateTimeOriginal wins over DateTimeDigitized', r?.taken_ts === EXPECT, `${r?.taken_ts}`);

// _parse_dt's control flow, which is where the two readers most easily diverge.
check("'0000:...' is rejected", parseDT('0000:00:00 00:00:00') === null);
check('a T separator falls back to the date, as strptime does',
      parseDT('2021:06:04T15:00:00') === Date.UTC(2021, 5, 4) / 1000,
      `${parseDT('2021:06:04T15:00:00')}`);
check('slashes are normalised to colons',
      parseDT('2021/06/04 15:00:00') === EXPECT, `${parseDT('2021/06/04 15:00:00')}`);
check('an impossible day is rejected, not rolled forward',
      parseDT('2025:02:30 10:00:00') === null, `${parseDT('2025:02:30 10:00:00')}`);
check('a date with no time parses to midnight',
      parseDT('2021:06:04') === Date.UTC(2021, 5, 4) / 1000);
check('single-digit month and day parse, as %m/%d allow',
      parseDT('2021:6:4 15:00:00') === EXPECT, `${parseDT('2021:6:4 15:00:00')}`);
check('rubbish is rejected', parseDT('not a date') === null);

// -------------------------------------------------------------- not a JPEG

check('a PNG returns null rather than throwing',
      parseExifBuffer(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0]).buffer) === null);
check('an empty buffer returns null', parseExifBuffer(new ArrayBuffer(0)) === null);
check('a truncated JPEG returns null',
      parseExifBuffer(new Uint8Array([0xFF, 0xD8, 0xFF]).buffer) === null);
// HEIC is ISO-BMFF, not JPEG: the reader is expected to decline it, and the
// desktop supplies the real coordinates when it ingests the file.
const heic = new Uint8Array(32);
heic.set(new TextEncoder().encode('ftypheic'), 4);
check('HEIC declines cleanly rather than guessing', parseExifBuffer(heic.buffer) === null);

// ------------------------------------------------ evidence, not just values
//
// Whether the file carries a GPS block at all is the one thing that separates a
// photo taken without a fix from a photo whose location was removed on the way
// out of a picker. Both have no coordinates; only the second has no block, and
// only the second is worth telling anyone to do something about.
const located = parseExifBuffer(buildJpeg({ lat: 51.5074, lon: 0.1278 }));
check('a located photo reports its GPS block', located?.gps === true);
const noBlock = parseExifBuffer(buildJpeg({ dtOriginal: '2021:06:04 15:00:00' }));
check('EXIF with no GPS block at all says so', noBlock !== null && noBlock.gps === false,
      JSON.stringify(noBlock));
check('and that is not confused with having no coordinates',
      noBlock?.lat === null && located?.lat !== null);
// Null island is a missing fix written into a block that IS present, which is
// exactly the case that must not look like a picker stripping the location.
const nullIsland = parseExifBuffer(buildJpeg({ lat: 0, lon: 0 }));
check('a rejected fix still counts as a block being there',
      nullIsland?.lat === null && nullIsland?.gps === true, JSON.stringify(nullIsland));

console.log();
const failed = results.filter((x) => !x.ok);
if (failed.length) {
  console.log(`${failed.length} FAILED: ${failed.map((f) => f.label).join(', ')}`);
  process.exit(1);
}
console.log(`ALL ${results.length} EXIF CHECKS PASSED`);
