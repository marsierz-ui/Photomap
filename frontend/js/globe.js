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
import { emit, fmtNum, fmtDateTime, dayColor } from './state.js';
import { el, toast } from './ui.js';

// Vendored rather than fetched from a CDN, so an outage cannot take the globe
// out. Resolved against this module's own URL: MapLibre finds its worker with
// `import.meta.url`, which has to land in the directory holding the other two
// files it ships with. See vendor/README.md.
const LIB = new URL('../vendor/maplibre-gl/maplibre-gl.mjs', import.meta.url).href;
const CSS = new URL('../vendor/maplibre-gl/maplibre-gl.css', import.meta.url).href;

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

// Both skins live in the style at once and are switched by visibility. MapLibre
// only fetches tiles for a source a visible layer uses, so the hidden one costs
// nothing, the visible one keeps whatever it had cached when you switch back,
// and the attribution control follows along on its own.
const SKINS = {
  map: {
    layer: 'skin-map',
    source: {
      type: 'raster',
      tiles: [...'abcd'].map((s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}${RETINA}.png`),
      tileSize: 256,
      maxzoom: 20,
      attribution: '&copy; OpenStreetMap, &copy; CARTO',
    },
  },
  // Same tile source as the 2D map's Streets basemap: a single host, no retina
  // set - unlike CARTO, raw OSM tiles do not offer an @2x variant.
  streets: {
    layer: 'skin-streets',
    source: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    },
  },
  satellite: {
    layer: 'skin-satellite',
    source: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Imagery &copy; Esri',
    },
  },
};

let maplibre = null;
let map = null;
let ready = false;
let booting = false;
let skin = 'map';
let byDay = false;
let count = 0;
let hovered = null;
let hoverTimer = null;
let tip = null;

const container = () => el('globe');

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
      'skin-map': SKINS.map.source,
      'skin-streets': SKINS.streets.source,
      'skin-satellite': SKINS.satellite.source,
      photos: { type: 'geojson', data: EMPTY },
      path: { type: 'geojson', data: EMPTY },
    },
    layers: [
      // The sphere before any tile lands. Without it the unpainted globe is
      // white, which flashes on every first zoom into a new region.
      { id: 'unpainted', type: 'background', paint: { 'background-color': '#0d1420' } },
      { id: 'skin-map', type: 'raster', source: 'skin-map', layout: { visibility: vis('map') } },
      { id: 'skin-streets', type: 'raster', source: 'skin-streets', layout: { visibility: vis('streets') } },
      { id: 'skin-satellite', type: 'raster', source: 'skin-satellite', layout: { visibility: vis('satellite') } },
      // Under the points, not over them - a dashed line drawn across the dots
      // it connects reads worse than one sitting beneath them.
      {
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
      },
      {
        id: 'photos',
        type: 'circle',
        source: 'photos',
        paint: {
          // Small enough at world view that a city reads as a cluster of dots
          // rather than one blob, big enough close in to be worth aiming at.
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 0, 2.2, 4, 3, 8, 4.2, 14, 6],
          'circle-color': tint(),
          'circle-opacity': 0.9,
          // A dark rim separates overlapping dots; skipped when they are too
          // small for it to be anything but a smudge.
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 2, 0, 5, 0.8],
          'circle-stroke-color': 'rgba(0,0,0,.55)',
        },
      },
      {
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
      },
    ],
  };
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
  try {
    maplibre = await loadLib();
    create(box);
  } catch (err) {
    // Two real cases: the CDN is unreachable, or the machine has no WebGL2,
    // which MapLibre requires. Cleared here rather than left set, so a retry
    // (reopening the globe, or a network blip clearing up) gets another
    // attempt instead of the pane sitting on "Preparing the globe…" forever.
    booting = false;
    el('map-status').textContent = `The globe is unavailable here: ${err.message}`;
  }
}

function create(box) {
  map = new maplibre.Map({
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
  });

  map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-left');

  // style.load, not load: load also waits for the first frame to be painted,
  // and a browser gives a background tab no frames at all. Everything below
  // needs the style, not a picture of it.
  map.on('style.load', () => {
    ready = true;
    booting = false;
    // Only matters if the mode buttons were used while the renderer was still
    // being fetched; the style is built with both of these already applied.
    setSkin(skin);
    setDayColors(byDay);
    wire();
    // The pane is up but has no points yet: tell the map view to draw them.
    emit('globeReady');
  });

  // Without a listener MapLibre logs every miss itself, and a satellite tile
  // that does not exist over open ocean is normal rather than news.
  map.on('error', (e) => console.warn('globe:', e.error?.message || e.type));
}

function wire() {
  map.on('mousemove', 'photos', (e) => {
    // A drag is a spin, not a hover, and mousemove fires throughout one.
    if (!map.isMoving()) setHovered(pick(e.features[0]));
  });
  map.on('mouseleave', 'photos', () => setHovered(null));
  map.on('movestart', () => setHovered(null));
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

export function show(data) {
  container().classList.remove('hidden');
  el('globe-skin').classList.remove('hidden');
  if (!ready) { boot(); return false; }
  resize();
  update(data);
  return true;
}

export function hide() {
  container().classList.add('hidden');
  el('globe-skin').classList.add('hidden');
  setHovered(null);
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
  if (!ready) return;
  const source = map.getSource('path');
  const n = data ? data.n : 0;
  if (on && n > 1 && n <= MAX_PATH) {
    const coords = new Array(n);
    for (let i = 0; i < n; i += 1) coords[i] = [data.lon[i], data.lat[i]];
    map.setPaintProperty('path-line', 'line-color', color);
    source.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
  } else {
    source.setData(EMPTY);
    if (on && n > MAX_PATH) {
      toast(`Path hidden: ${fmtNum(n)} points exceeds the ${fmtNum(MAX_PATH)} limit`);
    }
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
  if (!ready) return;
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
