import { api, guard } from './api.js';
import { state, emit, fmtNum } from './state.js';
import { el, modal, toast, escapeHtml, confirmModal } from './ui.js';
import { cloudBlock, refreshPanel } from './cloud.js';
import { themeChoice, setTheme } from './theme.js';

let pollTimer = null;
let scanning = false;

export function initLibrary() {
  el('btn-scan').addEventListener('click', () => {
    if (scanning) api.post('/api/scan/cancel');
    else startScan(false);
  });
  el('btn-settings').addEventListener('click', openSettings);
  poll();
}

async function startScan(force) {
  if (!state.config.roots.length) {
    toast('Add a photo folder first', true);
    openSettings();
    return;
  }
  await guard(api.post('/api/scan', { force }), 'Scan failed');
  poll();
}

async function poll() {
  clearTimeout(pollTimer);
  let status;
  try {
    status = await api.get('/api/scan');
  } catch {
    pollTimer = setTimeout(poll, 5000);
    return;
  }
  const chip = el('scan-chip');
  const btn = el('btn-scan');
  scanning = status.running;

  if (status.running) {
    chip.classList.remove('hidden');
    const pct = status.total ? Math.round((status.done / status.total) * 100) : 0;
    const phase = { walking: 'Finding files', indexing: 'Reading EXIF', pruning: 'Cleaning up' }[status.phase] || status.phase;
    chip.textContent = status.phase === 'walking'
      ? `${phase}: ${fmtNum(status.total)} found`
      : `${phase} ${pct}% · ${fmtNum(status.done)}/${fmtNum(status.total)}`;
    btn.textContent = 'Stop scan';
    pollTimer = setTimeout(poll, 700);
    return;
  }

  btn.textContent = 'Scan library';
  if (status.finished) {
    chip.classList.remove('hidden');
    chip.textContent = status.phase === 'error'
      ? `Scan error: ${status.message}`
      : `+${fmtNum(status.added)} new · ${fmtNum(status.updated)} updated`;
    if (!chip.dataset.seen || chip.dataset.seen !== String(status.finished)) {
      chip.dataset.seen = String(status.finished);
      emit('dataChanged');
      emit('filters');
    }
  } else {
    chip.classList.add('hidden');
  }
  pollTimer = setTimeout(poll, 4000);
}

// ------------------------------------------------------------------ settings

export async function openSettings() {
  state.config = await api.get('/api/config');
  const c = state.config;
  modal(`
    <h3>Library settings</h3>
    <div class="muted small" style="margin-bottom:6px">Photo folders</div>
    <div id="roots"></div>
    <div class="actions" style="justify-content:flex-start;margin:8px 0 16px">
      <button class="btn" data-act="browse">Browse…</button>
      <input type="text" id="root-manual" placeholder="…or paste a path" style="flex:1;margin:0">
      <button class="btn" data-act="add">Add</button>
    </div>

    <div class="row"><label>Theme</label>
      <select id="s-theme">
        <option value="auto">Match system</option>
        <option value="dark">Dark</option>
        <option value="light">Light</option>
      </select>
    </div>
    <div class="row"><label>Thumbnails</label>
      <select id="s-thumb">
        <option value="192">Small (192px)</option>
        <option value="256">Medium (256px)</option>
        <option value="384">Large (384px)</option>
      </select>
    </div>
    <div class="row"><label>Preview</label>
      <select id="s-preview">
        <option value="1200">1200px</option>
        <option value="1600">1600px</option>
        <option value="2400">2400px</option>
      </select>
    </div>

    ${shareBlock(c.share)}
    ${cloudBlock()}

    <div class="muted small" style="margin-top:10px">
      HEIC support: ${c.heif ? 'on' : 'off (pip install pillow-heif)'} ·
      Video frames: ${c.ffmpeg ? 'on' : 'off (install ffmpeg for real poster frames)'} ·
      Deleted files go to: ${c.recycle_bin ? 'the OS recycle bin' : 'data/trash'}<br>
      Index and thumbnails live in <code>${escapeHtml(c.data_dir)}</code>
    </div>

    <div class="actions">
      <button class="btn" data-act="redate">Fix dates from filenames</button>
      <button class="btn" data-act="rethumb">Rebuild thumbnails</button>
      <button class="btn" data-act="rescan">Full rescan</button>
      <button class="btn primary" data-act="close">Done</button>
    </div>`, (box, close) => {
    box.querySelector('#s-thumb').value = c.settings.thumb_size || '256';
    box.querySelector('#s-preview').value = c.settings.preview_size || '1600';
    box.querySelector('#s-theme').value = themeChoice();
    box.querySelector('#s-theme').onchange = (e) => setTheme(e.target.value);
    renderRoots(box);

    box.querySelector('[data-act=browse]').onclick = () => browseDialog(async (path) => {
      await addRoot(path, box);
      openSettings();
    });
    box.querySelector('[data-act=add]').onclick = async () => {
      const path = box.querySelector('#root-manual').value.trim();
      if (path) { await addRoot(path, box); box.querySelector('#root-manual').value = ''; }
    };
    box.querySelector('#s-thumb').onchange = (e) => api.post('/api/config/settings', { thumb_size: e.target.value });
    box.querySelector('#s-preview').onchange = (e) => api.post('/api/config/settings', { preview_size: e.target.value });
    box.querySelector('[data-act=rethumb]').onclick = async () => {
      const res = await api.post('/api/thumbs/clear', {});
      toast(`${fmtNum(res.removed)} cached thumbnails cleared`);
    };
    box.querySelector('[data-act=redate]').onclick = async () => {
      const preview = await guard(api.post('/api/photos/redate', { dry_run: true }), 'Failed');
      if (!preview.would_update) {
        toast('Every photo already has a capture time better than its file date');
        return;
      }
      const examples = preview.samples.slice(0, 5).map((s) =>
        `<div class="small"><code>${escapeHtml(s.filename)}</code><br>
         <span class="muted">${new Date(s.from * 1000).toISOString().slice(0, 16).replace('T', ' ')}
         → ${new Date(s.to * 1000).toISOString().slice(0, 16).replace('T', ' ')}</span></div>`).join('');
      if (!await confirmModal('Fix dates from filenames',
        `<p>${fmtNum(preview.would_update)} of ${fmtNum(preview.candidates)} photos still using their
         file date have a date in the filename. EXIF dates are never touched.</p>
         <div style="max-height:180px;overflow:auto;display:flex;flex-direction:column;gap:6px">${examples}</div>`,
        `Fix ${fmtNum(preview.would_update)} dates`)) return;
      const res = await guard(api.post('/api/photos/redate', {}), 'Failed');
      toast(`${fmtNum(res.updated)} capture times corrected`);
      emit('dataChanged');
      emit('filters');
    };
    box.querySelector('[data-act=rescan]').onclick = () => { close(); startScan(true); };
    box.querySelector('[data-act=close]').onclick = close;
    wireShare(box);
    refreshPanel();
  });
}

function shareBlock(share) {
  if (!share) return '';
  if (!share.required) {
    return `<div class="share">
      <div class="muted small">Local only. Start the server with <code>run.bat</code>
      or <code>serve.py --lan</code> to open it on your phone and laptop.</div>
    </div>`;
  }
  if (!share.urls.length) {
    return `<div class="share"><div class="muted small">Sharing is on, but no network
      address was found - check this machine's Wi-Fi connection.</div></div>`;
  }
  return `<div class="share">
    <div class="muted small" style="margin-bottom:6px">Open on another device (same Wi-Fi)</div>
    ${share.urls.map((u) => `<div class="share-url"><code>${escapeHtml(u)}</code>
      <button class="btn tiny" data-copy="${escapeHtml(u)}">Copy</button></div>`).join('')}
    <div class="muted small" style="margin-top:6px">
      Access key <code>${escapeHtml(share.key)}</code> - the link carries it, so it is only
      needed if you type the address by hand.
      <button class="btn tiny" data-act="newkey">New key</button>
    </div>
  </div>`;
}

function wireShare(box) {
  box.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        toast('Link copied');
      } catch {
        toast('Copy failed - select the address and copy it manually', true);
      }
    };
  });
  const reset = box.querySelector('[data-act=newkey]');
  if (reset) {
    reset.onclick = async () => {
      if (!await confirmModal('New access key', 'Devices already signed in will have to use the new link.', 'Generate')) {
        openSettings();
        return;
      }
      await api.post('/api/access/reset', {});
      openSettings();
      toast('New access key generated');
    };
  }
}

function renderRoots(box) {
  const target = box.querySelector('#roots');
  const roots = state.config.roots;
  target.innerHTML = roots.length
    ? roots.map((r) => `<div class="root-row"><code>${escapeHtml(r)}</code>
        <button class="btn tiny" data-root="${escapeHtml(r)}">Remove</button></div>`).join('')
    : '<div class="muted small">No folders yet. Add the folder holding your photos.</div>';
  target.querySelectorAll('button[data-root]').forEach((btn) => {
    btn.onclick = async () => {
      const path = btn.dataset.root;
      if (!await confirmModal('Remove folder', `Stop indexing <code>${escapeHtml(path)}</code>? Indexed photos stay until the next scan.`, 'Remove')) {
        openSettings();
        return;
      }
      await api.del('/api/config/roots', new URLSearchParams({ path }));
      openSettings();
    };
  });
}

async function addRoot(path, box) {
  try {
    const res = await api.post('/api/config/roots', { path });
    state.config.roots = res.roots;
    renderRoots(box);
    toast('Folder added - run a scan to index it');
  } catch (err) {
    toast(err.message, true);
  }
}

function browseDialog(onPick) {
  const load = async (path) => {
    const data = await api.get('/api/browse', new URLSearchParams(path ? { path } : {}));
    modal(`
      <h3>Choose a folder</h3>
      <div class="muted small" style="margin-bottom:6px">${escapeHtml(data.path || 'This computer')}</div>
      <div class="picker">
        ${data.parent ? '<div data-up="1">⬑ Up one level</div>' : ''}
        ${data.dirs.map((d) => `<div data-path="${escapeHtml(d.path)}">📁 ${escapeHtml(d.name)}</div>`).join('') || '<div class="muted">No subfolders</div>'}
      </div>
      <div class="actions">
        <button class="btn" data-act="cancel">Cancel</button>
        <button class="btn primary" data-act="use" ${data.path ? '' : 'disabled'}>Use this folder</button>
      </div>`, (box, close) => {
      box.querySelector('.picker').addEventListener('click', (e) => {
        const row = e.target.closest('div[data-path], div[data-up]');
        if (!row) return;
        load(row.dataset.up ? data.parent : row.dataset.path);
      });
      box.querySelector('[data-act=use]').onclick = () => { close(); onPick(data.path); };
      box.querySelector('[data-act=cancel]').onclick = close;
    });
  };
  load('');
}
