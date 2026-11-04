import { api, guard } from './api.js';
import { state, params, emit, on, setFilters, fmtNum, fmtDate, isoToTs, tsToIso, countryName } from './state.js';
import { el, modal, toast, confirmModal, escapeHtml } from './ui.js';
import { flyToBounds } from './mapview.js';
import { fixLocationsDialog } from './actions.js';
import { geotagDialog } from './tracklog.js';
import { openLocationQueue } from './locqueue.js';

export function initSidebar() {
  wireFilters();
  el('album-new').addEventListener('click', () => createAlbumDialog([]));
  el('album-list').addEventListener('click', onAlbumClick);

  on('filters', () => { syncInputs(); renderAlbums(); summarize(); renderQueue(); });
  el('nogeo-review').addEventListener('click', reviewQueue);
  el('nogeo-one').addEventListener('click', openLocationQueue);
  on('dataChanged', refreshAll);
}

// ------------------------------------------------------------------- filters

function wireFilters() {
  el('f-from').addEventListener('change', (e) => setFilters({ from: isoToTs(e.target.value) }));
  el('f-to').addEventListener('change', (e) => setFilters({ to: isoToTs(e.target.value, true) }));
  el('f-gps').addEventListener('change', (e) => setFilters({ gps: e.target.value }));
  el('f-camera').addEventListener('change', (e) => setFilters({ camera: e.target.value }));
  el('f-fav').addEventListener('change', (e) => setFilters({ fav: e.target.checked }));
  el('f-viewport').addEventListener('change', (e) => {
    state.followMap = e.target.checked;
    emit('filters');
  });
  el('f-reset').addEventListener('click', () => {
    state.followMap = false;
    el('f-viewport').checked = false;
    el('search').value = '';
    setFilters({ from: null, to: null, gps: 'any', album: null, camera: '', q: '', fav: false, near: null, country: '' });
  });

  let searchTimer = null;
  el('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setFilters({ q: e.target.value.trim() }), 300);
  });
}

function syncInputs() {
  const f = state.filters;
  el('f-from').value = tsToIso(f.from);
  el('f-to').value = tsToIso(f.to);
  el('f-gps').value = f.gps;
  el('f-camera').value = f.camera || '';
  el('f-fav').checked = !!f.fav;
}

function summarize() {
  const f = state.filters;
  const bits = [];
  if (f.from || f.to) bits.push(`${f.from ? fmtDate(f.from) : '…'} → ${f.to ? fmtDate(f.to) : '…'}`);
  if (f.album) bits.push(`album: ${state.albums.find((a) => a.id === Number(f.album))?.name ?? f.album}`);
  if (f.camera) bits.push(`camera: ${f.camera}`);
  if (f.q) bits.push(`"${f.q}"`);
  if (f.gps !== 'any') {
    bits.push({
      yes: 'with GPS', no: 'without GPS', approx: 'approximate location',
      neighbour: 'location from a neighbour', manual: 'location set by hand', track: 'placed from a GPS track',
    }[f.gps]);
  }
  if (f.near) bits.push(`at ${state.places.find((p) => p.id === Number(f.near))?.name ?? 'a saved place'}`);
  if (f.country) bits.push(`in ${countryName(f.country)}`);
  if (f.fav) bits.push('favourites');
  if (state.followMap) bits.push('map viewport');
  el('filter-summary').textContent = bits.join(' · ');
}

// -------------------------------------------------------------------- albums

export async function refreshAll() {
  const [albums, stats] = await Promise.all([
    api.get('/api/albums'),
    api.get('/api/stats'),
  ]);
  state.albums = albums;
  unlocated = Math.max(0, (stats.total || 0) - (stats.geo || 0));
  renderQueue();

  renderAlbums();

  const select = el('f-camera');
  const current = state.filters.camera || '';
  select.innerHTML = '<option value="">Any</option>'
    + stats.cameras.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)} (${fmtNum(c.c)})</option>`).join('');
  select.value = current;
  summarize();
}

// Collapsed albums, remembered on this device only: it is a view preference.
const collapsed = new Set((() => {
  try { return JSON.parse(localStorage.getItem('pm-albums-collapsed') || '[]'); } catch { return []; }
})());

function saveCollapsed() {
  try { localStorage.setItem('pm-albums-collapsed', JSON.stringify([...collapsed])); } catch { /* private window */ }
}

/** Albums in tree order, each with its depth. An album whose parent is gone is
 *  shown at the top rather than lost. */
export function albumTree(skipBelow = null) {
  const ids = new Set(state.albums.map((a) => a.id));
  const kids = new Map();
  state.albums.forEach((a) => {
    const parent = ids.has(a.parent_id) ? a.parent_id : null;
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(a);
  });
  const out = [];
  const walk = (parent, depth) => (kids.get(parent) || []).forEach((a) => {
    if (a.id === skipBelow) return;
    out.push({ album: a, depth, hasKids: kids.has(a.id) });
    walk(a.id, depth + 1);
  });
  walk(null, 0);
  return out;
}

function renderAlbums() {
  const active = Number(state.filters.album);
  const hidden = new Set();
  const rows = albumTree().filter(({ album }) => {
    if (hidden.has(album.parent_id)) { hidden.add(album.id); return false; }
    if (collapsed.has(album.id)) hidden.add(album.id);
    return true;
  });
  el('album-list').innerHTML = rows.map(({ album: a, depth, hasKids }) => `
    <li data-id="${a.id}" class="${a.id === active ? 'active' : ''}" style="padding-left:${6 + depth * 14}px">
      <span class="twisty" ${hasKids ? 'data-act="fold"' : ''}>${hasKids ? (collapsed.has(a.id) ? '▸' : '▾') : ''}</span>
      <span class="dot" style="background:${escapeHtml(a.color)}"></span>
      <span class="name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>
      <span class="count">${fmtNum(a.photo_count)}</span>
      <span class="acts">
        <button class="icon-btn" data-act="sub" title="New subalbum">+</button>
        <button class="icon-btn" data-act="map" title="Show on map">◎</button>
        <button class="icon-btn" data-act="edit" title="Rename / colour / move">✎</button>
        <button class="icon-btn" data-act="del" title="Delete album">✕</button>
      </span>
    </li>`).join('') || '<li class="muted small">No albums yet</li>';
}

/** A select of every album the given one could go under. */
function parentSelect(current, self = null) {
  const options = albumTree(self).map(({ album, depth }) =>
    `<option value="${album.id}" ${album.id === current ? 'selected' : ''}>${' '.repeat(depth)}${escapeHtml(album.name)}</option>`);
  return `<div class="row"><label>Inside</label><select id="al-parent">
    <option value="">(top level)</option>${options.join('')}</select></div>`;
}

const chosenParent = (box) => Number(box.querySelector('#al-parent').value) || null;

async function onAlbumClick(e) {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const id = Number(li.dataset.id);
  const album = state.albums.find((a) => a.id === id);
  const act = e.target.dataset.act;

  if (act === 'del') {
    const subs = state.albums.some((a) => a.parent_id === id)
      ? ' Its subalbums move up a level.' : '';
    if (await confirmModal('Delete album', `Delete "${escapeHtml(album.name)}"? Photos stay on disk.${subs}`, 'Delete album')) {
      await guard(api.del(`/api/albums/${id}`), 'Delete failed');
      if (Number(state.filters.album) === id) setFilters({ album: null }, true);
      await refreshAll();
      emit('filters');
    }
    return;
  }
  if (act === 'edit') { editAlbumDialog(album); return; }
  if (act === 'sub') { createAlbumDialog([], id); return; }
  if (act === 'fold') {
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    saveCollapsed();
    renderAlbums();
    return;
  }
  if (act === 'map') {
    setFilters({ album: id });
    const res = await api.get('/api/points', new URLSearchParams({ album: id, gps: 'yes' }));
    if (res.n) {
      let s = 90; let w = 180; let n = -90; let e2 = -180;
      for (let i = 0; i < res.n; i += 1) {
        s = Math.min(s, res.lat[i]); n = Math.max(n, res.lat[i]);
        w = Math.min(w, res.lon[i]); e2 = Math.max(e2, res.lon[i]);
      }
      flyToBounds([[s, w], [n, e2]]);
    } else {
      toast('No photos with location in this album');
    }
    return;
  }
  setFilters({ album: Number(state.filters.album) === id ? null : id });
}

export function createAlbumDialog(ids, parentId = null, done = null) {
  const parent = state.albums.find((a) => a.id === parentId);
  modal(`
    <h3>${parent ? `New album inside "${escapeHtml(parent.name)}"` : 'New album'}</h3>
    <input type="text" id="al-name" placeholder="Album name" autocomplete="off">
    <div class="row"><label>Colour</label><input type="color" id="al-color" value="${escapeHtml(parent?.color || '#ff5a5f')}"></div>
    ${parentSelect(parentId)}
    ${ids.length ? `<div class="muted small">${fmtNum(ids.length)} selected photos will be added.</div>` : ''}
    <div class="actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="ok">Create</button>
    </div>`, (box, close) => {
    const submit = async () => {
      const name = box.querySelector('#al-name').value.trim();
      if (!name) return;
      await guard(api.post('/api/albums', {
        name, color: box.querySelector('#al-color').value, ids, parent_id: chosenParent(box),
      }), 'Create failed');
      close();
      await refreshAll();
      toast(`Album "${name}" created`);
      emit('filters');
      if (done) done();
    };
    box.querySelector('#al-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    box.querySelector('[data-act=ok]').onclick = submit;
    box.querySelector('[data-act=cancel]').onclick = close;
  });
}

function editAlbumDialog(album) {
  modal(`
    <h3>Edit album</h3>
    <input type="text" id="al-name" value="${escapeHtml(album.name)}">
    <div class="row"><label>Colour</label><input type="color" id="al-color" value="${escapeHtml(album.color)}"></div>
    ${parentSelect(album.parent_id, album.id)}
    <div class="actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="ok">Save</button>
    </div>`, (box, close) => {
    box.querySelector('[data-act=ok]').onclick = async () => {
      await guard(api.patch(`/api/albums/${album.id}`, {
        name: box.querySelector('#al-name').value.trim(),
        color: box.querySelector('#al-color').value,
        parent_id: chosenParent(box),
      }), 'Save failed');
      close();
      await refreshAll();
      emit('filters');
    };
    box.querySelector('[data-act=cancel]').onclick = close;
  });
}

/** Album chooser used by the selection bar and the lightbox. */
export function pickAlbumDialog(ids, done) {
  const list = albumTree().map(({ album: a, depth }) => `
    <div data-id="${a.id}" style="padding-left:${10 + depth * 16}px">
      <span class="dot" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${escapeHtml(a.color)}"></span>
      ${escapeHtml(a.name)} <span class="muted small">${fmtNum(a.photo_count)}</span>
    </div>`).join('');
  modal(`
    <h3>${ids.length === 1 ? 'Add this photo to an album' : `Add ${fmtNum(ids.length)} photos to an album`}</h3>
    <div class="picker">${list || '<div class="muted">No albums yet</div>'}</div>
    <div class="actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="new">New album…</button>
    </div>`, (box, close) => {
    box.querySelector('.picker').addEventListener('click', async (e) => {
      const row = e.target.closest('div[data-id]');
      if (!row) return;
      const id = Number(row.dataset.id);
      await guard(api.post(`/api/albums/${id}/photos`, { ids }), 'Failed');
      close();
      await refreshAll();
      toast(ids.length === 1 ? 'Added to the album' : `Added ${fmtNum(ids.length)} photos`);
      emit('filters');
      if (done) done();
    });
    box.querySelector('[data-act=new]').onclick = () => { close(); createAlbumDialog(ids, null, done); };
    box.querySelector('[data-act=cancel]').onclick = close;
  });
}

// --------------------------------------------------------- no-location queue
//
// Photos with no position never reach the map, which is how they get
// forgotten. The count sits under the filters, and Review opens them in the
// gallery with the ways of placing them one click away.

let unlocated = 0;

function renderQueue() {
  const reviewing = state.filters.gps === 'no';
  el('nogeo-queue').classList.toggle('hidden', !unlocated);
  el('nogeo-text').textContent = reviewing
    ? `${fmtNum(unlocated)} without a location. Place them:`
    : `${fmtNum(unlocated)} photo${unlocated === 1 ? '' : 's'} without a location`;
  el('nogeo-review').textContent = reviewing ? 'Options…' : 'Review';
}

async function reviewQueue() {
  if (state.filters.gps !== 'no') {
    setFilters({ gps: 'no' });
    emit('showView', 'gallery');
    return;
  }
  const { ids } = await api.get('/api/photos/ids', params({ extra: { limit: 5000 } }));
  modal(`
    <h3>${fmtNum(ids.length)} photos without a location</h3>
    <p class="small">For photos from a camera without GPS, the best source is where your phone was at the time.</p>
    <div class="queue-opts">
      <button class="btn" data-act="one">One by one…<span class="muted small">each photo in turn: search a place or click the map, confirm, next</span></button>
      <button class="btn" data-act="tracks">From GPS tracks…<span class="muted small">GPX or Google Timeline, matched by time</span></button>
      <button class="btn" data-act="near">From the nearest photo…<span class="muted small">copy a phone photo's position from within 2 hours</span></button>
      <button class="btn" data-act="pick">Select them all<span class="muted small">then Set location… puts them on one spot</span></button>
    </div>
    <div class="actions"><button class="btn" data-act="cancel">Close</button></div>`, (box, close) => {
    box.querySelector('[data-act=cancel]').onclick = close;
    box.querySelector('[data-act=one]').onclick = () => { close(); openLocationQueue(); };
    box.querySelector('[data-act=tracks]').onclick = () => { close(); geotagDialog(ids); };
    box.querySelector('[data-act=near]').onclick = () => { close(); fixLocationsDialog(ids, { unlocated: true }); };
    box.querySelector('[data-act=pick]').onclick = () => { close(); emit('selectMany', ids); };
  });
}
