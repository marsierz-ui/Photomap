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

const PAD = { l: 8, r: 8, t: 8, b: 16 };

export function initTimeline() {
  new ResizeObserver(draw).observe(canvas);
  // Pointer events so brushing works with a mouse, a finger or a pen alike.
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    onDown(e);
  });
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', () => { drag = null; draw(); });
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
  const from = state.filters.from ?? domain[0];
  const to = state.filters.to ?? domain[1];
  const hasRange = state.filters.from != null || state.filters.to != null;
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

  if (drag) {
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

function onDown(e) {
  if (!buckets.length) return;
  const rect = canvas.getBoundingClientRect();
  drag = { a: e.clientX - rect.left, b: e.clientX - rect.left, ts: tsAt(e.clientX) };
}

function onMove(e) {
  const rect = canvas.getBoundingClientRect();
  if (drag) {
    drag.b = e.clientX - rect.left;
  } else if (buckets.length) {
    const ts = tsAt(e.clientX);
    const step = bucketSeconds(bucketName);
    const bucket = buckets.find((b) => ts >= b[0] && ts < b[0] + step);
    hover = bucket ? { ts: bucket[0], count: bucket[1], x: e.clientX - rect.left } : null;
  }
  draw();
}

function onUp(e) {
  if (!drag) return;
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
