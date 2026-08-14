"""Build the portable snapshot: a compact manifest plus small thumbnails.

Thumbnails are content-addressed (`t/<sha1-16>.jpg`), which gives delta uploads
and deduplication for free: an unchanged photo hashes to the same key and is
skipped, and two identical photos share one object.

Scope is a setting. "located" publishes only photos with GPS (a heat map);
"all" publishes the whole library so the cloud viewer can browse a gallery.
Sizing on a 26,729-photo library: roughly 12KB per unique thumbnail at 160px,
about 313MB, or 3% of R2's free tier.
"""
import hashlib
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor

from . import db, thumbs

MANIFEST_KEY = "manifest.json"
THUMB_PREFIX = "t/"
INBOX_PREFIX = "inbox/"
MANIFEST_VERSION = 4


def _thumb_hash(path) -> tuple[str, int]:
    data = path.read_bytes()
    return hashlib.sha1(data).hexdigest()[:16], len(data)


def thumb_key(digest: str) -> str:
    return f"{THUMB_PREFIX}{digest}.jpg"


def build(progress=None) -> tuple[dict, dict]:
    """Return (manifest, {key: local_thumb_path})."""
    conn = db.connect()
    size = int(db.get_setting("snapshot_thumb_size", 160))
    scope = db.get_setting("snapshot_scope", "all")

    where = "missing=0" + (" AND lat IS NOT NULL" if scope == "located" else "")
    rows = conn.execute(
        f"SELECT id, path, lat, lon, taken_ts, mtime, favorite,"
        f" filesize, camera_make, camera_model, filename, note FROM photos"
        f" WHERE {where} ORDER BY taken_ts DESC, id DESC"
    ).fetchall()

    cached = {
        r["photo_id"]: (r["mtime"], r["hash"], r["size"])
        for r in conn.execute("SELECT photo_id, mtime, hash, size FROM snapshot_thumbs")
    }

    ids: list[int] = []
    lat: list[float | None] = []
    lon: list[float | None] = []
    stamps: list[int] = []
    digests: list[str] = []
    favourites: list[int] = []
    sizes: list[int] = []
    # What the viewer's search box looks through. The filename, not the full
    # path: it is what anyone actually searches for, and a path would publish
    # the shape of the disk it came from for no gain. Filenames share long
    # prefixes, so this compresses about ten to one on the wire.
    names: list[str] = []
    # Sparse: almost no photo has a note, so a full array would be 26,000 empty
    # strings to carry a handful of real ones.
    notes: dict[str, str] = {}
    # Camera names repeat across thousands of photos, so they are published once
    # in `cams` and referenced by index. -1 is "no camera recorded".
    cameras: list[int] = []
    camera_names: list[str] = []
    camera_index: dict[str, int] = {}
    files: dict[str, object] = {}
    fresh: list[tuple] = []
    total_bytes = 0

    def prepare(row):
        """Resolve one photo's snapshot thumbnail. Runs on the pool."""
        entry = cached.get(row["id"])
        path = thumbs.cache_path(row["id"], size)
        if entry and entry[0] == row["mtime"] and path.exists():
            return row, entry[1], entry[2], path, False
        built = thumbs.build(row["id"], row["path"], size)
        if built is None:
            return row, None, 0, None, False  # unreadable: leave it out
        digest, byte_count = _thumb_hash(built)
        return row, digest, byte_count, built, True

    # Decoding a 100GB library one image at a time managed ~4 thumbnails/second.
    # The work is CPU-bound in Pillow, which releases the GIL while decoding.
    done = 0
    with ThreadPoolExecutor(max_workers=min(12, (os.cpu_count() or 4) * 2)) as pool:
        for row, digest, byte_count, path, is_new in pool.map(prepare, rows, chunksize=16):
            done += 1
            if progress and done % 50 == 0:
                progress(done, len(rows))
            if digest is None:
                continue
            if is_new:
                fresh.append((row["id"], row["mtime"], digest, byte_count))

            ids.append(row["id"])
            lat.append(round(row["lat"], 5) if row["lat"] is not None else None)
            lon.append(round(row["lon"], 5) if row["lon"] is not None else None)
            stamps.append(row["taken_ts"] or 0)
            digests.append(digest)
            favourites.append(1 if row["favorite"] else 0)
            sizes.append(row["filesize"] or 0)
            names.append(row["filename"] or "")
            note = (row["note"] or "").strip()
            if note:
                notes[str(row["id"])] = note
            name = f"{row['camera_make'] or ''} {row['camera_model'] or ''}".strip()
            if name:
                if name not in camera_index:
                    camera_index[name] = len(camera_names)
                    camera_names.append(name)
                cameras.append(camera_index[name])
            else:
                cameras.append(-1)
            key = thumb_key(digest)
            if key not in files:
                files[key] = path
                total_bytes += byte_count

    if fresh:
        with db.write_lock:
            conn.executemany(
                "INSERT INTO snapshot_thumbs(photo_id, mtime, hash, size) VALUES (?,?,?,?)"
                " ON CONFLICT(photo_id) DO UPDATE SET mtime=excluded.mtime,"
                " hash=excluded.hash, size=excluded.size",
                fresh,
            )
            conn.commit()

    published = set(ids)
    albums = []
    for album in conn.execute("SELECT id, name, color FROM albums ORDER BY name COLLATE NOCASE"):
        members = [
            r["photo_id"]
            for r in conn.execute(
                "SELECT photo_id FROM album_photos WHERE album_id=?", (album["id"],)
            )
            if r["photo_id"] in published
        ]
        albums.append({
            "id": album["id"],
            "name": album["name"],
            "color": album["color"],
            "photos": members,
        })

    # Duplicate sets among published photos, so the viewer can offer the one
    # destructive action the cloud is allowed: removing extra copies.
    duplicate_sets = []
    for row in conn.execute(
        "SELECT content_hash, COUNT(*) n FROM photos"
        " WHERE missing=0 AND content_hash IS NOT NULL"
        " GROUP BY content_hash HAVING n > 1"
    ):
        members = [
            r["id"]
            for r in conn.execute(
                "SELECT id FROM photos WHERE content_hash=? AND missing=0 ORDER BY added_ts, id",
                (row["content_hash"],),
            )
            if r["id"] in published
        ]
        if len(members) > 1:
            duplicate_sets.append({"hash": row["content_hash"], "ids": members, "keep": members[0]})

    located = [i for i, value in enumerate(lat) if value is not None]
    bounds = None
    if located:
        lats = [lat[i] for i in located]
        lons = [lon[i] for i in located]
        bounds = [min(lats), min(lons), max(lats), max(lons)]

    totals = conn.execute(
        "SELECT COUNT(*) total, SUM(CASE WHEN lat IS NOT NULL THEN 1 ELSE 0 END) located"
        " FROM photos WHERE missing=0"
    ).fetchone()

    manifest = {
        "v": MANIFEST_VERSION,
        "generated": int(time.time()),
        "scope": scope,
        "n": len(ids),
        "geo_n": len(located),
        "bounds": bounds,
        "ids": ids,
        "lat": lat,
        "lon": lon,
        "ts": stamps,
        "th": digests,
        "fav": favourites,
        "sz": sizes,
        "cam": cameras,
        "cams": camera_names,
        "name": names,
        "notes": notes,
        "albums": albums,
        "dupes": duplicate_sets,
        # Tells the viewer whether to offer deletion at all. The desktop side
        # re-checks this on apply, so a stale manifest cannot grant it.
        "allow_delete": db.get_setting("cloud_delete_enabled", "0") == "1",
        "delete_cap": 200,
        "first_ts": min(stamps) if stamps else None,
        "last_ts": max(stamps) if stamps else None,
        "total_photos": totals["total"] or 0,
        "located": totals["located"] or 0,
        "thumb_size": size,
        "bytes": total_bytes,
    }
    if progress:
        progress(len(rows), len(rows))
    return manifest, files


def manifest_bytes(manifest: dict) -> bytes:
    return json.dumps(manifest, separators=(",", ":")).encode("utf-8")


def estimate() -> dict:
    """What a full publish would cost, for the settings dialog."""
    conn = db.connect()
    size = int(db.get_setting("snapshot_thumb_size", 160))
    scope = db.get_setting("snapshot_scope", "all")
    where = "missing=0" + (" AND lat IS NOT NULL" if scope == "located" else "")
    count = conn.execute(f"SELECT COUNT(*) c FROM photos WHERE {where}").fetchone()["c"]
    per_thumb = {128: 8, 160: 12, 192: 17, 256: 25, 384: 50}.get(size, 12)
    return {
        "scope": scope,
        "photos": count,
        "thumb_size": size,
        "estimated_bytes": count * per_thumb * 1024,
        "free_tier_pct": round(count * per_thumb * 1024 / (10 * 1024 ** 3) * 100, 1),
    }
