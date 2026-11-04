import { api, guard } from './api.js';
import { state, params, on, emit, setFilters, fmtNum, fmtBytes, fmtDate, flag } from './state.js';
import { el, escapeHtml, toast } from './ui.js';
import { countryName } from './lightbox.js';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let retry = null;

export function initInsights() {
  on('insightsShown', render);
  on('filters', () => { if (state.view === 'insights') render(); });
  el('insights').addEventListener('click', async (e) => {
    const row = e.target.closest('[data-cc]');
    if (row) {
      // A country row narrows everything to it; the map is where that shows.
      setFilters({ country: state.filters.country === row.dataset.cc ? '' : row.dataset.cc });
      emit('showMap');
      return;
    }
    if (e.target.dataset.act !== 'places') return;
    e.target.disabled = true;
    await guard(api.post('/api/geocode/download'), 'Could not start the download');
    toast('Downloading place names…');
    render();
  });
}

async function render() {
  clearTimeout(retry);
  const target = el('insights');
  const [stats, hour, dow, month, year, countries] = await Promise.all([
    api.get('/api/stats', params()),
    api.get('/api/dist', params({ extra: { field: 'hour' } })),
    api.get('/api/dist', params({ extra: { field: 'dow' } })),
    api.get('/api/dist', params({ extra: { field: 'month' } })),
    api.get('/api/dist', params({ extra: { field: 'year' } })),
    api.get('/api/countries', params()),
  ]);
  // Still downloading, or still naming photos: look again shortly.
  if (state.view === 'insights' && (countries.downloading || countries.pending)) {
    retry = setTimeout(render, 4000);
  }

  const geoPct = stats.total ? Math.round((stats.geo / stats.total) * 100) : 0;
  target.innerHTML = `
    <div class="cards">
      ${card('Photos', fmtNum(stats.total))}
      ${card('With location', `${fmtNum(stats.geo)} <span class="muted" style="font-size:13px">(${geoPct}%)</span>`)}
      ${card('On disk', fmtBytes(stats.bytes))}
      ${card('First photo', fmtDate(stats.first_ts))}
      ${card('Latest photo', fmtDate(stats.last_ts))}
      ${countries.items.length ? card('Countries', `${fmtNum(countries.items.length)} <span class="muted" style="font-size:13px">(${worldPct(countries.world)} of the world)</span>`) : ''}
      ${stats.missing ? card('Missing files', fmtNum(stats.missing)) : ''}
    </div>
    ${countries.items.length ? continentChart(countries) : ''}
    ${countryChart(countries, stats.geo)}
    ${barChart('By hour of day', hour.items, (k) => `${k}`, 24, (i) => i)}
    ${barChart('By weekday', dow.items, (k) => DOW[k], 7, (i) => i)}
    ${barChart('By month', month.items, (k) => MONTHS[k - 1], 12, (i) => i + 1)}
    ${barChart('By year', year.items, (k) => `${k}`)}
    <div class="chart">
      <h4>Cameras <span class="muted" style="font-weight:400">share of ${fmtNum(stats.total)} photos</span></h4>
      ${stats.cameras.length
        ? stats.cameras.map((c) => hbar(c.name, c.c, stats.total)).join('')
          + (() => {
            const named = stats.cameras.reduce((sum, c) => sum + c.c, 0);
            const rest = stats.total - named;
            return rest > 0 ? hbar('No camera recorded', rest, stats.total) : '';
          })()
        : '<span class="muted">No camera data</span>'}
    </div>`;
}

function countryChart(res, located) {
  let body;
  if (!res.available) {
    body = res.downloading
      ? '<span class="muted">Downloading place names…</span>'
      : `<div class="muted small" style="margin-bottom:8px">${res.error ? `Download failed: ${escapeHtml(res.error)}. ` : ''}
         Countries and place names are worked out on this computer from the GeoNames list of
         places (about 11 MB, downloaded once). Nothing about your photos is sent anywhere.</div>
         <button class="btn tiny" data-act="places">Download place names</button>`;
  } else if (!res.items.length) {
    body = `<span class="muted">${res.pending ? `Naming ${fmtNum(res.pending)} photos…` : 'No located photos for these filters'}</span>`;
  } else {
    const rows = res.items.map((c) => `<div class="hbar clickable${state.filters.country === c.cc ? ' active' : ''}" data-cc="${escapeHtml(c.cc)}" title="Show only ${escapeHtml(countryName(c.cc))}">
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${flag(c.cc)} ${escapeHtml(countryName(c.cc))}</span>
      <span class="track"><span class="fill" style="width:${((c.c / res.items[0].c) * 100).toFixed(2)}%"></span></span>
      <span class="n">${fmtNum(c.c)} <span class="muted">· ${fmtNum(c.days)} day${c.days === 1 ? '' : 's'} · ${fmtNum(c.places)} place${c.places === 1 ? '' : 's'} · ${fmtDate(c.first_ts)} - ${fmtDate(c.last_ts)}</span></span>
    </div>`).join('');
    body = (res.pending ? `<div class="muted small">Still naming ${fmtNum(res.pending)} photos…</div>` : '') + rows;
  }
  return `<div class="chart countries">
    <h4>Countries <span class="muted" style="font-weight:400">${res.items.length ? `photos in each, of ${fmtNum(located)} located` : ''}</span></h4>
    ${body}
  </div>`;
}

const CONTINENT_NAMES = {
  EU: 'Europe', AS: 'Asia', AF: 'Africa', NA: 'North America', SA: 'South America', OC: 'Oceania', AN: 'Antarctica',
};

/** Share of the world's countries and territories (GeoNames counts 250). */
const worldPct = (w) => {
  const pct = w.total ? (w.visited / w.total) * 100 : 0;
  return `${pct >= 1 ? Math.round(pct) : pct.toFixed(1)}%`;
};

/** The scratch-map view: how much of each continent has a photo in it. */
function continentChart(res) {
  const rows = res.continents
    .filter((c) => c.visited || c.code !== 'AN')
    .sort((a, b) => b.visited / b.total - a.visited / a.total)
    .map((c) => hbar(`${CONTINENT_NAMES[c.code]} · ${c.visited} of ${c.total}`, c.visited, c.total)).join('');
  return `<div class="chart">
    <h4>Seen of the world <span class="muted" style="font-weight:400">${fmtNum(res.world.visited)} of ${fmtNum(res.world.total)} countries and territories · ${worldPct(res.world)}</span></h4>
    ${rows}
  </div>`;
}

function card(label, value) {
  return `<div class="card"><div class="k">${label}</div><div class="v">${value}</div></div>`;
}

function barChart(title, items, labelFor, fixedLength, keyAt) {
  const lookup = new Map(items);
  const keys = fixedLength
    ? Array.from({ length: fixedLength }, (_, i) => keyAt(i))
    : items.map(([k]) => k);
  const values = keys.map((k) => lookup.get(k) || 0);
  const max = Math.max(1, ...values);
  const bars = values.map((v, i) => `<div class="b" style="height:${(v / max) * 100}%" title="${escapeHtml(labelFor(keys[i]))}: ${fmtNum(v)}"></div>`).join('');
  const labels = keys.map((k) => `<span>${escapeHtml(labelFor(k))}</span>`).join('');
  return `<div class="chart"><h4>${title}</h4><div class="bars">${bars}</div><div class="bar-labels">${labels}</div></div>`;
}

/** Bar width is the share of `total`, so the bars read as percentages. */
function hbar(name, value, total) {
  const pct = total ? (value / total) * 100 : 0;
  return `<div class="hbar">
    <span title="${escapeHtml(name)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(name)}</span>
    <span class="track"><span class="fill" style="width:${pct.toFixed(2)}%"></span></span>
    <span class="n">${pct >= 0.1 ? pct.toFixed(1) : '<0.1'}% <span class="muted">(${fmtNum(value)})</span></span>
  </div>`;
}
