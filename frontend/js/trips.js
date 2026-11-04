// Trips: runs of days away from home, worked out by the server from the photos
// each time this view is opened, so a fix or a GPX import shows up at once.
import { api, guard, thumbUrl } from './api.js';
import { state, on, emit, setFilters, fmtNum, fmtDate, countryName, flag } from './state.js';
import { el, modal, toast, escapeHtml } from './ui.js';
import { pickLocation, flyToBounds } from './mapview.js';

const DAY = 86400;
let awayKm = (() => {
  try { return Number(localStorage.getItem('pm-trip-away')) || 50; } catch { return 50; }
})();
let last = null;

export function initTrips() {
  on('tripsShown', render);
  on('dataChanged', () => { if (state.view === 'trips') render(); });
  el('trips').addEventListener('click', onClick);
  el('trips').addEventListener('change', (e) => {
    if (e.target.id !== 'trip-away') return;
    awayKm = Number(e.target.value);
    try { localStorage.setItem('pm-trip-away', String(awayKm)); } catch { /* private window */ }
    render();
  });
}

/** What a trip is called when nobody has named it: the countries, if it left
 *  the home country, otherwise the towns it went to. */
export function tripTitle(trip, homeCc) {
  if (trip.title) return trip.title;
  const abroad = trip.countries.filter((c) => c.cc !== homeCc);
  const join = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} & ${list[list.length - 1]}` : list[0]);
  if (abroad.length) return join(trip.countries.slice(0, 3).map((c) => countryName(c.cc)));
  if (trip.places.length) return join(trip.places.slice(0, 2).map((p) => p.name));
  return `Trip of ${fmtDate(trip.start_ts)}`;
}

const span = (t) => ({ from: Math.floor(t.start_ts / DAY) * DAY, to: Math.floor(t.end_ts / DAY) * DAY + DAY - 1 });

async function render() {
  const target = el('trips');
  const res = await api.get('/api/trips', new URLSearchParams({ away_km: awayKm }));
  last = res;
  if (!res.home) {
    target.innerHTML = '<div class="empty muted">No located photos yet. Trips are worked out from where and when photos were taken.</div>';
    return;
  }
  const items = res.items;
  const days = items.reduce((n, t) => n + t.days, 0);
  const countries = new Set(items.flatMap((t) => t.countries.map((c) => c.cc)));
  const home = res.home;
  const homeName = home.guessed ? (home.place || `${home.lat.toFixed(3)}, ${home.lon.toFixed(3)}`) : home.name;

  target.innerHTML = `
    <div class="trips-head">
      <div>
        <strong>${fmtNum(items.length)} trip${items.length === 1 ? '' : 's'}</strong>
        <span class="muted">· ${fmtNum(days)} days away · ${fmtNum(countries.size)} countr${countries.size === 1 ? 'y' : 'ies'}</span>
      </div>
      <div class="spacer"></div>
      <span class="muted small">Home: <strong>${escapeHtml(homeName)}</strong>${home.guessed ? ' (guessed: the place with photos on the most days)' : ''}</span>
      <button class="btn tiny" data-act="home">${home.guessed ? 'Set home…' : 'Change home…'}</button>
      <label class="inline small">Away means further than
        <select id="trip-away">
          ${[15, 30, 50, 100, 200].map((k) => `<option value="${k}" ${k === awayKm ? 'selected' : ''}>${k} km</option>`).join('')}
        </select>
      </label>
    </div>
    ${items.length ? `<div class="trip-grid">${items.map((t, i) => card(t, i, home.cc)).join('')}</div>`
      : '<div class="empty muted">No trips yet: every photo is within reach of home.</div>'}`;
}

function card(t, i, homeCc) {
  const flags = t.countries.map((c) => `<span title="${escapeHtml(countryName(c.cc))}: ${fmtNum(c.c)} photos">${flag(c.cc)}</span>`).join('');
  const towns = t.places.map((p) => escapeHtml(p.name)).join(' · ');
  const when = Math.floor(t.start_ts / DAY) === Math.floor(t.end_ts / DAY)
    ? fmtDate(t.start_ts) : `${fmtDate(t.start_ts)} – ${fmtDate(t.end_ts)}`;
  return `<article class="trip" data-i="${i}">
    <div class="trip-cover" data-act="map"><img loading="lazy" src="${thumbUrl(t.cover, 384)}" alt=""></div>
    <div class="trip-body">
      <h4><span class="flags">${flags}</span> <span data-act="rename" title="Rename">${escapeHtml(tripTitle(t, homeCc))}</span></h4>
      <div class="muted small">${when}</div>
      <div class="small">${t.days === 1 ? 'Day trip' : `${fmtNum(t.days)} days`} · ${fmtNum(t.photos)} photos · ${fmtNum(Math.round(t.route_km))} km travelled · ${fmtNum(Math.round(t.far_km))} km from home at the furthest</div>
      ${towns ? `<div class="muted small trip-towns">${towns}</div>` : ''}
      <div class="trip-acts">
        <button class="btn tiny" data-act="map">Map</button>
        <button class="btn tiny" data-act="photos">Photos</button>
        <button class="btn tiny" data-act="replay">Replay</button>
        <button class="btn tiny" data-act="book" title="A printable photo book of this trip, saved as PDF from the print dialog">Book</button>
        <button class="btn tiny ghost" data-act="rename">Rename</button>
      </div>
    </div>
  </article>`;
}

async function onClick(e) {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'home') { homeDialog(); return; }
  const trip = last?.items[Number(e.target.closest('.trip')?.dataset.i)];
  if (!trip) return;
  const { from, to } = span(trip);
  if (act === 'map' || act === 'replay') {
    setFilters({ from, to });
    emit('showMap');
    const [s, w, n, east] = trip.bbox;
    setTimeout(() => {
      if (act === 'replay') el('view-mode').querySelector('[data-view=replay]').click();
      else flyToBounds([[s, w], [n, east]]);
    }, 50);
  } else if (act === 'photos') {
    setFilters({ from, to });
    emit('showView', 'gallery');
  } else if (act === 'book') {
    const q = new URLSearchParams({ from, to, title: tripTitle(trip, last.home.cc) });
    window.open(`book.html?${q}`, '_blank');
  } else if (act === 'rename') {
    renameDialog(trip);
  }
}

function renameDialog(trip) {
  modal(`
    <h3>Name this trip</h3>
    <div class="row"><label>Name</label><input type="text" id="trip-name" maxlength="120" style="flex:1"
      value="${escapeHtml(trip.title)}" placeholder="${escapeHtml(tripTitle({ ...trip, title: '' }, last.home.cc))}"></div>
    <p class="muted small">Leave it empty to go back to the generated name.</p>
    <div class="actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="ok">Save</button></div>`,
  (box, close) => {
    box.querySelector('[data-act=cancel]').onclick = close;
    const save = async () => {
      await guard(api.put(`/api/trips/${trip.key}/title`, { title: box.querySelector('#trip-name').value }), 'Could not rename');
      close();
      render();
    };
    box.querySelector('[data-act=ok]').onclick = save;
    box.querySelector('#trip-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  });
}

/** Trips are measured from home: make one of the saved places home, save the
 *  guessed spot, or pick it on the map. */
export function homeDialog() {
  const saved = state.places || [];
  const guess = last?.home;
  modal(`
    <h3>Where is home?</h3>
    <p class="muted small">Trips are the days with photos further than ${awayKm} km from here.</p>
    ${saved.length ? `<div class="row"><label>Saved place</label><select id="home-pick" style="flex:1">
      ${saved.map((p) => `<option value="${p.id}" ${p.is_home ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
    </select></div>` : ''}
    <div class="actions">
      <button class="btn" data-act="cancel">Cancel</button>
      ${guess?.guessed ? '<button class="btn" data-act="guess">Use the guessed spot</button>' : ''}
      <button class="btn" data-act="pick">Pick on the map</button>
      ${saved.length ? '<button class="btn primary" data-act="ok">Make it home</button>' : ''}
    </div>`, (box, close) => {
    box.querySelector('[data-act=cancel]').onclick = close;
    const done = () => { emit('placesChanged'); toast('Home set'); if (state.view === 'trips') render(); };
    const ok = box.querySelector('[data-act=ok]');
    if (ok) {
      ok.onclick = async () => {
        await guard(api.patch(`/api/places/${box.querySelector('#home-pick').value}`, { is_home: true }), 'Failed');
        close(); done();
      };
    }
    const g = box.querySelector('[data-act=guess]');
    if (g) {
      g.onclick = async () => {
        await guard(api.post('/api/places', { name: 'Home', lat: guess.lat, lon: guess.lon, radius_m: 1000, is_home: true }), 'Failed');
        close(); done();
      };
    }
    box.querySelector('[data-act=pick]').onclick = async () => {
      close();
      emit('showMap');
      const at = await pickLocation();
      if (!at) { toast('Cancelled'); return; }
      await guard(api.post('/api/places', { name: 'Home', lat: at.lat, lon: at.lng, radius_m: 1000, is_home: true }), 'Failed');
      done();
      emit('showView', 'trips');
    };
  });
}
