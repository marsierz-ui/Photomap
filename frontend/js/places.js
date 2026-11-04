// Saved places ("Home", "Grandma's"), and finding any place by name.
//
// A saved place is a circle: picking it in the sidebar narrows every view to
// the photos inside it, and one of them is home, which trips are measured from.
// Place names come from the offline GeoNames list, so typing "Kilronan" jumps
// the map there without asking anyone on the internet.
import { api, guard } from './api.js';
import { state, on, emit, setFilters, fmtNum, countryName, flag } from './state.js';
import { el, modal, toast, confirmModal, escapeHtml } from './ui.js';
import { leafletMap, flyTo, pickLocation } from './mapview.js';
import { parseCoordinates } from './actions.js';

let pins = null;
let found = null;

export function initPlaces() {
  el('place-new').addEventListener('click', () => placeDialog({}));
  el('place-list').addEventListener('click', onListClick);
  on('placesChanged', refreshPlaces);
  on('dataChanged', refreshPlaces);
  on('filters', renderList);
  wireSearch();
  // Right-click on the map: save this spot.
  leafletMap().on('contextmenu', (e) => placeDialog({ lat: e.latlng.lat, lon: e.latlng.lng }));
  refreshPlaces();
}

export async function refreshPlaces() {
  state.places = await api.get('/api/places');
  renderList();
  drawPins();
}

function renderList() {
  const active = Number(state.filters.near);
  el('place-list').innerHTML = state.places.map((p) => `
    <li data-id="${p.id}" class="${p.id === active ? 'active' : ''}">
      <span class="pin-ico">${p.is_home ? '⌂' : '◉'}</span>
      <span class="name" title="${escapeHtml(p.name)} · ${p.radius_m} m around">${escapeHtml(p.name)}</span>
      <span class="count">${fmtNum(p.photos)}</span>
      <span class="acts">
        <button class="icon-btn" data-act="go" title="Show on map">◎</button>
        ${p.is_home ? '' : '<button class="icon-btn" data-act="home" title="Make this home">⌂</button>'}
        <button class="icon-btn" data-act="edit" title="Rename, resize or move">✎</button>
        <button class="icon-btn" data-act="del" title="Delete place">✕</button>
      </span>
    </li>`).join('') || '<li class="muted small">Right-click the map, or + New, to name a place</li>';
}

function drawPins() {
  const map = leafletMap();
  if (pins) map.removeLayer(pins);
  pins = L.layerGroup(state.places.flatMap((p) => [
    L.circle([p.lat, p.lon], { radius: p.radius_m, color: p.is_home ? '#3fb950' : '#ffd166', weight: 1, fillOpacity: 0.06, interactive: false }),
    L.marker([p.lat, p.lon], {
      icon: L.divIcon({ className: `place-pin${p.is_home ? ' home' : ''}`, html: `<i>${p.is_home ? '⌂' : '◉'}</i><span>${escapeHtml(p.name)}</span>`, iconSize: null, iconAnchor: [9, 9] }),
      title: p.name,
      zIndexOffset: 500,
    }).on('click', () => setFilters({ near: p.id })),
  ])).addTo(map);
}

async function onListClick(e) {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const place = state.places.find((p) => p.id === Number(li.dataset.id));
  const act = e.target.dataset.act;
  if (act === 'go') { emit('showMap'); flyTo(place.lat, place.lon, 15); return; }
  if (act === 'home') {
    await guard(api.patch(`/api/places/${place.id}`, { is_home: true }), 'Failed');
    toast(`${place.name} is home now`);
    refreshPlaces();
    emit('dataChanged');
    return;
  }
  if (act === 'edit') { placeDialog(place); return; }
  if (act === 'del') {
    if (!await confirmModal('Delete place', `Forget <strong>${escapeHtml(place.name)}</strong>? Photos are not touched.`, 'Delete')) return;
    await guard(api.del(`/api/places/${place.id}`), 'Failed');
    if (Number(state.filters.near) === place.id) setFilters({ near: null });
    refreshPlaces();
    return;
  }
  // The name: narrow everything to this place, or let go of it again.
  const picking = Number(state.filters.near) !== place.id;
  setFilters({ near: picking ? place.id : null });
  if (picking && state.view === 'map') flyTo(place.lat, place.lon, place.radius_m > 3000 ? 11 : 14);
}

/** Create or edit a place. A position can come from the click that opened it,
 *  typed coordinates, a place name, or a click on the map. */
export function placeDialog(place) {
  const editing = !!place.id;
  let at = place.lat != null ? { lat: place.lat, lon: place.lon } : null;
  modal(`
    <h3>${editing ? 'Edit place' : 'Save a place'}</h3>
    <div class="row"><label>Name</label><input type="text" id="pl-name" maxlength="80" style="flex:1"
      value="${escapeHtml(place.name || '')}" placeholder="Home, Grandma's, the cottage…"></div>
    <div class="row"><label>Where</label><input type="text" id="pl-at" style="flex:1"
      placeholder="Coordinates or a town name" value="${at ? `${at.lat.toFixed(5)}, ${at.lon.toFixed(5)}` : ''}"></div>
    <div id="pl-hits" class="hits"></div>
    <div class="row"><label>Size</label>
      <select id="pl-radius">
        ${[[100, 'A building (100 m)'], [300, 'A street (300 m)'], [1000, 'A village (1 km)'], [5000, 'A town (5 km)'], [20000, 'A city (20 km)']]
          .map(([m, label]) => `<option value="${m}" ${m === (place.radius_m || 300) ? 'selected' : ''}>${label}</option>`).join('')}
      </select></div>
    <label class="check"><input type="checkbox" id="pl-home" ${place.is_home ? 'checked' : ''}> This is home (trips are measured from it)</label>
    <p class="muted small" id="pl-err" style="min-height:1.2em"></p>
    <div class="actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn" data-act="pick">Pick on the map</button>
      <button class="btn primary" data-act="ok">${editing ? 'Save' : 'Save place'}</button>
    </div>`, (box, close) => {
    const where = box.querySelector('#pl-at');
    const hits = box.querySelector('#pl-hits');
    const err = (t) => { box.querySelector('#pl-err').textContent = t; };
    if (!editing && at) box.querySelector('#pl-name').focus();
    let timer = null;
    where.addEventListener('input', () => {
      clearTimeout(timer);
      const typed = parseCoordinates(where.value);
      if (typed) { at = typed; hits.innerHTML = ''; return; }
      at = null;
      timer = setTimeout(async () => {
        const res = await api.get('/api/geocode/search', new URLSearchParams({ q: where.value, limit: 6 }));
        hits.innerHTML = res.items.map((h, i) => `<button class="hit" data-i="${i}">${flag(h.cc)} ${escapeHtml(h.name)}<span class="muted">${h.region ? `, ${escapeHtml(h.region)}` : ''}, ${escapeHtml(countryName(h.cc))}</span></button>`).join('')
          || (res.available ? '' : '<span class="muted small">Download place names in Settings to search by name</span>');
        hits.onclick = (e) => {
          const h = res.items[Number(e.target.closest('[data-i]')?.dataset.i)];
          if (!h) return;
          at = { lat: h.lat, lon: h.lon };
          where.value = `${h.name} (${h.lat.toFixed(4)}, ${h.lon.toFixed(4)})`;
          if (!box.querySelector('#pl-name').value) box.querySelector('#pl-name').value = h.name;
          hits.innerHTML = '';
        };
      }, 250);
    });
    box.querySelector('[data-act=cancel]').onclick = close;
    const values = () => ({
      name: box.querySelector('#pl-name').value.trim(),
      radius_m: Number(box.querySelector('#pl-radius').value),
      is_home: box.querySelector('#pl-home').checked,
    });
    box.querySelector('[data-act=pick]').onclick = async () => {
      const keep = values();
      close();
      emit('showMap');
      const picked = await pickLocation();
      if (picked) placeDialog({ ...place, ...keep, lat: picked.lat, lon: picked.lng });
    };
    box.querySelector('[data-act=ok]').onclick = async () => {
      const v = values();
      if (!v.name) { err('Give it a name'); return; }
      if (!at) { err('Choose where it is: coordinates, a town from the list, or Pick on the map'); return; }
      const body = { ...v, lat: at.lat, lon: at.lon };
      if (editing) await guard(api.patch(`/api/places/${place.id}`, body), 'Could not save the place');
      else await guard(api.post('/api/places', body), 'Could not save the place');
      close();
      toast(`${v.name} saved`);
      refreshPlaces();
      if (v.is_home !== !!place.is_home) emit('dataChanged');
    };
  });
}

// ------------------------------------------------------------ find a place

function wireSearch() {
  const input = el('place-search');
  const list = el('place-results');
  let timer = null;
  let results = [];
  const close = () => { list.classList.add('hidden'); };
  const go = (r) => {
    close();
    input.value = r.label;
    flyTo(r.lat, r.lon, r.zoom);
    const map = leafletMap();
    if (found) map.removeLayer(found);
    if (r.saved) return;
    found = L.marker([r.lat, r.lon], { title: r.label }).addTo(map)
      .bindPopup(`<strong>${escapeHtml(r.label)}</strong><br><button class="btn tiny" data-save>Save as a place</button>`)
      .openPopup();
    found.getPopup().getElement()?.querySelector('[data-save]')?.addEventListener('click', () => {
      placeDialog({ name: r.name, lat: r.lat, lon: r.lon, radius_m: 1000 });
    });
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    timer = setTimeout(async () => {
      const typed = parseCoordinates(q);
      const ql = q.toLowerCase();
      const saved = state.places.filter((p) => p.name.toLowerCase().includes(ql))
        .map((p) => ({ label: p.name, name: p.name, lat: p.lat, lon: p.lon, zoom: 15, saved: true, note: 'saved place' }));
      const res = await api.get('/api/geocode/search', new URLSearchParams({ q, limit: 8 }));
      results = [
        ...(typed ? [{ label: q, name: '', lat: typed.lat, lon: typed.lon, zoom: 15, note: 'coordinates' }] : []),
        ...saved,
        ...res.items.map((h) => ({
          label: `${h.name}${h.region ? `, ${h.region}` : ''}`, name: h.name, lat: h.lat, lon: h.lon,
          zoom: h.population > 500000 ? 11 : 13, note: `${h.local ? `${h.local} · ` : ''}${flag(h.cc)} ${countryName(h.cc)}`,
        })),
      ];
      list.innerHTML = results.map((r, i) => `<button data-i="${i}">${escapeHtml(r.label)} <span class="muted">${escapeHtml(r.note)}</span></button>`).join('')
        || `<span class="muted small" style="padding:6px">${res.available ? 'Nothing by that name' : 'Download place names in Settings to search by name'}</span>`;
      list.classList.remove('hidden');
    }, 200);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && results.length) go(results[0]);
    if (e.key === 'Escape') close();
  });
  list.addEventListener('click', (e) => {
    const r = results[Number(e.target.closest('[data-i]')?.dataset.i)];
    if (r) go(r);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.place-find')) close(); });
}
