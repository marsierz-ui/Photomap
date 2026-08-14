import { api, thumbUrl } from './api.js';
import { state, params, emit, on, fmtDate, fmtNum } from './state.js';
import { el, toast } from './ui.js';

const PAGE = 120;
// Served thumbnail sizes. Pick the first that covers the displayed box at the
// screen's pixel density, so tiles are never upscaled.
const LADDER = [256, 512, 768, 1024];

function thumbSizeFor(tilePx) {
  const needed = tilePx * (window.devicePixelRatio || 1);
  return LADDER.find((s) => s >= needed) || LADDER[LADDER.length - 1];
}

let items = [];
let total = 0;
let loading = false;
let exhausted = false;
let anchor = null;
let token = 0;
let dirty = true;

const grid = el('grid');

/** Keep grid rows as tall as the columns are wide, so tiles stay square. */
function syncRowHeight() {
  const column = getComputedStyle(grid).gridTemplateColumns.split(' ')[0];
  if (column && column.endsWith('px')) grid.style.setProperty('--row', column);
}

export function initGallery() {
  grid.addEventListener('load', (e) => e.target.classList.add('loaded'), true);
  new ResizeObserver(syncRowHeight).observe(grid);
  syncRowHeight();
  grid.addEventListener('scroll', () => {
    if (grid.scrollTop + grid.clientHeight > grid.scrollHeight - 600) loadPage();
  });
  grid.addEventListener('click', onClick);

  let sizeTimer = null;
  el('grid-size').addEventListener('input', (e) => {
    const tile = Number(e.target.value);
    grid.style.setProperty('--tile', `${tile}px`);
    syncRowHeight();
    // Re-point existing tiles at a large enough thumbnail; debounced so dragging
    // the slider does not fire a request per pixel.
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => {
      const size = thumbSizeFor(tile);
      grid.querySelectorAll('.tile img').forEach((img) => {
        const wanted = thumbUrl(Number(img.closest('.tile').dataset.id), size);
        if (img.getAttribute('src') !== wanted) {
          img.classList.remove('loaded');
          img.setAttribute('src', wanted);
        }
      });
    }, 250);
  });

  el('grid-fit').addEventListener('click', (e) => {
    const fit = grid.classList.toggle('fit');
    e.currentTarget.textContent = fit ? 'Whole photo' : 'Fill square';
    e.currentTarget.classList.toggle('active', fit);
  });
  el('gallery-sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    reset();
  });
  el('gallery-selectall').addEventListener('click', async () => {
    const res = await api.get('/api/photos/ids', params());
    emit('selectMany', res.ids);
    toast(`${fmtNum(res.ids.length)} photos selected`);
  });

  on('filters', () => { dirty = true; if (state.view === 'gallery') reset(); });
  on('selection', paintSelection);
  on('galleryShown', () => {
    // The grid is display:none until the tab is opened, so the column width can
    // only be measured now.
    syncRowHeight();
    if (dirty) reset();
  });
}

function reset() {
  dirty = false;
  items = [];
  total = 0;
  exhausted = false;
  anchor = null;
  grid.innerHTML = '';
  grid.scrollTop = 0;
  loadPage();
}

async function loadPage() {
  if (loading || exhausted) return;
  loading = true;
  const mine = ++token;
  try {
    const p = params({ extra: { limit: PAGE, offset: items.length, sort: state.sort } });
    const res = await api.get('/api/photos', p);
    if (mine !== token) return;
    total = res.total;
    if (!res.items.length) exhausted = true;
    items = items.concat(res.items);
    if (items.length >= total) exhausted = true;
    append(res.items);
    el('gallery-count').textContent =
      `${fmtNum(items.length)} of ${fmtNum(total)} photos`;
  } catch (err) {
    toast(`Gallery failed: ${err.message}`, true);
    exhausted = true;
  } finally {
    loading = false;
  }
}

function append(rows) {
  const size = thumbSizeFor(Number(el('grid-size').value));
  const colors = new Map(state.albums.map((a) => [a.id, a.color]));
  const base = items.length - rows.length;
  const html = rows.map((row, i) => {
    const index = base + i;
    const dots = (row.albums || [])
      .map((id) => `<span class="dot" style="background:${colors.get(id) || '#888'}"></span>`)
      .join('');
    return `<div class="tile${state.selection.has(row.id) ? ' selected' : ''}" data-id="${row.id}" data-index="${index}">
      <img loading="lazy" src="${thumbUrl(row.id, size)}" alt="">
      <span class="pick"></span>
      <span class="flags">${row.note ? '<span class="note-flag" title="Has a note">✎</span>' : ''}${row.favorite ? '<span class="dot" style="background:#ffd166"></span>' : ''}${dots}</span>
      <span class="meta">${fmtDate(row.taken_ts)}${row.lat == null ? ' <span class="nogeo">· no GPS</span>' : ''}</span>
    </div>`;
  }).join('');
  grid.insertAdjacentHTML('beforeend', html);
  syncRowHeight();
}

function onClick(e) {
  const tile = e.target.closest('.tile');
  if (!tile) return;
  const id = Number(tile.dataset.id);
  const index = Number(tile.dataset.index);

  if (e.target.classList.contains('pick') || e.ctrlKey || e.metaKey) {
    emit('toggleSelect', id);
    anchor = index;
    return;
  }
  if (e.shiftKey && anchor != null) {
    const [a, b] = anchor < index ? [anchor, index] : [index, anchor];
    emit('selectMany', items.slice(a, b + 1).map((row) => row.id));
    return;
  }
  anchor = index;
  emit('openPhoto', { id, ids: items.map((row) => row.id) });
}

function paintSelection() {
  grid.querySelectorAll('.tile').forEach((tile) => {
    tile.classList.toggle('selected', state.selection.has(Number(tile.dataset.id)));
  });
}

/** Ids currently rendered, used by the lightbox for prev/next. */
export const galleryIds = () => items.map((row) => row.id);
