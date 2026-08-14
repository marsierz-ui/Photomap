import { api } from './api.js';
import { state, params, on, fmtNum, fmtBytes, fmtDate } from './state.js';
import { el, escapeHtml } from './ui.js';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function initInsights() {
  on('insightsShown', render);
  on('filters', () => { if (state.view === 'insights') render(); });
}

async function render() {
  const target = el('insights');
  const [stats, hour, dow, month, year] = await Promise.all([
    api.get('/api/stats', params()),
    api.get('/api/dist', params({ extra: { field: 'hour' } })),
    api.get('/api/dist', params({ extra: { field: 'dow' } })),
    api.get('/api/dist', params({ extra: { field: 'month' } })),
    api.get('/api/dist', params({ extra: { field: 'year' } })),
  ]);

  const geoPct = stats.total ? Math.round((stats.geo / stats.total) * 100) : 0;
  target.innerHTML = `
    <div class="cards">
      ${card('Photos', fmtNum(stats.total))}
      ${card('With location', `${fmtNum(stats.geo)} <span class="muted" style="font-size:13px">(${geoPct}%)</span>`)}
      ${card('On disk', fmtBytes(stats.bytes))}
      ${card('First photo', fmtDate(stats.first_ts))}
      ${card('Latest photo', fmtDate(stats.last_ts))}
      ${stats.missing ? card('Missing files', fmtNum(stats.missing)) : ''}
    </div>
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
