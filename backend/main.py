import datetime
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import (
    FileResponse, HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse,
)
from fastapi.staticfiles import StaticFiles

from . import (
    auth, days, db, dupes, nametime, netinfo, photometa, r2, scanner, snapshot, sync, thumbs,
)
from .photometa import HEIF_ERROR, HEIF_OK, IMAGE_EXTS

try:
    from send2trash import send2trash

    RECYCLE_OK = True
except ImportError:
    RECYCLE_OK = False

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"

db.init()
app = FastAPI(title="Photo Map", docs_url=None, redoc_url=None)

# Photos added on a phone reach the bucket immediately and the library only on a
# sync, so while this is running it looks for them itself. The thread is a daemon
# and does nothing at all until the bucket has something new in it.
sync.start_watching()


@app.middleware("http")
async def access_gate(request: Request, call_next):
    """Loopback is trusted; every other client needs the access key."""
    if not auth.required():
        return await call_next(request)
    if (request.client.host if request.client else "") in auth.LOOPBACK:
        return await call_next(request)

    key = request.query_params.get("k")
    if key is not None:
        if not auth.valid(key):
            return HTMLResponse(auth.login_page(True), status_code=401)
        if request.url.path.startswith("/api/"):
            return await call_next(request)
        # Swap the key for a cookie so it stops travelling in the URL.
        response = RedirectResponse("/", status_code=303)
        response.set_cookie(auth.COOKIE, key, max_age=31536000, samesite="lax", httponly=True)
        return response

    if auth.valid(request.cookies.get(auth.COOKIE)):
        return await call_next(request)
    if request.url.path.startswith("/api/"):
        return JSONResponse({"detail": "Access key required"}, status_code=401)
    return HTMLResponse(auth.login_page(False), status_code=401)


# --------------------------------------------------------------------------- filters

def _bbox(value: str | None) -> tuple[str, list] | None:
    if not value:
        return None
    try:
        south, west, north, east = (float(x) for x in value.split(","))
    except ValueError:
        return None
    south, north = min(south, north), max(south, north)
    if west <= east:
        return "p.lat BETWEEN ? AND ? AND p.lon BETWEEN ? AND ?", [south, north, west, east]
    # viewport crosses the antimeridian
    return "p.lat BETWEEN ? AND ? AND (p.lon >= ? OR p.lon <= ?)", [south, north, west, east]


def _filters(request: Request) -> tuple[str, list]:
    q = request.query_params
    where = ["p.missing=0"] if q.get("missing") != "1" else ["p.missing=1"]
    params: list = []

    if q.get("from"):
        where.append("p.taken_ts >= ?")
        params.append(int(float(q["from"])))
    if q.get("to"):
        where.append("p.taken_ts <= ?")
        params.append(int(float(q["to"])))

    gps = q.get("gps", "any")
    if gps == "yes":
        where.append("p.lat IS NOT NULL")
    elif gps == "no":
        where.append("p.lat IS NULL")
    elif gps == "manual":
        where.append("p.gps_method='MANUAL'")
    elif gps == "neighbour":
        where.append("p.gps_method='NEIGHBOUR'")
    elif gps == "approx":
        # Positions guessed from towers or wifi, which are the ones worth fixing.
        marks = ",".join("?" * len(photometa.APPROX_METHODS))
        where.append(f"p.lat IS NOT NULL AND p.gps_method IN ({marks})")
        params.extend(photometa.APPROX_METHODS)

    box = _bbox(q.get("bbox"))
    if box:
        where.append(f"({box[0]})")
        params.extend(box[1])

    if q.get("album"):
        where.append("p.id IN (SELECT photo_id FROM album_photos WHERE album_id=?)")
        params.append(int(q["album"]))
    if q.get("camera"):
        where.append("COALESCE(p.camera_make,'') || ' ' || COALESCE(p.camera_model,'') LIKE ?")
        params.append(f"%{q['camera']}%")
    if q.get("folder"):
        where.append("p.folder LIKE ?")
        params.append(f"{q['folder']}%")
    if q.get("q"):
        # One box searches both, because "the shot with the broken bike" is a
        # note and "IMG_4021" is a filename, and nobody wants to pick first.
        where.append("(p.path LIKE ? OR p.note LIKE ?)")
        params.extend([f"%{q['q']}%", f"%{q['q']}%"])
    if q.get("fav") == "1":
        where.append("p.favorite=1")
    if q.get("ids"):
        ids = [int(x) for x in q["ids"].split(",") if x.strip().isdigit()]
        where.append(f"p.id IN ({','.join('?' * len(ids))})" if ids else "0")
        params.extend(ids)

    return " AND ".join(where), params


SORTS = {
    "date_desc": "p.taken_ts DESC, p.id DESC",
    "date_asc": "p.taken_ts ASC, p.id ASC",
    "name": "p.filename ASC",
    "added": "p.added_ts DESC, p.id DESC",
    "size": "p.filesize DESC",
}


# --------------------------------------------------------------------------- config

@app.get("/api/config")
def get_config(request: Request):
    conn = db.connect()
    settings = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings")}
    for secret in db.SECRET_SETTINGS:
        settings.pop(secret, None)
    on_loopback = (request.client.host if request.client else "") in auth.LOOPBACK
    share = {
        "required": auth.required(),
        # Only hand the key back to the machine running the server.
        "key": auth.token() if on_loopback else None,
        "urls": netinfo.share_urls(auth.token() if auth.required() else None) if on_loopback else [],
    }
    return {
        "share": share,
        "roots": db.get_roots(),
        "settings": settings,
        "heif": HEIF_OK,
        "heif_error": HEIF_ERROR,
        "extensions": sorted(IMAGE_EXTS | photometa.VIDEO_EXTS),
        # Whether a frame can be pulled out of a video here. Without it a clip
        # still indexes, still has a place and a time, and still appears
        # everywhere - it is the poster that is drawn rather than real.
        "ffmpeg": bool(thumbs.FFMPEG),
        "recycle_bin": RECYCLE_OK,
        "data_dir": str(db.DATA_DIR),
    }


@app.post("/api/config/roots")
def add_root(body: dict = Body(...)):
    raw = (body.get("path") or "").strip().strip('"')
    if not raw:
        raise HTTPException(400, "Path required")
    path = os.path.normpath(os.path.abspath(os.path.expanduser(raw)))
    if not os.path.isdir(path):
        raise HTTPException(400, f"Not a folder: {path}")
    db.add_root(path)
    return {"roots": db.get_roots()}


@app.delete("/api/config/roots")
def remove_root(path: str):
    db.remove_root(path)
    return {"roots": db.get_roots()}


@app.get("/api/sync")
def sync_status():
    cfg = sync.config()
    state = sync.status()
    state["configured"] = sync.configured()
    state["on_scan"] = db.get_setting("sync_on_scan", "1") == "1"
    state["allow_delete"] = db.get_setting("cloud_delete_enabled", "0") == "1"
    state["delete_cap"] = sync.CLOUD_DELETE_CAP
    state["allow_import"] = db.get_setting("cloud_import_enabled", "0") == "1"
    state["watch"] = db.get_setting("cloud_watch_enabled", "1") == "1"
    state["watch_interval"] = sync.WATCH_INTERVAL
    state["import_dir"] = str(db.IMPORT_DIR)
    state["viewer_url"] = db.get_setting("viewer_url", "") or ""
    state["last_sync_ts"] = db.get_setting("last_sync_ts", None)
    state["account_id"] = cfg["account_id"]
    state["bucket"] = cfg["bucket"]
    # Confirms a key is stored without revealing it.
    state["has_credentials"] = bool(cfg["access_key_id"] and cfg["secret_key"])
    row = db.connect().execute("SELECT COUNT(*) c, SUM(size) b FROM synced").fetchone()
    state["remote_objects"] = row["c"]
    state["remote_bytes"] = row["b"] or 0
    state["estimate"] = snapshot.estimate()
    return state


@app.post("/api/sync/config")
def sync_config(request: Request, body: dict = Body(...)):
    """Credentials are write-only and only settable from the server's own machine."""
    if (request.client.host if request.client else "") not in auth.LOOPBACK:
        raise HTTPException(403, "Cloud settings can only be changed on the computer running the server")

    fields = {
        "account_id": "r2_account_id",
        "bucket": "r2_bucket",
        "access_key_id": "r2_access_key_id",
        "secret_key": "r2_secret_key",
        "viewer_url": "viewer_url",
    }
    changed_credentials = False
    for field, key in fields.items():
        if field in body:
            value = str(body[field]).strip()
            if key in ("r2_account_id", "r2_bucket") and db.get_setting(key, "") != value:
                changed_credentials = True
            db.set_setting(key, value)
    if "on_scan" in body:
        db.set_setting("sync_on_scan", "1" if body["on_scan"] else "0")
    if "allow_delete" in body:
        db.set_setting("cloud_delete_enabled", "1" if body["allow_delete"] else "0")
    if "allow_import" in body:
        db.set_setting("cloud_import_enabled", "1" if body["allow_import"] else "0")
    if "watch" in body:
        db.set_setting("cloud_watch_enabled", "1" if body["watch"] else "0")
    if "scope" in body and body["scope"] in ("all", "located"):
        if db.get_setting("snapshot_scope", "all") != body["scope"]:
            db.set_setting("snapshot_scope", body["scope"])
            # Narrowing the scope leaves orphaned thumbnails; widening needs new
            # ones. Either way the next sync should reconcile from scratch.
            sync.reset_remote_state()
            changed_credentials = True

    # Pointing at a different bucket invalidates everything we think is uploaded.
    if changed_credentials:
        sync.reset_remote_state()
    return {"ok": True, "configured": sync.configured(), "reset": changed_credentials}


@app.post("/api/sync/check")
def sync_check(request: Request):
    if (request.client.host if request.client else "") not in auth.LOOPBACK:
        raise HTTPException(403, "Not allowed from another device")
    if not sync.configured():
        raise HTTPException(400, "Fill in account ID, bucket and both keys first")
    try:
        sync.client().check()
    except r2.R2Error as exc:
        raise HTTPException(400, exc.message)
    return {"ok": True}


@app.post("/api/sync")
def sync_start(request: Request, body: dict = Body(default={})):
    if not sync.configured():
        raise HTTPException(400, "R2 is not configured")
    if body.get("full"):
        if (request.client.host if request.client else "") not in auth.LOOPBACK:
            raise HTTPException(403, "Not allowed from another device")
        sync.reset_remote_state()
    if not sync.start():
        return sync.status()
    return sync.status()


@app.post("/api/access/reset")
def reset_access_key(request: Request):
    if (request.client.host if request.client else "") not in auth.LOOPBACK:
        raise HTTPException(403, "The key can only be changed from the computer running the server")
    key = auth.reset()
    return {"key": key, "urls": netinfo.share_urls(key)}


@app.post("/api/thumbs/clear")
def clear_thumbs(body: dict = Body(default={})):
    return {"removed": thumbs.clear_all()}


@app.post("/api/config/settings")
def update_settings(body: dict = Body(...)):
    for key, value in body.items():
        db.set_setting(key, value)
    return {"ok": True}


@app.get("/api/browse")
def browse(path: str = ""):
    """Minimal folder picker so roots can be chosen without typing a path."""
    if not path:
        drives = []
        if sys.platform == "win32":
            for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
                candidate = f"{letter}:\\"
                if os.path.isdir(candidate):
                    drives.append({"name": candidate, "path": candidate})
            home = os.path.expanduser("~")
            drives.insert(0, {"name": f"Home ({home})", "path": home})
            return {"path": "", "parent": None, "dirs": drives}
        path = os.path.expanduser("~")

    path = os.path.normpath(os.path.abspath(path))
    if not os.path.isdir(path):
        raise HTTPException(400, "Not a folder")
    dirs = []
    try:
        with os.scandir(path) as it:
            for entry in it:
                if entry.is_dir() and not entry.name.startswith("."):
                    dirs.append({"name": entry.name, "path": entry.path})
    except PermissionError:
        raise HTTPException(403, "Permission denied")
    dirs.sort(key=lambda d: d["name"].lower())
    parent = os.path.dirname(path)
    return {"path": path, "parent": None if parent == path else parent, "dirs": dirs}


# --------------------------------------------------------------------------- scan

@app.get("/api/scan")
def scan_status():
    return scanner.status()


@app.post("/api/scan")
def scan_start(body: dict = Body(default={})):
    if not db.get_roots():
        raise HTTPException(400, "Add at least one photo folder first")
    if not scanner.start(force=bool(body.get("force"))):
        raise HTTPException(409, "A scan is already running")
    return scanner.status()


@app.post("/api/scan/cancel")
def scan_cancel():
    scanner.cancel()
    return {"ok": True}


# --------------------------------------------------------------------------- photos

@app.get("/api/points")
def points(request: Request, limit: int = 500000):
    """Compact columnar payload for the map layers."""
    where, params = _filters(request)
    rows = db.connect().execute(
        f"SELECT p.id, p.lat, p.lon, p.taken_ts FROM photos p "
        f"WHERE {where} AND p.lat IS NOT NULL ORDER BY p.taken_ts LIMIT ?",
        params + [limit],
    ).fetchall()
    return JSONResponse({
        "n": len(rows),
        "ids": [r["id"] for r in rows],
        "lat": [round(r["lat"], 6) for r in rows],
        "lon": [round(r["lon"], 6) for r in rows],
        "ts": [r["taken_ts"] for r in rows],
    })


@app.get("/api/photos")
def list_photos(request: Request, limit: int = 200, offset: int = 0, sort: str = "date_desc"):
    conn = db.connect()
    where, params = _filters(request)
    order = SORTS.get(sort, SORTS["date_desc"])
    total = conn.execute(f"SELECT COUNT(*) c FROM photos p WHERE {where}", params).fetchone()["c"]
    rows = conn.execute(
        f"SELECT p.id, p.filename, p.path, p.ext, p.taken_ts, p.taken_src, p.lat, p.lon,"
        f" p.width, p.height, p.favorite, p.filesize, p.camera_make, p.camera_model,"
        f" p.note, p.duration, p.gps_method"
        f" FROM photos p WHERE {where} ORDER BY {order} LIMIT ? OFFSET ?",
        params + [min(limit, 1000), offset],
    ).fetchall()

    items = [dict(r) for r in rows]
    if items:
        ids = [i["id"] for i in items]
        by_photo: dict[int, list[int]] = {}
        for r in conn.execute(
            f"SELECT photo_id, album_id FROM album_photos WHERE photo_id IN ({','.join('?' * len(ids))})",
            ids,
        ):
            by_photo.setdefault(r["photo_id"], []).append(r["album_id"])
        for item in items:
            item["albums"] = by_photo.get(item["id"], [])
    return {"total": total, "offset": offset, "items": items}


@app.get("/api/photos/ids")
def photo_ids(request: Request, limit: int = 200000):
    where, params = _filters(request)
    rows = db.connect().execute(
        f"SELECT p.id FROM photos p WHERE {where} ORDER BY p.taken_ts DESC LIMIT ?",
        params + [limit],
    ).fetchall()
    return {"ids": [r["id"] for r in rows]}


@app.get("/api/photos/{photo_id}")
def photo_detail(photo_id: int):
    conn = db.connect()
    row = conn.execute("SELECT * FROM photos WHERE id=?", (photo_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Not found")
    data = dict(row)
    data["albums"] = [
        r["album_id"] for r in conn.execute("SELECT album_id FROM album_photos WHERE photo_id=?", (photo_id,))
    ]
    data["exists"] = os.path.exists(row["path"])
    return data


def _serve_cached(photo_id: int, size: int):
    row = db.connect().execute("SELECT path FROM photos WHERE id=?", (photo_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Not found")
    out = thumbs.build(photo_id, row["path"], size)
    if out is None:
        raise HTTPException(404, "Unreadable image")
    return FileResponse(out, media_type="image/jpeg", headers={"Cache-Control": "max-age=604800"})


@app.get("/api/photos/{photo_id}/thumb")
def photo_thumb(photo_id: int, s: int = Query(default=0)):
    return _serve_cached(photo_id, s or int(db.get_setting("thumb_size", 256)))


@app.get("/api/photos/{photo_id}/preview")
def photo_preview(photo_id: int, s: int = Query(default=0)):
    return _serve_cached(photo_id, s or int(db.get_setting("preview_size", 1600)))


# What a <video> element asks for, and the only reason this is not FileResponse:
# a player seeks by asking for byte ranges, and a server that answers every
# request with the whole file makes a two-minute clip unseekable.
VIDEO_TYPES = {
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
    ".3gp": "video/3gpp", ".3g2": "video/3gpp2",
}
# One chunk of a seek, not the whole file: a player asks for more as it plays.
VIDEO_CHUNK = 4 * 1024 * 1024


@app.get("/api/photos/{photo_id}/video")
def photo_video(photo_id: int, request: Request):
    row = db.connect().execute(
        "SELECT path, ext FROM photos WHERE id=?", (photo_id,)
    ).fetchone()
    if not row or not os.path.exists(row["path"]):
        raise HTTPException(404, "File missing")
    if not photometa.is_video(row["path"]):
        raise HTTPException(400, "Not a video")

    path = row["path"]
    total = os.path.getsize(path)
    media = VIDEO_TYPES.get(row["ext"], "application/octet-stream")
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600"}

    span = _byte_range(request.headers.get("range"), total)
    if span is None:
        return FileResponse(path, media_type=media, headers=headers)
    start, end = span
    headers["Content-Range"] = f"bytes {start}-{end}/{total}"
    headers["Content-Length"] = str(end - start + 1)

    def stream():
        with open(path, "rb") as fh:
            fh.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = fh.read(min(65536, left))
                if not chunk:
                    return
                left -= len(chunk)
                yield chunk

    return StreamingResponse(stream(), status_code=206, media_type=media, headers=headers)


def _byte_range(header: str | None, total: int) -> tuple[int, int] | None:
    """The one form players actually send: `bytes=start-` or `bytes=start-end`.

    A malformed or multi-range header is answered with the whole file rather
    than a 416: this serves one library to one browser, and refusing is worse
    than ignoring.
    """
    if not header or not header.startswith("bytes=") or "," in header:
        return None
    first, _, last = header[6:].partition("-")
    try:
        start = int(first) if first else 0
        end = int(last) if last else min(start + VIDEO_CHUNK - 1, total - 1)
    except ValueError:
        return None
    if not first and last:  # a suffix range: the last N bytes
        start, end = max(0, total - int(last)), total - 1
    end = min(end, total - 1)
    if start > end or start >= total:
        return None
    return start, end


@app.get("/api/photos/{photo_id}/original")
def photo_original(photo_id: int):
    row = db.connect().execute("SELECT path, filename FROM photos WHERE id=?", (photo_id,)).fetchone()
    if not row or not os.path.exists(row["path"]):
        raise HTTPException(404, "File missing")
    return FileResponse(row["path"], filename=row["filename"])


@app.post("/api/photos/{photo_id}/reveal")
def photo_reveal(photo_id: int):
    row = db.connect().execute("SELECT path FROM photos WHERE id=?", (photo_id,)).fetchone()
    if not row or not os.path.exists(row["path"]):
        raise HTTPException(404, "File missing")
    path = os.path.normpath(row["path"])
    if sys.platform == "win32":
        subprocess.Popen(["explorer", "/select,", path])
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", path])
    else:
        subprocess.Popen(["xdg-open", os.path.dirname(path)])
    return {"ok": True}


# How far either side of a photo to look for one with a trustworthy position.
# Past half a day it says nothing about where this one was taken.
SUGGEST_WINDOW = 12 * 3600


@app.get("/api/photos/{photo_id}/location-suggestions")
def location_suggestions(photo_id: int):
    """The nearest photos in time, before and after, that have a real GPS fix.

    Photos whose own position was a tower guess are not offered: suggesting one
    wrong position as the fix for another would only move the error.
    """
    conn = db.connect()
    row = conn.execute("SELECT taken_ts FROM photos WHERE id=?", (photo_id,)).fetchone()
    if not row or row["taken_ts"] is None:
        raise HTTPException(404, "Not found")
    ts = row["taken_ts"]
    marks = ",".join("?" * len(photometa.ESTIMATED_METHODS))
    base = (
        "SELECT id, lat, lon, taken_ts FROM photos WHERE missing=0 AND id != ?"
        f" AND lat IS NOT NULL AND (gps_method IS NULL OR gps_method NOT IN ({marks}))"
    )
    args = [photo_id, *photometa.ESTIMATED_METHODS]
    before = conn.execute(
        base + " AND taken_ts <= ? AND taken_ts >= ? ORDER BY taken_ts DESC LIMIT 1",
        args + [ts, ts - SUGGEST_WINDOW],
    ).fetchone()
    after = conn.execute(
        base + " AND taken_ts >= ? AND taken_ts <= ? ORDER BY taken_ts ASC LIMIT 1",
        args + [ts, ts + SUGGEST_WINDOW],
    ).fetchone()
    shape = lambda r: None if r is None else {  # noqa: E731
        "id": r["id"], "lat": r["lat"], "lon": r["lon"], "gap": abs(r["taken_ts"] - ts)}
    return {"before": shape(before), "after": shape(after)}


@app.post("/api/photos/{photo_id}/location")
def set_location(photo_id: int, body: dict = Body(...)):
    """Set a position by hand. Kept in location_fixes so a rescan - which reads
    the file again, and the file still holds the wrong one - does not undo it."""
    try:
        lat, lon = float(body["lat"]), float(body["lon"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "lat and lon are required")
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise HTTPException(400, "Not a position")
    conn = db.connect()
    row = conn.execute("SELECT path FROM photos WHERE id=?", (photo_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Not found")
    # A position taken from a neighbouring photo's suggestion is tagged as such,
    # the same as the batch fix, so one filter lists everything copied that way.
    method = "NEIGHBOUR" if body.get("method") == "NEIGHBOUR" else "MANUAL"
    with db.write_lock:
        conn.execute(
            "INSERT INTO location_fixes(path, lat, lon, method) VALUES (?,?,?,?)"
            " ON CONFLICT(path) DO UPDATE SET lat=excluded.lat, lon=excluded.lon,"
            " method=excluded.method",
            (row["path"], lat, lon, method),
        )
        conn.execute(
            "UPDATE photos SET lat=?, lon=?, gps_method=? WHERE id=?",
            (lat, lon, method, photo_id),
        )
        conn.commit()
    return {"lat": lat, "lon": lon, "method": method}


# The window for copying a position from a neighbouring photo in bulk. Tighter than
# the single-photo suggestions, which a person looks at before accepting.
NEIGHBOUR_WINDOW = 2 * 3600
BATCH_CAP = 5000


@app.post("/api/photos/fix-locations")
def fix_locations(body: dict = Body(...)):
    """Give each selected cell-tower photo the position of the nearest photo with a
    real GPS fix within two hours, before or after it.

    Photos with none are left as they were, and photos that were never a tower
    guess are not touched. What it changes is tagged NEIGHBOUR rather than MANUAL, so
    the batch stays findable and is never used as the source for another fix.
    """
    ids = [int(i) for i in body.get("ids", [])]
    if not ids or len(ids) > BATCH_CAP:
        raise HTTPException(400, f"Between 1 and {BATCH_CAP} photos")
    conn = db.connect()
    approx = ",".join("?" * len(photometa.APPROX_METHODS))
    estimated = ",".join("?" * len(photometa.ESTIMATED_METHODS))
    fixed = no_neighbour = skipped = 0
    for photo_id in ids:
        row = conn.execute(
            "SELECT path, taken_ts FROM photos WHERE id=? AND missing=0"
            f" AND lat IS NOT NULL AND gps_method IN ({approx})",
            [photo_id, *photometa.APPROX_METHODS],
        ).fetchone()
        if not row or row["taken_ts"] is None:
            skipped += 1
            continue
        ts = row["taken_ts"]
        near = conn.execute(
            "SELECT lat, lon FROM photos WHERE missing=0 AND id != ? AND lat IS NOT NULL"
            f" AND (gps_method IS NULL OR gps_method NOT IN ({estimated}))"
            " AND taken_ts BETWEEN ? AND ? ORDER BY ABS(taken_ts - ?) LIMIT 1",
            [photo_id, *photometa.ESTIMATED_METHODS, ts - NEIGHBOUR_WINDOW,
             ts + NEIGHBOUR_WINDOW, ts],
        ).fetchone()
        if not near:
            no_neighbour += 1
            continue
        with db.write_lock:
            conn.execute(
                "INSERT INTO location_fixes(path, lat, lon, method) VALUES (?,?,?,'NEIGHBOUR')"
                " ON CONFLICT(path) DO UPDATE SET lat=excluded.lat, lon=excluded.lon,"
                " method=excluded.method",
                (row["path"], near["lat"], near["lon"]),
            )
            conn.execute(
                "UPDATE photos SET lat=?, lon=?, gps_method='NEIGHBOUR' WHERE id=?",
                (near["lat"], near["lon"], photo_id),
            )
            conn.commit()
        fixed += 1
    return {"fixed": fixed, "no_neighbour": no_neighbour, "skipped": skipped,
            "window_hours": NEIGHBOUR_WINDOW // 3600}


@app.post("/api/photos/set-location")
def set_locations(body: dict = Body(...)):
    """One position for every selected photo, whatever they had before - a photo
    with none, a tower guess, or a real fix that was wrong. Kept as MANUAL in
    location_fixes, like a single set_location, so a rescan does not undo it."""
    ids = [int(i) for i in body.get("ids", [])]
    try:
        lat, lon = float(body["lat"]), float(body["lon"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "lat and lon are required")
    if not ids or len(ids) > BATCH_CAP:
        raise HTTPException(400, f"Between 1 and {BATCH_CAP} photos")
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise HTTPException(400, "Not a position")
    conn = db.connect()
    changed = 0
    with db.write_lock:
        for photo_id in ids:
            row = conn.execute(
                "SELECT path FROM photos WHERE id=? AND missing=0", (photo_id,)
            ).fetchone()
            if not row:
                continue
            conn.execute(
                "INSERT INTO location_fixes(path, lat, lon, method) VALUES (?,?,?,'MANUAL')"
                " ON CONFLICT(path) DO UPDATE SET lat=excluded.lat, lon=excluded.lon,"
                " method='MANUAL'",
                (row["path"], lat, lon),
            )
            conn.execute(
                "UPDATE photos SET lat=?, lon=?, gps_method='MANUAL' WHERE id=?",
                (lat, lon, photo_id),
            )
            changed += 1
        conn.commit()
    return {"changed": changed, "lat": lat, "lon": lon}


@app.post("/api/photos/undo-location")
def undo_locations(body: dict = Body(...)):
    """Put selected photos back to the position their own file holds.

    Reads the file again rather than remembering what was there: the file is the
    one place the original is guaranteed to still be, whatever number of fixes
    were made on top of it since. Photos with no stored fix are left as they are.
    """
    ids = [int(i) for i in body.get("ids", [])]
    if not ids or len(ids) > BATCH_CAP:
        raise HTTPException(400, f"Between 1 and {BATCH_CAP} photos")
    conn = db.connect()
    restored = unchanged = unreadable = 0
    for photo_id in ids:
        row = conn.execute(
            "SELECT p.path FROM photos p JOIN location_fixes f ON f.path = p.path"
            " WHERE p.id=? AND p.missing=0",
            (photo_id,),
        ).fetchone()
        if not row:
            unchanged += 1
            continue
        if not os.path.exists(row["path"]):
            unreadable += 1
            continue
        meta = photometa.read(row["path"])
        with db.write_lock:
            conn.execute("DELETE FROM location_fixes WHERE path=?", (row["path"],))
            conn.execute(
                "UPDATE photos SET lat=?, lon=?, gps_method=? WHERE id=?",
                (meta["lat"], meta["lon"], meta.get("gps_method"), photo_id),
            )
            conn.commit()
        restored += 1
    return {"restored": restored, "unchanged": unchanged, "unreadable": unreadable}


@app.post("/api/photos/{photo_id}/taken")
def set_taken(photo_id: int, body: dict = Body(...)):
    """Set one photo's capture time, as a wall clock: YYYY-MM-DD HH:MM:SS."""
    try:
        when = datetime.datetime.strptime(str(body.get("taken", "")), "%Y-%m-%d %H:%M:%S")
    except ValueError:
        raise HTTPException(400, "taken must be YYYY-MM-DD HH:MM:SS")
    ts = photometa.wall_ts(when)
    if not scanner.set_taken(db.connect(), photo_id, ts):
        raise HTTPException(404, "Not found")
    return {"taken_ts": ts}


@app.post("/api/photos/shift-dates")
def shift_dates(body: dict = Body(...)):
    folder = str(body.get("folder") or "").strip()
    day = str(body.get("to") or "")
    start = body.get("from")
    if not folder or not days.valid_day(day) or (start and not days.valid_day(str(start))):
        raise HTTPException(400, "folder and to (YYYY-MM-DD) are required")
    return scanner.shift_dates(db.connect(), folder, day, str(start) if start else None)


@app.post("/api/photos/{photo_id}/note")
def set_note(photo_id: int, body: dict = Body(...)):
    """An empty note is stored as NULL, so the search LIKE never matches it."""
    note = (body.get("note") or "").strip()
    conn = db.connect()
    with db.write_lock:
        cur = conn.execute("UPDATE photos SET note=? WHERE id=?", (note or None, photo_id))
        conn.commit()
    if not cur.rowcount:
        raise HTTPException(404, "Not found")
    return {"note": note}


@app.post("/api/photos/favorite")
def set_favorite(body: dict = Body(...)):
    ids = [int(i) for i in body.get("ids", [])]
    value = 1 if body.get("value", True) else 0
    conn = db.connect()
    with db.write_lock:
        conn.executemany("UPDATE photos SET favorite=? WHERE id=?", [(value, i) for i in ids])
        conn.commit()
    return {"updated": len(ids)}


@app.post("/api/photos/delete")
def delete_photos(body: dict = Body(...)):
    """mode=trash moves files to the recycle bin; mode=forget only unindexes them."""
    ids = [int(i) for i in body.get("ids", [])]
    mode = body.get("mode", "trash")
    if mode not in ("trash", "forget"):
        raise HTTPException(400, "mode must be 'trash' or 'forget'")

    conn = db.connect()
    deleted, failed = [], []
    for photo_id in ids:
        row = conn.execute("SELECT path FROM photos WHERE id=?", (photo_id,)).fetchone()
        if not row:
            continue
        if mode == "trash" and os.path.exists(row["path"]):
            try:
                if RECYCLE_OK:
                    send2trash(os.path.normpath(row["path"]))
                else:
                    db.TRASH_DIR.mkdir(parents=True, exist_ok=True)
                    target = db.TRASH_DIR / f"{photo_id}_{os.path.basename(row['path'])}"
                    shutil.move(row["path"], target)
            except Exception as exc:
                failed.append({"id": photo_id, "error": str(exc)})
                continue
        deleted.append(photo_id)

    if deleted:
        with db.write_lock:
            conn.executemany("DELETE FROM album_photos WHERE photo_id=?", [(i,) for i in deleted])
            conn.executemany("DELETE FROM photos WHERE id=?", [(i,) for i in deleted])
            conn.commit()
        for photo_id in deleted:
            thumbs.drop(photo_id)
    return {
        "deleted": len(deleted),
        "failed": failed,
        "location": "recycle bin" if RECYCLE_OK else str(db.TRASH_DIR),
        "mode": mode,
    }


# --------------------------------------------------------------------------- journal
#
# The day itself, its text and where it happened all live in backend/days.py:
# entries are written from the cloud viewer too, and those arrive through the
# bucket rather than through here.


@app.get("/api/days")
def list_days():
    return days.listing()


@app.put("/api/days/{day}")
def save_day(day: str, body: dict = Body(...)):
    if not days.valid_day(day):
        raise HTTPException(400, "Day must be YYYY-MM-DD")
    return days.save(
        day, body.get("text") or "", body.get("lat"), body.get("lon"), body.get("loc_src")
    )


# --------------------------------------------------------------------------- albums

@app.get("/api/albums")
def list_albums():
    rows = db.connect().execute(
        "SELECT a.id, a.name, a.color, a.created_ts,"
        " (SELECT COUNT(*) FROM album_photos ap WHERE ap.album_id=a.id) AS photo_count,"
        " (SELECT COUNT(*) FROM album_photos ap JOIN photos p ON p.id=ap.photo_id"
        "   WHERE ap.album_id=a.id AND p.lat IS NOT NULL) AS geo_count,"
        " (SELECT MIN(p.taken_ts) FROM album_photos ap JOIN photos p ON p.id=ap.photo_id"
        "   WHERE ap.album_id=a.id) AS start_ts,"
        " (SELECT MAX(p.taken_ts) FROM album_photos ap JOIN photos p ON p.id=ap.photo_id"
        "   WHERE ap.album_id=a.id) AS end_ts"
        " FROM albums a ORDER BY a.name COLLATE NOCASE"
    ).fetchall()
    return [dict(r) for r in rows]


@app.post("/api/albums")
def create_album(body: dict = Body(...)):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "Name required")
    conn = db.connect()
    try:
        with db.write_lock:
            cur = conn.execute(
                "INSERT INTO albums(name, color, created_ts) VALUES (?,?,?)",
                (name, body.get("color") or "#ff5a5f", int(time.time())),
            )
            conn.commit()
    except Exception:
        raise HTTPException(409, "An album with that name already exists")
    album_id = cur.lastrowid
    ids = [int(i) for i in body.get("ids", [])]
    if ids:
        _album_add(album_id, ids)
    return {"id": album_id}


@app.patch("/api/albums/{album_id}")
def update_album(album_id: int, body: dict = Body(...)):
    conn = db.connect()
    fields, params = [], []
    if "name" in body:
        fields.append("name=?")
        params.append(body["name"].strip())
    if "color" in body:
        fields.append("color=?")
        params.append(body["color"])
    if not fields:
        return {"ok": True}
    with db.write_lock:
        conn.execute(f"UPDATE albums SET {','.join(fields)} WHERE id=?", params + [album_id])
        conn.commit()
    return {"ok": True}


@app.delete("/api/albums/{album_id}")
def delete_album(album_id: int):
    conn = db.connect()
    with db.write_lock:
        conn.execute("DELETE FROM albums WHERE id=?", (album_id,))
        conn.commit()
    return {"ok": True}


def _album_add(album_id: int, ids: list[int]) -> int:
    conn = db.connect()
    with db.write_lock:
        conn.executemany(
            "INSERT OR IGNORE INTO album_photos(album_id, photo_id) VALUES (?,?)",
            [(album_id, i) for i in ids],
        )
        conn.commit()
    return len(ids)


@app.post("/api/albums/{album_id}/photos")
def album_add(album_id: int, body: dict = Body(...)):
    ids = [int(i) for i in body.get("ids", [])]
    return {"added": _album_add(album_id, ids)}


@app.post("/api/albums/{album_id}/photos/remove")
def album_remove(album_id: int, body: dict = Body(...)):
    ids = [int(i) for i in body.get("ids", [])]
    conn = db.connect()
    with db.write_lock:
        conn.executemany(
            "DELETE FROM album_photos WHERE album_id=? AND photo_id=?", [(album_id, i) for i in ids]
        )
        conn.commit()
    return {"removed": len(ids)}


@app.get("/api/duplicates")
def list_duplicates(limit: int = 200, offset: int = 0):
    limit = max(1, min(limit, 500))
    offset = max(0, offset)
    summary = dupes.summarise()
    return {
        "scan": dupes.status(),
        "summary": summary,
        "limit": limit,
        "offset": offset,
        "total": summary["sets"],
        "groups": dupes.groups(limit=limit, offset=offset),
    }


@app.get("/api/duplicates/all")
def all_duplicates():
    """Every set at once, for selecting them in bulk without paging."""
    return {"sets": dupes.all_sets()}


@app.post("/api/duplicates/scan")
def scan_duplicates():
    if not dupes.start():
        raise HTTPException(409, "A duplicate scan is already running")
    return dupes.status()


@app.post("/api/duplicates/scan/cancel")
def cancel_duplicates():
    dupes.cancel()
    return {"ok": True}


@app.post("/api/duplicates/resolve")
def resolve_duplicates(body: dict = Body(...)):
    """Delete the extra copies of each set, never the last one.

    The caller sends the ids to keep. Anything else in those sets is moved to
    the recycle bin. A set whose keep id is missing is skipped rather than
    guessed at, so a malformed request cannot wipe a whole set.
    """
    keep_ids = {int(i) for i in body.get("keep", [])}
    hashes = [str(h) for h in body.get("hashes", [])]
    if not hashes:
        raise HTTPException(400, "No duplicate sets given")

    conn = db.connect()
    to_delete: list[int] = []
    skipped: list[str] = []
    for digest in hashes:
        rows = conn.execute(
            "SELECT id FROM photos WHERE content_hash=? AND missing=0", (digest,)
        ).fetchall()
        ids = [r["id"] for r in rows]
        keepers = [i for i in ids if i in keep_ids]
        if len(ids) < 2 or len(keepers) != 1:
            skipped.append(digest)
            continue
        to_delete.extend(i for i in ids if i not in keep_ids)

    if not to_delete:
        return {"deleted": 0, "skipped": skipped, "failed": []}

    result = delete_photos({"ids": to_delete, "mode": body.get("mode", "trash")})
    result["skipped"] = skipped
    return result


@app.post("/api/photos/redate")
def redate(body: dict = Body(default={})):
    """Re-derive capture times from filenames for photos still on the file date.

    Cheaper than a full rescan: no image is opened, only the name is read.
    """
    conn = db.connect()
    dry_run = bool(body.get("dry_run"))
    rows = conn.execute(
        "SELECT id, filename, taken_ts FROM photos WHERE missing=0 AND taken_src='mtime'"
    ).fetchall()

    updates, samples = [], []
    for row in rows:
        ts, label = nametime.parse(row["filename"])
        if ts is None or ts == row["taken_ts"]:
            continue
        updates.append((ts, row["id"]))
        if len(samples) < 10:
            samples.append({
                "filename": row["filename"],
                "from": row["taken_ts"],
                "to": ts,
                "pattern": label,
            })

    if updates and not dry_run:
        with db.write_lock:
            conn.executemany(
                "UPDATE photos SET taken_ts=?, taken_src='filename' WHERE id=?", updates
            )
            conn.commit()

    return {
        "candidates": len(rows),
        "updated": 0 if dry_run else len(updates),
        "would_update": len(updates),
        "dry_run": dry_run,
        "samples": samples,
    }


# --------------------------------------------------------------------------- analytics

BUCKETS = {
    "hour": "CAST(p.taken_ts / 3600 * 3600 AS INTEGER)",
    "day": "CAST(strftime('%s', date(p.taken_ts, 'unixepoch')) AS INTEGER)",
    "month": "CAST(strftime('%s', strftime('%Y-%m-01', p.taken_ts, 'unixepoch')) AS INTEGER)",
    "year": "CAST(strftime('%s', strftime('%Y-01-01', p.taken_ts, 'unixepoch')) AS INTEGER)",
}


@app.get("/api/timeline")
def timeline(request: Request, bucket: str = "auto"):
    conn = db.connect()
    where, params = _filters(request)

    if bucket == "auto":
        span = conn.execute(
            f"SELECT MIN(p.taken_ts) a, MAX(p.taken_ts) b FROM photos p WHERE {where}", params
        ).fetchone()
        if span["a"] is None:
            return {"bucket": "day", "items": []}
        days = (span["b"] - span["a"]) / 86400.0
        bucket = "hour" if days <= 4 else "day" if days <= 400 else "month" if days <= 5000 else "year"

    expr = BUCKETS.get(bucket, BUCKETS["day"])
    rows = conn.execute(
        f"SELECT {expr} AS b, COUNT(*) AS c,"
        f" SUM(CASE WHEN p.lat IS NOT NULL THEN 1 ELSE 0 END) AS g"
        f" FROM photos p WHERE {where} AND p.taken_ts IS NOT NULL GROUP BY b ORDER BY b",
        params,
    ).fetchall()
    return {"bucket": bucket, "items": [[r["b"], r["c"], r["g"]] for r in rows]}


DIST = {
    "hour": "CAST(strftime('%H', p.taken_ts, 'unixepoch') AS INTEGER)",
    "dow": "CAST(strftime('%w', p.taken_ts, 'unixepoch') AS INTEGER)",
    "month": "CAST(strftime('%m', p.taken_ts, 'unixepoch') AS INTEGER)",
    "year": "CAST(strftime('%Y', p.taken_ts, 'unixepoch') AS INTEGER)",
}


@app.get("/api/dist")
def distribution(request: Request, field: str = "hour"):
    where, params = _filters(request)
    expr = DIST.get(field)
    if not expr:
        raise HTTPException(400, "Unknown field")
    rows = db.connect().execute(
        f"SELECT {expr} AS k, COUNT(*) AS c FROM photos p"
        f" WHERE {where} AND p.taken_ts IS NOT NULL GROUP BY k ORDER BY k",
        params,
    ).fetchall()
    return {"field": field, "items": [[r["k"], r["c"]] for r in rows]}


@app.get("/api/stats")
def stats(request: Request):
    conn = db.connect()
    where, params = _filters(request)
    base = conn.execute(
        f"SELECT COUNT(*) total,"
        f" SUM(CASE WHEN p.lat IS NOT NULL THEN 1 ELSE 0 END) geo,"
        f" MIN(p.taken_ts) first_ts, MAX(p.taken_ts) last_ts,"
        f" SUM(p.filesize) bytes"
        f" FROM photos p WHERE {where}",
        params,
    ).fetchone()
    cameras = conn.execute(
        f"SELECT TRIM(COALESCE(p.camera_make,'') || ' ' || COALESCE(p.camera_model,'')) AS name,"
        f" COUNT(*) c FROM photos p WHERE {where} GROUP BY name ORDER BY c DESC LIMIT 12",
        params,
    ).fetchall()
    missing = conn.execute("SELECT COUNT(*) c FROM photos WHERE missing=1").fetchone()["c"]
    return {
        **dict(base),
        "missing": missing,
        "cameras": [dict(r) for r in cameras if r["name"]],
    }


class AppFiles(StaticFiles):
    """Serve the UI with revalidation.

    Without an explicit header browsers fall back to heuristic caching, which
    leaves people running stale JS and CSS after the app is updated. ETags keep
    the revalidation cheap (304s). Photo bytes are unaffected: those endpoints
    set their own long-lived cache headers.
    """

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/", AppFiles(directory=FRONTEND, html=True), name="frontend")
