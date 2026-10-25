/**
 * The parts of the upload queue that the page and the service worker share.
 *
 * Two things are worth testing away from a browser: the block-at-a-time SHA-256,
 * because a wrong digest means every upload is rejected as corrupt and the only
 * symptom is a 422; and the multipart driver, because it is what sends a video
 * and it has to be resumable - a part that landed must never be sent twice.
 *
 *   node tests/test_uploadq.mjs
 */
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const src = await readFile(new URL('../viewer/uploadq.js', import.meta.url), 'utf8');
const scope = { navigator: {}, indexedDB: null };
new Function('self', src)(scope);
const Q = scope.Q;

const failures = [];
function check(label, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition ? '' : `  -> ${detail}`}`);
  if (!condition) failures.push(label);
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const platform = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));

// ------------------------------------------------------------------ digests

check('the empty digest is the known one',
  await Q.sha256Hex(new Uint8Array(0).buffer)
    === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

// Sizes chosen around the block and slice boundaries the streaming path cares
// about: a block is 64 bytes and a slice is 8MB, and an off-by-one in either
// only shows up when a length lands exactly on one.
const SIZES = [1, 63, 64, 65, 127, 128, 1000, 8 * 1024 * 1024 - 1, 8 * 1024 * 1024,
  8 * 1024 * 1024 + 1, 20 * 1024 * 1024];
for (const size of SIZES) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + (i >> 8)) & 0xff;
  const mine = await Q.sha256Blob(new Blob([bytes]));
  // eslint-disable-next-line no-await-in-loop
  check(`${size} bytes hashes as the platform does`, mine === await platform(bytes), mine);
}

// ---------------------------------------------------------------- multipart

/** Enough of an IndexedDB for sendParts to write records back into: it saves
 *  every part as it lands, and that is exactly what makes a video resumable. */
function fakeDb() {
  const saved = [];
  return {
    saved,
    transaction: () => ({
      objectStore: () => ({
        put(rec) {
          saved.push(rec.parts ? rec.parts.sent.length : 0);
          const req = {};
          queueMicrotask(() => req.onsuccess && req.onsuccess());
          return req;
        },
      }),
    }),
  };
}

const bytes = new Uint8Array(Q.PART_BYTES * 2 + 1234);
for (let i = 0; i < bytes.length; i += 1) bytes[i] = i & 0xff;
const file = new File([bytes], 'clip.mp4', { type: 'video/mp4' });

function recorder({ failAt = null } = {}) {
  const calls = [];
  return {
    calls,
    async post(path, body, meta) {
      calls.push({ path, size: body ? body.size : 0, meta });
      if (path.startsWith('api/import/begin')) {
        return { kind: 'http', status: 200, ok: true, data: { uploadId: 'u-1' } };
      }
      if (path.startsWith('api/import/part')) {
        const n = Number(new URL(path, 'https://x/').searchParams.get('part'));
        if (failAt === n) return { kind: 'network', status: 0, ok: false, data: {} };
        return { kind: 'http', status: 200, ok: true, data: { partNumber: n, etag: `e${n}` } };
      }
      return { kind: 'http', status: 202, ok: true, data: { stored: true } };
    },
  };
}

const db = fakeDb();
const rec = { id: 'r1', iid: '1700000000000-abcdef01-2345-6789-abcd-ef0123456789', ext: '.mp4',
  sha256: await Q.sha256Blob(file), full: file, parts: null };
const run = recorder();
const done = await Q.sendParts(db, rec, run.post);

check('the whole file is sent as parts', done.ok, JSON.stringify(done));
const parts = run.calls.filter((c) => c.path.startsWith('api/import/part'));
check('every part but the last is exactly the part size',
  parts.slice(0, -1).every((c) => c.size === Q.PART_BYTES), parts.map((c) => c.size).join(','));
check('and the last is the remainder',
  parts[parts.length - 1].size === bytes.length - Q.PART_BYTES * 2,
  String(parts[parts.length - 1].size));
check('the last part is marked as the last',
  parts[parts.length - 1].path.includes('last=1'), parts[parts.length - 1].path);
check('each part carries its own digest',
  parts.every((c) => /^[0-9a-f]{64}$/.test(c.meta.sha256)));
check('the digest sent with a part is that part',
  parts[0].meta.sha256 === await platform(bytes.slice(0, Q.PART_BYTES)));
check('every landed part is written back as it lands, not at the end',
  db.saved.length >= 3, JSON.stringify(db.saved));
check('finishing lists every part in order',
  JSON.stringify(rec.parts.sent.map((p) => p.partNumber)) === '[1,2,3]',
  JSON.stringify(rec.parts.sent));

// Resuming: a run that lost the connection on part 2 must pick up at part 2,
// not at the beginning. This is the whole reason the parts are written back to
// the record as they land.
const db2 = fakeDb();
const rec2 = { ...rec, full: file, parts: null };
const first = recorder({ failAt: 2 });
const stopped = await Q.sendParts(db2, rec2, first.post);
check('a dropped part stops the run', !stopped.ok, JSON.stringify(stopped));
check('and what landed before it is remembered', rec2.parts.sent.length === 1,
  JSON.stringify(rec2.parts));

const second = recorder();
const resumed = await Q.sendParts(db2, rec2, second.post);
check('resuming finishes it', resumed.ok, JSON.stringify(resumed));
check('and does not begin a second upload',
  !second.calls.some((c) => c.path.startsWith('api/import/begin')),
  second.calls.map((c) => c.path).join(' '));
check('nor re-send the part that already landed',
  second.calls.filter((c) => c.path.startsWith('api/import/part')).length === 2,
  second.calls.map((c) => c.path).join(' '));

// ------------------------------------------------------------------ routing

check('a video goes in parts only when it is too large for one request',
  Q.inParts(new Blob([new Uint8Array(10)])) === false
  && Q.inParts({ size: Q.SINGLE_MAX + 1 }) === true);
check('videos are recognised by extension', Q.isVideo({ name: 'VID_1.MOV', type: '' }));
check('and by type when the name says nothing',
  Q.isVideo({ name: 'clip', type: 'video/mp4' }));
check('a jpeg is not a video', !Q.isVideo({ name: 'a.jpg', type: 'image/jpeg' }));
check('the worker will stage an ordinary photo', Q.workerCanStage({ name: 'a.jpg', type: 'image/jpeg' }));
check('but not a HEIC, which needs a document to decode',
  !Q.workerCanStage({ name: 'a.heic', type: '' }));
check('and not a video, which needs a <video> for its poster',
  !Q.workerCanStage({ name: 'a.mp4', type: '' }));

console.log();
console.log(failures.length ? `${failures.length} FAILED` : 'ALL UPLOAD QUEUE CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
