import { api } from './api.js';
import { state, on, emit, fmtNum } from './state.js';
import { el, toast } from './ui.js';
import { initMap, refreshMapSize, fitToSelection } from './mapview.js';
import { initGallery } from './gallery.js';
import { initTimeline } from './timeline.js';
import { initSidebar, refreshAll, pickAlbumDialog } from './sidebar.js';
import { initLightbox } from './lightbox.js';
import { initInsights } from './insights.js';
import { initLibrary, openSettings } from './library.js';
import { initCloud } from './cloud.js';
import { initDupes } from './dupes.js';
import { initJournal } from './journal.js';
import { initTheme } from './theme.js';
import { setFavorite, deleteDialog, fixLocationsDialog, setLocationDialog } from './actions.js';

// ------------------------------------------------------------------- views

function showView(name) {
  state.view = name;
  closeDrawer();
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${name}`));
  if (name === 'map') refreshMapSize();
  if (name === 'gallery') emit('galleryShown');
  if (name === 'journal') emit('journalShown');
  if (name === 'insights') emit('insightsShown');
  if (name === 'dupes') emit('dupesShown');
}

// ---------------------------------------------------------- sidebar drawer

function closeDrawer() {
  el('sidebar').classList.remove('open');
  el('scrim').classList.add('hidden');
}

function wireDrawer() {
  el('btn-menu').addEventListener('click', () => {
    const open = el('sidebar').classList.toggle('open');
    el('scrim').classList.toggle('hidden', !open);
  });
  el('scrim').addEventListener('click', closeDrawer);
  // Picking an album is a "take me there" action: get out of the way.
  el('album-list').addEventListener('click', (e) => {
    if (e.target.closest('li[data-id]') && !e.target.dataset.act) closeDrawer();
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 860) closeDrawer();
    refreshMapSize();
  });
}

// --------------------------------------------------------------- selection

function updateSelbar() {
  const count = state.selection.size;
  el('selbar').classList.toggle('hidden', count === 0);
  el('sel-count').textContent = `${fmtNum(count)} selected`;
}

function wireSelection() {
  on('toggleSelect', (id) => {
    if (state.selection.has(id)) state.selection.delete(id);
    else state.selection.add(id);
    emit('selection');
  });
  on('selectMany', (ids) => {
    ids.forEach((id) => state.selection.add(id));
    emit('selection');
  });
  on('selection', updateSelbar);

  el('sel-clear').onclick = () => { state.selection.clear(); emit('selection'); };
  el('sel-album').onclick = () => pickAlbumDialog([...state.selection]);
  el('sel-fav').onclick = () => setFavorite([...state.selection], true);
  el('sel-locfix').onclick = () => fixLocationsDialog([...state.selection]);
  el('sel-setloc').onclick = () => setLocationDialog([...state.selection]);
  el('sel-delete').onclick = () => deleteDialog([...state.selection]);
  el('sel-map').onclick = () => {
    showView('map');
    if (!fitToSelection()) toast('None of the selected photos have GPS data');
  };
}

// ------------------------------------------------------------------- boot

async function main() {
  state.config = await api.get('/api/config');

  initMap();
  // After the map exists, so the basemap can follow the theme on first paint.
  initTheme();
  initGallery();
  initTimeline();
  initSidebar();
  initLightbox();
  initInsights();
  initLibrary();
  initCloud();
  initDupes();
  initJournal();
  wireSelection();
  wireDrawer();

  document.querySelector('.tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) showView(tab.dataset.view);
  });
  on('showMap', () => showView('map'));
  on('showJournal', () => showView('journal'));

  document.addEventListener('keydown', (e) => {
    // isContentEditable, not a selector: without it the single-letter view
    // shortcuts fire while writing, so typing "gjim" in a journal note walked
    // through four tabs instead of putting four letters in the note.
    if (e.target.matches('input, select, textarea') || e.target.isContentEditable) return;
    if (e.key === 'Escape' && state.selection.size) {
      state.selection.clear();
      emit('selection');
    }
    if (e.key === 'g') showView('gallery');
    if (e.key === 'm') showView('map');
    if (e.key === 'i') showView('insights');
    if (e.key === 'j') showView('journal');
  });

  await refreshAll();
  emit('filters');

  if (!state.config.roots.length) {
    toast('Add your photo folder to get started');
    openSettings();
  }
}

main().catch((err) => toast(`Startup failed: ${err.message}`, true));
