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
const MULTIPART = new Map();

const env = {
  PASSWORD_HASH: await sha256Hex(PASSWORD),
  SESSION_SECRET: 'a-long-random-session-secret-for-tests',
  BUCKET: {
    async put(key, body, options) {
      // Image uploads arrive as bytes, ops as JSON strings. Only the JSON is
      // parsed, so the existing assertions keep reading `body` as an object.
      const isText = typeof body === 'string';
      PUTS.push({
        key,
        body: isText ? JSON.parse(body) : null,
        size: isText ? body.length : body.byteLength,
        type: options?.httpMetadata?.contentType,
      });
    },
    async list({ prefix = '' } = {}) {
      return {
        objects: PUTS.filter((p) => p.key.startsWith(prefix))
          .map((p) => ({ key: p.key, size: p.size })),
        truncated: false,
      };
    },
    async head(key) {
      return PUTS.some((p) => p.key === key) ? { key } : null;
    },
    async delete(key) {
      const i = PUTS.findIndex((p) => p.key === key);
      if (i >= 0) PUTS.splice(i, 1);
    },
    // R2's multipart upload, which is how anything larger than a Worker can
    // receive gets into the bucket. The Worker keeps no state between the
    // calls: the id and the part etags come back from the client each time.
    async createMultipartUpload(key) {
      const uploadId = `up-${MULTIPART.size + 1}`;
      MULTIPART.set(uploadId, { key, parts: new Map(), done: false });
      return { key, uploadId };
    },
    resumeMultipartUpload(key, uploadId) {
      return {
        key,
        uploadId,
        async uploadPart(partNumber, body) {
          const open = MULTIPART.get(uploadId);
          if (!open) throw new Error('no such upload');
          open.parts.set(partNumber, body.byteLength);
          return { partNumber, etag: `etag-${partNumber}` };
        },
        async complete(parts) {
          const open = MULTIPART.get(uploadId);
          if (!open) throw new Error('no such upload');
          const sizes = [...open.parts.entries()].sort((a, b) => a[0] - b[0]);
          // R2 refuses to stitch an upload whose middle parts differ in size,
          // and it refuses it here - after every byte has been paid for.
          const middle = sizes.slice(0, -1).map(([, n]) => n);
          if (new Set(middle).size > 1) throw new Error('parts differ in size');
          if (parts.some((p) => !open.parts.has(p.partNumber))) throw new Error('missing part');
          open.done = true;
          PUTS.push({ key: open.key, body: null,
                      size: sizes.reduce((n, [, size]) => n + size, 0), type: null });
          return { key: open.key };
        },
        async abort() { MULTIPART.delete(uploadId); },
      };
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

// --- adding photos from a phone ---------------------------------------------

const b64url = (text) => Buffer.from(text, 'utf8').toString('base64url');
const bytesOf = (n, fill = 7) => new Uint8Array(n).fill(fill);
const digestOf = async (bytes) => Buffer.from(
  await crypto.subtle.digest('SHA-256', bytes),
).toString('hex');

const upload = (bytes, meta, path = '/api/import') => call(path, {
  method: 'POST',
  headers: { Cookie: cookie, 'X-Photo-Meta': b64url(JSON.stringify(meta)) },
  body: bytes,
});

const proxy = bytesOf(2048);
const proxyHash = await digestOf(proxy);

res = await upload(proxy, { name: 'IMG_1.JPG', ext: '.jpg', bytes: 4_000_000,
                            proxy_sha256: proxyHash });
let body = await res.json();
check('a valid proxy is accepted', res.status === 202, `got ${res.status} ${JSON.stringify(body)}`);
const iid = body.iid;
check('the id is a worker-generated ms-epoch and uuid',
      /^\d{13}-[0-9a-f-]{36}$/.test(iid || ''), String(iid));
check('the image goes under import/, never inbox/',
      PUTS.some((p) => p.key === `import/${iid}.jpg` && p.type === 'image/jpeg'));
const op = PUTS.find((p) => p.key === `inbox/${iid}.json`);
check('an op is written for the desktop to find', !!op);
check('the op is photo_import with the matching id',
      op?.body?.op === 'photo_import' && op?.body?.uid === iid, JSON.stringify(op?.body));
check('the op carries a millisecond queued_ts',
      String(op?.body?.queued_ts || '').length === 13, String(op?.body?.queued_ts));
check('the image object was written before the op',
      PUTS.findIndex((p) => p.key === `import/${iid}.jpg`)
      < PUTS.findIndex((p) => p.key === `inbox/${iid}.json`));

// The hash guard: this is the check that a string-only sha256 helper would have
// broken, by digesting every upload to the same constant.
res = await upload(proxy, { proxy_sha256: 'f'.repeat(64) });
check('a proxy whose hash does not match is refused', res.status === 422, `got ${res.status}`);
res = await upload(bytesOf(2048, 9), { proxy_sha256: proxyHash });
check('different bytes really do hash differently', res.status === 422, `got ${res.status}`);

res = await upload(bytesOf(0), { proxy_sha256: proxyHash });
check('an empty body is refused', res.status === 400, `got ${res.status}`);
res = await upload(bytesOf(3 * 1024 * 1024), { proxy_sha256: proxyHash });
check('an oversized preview is refused', res.status === 413, `got ${res.status}`);
res = await call('/api/import', { method: 'POST', headers: { Cookie: cookie }, body: proxy });
check('a missing metadata header is refused', res.status === 400, `got ${res.status}`);
res = await call('/api/import', { method: 'POST', body: proxy });
check('uploading without a session is refused', res.status === 401, `got ${res.status}`);

res = await upload(proxy, { proxy_sha256: proxyHash, bytes: 200 * 1024 * 1024 });
check('a photo over the per-photo cap is refused up front', res.status === 413, `got ${res.status}`);

// The original, under the same id.
const original = bytesOf(9000, 3);
const originalHash = await digestOf(original);
res = await upload(original, { sha256: originalHash }, `/api/import/full?iid=${iid}`);
check('the original is accepted under the same id', res.status === 202, `got ${res.status}`);
check('it lands as import/<id>.orig', PUTS.some((p) => p.key === `import/${iid}.orig`));

res = await upload(original, { sha256: 'a'.repeat(64) }, `/api/import/full?iid=${iid}`);
check('an original whose hash does not match is refused', res.status === 422, `got ${res.status}`);
res = await upload(original, { sha256: originalHash },
                   `/api/import/full?iid=1700000000000-${'0'.repeat(8)}-0000-0000-0000-000000000000`);
check('an original with no proxy already there is refused', res.status === 409, `got ${res.status}`);
res = await upload(original, { sha256: originalHash }, '/api/import/full?iid=../../etc');
check('a malformed id is refused', res.status === 400, `got ${res.status}`);

res = await call('/api/import/state', { headers: { Cookie: cookie } });
body = await res.json();
check('the viewer can ask how full the queue is', res.status === 200 && body.quota > 0,
      JSON.stringify(body));
check('pending counts the bytes actually stored', body.pending > 0, JSON.stringify(body));
check('the queue is not full yet', body.full === false, JSON.stringify(body));

// Fill it past the ceiling and confirm the refusal is a 507 the viewer can act
// on, rather than a silent failure or an accepted upload that fills the tier.
PUTS.push({ key: 'import/huge.orig', body: null, size: 5 * 1024 * 1024 * 1024 });
res = await upload(proxy, { proxy_sha256: proxyHash, bytes: 1000 });
body = await res.json();
check('a full queue refuses new photos with 507', res.status === 507, `got ${res.status}`);
check('and says so in a way the viewer can show', body.full === true && body.pending > 0,
      JSON.stringify(body));
res = await upload(original, { sha256: originalHash }, `/api/import/full?iid=${iid}`);
check('a full queue also refuses originals, not just previews',
      res.status === 507, `got ${res.status}`);
res = await call('/api/import/state', { headers: { Cookie: cookie } });
check('and the state endpoint reports it full', (await res.json()).full === true);
PUTS.splice(PUTS.findIndex((p) => p.key === 'import/huge.orig'), 1);

// --- a video, which does not fit in one request ------------------------------
//
// The largest body a Worker can receive is 100MB on the Free and Pro plans, and
// a minute of 4K is more than that, so a clip goes up as an R2 multipart upload:
// begin, one request per part, then finish. The parts land in the bucket as they
// arrive, which is what makes a dropped connection cost one part rather than the
// whole clip.

const clipProxy = bytesOf(4096, 5);
const clipProxyHash = await digestOf(clipProxy);
res = await upload(clipProxy, { name: 'VID_1.mp4', ext: '.mp4', bytes: 200 * 1024 * 1024,
                                proxy_sha256: clipProxyHash });
body = await res.json();
check('a clip larger than the photo cap is accepted for upload', res.status === 202,
      `got ${res.status} ${JSON.stringify(body)}`);
const clipId = body.iid;

res = await upload(bytesOf(2048), { name: 'VID_2.mp4', ext: '.mp4',
                                    bytes: 400 * 1024 * 1024,
                                    proxy_sha256: await digestOf(bytesOf(2048)) });
check('but not one past the video cap', res.status === 413, `got ${res.status}`);

res = await upload(clipProxy, { name: 'IMG.jpg', ext: '.jpg', bytes: 200 * 1024 * 1024,
                                proxy_sha256: clipProxyHash });
check('and a photo that size is still refused', res.status === 413, `got ${res.status}`);

res = await upload(new Uint8Array(0), { sha256: 'a'.repeat(64), bytes: 20 * 1024 * 1024, ext: '.mp4' },
                   `/api/import/begin?iid=${clipId}`);
body = await res.json();
check('an upload can be begun', res.status === 200 && !!body.uploadId, JSON.stringify(body));
check('and it names the part size the Worker will accept',
      body.part_bytes === 8 * 1024 * 1024, JSON.stringify(body));
const uploadId = body.uploadId;
const partPath = (n, last) =>
  `/api/import/part?iid=${clipId}&uploadId=${uploadId}&part=${n}${last ? '&last=1' : ''}`;

const partOne = bytesOf(body.part_bytes, 1);
res = await upload(partOne, { sha256: await digestOf(partOne) }, partPath(1));
body = await res.json();
check('a full-size part is accepted', res.status === 200 && body.etag, JSON.stringify(body));

res = await upload(partOne, { sha256: 'b'.repeat(64) }, partPath(2));
check('a part whose hash does not match is refused', res.status === 422, `got ${res.status}`);

const short = bytesOf(1024, 2);
res = await upload(short, { sha256: await digestOf(short) }, partPath(2));
check('a middle part of the wrong size is refused before R2 sees it',
      res.status === 400, `got ${res.status}`);

res = await upload(short, { sha256: await digestOf(short) }, partPath(2, true));
check('the same part as the last one is accepted', res.status === 200, `got ${res.status}`);

res = await call(`/api/import/finish?iid=${clipId}&uploadId=${uploadId}`, {
  method: 'POST',
  headers: { Cookie: cookie, 'X-Photo-Meta': b64url(JSON.stringify({ sha256: 'c'.repeat(64) })) },
  body: JSON.stringify({ parts: [{ partNumber: 1, etag: 'etag-1' }, { partNumber: 2, etag: 'etag-2' }] }),
});
check('finishing stitches the parts into one object', res.status === 202, `got ${res.status}`);
check('which lands as import/<id>.orig, like any other original',
      PUTS.some((p) => p.key === `import/${clipId}.orig`));

res = await call(`/api/import/part?iid=${clipId}&uploadId=${uploadId}&part=0`, {
  method: 'POST',
  headers: { Cookie: cookie, 'X-Photo-Meta': b64url(JSON.stringify({ sha256: 'd'.repeat(64) })) },
  body: partOne,
});
check('part numbers start at one', res.status === 400, `got ${res.status}`);

res = await upload(new Uint8Array(0), { sha256: 'a'.repeat(64), bytes: 1000, ext: '.mp4' },
                   `/api/import/begin?iid=1700000000000-${'0'.repeat(8)}-0000-0000-0000-000000000000`);
check('an upload cannot be begun for an id with no proxy', res.status === 409, `got ${res.status}`);

res = await call('/api/import/begin?iid=../../etc', {
  method: 'POST',
  headers: { Cookie: cookie, 'X-Photo-Meta': b64url(JSON.stringify({ sha256: 'a'.repeat(64) })) },
  body: new Uint8Array(0),
});
check('a malformed id cannot begin one either', res.status === 400, `got ${res.status}`);

res = await call(`/api/import/part?iid=${clipId}&uploadId=${uploadId}&part=1`, { method: 'POST', body: partOne });
check('parts need a session too', res.status === 401, `got ${res.status}`);

// An abandoned multipart upload is not an object, so nothing that lists the
// bucket can see it - which is why there has to be a way to give it back.
res = await upload(new Uint8Array(0), { sha256: 'e'.repeat(64), bytes: 20 * 1024 * 1024, ext: '.mp4' },
                   `/api/import/begin?iid=${clipId}`);
const doomed = (await res.json()).uploadId;
res = await call(`/api/import/abort?iid=${clipId}&uploadId=${doomed}`, {
  method: 'POST',
  headers: { Cookie: cookie, 'X-Photo-Meta': b64url(JSON.stringify({ sha256: 'e'.repeat(64) })) },
  body: new Uint8Array(0),
});
check('an abandoned upload can be given back', res.status === 200, `got ${res.status}`);
check('and it is gone from the bucket', !MULTIPART.has(doomed));

res = await call('/api/import/state', { headers: { Cookie: cookie } });
body = await res.json();
check('the state endpoint names the video cap and the part size',
      body.video_max_bytes === 256 * 1024 * 1024 && body.part_bytes === 8 * 1024 * 1024,
      JSON.stringify(body));

// --- a day written on a phone ------------------------------------------------

res = await change({ op: 'day_write', day: '2024-03-08', text: '<p>hello</p>' });
check('a journal day is queued for the desktop', res.status === 202, `got ${res.status}`);
const dayOp = PUTS.filter((p) => p.body?.op === 'day_write').pop();
check('and parked in the inbox like any other change', !!dayOp, JSON.stringify(PUTS.slice(-1)));
check('with its text intact', dayOp?.body?.text === '<p>hello</p>', JSON.stringify(dayOp?.body));

check('a day that is not a date is refused',
      (await change({ op: 'day_write', day: '8th March', text: 'x' })).status === 400);
check('a day with no text at all is refused',
      (await change({ op: 'day_write', day: '2024-03-08' })).status === 400);
check('an entry longer than the cap is refused',
      (await change({ op: 'day_write', day: '2024-03-08', text: 'x'.repeat(20001) })).status === 413);
check('an empty entry is allowed, because that is how a day is cleared',
      (await change({ op: 'day_write', day: '2024-03-08', text: '' })).status === 202);

check('photo_import cannot be injected through the ordinary change route',
      (await change({ op: 'photo_import', uid: 'x' })).status === 400);

res = await call('/__logout', { headers: { Cookie: cookie } });
check('logout redirects', res.status === 302, `got ${res.status}`);
check('logout clears the cookie', (res.headers.get('Set-Cookie') || '').includes('Max-Age=0'));

res = await worker.fetch(new Request('https://x.workers.dev/'), { BUCKET: env.BUCKET });
check('missing secrets -> 500, not open access', res.status === 500, `got ${res.status}`);

const failed = results.filter((r) => !r).length;
console.log(`\n${failed ? `${failed} of ${results.length} FAILED` : `ALL ${results.length} WORKER CHECKS PASSED`}`);
process.exit(failed ? 1 : 0);
