"""Cloud write-back: changes queued in the bucket are applied locally on sync.

Uses a mock S3 endpoint, so no real R2 account is touched.
"""
import hashlib
import http.server
import io
import json
import shutil
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid
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

# --- photos added from a phone ------------------------------------------------


def import_bytes(when="2021:06:04 15:00:00", lat=51.5074, lon=-0.1278, size=(64, 48)):
    """A real JPEG carrying real EXIF, so photometa reads it the way it would
    read one off a phone rather than being handed values by the test."""
    from PIL.TiffImagePlugin import IFDRational as R

    img = Image.new("RGB", size, (200, 60, 60))
    exif = Image.Exif()
    exif[271] = "TestPhone"
    exif[0x8769] = {36867: when}
    if lat is not None:
        def dms(v):
            d = int(abs(v)); m = int((abs(v) - d) * 60)
            return (R(d, 1), R(m, 1), R(round((abs(v) - d - m / 60) * 3600 * 100), 100))
        exif[0x8825] = {1: "S" if lat < 0 else "N", 2: dms(lat),
                        3: "W" if lon < 0 else "E", 4: dms(lon)}
    buf = io.BytesIO()
    img.save(buf, "JPEG", exif=exif.tobytes())
    return buf.getvalue()


def queue_import(proxy, *, full=None, name="IMG_0001.JPG", ext=".jpg", uid=None, **extra):
    """Stand in for the Worker: image bytes under import/, one op under inbox/."""
    uid = uid or f"{int(time.time() * 1000)}-{uuid.uuid4()}"
    with LOCK:
        STORE[f"import/{uid}.jpg"] = proxy
        if full is not None:
            STORE[f"import/{uid}.orig"] = full
        op = {"op": "photo_import", "uid": uid, "queued_ts": int(uid.split("-")[0]),
              "name": name, "ext": ext, "bytes": len(full or proxy),
              "sha256": hashlib.sha256(full).hexdigest() if full is not None else None,
              "proxy_sha256": hashlib.sha256(proxy).hexdigest()}
        op.update(extra)
        STORE[f"inbox/{uid}.json"] = json.dumps(op).encode()
    return uid


def photo_row(uid):
    tag = f"{uid[14:18]}-{uid[18:22]}"
    return db.connect().execute(
        "SELECT * FROM photos WHERE path LIKE ?", (f"%{tag}%",)).fetchone()


before = db.connect().execute("SELECT COUNT(*) c FROM photos").fetchone()["c"]
full_jpeg = import_bytes()
uid = queue_import(import_bytes(size=(32, 24)), full=full_jpeg)
state = run_sync()
check("import is refused while the switch is off", photo_row(uid) is None)
check("refused import is not counted", state["received"]["imported"] == 0, str(state["received"]))
check("refused import stays queued for the deadline", f"inbox/{uid}.json" in STORE)

db.set_setting("cloud_import_enabled", "1")
state = run_sync()
row = photo_row(uid)
check("import lands once the switch is on", row is not None)
check("sync counts the import", state["received"]["imported"] == 1, str(state["received"]))
# The same constant is asserted in tests/test_exif.mjs, so the Python and
# JavaScript readers cannot drift apart without one of the two failing.
check("capture time is read from EXIF as a UTC wall clock",
      row and row["taken_ts"] == 1622818800, str(row and row["taken_ts"]))
check("coordinates are read from EXIF, not taken on trust",
      row and abs(row["lat"] - 51.5074) < 1e-4 and abs(row["lon"] + 0.1278) < 1e-4,
      f"{row and row['lat']}, {row and row['lon']}")
check("the original was preferred over the proxy",
      row and row["filesize"] == len(full_jpeg), f"{row and row['filesize']} vs {len(full_jpeg)}")
check("the file landed under the import directory",
      row and str(db.IMPORT_DIR) in row["path"], row and row["path"])
check("the import directory is registered as a root",
      str(db.IMPORT_DIR) in db.get_roots(), str(db.get_roots()))
check("both image objects were cleared from the bucket",
      f"import/{uid}.jpg" not in STORE and f"import/{uid}.orig" not in STORE)
check("the inbox op was cleared", f"inbox/{uid}.json" not in STORE)
check("the imported photo reaches the manifest", row and row["id"] in manifest()["ids"])

# Replay: the drain tolerates seeing an op twice, and must not make a second row.
queue_import(import_bytes(size=(32, 24)), full=full_jpeg, uid=uid)
run_sync()
check("replaying an import does not duplicate the photo",
      db.connect().execute("SELECT COUNT(*) c FROM photos WHERE path=?",
                           (row["path"],)).fetchone()["c"] == 1)

# A photo the library already holds, sent up by a phone that could not know that
# - it left here by cable months ago and was renamed on the way. The bytes are
# what decide, so it is dropped rather than kept a second time.
cable = (PHOTOS / "plain_1.jpg").read_bytes()
before_dupe = db.connect().execute("SELECT COUNT(*) c FROM photos").fetchone()["c"]
already = queue_import(import_bytes(size=(32, 24)), full=cable, name="IMG_9001.JPG")
state = run_sync()
check("a photo already in the library is not imported again", photo_row(already) is None)
check("the library did not grow",
      db.connect().execute("SELECT COUNT(*) c FROM photos").fetchone()["c"] == before_dupe)
check("the skip is counted, and not as an import",
      state["received"]["already_here"] == 1 and state["received"]["imported"] == 0,
      str(state["received"]))
check("its bytes are cleared from the bucket",
      f"import/{already}.jpg" not in STORE and f"import/{already}.orig" not in STORE)
check("and its op is not left queued for another try", f"inbox/{already}.json" not in STORE)

# Narrowing by size is how the library is searched without hashing all of it,
# but the size alone must never be the answer: an import that merely happens to
# weigh the same as a library photo has to land.
check("a size collision alone is not a duplicate",
      sync._already_indexed(db.connect(), len(cable), "0" * 64) is False)
check("the same bytes are",
      sync._already_indexed(db.connect(), len(cable),
                            hashlib.sha256(cable).hexdigest()) is True)

# A proxy on its own, past the grace window, still has to land: the original may
# never arrive, and the photo is not on the phone forever.
old = f"{int((time.time() - sync.IMPORT_GRACE - 60) * 1000)}-{uuid.uuid4()}"
# The phone's reading is deliberately wrong here, and deliberately different, so
# "the file won" is something the check can actually see.
queue_import(import_bytes(when="2022:03:04 09:00:00", lat=-33.8688, lon=151.2093,
                          size=(24, 18)), uid=old, name="IMG_0002.JPG",
             taken_ts=1600000000, lat=10.0, lon=10.0)
db.connect().execute("INSERT OR REPLACE INTO import_seen(uid, first_ts) VALUES (?,?)",
                     (old, int(time.time()) - sync.IMPORT_GRACE - 60))
db.connect().commit()
state = run_sync()
lone = photo_row(old)
check("a proxy alone lands once the grace window has passed", lone is not None)
check("southern and western refs keep their sign",
      lone and abs(lone["lat"] + 33.8688) < 1e-3 and abs(lone["lon"] - 151.2093) < 1e-3,
      f"{lone and lone['lat']}, {lone and lone['lon']}")

# The proxy that landed above is a canvas re-encode in real life: no EXIF at all,
# so photometa reads no capture time and falls back to the file's own date, which
# is the moment it was written here. What the phone read off the original before
# downscaling it is the only copy of that fact left, and it has to be used.
naked = io.BytesIO()
Image.new("RGB", (20, 15), (30, 30, 30)).save(naked, "JPEG")   # stripped, like a canvas proxy
bare = f"{int((time.time() - sync.IMPORT_GRACE - 60) * 1000)}-{uuid.uuid4()}"
queue_import(naked.getvalue(), uid=bare, name="IMG_0009.JPG",
             taken_ts=1646384400, lat=-33.8688, lon=151.2093)
db.connect().execute("INSERT OR REPLACE INTO import_seen(uid, first_ts) VALUES (?,?)",
                     (bare, int(time.time()) - sync.IMPORT_GRACE - 60))
db.connect().commit()
run_sync()
stripped = photo_row(bare)
check("a stripped proxy keeps the capture time the phone read",
      stripped and stripped["taken_ts"] == 1646384400, str(stripped and stripped["taken_ts"]))
check("and it is not passed off as the file's own date",
      stripped and stripped["taken_src"] == "phone", str(stripped and stripped["taken_src"]))
check("and it keeps the position the phone read",
      stripped and abs(stripped["lat"] + 33.8688) < 1e-3, str(stripped and stripped["lat"]))
# The file's own EXIF still outranks the phone wherever there is any: that photo
# was sent with a capture time and a position that disagree with its own tags.
check("a real EXIF capture time still outranks the phone's",
      lone and lone["taken_src"] == "exif" and lone["taken_ts"] == 1646384400,
      f"{lone and lone['taken_src']} {lone and lone['taken_ts']}")
check("and a real EXIF position does too",
      lone and abs(lone["lat"] + 33.8688) < 1e-3, str(lone and lone["lat"]))

# A proxy whose original is still on its way is left alone rather than settled.
fresh = f"{int(time.time() * 1000)}-{uuid.uuid4()}"
queue_import(import_bytes(size=(24, 18)), uid=fresh, name="IMG_0003.JPG")
run_sync()
check("a fresh proxy waits for its original", photo_row(fresh) is None)
check("and its op is held, not deleted", f"inbox/{fresh}.json" in STORE)
check("the watermark is held back by what is still waiting",
      int(db.get_setting("import_watermark", 0)) <= int(fresh.split("-")[0]) // 1000,
      db.get_setting("import_watermark", 0))
check("the watermark is in seconds, not milliseconds",
      abs(int(db.get_setting("import_watermark", 0)) - time.time()) < 86400,
      db.get_setting("import_watermark", 0))

# Truncated in transit: the bytes do not match the hash the phone computed, so
# the original is refused outright rather than ingested as a broken photo.
proxy4 = import_bytes(size=(32, 24))
uid4 = f"{int(time.time() * 1000)}-{uuid.uuid4()}"
with LOCK:
    STORE[f"import/{uid4}.jpg"] = proxy4
    STORE[f"import/{uid4}.orig"] = b"truncated"
    STORE[f"inbox/{uid4}.json"] = json.dumps({
        "op": "photo_import", "uid": uid4, "queued_ts": int(uid4.split("-")[0]),
        "name": "IMG_0004.JPG", "ext": ".jpg", "bytes": 9,
        "sha256": hashlib.sha256(b"the whole file").hexdigest(),   # will not match
        "proxy_sha256": hashlib.sha256(proxy4).hexdigest()}).encode()
run_sync()
check("an upload that did not arrive intact is not ingested", photo_row(uid4) is None)
check("and it is held for another try rather than dropped", f"inbox/{uid4}.json" in STORE)

# Intact bytes that are not a decodable image: the original is undecodable but
# the proxy is a real JPEG, which is the HEIC-without-pillow_heif case. The
# photo has to survive at proxy resolution rather than be lost.
undecodable = b"\x00\x01\x02 not an image, but exactly what was hashed"
fallback = queue_import(import_bytes(size=(40, 30)), full=undecodable, name="IMG_0005.HEIC")
run_sync()
fb = photo_row(fallback)
check("an undecodable original falls back to the proxy", fb is not None)
check("the fallback row is the proxy, not the broken original",
      fb is not None and fb["filesize"] != len(undecodable), str(fb and fb["filesize"]))

# Nothing decodable at all: dropped, never indexed as a broken library photo.
junk = queue_import(b"not an image either", full=None, name="IMG_0006.JPG")
db.connect().execute("INSERT OR REPLACE INTO import_seen(uid, first_ts) VALUES (?,?)",
                     (junk, int(time.time()) - sync.IMPORT_GRACE - 60))
db.connect().commit()
run_sync()
check("an upload that will not decode never enters the library", photo_row(junk) is None)

# Traversal and rubbish ids.
evil = queue_import(import_bytes(size=(32, 24)), full=import_bytes(size=(32, 24)),
                    name="../../../../evil.jpg")
run_sync()
evil_row = photo_row(evil)
check("a traversing filename cannot escape the import directory",
      evil_row is not None and str(db.IMPORT_DIR) in evil_row["path"]
      and ".." not in evil_row["path"], evil_row and evil_row["path"])

with LOCK:
    STORE["inbox/not-a-real-id.json"] = json.dumps(
        {"op": "photo_import", "uid": "../../etc/passwd", "queued_ts": 0}).encode()
    STORE["import/stray.jpg"] = b"loose bytes with no op"
state = run_sync()
check("a malformed import id is refused", state["phase"] == "done")
check("loose image bytes are never JSON-parsed as an op",
      state["received"]["failed"] == 0, str(state["received"]))

# A scan must not hard-delete an import it did not walk. The prune classifies
# "not seen, but the file is there" as unrooted and DELETEs the row, and a scan
# racing a sync would otherwise destroy a photo that had just landed.
db.set_setting("cloud_import_enabled", "1")
survivor = queue_import(import_bytes(size=(48, 36)), full=import_bytes(size=(48, 36)),
                        name="IMG_0007.JPG")
run_sync()
kept = photo_row(survivor)
check("the import is in the index before the scan", kept is not None)
# The race, made deterministic: a walk that finished before the import landed
# still sees the file on disk afterwards, which is exactly the state that made
# the prune classify it as unrooted and DELETE it.
_real_walk = scanner._walk
scanner._walk = lambda roots: [f for f in _real_walk(roots) if str(db.IMPORT_DIR) not in f]
scanner.start()
while scanner.status()["running"]:
    time.sleep(0.05)
scanner._walk = _real_walk
still = db.connect().execute("SELECT missing FROM photos WHERE id=?", (kept["id"],)).fetchone()
check("a scan does not drop an imported photo it did not walk", still is not None,
      "the row was hard-deleted by the prune")
check("and it is not flagged missing either", still and still["missing"] == 0,
      str(still and still["missing"]))

# --- the watcher -------------------------------------------------------------
# It has to start a sync when the phone leaves something, and - the part that is
# easy to get wrong - it must NOT start one for work it has already seen. An
# import waiting for its full-resolution half keeps its inbox key on purpose, so
# a watcher that counted keys rather than tracking them would sync forever.
db.set_setting("cloud_import_enabled", "1")
while sync.status()["running"]:          # nothing below is true mid-sync
    time.sleep(0.05)
started = []
_real_start = sync.start
sync.start = lambda: (started.append(1), True)[1]
# Adopt what is in the bucket now, so only what arrives next counts as new.
sync._set_watch_seen(sync._pending_keys(sync.client()))
try:
    check("an idle bucket does not start a sync", sync._watch_once() is False)

    queue({"op": "favorite", "photo_ids": [target], "value": True})
    check("a new inbox object starts one", sync._watch_once() is True)
    check("and it started exactly one", len(started) == 1, str(len(started)))

    # Nothing drained it (start is stubbed), so the key is still there.
    check("the same object does not start another", sync._watch_once() is False)
    check("still exactly one", len(started) == 1, str(len(started)))

    # The other half of an import arriving is a new key under import/, which is
    # precisely when the op that was left queued deserves another try.
    with LOCK:
        STORE["import/9999999999999-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.orig"] = b"bytes"
    check("a full-resolution half arriving starts one", sync._watch_once() is True)

    db.set_setting("cloud_watch_enabled", "0")
    with LOCK:
        STORE["inbox/ignored-while-off.json"] = json.dumps({"op": "favorite"}).encode()
    check("switched off, it looks at nothing", sync._watch_once() is False)
    db.set_setting("cloud_watch_enabled", "1")
finally:
    sync.start = _real_start
with LOCK:
    STORE.pop("import/9999999999999-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.orig", None)
    STORE.pop("inbox/ignored-while-off.json", None)

db.set_setting("cloud_import_enabled", "0")
check("manifest hides importing once off",
      json.loads(snapshot.manifest_bytes(snapshot.build()[0]))["allow_import"] is False)

print()
if failures:
    print(f"{len(failures)} FAILED: {failures}")
    server.shutdown()
    sys.exit(1)
print("ALL WRITE-BACK CHECKS PASSED")
server.shutdown()
shutil.rmtree(TMP, ignore_errors=True)
