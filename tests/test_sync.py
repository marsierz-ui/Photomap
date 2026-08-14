"""Exercise the full sync pipeline against a mock S3 endpoint.

Verifies delta uploads, manifest correctness, prune-on-delete and the
credential-change reset, without touching a real R2 bucket.
"""
import datetime
import hashlib
import http.server
import json
import shutil
import sys
import tempfile
import threading
import time
import urllib.parse
import zlib
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT))

TMP = Path(tempfile.mkdtemp(prefix="photomap_sync_"))
PHOTOS = TMP / "photos"
DATA = TMP / "data"
PHOTOS.mkdir(parents=True)
DATA.mkdir(parents=True)

from backend import db  # noqa: E402

db.DATA_DIR = DATA
db.DB_PATH = DATA / "photomap.db"
db.THUMB_DIR = DATA / "thumbs"
db.TRASH_DIR = DATA / "trash"

from PIL import Image  # noqa: E402

from backend import scanner, snapshot, sync  # noqa: E402

# --------------------------------------------------------------- mock S3 server

STORE: dict[str, bytes] = {}
REQUESTS: list[tuple[str, str]] = []
LOCK = threading.Lock()


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _key(self):
        path = urllib.parse.urlsplit(self.path).path
        return urllib.parse.unquote(path.lstrip("/").split("/", 1)[1]) if "/" in path.lstrip("/") else ""

    def _auth_ok(self):
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("AWS4-HMAC-SHA256 Credential="):
            return False
        return "SignedHeaders=" in auth and "Signature=" in auth

    def do_PUT(self):
        if not self._auth_ok():
            self.send_error(403, "bad auth")
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        # The signed payload hash must describe the body actually sent.
        if hashlib.sha256(body).hexdigest() != self.headers.get("x-amz-content-sha256"):
            self.send_error(400, "content hash mismatch")
            return
        with LOCK:
            STORE[self._key()] = body
            REQUESTS.append(("PUT", self._key()))
        self.send_response(200)
        self.send_header("ETag", f'"{hashlib.md5(body).hexdigest()}"')
        self.end_headers()

    def do_DELETE(self):
        if not self._auth_ok():
            self.send_error(403, "bad auth")
            return
        with LOCK:
            STORE.pop(self._key(), None)
            REQUESTS.append(("DELETE", self._key()))
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if not self._auth_ok():
            self.send_error(403, "bad auth")
            return
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        prefix = query.get("prefix", [""])[0]
        with LOCK:
            keys = sorted(k for k in STORE if k.startswith(prefix))
            REQUESTS.append(("LIST", prefix))
        items = "".join(
            f"<Contents><Key>{k}</Key><Size>{len(STORE[k])}</Size></Contents>" for k in keys
        )
        xml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
            f"<IsTruncated>false</IsTruncated>{items}</ListBucketResult>"
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/xml")
        self.send_header("Content-Length", str(len(xml)))
        self.end_headers()
        self.wfile.write(xml)


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
PORT = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()

_real_client = sync.client


def fake_client():
    bucket = _real_client()
    bucket.scheme = "http"
    bucket.host = f"127.0.0.1:{PORT}"
    return bucket


sync.client = fake_client

# ------------------------------------------------------------------- fixtures


def deg(value):
    d = int(abs(value))
    m = int((abs(value) - d) * 60)
    return (float(d), float(m), round((abs(value) - d - m / 60) * 3600, 3))


def make_photo(name, when, lat=None, lon=None):
    # Deterministic colour: Python's hash() is salted per process, which would
    # make thumbnails collide (and correctly dedupe) at random between runs.
    tint = zlib.crc32(name.encode())
    img = Image.new("RGB", (90, 70), (tint % 200, (tint >> 8) % 200, (tint >> 16) % 200))
    exif = Image.Exif()
    exif[271] = "SyncCam"
    exif[306] = when.strftime("%Y:%m:%d %H:%M:%S")
    exif[0x8769] = {36867: when.strftime("%Y:%m:%d %H:%M:%S")}
    if lat is not None:
        exif[0x8825] = {
            1: "N" if lat >= 0 else "S", 2: deg(lat),
            3: "E" if lon >= 0 else "W", 4: deg(lon),
        }
    img.save(PHOTOS / name, exif=exif.tobytes())


base = datetime.datetime(2024, 5, 1, 9, 0, 0)
for i in range(8):
    make_photo(f"geo_{i:02d}.jpg", base + datetime.timedelta(hours=i), 48.85 + i * 0.01, 2.29 + i * 0.01)
for i in range(3):
    make_photo(f"nogeo_{i:02d}.jpg", base + datetime.timedelta(days=40, hours=i))

db.init()
db.add_root(str(PHOTOS))
db.set_setting("sync_on_scan", "0")  # drive sync explicitly in this test
# This test covers the map-only snapshot. Whole-library scope, including the
# gallery and write-back, is covered by test_writeback.py.
db.set_setting("snapshot_scope", "located")
scanner.start()
while scanner.status()["running"]:
    time.sleep(0.1)
print(f"indexed: {scanner.status()['added']} photos")

db.set_setting("r2_account_id", "testaccount")
db.set_setting("r2_bucket", "photomap")
db.set_setting("r2_access_key_id", "AKIDTEST")
db.set_setting("r2_secret_key", "secrettestkey")
assert sync.configured(), "config should be complete"


def run_sync(full=False):
    if full:
        sync.reset_remote_state()
    assert sync.start(), "sync should start"
    while sync.status()["running"]:
        time.sleep(0.05)
    state = sync.status()
    assert state["phase"] == "done", f"sync failed: {state['error']}"
    return state


def fail(message):
    print(f"\nFAILED: {message}")
    sys.exit(1)


# 1. first sync uploads everything
REQUESTS.clear()
first = run_sync()
puts = [k for m, k in REQUESTS if m == "PUT"]
print(f"\n1. first sync   uploaded={first['uploaded']} points={first['points']} bytes={first['bytes']}")
print(f"   objects in bucket: {len(STORE)}  ({sum(1 for k in STORE if k.startswith('t/'))} thumbs)")
if first["points"] != 8:
    fail(f"expected 8 located points, got {first['points']}")
if "manifest.json" not in STORE:
    fail("manifest.json was not uploaded")
if sum(1 for k in STORE if k.startswith("t/")) != 8:
    fail("expected 8 thumbnails")

manifest = json.loads(STORE["manifest.json"])
print(f"   manifest: n={manifest['n']} bounds={[round(b, 3) for b in manifest['bounds']]}"
      f" total_photos={manifest['total_photos']} located={manifest['located']}")
if len(manifest["lat"]) != 8 or len(manifest["th"]) != 8:
    fail("manifest columns are the wrong length")
if manifest["total_photos"] != 11:
    fail(f"total_photos should count all 11 photos, got {manifest['total_photos']}")
for digest in manifest["th"]:
    if snapshot.thumb_key(digest) not in STORE:
        fail(f"manifest references missing thumbnail {digest}")

# 2. re-sync with no changes: only the manifest should move
REQUESTS.clear()
second = run_sync()
puts = [k for m, k in REQUESTS if m == "PUT"]
print(f"\n2. no-change sync  uploaded={second['uploaded']} skipped={second['skipped']} PUTs={puts}")
if puts != ["manifest.json"]:
    fail(f"a no-change sync should rewrite only the manifest, got {puts}")
if second["skipped"] != 8:
    fail(f"expected 8 thumbnails skipped, got {second['skipped']}")

# 3. adding a photo uploads exactly one new thumbnail
make_photo("geo_new.jpg", base + datetime.timedelta(hours=20), 51.5, -0.12)
scanner.start()
while scanner.status()["running"]:
    time.sleep(0.1)
REQUESTS.clear()
third = run_sync()
puts = [k for m, k in REQUESTS if m == "PUT"]
print(f"\n3. one new photo   uploaded={third['uploaded']} points={third['points']} PUTs={len(puts)}")
if len(puts) != 2:
    fail(f"expected 1 thumbnail + manifest, got {puts}")
if third["points"] != 9:
    fail(f"expected 9 points, got {third['points']}")

# 4. identical photos share one object (content addressing)
shutil.copy(PHOTOS / "geo_00.jpg", PHOTOS / "geo_00_copy.jpg")
scanner.start()
while scanner.status()["running"]:
    time.sleep(0.1)
REQUESTS.clear()
fourth = run_sync()
puts = [k for m, k in REQUESTS if m == "PUT"]
print(f"\n4. duplicate photo uploaded={fourth['uploaded']} points={fourth['points']} PUTs={puts}")
if fourth["points"] != 10:
    fail(f"the duplicate should still be a map point, got {fourth['points']}")
if puts != ["manifest.json"]:
    fail(f"a duplicate should reuse the existing thumbnail, got {puts}")

# 5. deleting photos prunes their thumbnails
(PHOTOS / "geo_01.jpg").unlink()
(PHOTOS / "geo_02.jpg").unlink()
scanner.start()
while scanner.status()["running"]:
    time.sleep(0.1)
REQUESTS.clear()
fifth = run_sync()
deletes = [k for m, k in REQUESTS if m == "DELETE"]
print(f"\n5. deleted 2 photos  points={fifth['points']} pruned={fifth['deleted']} thumbs left={sum(1 for k in STORE if k.startswith('t/'))}")
if fifth["deleted"] != 2:
    fail(f"expected 2 pruned objects, got {fifth['deleted']}")
if fifth["points"] != 8:
    fail(f"expected 8 points after deletions, got {fifth['points']}")
manifest = json.loads(STORE["manifest.json"])
for digest in manifest["th"]:
    if snapshot.thumb_key(digest) not in STORE:
        fail("manifest references a pruned thumbnail")

# 6. pointing at a different bucket forces a full re-upload.
# Unique thumbnails, not points: content addressing collapses the duplicate.
unique_thumbs = len(set(json.loads(STORE["manifest.json"])["th"]))
viewer = [key for key, _ in sync.viewer_files()]
expected = unique_thumbs + 1 + len(viewer)
sync.reset_remote_state()
REQUESTS.clear()
sixth = run_sync()
puts = [k for m, k in REQUESTS if m == "PUT"]
print(f"\n6. after reset     re-uploaded={sixth['uploaded']} PUTs={len(puts)}"
      f" (expected {expected}: {unique_thumbs} unique thumbs + manifest"
      f" + {len(viewer)} viewer files)")
if len(puts) != expected:
    fail(f"a reset should re-upload {expected} objects, got {len(puts)}: {puts}")
for name in viewer:
    if name not in STORE:
        fail(f"viewer file {name} was not uploaded")

# 6b. the installable files have to be there for the app to install at all
for required in ("index.html", "sw.js", "manifest.webmanifest"):
    if required not in STORE:
        fail(f"{required} is missing from the bucket")
print(f"   viewer files in bucket: {', '.join(sorted(viewer))}")

# 7. a viewer file only re-uploads when its own bytes change
REQUESTS.clear()
seventh = run_sync()
puts = [k for m, k in REQUESTS if m == "PUT"]
print(f"\n7. unchanged viewer  PUTs={puts}")
if puts != ["manifest.json"]:
    fail(f"unchanged viewer files should not re-upload, got {puts}")

# 8. bad credentials surface as an error, not a crash
db.set_setting("r2_secret_key", "")
if sync.configured():
    fail("configured() should be False with an empty secret")
db.set_setting("r2_secret_key", "secrettestkey")

print(f"\nfinal bucket: {len(STORE)} objects, "
      f"{sum(len(v) for v in STORE.values()) / 1024:.1f} KB")
print("manifest keys:", sorted(k for k in STORE if not k.startswith("t/")))
print("\nALL SYNC CHECKS PASSED")

server.shutdown()
shutil.rmtree(TMP, ignore_errors=True)
