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
 * the /api/ passthrough. There is deliberately no Background Sync handler: an
 * upload only progresses while the page is open, and the viewer says so in its
 * own chip rather than implying a transfer is continuing in the background.
 */
// Bumped when the shell's contents change: activate drops every cache not in
// KEEP, so an installed app cannot keep serving the previous page offline.
const SHELL_CACHE = 'photomap-shell-v10';
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
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__')) return;

  event.respondWith(url.pathname.startsWith('/t/') ? thumbnail(request) : shell(request));
});

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
