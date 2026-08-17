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
 *             app is closed. The photos are already staged in IndexedDB - read,
 *             hashed and downscaled at the moment they were picked - so this only
 *             has to send them, and it shares the protocol for that with the page
 *             through uploadq.js rather than keeping a second copy of it.
 *   share     the app is a share target, so photos or a .zip can be sent to it
 *             from a file manager instead of being hunted down through a picker.
 *             The files land in IndexedDB and the page imports them on open.
 */
importScripts('./uploadq.js');
// Bumped when the shell's contents change: activate drops every cache not in
// KEEP, so an installed app cannot keep serving the previous page offline.
const SHELL_CACHE = 'photomap-shell-v11';
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

/** Send what is queued, with no page open.
 *
 *  Deliberately plain: the photos were read, hashed and downscaled when they were
 *  picked, so all that is left is two POSTs each, and there is nobody watching a
 *  progress bar. It stops on the first answer that will repeat, and re-registers
 *  itself if anything is still waiting - a sync event that resolves is considered
 *  finished, so the way to be woken again is to ask again.
 */
async function drainQueue() {
  const db = await Q.open();
  if (await Q.getPref(db, 'wifiOnly', true) && Q.onWifi() === false) {
    return retryLater();
  }

  let stop = false;
  for (const rec of await Q.records(db)) {
    if (stop || rec.state === 'done') continue;
    try {
      if (!rec.iid) {
        const res = await fetch(Q.PROXY_PATH, {
          method: 'POST', headers: Q.headers(Q.proxyMeta(rec)), body: rec.proxy,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 507 || Q.fatal(res.status, 'http')) stop = true;
          rec.state = 'failed';
          rec.error = data.error || `the server answered ${res.status}`;
          await Q.put(db, rec);
          continue;
        }
        rec.iid = data.iid;
        rec.state = 'sent';
        await Q.put(db, rec);
        await Q.addSent(db, Q.hashKey(rec.sha256));
        if (rec.file_key) await Q.addSent(db, rec.file_key);
      }
      if (rec.full) {
        const res = await fetch(Q.fullPath(rec.iid), {
          method: 'POST', headers: Q.headers({ sha256: rec.sha256 }), body: rec.full,
        });
        if (res.ok || res.status === 413) {
          rec.full = null;
          rec.state = 'done';
          if (res.status === 413) rec.proxy_only = true;
        } else if (res.status === 507 || Q.fatal(res.status, 'http')) {
          stop = true;
        }
        await Q.put(db, rec);
      } else {
        rec.state = 'done';
        await Q.put(db, rec);
      }
    } catch {
      // The connection went while this was in flight. Left queued, and asked
      // for again below rather than retried in a tight loop here.
      rec.state = 'queued';
      await Q.put(db, rec);
      stop = true;
    }
  }

  const left = (await Q.records(db)).some((r) => r.state !== 'done');
  if (left) await retryLater();
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
