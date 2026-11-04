// Trips: runs of days away from home, worked out by the server from the photos
// each time this view is opened, so a fix or a GPX import shows up at once.
import { api, guard, thumbUrl } from './api.js';
import { state, on, emit, setFilters, fmtNum, fmtDate, countryName, flag } from './state.js';
import { el, modal, toast, escapeHtml } from './ui.js';
import { flyToBounds } from './mapview.js';
import { locationPicker } from './locpick.js';
import { openTrip } from './tripview.js';

const DAY = 86400;
let awayKm = (() => {
  try { return Number(localStorage.getItem('pm-trip-away')) || 50; } catch { return 50; }
})();
let last = null;
let prompted = false;

export function initTrips() {
  on('tripsShown', render);
  on('dataChanged', () => { if (state.view === 'trips') render(); });
  // New photos are when a home timeline matters most: without one, the first
  // look at Trips measures everything from a single guessed home.
  on('scanFinished', async () => {
    if (prompted) return;
    const res = await api.get('/api/home-timeline');
    if (res.configured || !res.suggested.length) return;
    prompted = true;
    homeTimelineDialog('New photos are in. Trips are told apart from home, so check where you lived and when.');
  });
  on('tripChanged', () => { if (state.view === 'trips') render(); });
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
  const moved = res.timeline_set && res.timeline.length > 1;
  const homeName = home.guessed ? (home.place || `${home.lat.toFixed(3)}, ${home.lon.toFixed(3)}`) : home.name;

  target.innerHTML = `
    <div class="trips-head">
      <div>
        <strong>${fmtNum(items.length)} trip${items.length === 1 ? '' : 's'}</strong>
        <span class="muted">· ${fmtNum(days)} days away · ${fmtNum(countries.size)} countr${countries.size === 1 ? 'y' : 'ies'}</span>
      </div>
      <div class="spacer"></div>
      <span class="muted small">Home${moved ? ' now' : ''}: <strong>${escapeHtml(homeName)}</strong>${home.guessed ? ' (guessed: the place with photos on the most days)' : ''}${moved ? ` · ${res.timeline.length} homes over time` : ''}</span>
      <button class="btn tiny" data-act="home">Home timeline…</button>
      <label class="inline small">Away means further than
        <select id="trip-away">
          ${[15, 30, 50, 100, 200].map((k) => `<option value="${k}" ${k === awayKm ? 'selected' : ''}>${k} km</option>`).join('')}
        </select>
      </label>
    </div>
    ${res.timeline_set ? '' : `<div class="banner">Trips are measured from one home${home.guessed ? ' guessed from your photos' : ''}.
      If you have moved, set where you lived and when, so the old home is not counted as a trip.
      <button class="btn tiny primary" data-act="home">Set home timeline…</button></div>`}
    ${items.length ? `<div class="trip-grid">${items.map((t, i) => card(t, i, home.cc)).join('')}</div>`
      : '<div class="empty muted">No trips yet: every photo is within reach of home.</div>'}`;
}

function card(t, i, homeCc) {
  const flags = t.countries.map((c) => `<span title="${escapeHtml(countryName(c.cc))}: ${fmtNum(c.c)} photos">${flag(c.cc)}</span>`).join('');
  const towns = t.places.map((p) => escapeHtml(p.name)).join(' · ');
  const when = Math.floor(t.start_ts / DAY) === Math.floor(t.end_ts / DAY)
    ? fmtDate(t.start_ts) : `${fmtDate(t.start_ts)} – ${fmtDate(t.end_ts)}`;
  return `<article class="trip" data-i="${i}">
    <div class="trip-cover" data-act="open" title="Open the trip"><img loading="lazy" src="${thumbUrl(t.cover, 384)}" alt=""></div>
    <div class="trip-body">
      <h4><span class="flags">${flags}</span> <span data-act="rename" title="Rename">${escapeHtml(tripTitle(t, homeCc))}</span></h4>
      <div class="muted small">${when}</div>
      <div class="small">${t.days === 1 ? 'Day trip' : `${fmtNum(t.days)} days`} · ${fmtNum(t.photos)} photos · ${fmtNum(Math.round(t.route_km))} km travelled · ${fmtNum(Math.round(t.far_km))} km from home at the furthest</div>
      ${towns ? `<div class="muted small trip-towns">${towns}</div>` : ''}
      <div class="trip-acts">
        <button class="btn tiny primary" data-act="open">Open</button>
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
  if (act === 'home') { homeTimelineDialog(); return; }
  const trip = last?.items[Number(e.target.closest('.trip')?.dataset.i)];
  if (!trip) return;
  if (act === 'open') { openTrip({ ...trip, generatedTitle: tripTitle({ ...trip, title: '' }, last.home.cc) }, awayKm); return; }
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

/** Where home was, over time: the first row covers everything before the
 *  second, each later row starts on its date. All rows are edited on one map. */
export async function homeTimelineDialog(intro = '') {
  const res = await guard(api.get('/api/home-timeline'), 'Could not load the home timeline');
  let rows = (res.configured ? res.items : res.suggested).map((r) => ({ ...r }));
  if (!rows.length && last?.home) {
    rows = [{ since: '', name: last.home.name || 'Home', lat: last.home.lat, lon: last.home.lon }];
  }
  if (!rows.length) rows = [{ since: '', name: 'Home', lat: null, lon: null }];
  let active = 0;
  let picker = null;
  const today = new Date().toISOString().slice(0, 10);

  modal(`<div class="home-tl">
    <h3>Where you lived</h3>
    ${intro ? `<p class="small">${escapeHtml(intro)}</p>` : ''}
    <p class="muted small">Trips are the days spent further than ${awayKm} km from the home of that date.
      Add a row for each move; the first home also covers everything before the second.
      ${res.configured ? '' : 'These are suggested from your photos: the spot photographed on the most days each year. Check them.'}</p>
    <div class="htl-rows"></div>
    <button class="btn tiny" data-act="add">+ Add a move</button>
    <p class="muted small" style="margin:10px 0 4px">Choose a row, then search for the place or click the map.</p>
    <div class="htl-picker"></div>
    <p class="small err-text" data-slot="err"></p>
    <div class="actions"><button class="btn" data-act="cancel">Later</button><button class="btn primary" data-act="ok">Save</button></div>
  </div>`, (box, close) => {
    const list = box.querySelector('.htl-rows');
    const done = () => { picker?.destroy(); close(); };
    const draw = () => {
      list.innerHTML = rows.map((r, i) => `<div class="htl-row ${i === active ? 'active' : ''}" data-i="${i}">
        ${i === 0 ? '<span class="htl-since muted small">From the start</span>'
          : `<input type="date" class="htl-since" value="${escapeHtml(r.since)}" max="${today}">`}
        <input type="text" class="htl-name" value="${escapeHtml(r.name)}" placeholder="Name, e.g. the Galway flat">
        <span class="muted small htl-at">${r.lat == null ? 'not set' : `${r.lat.toFixed(3)}, ${r.lon.toFixed(3)}`}</span>
        ${rows.length > 1 ? '<button class="icon-btn" data-act="del" title="Remove">✕</button>' : '<span></span>'}
      </div>`).join('');
    };
    const focusRow = (i) => {
      active = i;
      list.querySelectorAll('.htl-row').forEach((row) => row.classList.toggle('active', Number(row.dataset.i) === i));
      const r = rows[i];
      if (r.lat != null) picker.set(r.lat, r.lon, { label: r.name, zoom: 12 });
      else picker.clear();
    };
    draw();
    picker = locationPicker(box.querySelector('.htl-picker'), {
      onChange: (at) => {
        if (!at) return;
        const r = rows[active];
        r.lat = at.lat;
        r.lon = at.lon;
        if (!r.name && at.label) r.name = at.label;
        const row = list.querySelector(`[data-i="${active}"]`);
        row.querySelector('.htl-at').textContent = `${at.lat.toFixed(3)}, ${at.lon.toFixed(3)}`;
        if (!row.querySelector('.htl-name').value && r.name) row.querySelector('.htl-name').value = r.name;
      },
    });
    setTimeout(() => focusRow(0), 0);
    list.addEventListener('focusin', (e) => {
      const i = Number(e.target.closest('.htl-row')?.dataset.i);
      if (Number.isInteger(i) && i !== active) focusRow(i);
    });
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.htl-row');
      if (!row) return;
      const i = Number(row.dataset.i);
      if (e.target.dataset.act === 'del') {
        rows.splice(i, 1);
        active = Math.min(active, rows.length - 1);
        draw();
        focusRow(active);
      } else if (i !== active) {
        focusRow(i);
      }
    });
    list.addEventListener('input', (e) => {
      const r = rows[Number(e.target.closest('.htl-row').dataset.i)];
      if (e.target.classList.contains('htl-name')) r.name = e.target.value;
      if (e.target.classList.contains('htl-since')) r.since = e.target.value;
    });
    box.querySelector('[data-act=add]').onclick = () => {
      rows.push({ since: today, name: '', lat: null, lon: null });
      draw();
      focusRow(rows.length - 1);
    };
    box.querySelector('[data-act=cancel]').onclick = done;
    box.querySelector('[data-act=ok]').onclick = async () => {
      const err = (m) => { box.querySelector('[data-slot=err]').textContent = m; };
      if (rows.some((r) => r.lat == null)) { err('Every home needs a place: choose its row, then search or click the map.'); return; }
      if (rows.slice(1).some((r) => !r.since)) { err('Every move needs the date it happened.'); return; }
      const [first, ...moves] = rows;
      moves.sort((a, b) => a.since.localeCompare(b.since));
      try {
        await api.put('/api/home-timeline', { items: [{ ...first, since: '1900-01-01' }, ...moves] });
      } catch (e) {
        err(e.message);
        return;
      }
      done();
      toast('Home timeline saved');
      emit('tripChanged');
    };
  });
}
