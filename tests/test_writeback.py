"""Cloud write-back: changes queued in the bucket are applied locally on sync.

Uses a mock S3 endpoint, so no real R2 account is touched.
"""
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

TMP = Path(tempfile.mkdtemp(prefix="photomap_wb_"))
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

from backend import dupes, scanner, snapshot, sync  # noqa: E402

sync.RECYCLE_OK = False  # keep the OS recycle bin out of the test

STORE: dict[str, bytes] = {}
LOCK = threading.Lock()
failures = []


def check(label, condition, detail=""):
    print(f"{'PASS' if condition else 'FAIL'}  {label}{'' if condition else f' -> {detail}'}")
    if not condition:
        failures.append(label)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _key(self):
        path = urllib.parse.urlsplit(self.path).path.lstrip("/")
        return urllib.parse.unquote(path.split("/", 1)[1]) if "/" in path else ""

    def do_PUT(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if hashlib.sha256(body).hexdigest() != self.headers.get("x-amz-content-sha256"):
            self.send_error(400, "hash mismatch")
            return
        with LOCK:
            STORE[self._key()] = body
        self.send_response(200)
        self.end_headers()

    def do_DELETE(self):
        with LOCK:
            STORE.pop(self._key(), None)
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        key = self._key()
        if key:
            with LOCK:
                body = STORE.get(key)
            if body is None:
                self.send_error(404, "no such key")
                return
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        prefix = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("prefix", [""])[0]
        with LOCK:
            keys = sorted(k for k in STORE if k.startswith(prefix))
        xml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
            "<IsTruncated>false</IsTruncated>"
            + "".join(f"<Contents><Key>{k}</Key></Contents>" for k in keys)
            + "</ListBucketResult>"
        ).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(xml)))
        self.end_headers()
        self.wfile.write(xml)


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
PORT = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()

_real = sync.client


def fake_client():
    b = _real()
    b.scheme = "http"
    b.host = f"127.0.0.1:{PORT}"
    return b


sync.client = fake_client


def make(name, when, lat=None, lon=None):
    tint = zlib.crc32(name.encode())
    img = Image.new("RGB", (120, 90), (tint % 200, (tint >> 8) % 200, (tint >> 16) % 200))
    exif = Image.Exif()
    exif[306] = when
    exif[0x8769] = {36867: when}
    if lat is not None:
        def deg(v):
            d = int(abs(v)); m = int((abs(v) - d) * 60)
            return (float(d), float(m), round((abs(v) - d - m / 60) * 3600, 3))
        exif[0x8825] = {1: "N", 2: deg(lat), 3: "E", 4: deg(lon)}
    img.save(PHOTOS / name, exif=exif.tobytes())


for i in range(6):
    make(f"geo_{i}.jpg", f"2024:05:0{i + 1} 10:00:00", 48.85 + i * 0.01, 2.29 + i * 0.01)
for i in range(3):
    make(f"plain_{i}.jpg", f"2024:06:0{i + 1} 10:00:00")
shutil.copy(PHOTOS / "geo_0.jpg", PHOTOS / "geo_0 (1).jpg")   # a duplicate pair

db.init()
db.add_root(str(PHOTOS))
db.set_setting("sync_on_scan", "0")
db.set_setting("r2_account_id", "acct")
db.set_setting("r2_bucket", "photomap")
db.set_setting("r2_access_key_id", "AKID")
db.set_setting("r2_secret_key", "secret")
scanner.start()
while scanner.status()["running"]:
    time.sleep(0.1)
dupes.start()
while dupes.status()["running"]:
    time.sleep(0.05)
print(f"indexed {scanner.status()['added']} photos, {dupes.summarise()['sets']} duplicate set\n")


def run_sync():
    assert sync.start()
    while sync.status()["running"]:
        time.sleep(0.05)
    s = sync.status()
    assert s["phase"] == "done", f"sync failed: {s['error']}"
    return s


def manifest():
    return json.loads(STORE[snapshot.MANIFEST_KEY])


def queue(change):
    """Stand in for the Worker writing an inbox object."""
    key = f"inbox/{time.time_ns()}.json"
    with LOCK:
        STORE[key] = json.dumps(change).encode()
    return key


# --- manifest v2 -------------------------------------------------------------
run_sync()
m = manifest()
print(f"manifest v{m['v']} scope={m['scope']} n={m['n']} geo={m['geo_n']} "
      f"albums={len(m['albums'])} dupes={len(m['dupes'])}")
check("publishes every photo, not just located ones", m["n"] == 10, f"n={m['n']}")
check("still marks which are located", m["geo_n"] == 7, f"geo_n={m['geo_n']}")
check("carries photo ids for write-back", len(m["ids"]) == m["n"])
check("carries favourite flags", len(m["fav"]) == m["n"])
check("exposes the duplicate set", len(m["dupes"]) == 1, str(m["dupes"]))

# --- favourite round-trip ----------------------------------------------------
target = m["ids"][0]
queue({"op": "favorite", "photo_ids": [target], "value": True})
state = run_sync()
fav = db.connect().execute("SELECT favorite FROM photos WHERE id=?", (target,)).fetchone()["favorite"]
check("favourite from the cloud is applied", fav == 1, f"favorite={fav}")
check("inbox is drained", not [k for k in STORE if k.startswith("inbox/")], str([k for k in STORE if k.startswith('inbox/')]))
check("manifest reflects the new favourite", manifest()["fav"][manifest()["ids"].index(target)] == 1)
check("sync reports what it received", state["received"]["favourites"] == 1, str(state["received"]))

# --- note round-trip ---------------------------------------------------------
queue({"op": "photo_note", "photo_ids": [target], "note": "  broken bike  "})
state = run_sync()
note = db.connect().execute("SELECT note FROM photos WHERE id=?", (target,)).fetchone()["note"]
check("note from the cloud is applied", note == "broken bike", f"note={note!r}")
check("sync reports the note", state["received"]["notes"] == 1, str(state["received"]))
check("manifest publishes the note", manifest()["notes"].get(str(target)) == "broken bike",
      str(manifest()["notes"]))
check("manifest carries filenames to search", len(manifest()["name"]) == manifest()["n"])

queue({"op": "photo_note", "photo_ids": [target], "note": "   "})
run_sync()
cleared = db.connect().execute("SELECT note FROM photos WHERE id=?", (target,)).fetchone()["note"]
check("an empty note clears it to NULL", cleared is None, f"note={cleared!r}")
check("cleared note leaves the manifest", str(target) not in manifest()["notes"],
      str(manifest()["notes"]))

# --- album create and add ----------------------------------------------------
ids = m["ids"][1:4]
queue({"op": "album_create", "name": "From phone", "color": "#00cc88", "photo_ids": ids})
run_sync()
album = db.connect().execute("SELECT id, name FROM albums WHERE name='From phone'").fetchone()
check("album created from the cloud", album is not None)
members = [r["photo_id"] for r in db.connect().execute(
    "SELECT photo_id FROM album_photos WHERE album_id=?", (album["id"],))]
check("album has the photos", sorted(members) == sorted(ids), f"{members} vs {ids}")
check("album appears in the manifest", any(a["name"] == "From phone" for a in manifest()["albums"]))

queue({"op": "album_add", "album_id": album["id"], "photo_ids": [m["ids"][5]]})
run_sync()
count = db.connect().execute(
    "SELECT COUNT(*) c FROM album_photos WHERE album_id=?", (album["id"],)).fetchone()["c"]
check("album_add appends", count == 4, f"count={count}")

queue({"op": "album_remove", "album_id": album["id"], "photo_ids": [m["ids"][5]]})
run_sync()
count = db.connect().execute(
    "SELECT COUNT(*) c FROM album_photos WHERE album_id=?", (album["id"],)).fetchone()["c"]
check("album_remove removes", count == 3, f"count={count}")

# --- replaying a change must not corrupt anything ----------------------------
queue({"op": "album_add", "album_id": album["id"], "photo_ids": [m["ids"][1]]})
run_sync()
count = db.connect().execute(
    "SELECT COUNT(*) c FROM album_photos WHERE album_id=?", (album["id"],)).fetchone()["c"]
check("re-adding an existing member is idempotent", count == 3, f"count={count}")

# --- duplicate removal: the one destructive cloud action ---------------------
dupe = manifest()["dupes"][0]
before = db.connect().execute("SELECT COUNT(*) c FROM photos WHERE missing=0").fetchone()["c"]

queue({"op": "dupe_resolve", "hash": dupe["hash"], "keep_id": 999999})
state = run_sync()
after = db.connect().execute("SELECT COUNT(*) c FROM photos WHERE missing=0").fetchone()["c"]
check("refuses a keeper outside the set", after == before, f"{before} -> {after}")

queue({"op": "dupe_resolve", "hash": dupe["hash"], "keep_id": dupe["keep"]})
state = run_sync()
after = db.connect().execute("SELECT COUNT(*) c FROM photos WHERE missing=0").fetchone()["c"]
survivor = db.connect().execute(
    "SELECT COUNT(*) c FROM photos WHERE content_hash=? AND missing=0", (dupe["hash"],)).fetchone()["c"]
trashed = list((DATA / "trash").glob("*")) if (DATA / "trash").exists() else []
print(f"\nduplicate removal: {before} -> {after} photos, {survivor} survivor, {len(trashed)} in trash")
check("removes exactly the extra copy", after == before - 1, f"{before} -> {after}")
check("one copy survives", survivor == 1, f"{survivor} left")
check("the removed file is recoverable", len(trashed) == 1, f"{len(trashed)} in trash")
check("kept photo still exists", db.connect().execute(
    "SELECT COUNT(*) c FROM photos WHERE id=?", (dupe["keep"],)).fetchone()["c"] == 1)

# --- unknown ops are ignored, not fatal --------------------------------------
queue({"op": "drop_everything", "photo_ids": [1, 2, 3]})
run_sync()
still = db.connect().execute("SELECT COUNT(*) c FROM photos WHERE missing=0").fetchone()["c"]
check("an unrecognised operation changes nothing", still == after, f"{after} -> {still}")

# --- deleting ordinary photos from the cloud ---------------------------------
print("\ndeletion guardrails")
live = db.connect().execute("SELECT COUNT(*) c FROM photos WHERE missing=0").fetchone()["c"]
victims = [r["id"] for r in db.connect().execute(
    "SELECT id FROM photos WHERE missing=0 ORDER BY id LIMIT 2")]

# Off by default: the request is honoured only after this machine opts in.
check("delete is off by default", db.get_setting("cloud_delete_enabled", "0") == "0")
queue({"op": "photo_delete", "photo_ids": victims, "confirm_count": len(victims)})
run_sync()
now = db.connect().execute("SELECT COUNT(*) c FROM photos WHERE missing=0").fetchone()["c"]
check("ignored while the switch is off", now == live, f"{live} -> {now}")

db.set_setting("cloud_delete_enabled", "1")

queue({"op": "photo_delete", "photo_ids": victims, "confirm_count": 99})
run_sync()
now = db.connect().execute("SELECT COUNT(*) c FROM photos WHERE missing=0").fetchone()["c"]
check("refuses a confirm_count that does not match", now == live, f"{live} -> {now}")

queue({"op": "photo_delete", "photo_ids": victims})
run_sync()
now = db.connect().execute("SELECT COUNT(*) c FROM photos WHERE missing=0").fetchone()["c"]
check("refuses a missing confirm_count", now == live, f"{live} -> {now}")

queue({"op": "photo_delete", "photo_ids": [], "confirm_count": 0})
run_sync()
now = db.connect().execute("SELECT COUNT(*) c FROM photos WHERE missing=0").fetchone()["c"]
check("refuses an empty list", now == live, f"{live} -> {now}")

oversized = list(range(1, sync.CLOUD_DELETE_CAP + 2))
queue({"op": "photo_delete", "photo_ids": oversized, "confirm_count": len(oversized)})
run_sync()
now = db.connect().execute("SELECT COUNT(*) c FROM photos WHERE missing=0").fetchone()["c"]
check("refuses a batch over the cap", now == live, f"{live} -> {now}")

trash_before = len(list((DATA / "trash").glob("*"))) if (DATA / "trash").exists() else 0
queue({"op": "photo_delete", "photo_ids": victims, "confirm_count": len(victims)})
state = run_sync()
now = db.connect().execute("SELECT COUNT(*) c FROM photos WHERE missing=0").fetchone()["c"]
trashed = len(list((DATA / "trash").glob("*"))) if (DATA / "trash").exists() else 0
print(f"  {live} -> {now} photos, trash {trash_before} -> {trashed}")
check("a fully-formed request deletes", now == live - 2, f"{live} -> {now}")
check("sync reports the deletions", state["received"]["deleted"] == 2, str(state["received"]))
check("deleted files go to the bin, not oblivion", trashed == trash_before + 2, f"{trashed}")
check("the photos left the index", db.connect().execute(
    f"SELECT COUNT(*) c FROM photos WHERE id IN ({','.join('?' * len(victims))})",
    victims).fetchone()["c"] == 0)
check("manifest advertises the switch", manifest()["allow_delete"] is True)

db.set_setting("cloud_delete_enabled", "0")
check("manifest hides it again once off",
      json.loads(snapshot.manifest_bytes(snapshot.build()[0]))["allow_delete"] is False)

print()
if failures:
    print(f"{len(failures)} FAILED: {failures}")
    server.shutdown()
    sys.exit(1)
print("ALL WRITE-BACK CHECKS PASSED")
server.shutdown()
shutil.rmtree(TMP, ignore_errors=True)
