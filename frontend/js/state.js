// Shared app state, event bus, query building and formatting.
// Capture times are stored as wall-clock seconds normalized through UTC, so
// every date read/write here uses UTC accessors on purpose.

export const state = {
  filters: { from: null, to: null, gps: 'any', album: null, camera: '', q: '', fav: false, near: null, country: '' },
  bounds: null,
  followMap: false,
  sort: 'date_desc',
  selection: new Set(),
  // Photo ids the gallery is limited to, when it was opened from a selection.
  // A snapshot, so changing the selection afterwards does not reshuffle it.
  only: null,
  view: 'map',
  config: null,
  albums: [],
  places: [],
};

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
}

export function emit(event, payload) {
  (listeners.get(event) || []).forEach((fn) => fn(payload));
}

export function setFilters(patch, silent = false) {
  Object.assign(state.filters, patch);
  if (!silent) emit('filters');
}

export function params(opts = {}) {
  const { bbox = true, dates = true } = opts;
  const f = state.filters;
  const p = new URLSearchParams();
  if (dates && f.from != null) p.set('from', f.from);
  if (dates && f.to != null) p.set('to', f.to);
  if (f.gps && f.gps !== 'any') p.set('gps', f.gps);
  if (f.album) p.set('album', f.album);
  if (f.camera) p.set('camera', f.camera);
  if (f.q) {
    p.set('q', f.q);
    const codes = countriesMatching(f.q);
    if (codes.length) p.set('cc', codes.join(','));
  }
  if (f.near) p.set('near', f.near);
  if (f.country) p.set('country', f.country);
  if (f.fav) p.set('fav', '1');
  if (bbox && state.followMap && state.bounds) p.set('bbox', state.bounds);
  Object.entries(opts.extra || {}).forEach(([k, v]) => p.set(k, v));
  return p;
}

export function boundsToBbox(b) {
  return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((n) => n.toFixed(6)).join(',');
}

// ------------------------------------------------------------------ formatting

const D_FMT = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const DT_FMT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
});

/** One colour per capture day, stable across the map and the globe.
 *  The golden-angle step puts consecutive days on opposite sides of the wheel,
 *  so a week of photos reads as a week rather than a gradient. */
export const DAY_SATURATION = 0.72;
export const DAY_LIGHTNESS = 0.62;

export function dayHue(ts) {
  if (ts == null) return null;
  const hue = (Math.floor(ts / 86400) * 137.508) % 360;
  return ((hue % 360) + 360) % 360;
}

/** The legacy comma form: leaflet hands it to the browser and the globe hands it
 *  to MapLibre's own colour parser, and only this form is safe in both. */
export function dayColor(ts) {
  const hue = dayHue(ts);
  if (hue == null) return '#4aa3ff';
  return `hsl(${hue}, ${DAY_SATURATION * 100}%, ${DAY_LIGHTNESS * 100}%)`;
}

export const fmtDate = (ts) => (ts == null ? '—' : D_FMT.format(new Date(ts * 1000)));
export const fmtDateTime = (ts) => (ts == null ? '—' : DT_FMT.format(new Date(ts * 1000)));
export const fmtNum = (n) => (n == null ? '0' : Number(n).toLocaleString());

export function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function isoToTs(value, endOfDay = false) {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 1000) + (endOfDay ? 86399 : 0);
}

export function tsToIso(ts) {
  if (ts == null) return '';
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ countries

const REGION_NAMES = (() => {
  try { return new Intl.DisplayNames(undefined, { type: 'region' }); } catch { return null; }
})();

/** A country's name in the browser's language. */
export const countryName = (cc) => {
  try { return (REGION_NAMES && REGION_NAMES.of(cc)) || cc; } catch { return cc; }
};

/** A flag from a two-letter code: two regional indicator symbols. */
export const flag = (cc) => (/^[A-Z]{2}$/.test(cc || '')
  ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');

let ALL_CODES = null;
function allCodes() {
  if (ALL_CODES) return ALL_CODES;
  ALL_CODES = [];
  for (let a = 65; a <= 90; a += 1) {
    for (let b = 65; b <= 90; b += 1) {
      const cc = String.fromCharCode(a, b);
      const name = countryName(cc);
      // DisplayNames hands unknown codes back unchanged.
      if (name && name !== cc) ALL_CODES.push([cc, fold(name)]);
    }
  }
  return ALL_CODES;
}

const fold = (text) => String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Country codes whose name, in the browser's language, starts with the query:
 *  "irel" finds IE, so the search box finds photos by country name although the
 *  index only stores the code. Needs three letters, so "a" is not 40 countries. */
export function countriesMatching(query) {
  const q = fold(query.trim());
  if (q.length < 3) return [];
  return allCodes().filter(([, name]) => name.startsWith(q) || name.includes(` ${q}`)).map(([cc]) => cc).slice(0, 12);
}
