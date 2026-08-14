// Light / dark. The choice lives in two places on purpose: the database, so it
// follows you to the phone and the tablet, and localStorage, so the page can
// stamp <html> before the first paint instead of flashing the other theme.
import { api } from './api.js';
import { state, emit, on } from './state.js';

const KEY = 'pm-theme';
const media = window.matchMedia('(prefers-color-scheme: light)');

export const themeChoice = () => localStorage.getItem(KEY) || 'auto';

const resolve = (choice) => (choice === 'auto' ? (media.matches ? 'light' : 'dark') : choice);

function paint(choice) {
  const mode = resolve(choice);
  document.documentElement.dataset.theme = mode;
  emit('theme', mode);
}

export function initTheme() {
  // The database is the shared answer; localStorage is only the fast one.
  const stored = state.config?.settings?.theme;
  if (stored && stored !== themeChoice()) localStorage.setItem(KEY, stored);
  paint(themeChoice());
  media.addEventListener('change', () => {
    if (themeChoice() === 'auto') paint('auto');
  });

  // The button always names what you would get, not what you have, and it
  // commits to a side: half of using a switch is knowing it stayed switched.
  const button = document.getElementById('btn-theme');
  button.addEventListener('click', () => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  on('theme', (mode) => {
    button.textContent = mode === 'dark' ? '☀' : '☾';
    button.title = mode === 'dark' ? 'Switch to light' : 'Switch to dark';
  });
  emit('theme', document.documentElement.dataset.theme);
}

export function setTheme(choice) {
  localStorage.setItem(KEY, choice);
  paint(choice);
  api.post('/api/config/settings', { theme: choice });
}
