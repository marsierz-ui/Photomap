import { api, thumbUrl } from './api.js';
import { state, params, emit, on, boundsToBbox, fmtNum, fmtDateTime, dayColor } from './state.js';
import { el, toast, escapeHtml, stripTags } from './ui.js';
import * as globe from './globe.js';
import { tileSpec, count, tileFailed } from './basemaps.js';

const MAX_MARKERS = 60000;
const MAX_PATH = 5000;

let map;
let heatLayer = null;
let clusterLayer = null;
let pointLayer = null;
let pathLayer = null;
let data = { n: 0, ids: [], lat: [], lon: [], ts: [] };
let mode = 'heat';
let showPath = false;
let byDay = false;
let showNotes = false;
let notesLayer = null;
let bubbleLayer = null;
let showBubbles = (() => {
  try { return localStorage.getItem('pm-bubbles') !== '0'; } catch { return true; }
})();
let picking = null;
let armed = false;
let loadToken = 0;
let deferred = false;

/** Whether there is anything real to draw into.
 *
 *  Two different sizes have to agree, and the difference is a real crash.
 *  leaflet.heat builds its canvas from map.getSize(), which Leaflet caches and
 *  only refreshes on invalidateSize; this measures the element. A container that
 *  gained its size without a resize event - a pane revealed while the window
 *  never moved - leaves that cache at 0x0 while the element measures fine, and
 *  the heat layer then calls getImageData on a zero-width canvas and throws. */
function hasSize() {
  const box = map.getContainer().getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return false;
  if (!map.getSize().x || !map.getSize().y) map.invalidateSize();
  return map.getSize().x > 0 && map.getSize().y > 0;
}

const bases = {};

function makeBase(name) {
  const t = tileSpec(name, '{r}');
  // A 512px tile at zoom z is drawn where Leaflet expects 256px tiles at z+1.
  const offset = t.tileSize === 512 ? -1 : 0;
  const layer = L.tileLayer(t.url, {
    attribution: t.attribution,
    maxZoom: 22, maxNativeZoom: t.maxzoom - offset, tileSize: t.tileSize, zoomOffset: offset,
  });
  if (t.kind) {
    layer.on('tileloadstart', () => count(t.kind));
    layer.on('tileerror', (e) => tileFailed(e.tile.src));
  }
  return layer;
}

/** (Re)build the three bases from the current provider, keeping whichever is shown. */
function buildBases() {
  const shown = Object.keys(bases).find((name) => map.hasLayer(bases[name])) || 'dark';
  Object.values(bases).forEach((layer) => map.removeLayer(layer));
  ['dark', 'streets', 'satellite'].forEach((name) => { bases[name] = makeBase(name); });
  bases[shown].addTo(map);
}

export function initMap() {
  map = L.map('map', {
    center: [25, 10],
    zoom: 3,
    maxZoom: 22,
    worldCopyJump: true,
    preferCanvas: true,
    zoomControl: true,
    boxZoom: false,
  });

  buildBases();

  map.on('moveend', () => {
    // A hidden pane is a zero-size container, and Leaflet still fires moveend
    // for it on a window resize. The bbox that comes out is a point, not a
    // viewport, so with "follow the map" on it would narrow every other view to
    // a rectangle nobody is looking at. The real bounds are still there when the
    // pane comes back.
    if (!hasSize()) return;
    state.bounds = boundsToBbox(map.getBounds());
    if (state.followMap) emit('filters');
  });
  map.on('click', (e) => endPick(e.latlng));
  // Rescaled to what is in view whenever the view changes; see visiblePeak.
  map.on('zoomend moveend', () => {
    if (heatLayer) heatLayer.setOptions(heatOptions());
    if (mode === 'points' && !picking) drawBubbles();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') endPick(null); });

  restoreHeatControls();
  wireControls();
  wireBoxSelect();
  // A zero-size container makes leaflet.heat throw in getImageData, so drawing
  // is deferred until the map actually has a size (background tab, collapsed
  // pane, tab not yet shown) and retried as soon as it gets one.
  new ResizeObserver(() => {
    if (!hasSize()) return;
    map.invalidateSize();
    if (deferred) { deferred = false; render(); }
  }).observe(map.getContainer());
  on('filters', load);
  // The globe fetches its renderer on first use, so the draw that asked for it
  // had nothing to draw on. It says when it is up.
  on('globeReady', () => { if (mode === 'globe') render(); });
  on('selection', () => { if (mode === 'points') render(); });
  on('dayNoteSaved', () => { if (showNotes) drawNotes(); });
  on('basemaps', buildBases);
  // A dark basemap under a light UI reads as a bug, so the two move together.
  on('theme', (mode2) => setBase(mode2 === 'light' ? 'streets' : 'dark'));
}

/** Wait for one click on the map and report where it landed. Resolves null if
 *  the pick is abandoned, so the caller can simply do nothing. */
export function pickLocation() {
  return new Promise((resolve) => {
    if (picking) picking(null);
    picking = resolve;
    map.getContainer().classList.add('selecting');
    // A bubble would take the click meant for the map.
    if (bubbleLayer) { map.removeLayer(bubbleLayer); bubbleLayer = null; }
    setStatus('Click the map to place it there · Esc to cancel');
  });
}

function endPick(at) {
  if (!picking) return;
  const resolve = picking;
  picking = null;
  map.getContainer().classList.remove('selecting');
  render();
  resolve(at);
}

export function setBase(name) {
  if (!bases[name] || map.hasLayer(bases[name])) return;
  Object.values(bases).forEach((layer) => map.removeLayer(layer));
  bases[name].addTo(map);
  [...el('base-mode').children].forEach((b) => b.classList.toggle('active', b.dataset.base === name));
}

export function refreshMapSize() {
  if (!map) return;
  // Called on every window resize, including while the map pane is hidden. A
  // hidden pane is a zero-size container, and leaflet.heat redraws itself on the
  // map's own moveend - straight into getImageData on a zero-width canvas, which
  // throws. Leaflet defers its resize handling to an animation frame, so
  // dropping the layers here happens first and leaves it nothing to redraw.
  if (!hasSize()) {
    clearLayers();
    deferred = true;
    return;
  }
  map.invalidateSize();
  globe.resize();
  if (deferred) render();
}

/** Zoom to the located photos in the current selection. Returns false if none. */
export function fitToSelection() {
  let s = 90; let w = 180; let nth = -90; let e = -180; let hits = 0;
  for (let i = 0; i < data.n; i += 1) {
    if (!state.selection.has(data.ids[i])) continue;
    hits += 1;
    if (data.lat[i] < s) s = data.lat[i];
    if (data.lat[i] > nth) nth = data.lat[i];
    if (data.lon[i] < w) w = data.lon[i];
    if (data.lon[i] > e) e = data.lon[i];
  }
  if (!hits) return false;
  frame(s, w, nth, e, 50, 17);
  return true;
}

/** Whichever of the two is on screen. Both "Fit to photos" and "Show on map"
 *  used to drive the leaflet map only, so in globe mode they did nothing. */
function frame(south, west, north, east, pad, maxZoom) {
  if (mode === 'globe') globe.fitTo(south, west, north, east, pad, maxZoom);
  else map.fitBounds([[south, west], [north, east]], { padding: [pad, pad], maxZoom });
}

// ------------------------------------------------------------------- loading

/** The map only ever shows located photos, so it asks for those - but not by
 *  overriding a location filter the person chose. Forcing gps=yes on top of
 *  "Approximate" or "Set from a neighbouring photo" made the map ignore it. */
const mapGps = () => (['any', 'no'].includes(state.filters.gps) ? 'yes' : state.filters.gps);

async function load() {
  const token = ++loadToken;
  setStatus('Loading…');
  try {
    const res = await api.get('/api/points', params({ bbox: false, extra: { gps: mapGps() } }));
    if (token !== loadToken) return;
    data = res;
  } catch (err) {
    setStatus(`Could not load points: ${err.message}`);
    return;
  }
  try {
    render();
  } catch (err) {
    // Keep the loaded data: a redraw may well succeed once layout settles.
    deferred = true;
    setStatus(`Could not draw the map: ${err.message}`);
  }
}

function albumColor() {
  if (!state.filters.album) return '#4aa3ff';
  const album = state.albums.find((a) => a.id === Number(state.filters.album));
  return album ? album.color : '#4aa3ff';
}

function clearLayers() {
  [heatLayer, clusterLayer, pointLayer, pathLayer, bubbleLayer].forEach((layer) => {
    if (layer) map.removeLayer(layer);
  });
  heatLayer = clusterLayer = pointLayer = pathLayer = bubbleLayer = null;
}

function render() {
  if (!hasSize()) {
    deferred = true;
    setStatus('Waiting for the map to be visible…');
    return;
  }
  deferred = false;
  // Leaflet keeps its zoom and attribution controls above everything in the
  // pane, so they sit on top of the globe unless the whole map is taken out of
  // sight. Hidden rather than removed: it keeps its size and comes straight
  // back, and something has to be under the globe while the globe is loading.
  el('map').classList.toggle('under-globe', mode === 'globe');

  if (mode === 'globe') {
    clearLayers();
    if (!globe.show(data)) {
      deferred = true;
      setStatus('Preparing the globe…');
      return;
    }
    globe.setPath(data, showPath, albumColor());
    const onGlobe = Math.min(data.n, globe.pointLimit);
    setStatus(data.n ? globe.label(onGlobe, data.n) + daySuffix(onGlobe)
                     : 'No photos with location for these filters');
    return;
  }
  globe.hide();

  clearLayers();
  const { n, lat, lon, ids } = data;
  if (!n) {
    setStatus('No photos with location for these filters');
    return;
  }
  const color = albumColor();

  if (mode === 'heat') {
    const pts = new Array(n);
    for (let i = 0; i < n; i += 1) pts[i] = [lat[i], lon[i], 1];
    heatLayer = L.heatLayer(pts, heatOptions()).addTo(map);
    setStatus(`${fmtNum(n)} located photos`);
  } else if (mode === 'cluster') {
    if (n > MAX_MARKERS) {
      setStatus(`${fmtNum(n)} located photos - too many for clustering, showing heat map`);
      const pts = new Array(n);
      for (let i = 0; i < n; i += 1) pts[i] = [lat[i], lon[i], 1];
      heatLayer = L.heatLayer(pts, heatOptions()).addTo(map);
    } else {
      clusterLayer = L.markerClusterGroup({
        chunkedLoading: true,
        maxClusterRadius: 45,
        spiderfyOnMaxZoom: true,
        disableClusteringAtZoom: 19,
      });
      const markers = new Array(n);
      for (let i = 0; i < n; i += 1) markers[i] = makeMarker(i, color);
      clusterLayer.addLayers(markers);
      bindPhotoEvents(clusterLayer);
      clusterLayer.addTo(map);
      setStatus(`${fmtNum(n)} located photos`);
    }
  } else {
    const capped = Math.min(n, 120000);
    pointLayer = L.featureGroup();
    const renderer = L.canvas({ padding: 0.3 });
    for (let i = 0; i < capped; i += 1) {
      const selected = state.selection.has(ids[i]);
      const shade = byDay ? dayColor(data.ts[i]) : color;
      L.circleMarker([lat[i], lon[i]], {
        radius: selected ? 6 : 4,
        color: selected ? '#fff' : shade,
        weight: selected ? 2 : 1,
        fillColor: shade,
        fillOpacity: 0.75,
        renderer,
        photoIndex: i,
      }).addTo(pointLayer);
    }
    bindPhotoEvents(pointLayer);
    pointLayer.addTo(map);
    drawBubbles();
    setStatus((capped < n ? `${fmtNum(capped)} of ${fmtNum(n)} shown` : `${fmtNum(n)} located photos`)
      + daySuffix(capped));
  }

  if (showPath && n > 1) {
    // Past MAX_PATH the line is drawn through evenly spaced photos, ends kept:
    // thousands of vertices make the SVG line crawl, and the shape of a trip is
    // the same at a fifth of the detail.
    const step = n > MAX_PATH ? (n - 1) / (MAX_PATH - 1) : 1;
    const count = Math.min(n, MAX_PATH);
    const line = new Array(count);
    for (let i = 0; i < count; i += 1) {
      const at = i === count - 1 ? n - 1 : Math.round(i * step);
      line[i] = [lat[at], lon[at]];
    }
    pathLayer = L.polyline(line, { color, weight: 1.5, opacity: 0.6, dashArray: '4 4' }).addTo(map);
    if (n > MAX_PATH) toast(`Path drawn through ${fmtNum(MAX_PATH)} of ${fmtNum(n)} photos`);
  }
}

function makeMarker(index, color) {
  const marker = L.marker([data.lat[index], data.lon[index]], {
    icon: L.divIcon({
      className: 'pin',
      html: `<i style="background:${color}"></i>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    }),
  });
  marker.options.photoIndex = index;
  return marker;
}

function bindPhotoEvents(layer) {
  layer.on('click', (e) => {
    const index = e.layer?.options?.photoIndex;
    if (index == null) return;
    if (e.originalEvent.ctrlKey || e.originalEvent.metaKey) {
      emit('toggleSelect', data.ids[index]);
    } else {
      emit('openPhoto', { id: data.ids[index], ids: data.ids });
    }
  });
  layer.on('mouseover', (e) => {
    const index = e.layer?.options?.photoIndex;
    if (index == null) return;
    const id = data.ids[index];
    e.layer
      .bindTooltip(
        `<img src="${thumbUrl(id, 160)}" width="140" alt="">` +
        `<div class="small muted">${fmtDateTime(data.ts[index])}</div>`,
        { direction: 'top', offset: [0, -8], opacity: 1 },
      )
      .openTooltip();
  });
}

// ------------------------------------------------------------------- bubbles

const BUBBLE_CELL = 70;
const MAX_BUBBLES = 160;

/** Thumbnails over the points, one per patch of screen so they do not pile up:
 *  the latest photo taken there, with how many share the patch. Rebuilt on
 *  every pan and zoom, since what counts as one patch depends on the zoom. */
function drawBubbles() {
  if (bubbleLayer) { map.removeLayer(bubbleLayer); bubbleLayer = null; }
  if (!showBubbles || mode !== 'points' || !data.n || !hasSize()) return;
  const view = map.getBounds();
  const size = map.getSize();
  const cells = new Map();
  for (let i = 0; i < data.n; i += 1) {
    if (!view.contains([data.lat[i], data.lon[i]])) continue;
    const p = map.latLngToContainerPoint([data.lat[i], data.lon[i]]);
    if (p.x < 0 || p.y < 0 || p.x > size.x || p.y > size.y) continue;
    const key = Math.floor(p.x / BUBBLE_CELL) * 65536 + Math.floor(p.y / BUBBLE_CELL);
    const cell = cells.get(key);
    // Points arrive in capture order, so the last one seen is the latest.
    if (cell) { cell.ids.push(data.ids[i]); cell.at = i; } else cells.set(key, { ids: [data.ids[i]], at: i });
  }
  const chosen = [...cells.values()].sort((a, b) => b.ids.length - a.ids.length).slice(0, MAX_BUBBLES);
  bubbleLayer = L.layerGroup(chosen.map((cell) => {
    const id = data.ids[cell.at];
    const marker = L.marker([data.lat[cell.at], data.lon[cell.at]], {
      icon: L.divIcon({
        className: 'bubble',
        html: `<img src="${thumbUrl(id, 160)}" loading="lazy" alt="">`
          + (cell.ids.length > 1 ? `<span class="n">${fmtNum(cell.ids.length)}</span>` : ''),
        iconSize: [48, 48],
        iconAnchor: [24, 58],
      }),
      riseOnHover: true,
    });
    // Newest first, so the photo on the bubble is the one that opens.
    marker.on('click', () => emit('openPhoto', { id, ids: [...cell.ids].reverse() }));
    return marker;
  })).addTo(map);
}

// ---------------------------------------------------------------- day notes

// Journal days sit outside the photo filters on purpose: a note is not a photo,
// and hiding it because the date range moved would be surprising. The layer is
// its own thing, added and removed only by its own switch.
async function drawNotes() {
  if (notesLayer) { map.removeLayer(notesLayer); notesLayer = null; }
  if (!showNotes) return;

  let days;
  try {
    days = await api.get('/api/days');
  } catch (err) {
    toast(`Could not load the journal: ${err.message}`, true);
    return;
  }
  const located = days.filter((d) => d.lat != null);
  if (!located.length) {
    toast(days.length ? 'No journal day has a location yet' : 'No journal days written yet');
    return;
  }

  notesLayer = L.layerGroup(located.map((day) => L.marker([day.lat, day.lon], {
    icon: L.divIcon({ className: 'note-pin', html: '<i>✎</i>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    title: day.day,
  }).bindPopup(
    `<strong>${day.day}</strong><div class="note-body">${escapeHtml(stripTags(day.text))}</div>`,
    { maxWidth: 260 },
  ))).addTo(map);
}

/** How many distinct capture days the colours are separating, once they mean
 *  something. Photos with no date share the fallback colour and are not days. */
function daySuffix(limit) {
  if (!byDay) return '';
  const days = new Set();
  for (let i = 0; i < limit; i += 1) {
    if (data.ts[i] != null) days.add(Math.floor(data.ts[i] / 86400));
  }
  return ` · ${fmtNum(days.size)} day${days.size === 1 ? '' : 's'}`;
}

// Radius, blur and intensity live in the settings table rather than
// localStorage: the database is what follows you to the phone. They are set in
// the settings dialog. Keys are new as of the zoom-relative intensity below,
// since a value saved for the old meaning would be wrong under the new one.
export const HEAT_DEFAULTS = { heat_r: 10, heat_b: 8, heat_i: 24 };
export const HEAT_RANGES = { heat_r: [3, 40], heat_b: [1, 30], heat_i: [1, 30] };
const heat = { ...HEAT_DEFAULTS };
let heatSaveTimer = null;

function restoreHeatControls() {
  const saved = state.config?.settings || {};
  Object.keys(HEAT_DEFAULTS).forEach((key) => {
    if (saved[key] != null && saved[key] !== '') heat[key] = Number(saved[key]);
  });
}

export const heatSettings = () => ({ ...heat });

/** Change one or more of the three, redraw now, save once the hand stops. */
export function setHeat(patch) {
  Object.assign(heat, patch);
  if (heatLayer) heatLayer.setOptions(heatOptions());
  clearTimeout(heatSaveTimer);
  heatSaveTimer = setTimeout(() => {
    // A slider position is not worth interrupting anyone over if it fails to save.
    api.post('/api/config/settings', { ...heat }).catch(() => {});
  }, 600);
}

/** The most photos that fall in one cell of leaflet.heat's own grid, among
 *  those on screen at this zoom.
 *
 *  The heat layer scales every photo by a fixed zoom curve and clips at a fixed
 *  maximum, so a whole country reads as one red blob and a street reads as a
 *  few faint dots. Measuring the busiest spot in view and scaling to it instead
 *  means the hottest place on screen is red at every zoom. */
function visiblePeak() {
  const cell = (heat.heat_r + heat.heat_b) / 2;
  const view = map.getBounds().pad(0.1);
  const s = view.getSouth(); const n = view.getNorth();
  const w = view.getWest(); const e = view.getEast();
  const wraps = e - w >= 360;
  const counts = new Map();
  let peak = 0;
  for (let i = 0; i < data.n; i += 1) {
    const lat = data.lat[i];
    if (lat < s || lat > n) continue;
    let lon = data.lon[i];
    if (!wraps) {
      // The view can sit across the antimeridian or on a world copy.
      while (lon < w) lon += 360;
      while (lon > e) lon -= 360;
      if (lon < w) continue;
    }
    const p = map.latLngToContainerPoint([lat, lon]);
    const key = Math.floor(p.x / cell) * 65536 + Math.floor(p.y / cell);
    const c = (counts.get(key) || 0) + 1;
    counts.set(key, c);
    if (c > peak) peak = c;
  }
  return peak;
}

function heatOptions() {
  // Intensity 1 keeps red for the single busiest spot; 30 turns red anything
  // with a tenth of its photos.
  const share = Math.max(0.06, 1.03 - heat.heat_i / 30);
  return {
    radius: heat.heat_r,
    blur: heat.heat_b,
    max: Math.max(1, visiblePeak() * share),
    minOpacity: 0.3,
    // At the current zoom, so the layer's own zoom curve does nothing: every
    // photo counts as one and the scale comes from max.
    maxZoom: map.getZoom(),
  };
}

function setStatus(text) {
  el('map-status').textContent = text;
}

// ------------------------------------------------------------------ controls

/** Disarmed on the surface that armed it, before the mode moves and the other
 *  one is asked to put a cursor back it never changed. */
function disarm() {
  if (!armed) return;
  armed = false;
  el('map-select').classList.remove('active');
  surface().aim(false);
}

function syncModeControls(view) {
  el('layer-mode').classList.toggle('hidden', view !== '2d');
  el('base-mode').classList.toggle('hidden', mode === 'globe');
  // Only the two per-photo renderings can carry a colour per photo.
  el('map-days').classList.toggle('hidden', mode !== 'points' && mode !== 'globe');
  el('map-bubbles').classList.toggle('hidden', mode !== 'points');
  // A replay draws its own route.
  el('map-path').classList.toggle('hidden', view === 'replay');
}

function wireControls() {
  // 2D is the flat map in whichever of its renderings was last chosen; 3D and
  // Replay both run on the globe surface, which is Mapbox Standard when Mapbox
  // is on and the MapLibre globe otherwise.
  let flatMode = mode;
  el('view-mode').addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    disarm();
    const view = button.dataset.view;
    mode = view === '2d' ? flatMode : 'globe';
    globe.setReplay(view === 'replay');
    [...e.currentTarget.children].forEach((b) => b.classList.toggle('active', b === button));
    syncModeControls(view);
    render();
  });

  el('layer-mode').addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    disarm();
    mode = flatMode = button.dataset.mode;
    [...e.currentTarget.children].forEach((b) => b.classList.toggle('active', b === button));
    syncModeControls('2d');
    render();
  });

  el('light-mode').addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    if (button.dataset.light) globe.setLight(button.dataset.light);
    else globe.setSatellite(!button.classList.contains('active'));
  });

  el('map-days').addEventListener('click', (e) => {
    byDay = !byDay;
    e.currentTarget.classList.toggle('active', byDay);
    globe.setDayColors(byDay);
    render();
  });

  el('map-bubbles').classList.toggle('active', showBubbles);
  el('map-bubbles').addEventListener('click', (e) => {
    showBubbles = !showBubbles;
    e.currentTarget.classList.toggle('active', showBubbles);
    try { localStorage.setItem('pm-bubbles', showBubbles ? '1' : '0'); } catch { /* private window */ }
    drawBubbles();
  });

  el('map-notes').addEventListener('click', (e) => {
    showNotes = !showNotes;
    e.currentTarget.classList.toggle('active', showNotes);
    drawNotes();
  });

  el('globe-skin').addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    globe.setSkin(button.dataset.skin);
    [...e.currentTarget.children].forEach((b) => b.classList.toggle('active', b === button));
  });

  el('base-mode').addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (button) setBase(button.dataset.base);
  });

  el('map-fit').addEventListener('click', fitToData);
  el('map-path').addEventListener('click', (e) => {
    showPath = !showPath;
    e.currentTarget.classList.toggle('active', showPath);
    render();
  });
  el('map-select').addEventListener('click', (e) => {
    armed = !armed;
    e.currentTarget.classList.toggle('active', armed);
    surface().aim(armed);
  });
}

export function fitToData() {
  if (!data.n) return;
  let s = 90; let w = 180; let nth = -90; let e = -180;
  for (let i = 0; i < data.n; i += 1) {
    if (data.lat[i] < s) s = data.lat[i];
    if (data.lat[i] > nth) nth = data.lat[i];
    if (data.lon[i] < w) w = data.lon[i];
    if (data.lon[i] > e) e = data.lon[i];
  }
  frame(s, w, nth, e, 40, 17);
}

export function flyToBounds(bounds) {
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
}

export function flyToPhoto(lat, lon) {
  if (mode === 'globe') {
    globe.flyTo(lat, lon);
    return;
  }
  map.setView([lat, lon], Math.max(map.getZoom(), 16));
}

// ---------------------------------------------------------------- box select

// The two surfaces answer the same drag differently. Leaflet turns the corners
// into a lat/lon box and asks the server, which catches photos scrolled off the
// edge of the pane. The globe cannot: a screen rectangle is not a coordinate
// rectangle on a sphere, so it asks the renderer which dots it drew in those
// pixels instead. Both take the same drag and both end in a selection.
const SURFACES = {
  leaflet: {
    box: () => map.getContainer(),
    at: (e) => map.mouseEventToContainerPoint(e),
    grab: (on) => (on ? map.dragging.enable() : map.dragging.disable()),
    aim: (on) => map.getContainer().classList.toggle('selecting', on),
    pick: async (from, to) => {
      const bounds = L.latLngBounds(map.containerPointToLatLng(from), map.containerPointToLatLng(to));
      const p = params({ bbox: false, extra: { gps: mapGps(), bbox: boundsToBbox(bounds) } });
      return (await api.get('/api/photos/ids', p)).ids;
    },
  },
  globe: {
    box: () => el('globe'),
    at: (e) => {
      const rect = el('globe').getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    },
    grab: (on) => globe.setBoxMode(!on),
    aim: (on) => globe.setBoxMode(on),
    pick: async (from, to) => globe.idsIn(from, to),
  },
};

const surface = () => (mode === 'globe' ? SURFACES.globe : SURFACES.leaflet);

function wireBoxSelect() {
  Object.values(SURFACES).forEach(wireBoxOn);
}

/** Each surface only sees a drag while it is the one on screen: the globe is
 *  display:none behind the others, and the map is visibility:hidden behind the
 *  globe. So there is nothing here to check which mode is on. */
function wireBoxOn(surf) {
  const container = surf.box();
  let start = null;
  let box = null;

  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || (!armed && !e.shiftKey)) return;
    e.preventDefault();
    surf.grab(false);
    start = surf.at(e);
    box = document.createElement('div');
    box.className = 'box-select';
    container.appendChild(box);
  });

  container.addEventListener('mousemove', (e) => {
    if (!start) return;
    const now = surf.at(e);
    box.style.left = `${Math.min(start.x, now.x)}px`;
    box.style.top = `${Math.min(start.y, now.y)}px`;
    box.style.width = `${Math.abs(now.x - start.x)}px`;
    box.style.height = `${Math.abs(now.y - start.y)}px`;
  });

  window.addEventListener('mouseup', async (e) => {
    if (!start) return;
    const end = surf.at(e);
    const from = start;
    start = null;
    box.remove();
    box = null;
    surf.grab(true);
    if (armed) {
      armed = false;
      el('map-select').classList.remove('active');
      surf.aim(false);
    }
    if (Math.abs(end.x - from.x) < 5 && Math.abs(end.y - from.y) < 5) return;

    const ids = await surf.pick(from, end);
    if (!ids.length) { toast('No photos in that area'); return; }
    emit('selectMany', ids);
    toast(`${fmtNum(ids.length)} photos selected`);
  });
}
