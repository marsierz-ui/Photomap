// Listening history from Spotify beside the photos: what was playing when a
// photo was taken, the day's most played, and a small player that plays it.
//
// Playback is Spotify's own embed, driven through its iFrame API. Its script is
// loaded from open.spotify.com the first time something is played, not before,
// so nothing reaches Spotify for people who never press play. The embed plays
// whole tracks for someone signed in to Spotify in this browser, and short
// previews otherwise. Plays from Spotify's one-year account data carry no track
// id, so those can be named but not played.
import { api, guard } from './api.js';
import { emit, fmtNum, fmtDate } from './state.js';
import { toast, confirmModal, escapeHtml } from './ui.js';

const API_SRC = 'https://open.spotify.com/embed/iframe-api/v1';
const cache = new Map();
let status = null;
let controller = null;
let loading = null;
let box = null;
let current = null;
let pending = false;

/** What was playing when a photo was taken and the day's most played, or null
 *  when there is no listening history at all. */
export async function musicFor(photoId) {
  if (status === null) {
    try { status = await api.get('/api/music'); } catch { status = { plays: 0 }; }
  }
  if (!status.plays) return null;
  if (!cache.has(photoId)) cache.set(photoId, api.get(`/api/photos/${photoId}/music`).catch(() => null));
  return cache.get(photoId);
}

/** The track worth playing for a photo: the one playing then, else the day's favourite. */
export function pick(m) {
  if (!m) return null;
  if (m.now?.uri) return { ...m.now, why: 'playing when this was taken' };
  const top = m.day.find((t) => t.uri);
  return top ? { ...top, why: 'most played that day' } : null;
}

export const label = (t) => `${t.track}${t.artist ? ` - ${t.artist}` : ''}`;

function ensurePlayer() {
  if (loading) return loading;
  box = document.createElement('div');
  box.className = 'music-player';
  box.innerHTML = '<div class="music-embed"></div><button class="icon-btn" data-act="close" title="Stop and close">✕</button>';
  document.body.appendChild(box);
  box.querySelector('[data-act=close]').onclick = () => {
    controller?.pause();
    box.classList.add('hidden');
    current = null;
  };
  loading = new Promise((resolve, reject) => {
    // Spotify calls this once its script has loaded; it has to exist first.
    window.onSpotifyIframeApiReady = (IFrameAPI) => {
      IFrameAPI.createController(box.querySelector('.music-embed'), { width: '100%', height: 80 }, (c) => {
        controller = c;
        // play() before the new track has loaded does nothing, so it waits.
        c.addListener('ready', () => { if (pending) { pending = false; c.play(); } });
        resolve(c);
      });
    };
    const script = document.createElement('script');
    script.src = API_SRC;
    script.async = true;
    script.onerror = () => { loading = null; reject(new Error('Spotify could not be reached')); };
    document.body.appendChild(script);
  });
  return loading;
}

/** Play a track in the mini player; the same track keeps playing. */
export async function play(track) {
  if (!track?.uri) return;
  let c;
  try { c = await ensurePlayer(); } catch (err) { toast(err.message, true); return; }
  box.classList.remove('hidden');
  if (current === track.uri) return;
  current = track.uri;
  pending = true;
  c.loadUri(track.uri);
  c.play();
}

export function pause() { controller?.pause(); }

// ------------------------------------------------------------------ settings

export function musicBlock() {
  return `<div class="muted small" style="margin:14px 0 6px">Music
    <span style="opacity:.8">- your Spotify listening history beside the photos: the song playing when each was taken,
    and the day's most played, played back during Replay. In Spotify: Account, Privacy settings, Download your data,
    tick <em>Extended streaming history</em> (the whole account, with playable tracks; Spotify takes up to 30 days to
    send it). <em>Account data</em> comes sooner but covers one year and its songs cannot be played back. Import the
    .zip or the .json files.</span></div>
    <div id="s-music" class="small"></div>
    <div class="actions" style="justify-content:flex-start;margin:6px 0 0">
      <label class="btn tiny">Import…<input type="file" id="s-music-file" multiple accept=".zip,.json" hidden></label>
      <button class="btn tiny ghost" data-act="music-clear">Remove listening history</button>
    </div>`;
}

export function wireMusic(root) {
  const slot = root.querySelector('#s-music');
  const render = async () => {
    status = await api.get('/api/music');
    if (!slot.isConnected) return;
    slot.innerHTML = status.plays
      ? `${fmtNum(status.plays)} plays, ${fmtDate(status.first)} to ${fmtDate(status.last)} · ${fmtNum(status.playable)} playable`
      : '<span class="muted">None imported yet</span>';
  };
  render();
  root.querySelector('#s-music-file').addEventListener('change', async (e) => {
    for (const file of e.target.files) {
      toast(`Reading ${file.name}…`);
      try {
        const res = await fetch(`/api/music/import?name=${encodeURIComponent(file.name)}`, {
          method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' },
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.detail || res.statusText);
        toast(`${file.name}: ${fmtNum(body.added)} new plays`);
      } catch (err) {
        toast(`${file.name}: ${err.message}`, true);
      }
    }
    e.target.value = '';
    cache.clear();
    render();
  });
  root.querySelector('[data-act=music-clear]').onclick = async () => {
    if (!await confirmModal('Remove listening history', 'Every imported play goes. The files you imported are not touched.', 'Remove')) return;
    await guard(api.del('/api/music'), 'Failed');
    cache.clear();
    status = null;
    emit('openSettings');
  };
}

/** The lightbox's Music line: the song playing when the photo was taken, or
 *  the day's most played, with a play button when it can be played. */
export async function musicLine(photoId, slot) {
  const m = await musicFor(photoId);
  if (!m || !slot.isConnected || (!m.now && !m.day.length)) return;
  const shown = m.now || m.day[0];
  const t = pick(m);
  slot.innerHTML = `<span class="k">Music</span> ${escapeHtml(label(shown))}
    <span class="k">(${m.now ? 'playing then' : 'most played that day'})</span>
    ${t ? `<button data-act="music" title="Play ${escapeHtml(label(t))}, ${escapeHtml(t.why)}">▶</button>` : ''}`;
  slot.classList.remove('hidden');
  const btn = slot.querySelector('[data-act=music]');
  if (btn) btn.onclick = (e) => { e.stopPropagation(); play(t); };
}
