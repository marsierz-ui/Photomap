"""Find byte-identical copies of the same photo.

Hashing a 100GB library end to end would be wasteful, so files are narrowed by
size first: two files cannot be identical unless their sizes match. Only files
sharing a size are read. Those get a full SHA-256 rather than a sampled hash,
because the result is used to offer deletion and a partial hash could in
principle collide.
"""
import hashlib
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from . import db

CHUNK = 1 << 20

_state = {
    "running": False,
    "phase": "idle",
    "done": 0,
    "total": 0,
    "hashed": 0,
    "errors": 0,
    "sets": 0,
    "redundant": 0,
    "reclaimable": 0,
    "started": None,
    "finished": None,
    "message": "",
}
_lock = threading.Lock()
_cancel = threading.Event()


def status() -> dict:
    with _lock:
        return dict(_state)


def _set(**kwargs) -> None:
    with _lock:
        _state.update(kwargs)


def cancel() -> None:
    _cancel.set()


def file_hash(path: str) -> str | None:
    digest = hashlib.sha256()
    try:
        with open(path, "rb") as handle:
            while chunk := handle.read(CHUNK):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def start() -> bool:
    with _lock:
        if _state["running"]:
            return False
        _state.update(
            running=True, phase="grouping", done=0, total=0, hashed=0, errors=0,
            sets=0, redundant=0, reclaimable=0, started=time.time(), finished=None, message="",
        )
    _cancel.clear()
    threading.Thread(target=_run, daemon=True).start()
    return True


def _run() -> None:
    conn = db.connect()
    try:
        # Only sizes shared by more than one file can hold duplicates.
        candidates = conn.execute(
            "SELECT id, path, filesize, mtime, content_hash, hashed_mtime FROM photos"
            " WHERE missing=0 AND filesize IN ("
            "   SELECT filesize FROM photos WHERE missing=0"
            "   GROUP BY filesize HAVING COUNT(*) > 1)"
        ).fetchall()

        todo = [
            r for r in candidates
            if not r["content_hash"] or r["hashed_mtime"] != r["mtime"]
        ]
        _set(phase="hashing", total=len(todo), done=0)

        results: list[tuple] = []
        errors = 0

        def work(row):
            return row["id"], file_hash(row["path"]), row["mtime"]

        with ThreadPoolExecutor(max_workers=min(8, (os.cpu_count() or 4))) as pool:
            for photo_id, digest, mtime in pool.map(work, todo):
                if _cancel.is_set():
                    break
                if digest is None:
                    errors += 1
                else:
                    results.append((digest, mtime, photo_id))
                with _lock:
                    _state["done"] += 1
                    _state["hashed"] = len(results)
                    _state["errors"] = errors
                if len(results) >= 500:
                    with db.write_lock:
                        conn.executemany(
                            "UPDATE photos SET content_hash=?, hashed_mtime=? WHERE id=?", results
                        )
                        conn.commit()
                    results = []

        if results:
            with db.write_lock:
                conn.executemany(
                    "UPDATE photos SET content_hash=?, hashed_mtime=? WHERE id=?", results
                )
                conn.commit()

        summary = summarise()
        _set(phase="cancelled" if _cancel.is_set() else "done", **summary)
    except Exception as exc:
        _set(phase="error", message=f"{type(exc).__name__}: {exc}")
    finally:
        _set(running=False, finished=time.time())


def summarise() -> dict:
    row = db.connect().execute(
        "SELECT COUNT(*) sets, COALESCE(SUM(n - 1), 0) redundant,"
        " COALESCE(SUM((n - 1) * filesize), 0) reclaimable FROM ("
        "  SELECT content_hash, COUNT(*) n, MIN(filesize) filesize FROM photos"
        "  WHERE missing=0 AND content_hash IS NOT NULL"
        "  GROUP BY content_hash HAVING n > 1)"
    ).fetchone()
    return {
        "sets": row["sets"],
        "redundant": row["redundant"],
        "reclaimable": row["reclaimable"],
    }


def all_sets() -> list[dict]:
    """Every duplicate set, but only what a bulk selection needs: which set,
    which copy survives, and how much removing the rest saves. Deliberately
    without the photo rows - those are what make `groups` heavy."""
    conn = db.connect()
    rows = conn.execute(
        "SELECT content_hash, COUNT(*) n, MIN(filesize) size FROM photos"
        " WHERE missing=0 AND content_hash IS NOT NULL"
        " GROUP BY content_hash HAVING n > 1"
    ).fetchall()
    if not rows:
        return []

    by_hash: dict[str, list[dict]] = {r["content_hash"]: [] for r in rows}
    for photo in conn.execute(
        "SELECT id, path, filename, filesize, taken_ts, added_ts, lat, favorite,"
        " content_hash FROM photos WHERE missing=0 AND content_hash IS NOT NULL"
        " ORDER BY added_ts, id"
    ):
        bucket = by_hash.get(photo["content_hash"])
        if bucket is not None:
            bucket.append(dict(photo))

    return [
        {
            "hash": r["content_hash"],
            "count": r["n"],
            "wasted": (r["n"] - 1) * r["size"],
            "keep_id": _suggest_keep(by_hash[r["content_hash"]]),
        }
        for r in rows
        if len(by_hash.get(r["content_hash"], [])) > 1
    ]


def groups(limit: int = 500, offset: int = 0) -> list[dict]:
    """Duplicate sets, largest wasted space first."""
    conn = db.connect()
    hashes = conn.execute(
        "SELECT content_hash, COUNT(*) n, MIN(filesize) size FROM photos"
        " WHERE missing=0 AND content_hash IS NOT NULL"
        " GROUP BY content_hash HAVING n > 1"
        " ORDER BY (n - 1) * MIN(filesize) DESC LIMIT ? OFFSET ?",
        (limit, offset),
    ).fetchall()

    if not hashes:
        return []

    # One query for every photo in the selected sets. Querying per hash turned
    # 300 sets into 6+ seconds.
    keys = [r["content_hash"] for r in hashes]
    placeholders = ",".join("?" * len(keys))
    by_hash: dict[str, list[dict]] = {k: [] for k in keys}
    for photo in conn.execute(
        f"SELECT id, path, filename, filesize, taken_ts, taken_src, added_ts, lat,"
        f" favorite, content_hash FROM photos"
        f" WHERE missing=0 AND content_hash IN ({placeholders})"
        f" ORDER BY added_ts, id",
        keys,
    ):
        by_hash[photo["content_hash"]].append(dict(photo))

    out = []
    for row in hashes:
        items = by_hash.get(row["content_hash"], [])
        if len(items) < 2:
            continue
        out.append({
            "hash": row["content_hash"],
            "size": row["size"],
            "count": row["n"],
            "wasted": (row["n"] - 1) * row["size"],
            "keep_id": _suggest_keep(items),
            "photos": items,
        })
    return out


def _suggest_keep(items: list[dict]) -> int:
    """Which copy to keep: the one indexed first, preferring a favourite, a
    copy that still has GPS, and a name without a copy marker."""
    def rank(item):
        name = item["filename"].lower()
        looks_like_copy = any(
            mark in name for mark in ("(1)", "(2)", "(3)", "copy", " - kopia", "kopia")
        )
        return (
            0 if item["favorite"] else 1,
            0 if item["lat"] is not None else 1,
            1 if looks_like_copy else 0,
            len(item["path"]),
            item["added_ts"] or 0,
            item["id"],
        )

    return min(items, key=rank)["id"]
