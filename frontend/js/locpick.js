// A place chooser for panels and dialogs: a search box with a live dropdown
// (saved places, GeoNames towns, typed coordinates) over a small map that also
// takes a click or a dragged pin. Used by the no-location queue and the home
// timeline, which both need "where was this" answered quickly.
import { api } from './api.js';
import { state, countryName, flag } from './state.js';
import { escapeHtml } from './ui.js';
import { baseLayer } from './mapview.js';
import { parseCoordinates } from './actions.js';

// With `enterConfirms`, Enter on a search result chooses it and calls onEnter
// at once - one key from a typed name to a saved location, for the queue.
/** Draw a place's border from OpenStreetMap on `map`; resolves to the layer,
 *  or null when there is none (offline, open country, a point not a town). */
export async function drawOutline(map, lat, lon, population = 0) {
  try {
    const r = await api.get('/api/geocode/outline', new URLSearchParams({ lat, lon, population: population || 0 }));
    if (!r.geojson) return null;
    return L.geoJSON(r.geojson, {
      style: { color: '#ffb020', weight: 2, fillColor: '#ffb020', fillOpacity: 0.07 }, interactive: false,
    }).addTo(map);
  } catch {
    return null;
  }
}

export function locationPicker(root, { onChange = () => {}, onEnter = null, enterConfirms = false } = {}) {
  root.classList.add('lp');
  root.innerHTML = `
    <div class="lp-find">
      <input type="search" placeholder="Search a town, a saved place, or type lat, lon" autocomplete="off">
      <div class="place-results hidden"></div>
    </div>
    <div class="lp-map"></div>
    <div class="lp-at muted small">Search above, or click the map</div>`;
  const input = root.querySelector('input');
  const list = root.querySelector('.place-results');
  const at = root.querySelector('.lp-at');
  const map = L.map(root.querySelector('.lp-map'), { center: [30, 10], zoom: 2, maxZoom: 19, worldCopyJump: true });
  baseLayer(document.documentElement.dataset.theme === 'light' ? 'streets' : 'dark').addTo(map);
  // A dialog grows to its width after the map is made; keep the chosen place in
  // the middle rather than where the narrower first layout put it.
  const sizer = new ResizeObserver(() => {
    if (!map.getContainer().isConnected) return;
    map.invalidateSize({ pan: false });
    if (current) map.setView([current.lat, current.lon], map.getZoom(), { animate: false });
  });
  sizer.observe(map.getContainer());

  let marker = null;
  let outline = null;
  let current = null;
  let results = [];
  let hi = 0; // the highlighted result, moved with the up and down arrows
  let searching = false;
  let enterWaiting = false; // Enter pressed before the results arrived
  let timer = null;
  let token = 0;

  async function name(lat, lon, label) {
    const mine = ++token;
    at.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}${label ? ` · ${label}` : ''}`;
    if (label) return;
    try {
      const r = await api.get('/api/geocode/reverse', new URLSearchParams({ lat, lon }));
      if (mine !== token || !current) return;
      current.label = r.place.split(',')[0];
      const where = r.place || (r.country ? `outside any town, ${countryName(r.country)}` : 'no town nearby');
      at.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)} · ${where}`;
      onChange(current);
    } catch { /* the coordinates alone are still a position */ }
  }

  function set(lat, lon, { label = '', zoom = null, method = 'MANUAL', fly = true } = {}) {
    current = { lat, lon, label, method };
    if (!marker) {
      marker = L.marker([lat, lon], { draggable: true }).addTo(map);
      marker.on('dragend', () => {
        const p = marker.getLatLng();
        set(p.lat, p.lng, { fly: false });
      });
    } else {
      marker.setLatLng([lat, lon]);
    }
    if (fly) map.setView([lat, lon], zoom ?? Math.max(map.getZoom(), 12));
    name(lat, lon, label);
    onChange(current);
  }

  function clear(view = null) {
    current = null;
    token += 1;
    if (marker) { map.removeLayer(marker); marker = null; }
    at.textContent = 'Search above, or click the map';
    input.value = '';
    results = [];
    enterWaiting = false;
    close();
    if (outline) { map.removeLayer(outline); outline = null; }
    if (view) map.setView([view.lat, view.lon], view.zoom ?? 11);
  }

  map.on('click', (e) => set(e.latlng.lat, e.latlng.lng, { fly: false }));

  const close = () => list.classList.add('hidden');
  const choose = (r) => {
    close();
    input.value = r.label;
    set(r.lat, r.lon, { label: r.name || r.label, zoom: r.zoom });
    if (outline) { map.removeLayer(outline); outline = null; }
    if (r.note === 'coordinates') return;
    const want = current;
    drawOutline(map, r.lat, r.lon, r.population).then((layer) => {
      if (!layer) return;
      if (current !== want) { map.removeLayer(layer); return; }
      outline = layer;
    });
  };
  const enter = () => {
    if (!list.classList.contains('hidden') && results.length) {
      choose(results[hi]);
      if (enterConfirms && onEnter) onEnter();
    } else if (searching || timer) {
      enterWaiting = true;
    } else if (onEnter && current) {
      onEnter();
    }
  };
  const highlight = (i) => {
    hi = Math.max(0, Math.min(i, results.length - 1));
    list.querySelectorAll('[data-i]').forEach((b) => b.classList.toggle('hi', Number(b.dataset.i) === hi));
    list.querySelector('.hi')?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    enterWaiting = false;
    if (q.length < 2) { close(); results = []; timer = null; return; }
    timer = setTimeout(async () => {
      timer = null;
      searching = true;
      const typed = parseCoordinates(q);
      const ql = q.toLowerCase();
      const saved = (state.places || []).filter((p) => p.name.toLowerCase().includes(ql))
        .map((p) => ({ label: p.name, name: p.name, lat: p.lat, lon: p.lon, zoom: 15, note: 'saved place' }));
      let res;
      try {
        res = await api.get('/api/geocode/search', new URLSearchParams({ q, limit: 8 }));
      } finally {
        searching = false;
      }
      if (input.value.trim() !== q) return;
      results = [
        ...(typed ? [{ label: q, name: '', lat: typed.lat, lon: typed.lon, zoom: 15, note: 'coordinates' }] : []),
        ...saved,
        ...res.items.map((h) => ({
          label: `${h.name}${h.region ? `, ${h.region}` : ''}`, name: h.name, lat: h.lat, lon: h.lon,
          population: h.population,
          zoom: h.population > 500000 ? 11 : 13, note: `${h.local ? `${h.local} · ` : ''}${flag(h.cc)} ${countryName(h.cc)}`,
        })),
      ];
      hi = 0;
      list.innerHTML = results.map((r, i) => `<button type="button" data-i="${i}" class="${i ? '' : 'hi'}">${escapeHtml(r.label)} <span class="muted">${escapeHtml(r.note)}</span></button>`).join('')
        || `<span class="muted small" style="padding:6px">${res.available ? 'Nothing by that name' : 'Download place names in Settings to search by name'}</span>`;
      list.classList.remove('hidden');
      if (enterWaiting) {
        enterWaiting = false;
        if (results.length) enter();
      }
    }, 180);
  });
  input.addEventListener('keydown', (e) => {
    const open = !list.classList.contains('hidden') && results.length;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      enter();
    }
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      highlight(hi + (e.key === 'ArrowDown' ? 1 : -1));
    }
    if (e.key === 'Escape' && !list.classList.contains('hidden')) { e.stopPropagation(); close(); }
  });
  list.addEventListener('click', (e) => {
    const r = results[Number(e.target.closest('[data-i]')?.dataset.i)];
    if (!r) return;
    choose(r);
    if (enterConfirms && onEnter) onEnter();
  });
  root.addEventListener('focusout', (e) => { if (!root.querySelector('.lp-find').contains(e.relatedTarget)) setTimeout(close, 150); });

  return {
    set, clear, map,
    get: () => current,
    focus: () => input.focus(),
    input,
    destroy: () => { sizer.disconnect(); map.remove(); },
  };
}
