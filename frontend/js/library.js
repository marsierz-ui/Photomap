import { api, guard } from './api.js';
import { state, emit, on, fmtNum } from './state.js';
import { tracksBlock, wireTracks } from './tracklog.js';
import { activitiesBlock, wireActivities } from './fitness.js';
import { musicBlock, wireMusic } from './music.js';
import { el, modal, toast, escapeHtml, confirmModal } from './ui.js';
import { cloudBlock, refreshPanel } from './cloud.js';
import { themeChoice, setTheme } from './theme.js';
import { HEAT_DEFAULTS, HEAT_RANGES, heatSettings, setHeat } from './mapview.js';
import { MAPBOX_FREE, usageNow, settingsChanged } from './basemaps.js';

let pollTimer = null;
let scanning = false;

export function initLibrary() {
  on('openSettings', openSettings);
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
      if (status.added && status.phase !== 'error') emit('scanFinished', status);
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
    <div class="row"><label>CARTO key</label>
      <input type="text" id="s-carto" placeholder="Needed for the dark map - free at carto.com/basemaps/apikey" autocomplete="off" spellcheck="false">
    </div>
    <div class="row"><label>Map provider</label>
      <select id="s-provider">
        <option value="free">CARTO, OpenStreetMap, Esri</option>
        <option value="mapbox">Mapbox, free maps once its free tier is used</option>
      </select>
    </div>
    <div class="row"><label>Mapbox token</label>
      <input type="text" id="s-mapbox" placeholder="Public token (pk.…) from account.mapbox.com" autocomplete="off" spellcheck="false">
    </div>
    <div class="row"><label>Mapbox this month</label><span id="s-mapbox-usage" class="muted small"></span></div>

    <div class="muted small" style="margin:14px 0 6px">Heat map <span style="opacity:.8">- intensity is relative to the busiest spot on screen, so it rescales as you zoom</span></div>
    ${heatRow('heat_r', 'Radius')}
    ${heatRow('heat_b', 'Blur')}
    ${heatRow('heat_i', 'Intensity')}
    <div class="actions" style="justify-content:flex-start;margin:4px 0 0"><button class="btn tiny" data-act="heat-reset">Reset heat map</button></div>

    <div class="row" style="margin-top:14px"><label>Place names</label><span id="s-places" class="muted small">…</span></div>
    <div class="row"><label>Names in</label>
      <select id="s-place-lang" style="flex:1"></select></div>
    <div class="row"><label></label><span id="s-place-lang-status" class="muted small"></span></div>
    <div class="row"><label>Town borders</label>
      <select id="s-borders" style="flex:1">
        <option value="0">Off - name photos by the nearest town in range</option>
        <option value="1">OpenStreetMap - name photos by the town whose border they are in</option>
      </select></div>
    <div class="row"><label></label><span class="muted small">Asks the Overpass API (overpass-api.de) once for every
      500 m area with photos, sending one photo position from it (to about 10 m). Where no town border is mapped,
      the nearest town in range is used.</span></div>
    <div class="row"><label></label><span id="s-borders-status" class="muted small"></span></div>
    <div class="row"><label>Weather</label>
      <select id="s-weather">
        <option value="0">Off</option>
        <option value="1">On - look up the weather for each photo (Open-Meteo)</option>
      </select>
    </div>
    <div class="row"><label>Open-Meteo key</label>
      <input type="password" id="s-meteo" placeholder="Only for commercial use - leave empty for personal use" autocomplete="off" spellcheck="false">
    </div>
    <div class="row"><label></label><span class="muted small">A key comes with a paid API plan:
      <a href="https://open-meteo.com/en/pricing" target="_blank" rel="noopener">open-meteo.com/en/pricing</a></span></div>
    <div class="row"><label></label><span id="s-weather-status" class="muted small"></span></div>

    ${tracksBlock()}
    ${activitiesBlock()}
    ${musicBlock()}

    <div class="muted small" style="margin:14px 0 6px">Your data <span style="opacity:.8">- everything stays on this computer.
      Take the locations with you in open formats, for any other map or app.</span></div>
    <div class="actions" style="justify-content:flex-start;margin:0">
      <a class="btn tiny" href="/api/export/locations?format=geojson" download>Photo locations (GeoJSON)</a>
      <a class="btn tiny" href="/api/export/locations?format=csv" download>Photo locations (CSV)</a>
      <a class="btn tiny" href="/api/export/tracks.gpx" download>Tracks (GPX)</a>
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
    box.querySelector('#s-carto').value = c.settings.carto_key || '';
    box.querySelector('#s-provider').value = c.settings.map_provider || 'free';
    box.querySelector('#s-mapbox').value = c.settings.mapbox_token || '';
    mapboxUsage(box);
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
    const saveMap = async (patch) => {
      await guard(api.post('/api/config/settings', patch), 'Could not save the map setting');
      Object.assign(state.config.settings, patch);
      settingsChanged();
      mapboxUsage(box);
    };
    box.querySelector('#s-carto').onchange = (e) => saveMap({ carto_key: e.target.value.trim() });
    box.querySelector('#s-provider').onchange = (e) => saveMap({ map_provider: e.target.value });
    box.querySelector('#s-mapbox').onchange = (e) => saveMap({ mapbox_token: e.target.value.trim() });
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
    box.querySelectorAll('input[data-heat]').forEach((input) => {
      input.addEventListener('input', () => setHeat({ [input.dataset.heat]: Number(input.value) }));
    });
    box.querySelector('[data-act=heat-reset]').onclick = () => {
      setHeat(HEAT_DEFAULTS);
      box.querySelectorAll('input[data-heat]').forEach((input) => { input.value = HEAT_DEFAULTS[input.dataset.heat]; });
    };
    placesStatus(box);
    bordersStatus(box);
    box.querySelector('#s-borders').onchange = async (e) => {
      await guard(api.post('/api/borders', { enabled: e.target.value === '1' }), 'Could not change town borders');
      bordersStatus(box);
      placesStatus(box);
    };
    box.querySelector('#s-weather').value = c.settings.weather_enabled === '1' ? '1' : '0';
    box.querySelector('#s-weather').onchange = async (e) => {
      const patch = { weather_enabled: e.target.value };
      await guard(api.post('/api/config/settings', patch), 'Could not save the weather setting');
      Object.assign(state.config.settings, patch);
      if (patch.weather_enabled === '1') await api.post('/api/weather/fill', {});
      weatherStatus(box);
    };
    box.querySelector('#s-meteo').onchange = async (e) => {
      await guard(api.post('/api/config/settings', { open_meteo_key: e.target.value.trim() }), 'Could not save the key');
      e.target.value = '';
      weatherStatus(box);
    };
    weatherStatus(box);
    wireTracks(box);
    wireActivities(box);
    wireMusic(box);
    box.querySelector('[data-act=close]').onclick = close;
    wireShare(box);
    refreshPanel();
  });
}

function mapboxUsage(box) {
  const slot = box.querySelector('#s-mapbox-usage');
  // The dialog may have closed while a save was on its way.
  if (!slot) return;
  const u = usageNow();
  const pct = (kind) => Math.min(100, Math.round(((u[kind] || 0) / MAPBOX_FREE[kind]) * 100));
  slot.textContent =
    `${fmtNum(u.styles)} of ${fmtNum(MAPBOX_FREE.styles)} map tiles (${pct('styles')}%) · `
    + `${fmtNum(u.raster)} of ${fmtNum(MAPBOX_FREE.raster)} satellite tiles (${pct('raster')}%) · `
    + `${fmtNum(u.loads || 0)} of ${fmtNum(MAPBOX_FREE.loads)} 3D map loads (${pct('loads')}%)`
    + (u.refused ? ` · refused by Mapbox (${u.refused}), using the free maps` : '');
}

function heatRow(key, label) {
  const [min, max] = HEAT_RANGES[key];
  return `<div class="row"><label>${label}</label>
    <input type="range" data-heat="${key}" min="${min}" max="${max}" value="${heatSettings()[key]}" style="flex:1"></div>`;
}

/** Town borders: whether they are on, and how many photo spots are still to be asked about. */
async function bordersStatus(box) {
  const slot = box.querySelector('#s-borders-status');
  if (!slot) return;
  const st = await api.get('/api/borders');
  if (!slot.isConnected) return;
  box.querySelector('#s-borders').value = st.enabled ? '1' : '0';
  if (!st.enabled) { slot.textContent = ''; return; }
  const done = st.cells - st.pending;
  slot.textContent = st.error && !st.running
    ? `Stopped at ${fmtNum(done)} of ${fmtNum(st.cells)} spots: ${st.error}. It carries on with the next scan or restart.`
    : st.pending ? `Looking up borders: ${fmtNum(done)} of ${fmtNum(st.cells)} spots…`
      : `Borders known for all ${fmtNum(st.cells)} spots with photos`;
  if (st.running || st.pending) setTimeout(() => bordersStatus(box), 3000);
}

/** Whether coordinates can be turned into places, and the button that makes it so. */
async function placesStatus(box) {
  const slot = box.querySelector('#s-places');
  if (!slot) return;
  const st = await api.get('/api/geocode');
  if (!slot.isConnected) return;
  if (st.available) {
    slot.textContent = st.pending ? `On - naming ${fmtNum(st.pending)} photos…` : 'On (GeoNames, worked out on this computer)';
  } else if (st.downloading) {
    slot.textContent = 'Downloading…';
  } else {
    slot.innerHTML = `${st.error ? `Download failed: ${escapeHtml(st.error)} ` : 'Off '}
      <button class="btn tiny" data-act="places">Download (about 11 MB, once)</button>`;
    slot.querySelector('[data-act=places]').onclick = async () => {
      await guard(api.post('/api/geocode/download'), 'Could not start the download');
      placesStatus(box);
    };
    return;
  }
  if (!st.populations) {
    // An old list: no populations to size towns by, no ids for other languages.
    slot.insertAdjacentHTML('beforeend', ` · this list is from an older version
      <button class="btn tiny" data-act="places-again" title="Town ranges sized by population, and names in other languages">Download again (about 11 MB)</button>`);
    slot.querySelector('[data-act=places-again]').onclick = async () => {
      await guard(api.post('/api/geocode/download'), 'Could not start the download');
      placesStatus(box);
    };
  }
  languageStatus(box, st);
  if (st.downloading || st.pending || st.names.running) setTimeout(() => placesStatus(box), 3000);
}

// Languages offered for place names: the browser's own first, then a fixed
// list of the common ones. Any ISO 639-1 code GeoNames knows would work.
const PLACE_LANGS = ['en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'cs', 'sv', 'da', 'no', 'fi', 'ga',
  'el', 'hu', 'ro', 'tr', 'ru', 'uk', 'ja', 'zh', 'ko', 'ar', 'he', 'hi'];

function languageStatus(box, st) {
  const select = box.querySelector('#s-place-lang');
  const slot = box.querySelector('#s-place-lang-status');
  if (!select || !slot) return;
  if (!select.options.length) {
    const own = (navigator.language || 'en').slice(0, 2).toLowerCase();
    const codes = [own, ...PLACE_LANGS.filter((c) => c !== own)];
    let names = null;
    try { names = new Intl.DisplayNames(undefined, { type: 'language' }); } catch { /* old browser */ }
    select.innerHTML = '<option value="">As GeoNames spells them (mostly local: Wien, Gaillimh)</option>'
      + codes.map((c) => `<option value="${c}">${escapeHtml(names?.of(c) || c)}</option>`).join('');
    select.onchange = async () => {
      await guard(api.post('/api/geocode/language', { lang: select.value }), 'Could not change the language');
      placesStatus(box);
    };
  }
  if (document.activeElement !== select) select.value = st.language || '';
  select.disabled = !st.available;
  const n = st.names;
  if (!st.available) {
    slot.textContent = 'Download place names first.';
  } else if (!st.language) {
    slot.textContent = '';
  } else if (n.running) {
    slot.textContent = n.total && n.done < n.total
      ? `Downloading translations… ${Math.round((n.done / n.total) * 100)}% of ${fmtNum(Math.round(n.total / 1e6))} MB (once per language)`
      : 'Picking out the names for this language…';
  } else if (st.translated) {
    slot.textContent = st.pending ? `Renaming ${fmtNum(st.pending)} photos…` : 'On. Search finds places by either name.';
  } else {
    // No table for this language: an older place list, or a failed download.
    slot.innerHTML = `${n.error ? `Failed: ${escapeHtml(n.error)}. ` : ''}${st.ids
      ? 'Translations need GeoNames\' alternate names (about 190 MB download, kept as a few MB).'
      : 'This place list predates translations; download it again first.'}
      <button class="btn tiny" data-act="names">${st.ids ? 'Download translations' : 'Download place names again'}</button>`;
    slot.querySelector('[data-act=names]').onclick = async () => {
      await guard(api.post(st.ids ? '/api/geocode/names' : '/api/geocode/download'), 'Could not start the download');
      placesStatus(box);
    };
  }
}

/** How far the weather lookup has got. Sends positions and dates to
 *  Open-Meteo, so it says so. */
async function weatherStatus(box) {
  const slot = box.querySelector('#s-weather-status');
  if (!slot) return;
  const st = await api.get('/api/weather');
  if (!slot.isConnected) return;
  const key = st.commercial ? 'commercial key set' : 'free, non-commercial';
  if (!st.enabled) {
    slot.textContent = `Off. When on, each photo's position and date are sent to open-meteo.com (${key}).`;
    return;
  }
  slot.textContent = st.filling || st.pending
    ? `Looking up ${fmtNum(st.pending)} photos… (${fmtNum(st.done)} done, ${key})`
    : `${fmtNum(st.done)} photos have weather (${key})`;
  if (st.error) slot.textContent += ` · last error: ${st.error}`;
  if (st.filling) setTimeout(() => weatherStatus(box), 3000);
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
