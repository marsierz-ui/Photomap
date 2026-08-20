import { api } from './api.js';
import { state, params, emit, on, setFilters, fmtDate, fmtNum } from './state.js';
import { el } from './ui.js';

const canvas = el('timeline');
const ctx = canvas.getContext('2d');

let buckets = [];
let bucketName = 'day';
let domain = [0, 1];
let lastKey = null;
let hover = null;
let drag = null;
let playTimer = null;
// The range as the hand is holding it, before it has been applied. Drawing from
// this rather than from the filters is what lets the shading follow a drag at
// screen speed while the map behind it refilters at its own, slower, pace.
let preview = null;
let liveAt = 0;

const PAD = { l: 8, r: 8, t: 8, b: 16 };
// How near an edge counts as taking hold of it rather than starting a new range.
const EDGE_PX = 7;
// A drag refilters at most this often. The map answers from SQLite and drops
// stale replies by token, so the cost of going faster is wasted queries rather
// than a wrong picture - but it is still waste. Play moves every 450ms; this is
// three times livelier, which is about where a drag stops feeling detached.
const LIVE_MS = 150;

export function initTimeline() {
  new ResizeObserver(draw).observe(canvas);
  // Pointer events so brushing works with a mouse, a finger or a pen alike.
  canvas.addEventListener('pointerdown', (e) => {
    // Capture first, but never at the cost of the drag itself: this throws if
    // the pointer is already gone by the time it is called, and it used to take
    // onDown down with it - leaving a press that did nothing at all.
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* no capture; the drag still works, it just ends if the pointer leaves */
    }
    onDown(e);
  });
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', () => { drag = null; preview = null; draw(); });
  canvas.addEventListener('pointerleave', () => { hover = null; draw(); });
  canvas.addEventListener('dblclick', clearRange);

  el('tl-clear').addEventListener('click', clearRange);
  el('tl-bucket').addEventListener('change', () => { lastKey = null; refresh(); });
  el('tl-play').addEventListener('click', togglePlay);

  on('filters', refresh);
  refresh();
}

async function refresh() {
  const key = params({ dates: false }).toString() + el('tl-bucket').value;
  if (key === lastKey) { draw(); return; }
  lastKey = key;
  const p = params({ dates: false, extra: { bucket: el('tl-bucket').value } });
  const res = await api.get('/api/timeline', p);
  buckets = res.items;
  bucketName = res.bucket;
  if (buckets.length) {
    const step = bucketSeconds(bucketName);
    domain = [buckets[0][0], buckets[buckets.length - 1][0] + step];
  } else {
    domain = [0, 1];
  }
  draw();
}

function bucketSeconds(name) {
  return { hour: 3600, day: 86400, month: 2629800, year: 31557600 }[name] || 86400;
}

// ---------------------------------------------------------------------- draw

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (!cssW || !cssH) return;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const w = cssW - PAD.l - PAD.r;
  const h = cssH - PAD.t - PAD.b;
  if (!buckets.length) {
    ctx.fillStyle = '#8b97a6';
    ctx.font = '12px system-ui';
    ctx.fillText('No dated photos for these filters', PAD.l, PAD.t + 18);
    el('tl-label').textContent = 'Timeline';
    return;
  }

  const span = domain[1] - domain[0];
  const x = (ts) => PAD.l + ((ts - domain[0]) / span) * w;
  let maxCount = 1;
  for (const b of buckets) if (b[1] > maxCount) maxCount = b[1];
  const barW = Math.max(1, (w * bucketSeconds(bucketName)) / span - 0.5);

  // selected range shading
  const from = preview ? preview.from : (state.filters.from ?? domain[0]);
  const to = preview ? preview.to : (state.filters.to ?? domain[1]);
  const hasRange = preview != null || state.filters.from != null || state.filters.to != null;
  if (hasRange) {
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.fillRect(PAD.l, PAD.t, Math.max(0, x(from) - PAD.l), h);
    ctx.fillRect(x(to), PAD.t, Math.max(0, PAD.l + w - x(to)), h);
  }

  buckets.forEach(([ts, count, geo]) => {
    const bx = x(ts);
    const inRange = !hasRange || (ts >= from && ts <= to);
    const bh = (count / maxCount) * h;
    ctx.fillStyle = inRange ? '#2f5d8a' : '#243040';
    ctx.fillRect(bx, PAD.t + h - bh, barW, bh);
    if (geo) {
      const gh = (geo / maxCount) * h;
      ctx.fillStyle = inRange ? '#4aa3ff' : '#31465e';
      ctx.fillRect(bx, PAD.t + h - gh, barW, gh);
    }
  });

  // axis
  ctx.strokeStyle = '#2a323d';
  ctx.beginPath();
  ctx.moveTo(PAD.l, PAD.t + h + 0.5);
  ctx.lineTo(PAD.l + w, PAD.t + h + 0.5);
  ctx.stroke();

  ctx.fillStyle = '#8b97a6';
  ctx.font = '10px system-ui';
  const ticks = Math.max(2, Math.min(10, Math.floor(w / 110)));
  for (let i = 0; i <= ticks; i += 1) {
    const ts = domain[0] + (span * i) / ticks;
    const label = fmtDate(ts);
    const tx = Math.min(PAD.l + w - 60, Math.max(PAD.l, x(ts) - 24));
    ctx.fillText(label, tx, PAD.t + h + 12);
  }

  // The edges of a range are drawn as grips. Nothing else says that the window
  // can be taken hold of and moved, and a control that only responds to a
  // gesture nobody knows is there may as well not respond.
  if (hasRange) {
    const grip = (gx) => {
      ctx.fillStyle = '#4aa3ff';
      ctx.fillRect(gx - 1.5, PAD.t, 3, h);
      ctx.fillRect(gx - 4.5, PAD.t + h / 2 - 9, 9, 18);
      ctx.fillStyle = '#06121f';
      ctx.fillRect(gx - 1.5, PAD.t + h / 2 - 5, 1, 10);
      ctx.fillRect(gx + 0.5, PAD.t + h / 2 - 5, 1, 10);
    };
    grip(Math.max(PAD.l + 1, x(from)));
    grip(Math.min(PAD.l + w - 1, x(to)));
  }

  if (drag && drag.mode === 'new') {
    ctx.fillStyle = 'rgba(74,163,255,.2)';
    ctx.strokeStyle = '#4aa3ff';
    const [a, b] = drag.a < drag.b ? [drag.a, drag.b] : [drag.b, drag.a];
    ctx.fillRect(a, PAD.t, b - a, h);
    ctx.strokeRect(a + 0.5, PAD.t + 0.5, b - a, h);
  }

  if (hover) {
    ctx.fillStyle = '#e6edf3';
    ctx.font = '11px system-ui';
    const text = `${fmtDate(hover.ts)} · ${fmtNum(hover.count)} photos`;
    const tw = ctx.measureText(text).width;
    const tx = Math.min(cssW - tw - 8, Math.max(4, hover.x - tw / 2));
    ctx.fillStyle = 'rgba(22,27,34,.94)';
    ctx.fillRect(tx - 5, PAD.t + 2, tw + 10, 17);
    ctx.fillStyle = '#e6edf3';
    ctx.fillText(text, tx, PAD.t + 14);
  }

  const total = buckets.reduce((sum, b) => sum + b[1], 0);
  el('tl-label').textContent = hasRange
    ? `${fmtDate(from)} - ${fmtDate(to)} selected · ${fmtNum(total)} in histogram (${bucketName})`
    : `${fmtNum(total)} photos · ${bucketName} buckets`;
}

// --------------------------------------------------------------- interaction

function tsAt(clientX) {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width - PAD.l - PAD.r;
  const frac = (clientX - rect.left - PAD.l) / w;
  return domain[0] + Math.min(1, Math.max(0, frac)) * (domain[1] - domain[0]);
}

/** Where a moment sits across the canvas, in the canvas's own pixels. The
 *  inverse of tsAt, and the thing that lets a pointer be tested against the
 *  edges of the current range. */
function xAt(ts) {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width - PAD.l - PAD.r;
  return PAD.l + ((ts - domain[0]) / (domain[1] - domain[0])) * w;
}

/** Which part of an existing range a pointer is on: an edge, the middle, or
 *  nothing, in which case the drag starts a new range as it always did. */
function grabAt(px) {
  if (state.filters.from == null && state.filters.to == null) return null;
  const from = state.filters.from ?? domain[0];
  const to = state.filters.to ?? domain[1];
  const fx = xAt(from);
  const tx = xAt(to);
  let mode = null;
  if (Math.abs(px - fx) <= EDGE_PX) mode = 'from';
  else if (Math.abs(px - tx) <= EDGE_PX) mode = 'to';
  else if (px > fx && px < tx) mode = 'move';
  return mode ? { mode, from, to } : null;
}

/** Push the range being dragged out to everything else, but not on every pixel.
 *  The map re-queries on each one of these. */
function live() {
  const now = Date.now();
  if (!preview || now - liveAt < LIVE_MS) return;
  liveAt = now;
  setFilters({ from: Math.floor(preview.from), to: Math.ceil(preview.to) });
}

function onDown(e) {
  if (!buckets.length) return;
  // A hand on the timeline takes it off the timer, wherever it landed. Playing
  // and dragging at once is two things fighting over one range, and the timer
  // wins every tick - so a range picked during playback was overwritten before
  // it could be looked at.
  stopPlay();
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;

  const hold = grabAt(px);
  if (hold) {
    drag = { ...hold, grabTs: tsAt(e.clientX) };
    preview = { from: hold.from, to: hold.to };
    hover = null;
    draw();
    return;
  }
  drag = { mode: 'new', a: px, b: px, ts: tsAt(e.clientX) };
}

function onMove(e) {
  const rect = canvas.getBoundingClientRect();
  if (drag && drag.mode === 'new') {
    drag.b = e.clientX - rect.left;
    hover = null;
  } else if (drag) {
    const ts = tsAt(e.clientX);
    if (drag.mode === 'move') {
      // The window keeps its width and stops at the ends rather than shrinking
      // against them - it is the same span of time moved somewhere else.
      const width = drag.to - drag.from;
      const from = Math.max(domain[0], Math.min(domain[1] - width, drag.from + (ts - drag.grabTs)));
      preview = { from, to: from + width };
    } else if (drag.mode === 'from') {
      preview = { from: Math.min(ts, drag.to), to: drag.to };
    } else {
      preview = { from: drag.from, to: Math.max(ts, drag.from) };
    }
    hover = null;
    live();
  } else if (buckets.length) {
    const px = e.clientX - rect.left;
    const ts = tsAt(e.clientX);
    const step = bucketSeconds(bucketName);
    const bucket = buckets.find((b) => ts >= b[0] && ts < b[0] + step);
    hover = bucket ? { ts: bucket[0], count: bucket[1], x: px } : null;
    // Say what this pointer would do before it is pressed.
    const hold = grabAt(px);
    canvas.style.cursor = !hold ? 'crosshair'
      : (hold.mode === 'move' ? 'grab' : 'ew-resize');
  }
  draw();
}

function onUp(e) {
  if (!drag) return;
  const mode = drag.mode;

  if (mode === 'new') {
    const moved = Math.abs(drag.b - drag.a) > 4;
    const endTs = tsAt(e.clientX);
    const [from, to] = drag.ts < endTs ? [drag.ts, endTs] : [endTs, drag.ts];
    drag = null;
    if (moved) {
      setFilters({ from: Math.floor(from), to: Math.ceil(to) });
    } else {
      const step = bucketSeconds(bucketName);
      const bucket = buckets.find((b) => from >= b[0] && from < b[0] + step);
      if (bucket) setFilters({ from: bucket[0], to: bucket[0] + step - 1 });
    }
  } else {
    // The throttle means the last thing applied is usually a little behind
    // where the hand stopped, so the exact range is set once here.
    const { from, to } = preview;
    drag = null;
    preview = null;
    setFilters({ from: Math.floor(from), to: Math.ceil(to) });
  }

  preview = null;
  emit('rangeChanged');
  draw();
}

function clearRange() {
  stopPlay();
  setFilters({ from: null, to: null });
  emit('rangeChanged');
}

// ---------------------------------------------------------------------- play

function togglePlay() {
  if (playTimer) { stopPlay(); return; }
  if (!buckets.length) return;
  const windowSec = Number(el('tl-window').value) * 86400;
  const step = windowSec / 6;
  let cursor = state.filters.from ?? domain[0];
  el('tl-play').textContent = '⏸';
  playTimer = setInterval(() => {
    if (cursor > domain[1]) { cursor = domain[0]; }
    setFilters({ from: Math.floor(cursor), to: Math.floor(cursor + windowSec) });
    cursor += step;
  }, 450);
}

function stopPlay() {
  clearInterval(playTimer);
  playTimer = null;
  el('tl-play').textContent = '▶';
}
