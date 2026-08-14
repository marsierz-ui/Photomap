import { api, guard } from './api.js';
import { state, on, fmtNum, fmtBytes, fmtDateTime } from './state.js';
import { el, modal, toast, escapeHtml, confirmModal } from './ui.js';


let pollTimer = null;
let last = null;

export function initCloud() {
  poll();
  // Best effort only: a backgrounded tab may be reclaimed before this lands,
  // which is why sync-on-scan remains the reliable trigger.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
  on('syncNow', () => startSync(false));
}

function flush() {
  if (!last?.configured || last.running) return;
  const body = JSON.stringify({});
  if (navigator.sendBeacon) navigator.sendBeacon('/api/sync', new Blob([body], { type: 'application/json' }));
}

export async function startSync(full) {
  try {
    await api.post('/api/sync', { full });
    poll();
  } catch (err) {
    toast(`Sync failed: ${err.message}`, true);
  }
}

async function poll() {
  clearTimeout(pollTimer);
  let status;
  try {
    status = await api.get('/api/sync');
  } catch {
    pollTimer = setTimeout(poll, 8000);
    return;
  }
  last = status;
  state.sync = status;
  paint(status);
  pollTimer = setTimeout(poll, status.running ? 800 : 6000);
}

function paint(status) {
  const chip = el('cloud-chip');
  if (!status.configured) { chip.classList.add('hidden'); return; }
  chip.classList.remove('hidden');

  if (status.running) {
    const pct = status.total ? Math.round((status.done / status.total) * 100) : 0;
    chip.textContent = status.phase === 'building'
      ? `Preparing snapshot ${pct}%`
      : `Uploading ${pct}% · ${fmtNum(status.done)}/${fmtNum(status.total)}`;
  } else if (status.phase === 'error') {
    chip.textContent = `Sync error: ${status.error}`;
  } else if (status.last_sync_ts) {
    chip.textContent = `Cloud synced ${fmtDateTime(localWall(status.last_sync_ts))}`;
  } else {
    chip.textContent = 'Cloud not synced yet';
  }

  const panel = document.getElementById('cloud-panel');
  if (panel) renderPanel(panel, status);
}

// last_sync_ts is a true epoch, but the formatter renders wall-clock UTC.
function localWall(ts) {
  return ts - new Date(ts * 1000).getTimezoneOffset() * 60;
}

export function cloudBlock() {
  return '<div id="cloud-panel" class="share"><div class="muted small">Loading cloud status…</div></div>';
}

export async function refreshPanel() {
  const status = await api.get('/api/sync');
  last = status;
  const panel = document.getElementById('cloud-panel');
  if (panel) renderPanel(panel, status);
}

function renderPanel(panel, status) {
  const configured = status.configured;
  const viewer = status.viewer_url;
  panel.innerHTML = `
    <div class="muted small" style="margin-bottom:6px">Portable cloud snapshot (Cloudflare R2)</div>
    ${configured ? `
      <div class="small" style="margin-bottom:6px">
        ${fmtNum(status.remote_objects)} objects · ${fmtBytes(status.remote_bytes)} stored ·
        ${status.last_sync_ts ? `last sync ${fmtDateTime(localWall(status.last_sync_ts))}` : 'never synced'}
        ${status.received ? `<br><span class="muted">last sync took in
          ${fmtNum(status.received.albums)} album changes,
          ${fmtNum(status.received.favourites)} favourites,
          ${fmtNum(status.received.duplicates)} duplicate removals,
          ${fmtNum(status.received.deleted || 0)} deletions from the cloud</span>` : ''}
        ${status.phase === 'error' ? `<br><span style="color:#ff9ea1">${escapeHtml(status.error || '')}</span>` : ''}
      </div>
      <div class="row"><label>Publish</label>
        <select data-cloud="scope">
          <option value="all"${status.estimate?.scope === 'all' ? ' selected' : ''}>Whole library (gallery + map)</option>
          <option value="located"${status.estimate?.scope === 'located' ? ' selected' : ''}>Only photos with GPS (map only)</option>
        </select>
      </div>
      ${status.estimate ? `<div class="muted small" style="margin-bottom:6px">
        ${fmtNum(status.estimate.photos)} photos at ${status.estimate.thumb_size}px
        ≈ ${fmtBytes(status.estimate.estimated_bytes)}, about ${status.estimate.free_tier_pct}% of the 10GB free tier.
      </div>` : ''}
      ${viewer ? `<div class="share-url"><code>${escapeHtml(viewer)}</code>
        <button class="btn tiny" data-cloud="copy">Copy</button></div>
        <div class="muted small">Open this on a phone and use <strong>Install</strong> (Android)
        or Share → <strong>Add to Home Screen</strong> (iPhone) to keep it as an app that opens
        offline.</div>` : ''}
      <div class="actions" style="justify-content:flex-start;margin-top:8px">
        <button class="btn" data-cloud="sync" ${status.running ? 'disabled' : ''}>
          ${status.running ? 'Syncing…' : 'Sync now'}</button>
        <button class="btn" data-cloud="full" ${status.running ? 'disabled' : ''}>Re-upload all</button>
        <button class="btn ghost" data-cloud="edit">Credentials…</button>
      </div>
      <label class="check small"><input type="checkbox" data-cloud="onscan" ${status.on_scan ? 'checked' : ''}>
        Sync automatically after every library scan</label>
      <label class="check small"><input type="checkbox" data-cloud="allowdelete" ${status.allow_delete ? 'checked' : ''}>
        Allow deleting photos from the cloud viewer</label>
      <div class="muted small">
        ${status.allow_delete
          ? `On. Anyone signed in to the viewer can delete up to ${fmtNum(status.delete_cap)} photos
             at a time. Deletions go to this computer's recycle bin and are applied at the next sync.`
          : `Off. The viewer can still tidy duplicates, which always keep one copy.
             Turn this on only if you want to delete ordinary photos from your phone.`}
      </div>
    ` : `
      <div class="muted small">Not set up. Uploads a heat map plus small thumbnails so you can
      view it from any device, without your library or this computer.</div>
      <div class="actions" style="justify-content:flex-start;margin-top:8px">
        <button class="btn primary" data-cloud="edit">Set up…</button>
      </div>
    `}`;

  panel.querySelectorAll('[data-cloud]').forEach((node) => {
    const action = node.dataset.cloud;
    if (action === 'onscan') {
      node.onchange = async (e) => {
        await api.post('/api/sync/config', { on_scan: e.target.checked });
        refreshPanel();
      };
      return;
    }
    if (action === 'allowdelete') {
      node.onchange = async (e) => {
        if (e.target.checked) {
          const ok = await confirmModal(
            'Allow deleting from the cloud',
            `Anyone who can sign in to your viewer will be able to delete photos from this
             library, up to ${fmtNum(status.delete_cap)} at a time. Deleted files go to this
             computer's recycle bin, so they stay recoverable, but the library entry goes.`,
            'Allow deleting',
          );
          if (!ok) { e.target.checked = false; refreshPanel(); return; }
        }
        await guard(api.post('/api/sync/config', { allow_delete: e.target.checked }), 'Failed');
        toast(e.target.checked
          ? 'Cloud deletion enabled - sync once so the viewer picks it up'
          : 'Cloud deletion disabled');
        refreshPanel();
      };
      return;
    }
    if (action === 'scope') {
      node.onchange = async (e) => {
        await guard(api.post('/api/sync/config', { scope: e.target.value }), 'Failed');
        toast('Scope changed - the next sync republishes everything');
        refreshPanel();
      };
      return;
    }
    node.onclick = async () => {
      if (action === 'copy') {
        try { await navigator.clipboard.writeText(viewer); toast('Link copied'); }
        catch { toast('Copy failed - select the address manually', true); }
      } else if (action === 'sync') {
        await startSync(false);
        toast('Sync started');
        refreshPanel();
      } else if (action === 'full') {
        if (await confirmModal('Re-upload everything',
          'Uploads every thumbnail again. Use this after changing bucket, or if the bucket was emptied.',
          'Re-upload')) {
          await startSync(true);
          toast('Full re-upload started');
        }
        refreshPanel();
      } else if (action === 'edit') {
        credentialsDialog(status);
      }
    };
  });
}

function credentialsDialog(status) {
  modal(`
    <h3>Cloud snapshot setup</h3>
    <div class="muted small" style="margin-bottom:10px">
      From the Cloudflare dashboard: R2 → your bucket, then R2 → Manage API Tokens for a token
      scoped to that one bucket with Object Read &amp; Write.
    </div>
    <label class="small muted">Account ID</label>
    <input type="text" id="c-account" value="${escapeHtml(status.account_id || '')}" autocomplete="off">
    <label class="small muted">Bucket name</label>
    <input type="text" id="c-bucket" value="${escapeHtml(status.bucket || '')}" autocomplete="off">
    <label class="small muted">Access key ID</label>
    <input type="text" id="c-key" placeholder="${status.has_credentials ? 'unchanged - leave blank to keep' : ''}" autocomplete="off">
    <label class="small muted">Secret access key</label>
    <input type="password" id="c-secret" placeholder="${status.has_credentials ? 'unchanged - leave blank to keep' : ''}" autocomplete="off">
    <label class="small muted">Viewer URL (your Worker address, optional)</label>
    <input type="text" id="c-viewer" value="${escapeHtml(status.viewer_url || '')}" placeholder="https://photo-map.you.workers.dev" autocomplete="off">
    <div class="muted small" style="margin-top:8px">
      Keys are stored in this app's local database and are never sent to any browser.
    </div>
    <div id="c-result" class="small" style="margin-top:8px"></div>
    <div class="actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn" data-act="test">Test connection</button>
      <button class="btn primary" data-act="save">Save</button>
    </div>`, (box, close) => {
    const collect = () => {
      const body = {
        account_id: box.querySelector('#c-account').value.trim(),
        bucket: box.querySelector('#c-bucket').value.trim(),
        viewer_url: box.querySelector('#c-viewer').value.trim(),
      };
      const key = box.querySelector('#c-key').value.trim();
      const secret = box.querySelector('#c-secret').value.trim();
      if (key) body.access_key_id = key;
      if (secret) body.secret_key = secret;
      return body;
    };
    const result = box.querySelector('#c-result');

    box.querySelector('[data-act=test]').onclick = async () => {
      result.textContent = 'Testing…';
      result.style.color = '';
      try {
        await api.post('/api/sync/config', collect());
        await api.post('/api/sync/check', {});
        result.textContent = 'Connected. Credentials and bucket look right.';
        result.style.color = '#7ee2a8';
      } catch (err) {
        result.textContent = err.message;
        result.style.color = '#ff9ea1';
      }
    };
    box.querySelector('[data-act=save]').onclick = async () => {
      const res = await guard(api.post('/api/sync/config', collect()), 'Save failed');
      close();
      toast(res.configured
        ? (res.reset ? 'Saved - next sync re-uploads everything' : 'Cloud settings saved')
        : 'Saved, but some fields are still empty');
      refreshPanel();
    };
    box.querySelector('[data-act=cancel]').onclick = close;
  });
}
