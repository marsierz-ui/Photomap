import { api, guard } from './api.js';
import { state, emit, fmtNum } from './state.js';
import { modal, toast } from './ui.js';
import { pickLocation } from './mapview.js';

export async function setFavorite(ids, value) {
  await guard(api.post('/api/photos/favorite', { ids, value }), 'Failed');
  toast(`${fmtNum(ids.length)} photos ${value ? 'favourited' : 'unfavourited'}`);
  emit('filters');
}

/** "53.1234, -9.5678", as copied from a map: latitude first, comma or space. */
export function parseCoordinates(text) {
  const parts = String(text).trim().split(/[\s,;]+/).filter(Boolean).map(Number);
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return null;
  const [lat, lon] = parts;
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

async function applyLocation(ids, lat, lon) {
  const res = await guard(api.post('/api/photos/set-location', { ids, lat, lon }),
    'Setting the location failed');
  toast(`Location set on ${fmtNum(res.changed)} photo${res.changed === 1 ? '' : 's'}`);
  emit('dataChanged');
  emit('filters');
}

/** Give every selected photo one location, typed in or picked on the map. */
export function setLocationDialog(ids) {
  modal(`
    <h3>Set the location of ${fmtNum(ids.length)} selected photo${ids.length === 1 ? '' : 's'}</h3>
    <p>Every selected photo gets the same position, whatever it had before.</p>
    <div class="row"><label>Coordinates</label>
      <input type="text" id="loc-text" placeholder="53.1234, -9.5678" style="flex:1"></div>
    <p class="muted small" id="loc-err" style="min-height:1.2em"></p>
    <div class="actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn" data-act="pick">Pick on the map</button>
      <button class="btn primary" data-act="ok">Set location</button>
    </div>`, (box, close) => {
    const field = box.querySelector('#loc-text');
    field.focus();
    box.querySelector('[data-act=cancel]').onclick = close;
    box.querySelector('[data-act=ok]').onclick = () => {
      const at = parseCoordinates(field.value);
      if (!at) {
        box.querySelector('#loc-err').textContent =
          'Latitude then longitude, e.g. 53.1234, -9.5678';
        return;
      }
      close();
      applyLocation(ids, at.lat, at.lon);
    };
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') box.querySelector('[data-act=ok]').click();
    });
    // The selection is kept while the map is up, so the photos are still the ones
    // that were chosen when the click lands.
    box.querySelector('[data-act=pick]').onclick = async () => {
      close();
      emit('showMap');
      const at = await pickLocation();
      if (at) applyLocation(ids, at.lat, at.lng);
      else toast('Cancelled - the location was not changed');
    };
  });
}

/** Put selected photos back to the position their own file holds. */
export function undoLocationDialog(ids) {
  modal(`
    <h3>Undo location changes on ${fmtNum(ids.length)} selected photo${ids.length === 1 ? '' : 's'}</h3>
    <p>Each photo whose location was set here - by hand, in bulk, or copied from a
    neighbouring photo - goes back to the location stored in the photo file itself, which
    may be none, or the original tower guess.</p>
    <p class="muted small">Photos you have not changed are left alone.</p>
    <div class="actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn danger" data-act="ok">Undo</button>
    </div>`, (box, close) => {
    box.querySelector('[data-act=cancel]').onclick = close;
    box.querySelector('[data-act=ok]').onclick = async () => {
      close();
      const res = await guard(api.post('/api/photos/undo-location', { ids }), 'Undo failed');
      toast(`${fmtNum(res.restored)} restored · ${fmtNum(res.unchanged)} had no change to undo`
        + (res.unreadable ? ` · ${fmtNum(res.unreadable)} files could not be read` : ''));
      emit('dataChanged');
      emit('filters');
    };
  });
}

/** Copy a real position onto cell-tower photos from the nearest photo in time. */
export function fixLocationsDialog(ids) {
  modal(`
    <h3>Fix locations of ${fmtNum(ids.length)} selected photo${ids.length === 1 ? '' : 's'}</h3>
    <p>Each photo whose location was guessed from mobile towers gets the position of the
    nearest photo with a real GPS fix, taken within 2 hours before or after it.</p>
    <p class="muted small">Photos with no such neighbour, and photos that were never a
    tower guess, are left alone. The changed photos are tagged, and can be listed with
    Location: Set from a neighbouring photo.</p>
    <div class="actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="ok">Fix locations</button>
    </div>`, (box, close) => {
    box.querySelector('[data-act=cancel]').onclick = close;
    box.querySelector('[data-act=ok]').onclick = async () => {
      close();
      const res = await guard(api.post('/api/photos/fix-locations', { ids }), 'Fixing locations failed');
      toast(`${fmtNum(res.fixed)} fixed · ${fmtNum(res.no_neighbour)} had no GPS photo within `
        + `${res.window_hours} h · ${fmtNum(res.skipped)} were not tower guesses`);
      emit('dataChanged');
      emit('filters');
    };
  });
}

/** Two-step delete: files go to the recycle bin, or the index entry only. */
export function deleteDialog(ids, onDone) {
  const recycle = state.config?.recycle_bin;
  const where = recycle ? 'the recycle bin' : 'the app trash folder';
  modal(`
    <h3>Delete ${fmtNum(ids.length)} photo${ids.length === 1 ? '' : 's'}</h3>
    <p>Choose what happens to the file${ids.length === 1 ? '' : 's'} on disk.</p>
    <label class="check"><input type="radio" name="delmode" value="trash" checked>
      Move to ${where} and remove from the library</label>
    <label class="check"><input type="radio" name="delmode" value="forget">
      Remove from the library only, leave the file${ids.length === 1 ? '' : 's'} on disk</label>
    <div class="actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn danger" data-act="ok">Delete</button>
    </div>`, (box, close) => {
    box.querySelector('[data-act=cancel]').onclick = close;
    box.querySelector('[data-act=ok]').onclick = async () => {
      const mode = box.querySelector('input[name=delmode]:checked').value;
      close();
      const res = await guard(api.post('/api/photos/delete', { ids, mode }), 'Delete failed');
      const failed = res.failed.length ? `, ${res.failed.length} failed` : '';
      toast(mode === 'trash'
        ? `${fmtNum(res.deleted)} moved to ${res.location}${failed}`
        : `${fmtNum(res.deleted)} removed from the library${failed}`);
      state.selection.clear();
      emit('selection');
      emit('dataChanged');
      emit('filters');
      if (onDone) onDone();
    };
  });
}
