"""Push the heat-map snapshot to R2, uploading only what changed.

Object layout in the bucket:
    index.html         the standalone viewer
    sw.js              its service worker, plus manifest.webmanifest and icons
    manifest.json      points, albums, stats (overwritten every sync)
    t/<hash>.jpg       content-addressed thumbnails (written once, never rewritten)

Only `manifest.json` is rewritten on a normal sync, so a run costs a handful of
Class A operations rather than one per photo.
"""
import hashlib
import json
import os
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import db, r2, snapshot, thumbs

try:
    from send2trash import send2trash

    RECYCLE_OK = True
except ImportError:
    RECYCLE_OK = False

VIEWER_DIR = Path(__file__).resolve().parent.parent / "viewer"
# The same Leaflet and MapLibre builds the desktop app runs. Published so the
# viewer has no CDN dependency: a cross-origin script is one the service worker
# cannot cache, which left the installed app with no map at all offline.
VENDOR_DIR = Path(__file__).resolve().parent.parent / "frontend" / "vendor"

# The viewer is a page plus the files that make it installable: a manifest, a
# service worker and two icons. They all land at the root of the bucket, which
# is what lets the service worker claim the whole origin as its scope.
VIEWER_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
}

# Kept in step with the Worker's own cap, which is the first thing a note has to
# get past. This is the backstop for an object written before that cap existed.
NOTE_MAX = 4000

# Most photos anyone would plausibly delete in one action from a phone. A larger
# request is far more likely to be a mistake than an intention.
CLOUD_DELETE_CAP = 200

# A dropped connection mid-run is normal against R2 over a long upload; only a
# key that fails every attempt is a real failure.
UPLOAD_TRIES = 4
UPLOAD_BACKOFF = 1.5  # seconds, doubled each retry
# Only stop early if something is systematically wrong, not for a rough patch.
MAX_FAILURES = 200

_state = {
    "running": False,
    "phase": "idle",
    "done": 0,
    "total": 0,
    "uploaded": 0,
    "skipped": 0,
    "deleted": 0,
    "bytes": 0,
    "points": 0,
    "received": None,
    "error": None,
    "started": None,
    "finished": None,
}
_lock = threading.Lock()
_thread: threading.Thread | None = None


def viewer_files() -> list[tuple[str, Path]]:
    """(bucket key, local file) for everything the viewer is made of.

    Its own files stay at the root, which is what lets the service worker claim
    the whole origin. The libraries keep their directory layout under `vendor/`
    because MapLibre resolves its worker against its own URL, so the three files
    it ships with have to stay side by side.
    """
    out: list[tuple[str, Path]] = []
    if VIEWER_DIR.is_dir():
        out += [
            (p.name, p)
            for p in sorted(VIEWER_DIR.iterdir())
            if p.is_file() and p.suffix in VIEWER_TYPES
        ]
    if VENDOR_DIR.is_dir():
        out += [
            (f"vendor/{p.relative_to(VENDOR_DIR).as_posix()}", p)
            for p in sorted(VENDOR_DIR.rglob("*"))
            if p.is_file() and p.suffix in VIEWER_TYPES
        ]
    return out


def status() -> dict:
    with _lock:
        return dict(_state)


def _set(**kwargs) -> None:
    with _lock:
        _state.update(kwargs)


def config() -> dict:
    return {
        "account_id": db.get_setting("r2_account_id", "") or "",
        "bucket": db.get_setting("r2_bucket", "") or "",
        "access_key_id": db.get_setting("r2_access_key_id", "") or "",
        "secret_key": db.get_setting("r2_secret_key", "") or "",
    }


def configured() -> bool:
    return all(config().values())


def client() -> r2.Bucket:
    cfg = config()
    return r2.Bucket(cfg["account_id"], cfg["bucket"], cfg["access_key_id"], cfg["secret_key"])


def start() -> bool:
    global _thread
    with _lock:
        if _state["running"]:
            return False
        _state.update(
            running=True, phase="building", done=0, total=0, uploaded=0, skipped=0,
            deleted=0, bytes=0, points=0, received=None, error=None,
            started=time.time(), finished=None,
        )
    _thread = threading.Thread(target=_run, daemon=True)
    _thread.start()
    return True


def _apply_inbox(bucket, conn) -> dict:
    """Pull changes made in the cloud viewer and apply them locally.

    Every operation is idempotent, so a change that was applied but whose inbox
    object failed to delete does no harm when it is seen again.
    """
    applied = {"albums": 0, "favourites": 0, "duplicates": 0, "deleted": 0,
               "notes": 0, "failed": 0}
    try:
        keys = bucket.list_keys(prefix=snapshot.INBOX_PREFIX)
    except r2.R2Error:
        return applied

    for key in sorted(keys):
        try:
            change = json.loads(bucket.get(key))
        except Exception:
            applied["failed"] += 1
            continue

        try:
            op = change.get("op")
            ids = [int(i) for i in change.get("photo_ids", [])]
            with db.write_lock:
                if op == "album_add" and ids:
                    conn.executemany(
                        "INSERT OR IGNORE INTO album_photos(album_id, photo_id) VALUES (?,?)",
                        [(int(change["album_id"]), i) for i in ids],
                    )
                    applied["albums"] += len(ids)
                elif op == "album_remove" and ids:
                    conn.executemany(
                        "DELETE FROM album_photos WHERE album_id=? AND photo_id=?",
                        [(int(change["album_id"]), i) for i in ids],
                    )
                    applied["albums"] += len(ids)
                elif op == "album_create":
                    name = str(change.get("name", "")).strip()
                    if name:
                        cur = conn.execute(
                            "INSERT OR IGNORE INTO albums(name, color, created_ts) VALUES (?,?,?)",
                            (name, change.get("color") or "#ff5a5f", int(time.time())),
                        )
                        album_id = cur.lastrowid or conn.execute(
                            "SELECT id FROM albums WHERE name=?", (name,)
                        ).fetchone()["id"]
                        conn.executemany(
                            "INSERT OR IGNORE INTO album_photos(album_id, photo_id) VALUES (?,?)",
                            [(album_id, i) for i in ids],
                        )
                        applied["albums"] += 1
                elif op == "favorite" and ids:
                    value = 1 if change.get("value") else 0
                    conn.executemany(
                        "UPDATE photos SET favorite=? WHERE id=?", [(value, i) for i in ids]
                    )
                    applied["favourites"] += len(ids)
                elif op == "photo_note" and ids:
                    # Empty clears it, and is stored as NULL like the desktop
                    # does, so the search LIKE never matches a blank note.
                    note = str(change.get("note", "")).strip()[:NOTE_MAX] or None
                    conn.executemany(
                        "UPDATE photos SET note=? WHERE id=?", [(note, i) for i in ids]
                    )
                    applied["notes"] += len(ids)
                conn.commit()

            if op == "dupe_resolve":
                applied["duplicates"] += _resolve_duplicate(conn, change)
            elif op == "photo_delete":
                applied["deleted"] += _delete_photos(conn, change)
        except Exception:
            applied["failed"] += 1

        try:
            bucket.delete(key)
        except r2.R2Error:
            pass  # re-applied harmlessly next sync
    return applied


def _trash_photo(conn, photo_id: int, path: str) -> bool:
    """Move one file to the recycle bin and drop it from the index.

    Nothing here deletes permanently: the file is always recoverable from the
    bin (or data/trash when Send2Trash is unavailable).
    """
    try:
        if os.path.exists(path):
            if RECYCLE_OK:
                send2trash(os.path.normpath(path))
            else:
                db.TRASH_DIR.mkdir(parents=True, exist_ok=True)
                shutil.move(path, db.TRASH_DIR / f"{photo_id}_{os.path.basename(path)}")
    except Exception:
        return False
    with db.write_lock:
        conn.execute("DELETE FROM album_photos WHERE photo_id=?", (photo_id,))
        conn.execute("DELETE FROM photos WHERE id=?", (photo_id,))
        conn.commit()
    thumbs.drop(photo_id)
    return True


def _resolve_duplicate(conn, change) -> int:
    """Delete the extra copies of one duplicate set, only if one copy survives."""
    digest = str(change.get("hash", ""))
    keep_id = int(change.get("keep_id", 0))
    rows = conn.execute(
        "SELECT id, path FROM photos WHERE content_hash=? AND missing=0", (digest,)
    ).fetchall()
    ids = [r["id"] for r in rows]
    if len(ids) < 2 or keep_id not in ids:
        return 0
    return sum(
        _trash_photo(conn, r["id"], r["path"]) for r in rows if r["id"] != keep_id
    )


def _delete_photos(conn, change) -> int:
    """Delete ordinary photos requested from the cloud viewer.

    Deliberately hard to trigger by accident:
      - off unless this machine has opted in (`cloud_delete_enabled`);
      - the request must state how many photos it means to delete, and the
        count has to match the id list exactly;
      - batches are capped, so a malformed or replayed request cannot sweep
        the library;
      - files go to the recycle bin, never straight to permanent deletion.
    """
    if db.get_setting("cloud_delete_enabled", "0") != "1":
        return 0
    ids = [int(i) for i in change.get("photo_ids", [])]
    if not ids or len(ids) > CLOUD_DELETE_CAP:
        return 0
    try:
        stated = int(change.get("confirm_count", -1))
    except (TypeError, ValueError):
        return 0
    if stated != len(ids):
        return 0

    placeholders = ",".join("?" * len(ids))
    rows = conn.execute(
        f"SELECT id, path FROM photos WHERE missing=0 AND id IN ({placeholders})", ids
    ).fetchall()
    return sum(_trash_photo(conn, r["id"], r["path"]) for r in rows)


def _run() -> None:
    conn = db.connect()
    try:
        if not configured():
            _set(phase="error", error="R2 is not configured")
            return

        bucket = client()

        # Take cloud edits first, so the manifest we publish already reflects them.
        _set(phase="receiving")
        received = _apply_inbox(bucket, conn)
        _set(received=received)
        manifest, files = snapshot.build(
            progress=lambda done, total: _set(done=done, total=total)
        )
        _set(phase="uploading", points=manifest["n"], done=0, total=len(files))

        known = {r["key"] for r in conn.execute("SELECT key FROM synced")}
        pending = [(key, path) for key, path in files.items() if key not in known]
        _set(total=len(pending), skipped=len(files) - len(pending))

        uploaded: list[tuple] = []
        failures: list[str] = []
        now = int(time.time())

        def upload(item):
            """Retry before giving up. R2 drops connections partway through a
            long run - a reset after 9,000 objects is the network being busy,
            not the credentials being wrong, and the whole sync used to abort
            on it. Uploads are idempotent, so retrying costs nothing."""
            key, path = item
            body = Path(path).read_bytes()
            last = None
            for attempt in range(UPLOAD_TRIES):
                try:
                    bucket.put(key, body, "image/jpeg")
                    return key, len(body), None
                except Exception as exc:
                    last = str(exc)
                    if attempt + 1 < UPLOAD_TRIES:
                        time.sleep(UPLOAD_BACKOFF * (2 ** attempt))
            return key, 0, last

        if pending:
            with ThreadPoolExecutor(max_workers=4) as pool:
                for key, size, error in pool.map(upload, pending):
                    if error:
                        failures.append(f"{key}: {error}")
                    else:
                        uploaded.append((key, size, now))
                    with _lock:
                        _state["done"] += 1
                        if not error:
                            _state["uploaded"] += 1
                            _state["bytes"] += size
                    if len(failures) > MAX_FAILURES:
                        break

        if uploaded:
            with db.write_lock:
                conn.executemany(
                    "INSERT OR REPLACE INTO synced(key, size, uploaded_ts) VALUES (?,?,?)",
                    uploaded,
                )
                conn.commit()

        # Whatever did land is still worth publishing: the manifest and the
        # viewer go up regardless, and the next sync picks up what is missing,
        # because `synced` already records everything that succeeded.
        if failures:
            _set(error=f"{len(failures)} thumbnail(s) still to upload - run Sync again")

        # Viewer files only move when their own contents change.
        known = json.loads(db.get_setting("viewer_hashes", "") or "{}")
        digests = {}
        for key, path in viewer_files():
            body = path.read_bytes()
            digests[key] = hashlib.sha1(body).hexdigest()
            if known.get(key) != digests[key]:
                bucket.put(key, body, VIEWER_TYPES[path.suffix])
                with _lock:
                    _state["uploaded"] += 1
                    _state["bytes"] += len(body)
        if digests != known:
            db.set_setting("viewer_hashes", json.dumps(digests))

        body = snapshot.manifest_bytes(manifest)
        bucket.put(snapshot.MANIFEST_KEY, body, "application/json")
        with _lock:
            _state["uploaded"] += 1
            _state["bytes"] += len(body)

        # Drop thumbnails for photos that are no longer in the library. Only keys
        # this app recorded are touched, so a shared bucket stays safe.
        _set(phase="pruning")
        stale = [
            r["key"]
            for r in conn.execute("SELECT key FROM synced WHERE key LIKE 't/%'")
            if r["key"] not in files
        ]
        for key in stale:
            try:
                bucket.delete(key)
                with db.write_lock:
                    conn.execute("DELETE FROM synced WHERE key=?", (key,))
                    conn.commit()
                with _lock:
                    _state["deleted"] += 1
            except Exception:
                pass  # a failed delete only costs storage; retried next sync

        db.set_setting("last_sync_ts", int(time.time()))
        _set(phase="done")
    except r2.R2Error as exc:
        _set(phase="error", error=exc.message)
    except Exception as exc:
        _set(phase="error", error=f"{type(exc).__name__}: {exc}")
    finally:
        _set(running=False, finished=time.time())


def maybe_sync_after_scan() -> None:
    if db.get_setting("sync_on_scan", "1") == "1" and configured():
        start()


def reset_remote_state() -> None:
    """Forget what the bucket contains, so the next sync re-uploads everything."""
    conn = db.connect()
    with db.write_lock:
        conn.execute("DELETE FROM synced")
        conn.commit()
    db.set_setting("viewer_hashes", "")
