// Auth and object-serving checks for the snapshot Worker.
// Run: node tests/test_worker.mjs
import worker from '../worker/src/worker.js';

const PASSWORD = 'correct horse battery staple';

const sha256Hex = async (value) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const OBJECTS = {
  'index.html': '<!DOCTYPE html><title>viewer</title>',
  'manifest.json': '{"v":1,"n":2}',
  'manifest.webmanifest': '{"name":"Photo Map"}',
  'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'sw.js': 'self.addEventListener("fetch", () => {});',
  't/abc123.jpg': 'JPEGBYTES',
};

const PUTS = [];

const env = {
  PASSWORD_HASH: await sha256Hex(PASSWORD),
  SESSION_SECRET: 'a-long-random-session-secret-for-tests',
  BUCKET: {
    async put(key, body) {
      PUTS.push({ key, body: JSON.parse(body) });
    },
    async head(key) {
      return PUTS.some((p) => p.key === key) ? { key } : null;
    },
    async delete(key) {
      const i = PUTS.findIndex((p) => p.key === key);
      if (i >= 0) PUTS.splice(i, 1);
    },
    async get(key) {
      if (!(key in OBJECTS)) return null;
      const body = OBJECTS[key];
      return {
        body,
        httpEtag: `"etag-${key}"`,
        writeHttpMetadata(headers) {
          headers.set('Content-Type', key.endsWith('.jpg') ? 'image/jpeg'
            : key.endsWith('.json') ? 'application/json' : 'text/html');
        },
      };
    },
  },
};

const results = [];
function check(label, condition, detail = '') {
  results.push(condition);
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail && !condition ? ` -> ${detail}` : ''}`);
}

const call = (path, init) => worker.fetch(new Request(`https://x.workers.dev${path}`, init), env);
const login = (password) => call('/__login', {
  method: 'POST',
  body: new URLSearchParams({ password }),
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
});

// --- unauthenticated ---------------------------------------------------------
let res = await call('/');
check('no cookie -> 401 login page', res.status === 401, `got ${res.status}`);
check('login page is HTML', (res.headers.get('Content-Type') || '').includes('text/html'));
const bodyText = await res.text();
check('login page does not leak objects', !bodyText.includes('viewer'));

res = await call('/manifest.json');
check('manifest blocked without cookie', res.status === 401, `got ${res.status}`);
res = await call('/t/abc123.jpg');
check('thumbnail blocked without cookie', res.status === 401, `got ${res.status}`);

// The browser fetches these without cookies to decide if the app is installable.
res = await call('/manifest.webmanifest');
check('web manifest served without cookie', res.status === 200, `got ${res.status}`);
res = await call('/icon.svg');
check('icon served without cookie', res.status === 200, `got ${res.status}`);
res = await call('/manifest.webmanifest', { method: 'POST' });
check('public assets are read-only', res.status === 401, `got ${res.status}`);
res = await call('/sw.js');
check('service worker still needs a session', res.status === 401, `got ${res.status}`);

// --- wrong password ----------------------------------------------------------
const started = Date.now();
res = await login('wrong password');
const elapsed = Date.now() - started;
check('wrong password -> 401', res.status === 401, `got ${res.status}`);
check('wrong password sets no cookie', !res.headers.get('Set-Cookie'));
check('wrong password is delayed', elapsed >= 500, `${elapsed}ms`);

// --- correct password --------------------------------------------------------
res = await login(PASSWORD);
const setCookie = res.headers.get('Set-Cookie') || '';
check('correct password -> 303 redirect', res.status === 303, `got ${res.status}`);
check('session cookie issued', setCookie.startsWith('pm_session='));
check('cookie is HttpOnly', setCookie.includes('HttpOnly'));
check('cookie is Secure', setCookie.includes('Secure'));
check('cookie is SameSite=Lax', setCookie.includes('SameSite=Lax'));

const cookie = setCookie.split(';')[0];
const withAuth = (path, extra = {}) => call(path, { headers: { Cookie: cookie, ...extra } });

// --- authenticated -----------------------------------------------------------
res = await withAuth('/');
check('root serves the viewer', res.status === 200, `got ${res.status}`);
check('viewer body is index.html', (await res.text()).includes('viewer'));

res = await withAuth('/manifest.json');
check('manifest served with cookie', res.status === 200, `got ${res.status}`);
check('manifest is no-cache', (res.headers.get('Cache-Control') || '').includes('no-cache'));

res = await withAuth('/t/abc123.jpg');
const cacheControl = res.headers.get('Cache-Control') || '';
check('thumbnail served with cookie', res.status === 200, `got ${res.status}`);
check('thumbnail cached immutably', cacheControl.includes('immutable'), cacheControl);
check('thumbnail cache is private', cacheControl.includes('private'), cacheControl);
check('nosniff header set', res.headers.get('X-Content-Type-Options') === 'nosniff');

res = await withAuth('/t/abc123.jpg', { 'If-None-Match': '"etag-t/abc123.jpg"' });
check('conditional request -> 304', res.status === 304, `got ${res.status}`);

res = await withAuth('/missing.json');
check('unknown key -> 404', res.status === 404, `got ${res.status}`);

// --- cookie forgery ----------------------------------------------------------
const [expiry, signature] = cookie.replace('pm_session=', '').split('.');
const forged = async (value, label) => {
  const r = await call('/', { headers: { Cookie: `pm_session=${value}` } });
  check(label, r.status === 401, `got ${r.status}`);
};
await forged(`${expiry}.${'0'.repeat(signature.length)}`, 'zeroed signature rejected');
await forged(`${Number(expiry) + 86400000}.${signature}`, 'extended expiry rejected');
await forged(`${Date.now() - 1000}.${await (async () => 'x'.repeat(64))()}`, 'expired cookie rejected');
await forged(expiry, 'malformed cookie rejected');
await forged('', 'empty cookie rejected');

// A cookie signed with a different secret must not validate.
const otherEnv = { ...env, SESSION_SECRET: 'a-different-secret-entirely' };
const otherLogin = await worker.fetch(
  new Request('https://x.workers.dev/__login', {
    method: 'POST',
    body: new URLSearchParams({ password: PASSWORD }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }),
  otherEnv,
);
const otherCookie = (otherLogin.headers.get('Set-Cookie') || '').split(';')[0];
res = await call('/', { headers: { Cookie: otherCookie } });
check('cookie from another secret rejected', res.status === 401, `got ${res.status}`);

// --- misc --------------------------------------------------------------------
// The URL parser collapses %2e%2e/ itself, so that form never reaches the guard
// and simply misses the bucket. An encoded slash survives parsing and does.
res = await withAuth('/%2e%2e/etc/passwd');
check('normalized traversal is a harmless miss', res.status === 404, `got ${res.status}`);
res = await withAuth('/a/%2e%2e%2fb');
check('encoded-slash traversal -> 400', res.status === 400, `got ${res.status}`);

res = await call('/', { method: 'POST', headers: { Cookie: cookie } });
check('POST to a normal path -> 405', res.status === 405, `got ${res.status}`);

// --- write-back endpoint -----------------------------------------------------
const change = (body, extra = {}) => call('/api/change', {
  method: 'POST',
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...extra },
  body: JSON.stringify(body),
});

res = await call('/api/change', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ op: 'favorite', photo_ids: [1], value: true }),
});
check('change without a session is rejected', res.status === 401, `got ${res.status}`);

PUTS.length = 0;
res = await change({ op: 'favorite', photo_ids: [1, 2], value: true });
check('favourite change is queued', res.status === 202, `got ${res.status}`);
check('queued into the inbox prefix', PUTS.length === 1 && PUTS[0].key.startsWith('inbox/'), JSON.stringify(PUTS[0]?.key));
check('queued body round-trips', PUTS[0]?.body?.op === 'favorite');

res = await change({ op: 'drop_database', photo_ids: [1] });
check('unknown operation refused', res.status === 400, `got ${res.status}`);

res = await change({ op: 'dupe_resolve', hash: 'abc' });
check('dupe_resolve without keep_id refused', res.status === 400, `got ${res.status}`);

res = await change({ op: 'dupe_resolve', hash: 'abc', keep_id: 7 });
check('valid dupe_resolve accepted', res.status === 202, `got ${res.status}`);

res = await change({ op: 'photo_note', photo_ids: [7], note: 'broken bike' });
check('photo_note accepted', res.status === 202, `got ${res.status}`);

res = await change({ op: 'photo_note', photo_ids: [7], note: '' });
check('empty note accepted (it clears one)', res.status === 202, `got ${res.status}`);

res = await change({ op: 'photo_note', photo_ids: [], note: 'x' });
check('photo_note without ids refused', res.status === 400, `got ${res.status}`);

res = await change({ op: 'photo_note', photo_ids: [7] });
check('photo_note without a note refused', res.status === 400, `got ${res.status}`);

res = await change({ op: 'photo_note', photo_ids: [7], note: 123 });
check('non-string note refused', res.status === 400, `got ${res.status}`);

res = await change({ op: 'photo_note', photo_ids: [7], note: 'x'.repeat(4001) });
check('over-long note refused', res.status === 413, `got ${res.status}`);

res = await change({ op: 'album_add', album_id: 1, photo_ids: Array.from({ length: 6000 }, (_, i) => i) });
check('oversized change refused', res.status === 413, `got ${res.status}`);

res = await call('/api/change', {
  method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: 'not json',
});
check('malformed body refused', res.status === 400, `got ${res.status}`);

// --- delete validation -------------------------------------------------------
res = await change({ op: 'photo_delete', photo_ids: [1, 2], confirm_count: 2 });
check('well-formed delete accepted', res.status === 202, `got ${res.status}`);

res = await change({ op: 'photo_delete', photo_ids: [1, 2], confirm_count: 3 });
check('delete with a mismatched count refused', res.status === 400, `got ${res.status}`);

res = await change({ op: 'photo_delete', photo_ids: [1, 2] });
check('delete without a count refused', res.status === 400, `got ${res.status}`);

res = await change({ op: 'photo_delete', photo_ids: [], confirm_count: 0 });
check('delete of nothing refused', res.status === 400, `got ${res.status}`);

const tooMany = Array.from({ length: 201 }, (_, i) => i);
res = await change({ op: 'photo_delete', photo_ids: tooMany, confirm_count: tooMany.length });
check('delete over the 200 cap refused', res.status === 413, `got ${res.status}`);

// --- undo --------------------------------------------------------------------
PUTS.length = 0;
res = await change({ op: 'photo_delete', photo_ids: [9], confirm_count: 1 });
const queuedKey = (await res.json()).key;
check('delete queued and key returned', !!queuedKey && PUTS.length === 1);

const cancel = (key) => call('/api/change/cancel', {
  method: 'POST',
  headers: { Cookie: cookie, 'Content-Type': 'application/json' },
  body: JSON.stringify({ key }),
});

res = await cancel(queuedKey);
check('undo removes the queued change', res.status === 200 && PUTS.length === 0, `got ${res.status}, ${PUTS.length} left`);

res = await cancel(queuedKey);
check('undoing twice reports it already went', res.status === 409, `got ${res.status}`);

res = await cancel('t/abc123.jpg');
check('undo cannot target a non-inbox key', res.status === 400, `got ${res.status}`);

res = await call('/api/change/cancel', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'inbox/x.json' }),
});
check('undo without a session refused', res.status === 401, `got ${res.status}`);

res = await call('/__logout', { headers: { Cookie: cookie } });
check('logout redirects', res.status === 302, `got ${res.status}`);
check('logout clears the cookie', (res.headers.get('Set-Cookie') || '').includes('Max-Age=0'));

res = await worker.fetch(new Request('https://x.workers.dev/'), { BUCKET: env.BUCKET });
check('missing secrets -> 500, not open access', res.status === 500, `got ${res.status}`);

const failed = results.filter((r) => !r).length;
console.log(`\n${failed ? `${failed} of ${results.length} FAILED` : `ALL ${results.length} WORKER CHECKS PASSED`}`);
process.exit(failed ? 1 : 0);
