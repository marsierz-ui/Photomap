// Trip replay: the camera flies from place to place in the order the photos
// were taken, the route grows behind it, and each stop shows its photos.
//
// Runs on the 3D surface (Mapbox GL JS or MapLibre - the camera API is the same
// in both), which globe.js owns. It hands over the map and two drawing hooks,
// and this module owns only the camera, the timing and its own controls.
import { thumbUrl } from './api.js';
import { emit, fmtNum, fmtDateTime } from './state.js';

// Past this many stops a replay is a slideshow nobody sits through, so nearby
// stops are merged until it fits.
const MAX_STOPS = 300;
const DWELL = 2200;
// Close enough for Mapbox Standard's 3D buildings, which start at about 15.
const STOP_ZOOM = 15.5;
const PITCH = 60;

let map = null;
let hooks = null;
let bar = null;
let card = null;
let source = null;
let stops = [];
let at = 0;
let speed = 1;
let playing = false;
let runToken = 0;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function distKm(aLat, aLon, bLat, bLon) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

/** Facing the way the trip goes, so the camera looks ahead rather than back. */
function bearing(from, to) {
  const rad = Math.PI / 180;
  const y = Math.sin((to.lon - from.lon) * rad) * Math.cos(to.lat * rad);
  const x = Math.cos(from.lat * rad) * Math.sin(to.lat * rad)
    - Math.sin(from.lat * rad) * Math.cos(to.lat * rad) * Math.cos((to.lon - from.lon) * rad);
  return Math.atan2(y, x) / rad;
}

/** Consecutive photos within `km` of where a stop began belong to that stop.
 *  The points arrive in capture order, so a stop is a visit, not a place: going
 *  back to the hotel each evening is a stop each evening. */
function group(data, km) {
  const out = [];
  let cur = null;
  for (let i = 0; i < data.n; i += 1) {
    const lat = data.lat[i];
    const lon = data.lon[i];
    if (cur && distKm(cur.lat, cur.lon, lat, lon) <= km) {
      cur.ids.push(data.ids[i]);
      if (data.ts[i] != null) cur.last = data.ts[i];
      continue;
    }
    cur = { lat, lon, ids: [data.ids[i]], first: data.ts[i], last: data.ts[i] };
    out.push(cur);
  }
  return out;
}

function buildStops(data) {
  if (!data || !data.n) return [];
  let km = 0.5;
  let out = group(data, km);
  while (out.length > MAX_STOPS) {
    km *= 2;
    out = group(data, km);
  }
  return out;
}

// ------------------------------------------------------------------- drawing

/** The route up to the current stop, plus `part` (0..1) of the leg towards the
 *  next one, so the line is drawn by the flight rather than appearing whole. */
function drawRoute(upto, part = 0) {
  const coords = stops.slice(0, upto + 1).map((s) => [s.lon, s.lat]);
  const next = stops[upto + 1];
  if (next && part > 0) {
    const from = stops[upto];
    coords.push([from.lon + (next.lon - from.lon) * part, from.lat + (next.lat - from.lat) * part]);
  }
  hooks.route(coords);
}

function showCard(stop) {
  if (!stop) { card.classList.add('hidden'); return; }
  const img = card.querySelector('img');
  img.src = thumbUrl(stop.ids[0], 256);
  const when = stop.first == null ? 'No date'
    : stop.last !== stop.first && fmtDateTime(stop.last).slice(0, 10) !== fmtDateTime(stop.first).slice(0, 10)
      ? `${fmtDateTime(stop.first)} - ${fmtDateTime(stop.last)}`
      : fmtDateTime(stop.first);
  card.querySelector('.when').textContent = when;
  card.querySelector('.count').textContent =
    stop.ids.length > 1 ? `${fmtNum(stop.ids.length)} photos` : '1 photo';
  const wx = card.querySelector('.wx');
  wx.textContent = '';
  card.classList.remove('hidden');
  hooks.highlight(stop.ids[0]);
  // The light and the weather follow the stop; the card says what it was.
  hooks.stop?.(stop).then((text) => { if (stops[at] === stop) wx.textContent = text || ''; });
}

function syncBar() {
  if (!bar) return;
  bar.querySelector('[data-act=play]').textContent = playing ? '⏸' : '▶';
  const scrub = bar.querySelector('input');
  scrub.max = Math.max(0, stops.length - 1);
  scrub.value = at;
  bar.querySelector('.where').textContent = stops.length
    ? `Stop ${fmtNum(Math.min(at + 1, stops.length))} of ${fmtNum(stops.length)}`
    : 'No located photos to replay';
  bar.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === speed));
}

// ------------------------------------------------------------------- playback

/** Fly to stop i, growing the route along the way. Resolves when the camera
 *  arrives, or straight away if the replay was paused or restarted meanwhile. */
function flyTo(i, token) {
  const stop = stops[i];
  const prev = i > 0 ? stops[i - 1] : null;
  const km = prev ? distKm(prev.lat, prev.lon, stop.lat, stop.lon) : 0;
  // Long legs get longer flights, but not so long that an ocean takes a minute.
  const duration = (prev ? Math.min(7000, 1800 + Math.sqrt(km) * 120) : 2500) / speed;
  return new Promise((resolve) => {
    const started = performance.now();
    const grow = () => {
      if (token !== runToken || !prev) return;
      const part = Math.min(1, (performance.now() - started) / duration);
      drawRoute(i - 1, part);
      if (part < 1) requestAnimationFrame(grow);
    };
    map.once('moveend', () => resolve());
    map.flyTo({
      center: [stop.lon, stop.lat],
      zoom: STOP_ZOOM,
      pitch: PITCH,
      bearing: prev && km > 0.05 ? bearing(prev, stop) : map.getBearing(),
      duration,
      essential: true,
    });
    requestAnimationFrame(grow);
  });
}

async function run() {
  const token = ++runToken;
  while (playing && at < stops.length) {
    showCard(null);
    await flyTo(at, token);
    if (token !== runToken) return;
    drawRoute(at);
    showCard(stops[at]);
    syncBar();
    await sleep(DWELL / speed);
    if (token !== runToken) return;
    if (at < stops.length - 1) at += 1;
    else { playing = false; syncBar(); }
  }
}

function play() {
  if (!stops.length) return;
  if (at >= stops.length - 1 && !playing) { at = 0; drawRoute(-1); }
  playing = true;
  syncBar();
  run();
}

function pause() {
  playing = false;
  runToken += 1;
  map.stop();
  syncBar();
}

/** Straight to stop i without flying, for the scrubber. */
function jump(i) {
  pause();
  at = Math.max(0, Math.min(i, stops.length - 1));
  const stop = stops[at];
  if (!stop) return;
  map.jumpTo({ center: [stop.lon, stop.lat], zoom: STOP_ZOOM, pitch: PITCH });
  drawRoute(at);
  showCard(stop);
  syncBar();
}

// --------------------------------------------------------------- controls

function build(box) {
  bar = document.createElement('div');
  bar.className = 'replay-bar';
  bar.innerHTML = `
    <button class="btn tiny" data-act="restart" title="Back to the first stop">⏮</button>
    <button class="btn tiny" data-act="play" title="Play or pause">▶</button>
    <input type="range" min="0" max="0" value="0" title="Jump to a stop">
    <span class="where small muted"></span>
    <div class="seg">
      <button data-speed="1">1x</button><button data-speed="2">2x</button><button data-speed="4">4x</button>
    </div>`;
  bar.querySelector('[data-act=play]').onclick = () => (playing ? pause() : play());
  bar.querySelector('[data-act=restart]').onclick = () => { jump(0); play(); };
  bar.querySelector('input').oninput = (e) => jump(Number(e.target.value));
  bar.querySelectorAll('[data-speed]').forEach((b) => {
    b.onclick = () => { speed = Number(b.dataset.speed); syncBar(); };
  });

  card = document.createElement('div');
  card.className = 'replay-card hidden';
  card.title = 'Open these photos';
  card.innerHTML = '<img alt=""><div><div class="when"></div><div class="count small muted"></div><div class="wx small"></div></div>';
  card.onclick = () => {
    const stop = stops[at];
    if (stop) emit('openPhoto', { id: stop.ids[0], ids: stop.ids });
  };
  box.append(bar, card);
}

// ------------------------------------------------------------------ exports

/** Start replaying on `glMap`, inside `box`. `drawHooks.route(coords)` draws the
 *  route line, `drawHooks.highlight(id)` marks the current photo, and
 *  `drawHooks.stop(stop)`, if given, is told each stop as it is reached and
 *  resolves to a line of text for its card (the weather). */
export function enter(glMap, box, data, drawHooks) {
  map = glMap;
  hooks = drawHooks;
  if (!bar || !box.contains(bar)) build(box);
  bar.classList.remove('hidden');
  source = null;
  setData(data, true);
}

/** New points, from a filter change or the map coming back. Only a different
 *  set starts over; the same set keeps its place. */
export function setData(data, autoplay = false) {
  if (!map) return;
  if (data === source && !autoplay) return;
  source = data;
  pause();
  stops = buildStops(data);
  at = 0;
  drawRoute(-1);
  showCard(null);
  syncBar();
  if (autoplay) play();
}

export function exit() {
  if (!map) return;
  pause();
  hooks.route([]);
  hooks.highlight(-1);
  bar?.classList.add('hidden');
  card?.classList.add('hidden');
  map = null;
  hooks = null;
  source = null;
}

export const active = () => map !== null;
