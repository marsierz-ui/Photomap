"""Background library scan: walk roots, read EXIF, upsert into the index."""
import datetime
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from . import db, photometa, sync

SKIP_DIRS = {".git", "node_modules", "$RECYCLE.BIN", "System Volume Information", "data"}

_state = {
    "running": False,
    "phase": "idle",
    "total": 0,
    "done": 0,
    "added": 0,
    "updated": 0,
    "skipped": 0,
    "errors": 0,
    "removed": 0,
    "unrooted": 0,
    "current": "",
    "message": "",
    "started": None,
    "finished": None,
}
_lock = threading.Lock()
_cancel = threading.Event()
_thread: threading.Thread | None = None


def status() -> dict:
    with _lock:
        return dict(_state)


def _set(**kwargs) -> None:
    with _lock:
        _state.update(kwargs)


def cancel() -> None:
    _cancel.set()


def start(force: bool = False) -> bool:
    global _thread
    with _lock:
        if _state["running"]:
            return False
        _state.update(
            running=True, phase="starting", total=0, done=0, added=0, updated=0,
            skipped=0, errors=0, removed=0, unrooted=0, current="", message="",
            started=time.time(), finished=None,
        )
    _cancel.clear()
    _thread = threading.Thread(target=_run, args=(force,), daemon=True)
    _thread.start()
    return True


def _walk(roots: list[str]) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            if _cancel.is_set():
                return found
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
            for name in filenames:
                if os.path.splitext(name)[1].lower() not in photometa.MEDIA_EXTS:
                    continue
                full = os.path.normpath(os.path.join(dirpath, name))
                key = full.lower()
                if key in seen:
                    continue
                seen.add(key)
                found.append(full)
            _set(phase="walking", total=len(found), current=dirpath)
    return found


def _apply_fixes(conn, meta: dict) -> None:
    """Put hand-made corrections over what the file says.

    Idempotent, which matters: a rescan always starts from the file's own values,
    so applying a shift twice is not possible - it is applied to a fresh read.
    """
    fix = conn.execute(
        "SELECT lat, lon FROM location_fixes WHERE path=?", (meta["path"],)
    ).fetchone()
    if fix:
        meta["lat"], meta["lon"], meta["gps_method"] = fix["lat"], fix["lon"], "MANUAL"

    folder = meta["folder"].lower() + os.sep
    for shift in conn.execute("SELECT folder, offset_s, before_ts FROM date_shifts"):
        under = (shift["folder"].lower() + os.sep)
        if folder.startswith(under) and meta["taken_ts"] is not None                 and meta["taken_ts"] < shift["before_ts"]:
            meta["taken_ts"] += shift["offset_s"]
            meta["taken_src"] = "manual"
            break


def shift_dates(conn, folder: str, to_day: str, before_ts: int = 1104537600) -> dict:
    """Move a folder's photos with a bogus camera clock to a real date.

    The first affected photo's day becomes `to_day` (YYYY-MM-DD) and every other
    photo moves by the same whole number of days, so the gaps between them - and
    each photo's time of day - are kept. Only photos dated before `before_ts`
    (2005 by default) move; the rest of the folder already has real dates.
    Recorded in date_shifts so a rescan does the same thing again.
    """
    like = folder.rstrip("/\\") + os.sep
    rows = conn.execute(
        "SELECT id, path, taken_ts FROM photos WHERE missing=0 AND taken_ts < ?"
        " AND substr(lower(path), 1, ?) = lower(?)",
        (before_ts, len(like), like),
    ).fetchall()
    if not rows:
        return {"moved": 0}
    first = min(r["taken_ts"] for r in rows)
    first_day = datetime.datetime.fromtimestamp(first, datetime.UTC).date()
    target = datetime.date.fromisoformat(to_day)
    offset = (target - first_day).days * 86400
    with db.write_lock:
        conn.execute(
            "INSERT INTO date_shifts(folder, offset_s, before_ts) VALUES (?,?,?)"
            " ON CONFLICT(folder) DO UPDATE SET offset_s=excluded.offset_s,"
            " before_ts=excluded.before_ts",
            (folder.rstrip("/\\"), offset, before_ts),
        )
        conn.executemany(
            "UPDATE photos SET taken_ts=taken_ts+?, taken_src='manual' WHERE id=?",
            [(offset, r["id"]) for r in rows],
        )
        conn.commit()
    return {"moved": len(rows), "offset_days": offset // 86400}


def upsert(conn, meta: dict, now: int) -> tuple[int, bool]:
    """Insert or refresh one photo row. Returns (photo_id, was_created).

    The caller holds db.write_lock and commits - threading.Lock is not
    reentrant, and flush() below already holds it. Lifted out of that closure so
    the cloud import path can reuse it: one INSERT statement and one column
    ordering in the codebase means the two paths cannot drift apart.
    """
    row = conn.execute("SELECT id FROM photos WHERE path=?", (meta["path"],)).fetchone()
    _apply_fixes(conn, meta)
    values = (
        meta["path"], meta["folder"], meta["filename"], meta["ext"],
        meta["taken_ts"], meta["taken_src"], meta["lat"], meta["lon"],
        meta["altitude"], meta["width"], meta["height"], meta["orientation"],
        meta["camera_make"], meta["camera_model"], meta["filesize"], meta["mtime"],
        meta.get("duration"), meta.get("gps_method"),
    )
    if row:
        conn.execute(
            "UPDATE photos SET path=?, folder=?, filename=?, ext=?, taken_ts=?,"
            " taken_src=?, lat=?, lon=?, altitude=?, width=?, height=?, orientation=?,"
            " camera_make=?, camera_model=?, filesize=?, mtime=?, duration=?, gps_method=?, missing=0"
            " WHERE id=?",
            values + (row["id"],),
        )
        return row["id"], False
    cur = conn.execute(
        "INSERT INTO photos(path, folder, filename, ext, taken_ts, taken_src,"
        " lat, lon, altitude, width, height, orientation, camera_make,"
        " camera_model, filesize, mtime, duration, gps_method, added_ts, missing)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)",
        values + (now,),
    )
    return cur.lastrowid, True


def _run(force: bool) -> None:
    conn = db.connect()
    try:
        roots = db.get_roots()
        if not roots:
            _set(phase="done", message="No photo folders configured.")
            return

        files = _walk(roots)
        _set(phase="indexing", total=len(files), current="")

        existing = {
            r["path"].lower(): (r["id"], r["mtime"], r["filesize"])
            for r in conn.execute("SELECT id, path, mtime, filesize FROM photos")
        }

        todo: list[str] = []
        seen_ids: set[int] = set()
        skipped = 0
        for path in files:
            row = existing.get(path.lower())
            if row is None:
                todo.append(path)
                continue
            seen_ids.add(row[0])
            try:
                stat = os.stat(path)
            except OSError:
                continue
            unchanged = (
                not force
                and row[1] is not None
                and abs((row[1] or 0) - stat.st_mtime) < 1.0
                and row[2] == stat.st_size
            )
            if unchanged:
                skipped += 1
            else:
                todo.append(path)
        _set(skipped=skipped, done=skipped)

        now = int(time.time())
        batch: list[dict] = []
        added = updated = errors = 0

        def flush() -> None:
            nonlocal batch, added, updated
            if not batch:
                return
            with db.write_lock:
                for meta in batch:
                    photo_id, created = upsert(conn, meta, now)
                    seen_ids.add(photo_id)
                    if created:
                        added += 1
                    else:
                        updated += 1
                conn.commit()
            batch = []

        with ThreadPoolExecutor(max_workers=min(16, (os.cpu_count() or 4) * 2)) as pool:
            for meta in pool.map(_safe_read, todo, chunksize=8):
                if _cancel.is_set():
                    break
                if meta is None:
                    errors += 1
                else:
                    if meta.get("error"):
                        errors += 1
                    batch.append(meta)
                with _lock:
                    _state["done"] += 1
                    _state["added"], _state["updated"], _state["errors"] = added, updated, errors
                    if meta:
                        _state["current"] = meta["filename"]
                if len(batch) >= 200:
                    flush()
        flush()
        _set(added=added, updated=updated, errors=errors)

        if not _cancel.is_set():
            _set(phase="pruning")
            # Not seen by this scan means one of two different things, and they
            # need different handling: the file is genuinely gone (flag it), or
            # it still exists but no longer sits under any configured root, in
            # which case it simply is not part of the library any more.
            # A cloud import that landed while this scan was walking is not
            # unrooted, it is simply newer than the walk - and "dropped" is a
            # hard DELETE, so treating it that way would destroy a photo that is
            # present and correct. added_ts cannot answer this: it has one-second
            # resolution and a scan can start inside the same second as the
            # insert. The import folder can, and only while it is still a root -
            # remove that root and imports prune like anything else.
            import_root = str(db.IMPORT_DIR)
            guarded = import_root in roots
            gone, dropped = [], []
            for row in conn.execute("SELECT id, path FROM photos WHERE missing=0"):
                if row["id"] in seen_ids:
                    continue
                if os.path.exists(row["path"]):
                    if guarded and row["path"].startswith(import_root + os.sep):
                        continue
                    dropped.append(row["id"])
                else:
                    gone.append(row["id"])
            if gone or dropped:
                with db.write_lock:
                    conn.executemany("UPDATE photos SET missing=1 WHERE id=?", [(i,) for i in gone])
                    conn.executemany("DELETE FROM album_photos WHERE photo_id=?", [(i,) for i in dropped])
                    conn.executemany("DELETE FROM photos WHERE id=?", [(i,) for i in dropped])
                    conn.commit()
            _set(removed=len(gone), unrooted=len(dropped))


        _set(phase="cancelled" if _cancel.is_set() else "done")
    except Exception as exc:
        _set(phase="error", message=f"{type(exc).__name__}: {exc}")
    finally:
        _set(running=False, finished=time.time(), current="")
        if not _cancel.is_set():
            sync.maybe_sync_after_scan()


def _safe_read(path: str):
    try:
        return photometa.read(path)
    except Exception:
        return None
