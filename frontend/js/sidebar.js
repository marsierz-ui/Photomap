import { api, guard } from './api.js';
import { state, params, emit, on, setFilters, fmtNum, fmtDate, isoToTs, tsToIso } from './state.js';
import { el, modal, toast, confirmModal, escapeHtml } from './ui.js';
import { flyToBounds } from './mapview.js';

export function initSidebar() {
  wireFilters();
  el('album-new').addEventListener('click', () => createAlbumDialog([]));
  el('album-list').addEventListener('click', onAlbumClick);

  on('filters', () => { syncInputs(); renderAlbums(); summarize(); });
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
    setFilters({ from: null, to: null, gps: 'any', album: null, camera: '', q: '', fav: false });
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
      neighbour: 'location from a neighbour', manual: 'location set by hand',
    }[f.gps]);
  }
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

  renderAlbums();

  const select = el('f-camera');
  const current = state.filters.camera || '';
  select.innerHTML = '<option value="">Any</option>'
    + stats.cameras.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)} (${fmtNum(c.c)})</option>`).join('');
  select.value = current;
  summarize();
}

function renderAlbums() {
  const active = Number(state.filters.album);
  el('album-list').innerHTML = state.albums.map((a) => `
    <li data-id="${a.id}" class="${a.id === active ? 'active' : ''}">
      <span class="dot" style="background:${escapeHtml(a.color)}"></span>
      <span class="name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>
      <span class="count">${fmtNum(a.photo_count)}</span>
      <span class="acts">
        <button class="icon-btn" data-act="map" title="Show on map">◎</button>
        <button class="icon-btn" data-act="edit" title="Rename / colour">✎</button>
        <button class="icon-btn" data-act="del" title="Delete album">✕</button>
      </span>
    </li>`).join('') || '<li class="muted small">No albums yet</li>';
}

async function onAlbumClick(e) {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const id = Number(li.dataset.id);
  const album = state.albums.find((a) => a.id === id);
  const act = e.target.dataset.act;

  if (act === 'del') {
    if (await confirmModal('Delete album', `Delete "${escapeHtml(album.name)}"? Photos stay on disk.`, 'Delete album')) {
      await guard(api.del(`/api/albums/${id}`), 'Delete failed');
      if (Number(state.filters.album) === id) setFilters({ album: null }, true);
      await refreshAll();
      emit('filters');
    }
    return;
  }
  if (act === 'edit') { editAlbumDialog(album); return; }
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

export function createAlbumDialog(ids) {
  modal(`
    <h3>New album</h3>
    <input type="text" id="al-name" placeholder="Album name" autocomplete="off">
    <div class="row"><label>Colour</label><input type="color" id="al-color" value="#ff5a5f"></div>
    ${ids.length ? `<div class="muted small">${fmtNum(ids.length)} selected photos will be added.</div>` : ''}
    <div class="actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="ok">Create</button>
    </div>`, (box, close) => {
    const submit = async () => {
      const name = box.querySelector('#al-name').value.trim();
      if (!name) return;
      await guard(api.post('/api/albums', { name, color: box.querySelector('#al-color').value, ids }), 'Create failed');
      close();
      await refreshAll();
      toast(`Album "${name}" created`);
      emit('filters');
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
    <div class="actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="ok">Save</button>
    </div>`, (box, close) => {
    box.querySelector('[data-act=ok]').onclick = async () => {
      await guard(api.patch(`/api/albums/${album.id}`, {
        name: box.querySelector('#al-name').value.trim(),
        color: box.querySelector('#al-color').value,
      }), 'Save failed');
      close();
      await refreshAll();
      emit('filters');
    };
    box.querySelector('[data-act=cancel]').onclick = close;
  });
}

/** Album chooser used by the selection bar. */
export function pickAlbumDialog(ids) {
  const list = state.albums.map((a) => `
    <div data-id="${a.id}">
      <span class="dot" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${escapeHtml(a.color)}"></span>
      ${escapeHtml(a.name)} <span class="muted small">${fmtNum(a.photo_count)}</span>
    </div>`).join('');
  modal(`
    <h3>Add ${fmtNum(ids.length)} photos to album</h3>
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
      toast(`Added ${fmtNum(ids.length)} photos`);
      emit('filters');
    });
    box.querySelector('[data-act=new]').onclick = () => { close(); createAlbumDialog(ids); };
    box.querySelector('[data-act=cancel]').onclick = close;
  });
}
