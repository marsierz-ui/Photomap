/**
 * The upload queue, shared by the page and the service worker.
 *
 * It exists because two different things now send photos. The page does it while
 * you watch, with a progress bar and a stall timer; the service worker does it
 * after the app is closed, through a Background Sync event, with nobody looking.
 * Everything they must agree on lives here - the database, the record shape, the
 * two endpoints, the metadata header, and which failures are worth retrying -
 * because two copies of that would drift and the drift would be silent.
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
  const DB_VERSION = 3;
  const SYNC_TAG = 'photomap-uploads';

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        // Checked rather than assumed: this runs as a first install and as an
        // upgrade from either earlier version.
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('sent')) db.createObjectStore('sent', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('prefs')) db.createObjectStore('prefs', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('shared')) {
          db.createObjectStore('shared', { keyPath: 'id', autoIncrement: true });
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

  scope.Q = {
    DB_NAME, DB_VERSION, SYNC_TAG,
    open, done, store,
    records, put, drop,
    sentKeys, addSent,
    getPref, setPref,
    shared, addShared, clearShared,
    b64url, proxyMeta, headers, PROXY_PATH, fullPath,
    NO_POINT_RETRYING, fatal,
    fileKey, hashKey, onWifi,
  };
}(self));
