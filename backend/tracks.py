"""Position logs: GPX files and Google Timeline exports.

A track says where a phone or a logger was at each moment, which places photos
from a camera that has no GPS of its own - the Lightroom way, by matching
capture times against the log. It also draws the route itself on the map.

Accepted:
  * GPX: track, route and waypoint points that carry a time.
  * Google Takeout "Location History": Records.json, and the monthly Semantic
    Location History files (placeVisit / activitySegment).
  * The newer on-device Timeline export (Timeline.json, "semanticSegments",
    "rawSignals"), from Android, and its list-shaped iPhone variant with
    "geo:lat,lon" strings.
  * A .zip of any of these, such as a whole Takeout archive.

Times in a log are real UTC. A photo's taken_ts is the camera's wall clock, so
matching needs the difference between the two: the time zone, plus whatever
the camera clock was off by. That offset is either given, guessed from photos
that have both GPS and a time (estimate_offset), or taken as this computer's
own time zone on each photo's date.
"""
import bisect
import datetime
import io
import json
import re
import time
import xml.etree.ElementTree as ET
import zipfile
from xml.sax.saxutils import escape

from . import db, places

# Two log points further apart than this in time say nothing about where you
# were in between, so a photo in the hole is not placed.
DEFAULT_GAP = 30 * 60
METHOD = "TRACK"


# ------------------------------------------------------------------ parsing

def _utc(value) -> int | None:
    """An ISO 8601 time, or epoch milliseconds as text, into epoch seconds."""
    if value is None:
        return None
    if isinstance(value, (int, float)) or (isinstance(value, str) and value.isdigit()):
        n = int(value)
        return n // 1000 if n > 10_000_000_000 else n
    try:
        when = datetime.datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=datetime.timezone.utc)
    return int(when.timestamp())


_LATLNG = re.compile(r"(-?\d+(?:\.\d+)?)\s*°?\s*,\s*(-?\d+(?:\.\d+)?)")


def _latlng(value) -> tuple[float, float] | None:
    """'51.5°, -0.12°', 'geo:51.5,-0.12', {'latLng': …} or {'latitudeE7': …}."""
    if isinstance(value, dict):
        if "latitudeE7" in value and "longitudeE7" in value:
            return value["latitudeE7"] / 1e7, value["longitudeE7"] / 1e7
        if "latE7" in value and "lngE7" in value:
            return value["latE7"] / 1e7, value["lngE7"] / 1e7
        for key in ("latLng", "LatLng", "placeLocation", "point", "location"):
            if key in value:
                return _latlng(value[key])
        return None
    if isinstance(value, str):
        m = _LATLNG.search(value)
        if m:
            return float(m.group(1)), float(m.group(2))
    return None


def _ok(lat, lon) -> bool:
    return -90 <= lat <= 90 and -180 <= lon <= 180 and not (lat == 0 and lon == 0)


def parse_gpx(data: bytes) -> list[tuple[int, float, float]]:
    out = []
    for _, node in ET.iterparse(io.BytesIO(data)):
        tag = node.tag.rsplit("}", 1)[-1]
        if tag not in ("trkpt", "rtept", "wpt"):
            continue
        when = None
        for child in node:
            if child.tag.rsplit("}", 1)[-1] == "time":
                when = _utc(child.text)
        try:
            lat, lon = float(node.get("lat")), float(node.get("lon"))
        except (TypeError, ValueError):
            continue
        if when is not None and _ok(lat, lon):
            out.append((when, lat, lon))
        node.clear()
    return out


def parse_json(doc) -> list[tuple[int, float, float]]:
    """Every timed position in any of Google's location exports."""
    out: list[tuple[int, float, float]] = []

    def add(ts, at):
        if ts is not None and at and _ok(*at):
            out.append((ts, at[0], at[1]))

    def walk(node, start=None, end=None):
        if isinstance(node, list):
            for item in node:
                walk(item, start, end)
            return
        if not isinstance(node, dict):
            return
        # Records.json, and the points of a simplifiedRawPath.
        if ("latitudeE7" in node or "latE7" in node) and (
                "timestamp" in node or "timestampMs" in node):
            add(_utc(node.get("timestamp") or node.get("timestampMs")), _latlng(node))
            return
        # Semantic Location History (Takeout, until 2024).
        if "placeVisit" in node or "activitySegment" in node:
            seg = node.get("placeVisit") or node.get("activitySegment")
            dur = seg.get("duration") or {}
            s, e = _utc(dur.get("startTimestamp")), _utc(dur.get("endTimestamp"))
            if "placeVisit" in node:
                at = _latlng(seg.get("location") or {})
                add(s, at)
                add(e, at)
            else:
                add(s, _latlng(seg.get("startLocation") or {}))
                add(e, _latlng(seg.get("endLocation") or {}))
                for key in ("simplifiedRawPath", "waypointPath"):
                    path = seg.get(key) or {}
                    walk(path.get("points") or [], s, e)
            return
        # On-device Timeline: a segment with a start and end time.
        s = _utc(node.get("startTime")) if "startTime" in node else start
        e = _utc(node.get("endTime")) if "endTime" in node else end
        if "visit" in node:
            cand = (node["visit"] or {}).get("topCandidate") or {}
            at = _latlng(cand.get("placeLocation") or cand)
            add(s, at)
            add(e, at)
        if "activity" in node and isinstance(node["activity"], dict):
            add(s, _latlng(node["activity"].get("start")))
            add(e, _latlng(node["activity"].get("end")))
        if "timelinePath" in node:
            for p in node["timelinePath"] or []:
                if not isinstance(p, dict):
                    continue
                if "time" in p:
                    ts = _utc(p["time"])
                elif "durationMinutesOffsetFromStartTime" in p and s is not None:
                    ts = s + int(float(p["durationMinutesOffsetFromStartTime"]) * 60)
                else:
                    ts = None
                add(ts, _latlng(p.get("point")))
        if "position" in node and isinstance(node["position"], dict):
            pos = node["position"]
            add(_utc(pos.get("timestamp")), _latlng(pos.get("LatLng") or pos.get("latLng") or ""))
        for key in ("locations", "timelineObjects", "semanticSegments", "rawSignals"):
            if key in node:
                walk(node[key], s, e)

    walk(doc)
    return out


def parse(name: str, data: bytes) -> list[tuple[str, list]]:
    """[(name, points)] for one uploaded file; a zip can hold several."""
    lower = name.lower()
    if lower.endswith(".zip") or data[:4] == b"PK\x03\x04":
        found = []
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for info in archive.infolist():
                inner = info.filename.lower()
                if info.is_dir() or not inner.endswith((".gpx", ".json")):
                    continue
                for label, pts in parse(info.filename, archive.read(info)):
                    if pts:
                        found.append((label, pts))
        return found
    head = data.lstrip()[:200]
    if lower.endswith(".gpx") or head.startswith(b"<"):
        return [(name, parse_gpx(data))]
    try:
        doc = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError):
        raise ValueError(f"{name}: neither a GPX file nor a Google location export")
    return [(name, parse_json(doc))]


# ------------------------------------------------------------------- storage

def store(name: str, source: str, points: list[tuple[int, float, float]]) -> dict | None:
    pts = sorted(set(points))
    # One position per second is plenty, and Takeout repeats itself.
    dedup, last = [], None
    for p in pts:
        if p[0] != last:
            dedup.append(p)
            last = p[0]
    if not dedup:
        return None
    conn = db.connect()
    with db.write_lock:
        cur = conn.execute(
            "INSERT INTO tracks(name, source, points, first_ts, last_ts, imported_ts) VALUES (?,?,?,?,?,?)",
            (name[:200], source, len(dedup), dedup[0][0], dedup[-1][0], int(time.time())),
        )
        tid = cur.lastrowid
        conn.executemany("INSERT INTO track_points(track_id, ts, lat, lon) VALUES (?,?,?,?)",
                         [(tid, *p) for p in dedup])
        conn.commit()
    return get(tid)


def import_file(name: str, data: bytes) -> list[dict]:
    saved = []
    for label, pts in parse(name, data):
        source = "gpx" if label.lower().endswith(".gpx") else "google"
        track = store(label.rsplit("/", 1)[-1], source, pts)
        if track:
            saved.append(track)
    return saved


def get(track_id: int) -> dict | None:
    row = db.connect().execute("SELECT * FROM tracks WHERE id=?", (track_id,)).fetchone()
    return dict(row) if row else None


def list_all() -> list[dict]:
    return [dict(r) for r in db.connect().execute("SELECT * FROM tracks ORDER BY first_ts DESC")]


def delete(track_id: int) -> bool:
    conn = db.connect()
    with db.write_lock:
        conn.execute("DELETE FROM track_points WHERE track_id=?", (track_id,))
        gone = conn.execute("DELETE FROM tracks WHERE id=?", (track_id,)).rowcount
        conn.commit()
    return bool(gone)


def points(start: int | None = None, end: int | None = None, limit: int = 20000) -> dict:
    """Track positions for drawing, thinned evenly to at most `limit`."""
    where, args = ["1=1"], []
    if start is not None:
        where.append("ts >= ?")
        args.append(start - 86400)  # a wall-clock filter against UTC: be generous
    if end is not None:
        where.append("ts <= ?")
        args.append(end + 86400)
    conn = db.connect()
    clause = " AND ".join(where)
    n = conn.execute(f"SELECT COUNT(*) c FROM track_points WHERE {clause}", args).fetchone()["c"]
    step = max(1, -(-n // limit))
    rows = conn.execute(
        f"SELECT ts, lat, lon FROM (SELECT ts, lat, lon, ROW_NUMBER() OVER (ORDER BY ts) AS rn"
        f" FROM track_points WHERE {clause}) WHERE (rn - 1) % ? = 0 ORDER BY ts",
        args + [step],
    ).fetchall()
    return {"n": len(rows), "total": n, "ts": [r["ts"] for r in rows],
            "lat": [round(r["lat"], 6) for r in rows], "lon": [round(r["lon"], 6) for r in rows]}


# ----------------------------------------------------------------- matching

class Log:
    """Every stored track point in a time window, merged and sorted."""

    def __init__(self, start: int, end: int):
        rows = db.connect().execute(
            "SELECT ts, lat, lon FROM track_points WHERE ts BETWEEN ? AND ? ORDER BY ts",
            (start, end),
        ).fetchall()
        self.ts = [r["ts"] for r in rows]
        self.lat = [r["lat"] for r in rows]
        self.lon = [r["lon"] for r in rows]

    def __len__(self):
        return len(self.ts)

    def at(self, utc: int, gap: int) -> tuple[float, float] | None:
        """Where the log says you were at `utc`: between the two points either
        side when both are within `gap`, else the nearer one if it is."""
        i = bisect.bisect_left(self.ts, utc)
        before = i - 1 if i > 0 else None
        after = i if i < len(self.ts) else None
        if after is not None and self.ts[after] == utc:
            return self.lat[after], self.lon[after]
        db_ = utc - self.ts[before] if before is not None else None
        da = self.ts[after] - utc if after is not None else None
        if db_ is not None and da is not None and db_ <= gap and da <= gap:
            f = db_ / (db_ + da)
            return (self.lat[before] + (self.lat[after] - self.lat[before]) * f,
                    self.lon[before] + (self.lon[after] - self.lon[before]) * f)
        if db_ is not None and db_ <= gap and (da is None or db_ <= da):
            return self.lat[before], self.lon[before]
        if da is not None and da <= gap:
            return self.lat[after], self.lon[after]
        return None


def local_offset(wall_ts: int) -> int:
    """This computer's UTC offset on a photo's date, daylight saving included."""
    guess = time.localtime(wall_ts)
    return guess.tm_gmtoff or 0


def _span(conn) -> tuple[int, int] | None:
    row = conn.execute("SELECT MIN(first_ts) a, MAX(last_ts) b FROM tracks").fetchone()
    return (row["a"], row["b"]) if row and row["a"] is not None else None


def estimate_offset(gap: int = DEFAULT_GAP) -> dict:
    """The camera-clock-minus-UTC offset that best lines photos up with the log.

    Tries every quarter hour from -14 h to +14 h against the photos that do have
    a GPS position and count how many land within a kilometre of where the log
    put them at that offset. Needs a few such photos inside the log's span.
    """
    from .photometa import ESTIMATED_METHODS
    conn = db.connect()
    span = _span(conn)
    if not span:
        return {"offset_s": None, "matches": 0, "tested": 0}
    marks = ",".join("?" * len(ESTIMATED_METHODS))
    rows = conn.execute(
        "SELECT taken_ts, lat, lon FROM photos WHERE missing=0 AND lat IS NOT NULL"
        f" AND (gps_method IS NULL OR gps_method NOT IN ({marks}, 'TRACK', 'MANUAL'))"
        " AND taken_ts BETWEEN ? AND ? ORDER BY RANDOM() LIMIT 1500",
        [*ESTIMATED_METHODS, span[0] - 15 * 3600, span[1] + 15 * 3600],
    ).fetchall()
    if not rows:
        return {"offset_s": None, "matches": 0, "tested": 0}
    log = Log(span[0] - 15 * 3600, span[1] + 15 * 3600)
    # Most photos within a kilometre wins; between offsets that match as many,
    # the one that puts them nearest. On a slow walk several quarter hours all
    # land within the kilometre, and only the distance tells them apart.
    best, best_n, best_err = None, 0, float("inf")
    for quarter in range(-56, 57):
        off = quarter * 900
        n, err = 0, 0.0
        for r in rows:
            at = log.at(r["taken_ts"] - off, gap)
            if at:
                d = places.km(at[0], at[1], r["lat"], r["lon"])
                if d <= 1.0:
                    n += 1
                    err += d
        mean = err / n if n else float("inf")
        if n > best_n or (n == best_n and n and mean < best_err):
            best, best_n, best_err = off, n, mean
    if best_n < 3:
        return {"offset_s": None, "matches": best_n, "tested": len(rows)}
    return {"offset_s": best, "matches": best_n, "tested": len(rows)}


def geotag(offset_s: int | None, gap: int = DEFAULT_GAP, include_approx: bool = False,
           ids: list[int] | None = None, dry_run: bool = True) -> dict:
    """Place photos without a position (and optionally tower guesses) from the log.

    offset_s None means "this computer's time zone on the photo's date".
    """
    from .photometa import APPROX_METHODS
    conn = db.connect()
    span = _span(conn)
    if not span:
        return {"placed": 0, "candidates": 0, "samples": []}
    cond = "p.lat IS NULL"
    args: list = []
    if include_approx:
        marks = ",".join("?" * len(APPROX_METHODS))
        cond = f"(p.lat IS NULL OR p.gps_method IN ({marks}))"
        args = list(APPROX_METHODS)
    sql = (f"SELECT p.id, p.path, p.taken_ts FROM photos p WHERE p.missing=0 AND {cond}"
           " AND p.taken_ts BETWEEN ? AND ?")
    args += [span[0] - 15 * 3600, span[1] + 15 * 3600]
    if ids:
        sql += f" AND p.id IN ({','.join('?' * len(ids))})"
        args += ids
    rows = conn.execute(sql + " ORDER BY p.taken_ts", args).fetchall()
    log = Log(span[0] - 15 * 3600, span[1] + 15 * 3600)
    hits = []
    for r in rows:
        off = local_offset(r["taken_ts"]) if offset_s is None else offset_s
        at = log.at(r["taken_ts"] - off, gap)
        if at:
            hits.append((r, at))
    if not dry_run and hits:
        with db.write_lock:
            for r, (lat, lon) in hits:
                conn.execute(
                    "INSERT INTO location_fixes(path, lat, lon, method) VALUES (?,?,?,?)"
                    " ON CONFLICT(path) DO UPDATE SET lat=excluded.lat, lon=excluded.lon,"
                    " method=excluded.method",
                    (r["path"], lat, lon, METHOD),
                )
                conn.execute("UPDATE photos SET lat=?, lon=?, gps_method=? WHERE id=?",
                             (lat, lon, METHOD, r["id"]))
            conn.commit()
    return {
        "placed": len(hits),
        "candidates": len(rows),
        "samples": [{"id": r["id"], "lat": round(a[0], 6), "lon": round(a[1], 6)} for r, a in hits[:200]],
        "applied": not dry_run,
    }


# -------------------------------------------------------------------- export

def gpx(track_id: int | None = None) -> str:
    conn = db.connect()
    tracks = [get(track_id)] if track_id else list_all()
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<gpx version="1.1" creator="Photo Map" xmlns="http://www.topografix.com/GPX/1/1">']
    for t in tracks:
        if not t:
            continue
        out.append(f"<trk><name>{escape(t['name'])}</name><trkseg>")
        for r in conn.execute("SELECT ts, lat, lon FROM track_points WHERE track_id=? ORDER BY ts", (t["id"],)):
            when = datetime.datetime.fromtimestamp(r["ts"], datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            out.append(f'<trkpt lat="{r["lat"]:.7f}" lon="{r["lon"]:.7f}"><time>{when}</time></trkpt>')
        out.append("</trkseg></trk>")
    out.append("</gpx>")
    return "\n".join(out)
