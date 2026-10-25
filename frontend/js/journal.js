// Daily notes: one entry per calendar day, each carrying where that day was.
import { api, guard } from './api.js';
import { state, on, emit, fmtNum } from './state.js';
import { el, toast, escapeHtml, stripTags } from './ui.js';
import { flyToPhoto, pickLocation } from './mapview.js';

// Every day exists, whether or not anything was written in it, so the list is
// unbounded backwards. Only what has been written comes from the server; the
// empty days between are made locally, a page at a time as you scroll.
const PAGE = 30;

const AUTOSAVE_MS = 2500;

// Show only the days that have something written, newest first, instead of every
// day back to the beginning of time with the empty ones among them.
let onlyWritten = false;

let notes = new Map();
let loaded = false;
let dirty = false;
let anchor = null;
let shown = 0;
let autoTimer = null;
let pending = null;

const view = () => el('journal');

// ------------------------------------------------------------------ rich text

// Entries are HTML now, so nothing that comes back out of the database is
// trusted: it is rebuilt from this whitelist. Nothing here can carry an
// attribute, so there is no href, no src and no on* handler to abuse.
// S and STRIKE are the same thing; which one you get for a strikethrough is up
// to the browser, and Chrome still emits the older tag.
const ALLOWED = /^(B|STRONG|I|EM|U|S|STRIKE|UL|OL|LI|BR|DIV|P)$/;

// Walked as a live list rather than a snapshot, because unwrapping a tag moves
// its children up to this level and those children have not been checked yet.
// Scrubbing them where they used to be - inside the tag that was just removed -
// only ever looked one level too deep, so anything wrapped in a tag that was
// not on the list came through whole: `<span><img src=x onerror=...></span>`
// lost the span and kept the img, handler and all. Notes are put back on the
// page with innerHTML, and the paste handler runs this over whatever the
// clipboard holds, so that was one copied paragraph away from running.
function scrub(node) {
  let child = node.firstChild;
  while (child) {
    if (child.nodeType === Node.TEXT_NODE) { child = child.nextSibling; continue; }
    if (child.nodeType !== Node.ELEMENT_NODE) {
      const next = child.nextSibling;
      child.remove();
      child = next;
      continue;
    }
    if (!ALLOWED.test(child.tagName)) {
      // Carry on from the first node it was hiding, so each one is tested in
      // its own right; an empty tag just goes.
      const next = child.firstChild || child.nextSibling;
      child.replaceWith(...child.childNodes);
      child = next;
      continue;
    }
    [...child.attributes].forEach((attr) => child.removeAttribute(attr.name));
    scrub(child);
    child = child.nextSibling;
  }
}

/** Parsed through DOMParser rather than a real element on purpose: the document
 *  it returns is inert, so an `<img onerror>` in the input never gets the chance
 *  to run while it is being taken apart. */
function clean(html) {
  const doc = new DOMParser().parseFromString(html ?? '', 'text/html');
  scrub(doc.body);
  return doc.body.innerHTML;
}

/** An "empty" entry is not an empty string: a contenteditable left blank still
 *  holds a <br>, and saving that would keep a day nobody wrote in. */
const isBlank = (html) => stripTags(html) === '';

const SHORTCUTS = { b: 'bold', i: 'italic', u: 'underline' };
// Keyed on the physical key rather than the character, because the character
// these produce depends on the layout: shift-7 is "&" on a US keyboard.
const SHIFT_SHORTCUTS = {
  Digit7: 'insertOrderedList',
  Digit8: 'insertUnorderedList',
  KeyX: 'strikeThrough',
};

function onKeys(e) {
  if (!e.target.matches('.day-text')) return;

  // Leaves the note the way Enter leaves a form field, which also saves it -
  // and keeps Escape from reaching the handlers that clear the photo selection
  // or cancel a map pick.
  if (e.key === 'Escape') {
    e.stopPropagation();
    e.target.blur();
    return;
  }
  if (e.key === 'Tab') { nest(e); return; }

  const combo = e.ctrlKey || e.metaKey;
  if (combo && e.shiftKey && SHIFT_SHORTCUTS[e.code]) {
    e.preventDefault();
    document.execCommand(SHIFT_SHORTCUTS[e.code]);
    return;
  }
  if (combo && SHORTCUTS[e.key.toLowerCase()]) {
    e.preventDefault();
    document.execCommand(SHORTCUTS[e.key.toLowerCase()]);
    return;
  }
  if (e.key === ' ') autoList(e);
}

/** Tab makes a sub-point, shift-Tab promotes one back.
 *
 *  Only inside a list. Everywhere else `indent` wraps the line in a blockquote
 *  carrying the indent as a style attribute, and every attribute is stripped on
 *  the way into the database - so the indent would look right until the day was
 *  saved and then vanish. Outside a list Tab keeps its usual job of moving to
 *  the next control, which is also the only way out of the note by keyboard. */
function nest(e) {
  const selection = document.getSelection();
  if (!selection.rangeCount) return;
  const node = selection.getRangeAt(0).startContainer;
  const at = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  if (!at?.closest('li')) return;
  e.preventDefault();
  document.execCommand(e.shiftKey ? 'outdent' : 'indent');
}

/** "- " or "1. " at the start of a line becomes a real list, the way a word
 *  processor does it. The marker is removed first so it does not end up as
 *  text inside the bullet it just created. */
function autoList(e) {
  const selection = document.getSelection();
  if (!selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE || !range.collapsed) return;
  if (node.parentElement.closest('li')) return; // already in a list

  const before = node.textContent.slice(0, range.startOffset);
  const bullet = /^\s*([-*])$/.exec(before);
  const numbered = /^\s*(\d+\.)$/.exec(before);
  if (!bullet && !numbered) return;

  e.preventDefault();
  const marker = (bullet || numbered)[1];
  const start = range.startOffset - marker.length;
  node.textContent = node.textContent.slice(0, start) + node.textContent.slice(range.startOffset);

  const caret = document.createRange();
  caret.setStart(node, start);
  caret.collapse(true);
  selection.removeAllRanges();
  selection.addRange(caret);
  document.execCommand(bullet ? 'insertUnorderedList' : 'insertOrderedList');
}

/** Local date, not UTC: a journal day is the day you lived, not the day in
 *  Greenwich. Photo timestamps are handled separately, on their own scale. */
function today() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

const DAY_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
});

const asDate = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

const heading = (day) => DAY_FMT.format(asDate(day));

function shift(day, byDays) {
  const date = asDate(day);
  date.setUTCDate(date.getUTCDate() + byDays);
  return date.toISOString().slice(0, 10);
}

export function initJournal() {
  view().addEventListener('focusout', (e) => {
    if (!e.target.matches('.day-text')) return;
    clearTimeout(autoTimer);
    pending = null;
    save(e.target.closest('.day').dataset.day, e.target.innerHTML);
    // A re-render held back while you were typing can happen now.
    if (dirty) { dirty = false; setTimeout(render, 0); }
  });
  // An entry only reached the database when the caret left it, so an afternoon
  // of writing was one closed tab away from being gone.
  view().addEventListener('input', (e) => {
    if (!e.target.matches('.day-text')) return;
    pending = e.target;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(autosave, AUTOSAVE_MS);
  });
  view().addEventListener('keydown', onKeys);
  // Pasting from anywhere else arrives as a document's worth of markup.
  view().addEventListener('paste', (e) => {
    if (!e.target.matches('.day-text')) return;
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertHTML', false, html ? clean(html) : escapeHtml(text));
  });
  view().addEventListener('click', onClick);
  view().addEventListener('scroll', () => {
    if (view().scrollTop + view().clientHeight > view().scrollHeight - 400) more();
  });
  el('journal-date').addEventListener('change', (e) => {
    if (e.target.value) openDay(e.target.value);
  });
  el('journal-today').addEventListener('click', () => openDay(today()));
  el('journal-written').addEventListener('change', (e) => {
    onlyWritten = e.target.checked;
    // Leaving the caret in a card would defer the redraw this has to make now.
    if (document.activeElement?.matches?.('.day-text')) document.activeElement.blur();
    dirty = false;
    render();
  });

  on('journalShown', () => { if (!loaded) load(); else render(); });
  // The search box filters photos; letting it filter the journal too keeps one
  // box meaning one thing.
  on('filters', () => { if (state.view === 'journal' && loaded) render(); });
}

async function load() {
  try {
    const list = await api.get('/api/days');
    notes = new Map(list.map((d) => [d.day, d]));
    loaded = true;
    render();
  } catch (err) {
    view().innerHTML = `<div class="muted">Could not load the journal: ${escapeHtml(err.message)}</div>`;
  }
}

const entry = (day) => notes.get(day) || { day, text: '' };

// ------------------------------------------------------------------ rendering

function render() {
  // Rebuilding the list replaces every textarea, which would throw away
  // whatever is being typed in one. Wait for the caret to leave.
  if (view().contains(document.activeElement) && document.activeElement.matches('.day-text')) {
    dirty = true;
    return;
  }
  anchor = anchor || today();
  view().innerHTML = '';
  view().scrollTop = 0;
  shown = 0;

  // A search is a search of what was written, not a walk back through empty
  // days, so it drops the continuum and lists only the matches.
  const query = (state.filters.q || '').trim().toLowerCase();
  if (query) {
    const hits = [...notes.values()]
      .filter((d) => stripTags(d.text).toLowerCase().includes(query) || d.day.includes(query))
      .sort((a, b) => (a.day < b.day ? 1 : -1));
    view().innerHTML = hits.map((d) => card(d, d.day === today())).join('')
      || '<div class="muted">Nothing written matches that search.</div>';
    paintCount(hits.length);
    return;
  }

  el('journal-today').classList.toggle('hidden', anchor === today());
  more();
  paintCount();
}

/** Append the next page of days. Appending, not re-rendering: a rebuild would
 *  destroy any card already being typed into further up the list. */
function more() {
  if (!loaded || (state.filters.q || '').trim()) return;
  if (onlyWritten) {
    // From the day being looked at and back: the same walk the full list makes,
    // taking only the days that hold something.
    const list = [...notes.values()].filter((d) => d.day <= anchor)
      .sort((a, b) => (a.day < b.day ? 1 : -1));
    const page = list.slice(shown, shown + PAGE);
    shown += page.length;
    if (!list.length) {
      view().innerHTML = '<div class="muted">No days with notes yet.</div>';
      return;
    }
    view().insertAdjacentHTML('beforeend', page.map((d) => card(d, d.day === today())).join(''));
    return;
  }
  const html = [];
  for (let i = 0; i < PAGE; i += 1) {
    const day = shift(anchor, -(shown + i));
    html.push(card(entry(day), day === today()));
    if (shown + i === 0 && anchor === today()) html.push('<div class="day-divider"><span>Earlier</span></div>');
  }
  shown += PAGE;
  view().insertAdjacentHTML('beforeend', html.join(''));
}

function paintCount(hits) {
  const query = (state.filters.q || '').trim();
  el('journal-count').textContent = query && hits != null
    ? `${fmtNum(hits)} of ${fmtNum(notes.size)} written days`
    : `${fmtNum(notes.size)} ${notes.size === 1 ? 'day' : 'days'} written`;
}

function card(day, isToday) {
  return `
    <article class="day${isToday ? ' today' : ''}${day.text ? '' : ' empty'}" data-day="${day.day}">
      <header>${header(day, isToday)}</header>
      <div class="day-text" contenteditable="true" role="textbox" aria-multiline="true"
        data-placeholder="What happened…">${clean(day.text || '')}</div>
    </article>`;
}

function header(day, isToday) {
  return `
    <h4>${escapeHtml(heading(day.day))}</h4>
    <span class="muted small">${isToday ? 'today' : day.day}</span>
    <span class="day-state muted small"></span>
    <span class="spacer"></span>
    ${placeChip(day)}
    <button class="btn tiny" data-act="here" title="Use this device's position">Use my location</button>
    <button class="btn tiny" data-act="pick" title="Click a spot on the map">Set on map</button>
    ${day.lat != null ? '<button class="btn tiny" data-act="map">Show on map</button>' : ''}`;
}

function placeChip(day) {
  if (day.lat == null) return '<span class="muted small">no location</span>';
  const where = `${day.lat.toFixed(4)}, ${day.lon.toFixed(4)}`;
  const how = { device: 'this device', photo: 'nearest photo', picked: 'picked on map' }[day.loc_src] || 'unknown';
  return `<span class="chip" title="Located by ${how}">${where} · ${how}</span>`;
}

// ------------------------------------------------------------------- actions

async function onClick(e) {
  const button = e.target.closest('button[data-act]');
  if (!button) return;
  const card = button.closest('.day');
  const day = entry(card.dataset.day);

  if (button.dataset.act === 'map' && day.lat != null) {
    emit('showMap');
    flyToPhoto(day.lat, day.lon);
    return;
  }
  if (button.dataset.act === 'here') { locate(card); return; }
  if (button.dataset.act === 'pick') {
    const text = card.querySelector('.day-text').innerHTML;
    emit('showMap');
    const at = await pickLocation();
    emit('showJournal');
    if (at) save(card.dataset.day, text, { lat: at.lat, lon: at.lng, src: 'picked' });
  }
}

/** Quiet: it never nags. If the browser has already been told no, it does not
 *  ask again, and any failure just leaves the server's nearest-photo fallback
 *  to do the job. Browser geolocation also needs a secure context, so over
 *  plain HTTP this only works on this computer, not from a phone on the LAN. */
async function autoLocate() {
  if (!navigator.geolocation) return null;
  try {
    const permission = await navigator.permissions?.query({ name: 'geolocation' });
    if (permission?.state === 'denied') return null;
  } catch { /* no permissions API: just ask */ }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 6000, maximumAge: 300000 },
    );
  });
}

function locate(card) {
  const text = card.querySelector('.day-text').innerHTML;
  if (!navigator.geolocation) { toast('This browser has no location support', true); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => save(card.dataset.day, text,
      { lat: pos.coords.latitude, lon: pos.coords.longitude, src: 'device' }),
    (err) => toast(`Location unavailable: ${err.message} - try Set on map`, true),
    { enableHighAccuracy: true, timeout: 8000 },
  );
}

/** The pending edit, on the timer set by every keystroke. Quiet: no toast and
 *  no map redraw, because this runs while you are still typing. */
function autosave() {
  const box = pending;
  pending = null;
  if (box?.isConnected) save(box.closest('.day').dataset.day, box.innerHTML, undefined, true);
}

/** Says which way the last keystroke went without a toast for each one. */
function flash(card, text) {
  const slot = card.querySelector('.day-state');
  if (!slot) return;
  slot.textContent = text;
  clearTimeout(slot.timer);
  if (text) slot.timer = setTimeout(() => { slot.textContent = ''; }, 1600);
}

async function save(day, html, place, quiet = false) {
  const existing = notes.get(day);
  const text = isBlank(html) ? '' : clean(html);
  const unchanged = existing ? existing.text === text : !text;
  if (unchanged && !place) return;

  // Location is never something to remember to do. If the day has none yet,
  // the device is asked before saving; failing that the server places it by the
  // photo nearest in time. The explicit buttons only override the result.
  if (text && !place && !existing?.lat) {
    const at = await autoLocate();
    if (at) place = { lat: at.lat, lon: at.lon, src: 'device' };
  }
  // A save with no location tells the server to place the day by the photo
  // nearest in time - which would quietly undo one you had set on the map, on
  // every edit to the text. So a location it already has is sent back with it.
  if (!place && existing?.lat != null) {
    place = { lat: existing.lat, lon: existing.lon, src: existing.loc_src };
  }

  const card = view().querySelector(`.day[data-day="${day}"]`);
  if (card) flash(card, 'Saving…');
  const saved = await guard(
    api.put(`/api/days/${day}`, { text, lat: place?.lat, lon: place?.lon, loc_src: place?.src }),
    'Could not save the day',
  );
  if (saved.text) notes.set(day, saved); else notes.delete(day);

  // Only this card is touched, and only the parts that changed. A full render
  // would replace every textarea on the page, including one you may have just
  // moved the caret into; rebuilding the header would take the caret out of a
  // button and wipe the indicator on every autosave.
  if (card) {
    card.classList.toggle('empty', !saved.text);
    if (saved.lat !== existing?.lat || saved.loc_src !== existing?.loc_src) {
      card.querySelector('header').innerHTML = header(saved, day === today());
    }
    const box = card.querySelector('.day-text');
    if (box !== document.activeElement) box.innerHTML = clean(saved.text || '');
    flash(card, saved.text ? 'Saved' : '');
  }
  paintCount();
  // Redrawing the note pins means re-fetching every day, which is not something
  // to do between two keystrokes.
  if (!quiet || place) emit('dayNoteSaved');
}

/** Jump the list to an arbitrary day rather than scrolling back to it. */
function openDay(day) {
  // Jumping is explicit, so it must not be swallowed by the guard that defers a
  // redraw while a card has the caret. Leaving the field first also saves it.
  if (document.activeElement?.matches?.('.day-text')) document.activeElement.blur();
  dirty = false;
  anchor = day;
  render();
  const card = view().querySelector(`.day[data-day="${day}"]`);
  if (card) card.querySelector('.day-text').focus();
}
