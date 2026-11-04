// 3D globe mode, on MapLibre GL JS's globe projection.
//
// The previous build stitched slippy tiles onto a three.js sphere by hand, and
// the engine under it never freed the levels you passed through on the way in:
// a dive from the whole planet to street level left every level resident until
// the GPU gave up and the canvas froze. The workarounds for that - a texture
// counter, a cache purge, a re-issued camera, a re-entrancy flag and a cooldown
// so the purge did not feed itself - were all bounding a leak that should not
// have needed bounding.
//
// So none of it is hand-rolled any more. The tile pyramid and its eviction, the
// point rendering, hit testing and the camera are MapLibre primitives, which is
// the same machinery that draws a normal map: there is no memory to police, and
// the renderer sleeps when nothing moves instead of spinning a frame loop.
import { thumbUrl } from './api.js';
import { state, emit, on, fmtNum, fmtDateTime, dayColor } from './state.js';
import { el, toast } from './ui.js';
import { tileSpec, mapboxKind, count as countTile, refused, useMapbox } from './basemaps.js';
import * as replay from './replay.js';
import { api } from './api.js';
import * as sky from './sky.js';

// Vendored rather than fetched from a CDN, so an outage cannot take the globe
// out. Resolved against this module's own URL: MapLibre finds its worker with
// `import.meta.url`, which has to land in the directory holding the other two
// files it ships with. See vendor/README.md.
const LIB = new URL('../vendor/maplibre-gl/maplibre-gl.mjs', import.meta.url).href;
const CSS = new URL('../vendor/maplibre-gl/maplibre-gl.css', import.meta.url).href;

// Mapbox Standard - 3D buildings, landmarks and dawn-to-night lighting - only
// renders in Mapbox's own GL JS. Fetched from Mapbox rather than vendored: it
// is only used while Mapbox serves the tiles anyway, so an outage of one is an
// outage of both, and the MapLibre globe takes over either way.
const MAPBOX_GL = 'https://api.mapbox.com/mapbox-gl-js/v3.33.0/';
const STANDARD = 'mapbox://styles/mapbox/standard';
const STANDARD_SATELLITE = 'mapbox://styles/mapbox/standard-satellite';
export const LIGHTS = ['dawn', 'day', 'dusk', 'night'];
// Zoomed in past this, the photo nearest the middle of the view sets the light
// and the weather; zoomed back out past UNFOCUS_ZOOM the globe goes back to its
// own look. The gap keeps a zoom hovering at the line from flickering.
const FOCUS_ZOOM = 11;
const UNFOCUS_ZOOM = 9;
// Light for the planet seen from orbit when the light follows the photos.
const ORBIT_LIGHT = 'day';
const DEM = 'mapbox://mapbox.mapbox-terrain-dem-v1';

// Same cap as the 2D points layer. MapLibre draws the whole set in one GPU call
// and tiles it on a worker, so the only cost that scales here is building the
// GeoJSON, which is why there is still a cap at all.
const MAX_POINTS = 120000;
// Same limit mapview.js applies to the flat map's Path: a line is a trip at
// thousands of points, a scribble - and a very slow one to build - past it.
const MAX_PATH = 5000;
const BASE_COLOR = '#4aa3ff';
const HOVER_SETTLE = 110;
const EMPTY = { type: 'FeatureCollection', features: [] };

// Retina tiles are four times the bytes for nothing on a 1x display, so ask for
// them the way the 2D map's {r} placeholder does: only where they show.
const RETINA = window.devicePixelRatio > 1 ? '@2x' : '';

// All skins live in the style at once and are switched by visibility. MapLibre
// only fetches tiles for a source a visible layer uses, so the hidden ones cost
// nothing, the visible one keeps whatever it had cached when you switch back,
// and the attribution control follows along on its own. `base` is the same
// basemap on the 2D map; basemaps.js decides who serves it.
const SKINS = {
  map: { layer: 'skin-map', base: 'dark' },
  streets: { layer: 'skin-streets', base: 'streets' },
  satellite: { layer: 'skin-satellite', base: 'satellite' },
};

// Built when asked, not at import: this module loads before the config does.
function skinSource(name) {
  const t = tileSpec(SKINS[name].base, RETINA);
  return { type: 'raster', tiles: [t.url], tileSize: t.tileSize, maxzoom: t.maxzoom, attribution: t.attribution };
}

/** Swap every skin's source for the provider now in force. A source's tile
 *  size cannot be changed in place, so each is removed and added again, under
 *  the path line as in the style. */
function rebuildSkins() {
  if (!ready) return;
  Object.entries(SKINS).forEach(([name, def]) => {
    map.removeLayer(def.layer);
    map.removeSource(def.layer);
    map.addSource(def.layer, skinSource(name));
    map.addLayer({ id: def.layer, type: 'raster', source: def.layer, layout: { visibility: vis(name) } }, 'path-line');
  });
}

let lib = null;
let map = null;
// Which renderer `map` is: 'mapbox' (Standard, 3D) or 'maplibre' (the globe on
// raster skins).
let engine = null;
let mapboxBroken = false;
let ready = false;
let booting = false;
let skin = 'map';
let byDay = false;
let count = 0;
let hovered = null;
let hoverTimer = null;
let tip = null;
let replaying = false;
let lastData = null;

const remembered = (key, fallback) => {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
};
const remember = (key, value) => {
  try { localStorage.setItem(key, value); } catch { /* private window */ }
};
// 'auto' follows the capture time of the photo in view; otherwise a preset.
let lightMode = remembered('pm-light', 'auto');
if (lightMode !== 'auto' && !LIGHTS.includes(lightMode)) lightMode = 'auto';
let light = lightMode === 'auto' ? ORBIT_LIGHT : lightMode;
let satellite = remembered('pm-3d-satellite', '0') === '1';
// Everything else in the style pop-up.
const STYLE_DEFAULTS = {
  theme: 'default', buildings: true, terrain: false, weather: true,
  places: true, pois: true, roads: true, spin: false,
};
let opts = { ...STYLE_DEFAULTS };
try { opts = { ...STYLE_DEFAULTS, ...JSON.parse(remembered('pm-3d-style', '{}')) }; } catch { /* keep defaults */ }
const saveOpts = () => remember('pm-3d-style', JSON.stringify(opts));

// The photo the light and weather are taken from, and its weather.
let focused = null;
let focusWeather = null;
let baseFog = undefined;
const weatherCache = new Map();
const weatherOn = () => state.config?.settings?.weather_enabled === '1';

const container = () => el('globe');
const shown = () => !container().classList.contains('hidden');
const wantEngine = () => (!mapboxBroken && useMapbox('loads') ? 'mapbox' : 'maplibre');

// The provider changed, or Mapbox ran out or said no. Raster skins can be
// swapped in place; a change of renderer means a new map.
on('basemaps', () => {
  if (!map) return;
  if (engine !== wantEngine()) {
    teardown();
    if (shown()) boot();
  } else if (engine === 'maplibre') {
    rebuildSkins();
  }
});

function teardown() {
  if (replaying) replay.exit();
  setHovered(null);
  clearTimeout(spinTimer);
  focused = null;
  focusWeather = null;
  baseFog = undefined;
  map.remove();
  map = null;
  ready = false;
  booting = false;
  engine = null;
}

// ------------------------------------------------------------------ loading

// MapLibre is around half a megabyte and most sessions never open the globe, so
// it is fetched the first time this mode is chosen rather than at boot.
let libPromise = null;

function loadLib() {
  if (!libPromise) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS;
    document.head.appendChild(link);
    // Cleared on failure rather than left holding the rejection: a promise, once
    // settled, replays the same outcome forever, so a network blip on the first
    // try would otherwise poison every later attempt without a byte going out.
    libPromise = import(LIB).catch((err) => { libPromise = null; throw err; });
  }
  return libPromise;
}

// A classic script, not a module: it sets window.mapboxgl.
let mapboxPromise = null;

function loadMapbox() {
  if (!mapboxPromise) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${MAPBOX_GL}mapbox-gl.css`;
    document.head.appendChild(link);
    mapboxPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${MAPBOX_GL}mapbox-gl.js`;
      script.onload = () => resolve(window.mapboxgl);
      script.onerror = () => {
        script.remove();
        mapboxPromise = null;
        reject(new Error('Mapbox GL JS could not be loaded'));
      };
      document.head.appendChild(script);
    });
  }
  return mapboxPromise;
}

function style() {
  return {
    version: 8,
    // "globe" is a preset: a sphere out to zoom 10, easing into mercator by 12,
    // which is where the sphere's precision runs out anyway. Zooming in stays a
    // map, so there is no cliff between this mode and the 2D one.
    projection: { type: 'globe' },
    // The halo around the planet, faded out as the sphere fills the frame -
    // atmosphere seen edge-on from orbit, not a blue rim around a street.
    sky: {
      'sky-color': '#0a1220',
      'horizon-color': '#1d3a5f',
      'fog-color': '#080b11',
      'sky-horizon-blend': 0.6,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.9, 5, 0.4, 8, 0],
    },
    sources: {
      'skin-map': skinSource('map'),
      'skin-streets': skinSource('streets'),
      'skin-satellite': skinSource('satellite'),
    },
    layers: [
      // The sphere before any tile lands. Without it the unpainted globe is
      // white, which flashes on every first zoom into a new region.
      { id: 'unpainted', type: 'background', paint: { 'background-color': '#0d1420' } },
      { id: 'skin-map', type: 'raster', source: 'skin-map', layout: { visibility: vis('map') } },
      { id: 'skin-streets', type: 'raster', source: 'skin-streets', layout: { visibility: vis('streets') } },
      { id: 'skin-satellite', type: 'raster', source: 'skin-satellite', layout: { visibility: vis('satellite') } },
    ],
  };
}

/** The photos and the trip line, on top of whichever basemap the renderer has.
 *  Added after the style loads, on both renderers, and again whenever Mapbox
 *  switches style (satellite on or off), which throws added layers away. With
 *  no slot, Mapbox Standard draws them above everything, labels included. */
function addDataLayers() {
  if (map.getSource('photos')) return;
  map.addSource('photos', { type: 'geojson', data: EMPTY });
  map.addSource('path', { type: 'geojson', data: EMPTY });
  // Under the points, not over them - a dashed line drawn across the dots it
  // connects reads worse than one sitting beneath them.
  map.addLayer({
    id: 'path-line',
    type: 'line',
    source: 'path',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': BASE_COLOR,
      'line-width': 1.5,
      'line-opacity': 0.6,
      'line-dasharray': [4, 4],
    },
  });
  map.addLayer({
    id: 'photos',
    type: 'circle',
    source: 'photos',
    paint: {
      // Small enough at world view that a city reads as a cluster of dots
      // rather than one blob, big enough close in to be worth aiming at.
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 0, 2.2, 4, 3, 8, 4.2, 14, 6],
      'circle-color': tint(),
      'circle-opacity': 0.9,
      // A dark rim separates overlapping dots; skipped when they are too small
      // for it to be anything but a smudge.
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 2, 0, 5, 0.8],
      'circle-stroke-color': 'rgba(0,0,0,.55)',
    },
  });
  map.addLayer({
    id: 'photo-hover',
    type: 'circle',
    source: 'photos',
    filter: ['==', ['get', 'id'], -1],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 0, 4.5, 8, 6.5, 14, 8.5],
      'circle-color': tint(),
      'circle-stroke-width': 2,
      'circle-stroke-color': '#fff',
    },
  });
  // Standard lights the scene for the time of day, custom layers included, so
  // at dusk or night the dots and the route would sink into the dark. Lit from
  // within instead. MapLibre does not know these properties.
  if (engine === 'mapbox') {
    map.setPaintProperty('path-line', 'line-emissive-strength', 1);
    map.setPaintProperty('photos', 'circle-emissive-strength', 1);
    map.setPaintProperty('photo-hover', 'circle-emissive-strength', 1);
  }
}

// The style is built with the skin and the colouring already chosen rather than
// corrected afterwards, so the globe is painted the moment it has a style -
// with no frame in between showing a bare sphere.
const vis = (name) => (name === skin ? 'visible' : 'none');
const tint = () => (byDay ? ['get', 'c'] : BASE_COLOR);

/** Creation waits for the pane to have a size: a zero-size canvas comes up
 *  blank and stays blank until something resizes it. */
async function boot() {
  if (booting || map) return;
  const box = container();
  const rect = box.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  booting = true;
  const want = wantEngine();
  try {
    if (want === 'mapbox') {
      lib = await loadMapbox();
      lib.accessToken = state.config.settings.mapbox_token;
    } else {
      lib = await loadLib();
    }
    engine = want;
    if (engine === 'mapbox') createMapbox(box); else create(box);
    syncControls();
  } catch (err) {
    booting = false;
    if (want === 'mapbox') {
      // Mapbox's script did not arrive: the MapLibre globe, for this session.
      mapboxBroken = true;
      boot();
      return;
    }
    // Two real cases: the file did not load, or the machine has no WebGL2,
    // which MapLibre requires. Cleared here rather than left set, so a retry
    // (reopening the globe, or a network blip clearing up) gets another
    // attempt instead of the pane sitting on "Preparing the globe…" forever.
    el('map-status').textContent = `The globe is unavailable here: ${err.message}`;
  }
}

/** Mapbox Standard: a globe from far out, 3D buildings and landmarks close in,
 *  lit for the time of day chosen. Billed per map load, so one is counted here. */
function createMapbox(box) {
  countTile('loads');
  map = new lib.Map({
    container: box,
    style: satellite ? STANDARD_SATELLITE : STANDARD,
    config: { basemap: { lightPreset: light } },
    projection: 'globe',
    center: [10, 25],
    zoom: 1.4,
    // Shift-drag is box select here, as on the 2D map.
    boxZoom: false,
    // Mapbox's terms want the logo visible; bottom-left is where the status
    // line sits.
    logoPosition: 'bottom-right',
  });
  map.addControl(new lib.NavigationControl({ visualizePitch: true }), 'top-left');
  onLoaded();
  map.on('error', (e) => {
    // Only the map services count: GL JS also posts telemetry to
    // events.mapbox.com, and a 429 there says nothing about the maps.
    if ([401, 403, 429].includes(e.error?.status) && mapboxKind(e.error?.url)) refused(e.error.status);
    else console.warn('3D map:', e.error?.message || e.type);
  });
}

/** style.load, not load: load also waits for the first frame to be painted,
 *  and a browser gives a background tab no frames at all. Everything here needs
 *  the style, not a picture of it. Fires again when Mapbox switches style. */
function onLoaded() {
  map.on('style.load', () => {
    addDataLayers();
    // A new style starts from its own defaults: lighting, fog, terrain.
    if (engine === 'mapbox') {
      baseFog = map.getFog ? map.getFog() : null;
      applyStyleOptions();
      applyWeather(focusWeather);
    }
    if (!ready) {
      ready = true;
      booting = false;
      wire();
    }
    // Only matters if the mode buttons were used while the renderer was still
    // being fetched.
    setSkin(skin);
    setDayColors(byDay);
    // The pane is up but has no points yet: tell the map view to draw them.
    emit('globeReady');
  });
}

function create(box) {
  map = new lib.Map({
    container: box,
    style: style(),
    center: [10, 25],
    zoom: 1.4,
    minZoom: 0,
    // Deeper than this a pixel is under a metre, which no basemap here serves.
    maxZoom: 19,
    attributionControl: { compact: true },
    // Dragging spins the globe; tilting it only makes the far side ambiguous.
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    // Shift-drag is box select here, as it is on the 2D map. MapLibre would
    // otherwise take it as box zoom.
    boxZoom: false,
    // Tiles you zoomed through are worth keeping for the way back out, but only
    // a few levels of them - the rest is memory held against a trip nobody
    // makes, which is exactly what sank the last build.
    maxTileCacheZoomLevels: 3,
    // Every Mapbox tile counts against its free tier, so each one is tallied
    // on its way out.
    transformRequest: (url, type) => {
      const kind = type === 'Tile' && mapboxKind(url);
      if (kind) countTile(kind);
      return { url };
    },
  });

  map.addControl(new lib.NavigationControl({ showCompass: false }), 'top-left');
  onLoaded();

  // Without a listener MapLibre logs every miss itself, and a satellite tile
  // that does not exist over open ocean is normal rather than news.
  map.on('error', (e) => {
    if ([401, 403, 429].includes(e.error?.status) && mapboxKind(e.error?.url)) refused(e.error.status);
    else console.warn('globe:', e.error?.message || e.type);
  });
}

function wire() {
  map.on('mousemove', 'photos', (e) => {
    // A drag is a spin, not a hover, and mousemove fires throughout one.
    if (!map.isMoving()) setHovered(pick(e.features[0]));
  });
  map.on('mouseleave', 'photos', () => setHovered(null));
  map.on('movestart', () => setHovered(null));
  map.on('moveend', () => { refocus(); spinLater(); });
  // Any hand on the map stops the spin until it is let go.
  ['mousedown', 'touchstart'].forEach((ev) => map.on(ev, () => { interacting = true; }));
  ['mouseup', 'touchend'].forEach((ev) => map.on(ev, () => { interacting = false; spinLater(); }));
  map.on('click', 'photos', (e) => {
    const id = e.features[0].properties.id;
    emit('openPhoto', { id, ids: [id] });
  });

  map.on('webglcontextlost', () => {
    el('map-status').textContent = 'The globe lost its graphics context - it will come back on its own';
  });
  map.on('webglcontextrestored', () => emit('globeReady'));
}

// ------------------------------------------------------------------- hover

/** Tile geometry is quantised, so the coordinates that come back are the dot's
 *  own position to within well under a pixel - close enough to hang a preview
 *  on, and free compared to keeping a parallel copy of the data to look up. */
function pick(feature) {
  const [lon, lat] = feature.geometry.coordinates;
  return { id: feature.properties.id, ts: feature.properties.ts ?? null, lon, lat };
}

function setHovered(point) {
  // hide() runs on every redraw of the other map modes, including before the
  // globe has ever been built.
  if (!map) return;
  if (point?.id === hovered?.id) return;
  hovered = point;
  map.getCanvas().style.cursor = point ? 'pointer' : '';
  map.setFilter('photo-hover', ['==', ['get', 'id'], point ? point.id : -1]);
  clearTimeout(hoverTimer);
  if (!point) { showTip(null); return; }
  // Sweeping the cursor over the globe crosses dozens of photos. Showing each
  // one would fire a thumbnail request per photo crossed, which is what made
  // hovering stutter; wait for the pointer to settle on one instead.
  hoverTimer = setTimeout(() => showTip(point), HOVER_SETTLE);
}

function ensureTip() {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.className = 'globe-tip hidden';
  // Built once and reused: rewriting innerHTML per hover threw the <img> away
  // and reloaded the same picture from scratch.
  tip.innerHTML = '<img width="130" alt=""><div class="small muted"></div>';
  container().appendChild(tip);
  return tip;
}

function showTip(point) {
  const box = ensureTip();
  if (!point) { box.classList.add('hidden'); return; }

  const image = box.firstChild;
  // 256 rather than a size of its own: that is what the gallery and the
  // settings default already cache, so a hover is usually a cache hit instead
  // of the server decoding the full-size photo to make one more thumbnail.
  const url = thumbUrl(point.id, 256);
  if (image.getAttribute('src') !== url) {
    image.setAttribute('src', url);
    // Until it decodes, the box has no height to position against.
    image.onload = () => { if (hovered?.id === point.id) place(box, point); };
  }
  box.lastChild.textContent = fmtDateTime(point.ts);
  box.classList.remove('hidden');
  place(box, point);
}

/** Over the photo it describes, not parked in a corner - and never hanging off
 *  the edge of the pane. Above the dot when there is room, below it when not. */
function place(box, point) {
  const rect = container().getBoundingClientRect();
  const at = map.project([point.lon, point.lat]);
  const width = box.offsetWidth;
  const height = box.offsetHeight;
  const above = at.y - height - 14;
  const clamp = (value, limit) => Math.max(6, Math.min(limit, value));
  box.style.left = `${clamp(at.x - width / 2, rect.width - width - 6)}px`;
  box.style.top = `${clamp(above >= 6 ? above : at.y + 18, rect.height - height - 6)}px`;
}

// -------------------------------------------------------------------- data

/** Both colours ride along on every point so that switching between them is a
 *  paint property rather than a rebuild of the whole set. */
function toGeoJSON(data, n) {
  const features = new Array(n);
  const cache = new Map();
  for (let i = 0; i < n; i += 1) {
    const ts = data.ts[i];
    const day = ts == null ? -1 : Math.floor(ts / 86400);
    let color = cache.get(day);
    if (!color) { color = dayColor(ts); cache.set(day, color); }
    features[i] = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [data.lon[i], data.lat[i]] },
      properties: { id: data.ids[i], ts, c: color },
    };
  }
  return { type: 'FeatureCollection', features };
}

// ------------------------------------------------------------------ exports

/** The style pop-up button shows with the 3D pane; what is inside depends on
 *  the renderer. */
function syncControls() {
  el('style-wrap').classList.toggle('hidden', !shown());
  if (!shown()) closePop();
  else if (!el('style-pop').classList.contains('hidden')) renderPop();
}

// ------------------------------------------------------------ style pop-up

const seg = (name, items, current) => `<div class="seg" data-group="${name}">${items
  .map(([value, text, title]) => `<button data-value="${value}"${title ? ` title="${title}"` : ''}${String(value) === String(current) ? ' class="active"' : ''}>${text}</button>`)
  .join('')}</div>`;
const check = (key, text, disabled = false) =>
  `<label class="pop-check${disabled ? ' off' : ''}"><input type="checkbox" data-opt="${key}"${opts[key] ? ' checked' : ''}${disabled ? ' disabled' : ''}> ${text}</label>`;

function renderPop() {
  const pop = el('style-pop');
  const mb = engine === 'mapbox';
  const autoHint = focused
    ? `Now: ${light} - ${fmtDateTime(focused.ts)}`
    : 'Zoom in on a photo, or replay, and the light follows when it was taken';
  pop.innerHTML = mb ? `
    <div class="pop-h">Light</div>
    ${seg('light', [['auto', 'Auto', 'Follow the time each photo was taken'], ...LIGHTS.map((l) => [l, l[0].toUpperCase() + l.slice(1)])], lightMode)}
    <div class="pop-hint">${lightMode === 'auto' ? escapeText(autoHint) : 'Fixed light for every photo'}</div>
    <div class="pop-h">Map</div>
    ${seg('base', [['standard', 'Standard', '3D buildings and landmarks'], ['satellite', 'Satellite', 'Satellite imagery under the labels']], satellite ? 'satellite' : 'standard')}
    <div class="pop-h">Colours</div>
    ${seg('theme', [['default', 'Default'], ['faded', 'Faded'], ['monochrome', 'Mono']], opts.theme)}
    <div class="pop-h">Show</div>
    <div class="pop-grid">
      ${check('weather', 'Weather of the photo', !weatherOn())}
      ${check('terrain', 'Terrain')}
      ${check('buildings', '3D buildings', satellite)}
      ${check('places', 'Place names')}
      ${check('pois', 'Points of interest')}
      ${check('roads', 'Road names')}
      ${check('spin', 'Spin the globe when idle')}
    </div>
    ${weatherOn() ? '' : '<div class="pop-hint">Turn weather on in ⚙ Settings to draw rain, snow and fog from the day each photo was taken.</div>'}`
    : `
    <div class="pop-h">Map</div>
    ${seg('skin', [['map', 'Map'], ['streets', 'Streets'], ['satellite', 'Satellite']], skin)}
    <div class="pop-h">Show</div>
    <div class="pop-grid">${check('spin', 'Spin the globe when idle')}</div>
    <div class="pop-hint">Lighting by photo time, weather effects, terrain and 3D buildings need Mapbox
      (⚙ Settings → Map provider).</div>`;
}

const escapeText = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function closePop() {
  el('style-pop').classList.add('hidden');
  el('style-btn').classList.remove('active');
}

function wirePop() {
  const pop = el('style-pop');
  el('style-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = pop.classList.contains('hidden');
    if (open) renderPop();
    pop.classList.toggle('hidden', !open);
    el('style-btn').classList.toggle('active', open);
  });
  // Outside the pop-up closes it; inside does not.
  document.addEventListener('click', (e) => {
    if (!pop.classList.contains('hidden') && !el('style-wrap').contains(e.target)) closePop();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
  pop.addEventListener('click', (e) => {
    const button = e.target.closest('[data-group] button');
    if (!button) return;
    const { group } = button.parentElement.dataset;
    const value = button.dataset.value;
    if (group === 'light') setLight(value);
    else if (group === 'base') setSatellite(value === 'satellite');
    else if (group === 'skin') setSkin(value);
    else if (group === 'theme') { opts.theme = value; saveOpts(); applyStyleOptions(); }
    renderPop();
  });
  pop.addEventListener('change', (e) => {
    const key = e.target.dataset.opt;
    if (!key) return;
    opts[key] = e.target.checked;
    saveOpts();
    if (key === 'weather') applyWeather(focusWeather);
    else if (key === 'spin') spinLater();
    else applyStyleOptions();
  });
}
wirePop();

/** Everything in the pop-up that lives in the Mapbox style. */
function applyStyleOptions() {
  if (engine !== 'mapbox' || !map || !(ready || map.isStyleLoaded())) return;
  const set = (key, value) => { try { map.setConfigProperty('basemap', key, value); } catch { /* not in this style */ } };
  set('lightPreset', light);
  set('showPlaceLabels', opts.places);
  set('showPointOfInterestLabels', opts.pois);
  set('showRoadLabels', opts.roads);
  if (!satellite) {
    // A grey day is shown faded, unless a theme of its own was chosen.
    const mood = opts.weather && opts.theme === 'default' ? sky.effects(focusWeather).mood : null;
    set('theme', mood || opts.theme);
    set('show3dObjects', opts.buildings);
  }
  if (opts.terrain) {
    if (!map.getSource('pm-dem')) map.addSource('pm-dem', { type: 'raster-dem', url: DEM, tileSize: 512, maxzoom: 14 });
    map.setTerrain({ source: 'pm-dem', exaggeration: 1.4 });
  } else if (map.getTerrain && map.getTerrain()) {
    map.setTerrain(null);
  }
}

/** Rain, snow and fog for a photo's weather, or the style's own sky for none.
 *  Rain and snow are Mapbox GL JS 3.9+; anything older just skips them. */
function applyWeather(w) {
  if (engine !== 'mapbox' || !map) return;
  const fx = sky.effects(opts.weather ? w : null);
  try { if (map.setRain) map.setRain(fx.rain); } catch (err) { console.warn('rain:', err.message); }
  try { if (map.setSnow) map.setSnow(fx.snow); } catch (err) { console.warn('snow:', err.message); }
  try {
    if (fx.fog) map.setFog({ ...(baseFog || {}), ...fx.fog });
    else if (baseFog !== undefined) map.setFog(baseFog);
  } catch (err) { console.warn('fog:', err.message); }
  if (!satellite && opts.theme === 'default') {
    try { map.setConfigProperty('basemap', 'theme', fx.mood || 'default'); } catch { /* older style */ }
  }
}

// ------------------------------------------------------ photo time and weather

function weatherChip() {
  let chip = container().querySelector('.globe-weather');
  if (!chip) {
    chip = document.createElement('div');
    chip.className = 'globe-weather hidden';
    chip.title = 'Open this photo';
    chip.onclick = () => { if (focused) emit('openPhoto', { id: focused.id, ids: [focused.id] }); };
    container().appendChild(chip);
  }
  return chip;
}

function showChip() {
  const chip = weatherChip();
  if (!focused) { chip.classList.add('hidden'); return; }
  const night = light === 'night';
  const parts = [fmtDateTime(focused.ts)];
  if (focusWeather) parts.push(sky.describe(focusWeather, { night }));
  else if (weatherOn() && focused.loading) parts.push('Looking up the weather…');
  chip.textContent = parts.join('  ·  ');
  chip.classList.remove('hidden');
}

async function weatherFor(id) {
  if (!weatherOn() || id == null) return null;
  if (weatherCache.has(id)) return weatherCache.get(id);
  try {
    const res = await api.get(`/api/photos/${id}/weather`);
    // Only answers worth keeping are kept; an offline blip is asked again.
    if (res.weather || res.reason !== 'unavailable') weatherCache.set(id, res.weather || null);
    return res.weather || null;
  } catch {
    return null;
  }
}

/** Make `photo` ({id, ts, lat, lon}) the one the sky follows. Resolves to its
 *  weather. */
async function focusOn(photo) {
  if (focused?.id === photo?.id) return focusWeather;
  focused = photo ? { ...photo, loading: true } : null;
  focusWeather = null;
  if (!photo) {
    if (lightMode === 'auto') applyLight(ORBIT_LIGHT);
    applyWeather(null);
    showChip();
    return null;
  }
  // The light first, from the sun's position: it needs no network.
  if (lightMode === 'auto') applyLight(sky.lightFor(photo.ts, photo.lat, photo.lon) || ORBIT_LIGHT);
  showChip();
  const w = await weatherFor(photo.id);
  if (focused?.id !== photo.id) return w;
  focused.loading = false;
  focusWeather = w;
  // With the real time zone, sunrise and sunset are exact.
  if (w && lightMode === 'auto') applyLight(sky.lightFor(photo.ts, photo.lat, photo.lon, w) || ORBIT_LIGHT);
  applyWeather(w);
  showChip();
  if (!el('style-pop').classList.contains('hidden')) renderPop();
  return w;
}

function applyLight(name) {
  light = name;
  if (ready && engine === 'mapbox') map.setConfigProperty('basemap', 'lightPreset', name);
}

/** The photo nearest the middle of the view, if it is in view at all. */
function nearestToCentre() {
  if (!lastData || !lastData.n) return null;
  const c = map.getCenter();
  const bounds = map.getBounds();
  const shrink = Math.cos(c.lat * Math.PI / 180) ** 2;
  let best = -1;
  let bestD = Infinity;
  const n = Math.min(lastData.n, MAX_POINTS);
  for (let i = 0; i < n; i += 1) {
    const dy = lastData.lat[i] - c.lat;
    const dx = lastData.lon[i] - c.lng;
    const d = dy * dy + dx * dx * shrink;
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0 || !bounds.contains([lastData.lon[best], lastData.lat[best]])) return null;
  return { id: lastData.ids[best], ts: lastData.ts[best], lat: lastData.lat[best], lon: lastData.lon[best] };
}

/** After every move: zoomed in, the sky follows the photo in the middle;
 *  zoomed out, it lets go. A replay sets it per stop instead. */
function refocus() {
  if (!ready || replay.active()) return;
  const z = map.getZoom();
  if (z >= FOCUS_ZOOM) {
    const photo = nearestToCentre();
    if (photo) focusOn(photo);
  } else if (z < UNFOCUS_ZOOM && focused) {
    focusOn(null);
  }
}

// ------------------------------------------------------------------- spin

let interacting = false;
let spinTimer = null;

/** A slow turn of the planet while nobody is touching it. One degree a second
 *  at the equator, eased so it never stops with a jolt. */
function spinLater() {
  clearTimeout(spinTimer);
  if (!opts.spin || !ready || !shown() || replay.active()) return;
  spinTimer = setTimeout(() => {
    if (!opts.spin || interacting || replay.active() || !shown() || map.getZoom() > 5) return;
    const c = map.getCenter();
    map.easeTo({ center: [c.lng - 2, c.lat], duration: 2000, easing: (t) => t });
  }, interacting ? 2000 : 30);
}

// While a replay runs it owns the trip line: solid, thicker, drawn as it flies.
const replayHooks = {
  route: (coords) => {
    if (!ready) return;
    map.getSource('path').setData(coords.length > 1
      ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }
      : EMPTY);
  },
  highlight: (id) => { if (ready) map.setFilter('photo-hover', ['==', ['get', 'id'], id]); },
  // Each stop sets the light and the weather; resolves to the weather's text
  // for the stop's card.
  stop: async (stop) => {
    if (!stop) return '';
    const w = await focusOn({ id: stop.ids[0], ts: stop.first, lat: stop.lat, lon: stop.lon });
    return w ? sky.describe(w, { short: true, night: light === 'night' }) : '';
  },
};

function lineStyle(forReplay) {
  map.setPaintProperty('path-line', 'line-dasharray', forReplay ? [1, 0] : [4, 4]);
  map.setPaintProperty('path-line', 'line-width', forReplay ? 3.5 : 1.5);
  map.setPaintProperty('path-line', 'line-opacity', forReplay ? 0.95 : 0.6);
  if (forReplay) map.setPaintProperty('path-line', 'line-color', '#ffb020');
}

export function show(data) {
  container().classList.remove('hidden');
  syncControls();
  if (!ready) { boot(); return false; }
  resize();
  update(data);
  lastData = data;
  spinLater();
  if (replaying) {
    if (replay.active()) replay.setData(data);
    else { lineStyle(true); replay.enter(map, container(), data, replayHooks); }
  }
  return true;
}

export function hide() {
  container().classList.add('hidden');
  syncControls();
  setHovered(null);
  clearTimeout(spinTimer);
  if (replay.active()) replay.exit();
}

/** Animation mode: on the same surface, the camera replays the trip. */
export function setReplay(on) {
  if (replaying === on) return;
  replaying = on;
  if (!ready) return;
  if (on) {
    lineStyle(true);
    replay.enter(map, container(), lastData, replayHooks);
  } else {
    replay.exit();
    lineStyle(false);
    focusOn(null);
    map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
  }
}

/** 'auto' or one of LIGHTS. */
export function setLight(name) {
  if (name !== 'auto' && !LIGHTS.includes(name)) return;
  lightMode = name;
  remember('pm-light', name);
  if (name === 'auto') {
    applyLight(focused ? sky.lightFor(focused.ts, focused.lat, focused.lon, focusWeather) || ORBIT_LIGHT : ORBIT_LIGHT);
  } else {
    applyLight(name);
  }
  showChip();
}

/** Standard Satellite is a different style, so the switch reloads it; the
 *  photo layers come back through onLoaded. */
export function setSatellite(on) {
  satellite = on;
  remember('pm-3d-satellite', on ? '1' : '0');
  if (ready && engine === 'mapbox') {
    if (replay.active()) replay.exit();
    map.setStyle(on ? STANDARD_SATELLITE : STANDARD);
  }
}

export function update(data) {
  if (!ready || !data) return 0;
  setHovered(null);
  count = Math.min(data.n, MAX_POINTS);
  map.getSource('photos').setData(count ? toGeoJSON(data, count) : EMPTY);
  return count;
}

/** The trip line. `data.lat`/`data.lon` already arrive in capture order -
 *  /api/points sorts by taken_ts - so unlike the point layer this draws
 *  straight from the arrays with no rebuild of its own.
 *
 *  Never capped to MAX_POINTS: that limit exists so tens of thousands of
 *  circles stay paintable, and a LineString of the same length is one
 *  geometry, not one draw call per vertex. It has its own ceiling instead,
 *  matching the flat map's Path exactly, including the warning once it is
 *  past drawing at all. */
export function setPath(data, on, color) {
  if (!ready || replaying) return;
  const source = map.getSource('path');
  const n = data ? data.n : 0;
  if (on && n > 1) {
    // Past MAX_PATH the line runs through evenly spaced photos, ends kept, as on
    // the flat map.
    const step = n > MAX_PATH ? (n - 1) / (MAX_PATH - 1) : 1;
    const count = Math.min(n, MAX_PATH);
    const coords = new Array(count);
    for (let i = 0; i < count; i += 1) {
      const at = i === count - 1 ? n - 1 : Math.round(i * step);
      coords[i] = [data.lon[at], data.lat[at]];
    }
    map.setPaintProperty('path-line', 'line-color', color);
    source.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
  } else {
    source.setData(EMPTY);
  }
}

export function resize() {
  if (!map) return;
  // display:none leaves the container at 0x0, and resizing to that throws the
  // camera away; the pane calls this on every layout change either way.
  const rect = container().getBoundingClientRect();
  if (rect.width && rect.height) map.resize();
}

export function setSkin(name) {
  if (!SKINS[name]) return;
  skin = name;
  if (!ready || engine !== 'maplibre') return;
  Object.entries(SKINS).forEach(([key, def]) => {
    map.setLayoutProperty(def.layer, 'visibility', key === name ? 'visible' : 'none');
  });
}

export function setDayColors(on) {
  byDay = on;
  if (!ready) return;
  const color = on ? ['get', 'c'] : BASE_COLOR;
  map.setPaintProperty('photos', 'circle-color', color);
  map.setPaintProperty('photo-hover', 'circle-color', color);
}

/** Spin to a location and zoom in, used when jumping to a photo. Stops at the
 *  zoom where the sphere hands over to mercator, so this stays a globe. */
export function flyTo(lat, lon) {
  if (map) map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 9), duration: 1400 });
}

/** Box select: the globe has to stop spinning under the drag, and the cursor
 *  has to say that it will. */
export function setBoxMode(on) {
  if (!map) return;
  if (on) map.dragPan.disable(); else map.dragPan.enable();
  map.getCanvas().style.cursor = on ? 'crosshair' : '';
}

/** The photos inside a screen rectangle.
 *
 *  Screen space, not a lat/lon box: a rectangle drawn on a sphere is not a
 *  rectangle in coordinates - near the edge it bends around the limb, and over
 *  a pole the corners do not bound anything. Asking the renderer what it
 *  actually drew inside those pixels answers the question the drag asked, and
 *  leaves out the photos on the far side of the planet, which are behind the
 *  globe rather than under the box. */
export function idsIn(from, to) {
  if (!map) return [];
  const corners = [
    [Math.min(from.x, to.x), Math.min(from.y, to.y)],
    [Math.max(from.x, to.x), Math.max(from.y, to.y)],
  ];
  // A point on a tile boundary is in both tiles, so it comes back twice.
  return [...new Set(map.queryRenderedFeatures(corners, { layers: ['photos'] })
    .map((f) => f.properties.id))];
}

/** Frame a lat/lon box, for "Fit to photos" and "Show on map". */
export function fitTo(south, west, north, east, pad, maxZoom) {
  if (map) map.fitBounds([[west, south], [east, north]], { padding: pad, maxZoom, duration: 1000 });
}

export const pointLimit = MAX_POINTS;
export const label = (shown, total) =>
  shown < total ? `${fmtNum(shown)} of ${fmtNum(total)} on the globe` : `${fmtNum(total)} located photos`;
