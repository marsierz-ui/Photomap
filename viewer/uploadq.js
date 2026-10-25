/**
 * The upload queue, shared by the page and the service worker.
 *
 * It exists because two different things now send photos. The page does it while
 * you watch, with a progress bar and a stall timer; the service worker does it
 * after the app is closed - or with the screen off, which is the same thing to a
 * phone - with nobody looking. Everything they must agree on lives here: the
 * database, the record shape, the endpoints, the metadata header, how a file too
 * large for one request is cut into parts, and which failures are worth
 * retrying. Two copies of that would drift, and the drift would be silent.
 *
 * A classic script on purpose: a service worker reaches it with importScripts,
 * and the page with a plain <script>. `self` is the window in one and the worker
 * global in the other, and nothing in here touches the DOM.
 */
(function attach(scope) {
  const DB_NAME = 'photomap-uploads';
  // 3 added `prefs` and `shared`. Both exist for the worker: it cannot read
  // localStorage, so the Wi-Fi preference has to live somewhere it can see, and
  // a photo shared into the app arrives in the worker with no page to hand it to.
  // 4 added `hold` and `ops`, which are what make a batch survive the screen
  // going off: the files nobody has read yet, and the edits nobody has sent yet.
  const DB_VERSION = 4;
  const SYNC_TAG = 'photomap-uploads';

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        // Checked rather than assumed: this runs as a first install and as an
        // upgrade from any earlier version.
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('sent')) db.createObjectStore('sent', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('prefs')) db.createObjectStore('prefs', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('shared')) {
          db.createObjectStore('shared', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('hold')) {
          db.createObjectStore('hold', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('ops')) {
          db.createObjectStore('ops', { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => {
        // An older tab holding this database open blocks the next upgrade
        // indefinitely, and a page waiting on that open never finishes booting.
        // Standing aside when asked is what keeps the other tab moving.
        req.result.onversionchange = () => req.result.close();
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
      // Reached when a tab that predates onversionchange above is still open.
      // Reported rather than left hanging: "the app is open in another tab" is
      // something a person can act on, a spinner forever is not.
      req.onblocked = () => reject(new Error(
        'the app is open in another tab - close it and reload to finish upgrading',
      ));
    });
  }

  const done = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const store = (db, name, mode) => db.transaction(name, mode).objectStore(name);

  // ------------------------------------------------------------------ records

  const records = async (db) => (await done(store(db, 'photos', 'readonly').getAll()))
    .sort((a, b) => a.queued_ts - b.queued_ts);

  const put = (db, rec) => done(store(db, 'photos', 'readwrite').put(rec));
  const drop = (db, id) => done(store(db, 'photos', 'readwrite').delete(id));

  const sentKeys = (db) => done(store(db, 'sent', 'readonly').getAllKeys());
  const addSent = (db, key) => done(store(db, 'sent', 'readwrite').put({ key, ts: Date.now() }));

  const getPref = async (db, key, fallback) => {
    const row = await done(store(db, 'prefs', 'readonly').get(key));
    return row ? row.value : fallback;
  };
  const setPref = (db, key, value) => done(store(db, 'prefs', 'readwrite').put({ key, value }));

  const shared = (db) => done(store(db, 'shared', 'readonly').getAll());
  const addShared = (db, file) => done(store(db, 'shared', 'readwrite').put({ file, ts: Date.now() }));
  const clearShared = (db) => done(store(db, 'shared', 'readwrite').clear());

  // Picked, but not read yet. A batch is deliberately staged a few photos ahead
  // of the uploader rather than all at once, so the rest of a five thousand
  // photo selection lives here until something gets to it - the page while it is
  // open, the service worker while it is not.
  const held = (db) => done(store(db, 'hold', 'readonly').getAll());
  const hold = (db, file) => done(store(db, 'hold', 'readwrite').put({ file, ts: Date.now() }));
  const unhold = (db, id) => done(store(db, 'hold', 'readwrite').delete(id));
  const clearHold = (db) => done(store(db, 'hold', 'readwrite').clear());

  // Edits waiting for a connection - a journal day written on a plane, a note
  // typed in a lift. The bucket is the only place a change can be parked, so
  // until there is a signal they are parked here instead.
  const ops = (db) => done(store(db, 'ops', 'readonly').getAll());
  const addOp = (db, change) => done(store(db, 'ops', 'readwrite').put({ change, ts: Date.now() }));
  const dropOp = (db, id) => done(store(db, 'ops', 'readwrite').delete(id));

  // ----------------------------------------------------------------- protocol

  const b64url = (text) => btoa(unescape(encodeURIComponent(text)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  /** What /api/import is told about a photo. The Worker synthesises the import
   *  op from this, so a field missing here is a field missing from the library. */
  const proxyMeta = (rec) => ({
    name: rec.name, ext: rec.ext, bytes: rec.bytes, sha256: rec.sha256,
    proxy_sha256: rec.proxy_sha256, taken_ts: rec.taken_ts, lat: rec.lat, lon: rec.lon,
  });

  const headers = (meta) => ({
    'X-Photo-Meta': b64url(JSON.stringify(meta)),
    'Content-Type': 'application/octet-stream',
  });

  const PROXY_PATH = 'api/import';
  const fullPath = (iid) => `api/import/full?iid=${encodeURIComponent(iid)}`;
  const beginPath = (iid) => `api/import/begin?iid=${encodeURIComponent(iid)}`;
  const finishPath = (iid, up) =>
    `api/import/finish?iid=${encodeURIComponent(iid)}&uploadId=${encodeURIComponent(up)}`;
  const abortPath = (iid, up) =>
    `api/import/abort?iid=${encodeURIComponent(iid)}&uploadId=${encodeURIComponent(up)}`;
  const partPath = (iid, up, n, last) =>
    `api/import/part?iid=${encodeURIComponent(iid)}&uploadId=${encodeURIComponent(up)}`
    + `&part=${n}${last ? '&last=1' : ''}`;

  // Answers that will be identical for the next photo, so there is nothing to
  // learn from trying it. Kept here because the page stops a run on these and
  // the worker has to make the same call.
  const NO_POINT_RETRYING = new Set([401, 403, 404, 405, 429, 501]);
  const fatal = (status, kind) => kind !== 'http'
    || NO_POINT_RETRYING.has(status) || status >= 500;

  // Two fingerprints per photo, both exact: one off the File with no reading at
  // all, one over the bytes. See the note where they are used.
  const fileKey = (file) => `f|${file.name.toLowerCase()}|${file.size}|${file.lastModified}`;
  const hashKey = (digest) => `h|${digest}`;

  // ------------------------------------------------------------------- videos
  //
  // A video is an ordinary library item with an ordinary place and time on it -
  // the difference is only ever its size. Two things follow, and both live here
  // because both halves of the app have to agree on them:
  //
  //   its preview is a frame rather than a downscale, so what the desktop gets
  //   as the "proxy" is a poster it can keep as the thumbnail; and
  //
  //   it does not fit in one request. The largest body a Worker can receive is
  //   100MB on the Free and Pro plans, so anything past SINGLE_MAX goes up as an
  //   R2 multipart upload instead, one part at a time, resumable.
  const VIDEO_EXT = /\.(mp4|m4v|mov|3gp|3g2)$/i;
  const isVideo = (file) => VIDEO_EXT.test(file.name || '')
    || /^video\//i.test(file.type || '');
  const SINGLE_MAX = 64 * 1024 * 1024;
  // Matched to the Worker, which refuses a middle part of any other size: R2
  // requires them uniform, and it says so at `complete`, after every byte has
  // already been sent.
  const PART_BYTES = 8 * 1024 * 1024;
  const inParts = (blob) => !!blob && blob.size > SINGLE_MAX;

  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // SHA-256 again, a block at a time.
  //
  // crypto.subtle has no streaming form: it takes the whole buffer, which for a
  // 200MB video means holding the entire clip in memory on a phone just to find
  // out what to call it - on top of the copy the upload itself is holding. This
  // is the same digest computed over 8MB slices, so a video of any size costs
  // one slice at a time. It is checked against crypto.subtle in the tests.
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function hasher() {
    const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Uint32Array(64);
    const tail = new Uint8Array(64);
    let held = 0;
    let total = 0;

    const rot = (x, n) => (x >>> n) | (x << (32 - n));

    function block(bytes, at) {
      for (let i = 0; i < 16; i += 1) {
        w[i] = (bytes[at + i * 4] << 24) | (bytes[at + i * 4 + 1] << 16)
          | (bytes[at + i * 4 + 2] << 8) | bytes[at + i * 4 + 3];
      }
      for (let i = 16; i < 64; i += 1) {
        const a = w[i - 15];
        const b = w[i - 2];
        const s0 = rot(a, 7) ^ rot(a, 18) ^ (a >>> 3);
        const s1 = rot(b, 17) ^ rot(b, 19) ^ (b >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i += 1) {
        const s1 = rot(e, 6) ^ rot(e, 11) ^ rot(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + s1 + ch + K[i] + w[i]) | 0;
        const s0 = rot(a, 2) ^ rot(a, 13) ^ rot(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (s0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }

    return {
      update(bytes) {
        total += bytes.length;
        let at = 0;
        if (held) {
          const need = Math.min(64 - held, bytes.length);
          tail.set(bytes.subarray(0, need), held);
          held += need;
          at = need;
          if (held < 64) return;
          block(tail, 0);
          held = 0;
        }
        for (; at + 64 <= bytes.length; at += 64) block(bytes, at);
        if (at < bytes.length) {
          tail.set(bytes.subarray(at), 0);
          held = bytes.length - at;
        }
      },
      digest() {
        const bits = total * 8;
        const pad = new Uint8Array(held + (held % 64 < 56 ? 64 - (held % 64) : 128 - (held % 64)));
        pad.set(tail.subarray(0, held), 0);
        pad[held] = 0x80;
        // The length is 64 bits; the high half is written from a float because a
        // library this size will never see a file past 2**53 bytes.
        new DataView(pad.buffer).setUint32(pad.length - 8, Math.floor(bits / 4294967296));
        new DataView(pad.buffer).setUint32(pad.length - 4, bits >>> 0);
        for (let at = 0; at < pad.length; at += 64) block(pad, at);
        return h.map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
      },
    };
  }

  const HASH_SLICE = 8 * 1024 * 1024;

  /** The digest of a blob, without ever holding all of it at once. */
  async function sha256Blob(blob) {
    if (blob.size <= HASH_SLICE) return sha256Hex(await blob.arrayBuffer());
    const state = hasher();
    for (let at = 0; at < blob.size; at += HASH_SLICE) {
      const slice = blob.slice(at, Math.min(at + HASH_SLICE, blob.size));
      state.update(new Uint8Array(await slice.arrayBuffer()));
    }
    return state.digest();
  }

  /** Send one original in parts. `post(path, body, meta)` is the caller's own
   *  sender - XMLHttpRequest in the page, because it is the only one that
   *  reports upload progress, and fetch in the worker, where nothing is
   *  watching - and it resolves to the same shape either way.
   *
   *  Every completed part is written back to the record before the next one
   *  starts, so a sync that is killed halfway through a 200MB clip resumes at
   *  the part after the last one that landed rather than at the beginning. */
  async function sendParts(db, rec, post, onPart) {
    const file = rec.full;
    const count = Math.max(1, Math.ceil(file.size / PART_BYTES));
    if (!rec.parts || !rec.parts.uploadId) {
      const begun = await post(beginPath(rec.iid), new Blob([]), {
        sha256: rec.sha256, bytes: file.size, ext: rec.ext,
      });
      if (!begun.ok) return begun;
      rec.parts = { uploadId: begun.data.uploadId, sent: [] };
      await put(db, rec);
    }
    while (rec.parts.sent.length < count) {
      const n = rec.parts.sent.length + 1;
      const last = n === count;
      const slice = file.slice((n - 1) * PART_BYTES, Math.min(n * PART_BYTES, file.size));
      const digest = await sha256Hex(await slice.arrayBuffer());
      if (onPart) onPart(n, count, slice.size);
      const res = await post(partPath(rec.iid, rec.parts.uploadId, n, last), slice, { sha256: digest });
      if (!res.ok) return res;
      rec.parts.sent.push({ partNumber: res.data.partNumber || n, etag: res.data.etag });
      await put(db, rec);
    }
    const body = new Blob([JSON.stringify({ parts: rec.parts.sent, sha256: rec.sha256 })]);
    return post(finishPath(rec.iid, rec.parts.uploadId), body, { sha256: rec.sha256 });
  }

  /** Hand back the space an abandoned upload is holding. A multipart upload that
   *  was never completed is not an object, so nothing that lists the bucket can
   *  see it and the desktop's own sweep cannot reach it. */
  async function abortParts(rec, post) {
    if (!rec.parts || !rec.parts.uploadId) return;
    try {
      await post(abortPath(rec.iid, rec.parts.uploadId), new Blob([]), { sha256: rec.sha256 });
    } catch {
      /* nothing to free, or no connection to free it over */
    }
  }

  /** true on Wi-Fi, false on something metered, null when nothing will say.
   *  Works in a worker as well as a page - NetworkInformation is on both. */
  function onWifi() {
    const net = scope.navigator
      && (scope.navigator.connection || scope.navigator.mozConnection
        || scope.navigator.webkitConnection);
    if (!net) return null;
    if (net.saveData) return false;
    const kind = net.type;
    if (typeof kind !== 'string' || !kind) return null;
    if (kind === 'wifi' || kind === 'ethernet') return true;
    if (kind === 'cellular') return false;
    return null;
  }

  // ------------------------------------------------------------------ staging
  //
  // Reading a picked file into a record: its digest, what it says about where
  // and when it was taken, and a preview small enough to send straight away.
  //
  // The page can do this for anything, because it has a document: an <img> for a
  // HEIC the bitmap decoder refuses, a <video> for a frame out of a clip. The
  // worker has neither, so it can only stage what createImageBitmap will open,
  // which is every ordinary JPEG and PNG and nothing else. That is the whole
  // difference between them, and it is why this asks the caller for the poster
  // rather than making one itself.

  const workerCanStage = (file) => !isVideo(file)
    && !/\.(heic|heif|avif)$/i.test(file.name || '')
    && !/heic|heif|avif/i.test(file.type || '');

  const PROXY_EDGE = 1600;
  const PROXY_QUALITY = 0.82;

  /** A JPEG small enough to send now, drawn off the bitmap decoder. Available in
   *  a service worker, which has no canvas element and no <img>. */
  async function proxyFromBitmap(file) {
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, PROXY_EDGE / Math.max(bitmap.width, bitmap.height));
      const canvas = new OffscreenCanvas(
        Math.max(1, Math.round(bitmap.width * scale)),
        Math.max(1, Math.round(bitmap.height * scale)),
      );
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return await canvas.convertToBlob({ type: 'image/jpeg', quality: PROXY_QUALITY });
    } finally {
      bitmap.close();
    }
  }

  /** The record shape, in one place. `read` is whatever the caller managed to
   *  learn about the file itself, and `proxy` the preview it managed to make. */
  function record(file, { digest, proxy, proxyDigest, read, loc }) {
    const ext = (String(file.name || '').match(/\.[A-Za-z0-9]+$/) || ['.jpg'])[0].toLowerCase();
    const meta = read || {};
    return {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      queued_ts: Date.now(),
      name: file.name,
      file_key: fileKey(file),
      ext,
      video: isVideo(file),
      bytes: file.size,
      sha256: digest,
      proxy_sha256: proxyDigest,
      taken_ts: meta.taken_ts ?? null,
      lat: meta.lat ?? null,
      lon: meta.lon ?? null,
      // Why this file has no position, which is otherwise a silence with several
      // very different causes and several different answers. Recorded here
      // because this is the only place that ever sees the original.
      loc: loc || (meta.lat != null ? 'ok' : 'stripped'),
      proxy,
      full: file,
      parts: null,
      iid: null,
      state: 'queued',
    };
  }

  scope.Q = {
    DB_NAME, DB_VERSION, SYNC_TAG,
    open, done, store,
    records, put, drop,
    sentKeys, addSent,
    getPref, setPref,
    shared, addShared, clearShared,
    held, hold, unhold, clearHold,
    ops, addOp, dropOp,
    b64url, proxyMeta, headers,
    PROXY_PATH, fullPath, beginPath, partPath, finishPath, abortPath,
    NO_POINT_RETRYING, fatal,
    fileKey, hashKey, onWifi,
    isVideo, inParts, sendParts, abortParts, SINGLE_MAX, PART_BYTES,
    sha256Hex, sha256Blob, workerCanStage, proxyFromBitmap, record,
    PROXY_EDGE, PROXY_QUALITY,
  };
}(self));
