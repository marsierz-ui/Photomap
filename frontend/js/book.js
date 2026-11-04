// A trip as a printable photo book: a cover, a route map, then the days in
// order with their journal notes and photos. "Print or save as PDF" in the
// browser makes the file; nothing is uploaded anywhere.
//
// Photos are packed into justified rows (every row exactly the page width),
// rows onto pages, and then each page's rows are stretched to fill the page
// height, cropping a little rather than leaving half a page empty. The crop is
// capped so a portrait is never cut down to a strip.

const DAY = 86400;
const PAPER = {
  a4p: { w: 210, h: 297, css: '210mm 297mm' },
  a4l: { w: 297, h: 210, css: '297mm 210mm' },
  sq: { w: 210, h: 210, css: '210mm 210mm' },
};
const MARGIN_MM = 12;
const GAP_MM = 2.2;
// How much taller than its natural height a row may be stretched.
const MAX_STRETCH = 1.3;

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const from = Number(q.get('from'));
const to = Number(q.get('to'));

const D_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const R_FMT = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const regionNames = (() => { try { return new Intl.DisplayNames(undefined, { type: 'region' }); } catch { return null; } })();
const countryName = (cc) => { try { return regionNames?.of(cc) || cc; } catch { return cc; } };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plain = (html) => (new DOMParser().parseFromString(html || '', 'text/html').body.innerText || '').trim();

let photos = [];
let notes = new Map();

async function get(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function load() {
  $('b-status').textContent = 'Loading photos…';
  const all = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await get(`/api/photos?from=${from}&to=${to}&sort=date_asc&limit=1000&offset=${offset}`);
    all.push(...page.items);
    if (all.length >= page.total || !page.items.length) break;
  }
  // Clips do not print.
  photos = all.filter((p) => p.duration == null && p.width && p.height);
  try {
    const days = await get('/api/days');
    notes = new Map(days.map((d) => [d.day, plain(d.text)]));
  } catch { notes = new Map(); }
}

/** Width over height as it is shown, after EXIF rotation. */
const aspect = (p) => ([5, 6, 7, 8].includes(p.orientation) ? p.height / p.width : p.width / p.height);
const dayKey = (ts) => new Date(Math.floor(ts / DAY) * DAY * 1000).toISOString().slice(0, 10);

function render() {
  const paper = PAPER[$('b-paper').value];
  const density = Number($('b-density').value);
  const favsOnly = $('b-favs').checked;
  const pages = $('pages');
  pages.innerHTML = '';
  document.documentElement.style.setProperty('--pw', `${paper.w}mm`);
  document.documentElement.style.setProperty('--ph', `${paper.h}mm`);
  document.documentElement.style.setProperty('--gap', `${GAP_MM}mm`);
  $('page-size').textContent = `@page { size: ${paper.css}; margin: 0; }`;

  const chosen = favsOnly ? photos.filter((p) => p.favorite) : photos;
  if (!chosen.length) {
    pages.innerHTML = '<p>No photos in this trip' + (favsOnly ? ' are favourites' : '') + '.</p>';
    $('b-status').textContent = '';
    return;
  }

  // Measure in pixels on screen; mm and px keep a fixed ratio, so print matches.
  const probe = newPage(pages);
  const pxPerMm = probe.clientWidth / paper.w;
  const innerW = probe.clientWidth - 2 * MARGIN_MM * pxPerMm;
  const innerH = probe.clientHeight - 2 * MARGIN_MM * pxPerMm - 6 * pxPerMm; // room for the folio
  const gap = GAP_MM * pxPerMm;
  probe.remove();
  const targetRow = innerH / (paper.h > paper.w ? 3.4 : 2.4) * density;

  cover(pages, chosen);
  if ($('b-map').checked) routeMap(pages, chosen);

  const byDay = new Map();
  chosen.forEach((p) => {
    const k = dayKey(p.taken_ts);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(p);
  });

  let page = null;
  let used = 0;
  let rowsOnPage = [];
  const finish = () => { if (page) stretch(rowsOnPage, innerH - used); };
  const start = () => {
    finish();
    page = newPage(pages);
    used = 0;
    rowsOnPage = [];
  };

  for (const [day, list] of byDay) {
    const head = dayHead(day, list);
    // A day starts on a fresh page when its heading plus one row will not fit.
    if (!page) start();
    page.appendChild(head);
    const hh = head.offsetHeight + 3 * pxPerMm;
    if (used + hh + targetRow * 0.8 > innerH && used > 0) {
      head.remove();
      start();
      page.appendChild(head);
    }
    used += head.offsetHeight + 3 * pxPerMm;

    for (const row of justify(list, innerW, targetRow, gap)) {
      if (used + row.h > innerH + 0.5) start();
      const el = document.createElement('div');
      el.className = 'row';
      row.items.forEach(({ p, w }) => {
        const img = document.createElement('img');
        img.src = `/api/photos/${p.id}/preview?s=1600`;
        img.alt = p.filename;
        img.style.width = `${w}px`;
        img.style.height = `${row.h}px`;
        img.loading = 'eager';
        el.appendChild(img);
      });
      page.appendChild(el);
      rowsOnPage.push({ el, h: row.h });
      used += row.h + gap;
    }
  }
  finish();
  [...pages.querySelectorAll('.page')].forEach((p, i) => {
    if (i < ($('b-map').checked ? 2 : 1)) return;
    const f = document.createElement('div');
    f.className = 'folio';
    f.textContent = String(i + 1);
    p.appendChild(f);
  });
  $('b-status').textContent = `${chosen.length} photos · ${pages.children.length} pages`;
}

function newPage(parent) {
  const page = document.createElement('section');
  page.className = 'page';
  parent.appendChild(page);
  return page;
}

/** Rows of photos at a common height that exactly fill the width. The last
 *  row of a day is not blown up to full width when it has only one or two
 *  photos; it keeps the target height. */
function justify(list, width, target, gap) {
  const rows = [];
  let cur = [];
  let sum = 0;
  list.forEach((p) => {
    cur.push(p);
    sum += aspect(p);
    const h = (width - gap * (cur.length - 1)) / sum;
    if (h <= target) {
      rows.push(fit(cur, sum, width, gap));
      cur = [];
      sum = 0;
    }
  });
  if (cur.length) {
    const full = fit(cur, sum, width, gap);
    if (full.h <= target * 1.35) {
      rows.push(full);
    } else if (rows.length) {
      // Too few left to fill a row: join the row above rather than leave a gap.
      const prev = rows.pop().items.map((i) => i.p).concat(cur);
      rows.push(fit(prev, prev.reduce((n, p) => n + aspect(p), 0), width, gap));
    } else {
      rows.push({ h: target, items: cur.map((p) => ({ p, w: aspect(p) * target })) });
    }
  }
  return rows;
}

function fit(items, sum, width, gap) {
  const h = (width - gap * (items.length - 1)) / sum;
  return { h, items: items.map((p) => ({ p, w: aspect(p) * h })) };
}

/** Give the page's spare height to its rows, cropping a little. */
function stretch(rows, spare) {
  if (!rows.length || spare <= 1) return;
  const total = rows.reduce((s, r) => s + r.h, 0);
  const factor = Math.min(MAX_STRETCH, (total + spare) / total);
  rows.forEach((r) => {
    const h = r.h * factor;
    r.el.querySelectorAll('img').forEach((img) => { img.style.height = `${h}px`; });
  });
}

function dayHead(day, list) {
  const head = document.createElement('div');
  head.className = 'dayhead';
  const towns = [...new Set(list.map((p) => (p.place || '').split(',')[0]).filter(Boolean))].slice(0, 4);
  const note = $('b-notes').checked ? notes.get(day) : '';
  head.innerHTML = `<h3>${esc(D_FMT.format(new Date(`${day}T00:00:00Z`)))}</h3>
    ${towns.length ? `<div class="where">${esc(towns.join(' · '))}</div>` : ''}
    ${note ? `<div class="note">${esc(note)}</div>` : ''}`;
  return head;
}

function cover(parent, list) {
  const pick = list.find((p) => p.favorite && aspect(p) >= 0.6) || list[Math.floor(list.length / 2)];
  const page = newPage(parent);
  page.classList.add('cover');
  page.style.backgroundImage = `url(/api/photos/${pick.id}/preview?s=2400)`;
  const first = list[0].taken_ts;
  const last = list[list.length - 1].taken_ts;
  const countries = [...new Set(list.map((p) => p.country).filter(Boolean))].map(countryName);
  page.innerHTML = `<div class="veil"><h1>${esc($('b-title').value)}</h1>
    <p>${esc(R_FMT.format(new Date(first * 1000)))}${dayKey(first) === dayKey(last) ? '' : ` – ${esc(R_FMT.format(new Date(last * 1000)))}`}</p>
    ${countries.length ? `<p>${esc(countries.join(' · '))}</p>` : ''}</div>`;
}

function routeMap(parent, list) {
  const located = list.filter((p) => p.lat != null);
  if (!located.length) return;
  const page = newPage(parent);
  page.classList.add('mappage');
  const days = new Set(list.map((p) => dayKey(p.taken_ts))).size;
  let km = 0;
  for (let i = 1; i < located.length; i += 1) km += dist(located[i - 1], located[i]);
  page.innerHTML = `<h2>The route</h2><div class="map"></div>
    <div class="stats"><span><b>${days}</b> day${days === 1 ? '' : 's'}</span><span><b>${list.length}</b> photos</span>
    <span><b>${Math.round(km).toLocaleString()}</b> km between photos</span></div>`;
  const map = L.map(page.querySelector('.map'), { zoomControl: false, attributionControl: true, zoomSnap: 0.25 });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '© OpenStreetMap contributors', crossOrigin: true,
  }).addTo(map);
  const line = located.map((p) => [p.lat, p.lon]);
  L.polyline(line, { color: '#0b72d8', weight: 3 }).addTo(map);
  L.circleMarker(line[0], { radius: 6, color: '#fff', fillColor: '#1a7f37', fillOpacity: 1, weight: 2 }).addTo(map);
  L.circleMarker(line[line.length - 1], { radius: 6, color: '#fff', fillColor: '#c9333a', fillOpacity: 1, weight: 2 }).addTo(map);
  map.fitBounds(L.latLngBounds(line).pad(0.08), { maxZoom: 14 });
}

function dist(a, b) {
  const r = Math.PI / 180;
  const x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r);
  const y = (b.lat - a.lat) * r;
  return 6371 * Math.hypot(x, y);
}

async function printBook() {
  $('b-status').textContent = 'Waiting for photos to load…';
  await Promise.all([...document.images].map((img) => (img.complete ? null : img.decode().catch(() => null))));
  $('b-status').textContent = '';
  window.print();
}

async function main() {
  const style = document.createElement('style');
  style.id = 'page-size';
  document.head.appendChild(style);
  $('b-title').value = q.get('title') || 'Our trip';
  document.title = $('b-title').value;
  await load();
  render();
  ['b-paper', 'b-density', 'b-favs', 'b-notes', 'b-map'].forEach((id) => $(id).addEventListener('change', render));
  let t = null;
  $('b-title').addEventListener('input', () => {
    document.title = $('b-title').value;
    clearTimeout(t);
    t = setTimeout(render, 400);
  });
  $('b-print').addEventListener('click', printBook);
}

main().catch((err) => { $('b-status').textContent = `Could not build the book: ${err.message}`; });
