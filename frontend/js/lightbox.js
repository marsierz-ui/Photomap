import { api, previewUrl } from './api.js';
import { state, on, emit, fmtDateTime, fmtBytes, fmtNum } from './state.js';
import { el, escapeHtml, toast } from './ui.js';
import { setFavorite, deleteDialog } from './actions.js';
import { isVideo, isApprox, clock } from './gallery.js';
import { flyToPhoto, pickLocation } from './mapview.js';

const box = el('lightbox');
const img = el('lb-img');
const player = el('lb-video');
const info = el('lb-info');

/** Stop whatever is playing and let go of the file.
 *
 *  Clearing the source matters as much as pausing: a paused <video> with a src
 *  still holds an open connection to the range endpoint, so stepping through a
 *  folder of clips would leave one per photo behind it. */
function stopPlayer() {
  if (!player.getAttribute('src')) return;
  player.pause();
  player.removeAttribute('src');
  player.load();
}

let ids = [];
let index = 0;
let current = null;
let relocated = false;   // a position changed, so the views behind need redrawing

export function initLightbox() {
  on('openPhoto', ({ id, ids: list }) => open(id, list));

  box.addEventListener('click', (e) => {
    const act = e.target.dataset.lb;
    if (act === 'close' || e.target === box) close();
    if (act === 'prev') step(-1);
    if (act === 'next') step(1);
  });

  // Swipe left/right to move through photos on a touch screen.
  let swipe = null;
  box.addEventListener('pointerdown', (e) => {
    swipe = e.pointerType === 'mouse' ? null : { x: e.clientX, y: e.clientY };
  });
  box.addEventListener('pointerup', (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.6) step(dx < 0 ? 1 : -1);
  });

  info.addEventListener('click', async (e) => {
    const act = e.target.dataset.act;
    if (!act || !current) return;
    if (act === 'fav') {
      await setFavorite([current.id], !current.favorite);
      show();
    } else if (act === 'map') {
      if (current.lat == null) { toast('This photo has no GPS data'); return; }
      close();
      emit('showMap');
      flyToPhoto(current.lat, current.lon);
    } else if (act === 'fixloc') {
      showSuggestions();
    } else if (act === 'usesug') {
      saveLocation(Number(e.target.dataset.lat), Number(e.target.dataset.lon));
    } else if (act === 'pickloc') {
      const photo = current;
      close();
      emit('showMap');
      const at = await pickLocation();
      emit('openPhoto', { id: photo.id, ids });
      if (at) saveLocation(at.lat, at.lng, photo.id);
    } else if (act === 'reveal') {
      await api.post(`/api/photos/${current.id}/reveal`);
    } else if (act === 'delete') {
      const victim = current.id;
      deleteDialog([victim], () => {
        ids = ids.filter((i) => i !== victim);
        if (!ids.length) { close(); return; }
        index = Math.min(index, ids.length - 1);
        show();
      });
    }
  });

  // Blur commits the note, which covers clicking away, tabbing out and closing
  // the lightbox with the mouse. Ctrl+Enter is the explicit version.
  info.addEventListener('focusout', (e) => {
    if (e.target.id === 'lb-note') saveNote();
  });
  info.addEventListener('keydown', (e) => {
    if (e.target.id === 'lb-note' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.target.blur();
  });

  document.addEventListener('keydown', (e) => {
    if (box.classList.contains('hidden')) return;
    // Typing a note must not trip the single-key shortcuts below.
    if (e.target.matches('input, textarea')) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
    if (e.key.toLowerCase() === 'f' && current) setFavorite([current.id], !current.favorite).then(show);
    if (e.key === 'Delete' && current) {
      const victim = current.id;
      deleteDialog([victim], () => {
        ids = ids.filter((i) => i !== victim);
        if (!ids.length) close(); else { index = Math.min(index, ids.length - 1); show(); }
      });
    }
  });
}

function open(id, list) {
  ids = list && list.length ? list : [id];
  index = Math.max(0, ids.indexOf(id));
  box.classList.remove('hidden');
  show();
}

function close() {
  saveNote();
  if (relocated) { relocated = false; emit('filters'); }
  box.classList.add('hidden');
  img.removeAttribute('src');
  stopPlayer();
  current = null;
}

function step(delta) {
  if (!ids.length) return;
  saveNote();
  index = (index + delta + ids.length) % ids.length;
  show();
}

/** Write the note back if it changed. Deliberately not awaited: the photo the
 *  edit belongs to is captured here, so moving on immediately is safe. */
function saveNote() {
  const field = el('lb-note');
  if (!field || !current) return;
  const value = field.value.trim();
  const photo = current;
  if (value === (photo.note || '')) return;
  photo.note = value;
  api.post(`/api/photos/${photo.id}/note`, { note: value })
    .then(() => toast(value ? 'Note saved' : 'Note cleared'))
    .catch((err) => toast(`Could not save the note: ${err.message}`, true));
}

const gapText = (s) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min`
  : `${(s / 3600).toFixed(1)} h`);

/** Offer the position of the nearest photos in time that have a real GPS fix. */
async function showSuggestions() {
  const slot = el('lb-suggest');
  slot.innerHTML = '<span class="muted">Looking at the photos either side…</span>';
  let found;
  try {
    found = await api.get(`/api/photos/${current.id}/location-suggestions`);
  } catch (err) {
    // Said rather than left as "Looking...": a server that predates this route
    // answers 404, and the fix is to restart it, which nobody can guess from a
    // message that never changes.
    slot.innerHTML = `<span class="muted">Could not look: ${escapeHtml(err.message)}. `
      + 'If the app was started before this update, restart it.</span>'
      + ' <button data-act="pickloc">Pick on the map</button>';
    return;
  }
  const options = [['before', 'earlier'], ['after', 'later']]
    .filter(([key]) => found[key])
    .map(([key, label]) => {
      const s = found[key];
      return `<button data-act="usesug" data-lat="${s.lat}" data-lon="${s.lon}">
        Use the photo taken ${gapText(s.gap)} ${label} · ${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}</button>`;
    });
  slot.innerHTML = (options.length ? options.join(' ')
    : '<span class="muted">No photo with a real GPS fix within 12 hours.</span>')
    + ' <button data-act="pickloc">Pick on the map</button>';
}

async function saveLocation(lat, lon, id = current && current.id) {
  if (id == null) return;
  try {
    await api.post(`/api/photos/${id}/location`, { lat, lon });
    relocated = true;
    toast('Location corrected');
    if (current && current.id === id) show();
  } catch (err) {
    toast(`Could not save the location: ${err.message}`, true);
  }
}

async function show() {
  const id = ids[index];
  // The still first, whatever this turns out to be: the thumbnail is already
  // cached, and a clip's poster frame is the right thing to show while its
  // details are being fetched.
  stopPlayer();
  img.classList.remove('hidden');
  player.classList.add('hidden');
  img.src = previewUrl(id);
  info.innerHTML = '<span class="muted">Loading…</span>';
  const data = await api.get(`/api/photos/${id}`);
  if (ids[index] !== id) return;
  current = data;

  const video = isVideo(data);
  if (video) {
    img.classList.add('hidden');
    player.classList.remove('hidden');
    player.poster = previewUrl(id);
    player.src = `/api/photos/${id}/video`;
  }

  const albums = (data.albums || [])
    .map((aid) => state.albums.find((a) => a.id === aid))
    .filter(Boolean)
    .map((a) => `<span class="dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${escapeHtml(a.color)}"></span> ${escapeHtml(a.name)}`)
    .join(' ');

  info.innerHTML = `
    <span><strong>${escapeHtml(data.filename)}</strong></span>
    <span><span class="k">Taken</span> ${fmtDateTime(data.taken_ts)}${data.taken_src === 'mtime' ? ' <span class="k">(file date)</span>' : ''}</span>
    <span><span class="k">Where</span> ${data.lat == null ? 'no GPS' : `${data.lat.toFixed(5)}, ${data.lon.toFixed(5)}`}${isApprox(data) ? ' <span class="k">(approximate, from the network)</span>' : ''}${data.gps_method === 'MANUAL' ? ' <span class="k">(set by hand)</span>' : ''}${data.gps_method === 'NEIGHBOUR' ? ' <span class="k">(copied from a neighbouring photo)</span>' : ''}</span>
    <span id="lb-suggest">${isApprox(data) ? '<button data-act="fixloc">Fix location</button>' : ''}</span>
    <span><span class="k">Camera</span> ${escapeHtml([data.camera_make, data.camera_model].filter(Boolean).join(' ') || '—')}</span>
    <span><span class="k">Size</span> ${data.width || '?'}×${data.height || '?'} · ${fmtBytes(data.filesize)}${video ? ` · ▶ ${data.duration ? clock(data.duration) : 'video'}` : ''}</span>
    ${albums ? `<span><span class="k">Albums</span> ${albums}</span>` : ''}
    <textarea id="lb-note" class="lb-note" rows="1" maxlength="1000" spellcheck="false"
      placeholder="Add a note… (searchable)">${escapeHtml(data.note || '')}</textarea>
    <span class="spacer"></span>
    <button data-act="fav">${data.favorite ? '★ Favourited' : '☆ Favourite'}</button>
    <button data-act="map">Show on map</button>
    <button data-act="reveal">Reveal in folder</button>
    <a class="btn" href="/api/photos/${id}/original" download>Download</a>
    <button data-act="delete">Delete</button>
    <span class="muted small">${fmtNum(index + 1)} / ${fmtNum(ids.length)}</span>`;
}
