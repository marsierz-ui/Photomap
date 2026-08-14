import { api, guard } from './api.js';
import { state, emit, fmtNum } from './state.js';
import { modal, toast } from './ui.js';

export async function setFavorite(ids, value) {
  await guard(api.post('/api/photos/favorite', { ids, value }), 'Failed');
  toast(`${fmtNum(ids.length)} photos ${value ? 'favourited' : 'unfavourited'}`);
  emit('filters');
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
