// One trip in a window of its own: the route on a map, how each leg was
// travelled, and a chart of the days that picks the day to look at. Travel
// modes are chosen here for the whole trip, a day, or a single leg; workouts
// imported from fitness apps fill in distance, time, climb and heart rate.
import { api, guard, thumbUrl } from './api.js';
import { emit, setFilters, fmtNum, fmtDate, countryName, flag, dayColor } from './state.js';
import { toast, escapeHtml } from './ui.js';
import { baseLayer } from './mapview.js';
import { ACCEPT, importActivities, fmtDuration, fmtKm, fmtSpeed } from './fitness.js';

const DAY = 86400;
export const MODES = {
  foot: { label: 'On foot', color: '#3fb950' },
  bike: { label: 'Bike', color: '#f0a020' },
  car: { label: 'Car', color: '#4aa3ff' },
  bus: { label: 'Bus', color: '#a371f7' },
  train: { label: 'Train', color: '#ff7a45' },
  plane: { label: 'Plane', color: '#e5484d' },
  boat: { label: 'Boat', color: '#2bc4c4' },
  '': { label: 'Not set', color: '#8b97a6' },
};
// Speed, climb, moving time and heart rate describe a ride or a hike. On a
// trip by car, train or plane they are noise, so they only show for these.
const SPORTY = new Set(['bike', 'foot']);
const METRICS = {
  km: { label: 'Distance', unit: 'km', of: (d) => d.km },
  photos: { label: 'Photos', unit: '', of: (d) => d.photos },
  walk_km: { label: 'Walked', unit: 'km', of: (d) => d.walk_km },
  act_km: { label: 'Workout km', unit: 'km', of: (d) => d.act_km, sporty: true },
  act_moving_s: { label: 'Moving time', unit: 'h', of: (d) => d.act_moving_s / 3600, sporty: true },
  act_ascent_m: { label: 'Climb', unit: 'm', of: (d) => d.act_ascent_m, sporty: true },
};

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' });
const LONGDAY = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const clock = (ts) => new Date(ts * 1000).toISOString().slice(11, 16);
const modeOptions = (selected, blank) => [
  `<option value="">${escapeHtml(blank)}</option>`,
  ...Object.entries(MODES).filter(([k]) => k).map(([k, m]) => `<option value="${k}" ${k === selected ? 'selected' : ''}>${m.label}</option>`),
].join('');

export async function openTrip(card, awayKm) {
  const panel = document.createElement('div');
  panel.className = 'fullpanel';
  panel.innerHTML = `
    <header class="fp-head">
      <button class="btn" data-act="close">Back to trips</button>
      <div class="tv-title"><h2 data-slot="title"></h2><div class="muted small" data-slot="sub"></div></div>
      <div class="spacer"></div>
      <label class="inline small">Travelled by <select data-act="trip-mode"></select></label>
      <label class="btn tiny" title="GPX, TCX or FIT from Strava, Garmin, Komoot..., Strava's whole export, Apple Health's export.zip, or daily step summaries">Import fitness / watch data…
        <input type="file" data-act="import" multiple accept="${ACCEPT}" hidden></label>
      <button class="btn tiny" data-act="map">Main map</button>
      <button class="btn tiny" data-act="photos">Photos</button>
      <button class="btn tiny" data-act="book">Book</button>
    </header>
    <div class="tv-body">
      <div class="tv-map"></div>
      <div class="tv-side">
        <div class="tv-tiles" data-slot="tiles"></div>
        <div data-slot="modes"></div>
        <div class="tv-chart-head">
          <strong class="small">Day by day</strong>
          <div class="seg" data-slot="metrics"></div>
        </div>
        <div class="tv-chart" data-slot="chart"></div>
        <div class="tv-day" data-slot="day"></div>
      </div>
    </div>`;
  document.body.appendChild(panel);

  const slot = (name) => panel.querySelector(`[data-slot=${name}]`);
  const map = L.map(panel.querySelector('.tv-map'), { zoomControl: true, maxZoom: 19, worldCopyJump: true });
  baseLayer(document.documentElement.dataset.theme === 'light' ? 'streets' : 'dark').addTo(map);
  new ResizeObserver(() => {
    if (!panel.isConnected) return;
    map.invalidateSize();
    if (trip) drawChart();
  }).observe(panel.querySelector('.tv-body'));
  let layers = L.layerGroup().addTo(map);

  let trip = null;
  let selected = null; // a day index, or null for the whole trip
  let metric = 'km';

  async function load() {
    trip = await api.get(`/api/trips/${card.key}`, new URLSearchParams({ away_km: awayKm }));
    const title = card.title || card.generatedTitle;
    slot('title').innerHTML = `<span class="flags">${trip.countries.map((c) => flag(c.cc)).join('')}</span> ${escapeHtml(title)}`;
    const when = Math.floor(trip.start_ts / DAY) === Math.floor(trip.end_ts / DAY)
      ? fmtDate(trip.start_ts) : `${fmtDate(trip.start_ts)} – ${fmtDate(trip.end_ts)}`;
    slot('sub').textContent = `${when} · ${trip.days === 1 ? 'day trip' : `${fmtNum(trip.days)} days`} · ${trip.countries.map((c) => countryName(c.cc)).join(', ')}`;
    panel.querySelector('[data-act=trip-mode]').innerHTML = modeOptions(trip.trip_mode, 'Choose…');
    if (!metrics().includes(metric)) metric = 'km';
    render();
  }

  /** A ride or a hike: chosen as the trip's mode, or, with none chosen, any leg
   *  on foot or by bike (a workout that day makes it one). */
  function sporty() {
    return trip.trip_mode ? SPORTY.has(trip.trip_mode) : trip.legs.some((l) => SPORTY.has(l.mode));
  }

  /** The chart's metrics that mean something for this trip and have data. */
  function metrics() {
    return Object.keys(METRICS).filter((k) => {
      if (METRICS[k].sporty && !sporty()) return false;
      return k === 'km' || k === 'photos' || trip.days_detail.some((d) => METRICS[k].of(d));
    });
  }

  function render() {
    drawTiles();
    drawModes();
    drawChart();
    drawMap();
    drawDay();
  }

  function drawTiles() {
    const acts = trip.activities;
    const sum = (k) => acts.reduce((n, a) => n + (a[k] || 0), 0);
    const moving = sum('moving_s');
    const hr = acts.filter((a) => a.avg_hr);
    const km = trip.legs.reduce((n, l) => n + l.km, 0);
    const tiles = [
      ['Days', fmtNum(trip.days)],
      ['Photos', fmtNum(trip.photos)],
      ['Travelled', `${fmtNum(Math.round(km))} km`],
      ['Furthest from home', `${fmtNum(Math.round(trip.far_km))} km`],
    ];
    const walked = trip.days_detail.reduce((n, d) => n + d.walk_km, 0);
    const steps = trip.days_detail.reduce((n, d) => n + d.steps, 0);
    if (walked || steps) {
      tiles.push(['Walked', `${walked ? `${fmtNum(Math.round(walked * 10) / 10)} km` : ''}${walked && steps ? ' · ' : ''}${steps ? `${fmtNum(steps)} steps` : ''}`]);
    }
    if (acts.length && !sporty()) {
      tiles.push(['Workouts', `${fmtNum(acts.length)} · ${fmtKm(sum('distance_m'))}`]);
    } else if (acts.length) {
      tiles.push(
        ['Workouts', `${fmtNum(acts.length)} · ${fmtKm(sum('distance_m'))}`],
        ['Moving time', fmtDuration(moving)],
        ['Climb', `${fmtNum(Math.round(sum('ascent_m')))} m`],
        ['Average speed', fmtSpeed(moving ? sum('distance_m') / moving : 0) || '–'],
      );
      if (hr.length) tiles.push(['Average heart rate', `${Math.round(hr.reduce((n, a) => n + a.avg_hr, 0) / hr.length)} bpm`]);
    }
    slot('tiles').innerHTML = tiles.map(([k, v]) => `<div class="tv-tile"><span class="muted small">${k}</span><strong>${v}</strong></div>`).join('');
  }

  function drawModes() {
    const entries = Object.entries(trip.km_by_mode).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((n, [, v]) => n + v, 0);
    if (!total) { slot('modes').innerHTML = ''; return; }
    slot('modes').innerHTML = `<div class="tv-modebar">${entries.map(([m, v]) => `<span style="flex:${v};background:${MODES[m]?.color}" title="${MODES[m]?.label}: ${fmtNum(Math.round(v))} km"></span>`).join('')}</div>
      <div class="tv-legend small">${entries.map(([m, v]) => `<span><i style="background:${MODES[m]?.color}"></i>${MODES[m]?.label} ${fmtNum(Math.round(v))} km</span>`).join('')}</div>`;
  }

  function drawChart() {
    slot('metrics').innerHTML = metrics().map((k) => `<button data-metric="${k}" class="${k === metric ? 'active' : ''}">${METRICS[k].label}</button>`).join('');
    const box = slot('chart');
    const W = Math.max(200, box.clientWidth);
    const H = 150;
    const pad = { l: 34, r: 6, t: 8, b: 30 };
    const days = trip.days_detail;
    const m = METRICS[metric];
    const vals = days.map(m.of);
    const max = Math.max(...vals, 0) || 1;
    const bw = (W - pad.l - pad.r) / days.length;
    const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
    const fmt = (v) => (m.unit === 'h' ? fmtDuration(v * 3600) : `${fmtNum(Math.round(v * 10) / 10)}${m.unit ? ` ${m.unit}` : ''}`);
    let svg = `<svg width="${W}" height="${H}" role="img" aria-label="${m.label} per day">`;
    svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}" class="tv-axis"/>`;
    svg += `<text x="${pad.l - 4}" y="${y(max) + 4}" class="tv-tick" text-anchor="end">${escapeHtml(fmt(max).replace(/ (km|m|h)$/, ''))}</text>`;
    days.forEach((d, i) => {
      const x = pad.l + i * bw + bw * 0.12;
      const w = Math.max(1, bw * 0.76);
      const on = selected == null || selected === d.day;
      const label = `${WEEKDAY.format(new Date(d.day * DAY * 1000))} ${new Date(d.day * DAY * 1000).getUTCDate()}`;
      svg += `<g class="tv-bar ${on ? '' : 'dim'} ${selected === d.day ? 'sel' : ''}" data-day="${d.day}">`;
      svg += `<rect x="${pad.l + i * bw}" y="${pad.t}" width="${bw}" height="${H - pad.t - pad.b + 20}" class="tv-hit"/>`;
      if (metric === 'km') {
        let top = y(0);
        for (const [mode, km] of Object.entries(d.km_by_mode).sort()) {
          const h = y(0) - y(km);
          top -= h;
          svg += `<rect x="${x}" y="${top}" width="${w}" height="${Math.max(0, h)}" fill="${MODES[mode]?.color || MODES[''].color}"/>`;
        }
      } else {
        svg += `<rect x="${x}" y="${y(vals[i])}" width="${w}" height="${Math.max(0, y(0) - y(vals[i]))}" class="tv-fill"/>`;
      }
      if (bw > 22 || i % Math.ceil(26 / bw) === 0) {
        svg += `<text x="${pad.l + i * bw + bw / 2}" y="${H - pad.b + 14}" class="tv-tick" text-anchor="middle">${escapeHtml(label)}</text>`;
      }
      svg += `<title>${escapeHtml(LONGDAY.format(new Date(d.day * DAY * 1000)))}: ${escapeHtml(fmt(vals[i]))}${d.towns.length ? ` · ${escapeHtml(d.towns.join(', '))}` : ''}</title></g>`;
    });
    svg += '</svg>';
    box.innerHTML = svg;
  }

  function dayOf(ts) { return Math.floor(ts / DAY); }

  function drawMap() {
    layers.remove();
    layers = L.layerGroup().addTo(map);
    const bounds = [];
    const inDay = (day) => selected == null || day === selected;

    for (const leg of trip.legs) {
      const on = inDay(leg.day);
      const color = MODES[leg.mode]?.color || MODES[''].color;
      const line = L.polyline([leg.from_ll, leg.to_ll], {
        color, weight: on ? 4 : 2, opacity: on ? 0.9 : 0.25,
        dashArray: leg.mode === 'plane' || leg.assumed ? '8 8' : null,
      }).bindTooltip(`${escapeHtml(leg.from || '?')} → ${escapeHtml(leg.to || '?')} · ${fmtNum(Math.round(leg.km))} km · ${MODES[leg.mode]?.label}`);
      layers.addLayer(line);
      if (on && !leg.assumed) bounds.push(leg.from_ll, leg.to_ll);
    }
    for (const a of trip.activities) {
      if (!a.route.length) continue;
      const on = inDay(dayOf(a.local_ts));
      layers.addLayer(L.polyline(a.route, { color: '#ff7a45', weight: on ? 3 : 1.5, opacity: on ? 0.95 : 0.3 })
        .bindTooltip(`${escapeHtml(a.name)} · ${fmtKm(a.distance_m)} · ${fmtDuration(a.moving_s)}`));
      if (on) bounds.push(...a.route);
    }
    const p = trip.points;
    const ids = p.ids;
    for (let i = 0; i < ids.length; i += 1) {
      const on = inDay(dayOf(p.ts[i]));
      const dot = L.circleMarker([p.lat[i], p.lon[i]], {
        radius: on ? 5 : 3, weight: 1, color: '#000', opacity: on ? 0.6 : 0.15,
        fillColor: dayColor(p.ts[i]), fillOpacity: on ? 0.95 : 0.25,
      });
      dot.on('click', () => emit('openPhoto', { id: ids[i], ids }));
      layers.addLayer(dot);
      if (on) bounds.push([p.lat[i], p.lon[i]]);
    }
    if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
    else map.fitBounds([[trip.bbox[0], trip.bbox[1]], [trip.bbox[2], trip.bbox[3]]], { padding: [30, 30] });
  }

  function legRow(leg) {
    const auto = leg.mode_src === 'chosen' ? '' : leg.mode;
    const why = { activity: 'from a workout', trip: 'trip', '': '' }[leg.mode_src] || '';
    return `<div class="tv-leg">
      <span class="tv-dot" style="background:${MODES[leg.mode]?.color}"></span>
      <span class="muted small">${leg.assumed ? 'from/to home' : clock(leg.start_ts)}</span>
      <span class="tv-leg-name">${escapeHtml(leg.from || '?')} → ${escapeHtml(leg.to || '?')}</span>
      <span class="muted small">${fmtNum(Math.round(leg.km))} km</span>
      <select data-leg="${escapeHtml(leg.id)}">${modeOptions(leg.mode_src === 'chosen' ? leg.mode : '',
        `Auto: ${auto ? MODES[auto].label : 'not set'}${why ? ` (${why})` : ''}`)}</select>
    </div>`;
  }

  function actRow(a) {
    const bits = [fmtKm(a.distance_m), fmtDuration(a.moving_s)];
    if (sporty()) {
      bits.push(fmtSpeed(a.avg_speed),
        a.ascent_m ? `${fmtNum(Math.round(a.ascent_m))} m climb` : '',
        a.avg_hr ? `${Math.round(a.avg_hr)} bpm avg${a.max_hr ? `, ${Math.round(a.max_hr)} max` : ''}` : '',
        a.avg_power ? `${Math.round(a.avg_power)} W` : '', a.calories ? `${fmtNum(Math.round(a.calories))} kcal` : '');
    }
    const shown = bits.filter(Boolean);
    return `<div class="tv-act"><strong>${escapeHtml(a.name)}</strong> <span class="muted small">${escapeHtml(a.sport)} · ${clock(a.local_ts)}</span>
      <div class="small">${shown.join(' · ')}</div></div>`;
  }

  /** The places reached, in order, with when and how many photos; a click
   *  centres the map on one. */
  function placesList(list) {
    if (!list.length) return '<p class="muted small">No named places: the photos were taken outside any town.</p>';
    return list.map((v) => {
      const day = new Date(Math.floor(v.first / DAY) * DAY * 1000);
      const when = `${WEEKDAY.format(day)} ${day.getUTCDate()}, ${clock(v.first)}${v.last !== v.first ? `–${clock(v.last)}` : ''}`;
      return `<div class="tv-place" data-lat="${v.lat}" data-lon="${v.lon}" title="Show on the map">
        <span class="tv-dot" style="background:${dayColor(v.first)}"></span>
        <span class="tv-leg-name">${flag(v.cc)} ${escapeHtml(v.name)}</span>
        <span class="muted small">${when} · ${fmtNum(v.photos)} photo${v.photos === 1 ? '' : 's'}</span>
      </div>`;
    }).join('');
  }

  function drawDay() {
    const target = slot('day');
    if (selected == null) {
      target.innerHTML = `
        <h4>Places visited <span class="muted small">${fmtNum(new Set(trip.visited.map((v) => v.name)).size)} places, in order</span></h4>
        ${placesList(trip.visited)}
        <h4>All legs <span class="muted small">pick a day in the chart to look at it on its own</span></h4>
        ${trip.legs.length ? trip.days_detail.map((d) => {
          const legs = trip.legs.filter((l) => l.day === d.day);
          return legs.length ? `<div class="muted small tv-daylabel">${escapeHtml(LONGDAY.format(new Date(d.day * DAY * 1000)))}</div>${legs.map(legRow).join('')}` : '';
        }).join('') : '<p class="muted small">No movement between photos: everything was taken in one place.</p>'}
        ${trip.activities.length ? `<h4>Workouts</h4>${trip.activities.map(actRow).join('')}`
          : `<p class="muted small">No workouts on these days.${sporty() ? ' Import rides or hikes from a fitness app or watch for distance, time, climb and heart rate.' : ''}</p>`}`;
      return;
    }
    const d = trip.days_detail.find((x) => x.day === selected);
    const legs = trip.legs.filter((l) => l.day === d.day);
    const acts = trip.activities.filter((a) => dayOf(a.local_ts) === d.day);
    target.innerHTML = `
      <h4>${escapeHtml(LONGDAY.format(new Date(d.day * DAY * 1000)))}
        <button class="btn tiny ghost" data-act="all-days">Whole trip</button></h4>
      <div class="small">${d.towns.length ? `${escapeHtml(d.towns.join(', '))} · ` : ''}${fmtNum(d.photos)} photos${d.first_ts ? ` between ${clock(d.first_ts)} and ${clock(d.last_ts)}` : ''} · ${fmtNum(Math.round(d.km))} km between them${d.walk_km || d.steps ? ` · walked ${d.walk_km ? `${fmtNum(d.walk_km)} km` : ''}${d.walk_km && d.steps ? ', ' : ''}${d.steps ? `${fmtNum(d.steps)} steps` : ''}` : ''}</div>
      ${d.ids.length ? `<div class="tv-thumbs">${d.ids.slice(0, 30).map((id) => `<img loading="lazy" src="${thumbUrl(id, 256)}" data-photo="${id}" alt="">`).join('')}${d.ids.length > 30 ? `<span class="muted small">+${fmtNum(d.ids.length - 30)}</span>` : ''}</div>` : ''}
      <h4>Places visited</h4>
      ${placesList(trip.visited.filter((v) => dayOf(v.first) === d.day))}
      <h4>Legs ${legs.length > 1 ? `<label class="inline small">All of this day <select data-act="day-mode">${modeOptions('', 'Choose…')}</select></label>` : ''}</h4>
      ${legs.length ? legs.map(legRow).join('') : '<p class="muted small">No movement between photos this day.</p>'}
      ${acts.length ? `<h4>Workouts</h4>${acts.map(actRow).join('')}` : ''}`;
  }

  async function saveModes(body) {
    await guard(api.put(`/api/trips/${card.key}/modes`, body), 'Could not save the travel mode');
    await load();
  }

  function close() {
    document.removeEventListener('keydown', onKey);
    map.remove();
    panel.remove();
  }

  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (!document.getElementById('lightbox').classList.contains('hidden')) return;
    if (!document.getElementById('modal').classList.contains('hidden')) return;
    close();
  }
  document.addEventListener('keydown', onKey);

  panel.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const metricBtn = e.target.closest('[data-metric]');
    const bar = e.target.closest('.tv-bar');
    const photo = e.target.closest('[data-photo]');
    const place = e.target.closest('.tv-place');
    if (place) { map.setView([Number(place.dataset.lat), Number(place.dataset.lon)], 14); return; }
    if (metricBtn) { metric = metricBtn.dataset.metric; drawChart(); return; }
    if (bar) {
      const day = Number(bar.dataset.day);
      selected = selected === day ? null : day;
      drawChart(); drawMap(); drawDay();
      return;
    }
    if (photo) {
      const d = trip.days_detail.find((x) => x.day === selected);
      emit('openPhoto', { id: Number(photo.dataset.photo), ids: d.ids });
      return;
    }
    const from = Math.floor(trip.start_ts / DAY) * DAY;
    const to = Math.floor(trip.end_ts / DAY) * DAY + DAY - 1;
    if (act === 'close') close();
    if (act === 'all-days') { selected = null; drawChart(); drawMap(); drawDay(); }
    if (act === 'map') {
      close();
      setFilters({ from, to });
      emit('showMap');
    }
    if (act === 'photos') {
      close();
      setFilters({ from, to });
      emit('showView', 'gallery');
    }
    if (act === 'book') {
      window.open(`book.html?${new URLSearchParams({ from, to, title: card.title || card.generatedTitle })}`, '_blank');
    }
  });

  panel.addEventListener('change', async (e) => {
    if (e.target.dataset.act === 'trip-mode') await saveModes({ trip: e.target.value });
    else if (e.target.dataset.leg) await saveModes({ legs: { [e.target.dataset.leg]: e.target.value } });
    else if (e.target.dataset.act === 'day-mode' && e.target.value) {
      const legs = Object.fromEntries(trip.legs.filter((l) => l.day === selected).map((l) => [l.id, e.target.value]));
      await saveModes({ legs });
    } else if (e.target.dataset.act === 'import') {
      const added = await importActivities([...e.target.files]);
      e.target.value = '';
      if (added) await load();
    }
  });

  try {
    await load();
  } catch (err) {
    toast(`Could not open the trip: ${err.message}`, true);
    close();
  }
}
