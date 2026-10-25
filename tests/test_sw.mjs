/**
 * The service worker's drain: what happens to an upload with nobody looking.
 *
 * This is the half of the queue that cannot be watched - it runs on a Background
 * Sync event, with the app shut or the screen off - so the behaviour that
 * matters is tested here rather than by trying it on a phone:
 *
 *   it stands down while the page is up, or the two would send the same photo;
 *   it stages what was picked and never read, which is what makes a whole
 *   selection survive the screen going off rather than only the staged few;
 *   and it leaves alone what it cannot decode, rather than dropping it.
 *
 *   node tests/test_sw.mjs
 */
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const failures = [];
function check(label, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition ? '' : `  -> ${detail}`}`);
  if (!condition) failures.push(label);
}

// ------------------------------------------------------------- the fake world

/** The queue, in memory. Same surface as uploadq.js, none of the IndexedDB. */
function fakeQ(state) {
  const proxyOf = (file) => new Blob([`proxy:${file.name}`]);
  return {
    SYNC_TAG: 'photomap-uploads',
    PROXY_PATH: 'api/import',
    fullPath: (iid) => `api/import/full?iid=${iid}`,
    async open() { return state; },
    async getPref(_db, key, fallback) {
      return key in state.prefs ? state.prefs[key] : fallback;
    },
    onWifi: () => state.wifi,
    async records() { return state.photos.slice(); },
    async put(_db, rec) {
      const at = state.photos.findIndex((r) => r.id === rec.id);
      if (at >= 0) state.photos[at] = rec; else state.photos.push(rec);
    },
    async held() { return state.hold.slice(); },
    async unhold(_db, id) { state.hold = state.hold.filter((h) => h.id !== id); },
    async ops() { return state.ops.slice(); },
    async dropOp(_db, id) { state.ops = state.ops.filter((o) => o.id !== id); },
    async addSent(_db, key) { state.sent.push(key); },
    async sentKeys() { return state.sent.slice(); },
    hashKey: (d) => `h|${d}`,
    fileKey: (f) => `f|${f.name}|${f.size}`,
    proxyMeta: (rec) => ({ name: rec.name, sha256: rec.sha256 }),
    headers: () => ({}),
    fatal: (status, kind) => kind !== 'http' || status >= 500 || status === 401,
    inParts: (blob) => blob && blob.size > 64 * 1024 * 1024,
    sendParts: async () => { state.usedParts += 1; return { ok: true, status: 202, data: {} }; },
    abortParts: async () => { state.aborted += 1; },
    workerCanStage: (file) => !/\.(mp4|mov|heic)$/i.test(file.name),
    async sha256Hex(buffer) {
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    },
    proxyFromBitmap: async (file) => proxyOf(file),
    record: (file, { digest, proxy }) => ({
      id: `rec-${file.name}`, queued_ts: Date.now(), name: file.name,
      file_key: `f|${file.name}|${file.size}`, sha256: digest, proxy,
      full: file, iid: null, state: 'queued', parts: null,
    }),
  };
}

async function load(state) {
  const src = await readFile(new URL('../viewer/sw.js', import.meta.url), 'utf8');
  const scope = {
    addEventListener() {},
    location: { origin: 'https://x.workers.dev' },
    registration: { sync: { register: async () => { state.reregistered += 1; } } },
    clients: {
      matchAll: async () => state.clients,
      claim: async () => {},
    },
    skipWaiting() {},
  };
  const sandbox = {
    self: scope,
    importScripts() {},
    Q: fakeQ(state),
    caches: { open: async () => ({}), keys: async () => [], match: async () => null },
    Response, Request, Blob, File, URL, crypto, console,
    readExif: async () => ({ lat: 51.5, lon: -0.12, taken_ts: 1700000000 }),
    fetch: (...args) => state.fetch(...args),
  };
  const names = Object.keys(sandbox);
  const body = `${src}\nreturn { drainQueue, sendStaged, stageHeld, flushOps, pageIsUp };`;
  // eslint-disable-next-line no-new-func
  return new Function(...names, body)(...names.map((n) => sandbox[n]));
}

const answer = (status, data = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => data,
});

function newState(over = {}) {
  return {
    prefs: {}, wifi: true, photos: [], hold: [], ops: [], sent: [],
    clients: [], calls: [], reregistered: 0, usedParts: 0, aborted: 0,
    fetch(path) {
      this.calls.push(String(path));
      if (String(path).startsWith('api/import/full')) return answer(202, { stored: true });
      if (String(path).startsWith('api/import')) return answer(202, { iid: 'iid-1' });
      return answer(202, { queued: true });
    },
    ...over,
  };
}

const staged = (over = {}) => ({
  id: 'r1', queued_ts: 1, name: 'IMG_1.jpg', sha256: 'a'.repeat(64),
  proxy: new Blob(['p']), full: new Blob(['full']), iid: null, state: 'queued',
  file_key: 'f|IMG_1.jpg|4', parts: null, ...over,
});

// -------------------------------------------------------------------- checks

// The page is on screen: it is draining the queue itself, and a second sender
// would put some photos in the bucket twice.
let state = newState({ clients: [{ visibilityState: 'visible' }], photos: [staged()] });
let sw = await load(state);
await sw.drainQueue();
check('it stands down while the app is on screen', state.calls.length === 0,
  state.calls.join(' '));

// A hidden client is not a working one - that is exactly the screen-off case
// this whole path exists for.
state = newState({ clients: [{ visibilityState: 'hidden' }], photos: [staged()] });
sw = await load(state);
await sw.drainQueue();
check('but not while it is merely open behind a locked screen',
  state.calls.some((c) => c.startsWith('api/import')), state.calls.join(' '));
check('it sends the preview and then the original',
  state.calls.filter((c) => c.startsWith('api/import')).length === 2, state.calls.join(' '));
check('and the record is finished, not left saying "uploading"',
  state.photos[0].state === 'done' && state.photos[0].full === null,
  JSON.stringify(state.photos[0].state));
check('what it sent is remembered, so picking it again skips it',
  state.sent.includes('h|' + 'a'.repeat(64)), state.sent.join(' '));

// The Wi-Fi preference lives in the queue's own database precisely so this can
// honour it: a worker cannot read localStorage.
state = newState({ prefs: { wifiOnly: true }, wifi: false, photos: [staged()] });
sw = await load(state);
await sw.drainQueue();
check('it holds the queue on mobile data', state.calls.length === 0, state.calls.join(' '));
check('and asks to be woken again rather than giving up', state.reregistered === 1,
  String(state.reregistered));

state = newState({ prefs: { wifiOnly: false }, wifi: false, photos: [staged()] });
sw = await load(state);
await sw.drainQueue();
check('unless the preference is off', state.calls.length > 0, state.calls.join(' '));

// Files picked but never read. This is what makes a whole selection survive the
// screen going off rather than only the handful that were staged.
state = newState({
  hold: [
    { id: 1, file: new File(['photo bytes'], 'IMG_9.jpg', { type: 'image/jpeg' }) },
    { id: 2, file: new File(['clip bytes'], 'VID_9.mp4', { type: 'video/mp4' }) },
  ],
});
sw = await load(state);
await sw.drainQueue();
check('it reads a held photo itself and sends it',
  state.photos.length === 1 && state.photos[0].name === 'IMG_9.jpg',
  JSON.stringify(state.photos.map((p) => p.name)));
check('the photo it staged is out of the holding store',
  !state.hold.some((h) => h.id === 1), JSON.stringify(state.hold.map((h) => h.id)));
check('a clip is left for the app, which has a <video> to draw a frame with',
  state.hold.some((h) => h.id === 2), JSON.stringify(state.hold.map((h) => h.id)));
check('and it asks to be woken again while that is still waiting',
  state.reregistered >= 1, String(state.reregistered));

// Edits queued with no signal - a journal day written on a train.
state = newState({ ops: [{ id: 1, change: { op: 'day_write', day: '2024-03-08', text: 'x' } }] });
sw = await load(state);
await sw.drainQueue();
check('a parked change is sent', state.calls.includes('api/change'), state.calls.join(' '));
check('and dropped once it lands', state.ops.length === 0, JSON.stringify(state.ops));

state = newState({ ops: [{ id: 1, change: { op: 'day_write' } }] });
state.fetch = function refuse(path) { this.calls.push(String(path)); return answer(400, { error: 'nope' }); };
sw = await load(state);
await sw.drainQueue();
check('a change the Worker refuses is dropped rather than retried forever',
  state.ops.length === 0, JSON.stringify(state.ops));

state = newState({ ops: [{ id: 1, change: { op: 'day_write' } }] });
state.fetch = function dead() { throw new Error('offline'); };
sw = await load(state);
await sw.drainQueue();
check('but one that could not be sent at all is kept', state.ops.length === 1);

// A full bucket is not a reason to grind through the rest of the queue.
state = newState({ photos: [staged(), staged({ id: 'r2', name: 'IMG_2.jpg' })] });
state.fetch = function full(path) {
  this.calls.push(String(path));
  return answer(507, { error: 'the upload space is full', full: true });
};
sw = await load(state);
await sw.drainQueue();
check('a full queue stops the run at the first photo',
  state.calls.length === 1, state.calls.join(' '));
check('and the photo says why rather than saying it is on its way',
  state.photos[0].state === 'failed' && /full/.test(state.photos[0].error || ''),
  JSON.stringify(state.photos[0]));

// Anything larger than a Worker can receive goes up in parts, here as well as
// in the page - the two share one implementation of that.
state = newState({ photos: [staged({ full: { size: 200 * 1024 * 1024 } })] });
sw = await load(state);
await sw.drainQueue();
check('a video goes up in parts', state.usedParts === 1, String(state.usedParts));

console.log();
console.log(failures.length ? `${failures.length} FAILED` : 'ALL SERVICE WORKER CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
