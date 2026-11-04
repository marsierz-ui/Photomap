// Replay: the camera flies from place to place in the order the photos were
// taken, the route grows behind it, and every photo is shown in turn.
//
// Runs on the 3D surface (Mapbox GL JS or MapLibre - the camera API is the same
// in both), which globe.js owns. It hands over the map and its drawing hooks,
// and this module owns only the camera, the timing and its own controls.
//
// Photos taken within half a kilometre of each other, one after another, are a
// stop: the camera flies between stops and stays put while a stop's photos go
// by. "Every photo" shows all of them, from the first to the last; "Places only"
// shows one per stop, for a quick look at where a long stretch went.
import { api, thumbUrl } from './api.js';
import { toast, escapeHtml } from './ui.js';
import { emit, on, setFilters, fmtNum, fmtDate, countryName } from './state.js';
import { musicFor, pick, play as playMusic, pause as pauseMusic, label as trackLabel } from './music.js';

const STOP_KM = 0.5;
const DWELL = 2200;
const SPEEDS = [0.5, 1, 2, 4, 8];
// Close enough for Mapbox Standard's 3D buildings, which start at about 15.
const STOP_ZOOM = 15.5;
const PITCH = 60;
const DAY = 86400;

let map = null;
let hooks = null;
let bar = null;
let card = null;
let source = null;
let stops = [];
let frames = []; // what is shown, in order: {s: stop index, id, ts, k: place in stop, n: photos in stop}
let at = 0;
let shownStop = -1;
let speed = 1;
let playing = false;
let runToken = 0;
let notes = new Map(); // YYYY-MM-DD -> journal text
let autoplayNext = false;

const remembered = (key, fallback) => {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
};
const remember = (key, value) => {
  try { localStorage.setItem(key, value); } catch { /* private window */ }
};
let mode = remembered('pm-replay-mode', 'all');
// Play the song from each photo's moment (or that day's favourite) as the
// replay reaches it. On unless turned off - with the Music button or by closing
// the player - and that choice is remembered in the browser.
let withMusic = remembered('pm-replay-music', '1') !== '0';

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

/** Consecutive photos within STOP_KM of where a stop began belong to that
 *  stop. The points arrive in capture order, so a stop is a visit, not a
 *  place: going back to the hotel each evening is a stop each evening. */
function buildStops(data) {
  const out = [];
  let cur = null;
  for (let i = 0; i < (data?.n || 0); i += 1) {
    const lat = data.lat[i];
    const lon = data.lon[i];
    if (cur && distKm(cur.lat, cur.lon, lat, lon) <= STOP_KM) {
      cur.ids.push(data.ids[i]);
      cur.ts.push(data.ts[i]);
      continue;
    }
    cur = { lat, lon, ids: [data.ids[i]], ts: [data.ts[i]] };
    out.push(cur);
  }
  return out;
}

function buildFrames() {
  frames = stops.flatMap((stop, s) => (mode === 'stops' ? [0] : stop.ids.map((_, k) => k))
    .map((k) => ({ s, id: stop.ids[k], ts: stop.ts[k], k, n: stop.ids.length })));
}

// ------------------------------------------------------------------- drawing

/** The route up to stop `upto`, plus `part` (0..1) of the leg towards the
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

/** A day's journal entry as plain lines: it is stored as HTML, parsed here in
 *  an inert document so nothing in it can run, and shown as text. */
function noteText(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  doc.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  doc.querySelectorAll('p, div, li').forEach((b) => b.append('\n'));
  doc.querySelectorAll('li').forEach((li) => li.prepend('• '));
  doc.querySelectorAll('ul, ol').forEach((list) => list.prepend('\n'));
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

const dayOf = (ts) => (ts == null ? '' : new Date(Math.floor(ts / DAY) * DAY * 1000).toISOString().slice(0, 10));

function showFrame(f) {
  if (!f) { card.classList.add('hidden'); hooks.caption?.(''); return; }
  const stop = stops[f.s];
  card.querySelector('img').src = thumbUrl(f.id, 512);
  card.querySelector('.count').textContent = f.n > 1 ? `${fmtNum(f.k + 1)} / ${fmtNum(f.n)}` : '';
  card.querySelector('.count').classList.toggle('hidden', f.n < 2);
  const note = notes.get(dayOf(f.ts));
  const box = card.querySelector('.note');
  box.classList.toggle('hidden', !note);
  if (note) {
    box.innerHTML = `<div class="note-day muted small">Journal, ${escapeHtml(fmtDate(f.ts))}</div>${escapeHtml(note)}`;
    box.scrollTop = 0;
  }
  card.classList.remove('hidden');
  hooks.highlight(f.id);
  // The light and the weather follow the photo; the strip at the top says
  // what they were, and the song is added to it.
  hooks.stop?.({ ids: [f.id], first: f.ts, lat: stop.lat, lon: stop.lon });
  hooks.caption?.('');
  musicFor(f.id).then((m) => {
    if (frames[at] !== f) return;
    const shown = m && (m.now || m.day[0]);
    hooks.caption?.(shown ? `♪ ${trackLabel(shown)}` : '');
    const t = pick(m);
    if (withMusic && t) playMusic(t);
  });
}

function syncBar() {
  if (!bar) return;
  bar.querySelector('[data-act=play]').textContent = playing ? '⏸' : '▶';
  const scrub = bar.querySelector('input');
  scrub.max = Math.max(0, frames.length - 1);
  scrub.value = at;
  const f = frames[at];
  bar.querySelector('.where').textContent = !frames.length ? 'No located photos to replay'
    : mode === 'stops' ? `Place ${fmtNum(at + 1)} of ${fmtNum(frames.length)}`
      : `Photo ${fmtNum(at + 1)} of ${fmtNum(frames.length)} · place ${fmtNum((f?.s ?? 0) + 1)} of ${fmtNum(stops.length)}`;
  bar.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === speed));
  bar.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  bar.querySelector('[data-act=music]').classList.toggle('active', withMusic);
}

// ------------------------------------------------------------------- playback

/** Fly to stop s from the one on screen, growing the route along the way.
 *  Resolves when the camera arrives, or at once if the replay was paused or
 *  restarted meanwhile. */
function flyTo(s, token) {
  const stop = stops[s];
  const prev = shownStop >= 0 ? stops[shownStop] : (s > 0 ? stops[s - 1] : null);
  const km = prev ? distKm(prev.lat, prev.lon, stop.lat, stop.lon) : 0;
  // Long legs get longer flights, but not so long that an ocean takes a minute.
  const duration = (prev ? Math.min(7000, 1800 + Math.sqrt(km) * 120) : 2500) / speed;
  return new Promise((resolve) => {
    const started = performance.now();
    const grow = () => {
      if (token !== runToken || s < 1) return;
      const part = Math.min(1, (performance.now() - started) / duration);
      drawRoute(s - 1, part);
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
  while (playing && at < frames.length) {
    const f = frames[at];
    if (f.s !== shownStop) {
      showFrame(null);
      await flyTo(f.s, token);
      if (token !== runToken) return;
      shownStop = f.s;
      drawRoute(f.s);
    }
    showFrame(f);
    syncBar();
    await sleep(DWELL / speed);
    if (token !== runToken) return;
    if (at < frames.length - 1) at += 1;
    else { playing = false; syncBar(); }
  }
}

function play() {
  if (!frames.length) return;
  if (at >= frames.length - 1 && !playing) { at = 0; shownStop = -1; drawRoute(-1); }
  playing = true;
  syncBar();
  run();
}

function pause() {
  playing = false;
  runToken += 1;
  map?.stop();
  syncBar();
}

/** Straight to frame i without flying: the scrubber and the arrow keys. */
function jump(i) {
  pause();
  at = Math.max(0, Math.min(i, frames.length - 1));
  const f = frames[at];
  if (!f) return;
  const stop = stops[f.s];
  if (f.s !== shownStop) map.jumpTo({ center: [stop.lon, stop.lat], zoom: STOP_ZOOM, pitch: PITCH });
  shownStop = f.s;
  drawRoute(f.s);
  showFrame(f);
  syncBar();
}

/** One photo along, keeping the replay playing if it was. */
function step(by) {
  const was = playing;
  jump(at + by);
  if (was) play();
}

function setSpeed(next) {
  speed = next;
  syncBar();
}

function setMode(next) {
  if (next === mode) return;
  const id = frames[at]?.id;
  mode = next;
  remember('pm-replay-mode', mode);
  buildFrames();
  // Stay on the same photo, or the first of its stop.
  const same = frames.findIndex((f) => f.id === id);
  const stopFirst = frames.findIndex((f) => f.s === (stops.findIndex((s) => s.ids.includes(id))));
  jump(same >= 0 ? same : Math.max(0, stopFirst));
}

// --------------------------------------------------------------- controls

// Closing the player is turning the music off, not skipping a song.
on('musicStopped', () => { withMusic = false; syncBar(); });

// Left and right step through the photos, space pauses and resumes, up and
// down change the speed. Not while typing, nor with a photo, a dialog or a
// panel open over the map.
document.addEventListener('keydown', (e) => {
  if (!map || e.target.matches?.('input, select, textarea') || e.target.isContentEditable) return;
  if (!document.getElementById('lightbox')?.classList.contains('hidden')) return;
  if (!document.getElementById('modal')?.classList.contains('hidden') || document.querySelector('.fullpanel')) return;
  const i = SPEEDS.indexOf(speed);
  if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === ' ') (playing ? pause() : play());
  else if (e.key === 'ArrowUp') setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, i + 1)]);
  else if (e.key === 'ArrowDown') setSpeed(SPEEDS[Math.max(0, i - 1)]);
  else return;
  e.preventDefault();
  e.stopPropagation();
}, true);

async function loadTrips(select) {
  let away = 50;
  try { away = Number(localStorage.getItem('pm-trip-away')) || 50; } catch { /* private window */ }
  try {
    const res = await api.get('/api/trips', new URLSearchParams({ away_km: away }));
    const name = (t) => t.title || (t.countries.some((c) => c.cc !== res.home?.cc)
      ? t.countries.slice(0, 3).map((c) => countryName(c.cc)).join(', ')
      : t.places.slice(0, 2).map((p) => p.name).join(' & ')) || 'Trip';
    select.innerHTML = '<option value="">All photos in the current filters</option>'
      + [...res.items].reverse().map((t) => {
        const from = Math.floor(t.start_ts / DAY) * DAY;
        const to = Math.floor(t.end_ts / DAY) * DAY + DAY - 1;
        return `<option value="${from}-${to}">${escapeHtml(fmtDate(t.start_ts))} · ${escapeHtml(name(t))}</option>`;
      }).join('');
  } catch { /* trips are optional here; the replay works without the list */ }
}

function build(box) {
  bar = document.createElement('div');
  bar.className = 'replay-bar';
  bar.title = '← → photo by photo · Space pause or play · ↑ ↓ faster or slower';
  bar.innerHTML = `
    <button class="btn tiny" data-act="restart" title="Back to the first photo">⏮</button>
    <button class="btn tiny" data-act="play" title="Play or pause (Space)">▶</button>
    <input type="range" min="0" max="0" value="0" title="Jump to a photo (← →)">
    <span class="where small muted"></span>
    <div class="seg" title="Speed (↑ ↓)">${SPEEDS.map((s) => `<button data-speed="${s}">${s === 0.5 ? '½' : s}x</button>`).join('')}</div>
    <div class="seg" title="Every photo, or one per place">
      <button data-mode="all">Every photo</button><button data-mode="stops">Places only</button>
    </div>
    <select class="replay-trip" title="Replay one trip, or everything in the current filters"></select>
    <button class="btn tiny" data-act="music" title="Play what you listened to on Spotify at each photo (import your listening history in Settings)">♪ Music</button>`;
  bar.querySelector('[data-act=play]').onclick = () => (playing ? pause() : play());
  bar.querySelector('[data-act=restart]').onclick = () => { shownStop = -1; jump(0); play(); };
  bar.querySelector('input').oninput = (e) => jump(Number(e.target.value));
  bar.querySelectorAll('[data-speed]').forEach((b) => { b.onclick = () => setSpeed(Number(b.dataset.speed)); });
  bar.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
  bar.querySelector('.replay-trip').onchange = (e) => {
    const [from, to] = e.target.value ? e.target.value.split('-').map(Number) : [null, null];
    // The globe reloads its points for the new dates and hands them back in
    // setData, which starts the replay of that trip from its first photo.
    autoplayNext = true;
    setFilters({ from, to });
  };
  bar.querySelector('[data-act=music]').onclick = async () => {
    withMusic = !withMusic;
    remember('pm-replay-music', withMusic ? '1' : '0');
    syncBar();
    if (!withMusic) { pauseMusic(); return; }
    const f = frames[at];
    const m = f ? await musicFor(f.id) : null;
    if (m === null) toast('No listening history yet: import it in Settings, under Music');
    const t = pick(m);
    if (t) playMusic(t);
  };

  card = document.createElement('div');
  card.className = 'replay-card hidden';
  card.innerHTML = `<div class="shot" title="Open this photo"><img alt=""><span class="count hidden"></span></div>
    <div class="note hidden"></div>`;
  card.querySelector('.shot').onclick = () => {
    const f = frames[at];
    if (f) emit('openPhoto', { id: f.id, ids: stops[f.s].ids });
  };
  box.append(bar, card);
}

// ------------------------------------------------------------------ exports

/** Start replaying on `glMap`, inside `box`. `drawHooks.route(coords)` draws the
 *  route line, `drawHooks.highlight(id)` marks the current photo,
 *  `drawHooks.stop(photo)` sets the light and weather for it, and
 *  `drawHooks.caption(text)` adds a line (the song) to the strip at the top. */
export function enter(glMap, box, data, drawHooks) {
  map = glMap;
  hooks = drawHooks;
  if (!bar || !box.contains(bar)) build(box);
  bar.classList.remove('hidden');
  // The arrow keys are the replay's while it runs, not the map's.
  map.keyboard?.disable();
  loadTrips(bar.querySelector('.replay-trip'));
  api.get('/api/days').then((rows) => {
    notes = new Map(rows.map((r) => [r.day, noteText(r.text)]).filter(([, text]) => text));
  }).catch(() => { notes = new Map(); });
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
  buildFrames();
  at = 0;
  shownStop = -1;
  drawRoute(-1);
  showFrame(null);
  syncBar();
  if (autoplay || autoplayNext) { autoplayNext = false; play(); }
}

export function exit() {
  if (!map) return;
  pause();
  pauseMusic();
  hooks.route([]);
  hooks.highlight(-1);
  hooks.caption?.('');
  map.keyboard?.enable();
  bar?.classList.add('hidden');
  card?.classList.add('hidden');
  map = null;
  hooks = null;
  source = null;
}

export const active = () => map !== null;
