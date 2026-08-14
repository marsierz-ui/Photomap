import { api, guard, thumbUrl } from './api.js';
import { emit, on, fmtBytes, fmtNum, fmtDate } from './state.js';
import { el, toast, escapeHtml, confirmModal } from './ui.js';

let groups = [];             // the sets on the current page
let total = 0;               // sets in the whole library
let offset = 0;
let perPage = 100;
const keepers = new Map();   // hash -> photo id to keep, kept across pages
const chosen = new Set();    // hashes queued for resolve, kept across pages
const meta = new Map();      // hash -> {count, wasted}, so off-page picks still total correctly
let pollTimer = null;
let loaded = false;

export function initDupes() {
  el('dup-scan').addEventListener('click', scan);
  el('dup-selectall').addEventListener('click', () => {
    // Scoped to the page on purpose: selecting thousands of sets sight-unseen
    // is exactly the kind of action this screen exists to prevent.
    const allOnPage = groups.every((g) => chosen.has(g.hash));
    groups.forEach((g) => (allOnPage ? chosen.delete(g.hash) : chosen.add(g.hash)));
    render();
  });
  el('dup-selectevery').addEventListener('click', selectEverySet);
  el('dup-resolve').addEventListener('click', resolve);
  el('dup-list').addEventListener('click', onListClick);
  // 'change' rather than 'click': the checkbox sits inside its own <label>, and
  // relying on the click would double-toggle. Only the button is repainted, so
  // ticking a box does not rebuild the list or lose scroll position.
  el('dup-list').addEventListener('change', (e) => {
    const pick = e.target.closest('.dup-pick');
    if (!pick) return;
    if (pick.checked) chosen.add(pick.dataset.hash);
    else chosen.delete(pick.dataset.hash);
    paintResolveButton();
  });

  el('dup-first').addEventListener('click', () => go(0));
  el('dup-prev').addEventListener('click', () => go(offset - perPage));
  el('dup-next').addEventListener('click', () => go(offset + perPage));
  el('dup-per').addEventListener('change', (e) => {
    perPage = Number(e.target.value);
    go(0);
  });

  on('dupesShown', () => { if (!loaded) load(); });
}

function go(next) {
  offset = Math.max(0, Math.min(next, Math.max(0, total - 1)));
  load();
  el('dup-list').scrollTop = 0;
}

async function load() {
  loaded = true;
  const params = new URLSearchParams({ limit: perPage, offset });
  const data = await guard(api.get('/api/duplicates', params), 'Could not load duplicates');
  absorb(data);
  paintSummary(data.summary, data.scan);
  render();
}

function absorb(data) {
  groups = data.groups;
  total = data.total ?? data.summary.sets;
  offset = data.offset ?? offset;
  groups.forEach((g) => {
    if (!keepers.has(g.hash)) keepers.set(g.hash, g.keep_id);
    meta.set(g.hash, { count: g.count, wasted: g.wasted });
  });
}

function paintSummary(summary, scan) {
  const bits = [];
  if (summary.sets) {
    bits.push(`${fmtNum(summary.sets)} duplicate sets`);
    bits.push(`${fmtNum(summary.redundant)} redundant copies`);
    bits.push(`${fmtBytes(summary.reclaimable)} reclaimable`);
  } else {
    bits.push(scan.finished ? 'No duplicates found' : 'Not scanned yet');
  }
  el('dup-summary').textContent = bits.join(' · ');
}

async function scan() {
  await guard(api.post('/api/duplicates/scan', {}), 'Scan failed');
  poll();
}

async function poll() {
  clearTimeout(pollTimer);
  const params = new URLSearchParams({ limit: perPage, offset });
  const data = await api.get('/api/duplicates', params);
  const scan = data.scan;
  if (scan.running) {
    const pct = scan.total ? Math.round((scan.done / scan.total) * 100) : 0;
    el('dup-summary').textContent =
      `Hashing ${pct}% · ${fmtNum(scan.done)}/${fmtNum(scan.total)} files that share a size`;
    el('dup-scan').textContent = 'Scanning…';
    el('dup-scan').disabled = true;
    pollTimer = setTimeout(poll, 700);
    return;
  }
  el('dup-scan').textContent = 'Find duplicates';
  el('dup-scan').disabled = false;
  absorb(data);
  paintSummary(data.summary, scan);
  render();
}

function render() {
  const list = el('dup-list');
  if (!groups.length) {
    list.innerHTML = '<div class="muted" style="padding:20px">'
      + (total
        ? 'No sets on this page.'
        : 'Nothing to review. Press <strong>Find duplicates</strong> to compare files that share a size.')
      + '</div>';
    el('dup-resolve').disabled = true;
    paintPager();
    return;
  }

  list.innerHTML = groups.map((g) => {
    const keep = keepers.get(g.hash);
    const photos = g.photos.map((p) => `
      <div class="dupphoto${p.id === keep ? ' keep' : ''}" data-hash="${g.hash}" data-id="${p.id}"
           title="${escapeHtml(p.path)}">
        <img loading="lazy" src="${thumbUrl(p.id, 256)}" alt="">
        <span class="badge">${p.id === keep ? 'Keep' : 'Remove'}</span>
        <span class="name">${escapeHtml(p.filename)}</span>
        <span class="sub muted">${fmtDate(p.taken_ts)}${p.lat != null ? ' · GPS' : ''}${p.favorite ? ' · ★' : ''}</span>
      </div>`).join('');
    return `<div class="dupset">
      <div class="dupset-head">
        <label class="check">
          <input type="checkbox" class="dup-pick" data-hash="${g.hash}" ${chosen.has(g.hash) ? 'checked' : ''}>
          ${fmtNum(g.count)} identical copies · ${fmtBytes(g.size)} each ·
          <strong>${fmtBytes(g.wasted)}</strong> reclaimable
        </label>
      </div>
      <div class="dupset-photos">${photos}</div>
    </div>`;
  }).join('');

  paintResolveButton();
  paintPager();
}

function paintPager() {
  const pager = el('dup-pager');
  pager.classList.toggle('hidden', total <= 0);
  if (total <= 0) return;

  const page = Math.floor(offset / perPage) + 1;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const to = Math.min(offset + groups.length, total);
  const offPage = [...chosen].filter((h) => !groups.some((g) => g.hash === h)).length;
  el('dup-page').textContent =
    `Sets ${fmtNum(offset + 1)}-${fmtNum(to)} of ${fmtNum(total)} · page ${fmtNum(page)} of ${fmtNum(pages)}`
    + (offPage ? ` · ${fmtNum(offPage)} selected on other pages` : '');

  el('dup-first').disabled = offset === 0;
  el('dup-prev').disabled = offset === 0;
  el('dup-next').disabled = offset + perPage >= total;
  el('dup-selectall').textContent = groups.length && groups.every((g) => chosen.has(g.hash))
    ? 'Deselect page' : 'Select page';
  el('dup-selectevery').textContent = total && chosen.size >= total
    ? 'Clear selection' : 'Select all sets';
}

/** Every set in the library, not just the page. The whole point is to clear a
 *  large library in one pass, so it asks first and says what it is about to
 *  queue - the keep-one-copy rule still applies to every set. */
async function selectEverySet() {
  if (total && chosen.size >= total) {
    chosen.clear();
    render();
    return;
  }
  const button = el('dup-selectevery');
  button.disabled = true;
  button.textContent = 'Loading…';
  try {
    const res = await guard(api.get('/api/duplicates/all'), 'Could not list the sets');
    let files = 0;
    let bytes = 0;
    res.sets.forEach((set) => {
      files += set.count - 1;
      bytes += set.wasted;
    });
    const ok = await confirmModal(
      'Select every duplicate set',
      `${fmtNum(res.sets.length)} sets across the whole library, ${fmtNum(files)} extra
       files (${fmtBytes(bytes)}). Nothing is deleted yet - this only ticks them, and one
       copy of each set is always kept.`,
      `Select ${fmtNum(res.sets.length)} sets`,
    );
    if (!ok) return;
    res.sets.forEach((set) => {
      chosen.add(set.hash);
      meta.set(set.hash, { count: set.count, wasted: set.wasted });
      if (!keepers.has(set.hash)) keepers.set(set.hash, set.keep_id);
    });
    render();
    toast(`${fmtNum(res.sets.length)} sets selected`);
  } finally {
    button.disabled = false;
    paintPager();
  }
}

function paintResolveButton() {
  let bytes = 0;
  chosen.forEach((h) => { bytes += meta.get(h)?.wasted || 0; });
  const button = el('dup-resolve');
  button.disabled = chosen.size === 0;
  button.textContent = chosen.size
    ? `Move extras to recycle bin (${fmtNum(chosen.size)} set${chosen.size === 1 ? '' : 's'}, ${fmtBytes(bytes)})`
    : 'Move extras to recycle bin';
  paintPager();
}

function onListClick(e) {
  if (e.target.closest('.dup-pick')) return;   // handled by the change listener
  const photo = e.target.closest('.dupphoto');
  if (photo) {
    keepers.set(photo.dataset.hash, Number(photo.dataset.id));
    render();
  }
}

async function resolve() {
  const hashes = [...chosen];
  let count = 0;
  let bytes = 0;
  hashes.forEach((h) => {
    const m = meta.get(h);
    if (m) { count += m.count - 1; bytes += m.wasted; }
  });
  const offPage = hashes.filter((h) => !groups.some((g) => g.hash === h)).length;

  const ok = await confirmModal(
    'Move duplicates to the recycle bin',
    `${fmtNum(count)} extra file${count === 1 ? '' : 's'} (${fmtBytes(bytes)}) across
     ${fmtNum(hashes.length)} set${hashes.length === 1 ? '' : 's'} will be moved to the recycle bin.
     ${offPage ? `<br><strong>${fmtNum(offPage)}</strong> of those sets are on other pages.` : ''}
     One copy of each set is kept, and you can restore anything from the bin.`,
    `Move ${fmtNum(count)} files`,
  );
  if (!ok) return;

  const res = await guard(api.post('/api/duplicates/resolve', {
    hashes,
    keep: hashes.map((h) => keepers.get(h)),
    mode: 'trash',
  }), 'Delete failed');

  const skipped = res.skipped?.length ? `, ${res.skipped.length} skipped` : '';
  toast(`${fmtNum(res.deleted)} moved to ${res.location}${skipped}`);
  hashes.forEach((h) => { chosen.delete(h); meta.delete(h); keepers.delete(h); });
  // Resolved sets vanish, so the page window may now sit past the end.
  offset = Math.max(0, Math.min(offset, Math.max(0, total - res.deleted - 1)));
  await load();
  emit('dataChanged');
  emit('filters');
}
