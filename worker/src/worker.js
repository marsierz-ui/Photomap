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
    if (url.pathname === '/api/import' && request.method === 'POST') {
      return receiveImport(request, env);
    }
    if (url.pathname === '/api/import/full' && request.method === 'POST') {
      return receiveOriginal(request, env);
    }
    if (url.pathname === '/api/import/state' && request.method === 'GET') {
      return importState(env);
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

/** The same digest over raw bytes. Separate from sha256Hex on purpose: that one
 *  runs the value through TextEncoder, which stringifies an ArrayBuffer to
 *  "[object ArrayBuffer]" and would hash every upload to the same constant. */
async function sha256Bytes(buffer) {
  return hex(await crypto.subtle.digest('SHA-256', buffer));
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

// ------------------------------------------------------------------- imports
// A photo picked on a phone arrives as two objects under import/: a small proxy
// first, so the map updates straight away, then the full-resolution original.
// Image bytes never go under inbox/ - the desktop drain JSON-parses everything
// it finds there, and a JPEG would fail to parse on every sync forever.
//
// One photo per request: the maximum request body through a Worker is set by the
// Cloudflare account plan (100 MB on Free and Pro), so a batch in one body is
// not an option.
const IMPORT_MAX_BYTES = 64 * 1024 * 1024;  // covers a 50MB phone photo
const PROXY_MAX_BYTES = 2 * 1024 * 1024;
// The real risk is not one big photo, it is a computer that has not synced for
// weeks. R2's free tier is 10 GB; past this the bucket stops accepting, which
// leaves the snapshot and plenty of headroom. Clearing it is one sync.
const IMPORT_QUOTA_BYTES = 4 * 1024 * 1024 * 1024;
const IMPORT_META_MAX = 4096;
const IMPORT_ID = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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

/** Bytes already waiting for the desktop to collect.
 *
 *  Listing costs one Class A operation against a million-a-month allowance, and
 *  it is the only honest number: the alternative is trusting a counter that
 *  drifts the moment a sync deletes objects behind the Worker's back.
 */
async function pendingBytes(env) {
  let total = 0;
  let cursor;
  do {
    const listed = await env.BUCKET.list({ prefix: 'import/', limit: 1000, cursor });
    for (const object of listed.objects) total += object.size || 0;
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return total;
}

/** Metadata rides in a header so the body stays raw bytes: base64 in a JSON
 *  body would waste a third of the 100 MB a Worker can receive. */
function readMeta(request) {
  const raw = request.headers.get('X-Photo-Meta') || '';
  if (!raw || raw.length > IMPORT_META_MAX) return null;
  try {
    const padded = raw.replace(/-/g, '+').replace(/_/g, '/');
    const text = new TextDecoder().decode(
      Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)),
    );
    const meta = JSON.parse(text);
    return meta && typeof meta === 'object' ? meta : null;
  } catch {
    return null;
  }
}

function quotaResponse(pending) {
  return json(507, {
    error: 'Photos are waiting for your computer to sync. Nothing more can be '
      + 'uploaded until it does.',
    pending,
    quota: IMPORT_QUOTA_BYTES,
    full: true,
  });
}

/** The small proxy, sent first so the photo appears on the map straight away. */
async function receiveImport(request, env) {
  const meta = readMeta(request);
  if (!meta) return json(400, { error: 'Missing or malformed X-Photo-Meta' });
  if (typeof meta.proxy_sha256 !== 'string') {
    return json(400, { error: 'Metadata needs proxy_sha256' });
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return json(400, { error: 'Empty body' });
  if (bytes.byteLength > PROXY_MAX_BYTES) return json(413, { error: 'Preview too large' });
  if (await sha256Bytes(bytes) !== meta.proxy_sha256) {
    return json(422, { error: 'Upload did not arrive intact - try again' });
  }

  // Checked against what this photo will eventually occupy, both halves, so a
  // proxy is never accepted for an original that cannot follow it.
  const claimed = Number(meta.bytes) || bytes.byteLength;
  if (claimed > IMPORT_MAX_BYTES) {
    return json(413, { error: `Photos are limited to ${IMPORT_MAX_BYTES >> 20}MB` });
  }
  const pending = await pendingBytes(env);
  if (pending + claimed > IMPORT_QUOTA_BYTES) return quotaResponse(pending);

  const iid = `${Date.now()}-${crypto.randomUUID()}`;
  await env.BUCKET.put(`import/${iid}.jpg`, bytes, {
    httpMetadata: { contentType: 'image/jpeg' },
  });
  // Written only after the proxy landed, so the desktop never drains an op
  // whose image is missing. The op is synthesised here rather than accepted
  // from the client, which is why photo_import is not in ALLOWED_OPS.
  await env.BUCKET.put(`inbox/${iid}.json`, JSON.stringify({
    op: 'photo_import',
    uid: iid,
    queued_ts: Date.now(),
    name: String(meta.name || '').slice(0, 120),
    ext: String(meta.ext || '').slice(0, 12).toLowerCase(),
    bytes: claimed,
    sha256: typeof meta.sha256 === 'string' ? meta.sha256 : null,
    proxy_sha256: meta.proxy_sha256,
    taken_ts: Number.isFinite(meta.taken_ts) ? meta.taken_ts : null,
    lat: Number.isFinite(meta.lat) ? meta.lat : null,
    lon: Number.isFinite(meta.lon) ? meta.lon : null,
  }), { httpMetadata: { contentType: 'application/json' } });

  return json(202, {
    queued: true, iid, pending: pending + bytes.byteLength, quota: IMPORT_QUOTA_BYTES,
  });
}

/** The full-resolution original, sent after the proxy under the same id. */
async function receiveOriginal(request, env) {
  const url = new URL(request.url);
  const iid = url.searchParams.get('iid') || '';
  if (!IMPORT_ID.test(iid)) return json(400, { error: 'Not an upload id' });

  const meta = readMeta(request);
  if (!meta || typeof meta.sha256 !== 'string') {
    return json(400, { error: 'Metadata needs sha256' });
  }
  // The proxy has to be there first: without it the desktop has an original
  // with no op to describe it, and nothing would ever collect it.
  if (!(await env.BUCKET.head(`import/${iid}.jpg`))) {
    return json(409, { error: 'That upload is not open' });
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return json(400, { error: 'Empty body' });
  if (bytes.byteLength > IMPORT_MAX_BYTES) {
    return json(413, { error: `Photos are limited to ${IMPORT_MAX_BYTES >> 20}MB` });
  }
  if (await sha256Bytes(bytes) !== meta.sha256) {
    return json(422, { error: 'Upload did not arrive intact - try again' });
  }
  // Enforced here too, not only on the proxy: this is the request that carries
  // the bytes that actually fill the bucket.
  const pending = await pendingBytes(env);
  if (pending + bytes.byteLength > IMPORT_QUOTA_BYTES) return quotaResponse(pending);

  await env.BUCKET.put(`import/${iid}.orig`, bytes, {
    httpMetadata: { contentType: 'application/octet-stream' },
  });
  return json(202, {
    stored: true, pending: pending + bytes.byteLength, quota: IMPORT_QUOTA_BYTES,
  });
}

/** What the viewer asks before picking, so it can say the queue is full before
 *  a photo is chosen rather than after it has been read and downscaled. */
async function importState(env) {
  const pending = await pendingBytes(env);
  return json(200, {
    pending,
    quota: IMPORT_QUOTA_BYTES,
    max_bytes: IMPORT_MAX_BYTES,
    full: pending >= IMPORT_QUOTA_BYTES,
  });
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
