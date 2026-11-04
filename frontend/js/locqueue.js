// Photos without a location, one at a time: the photo on the left, a search box
// and a map on the right. Confirming saves the position and the next photo
// comes up on its own, so a pile of camera shots is a run of
// look-search-Enter rather than a selection exercise.
import { api, guard, previewUrl } from './api.js';
import { params, emit, fmtNum, fmtDateTime } from './state.js';
import { toast, escapeHtml } from './ui.js';
import { locationPicker } from './locpick.js';

const gap = (s) => {
  const total = Math.round(s / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
};

export async function openLocationQueue() {
  const { ids } = await api.get('/api/photos/ids', params({ extra: { gps: 'no', sort: 'date_asc', limit: 20000 } }));
  if (!ids.length) { toast('Every photo here has a location'); return; }

  const panel = document.createElement('div');
  panel.className = 'fullpanel';
  panel.innerHTML = `
    <header class="fp-head">
      <button class="btn" data-act="close">Close</button>
      <strong>Place photos without a location</strong>
      <span class="muted" data-slot="count"></span>
      <div class="spacer"></div>
      <span class="muted small">Enter confirms · → skips · ← goes back · Esc closes</span>
    </header>
    <div class="lq-body">
      <div class="lq-photo">
        <img alt="">
        <div class="lq-meta small" data-slot="meta"></div>
      </div>
      <div class="lq-side">
        <div class="lq-chips" data-slot="chips"></div>
        <div class="lq-picker"></div>
        <div class="lq-acts">
          <button class="btn" data-act="back">Back</button>
          <button class="btn" data-act="skip">Skip</button>
          <div class="spacer"></div>
          <button class="btn primary" data-act="ok" disabled>Confirm and next</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(panel);

  const slot = (name) => panel.querySelector(`[data-slot=${name}]`);
  const ok = panel.querySelector('[data-act=ok]');
  const picker = locationPicker(panel.querySelector('.lq-picker'), {
    onChange: (at) => { ok.disabled = !at; },
    onEnter: () => confirm(),
  });

  let index = 0;
  let placed = 0;
  let last = null; // the previous confirmed position, offered for the next photo
  let suggestions = {};
  let busy = false;

  async function show() {
    if (index >= ids.length) { finish(); return; }
    const id = ids[index];
    slot('count').textContent = `${fmtNum(index + 1)} of ${fmtNum(ids.length)} · ${fmtNum(placed)} placed`;
    panel.querySelector('.lq-photo img').src = previewUrl(id);
    const photo = await api.get(`/api/photos/${id}`);
    if (ids[index] !== id) return;
    const camera = [photo.camera_make, photo.camera_model].filter(Boolean).join(' ');
    slot('meta').innerHTML = `<strong>${fmtDateTime(photo.taken_ts)}</strong> · ${escapeHtml(photo.filename)}${camera ? ` · ${escapeHtml(camera)}` : ''}
      <div class="muted">${escapeHtml(photo.folder)}</div>`;
    suggestions = {};
    try {
      suggestions = await api.get(`/api/photos/${id}/location-suggestions`);
    } catch { /* no capture time: nothing near it in time to offer */ }
    if (ids[index] !== id) return;
    const chips = [];
    if (last) chips.push(`<button class="btn tiny" data-chip="last">Same as last: ${escapeHtml(last.label || `${last.lat.toFixed(4)}, ${last.lon.toFixed(4)}`)}</button>`);
    if (suggestions.before) chips.push(`<button class="btn tiny" data-chip="before">Photo ${gap(suggestions.before.gap)} before</button>`);
    if (suggestions.after) chips.push(`<button class="btn tiny" data-chip="after">Photo ${gap(suggestions.after.gap)} after</button>`);
    slot('chips').innerHTML = chips.length ? `<span class="muted small">Suggestions:</span> ${chips.join('')}` : '';
    // Start where the answer most likely is, without choosing it for them.
    const near = suggestions.before || suggestions.after || last;
    picker.clear(near ? { lat: near.lat, lon: near.lon, zoom: 12 } : null);
    ok.disabled = true;
    picker.focus();
  }

  async function confirm() {
    const at = picker.get();
    if (!at || busy) return;
    busy = true;
    try {
      await guard(api.post(`/api/photos/${ids[index]}/location`, { lat: at.lat, lon: at.lon, method: at.method }), 'Could not save the location');
      placed += 1;
      last = { lat: at.lat, lon: at.lon, label: at.label };
      index += 1;
      await show();
    } finally {
      busy = false;
    }
  }

  function finish() {
    toast(`${fmtNum(placed)} photo${placed === 1 ? '' : 's'} placed`);
    close();
  }

  function close() {
    document.removeEventListener('keydown', onKey);
    picker.destroy();
    panel.remove();
    if (placed) { emit('dataChanged'); emit('filters'); }
  }

  function onKey(e) {
    if (!document.getElementById('modal').classList.contains('hidden')) return;
    const typing = e.target.matches('input, select, textarea');
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (typing) return;
    if (e.key === 'Enter') { e.preventDefault(); confirm(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); index += 1; show(); }
    if (e.key === 'ArrowLeft' && index > 0) { e.preventDefault(); index -= 1; show(); }
  }
  document.addEventListener('keydown', onKey);

  panel.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const chip = e.target.closest('[data-chip]')?.dataset.chip;
    if (act === 'close') close();
    if (act === 'ok') confirm();
    if (act === 'skip') { index += 1; show(); }
    if (act === 'back' && index > 0) { index -= 1; show(); }
    if (chip === 'last') picker.set(last.lat, last.lon, { label: last.label });
    if (chip === 'before' || chip === 'after') {
      const s = suggestions[chip];
      picker.set(s.lat, s.lon, { method: 'NEIGHBOUR', zoom: 14 });
    }
  });

  show();
}
