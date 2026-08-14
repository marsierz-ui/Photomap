/**
 * Photo Map snapshot gateway.
 *
 * The R2 bucket stays private: it has no public r2.dev URL and no custom domain.
 * Every object is served through this Worker via an R2 binding, and only after a
 * password check. Cloudflare Access would be the alternative, but it requires a
 * custom domain, which this deliberately does not.
 *
 * Secrets (wrangler secret put ...):
 *   PASSWORD_HASH    lowercase hex SHA-256 of the viewing password
 *   SESSION_SECRET   long random string used to sign session cookies
 */

const COOKIE = 'pm_session';
const SESSION_DAYS = 30;
const LOGIN_DELAY_MS = 600; // blunts online password guessing

// The browser fetches the manifest and its icons without cookies when it works
// out whether the app is installable, so gating them behind the session makes
// the app quietly uninstallable. None of them says anything about the library.
const PUBLIC_KEYS = new Set(['manifest.webmanifest', 'icon.svg', 'apple-touch-icon.png']);

export default {
  async fetch(request, env) {
    if (!env.PASSWORD_HASH || !env.SESSION_SECRET) {
      return text(500, 'Worker is missing PASSWORD_HASH or SESSION_SECRET.');
    }

    const url = new URL(request.url);

    if (url.pathname === '/__login' && request.method === 'POST') {
      return handleLogin(request, env, url);
    }
    if (url.pathname === '/__logout') {
      return new Response(null, {
        status: 302,
        headers: {
          Location: '/',
          'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    }

    const readOnly = request.method === 'GET' || request.method === 'HEAD';
    if (readOnly && PUBLIC_KEYS.has(url.pathname.replace(/^\/+/, ''))) {
      return serveObject(url, env, request);
    }

    if (!(await validSession(request, env))) {
      return loginPage(url.pathname === '/' ? '' : 'Sign in to view this map.', 401);
    }

    if (url.pathname === '/api/change' && request.method === 'POST') {
      return queueChange(request, env);
    }
    if (url.pathname === '/api/change/cancel' && request.method === 'POST') {
      return cancelChange(request, env);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return text(405, 'Method not allowed');
    }
    return serveObject(url, env, request);
  },
};

// ----------------------------------------------------------------------- auth

async function handleLogin(request, env, url) {
  const form = await request.formData();
  const supplied = String(form.get('password') || '');
  const digest = await sha256Hex(supplied);

  if (!timingSafeEqual(digest, String(env.PASSWORD_HASH).trim().toLowerCase())) {
    await new Promise((resolve) => setTimeout(resolve, LOGIN_DELAY_MS));
    return loginPage('That password was not right.', 401);
  }

  const expiry = Date.now() + SESSION_DAYS * 86400_000;
  const cookie = `${expiry}.${await hmacHex(env.SESSION_SECRET, String(expiry))}`;
  return new Response(null, {
    status: 303,
    headers: {
      Location: url.searchParams.get('next') || '/',
      'Set-Cookie':
        `${COOKIE}=${cookie}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

async function validSession(request, env) {
  const header = request.headers.get('Cookie') || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!match) return false;

  const [expiry, signature] = match[1].split('.');
  if (!expiry || !signature) return false;
  if (!Number(expiry) || Number(expiry) < Date.now()) return false;
  return timingSafeEqual(signature, await hmacHex(env.SESSION_SECRET, expiry));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return hex(digest);
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Comparison whose duration does not depend on where the strings differ. */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --------------------------------------------------------------------- changes

// Edits made in the viewer are parked in the bucket; the desktop app drains
// them on its next sync. The Worker never touches the library itself.
const ALLOWED_OPS = new Set([
  'album_add', 'album_remove', 'album_create', 'favorite', 'dupe_resolve', 'photo_delete',
  'photo_note',
]);
const MAX_IDS = 5000;
const DELETE_CAP = 200;
// A note is a caption, not a document. Long enough for anything anyone types on
// a phone, short enough that the inbox cannot be filled with one request.
const NOTE_MAX = 4000;

async function queueChange(request, env) {
  let change;
  try {
    change = await request.json();
  } catch {
    return json(400, { error: 'Body must be JSON' });
  }

  if (!ALLOWED_OPS.has(change.op)) {
    return json(400, { error: `Unsupported operation: ${String(change.op).slice(0, 40)}` });
  }
  if (Array.isArray(change.photo_ids) && change.photo_ids.length > MAX_IDS) {
    return json(413, { error: `At most ${MAX_IDS} photos per change` });
  }
  if (change.op === 'dupe_resolve' && (!change.hash || !change.keep_id)) {
    return json(400, { error: 'dupe_resolve needs hash and keep_id' });
  }
  if (change.op === 'photo_note') {
    if (!Array.isArray(change.photo_ids) || change.photo_ids.length === 0) {
      return json(400, { error: 'photo_note needs photo_ids' });
    }
    if (typeof change.note !== 'string') {
      return json(400, { error: 'photo_note needs a note string' });
    }
    if (change.note.length > NOTE_MAX) {
      return json(413, { error: `A note is limited to ${NOTE_MAX} characters` });
    }
  }
  if (change.op === 'photo_delete') {
    const ids = change.photo_ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return json(400, { error: 'photo_delete needs photo_ids' });
    }
    if (ids.length > DELETE_CAP) {
      return json(413, { error: `At most ${DELETE_CAP} photos can be deleted in one action` });
    }
    // The caller must say how many it means to delete. A mismatch means the
    // request was built wrong, and it is refused rather than partly honoured.
    if (change.confirm_count !== ids.length) {
      return json(400, { error: 'confirm_count must match the number of photos' });
    }
  }

  const key = `inbox/${Date.now()}-${crypto.randomUUID()}.json`;
  await env.BUCKET.put(key, JSON.stringify(change), {
    httpMetadata: { contentType: 'application/json' },
  });
  return json(202, { queued: true, key });
}

/** Undo: drop a queued change before the desktop app has drained it. */
async function cancelChange(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Body must be JSON' });
  }
  const key = String(body.key || '');
  if (!key.startsWith('inbox/') || key.includes('..') || key.length > 200) {
    return json(400, { error: 'Not a queued change' });
  }
  const existing = await env.BUCKET.head(key);
  if (!existing) {
    return json(409, { error: 'Already applied - undo it on the computer instead' });
  }
  await env.BUCKET.delete(key);
  return json(200, { cancelled: true });
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// --------------------------------------------------------------------- objects

async function serveObject(url, env, request) {
  let key = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (key === '' || key.endsWith('/')) key += 'index.html';
  if (key.split('/').includes('..')) return text(400, 'Bad path');

  const object = await env.BUCKET.get(key);
  if (!object) {
    return key === 'index.html'
      ? text(404, 'Nothing synced yet. Run a sync from the Photo Map app.')
      : text(404, 'Not found');
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  // Thumbnails are content-addressed, so they never change under a given name.
  // "private" keeps them in the browser only, never a shared cache.
  headers.set(
    'Cache-Control',
    key.startsWith('t/') ? 'private, max-age=31536000, immutable' : 'private, no-cache',
  );

  if (request.headers.get('If-None-Match') === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}

// ----------------------------------------------------------------------- pages

function text(status, message) {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function loginPage(message, status) {
  const body = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Photo Map</title>
<style>
 body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
      background:#0e1116;color:#e6edf3;font:15px/1.5 system-ui,"Segoe UI",sans-serif}
 form{background:#161b22;border:1px solid #2a323d;border-radius:8px;padding:28px;
      width:min(360px,90vw);text-align:center}
 h1{font-size:18px;margin:0 0 4px} p{color:#8b97a6;font-size:13px;margin:0 0 18px}
 input{width:100%;box-sizing:border-box;background:#1c232d;border:1px solid #2a323d;
       border-radius:6px;padding:11px;color:inherit;font:inherit;margin-bottom:12px}
 button{width:100%;background:#4aa3ff;border:0;border-radius:6px;padding:11px;
        color:#06121f;font:600 15px system-ui;cursor:pointer}
 .msg{color:#ff9ea1;font-size:13px;margin-bottom:12px}
</style></head><body>
<form method="post" action="/__login">
  <h1>Photo Map</h1><p>Private snapshot</p>
  ${message ? `<div class="msg">${escapeHtml(message)}</div>` : ''}
  <input type="password" name="password" placeholder="Password" autofocus
         autocomplete="current-password" autocapitalize="off" spellcheck="false">
  <button type="submit">Unlock</button>
</form></body></html>`;
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
