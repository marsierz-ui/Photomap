// Workouts from fitness apps and watches (Strava, Garmin, Komoot, Wahoo, Apple
// Watch...) and daily step totals: importing them, listing them in Settings,
// and the stat formatting the trip panel shares.
import { api, guard } from './api.js';
import { emit, fmtNum, fmtDate } from './state.js';
import { toast, confirmModal, escapeHtml } from './ui.js';

export const ACCEPT = '.gpx,.tcx,.fit,.gz,.zip,.csv,.json';

export function fmtDuration(s) {
  if (!s) return '0 min';
  const total = Math.round(s / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

export const fmtKm = (m) => `${fmtNum(Math.round((m || 0) / 100) / 10)} km`;
export const fmtSpeed = (mps) => (mps ? `${(mps * 3.6).toFixed(1)} km/h` : '');

/** Upload each file; returns how many workouts and days were added. */
export async function importActivities(files) {
  let added = 0;
  for (const file of files) {
    toast(`Reading ${file.name}…`);
    try {
      const res = await fetch(`/api/activities/import?name=${encodeURIComponent(file.name)}`, {
        method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || res.statusText);
      added += body.items.length + body.days;
      const parts = [`${fmtNum(body.items.length)} workout${body.items.length === 1 ? '' : 's'} added`];
      if (body.duplicates) parts.push(`${fmtNum(body.duplicates)} already here`);
      if (body.days) parts.push(`steps and distance for ${fmtNum(body.days)} days`);
      toast(`${file.name}: ${parts.join(', ')}`);
    } catch (err) {
      toast(`${file.name}: ${err.message}`, true);
    }
  }
  if (added) { emit('tracksChanged'); emit('activitiesChanged'); }
  return added;
}

/** The Fitness activities section of the settings dialog. */
export function activitiesBlock() {
  return `<div class="muted small" style="margin:14px 0 6px">Fitness and watch data
    <span style="opacity:.8">- rides, runs and walks from Strava, Garmin, Komoot or any app that exports GPX, TCX or FIT
    (Strava's whole export .zip works), and from a watch: Apple Health's export.zip (Health app, your picture, Export All
    Health Data) brings Apple Watch workouts with their routes plus steps and walking distance per day; Google Fit's
    "Daily activity metrics.csv" and Garmin's daily summary files bring steps and distance too. They show up on the trips
    they belong to.</span></div>
    <div id="s-daily" class="small muted"></div>
    <div id="s-acts" class="small"></div>
    <div class="actions" style="justify-content:flex-start;margin:6px 0 0">
      <label class="btn tiny">Import…<input type="file" id="s-act-file" multiple accept="${ACCEPT}" hidden></label>
    </div>`;
}

export function wireActivities(box) {
  const slot = box.querySelector('#s-acts');
  const render = async () => {
    const { items, daily } = await api.get('/api/activities');
    if (!slot.isConnected) return;
    box.querySelector('#s-daily').innerHTML = daily.days
      ? `Steps and distance for ${fmtNum(daily.days)} days, ${escapeHtml(daily.first)} to ${escapeHtml(daily.last)}
        <button class="btn tiny ghost" data-act="clear-daily">Remove</button>` : '';
    slot.innerHTML = items.length ? items.slice(0, 200).map((a) => `<div class="track-row">
        <span class="name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>
        <span class="muted">${fmtDate(a.local_ts)} · ${escapeHtml(a.sport)} · ${fmtKm(a.distance_m)} · ${fmtDuration(a.moving_s)}</span>
        <button class="icon-btn" data-del="${a.id}" title="Remove this activity">✕</button>
      </div>`).join('') + (items.length > 200 ? `<div class="muted">and ${fmtNum(items.length - 200)} more</div>` : '')
      : '<span class="muted">None imported yet</span>';
  };
  render();
  box.querySelector('#s-daily').addEventListener('click', async (e) => {
    if (e.target.dataset.act !== 'clear-daily') return;
    if (!await confirmModal('Remove daily totals', 'Steps and walking distance for every day go. Workouts stay.', 'Remove')) return;
    await guard(api.del('/api/activities/daily'), 'Failed');
    emit('openSettings');
  });
  slot.addEventListener('click', async (e) => {
    const id = e.target.dataset.del;
    if (!id) return;
    if (!await confirmModal('Remove activity', 'Its track goes too. Photos already placed from it keep their position.', 'Remove')) return;
    await guard(api.del(`/api/activities/${id}`), 'Failed');
    emit('tracksChanged');
    emit('openSettings');
  });
  box.querySelector('#s-act-file').addEventListener('change', async (e) => {
    await importActivities([...e.target.files]);
    e.target.value = '';
    render();
  });
}
