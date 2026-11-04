// GPX files and Google Timeline exports: importing them, drawing them, and
// placing photos from a camera without GPS by matching capture times to them.
import { api, guard } from './api.js';
import { state, on, emit, fmtNum, fmtDate } from './state.js';
import { el, modal, toast, confirmModal, escapeHtml } from './ui.js';
import { leafletMap } from './mapview.js';

let layer = null;
let shown = false;
// A break in the log longer than this is not drawn as a straight line across it.
const GAP_S = 2 * 3600;

export function initTracks() {
  el('map-tracks').addEventListener('click', (e) => {
    shown = !shown;
    e.currentTarget.classList.toggle('active', shown);
    draw();
  });
  on('filters', () => { if (shown) draw(); });
  on('tracksChanged', () => { if (shown) draw(); });
}

async function draw() {
  const map = leafletMap();
  if (layer) { map.removeLayer(layer); layer = null; }
  if (!shown) return;
  const p = new URLSearchParams();
  if (state.filters.from != null) p.set('from', state.filters.from);
  if (state.filters.to != null) p.set('to', state.filters.to);
  const res = await api.get('/api/tracks/points', p);
  if (!res.n) {
    toast('No GPS tracks here. Import GPX files or a Google Timeline export in Settings.');
    return;
  }
  const lines = [];
  let line = [];
  for (let i = 0; i < res.n; i += 1) {
    if (i && res.ts[i] - res.ts[i - 1] > GAP_S) { if (line.length > 1) lines.push(line); line = []; }
    line.push([res.lat[i], res.lon[i]]);
  }
  if (line.length > 1) lines.push(line);
  layer = L.layerGroup([
    L.polyline(lines, { color: '#ff7a45', weight: 3, opacity: 0.85, interactive: false }),
  ]).addTo(map);
  if (res.total > res.n) toast(`Track thinned to ${fmtNum(res.n)} of ${fmtNum(res.total)} points; narrow the dates for more detail`);
}

// ------------------------------------------------------------------ settings

/** The Tracks section of the settings dialog. */
export function tracksBlock() {
  return `<div class="muted small" style="margin:14px 0 6px">GPS tracks
    <span style="opacity:.8">- GPX files, or Google Timeline / Takeout Location History (.json or the whole .zip).
    They place photos from cameras without GPS, and draw your route.</span></div>
    <div id="s-tracks" class="small"></div>
    <div class="actions" style="justify-content:flex-start;margin:6px 0 0">
      <label class="btn tiny">Import…<input type="file" id="s-track-file" multiple accept=".gpx,.json,.zip" hidden></label>
      <button class="btn tiny" data-act="geotag">Place photos from tracks…</button>
      <a class="btn tiny" href="/api/export/tracks.gpx" download>Export all as GPX</a>
    </div>`;
}

export async function wireTracks(box) {
  const slot = box.querySelector('#s-tracks');
  const render = async () => {
    const { items } = await api.get('/api/tracks');
    if (!slot.isConnected) return;
    slot.innerHTML = items.length ? items.map((t) => `<div class="track-row">
        <span class="name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>
        <span class="muted">${fmtDate(t.first_ts)} – ${fmtDate(t.last_ts)} · ${fmtNum(t.points)} points</span>
        <a class="icon-btn" href="/api/export/tracks.gpx?track=${t.id}" download title="Download as GPX">⇩</a>
        <button class="icon-btn" data-del="${t.id}" title="Remove this track">✕</button>
      </div>`).join('') : '<span class="muted">None imported yet</span>';
  };
  render();
  slot.addEventListener('click', async (e) => {
    const id = e.target.dataset.del;
    if (!id) return;
    if (!await confirmModal('Remove track', 'Photos already placed from it keep their position (Undo location changes puts them back).', 'Remove')) {
      return;
    }
    await guard(api.del(`/api/tracks/${id}`), 'Failed');
    emit('tracksChanged');
    // confirmModal replaced the settings dialog; bring it back.
    emit('openSettings');
  });
  box.querySelector('#s-track-file').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    for (const file of files) {
      toast(`Reading ${file.name}…`);
      try {
        const res = await fetch(`/api/tracks/import?name=${encodeURIComponent(file.name)}`, {
          method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' },
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.detail || res.statusText);
        const n = body.items.reduce((s, t) => s + t.points, 0);
        toast(`${file.name}: ${fmtNum(n)} positions imported`);
      } catch (err) {
        toast(`${file.name}: ${err.message}`, true);
      }
    }
    e.target.value = '';
    render();
    emit('tracksChanged');
  });
  box.querySelector('[data-act=geotag]').onclick = () => geotagDialog();
}

const hours = (s) => {
  const sign = s < 0 ? '−' : '+';
  const a = Math.abs(s);
  return `UTC${sign}${Math.floor(a / 3600)}${a % 3600 ? `:${String((a % 3600) / 60).padStart(2, '0')}` : ''}`;
};

/** Place photos from the imported tracks. `ids` limits it to a selection. */
export async function geotagDialog(ids = null) {
  const { items } = await api.get('/api/tracks');
  if (!items.length) {
    toast('Import a GPX file or a Google Timeline export first (Settings → GPS tracks)', true);
    return;
  }
  const est = await api.get('/api/tracks/offset');
  modal(`
    <h3>Place photos from GPS tracks</h3>
    <p class="small">Each photo without a location is put where the track says you were when it was taken.
      Cameras keep local time and tracks keep UTC, so the two need lining up.</p>
    <div class="row"><label>Camera clock</label>
      <select id="gt-mode" style="flex:1">
        <option value="auto">This computer's time zone on each photo's date (summer time included)</option>
        ${est.offset_s != null ? `<option value="${est.offset_s}" selected>${hours(est.offset_s)}: lines up ${fmtNum(est.matches)} of ${fmtNum(est.tested)} photos that have GPS</option>` : ''}
        <option value="custom">Another offset…</option>
      </select></div>
    ${est.offset_s == null ? `<p class="muted small">Could not work the offset out: that needs a few phone photos
      (with GPS) taken while the track was recording. If the camera was set to the local time of the trip, choose
      Another offset and enter that time zone, then check the count below.</p>` : ''}
    <div class="row hidden" id="gt-custom-row"><label>Offset</label>
      <input type="number" id="gt-h" step="0.25" value="${(est.local_offset_s / 3600).toFixed(2)}" style="width:80px"> hours ahead of UTC,
      <input type="number" id="gt-m" step="1" value="0" style="width:70px"> minutes of camera clock error</div>
    <div class="row"><label>Largest gap</label>
      <select id="gt-gap"><option value="5">5 minutes</option><option value="15">15 minutes</option><option value="30" selected>30 minutes</option><option value="120">2 hours</option></select></div>
    <label class="check"><input type="checkbox" id="gt-approx"> Also replace approximate (cell-tower) positions</label>
    <p class="small" id="gt-preview" style="min-height:1.4em"></p>
    <div class="actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="ok" disabled>Place photos</button>
    </div>`, (box, close) => {
    const mode = box.querySelector('#gt-mode');
    const offset = () => {
      if (mode.value === 'auto') return 'auto';
      if (mode.value === 'custom') {
        return Math.round(Number(box.querySelector('#gt-h').value) * 3600 + Number(box.querySelector('#gt-m').value) * 60);
      }
      return Number(mode.value);
    };
    const body = (dry) => ({
      offset_s: offset(), gap_min: Number(box.querySelector('#gt-gap').value),
      include_approx: box.querySelector('#gt-approx').checked, ids, dry_run: dry,
    });
    const ok = box.querySelector('[data-act=ok]');
    const preview = async () => {
      box.querySelector('#gt-custom-row').classList.toggle('hidden', mode.value !== 'custom');
      const res = await api.post('/api/tracks/geotag', body(true));
      box.querySelector('#gt-preview').textContent = res.candidates
        ? `${fmtNum(res.placed)} of ${fmtNum(res.candidates)} photos in the tracks' time span can be placed.`
        : 'No photos without a location were taken while the tracks were recording.';
      ok.disabled = !res.placed;
      ok.textContent = res.placed ? `Place ${fmtNum(res.placed)} photos` : 'Place photos';
    };
    box.querySelectorAll('select, input').forEach((i) => i.addEventListener('change', preview));
    preview();
    box.querySelector('[data-act=cancel]').onclick = close;
    ok.onclick = async () => {
      const res = await guard(api.post('/api/tracks/geotag', body(false)), 'Placing failed');
      close();
      toast(`${fmtNum(res.placed)} photos placed from tracks. Filter "From a GPS track" lists them; Undo location changes reverts.`);
      emit('dataChanged');
      emit('filters');
    };
  });
}
