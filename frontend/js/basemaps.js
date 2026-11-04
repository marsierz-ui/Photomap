// Which provider draws the basemaps, for both the flat map and the globe.
//
// The free set (CARTO, OpenStreetMap, Esri) is the default and the fallback.
// Mapbox, when chosen, is used only while it is inside its free tier: a card on
// the Mapbox account means it bills past the tier instead of stopping, so the
// count is kept here, and a Mapbox account with no card refuses tiles once the
// tier is spent, which is caught too.
import { api } from './api.js';
import { state, emit } from './state.js';
import { toast } from './ui.js';

// Monthly free tiers from mapbox.com/pricing. Style tiles (dark, streets) are
// billed as Static Tiles API requests, satellite as Raster Tiles API requests,
// and each has its own allowance.
export const MAPBOX_FREE = { styles: 200000, raster: 750000 };

const MAPBOX_STYLES = { dark: 'mapbox/dark-v11', streets: 'mapbox/streets-v12' };
const MAPBOX_ATTR = '&copy; <a href="https://www.mapbox.com/about/maps/" target="_blank">Mapbox</a> '
  + '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> '
  + '<a href="https://www.mapbox.com/map-feedback/" target="_blank">Improve this map</a>';

const settings = () => state.config?.settings || {};
const thisMonth = () => new Date().toISOString().slice(0, 7);

let usage = null;
let refusedBy = null;
const pending = { styles: 0, raster: 0 };
let flushTimer = null;

export function usageNow() {
  if (!usage) {
    try { usage = JSON.parse(settings().mapbox_usage || 'null'); } catch { usage = null; }
  }
  if (!usage || usage.month !== thisMonth()) usage = { month: thisMonth(), styles: 0, raster: 0 };
  return { ...usage, refused: refusedBy };
}

const spent = (kind) => usageNow()[kind] >= MAPBOX_FREE[kind];

function useMapbox(kind) {
  const s = settings();
  return s.map_provider === 'mapbox' && !!s.mapbox_token && !refusedBy && !spent(kind);
}

/** Tiles for one base ('dark', 'streets' or 'satellite'). `retina` is the
 *  suffix in the URL: Leaflet's '{r}' placeholder, or the literal for MapLibre.
 *  maxzoom is in the tile's own zoom levels; `kind` is set for Mapbox tiles,
 *  which are the only ones counted. */
export function tileSpec(base, retina) {
  const kind = base === 'satellite' ? 'raster' : 'styles';
  if (useMapbox(kind)) {
    const token = encodeURIComponent(settings().mapbox_token);
    // 512px tiles cover what four 256px tiles do, so a quarter of the requests.
    return base === 'satellite'
      ? { url: `https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=${token}`,
        tileSize: 512, maxzoom: 19, attribution: MAPBOX_ATTR, kind }
      : { url: `https://api.mapbox.com/styles/v1/${MAPBOX_STYLES[base]}/tiles/512/{z}/{x}/{y}${retina}?access_token=${token}`,
        tileSize: 512, maxzoom: 21, attribution: MAPBOX_ATTR, kind };
  }
  if (base === 'dark') {
    // CARTO serves an "API key required" watermark in place of every tile without one.
    return { url: `https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}${retina}.png?key=${encodeURIComponent(settings().carto_key || '')}`,
      tileSize: 256, maxzoom: 20, attribution: '&copy; OpenStreetMap contributors, &copy; CARTO', kind: null };
  }
  if (base === 'streets') {
    // Raw OSM tiles have no @2x set.
    return { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      tileSize: 256, maxzoom: 19, attribution: '&copy; OpenStreetMap contributors', kind: null };
  }
  return { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    tileSize: 256, maxzoom: 19, attribution: 'Imagery &copy; Esri', kind: null };
}

/** Which kind of Mapbox tile a URL is, or null for anything else. */
export function mapboxKind(url) {
  if (!url || !url.startsWith('https://api.mapbox.com/')) return null;
  return url.includes('/v4/mapbox.satellite/') ? 'raster' : 'styles';
}

/** One Mapbox tile requested. Switches to the free set the moment the count
 *  reaches the tier, and reports the count to the server in batches. */
export function count(kind) {
  const before = spent(kind);
  pending[kind] += 1;
  usage[kind] += 1;
  if (!flushTimer) flushTimer = setTimeout(flush, 15000);
  if (!before && spent(kind)) {
    flush();
    toast(`Mapbox free tier used up for this month - switched to the free maps`);
    emit('basemaps');
  }
}

async function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  const body = { ...pending };
  if (!body.styles && !body.raster) return;
  pending.styles = 0;
  pending.raster = 0;
  try {
    const total = await api.post('/api/mapbox/usage', body);
    // Other tabs and devices count too; the server's total is the real one.
    const was = { styles: spent('styles'), raster: spent('raster') };
    usage = { month: total.month, styles: total.styles + pending.styles, raster: total.raster + pending.raster };
    if (state.config) state.config.settings.mapbox_usage = JSON.stringify(total);
    if (was.styles !== spent('styles') || was.raster !== spent('raster')) emit('basemaps');
  } catch {
    // Not lost: put back and sent with the next batch.
    pending.styles += body.styles;
    pending.raster += body.raster;
  }
}

window.addEventListener('pagehide', flush);

let probing = false;

/** A Mapbox tile failed to load. An image cannot say why, so one request is
 *  repeated to read the status: 401/403 is a bad token or an account that
 *  stopped at its free tier, 429 is the rate limit. Any of them means the free
 *  set for the rest of this session. Anything else (a missing tile, a blip) is
 *  left alone. */
export async function tileFailed(url) {
  if (refusedBy || probing || !mapboxKind(url)) return;
  probing = true;
  try {
    const res = await fetch(url);
    if ([401, 403, 429].includes(res.status)) refused(res.status);
  } catch {
    /* offline: nothing to learn */
  } finally {
    probing = false;
  }
}

/** Mapbox said no; MapLibre hands over the status directly. */
export function refused(status) {
  if (refusedBy) return;
  refusedBy = status;
  toast(status === 429
    ? 'Mapbox is rate limiting - switched to the free maps'
    : 'Mapbox refused the token or the account is over its limit - switched to the free maps', true);
  emit('basemaps');
}

/** After the provider or token changed in settings: a fresh token deserves a
 *  fresh try. */
export function settingsChanged() {
  refusedBy = null;
  emit('basemaps');
}
