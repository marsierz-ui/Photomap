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
  wireAreaSelect();
  el('grid-select').addEventListener('click', () => armArea(!armed));

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

// ------------------------------------------------- selecting an area of grid
//
// Tiles here are real elements - this grid is paginated rather than virtualised
// - so the rectangle is answered by testing them, which also means it selects
// exactly what is loaded and nothing it has never heard of. Dragging to the
// bottom edge scrolls, and scrolling is what fetches the next page, so a long
// drag keeps finding more.

let armed = false;
let justDragged = false;   // a click is arriving from a drag already handled

function armArea(on) {
  armed = on;
  el('grid-select').classList.toggle('active', on);
  grid.classList.toggle('picking', on);
}

/** A tile's box in the grid's own scrolled coordinates. offsetLeft/Top are
 *  relative to #grid, which is the offset parent now that it is positioned. */
function tileBox(tile) {
  return {
    left: tile.offsetLeft,
    top: tile.offsetTop,
    right: tile.offsetLeft + tile.offsetWidth,
    bottom: tile.offsetTop + tile.offsetHeight,
  };
}

function wireAreaSelect() {
  let from = null;
  let band = null;
  let pointer = null;
  let client = null;
  let scrolling = null;

  const point = () => {
    const r = grid.getBoundingClientRect();
    return { x: client.x - r.left + grid.scrollLeft, y: client.y - r.top + grid.scrollTop };
  };

  const drawBand = () => {
    const now = point();
    band.style.left = `${Math.min(from.x, now.x)}px`;
    band.style.top = `${Math.min(from.y, now.y)}px`;
    band.style.width = `${Math.abs(now.x - from.x)}px`;
    band.style.height = `${Math.abs(now.y - from.y)}px`;
  };

  /** Dragging at the edge keeps going, and because the grid loads the next page
   *  as it scrolls, the drag reaches photos that were not fetched when it began. */
  const follow = () => {
    if (from === null) return;
    const r = grid.getBoundingClientRect();
    const margin = 56;
    let dy = 0;
    if (client.y < r.top + margin) dy = -Math.ceil((r.top + margin - client.y) / 3);
    else if (client.y > r.bottom - margin) dy = Math.ceil((client.y - (r.bottom - margin)) / 3);
    if (dy) {
      const before = grid.scrollTop;
      grid.scrollTop += dy;
      if (grid.scrollTop !== before) drawBand();
    }
    scrolling = requestAnimationFrame(follow);
  };

  const stop = () => {
    if (scrolling !== null) cancelAnimationFrame(scrolling);
    scrolling = null;
  };

  grid.addEventListener('pointerdown', (e) => {
    if (from !== null) return;
    if (!armed && !e.shiftKey) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    pointer = e.pointerId;
    client = { x: e.clientX, y: e.clientY };
    from = point();
    band = document.createElement('div');
    band.className = 'grid-band';
    grid.appendChild(band);
    try {
      grid.setPointerCapture(pointer);
    } catch {
      /* the pointer ended before capture; the drag still works */
    }
    scrolling = requestAnimationFrame(follow);
  });

  grid.addEventListener('pointermove', (e) => {
    if (from === null || e.pointerId !== pointer) return;
    e.preventDefault();
    client = { x: e.clientX, y: e.clientY };
    drawBand();
  });

  const finish = (e) => {
    if (from === null || (e && e.pointerId !== pointer)) return;
    stop();
    // The click that follows the release lands on whatever tile was underneath,
    // and would otherwise open it in the lightbox.
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 0);

    const start = from;
    const end = point();
    from = null;
    band.remove();
    band = null;
    try {
      grid.releasePointerCapture(pointer);
    } catch {
      /* already released */
    }
    if (armed) armArea(false);

    const box = {
      left: Math.min(start.x, end.x),
      right: Math.max(start.x, end.x),
      top: Math.min(start.y, end.y),
      bottom: Math.max(start.y, end.y),
    };
    const tiles = [...grid.querySelectorAll('.tile')];

    // Barely moved: that was a tap, and it means the one photo under it.
    if (box.right - box.left < 6 && box.bottom - box.top < 6) {
      const hit = tiles.find((t) => {
        const b = tileBox(t);
        return box.left >= b.left && box.left <= b.right && box.top >= b.top && box.top <= b.bottom;
      });
      if (hit) emit('toggleSelect', Number(hit.dataset.id));
      return;
    }

    const ids = tiles.filter((t) => {
      const b = tileBox(t);
      return b.left < box.right && box.left < b.right && b.top < box.bottom && box.top < b.bottom;
    }).map((t) => Number(t.dataset.id));

    if (!ids.length) { toast('No photos in that area'); return; }
    emit('selectMany', ids);
    toast(`${fmtNum(ids.length)} photos selected`);
  };

  grid.addEventListener('pointerup', finish);
  grid.addEventListener('pointercancel', finish);
}

function onClick(e) {
  if (justDragged) return;
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
