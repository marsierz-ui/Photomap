/**
 * Offline shell for the cloud viewer.
 *
 * Everything the viewer needs is same-origin - the Worker serves the page, the
 * snapshot and the thumbnails from one private bucket - so the usual "never
 * touch cross-origin" rule costs nothing here, and the two same-origin classes
 * want opposite strategies:
 *
 *   t/<hash>.jpg   content-addressed, so the bytes under a name never change.
 *                  Cache-first, and a hit means no request at all.
 *   everything     the page and manifest.json do change. Network-first, with
 *   else           the cache as the fallback when there is no signal.
 *
 * /api/ and /__login are never cached: queued changes and the password gate
 * have to reach the Worker or fail loudly. Photo uploads are POSTs to
 * /api/import, so they are left alone twice over - by the method check and by
 * the /api/ passthrough.
 *
 * Two things here outlive the page, which is the point of both:
 *
 *   sync      a Background Sync event drains whatever is still queued after the
 *             app is closed - or after the screen goes off, which to a phone is
 *             the same thing. It sends what is already staged, and stages what
 *             it can of what is not: a batch is deliberately read a few files
 *             ahead of the uploader rather than all at once, so the rest of a
 *             camera roll sits in `hold` until something gets to it. It shares
 *             all of that with the page through uploadq.js rather than keeping
 *             a second copy of it.
 *   share     the app is a share target, so photos or a .zip can be sent to it
 *             from a file manager instead of being hunted down through a picker.
 *             The files land in IndexedDB and the page imports them on open.
 */
importScripts('./exif.js', './uploadq.js');
// Bumped when the shell's contents change: activate drops every cache not in
// KEEP, so an installed app cannot keep serving the previous page offline.
const SHELL_CACHE = 'photomap-shell-v14';
const THUMB_CACHE = 'photomap-thumbs-v1';
const KEEP = [SHELL_CACHE, THUMB_CACHE];

// Roughly 50MB at the 160px thumbnails the snapshot publishes. Phones evict
// storage under pressure anyway; this keeps us well short of that.
const THUMB_LIMIT = 4000;

// The map libraries are part of the shell now that they come from the bucket
// rather than a CDN. Without them a cold offline start has a page and no map.
// MapLibre is not listed: it is half a megabyte for a mode most sessions never
// open, so it is cached on first use by the same network-first path instead.
const SHELL = [
  './', './index.html', './manifest.webmanifest', './icon.svg', './exif.js',
  './uploadq.js',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.markercluster.js',
  './vendor/leaflet/MarkerCluster.css',
  './vendor/leaflet/leaflet-heat.js',
];

self.addEventListener('install', (event) => {
  // A missing shell asset must not fail the whole install, so they are added
  // one at a time rather than through addAll.
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => Promise.all(
      SHELL.map((url) => cache.add(url).catch(() => {})),
    )),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => !KEEP.includes(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Shared into the app from another app. This is the only POST handled here,
  // and it has to be handled here because the target of a share is the service
  // worker: there is no page yet to receive the files.
  if (request.method === 'POST' && url.pathname.endsWith('/share')) {
    event.respondWith(takeShare(request));
    return;
  }
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__')) return;

  event.respondWith(url.pathname.startsWith('/t/') ? thumbnail(request) : shell(request));
});

/** Park the shared files and send the browser to the app, which picks them up.
 *
 *  A 303 rather than a 200: the share arrives as a POST, and answering it with a
 *  page would leave that POST as the current history entry, so a reload would
 *  re-submit the share. See the shared-files handling in index.html. */
async function takeShare(request) {
  const home = new URL('./?shared=1', self.location).href;
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter((f) => f && typeof f.name === 'string');
    if (files.length) {
      const db = await Q.open();
      for (const file of files) await Q.addShared(db, file);
    }
  } catch {
    // Nothing to hand over. The app opens anyway rather than showing an error
    // page in a window the share just launched.
  }
  return Response.redirect(home, 303);
}

// --------------------------------------------------------- background uploads

self.addEventListener('sync', (event) => {
  if (event.tag === Q.SYNC_TAG) event.waitUntil(drainQueue());
});

/** Whether the app is on screen right now.
 *
 *  If it is, it is draining the queue itself, and two senders working the same
 *  records would send some of them twice. The worker's job begins where the
 *  page's ends. */
async function pageIsUp() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return clients.some((c) => c.visibilityState === 'visible');
}

/** fetch, wearing the shape the page's XHR sender resolves to, so the shared
 *  protocol in uploadq.js does not have to know which of the two called it. */
async function post(path, body, meta) {
  try {
    const res = await fetch(path, { method: 'POST', headers: Q.headers(meta), body });
    const data = await res.json().catch(() => ({}));
    return { kind: 'http', status: res.status, ok: res.ok, data };
  } catch {
    return { kind: 'network', status: 0, ok: false, data: {} };
  }
}

/** Send what is queued, and stage what can be staged, with no page open.
 *
 *  It stops on the first answer that will repeat, and re-registers itself if
 *  anything is still waiting - a sync event that resolves is considered
 *  finished, so the way to be woken again is to ask again.
 */
async function drainQueue() {
  if (await pageIsUp()) return;
  const db = await Q.open();
  if (await Q.getPref(db, 'wifiOnly', true) && Q.onWifi() === false) {
    return retryLater();
  }

  // Edits first: a journal day is a few hundred bytes, and it is the thing most
  // likely to have been written with no signal at all.
  await flushOps(db);

  let stop = await sendStaged(db);
  if (!stop) stop = await stageHeld(db);

  const left = (await Q.records(db)).some((r) => r.state !== 'done')
    || (await Q.held(db)).length || (await Q.ops(db)).length;
  if (left) await retryLater();
}

/** Changes made while there was nowhere to put them. Each is one small JSON
 *  object, and the Worker parks it in the bucket for the desktop to apply. */
async function flushOps(db) {
  for (const row of await Q.ops(db)) {
    try {
      const res = await fetch('api/change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(row.change),
      });
      // A refusal is not a reason to keep trying forever: the Worker rejected
      // the change itself, and it will reject it again every time. A 401 is
      // different - the session expires, and signing in again fixes it.
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 401)) {
        await Q.dropOp(db, row.id);
      } else {
        return;
      }
    } catch {
      return;  // no connection; the next sync tries again
    }
  }
}

/** The records that have already been read. True if something went wrong in a
 *  way that will go wrong again. */
async function sendStaged(db) {
  for (const rec of await Q.records(db)) {
    if (rec.state === 'done') continue;
    try {
      if (!rec.iid) {
        const res = await post(Q.PROXY_PATH, rec.proxy, Q.proxyMeta(rec));
        if (!res.ok) {
          rec.state = 'failed';
          rec.error = res.data.error || `the server answered ${res.status}`;
          await Q.put(db, rec);
          if (res.status === 507 || Q.fatal(res.status, res.kind)) return true;
          continue;
        }
        rec.iid = res.data.iid;
        rec.state = 'sent';
        await Q.put(db, rec);
        await Q.addSent(db, Q.hashKey(rec.sha256));
        if (rec.file_key) await Q.addSent(db, rec.file_key);
      }
      if (rec.full) {
        // One request, or one per part when the file is larger than a Worker
        // can receive. Every part that lands is written back to the record, so
        // being killed halfway through a video costs the part in flight and
        // nothing else.
        const res = Q.inParts(rec.full)
          ? await Q.sendParts(db, rec, post)
          : await post(Q.fullPath(rec.iid), rec.full, { sha256: rec.sha256 });
        if (res.ok || res.status === 413) {
          if (res.status === 413 && rec.parts) await Q.abortParts(rec, post);
          rec.full = null;
          rec.parts = null;
          rec.state = 'done';
          if (res.status === 413) rec.proxy_only = true;
          await Q.put(db, rec);
        } else {
          await Q.put(db, rec);
          if (res.status === 507 || Q.fatal(res.status, res.kind)) return true;
        }
      } else {
        rec.state = 'done';
        await Q.put(db, rec);
      }
    } catch {
      // The connection went while this was in flight. Left queued, and asked
      // for again rather than retried in a tight loop here.
      rec.state = 'queued';
      await Q.put(db, rec);
      return true;
    }
  }
  return false;
}

/** Files that were picked but never read, because the app went away first.
 *
 *  This is what makes "the upload carries on with the screen off" true of a
 *  whole selection rather than of the handful that happened to be staged: the
 *  worker reads the next one itself, sends it, and goes on to the next.
 *
 *  It can only do that for what the bitmap decoder will open - an ordinary JPEG
 *  or PNG. A HEIC needs an <img> and a video needs a <video>, and a worker has
 *  neither, so those are left where they are for the app to deal with when it is
 *  next opened. Left, not dropped: nothing here throws a picked file away. */
async function stageHeld(db) {
  const waiting = await Q.held(db);
  if (!waiting.length) return false;
  const seen = new Set(await Q.sentKeys(db));

  for (const row of waiting) {
    const file = row.file;
    if (!file) { await Q.unhold(db, row.id); continue; }
    if (!Q.workerCanStage(file)) continue;
    if (seen.has(Q.fileKey(file))) { await Q.unhold(db, row.id); continue; }
    try {
      const digest = await Q.sha256Hex(await file.arrayBuffer());
      if (seen.has(Q.hashKey(digest))) { await Q.unhold(db, row.id); continue; }
      const read = typeof readExif === 'function' ? await readExif(file) : null;
      const proxy = await Q.proxyFromBitmap(file);
      const rec = Q.record(file, {
        digest,
        proxy,
        proxyDigest: await Q.sha256Hex(await proxy.arrayBuffer()),
        read,
      });
      await Q.put(db, rec);
      await Q.unhold(db, row.id);
    } catch {
      continue;  // unreadable here; the app can try it with a document behind it
    }
    if (await sendStaged(db)) return true;
    // The screen may have come back on while this was running, in which case
    // the page is now draining the same queue. Standing down is cheaper than
    // arguing about it.
    if (await pageIsUp()) return true;
  }
  return false;
}

/** Ask to be woken again. Registering from inside the worker is what keeps a
 *  half-finished queue moving without a page ever being opened. */
async function retryLater() {
  try {
    await self.registration.sync.register(Q.SYNC_TAG);
  } catch {
    /* the browser has had enough for now; the page will drain on next open */
  }
}

async function thumbnail(request) {
  const cache = await caches.open(THUMB_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    trim(cache);
  }
  return response;
}

/** cache.keys() reports insertion order, so the oldest entries are the front. */
async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length <= THUMB_LIMIT) return;
  await Promise.all(keys.slice(0, keys.length - THUMB_LIMIT).map((key) => cache.delete(key)));
}

async function shell(request) {
  try {
    const response = await fetch(request);
    // Only 200s: a 401 is the login page, and caching that would lock the
    // installed app out of its own shell until the cache was cleared.
    if (response.ok) {
      const copy = response.clone();
      caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const index = await caches.match('./index.html');
      if (index) return index;
    }
    return new Response('Offline, and this has not been opened before.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}
