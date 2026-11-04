"""Workouts from fitness apps and watches, and daily step and walking totals.

Workouts: GPX (with Garmin's TrackPointExtension for heart rate and cadence),
TCX, FIT, any of those gzipped (.gpx.gz, .fit.gz - how Strava's bulk export
ships them), and a .zip of them, such as the whole Strava export, whose
activities.csv supplies each file's name and type.

Watches: Apple Health's export.zip (Apple Watch and iPhone) gives workouts with
their routes, and steps and walking distance per day. Daily summaries from
other exports - Google Fit's "Daily activity metrics.csv", Garmin's UDS files -
are read by their column names. A watch records a route only during a workout;
the all-day position log is the phone's (Google Timeline, see tracks.py).

Each activity is also stored as a track, so it draws on the map and places
photos from a camera without GPS like any other log. Stats a file states
(Garmin's session totals, TCX laps) are used as given; the rest are worked out
from the points.
"""
import csv
import datetime
import gzip
import io
import json
import struct
import time
import xml.etree.ElementTree as ET
import zipfile

from . import db, places, tracks

SCHEMA = """
CREATE TABLE IF NOT EXISTS activities (
    id          INTEGER PRIMARY KEY,
    track_id    INTEGER,
    name        TEXT NOT NULL,
    sport       TEXT NOT NULL,
    source      TEXT NOT NULL,
    start_ts    INTEGER NOT NULL,
    local_ts    INTEGER NOT NULL,
    elapsed_s   REAL,
    moving_s    REAL,
    distance_m  REAL,
    ascent_m    REAL,
    descent_m   REAL,
    avg_speed   REAL,
    max_speed   REAL,
    avg_hr      REAL,
    max_hr      REAL,
    avg_cadence REAL,
    avg_power   REAL,
    calories    REAL,
    imported_ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_activities_local ON activities(local_ts);
-- Steps and walking distance per local calendar day, per export they came from.
-- Two sources for one day (a phone and a watch) are not added up: the larger wins.
CREATE TABLE IF NOT EXISTS daily_stats (
    day        TEXT NOT NULL,
    source     TEXT NOT NULL,
    steps      INTEGER,
    distance_m REAL,
    PRIMARY KEY (day, source)
);
"""

STAT_FIELDS = ("elapsed_s", "moving_s", "distance_m", "ascent_m", "descent_m", "avg_speed", "max_speed",
               "avg_hr", "max_hr", "avg_cadence", "avg_power", "calories")

# What each app calls a sport, folded into a short list.
SPORTS = {
    "cycling": "cycling", "biking": "cycling", "ride": "cycling", "bike": "cycling", "road_biking": "cycling",
    "mountain_biking": "cycling", "gravel_cycling": "cycling", "ebikeride": "cycling", "e-bike ride": "cycling",
    "virtualride": "cycling", "virtual ride": "cycling", "gravel ride": "cycling", "mountain bike ride": "cycling",
    "running": "running", "run": "running", "trail run": "running", "trail_running": "running",
    "walking": "walking", "walk": "walking",
    "hiking": "hiking", "hike": "hiking",
    "swimming": "swimming", "swim": "swimming",
    "alpine_skiing": "skiing", "cross_country_skiing": "skiing", "alpine ski": "skiing", "nordic ski": "skiing",
    "rowing": "rowing", "kayaking": "rowing", "canoeing": "rowing", "paddlesports": "rowing",
    "downhillskiing": "skiing", "crosscountryskiing": "skiing", "snowboarding": "skiing",
}
# The FIT profile's sport enum, for the values that matter here.
FIT_SPORTS = {1: "running", 2: "cycling", 5: "swimming", 11: "walking", 12: "skiing", 13: "skiing",
              15: "rowing", 17: "hiking", 21: "cycling"}

# A sample counts towards moving time when it is slower to cover than this...
MOVING_MPS = 0.5
# ...and not after a pause in recording longer than this.
MAX_SAMPLE_GAP = 30
# Elevation changes smaller than this are GPS noise, not a climb.
CLIMB_NOISE_M = 3.0


def init_schema() -> None:
    conn = db.connect()
    conn.executescript(SCHEMA)
    conn.commit()


def sport_of(value) -> str:
    key = str(value or "").strip().lower()
    return SPORTS.get(key) or SPORTS.get(key.replace(" ", "_")) or ("other" if key else "other")


# ------------------------------------------------------------------ parsing
#
# Every parser returns {"name", "sport", "points": [(ts, lat, lon, ele, hr, cad, power)],
# "stats": {...}} with whatever the file stated outright in stats.

def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _num(text):
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def parse_gpx(data: bytes) -> dict:
    root = ET.fromstring(data.lstrip())
    name, sport, pts = "", "", []
    for node in root.iter():
        tag = _local(node.tag)
        if tag == "trk":
            for child in node:
                if _local(child.tag) == "name" and child.text and not name:
                    name = child.text.strip()
                if _local(child.tag) == "type" and child.text and not sport:
                    sport = child.text.strip()
        if tag != "trkpt":
            continue
        lat, lon = _num(node.get("lat")), _num(node.get("lon"))
        when = ele = hr = cad = power = None
        for child in node.iter():
            t = _local(child.tag)
            if t == "time":
                when = tracks._utc(child.text)
            elif t == "ele":
                ele = _num(child.text)
            elif t in ("hr", "heartrate"):
                hr = _num(child.text)
            elif t in ("cad", "cadence"):
                cad = _num(child.text)
            elif t in ("power", "watts"):
                power = _num(child.text)
        if when is not None and lat is not None and lon is not None and tracks._ok(lat, lon):
            pts.append((when, lat, lon, ele, hr, cad, power))
    return {"name": name, "sport": sport, "points": pts, "stats": {}}


def parse_tcx(data: bytes) -> dict:
    root = ET.fromstring(data.lstrip())
    activity = next((n for n in root.iter() if _local(n.tag) == "Activity"), None)
    if activity is None:
        raise ValueError("no Activity in this TCX file")
    sport = activity.get("Sport") or ""
    stats = {"elapsed_s": 0.0, "distance_m": 0.0, "calories": 0.0}
    hr_max = None
    pts = []
    for lap in (n for n in activity.iter() if _local(n.tag) == "Lap"):
        for child in lap:
            t = _local(child.tag)
            if t == "TotalTimeSeconds":
                stats["elapsed_s"] += _num(child.text) or 0
            elif t == "DistanceMeters":
                stats["distance_m"] += _num(child.text) or 0
            elif t == "Calories":
                stats["calories"] += _num(child.text) or 0
            elif t == "MaximumHeartRateBpm":
                v = _num(next((c.text for c in child.iter() if _local(c.tag) == "Value"), None))
                if v is not None:
                    hr_max = max(hr_max or 0, v)
        for tp in (n for n in lap.iter() if _local(n.tag) == "Trackpoint"):
            when = lat = lon = ele = hr = cad = power = None
            for c in tp.iter():
                t = _local(c.tag)
                if t == "Time":
                    when = tracks._utc(c.text)
                elif t == "LatitudeDegrees":
                    lat = _num(c.text)
                elif t == "LongitudeDegrees":
                    lon = _num(c.text)
                elif t == "AltitudeMeters":
                    ele = _num(c.text)
                elif t == "HeartRateBpm":
                    hr = _num(next((x.text for x in c.iter() if _local(x.tag) == "Value"), None))
                elif t in ("Cadence", "RunCadence"):
                    cad = _num(c.text)
                elif t == "Watts":
                    power = _num(c.text)
            if when is not None and lat is not None and lon is not None and tracks._ok(lat, lon):
                pts.append((when, lat, lon, ele, hr, cad, power))
    stats = {k: v for k, v in stats.items() if v}
    if hr_max:
        stats["max_hr"] = hr_max
    return {"name": "", "sport": sport, "points": pts, "stats": stats}


FIT_EPOCH = 631065600  # 1989-12-31T00:00:00Z
SEMICIRCLE = 180 / 2 ** 31
# base type number -> (struct code, size, invalid value)
FIT_TYPES = {
    0: ("B", 1, 0xFF), 1: ("b", 1, 0x7F), 2: ("B", 1, 0xFF), 3: ("h", 2, 0x7FFF), 4: ("H", 2, 0xFFFF),
    5: ("i", 4, 0x7FFFFFFF), 6: ("I", 4, 0xFFFFFFFF), 8: ("f", 4, None), 9: ("d", 8, None),
    10: ("B", 1, 0), 11: ("H", 2, 0), 12: ("I", 4, 0), 14: ("q", 8, 0x7FFFFFFFFFFFFFFF),
    15: ("Q", 8, 0xFFFFFFFFFFFFFFFF), 16: ("Q", 8, 0),
}


def parse_fit(data: bytes) -> dict:
    """The record and session messages of a FIT file. Only single numbers are
    decoded; arrays, strings and developer fields are skipped by their size."""
    if len(data) < 12 or data[8:12] != b".FIT":
        raise ValueError("not a FIT file")
    header = data[0]
    end = min(len(data), header + struct.unpack_from("<I", data, 4)[0])
    pos = header
    defs: dict[int, tuple] = {}
    last_ts = None
    records, sessions = [], []

    while pos < end:
        rh = data[pos]
        pos += 1
        compressed = rh & 0x80
        if not compressed and rh & 0x40:  # definition message
            dev = rh & 0x20
            local = rh & 0x0F
            big = data[pos + 1] == 1
            gnum = struct.unpack_from(">H" if big else "<H", data, pos + 2)[0]
            nfields = data[pos + 4]
            pos += 5
            fields = []
            for _ in range(nfields):
                fields.append((data[pos], data[pos + 1], data[pos + 2] & 0x1F))
                pos += 3
            dev_size = 0
            if dev:
                ndev = data[pos]
                pos += 1
                for _ in range(ndev):
                    dev_size += data[pos + 1]
                    pos += 3
            defs[local] = (gnum, big, fields, dev_size)
            continue
        local = (rh >> 5) & 0x03 if compressed else rh & 0x0F
        if local not in defs:
            raise ValueError("FIT data before its definition")
        gnum, big, fields, dev_size = defs[local]
        values = {}
        for num, size, base in fields:
            spec = FIT_TYPES.get(base)
            if spec and spec[1] == size:
                v = struct.unpack_from((">" if big else "<") + spec[0], data, pos)[0]
                if spec[2] is None or v != spec[2]:
                    values[num] = v
            pos += size
        pos += dev_size
        if compressed:
            offset = rh & 0x1F
            if last_ts is not None:
                values[253] = last_ts + ((offset - (last_ts & 0x1F)) & 0x1F)
        if 253 in values:
            last_ts = values[253]
        if gnum == 20:
            records.append(values)
        elif gnum == 18:
            sessions.append(values)

    pts = []
    for r in records:
        if 0 not in r or 1 not in r or 253 not in r:
            continue
        lat, lon = r[0] * SEMICIRCLE, r[1] * SEMICIRCLE
        if not tracks._ok(lat, lon):
            continue
        alt = r.get(78, r.get(2))
        ele = alt / 5 - 500 if alt is not None else None
        pts.append((r[253] + FIT_EPOCH, lat, lon, ele, r.get(3), r.get(4), r.get(7)))

    stats: dict = {}
    sport = ""
    if sessions:
        s = sessions[0]
        sport = FIT_SPORTS.get(s.get(5), "other")
        total = lambda k, scale=1: sum(x[k] / scale for x in sessions if k in x) or None  # noqa: E731
        stats = {
            "elapsed_s": total(7, 1000), "moving_s": total(8, 1000), "distance_m": total(9, 100),
            "calories": total(11), "ascent_m": total(22), "descent_m": total(23),
            "avg_hr": s.get(16), "max_hr": s.get(17), "avg_cadence": s.get(18), "avg_power": s.get(20),
        }
        speed = s.get(124, s.get(14))
        top = s.get(125, s.get(15))
        stats["avg_speed"] = speed / 1000 if speed is not None else None
        stats["max_speed"] = top / 1000 if top is not None else None
        stats = {k: v for k, v in stats.items() if v is not None}
    return {"name": "", "sport": sport, "points": pts, "stats": stats}


def _one(name: str, data: bytes) -> dict | None:
    lower = name.lower()
    if lower.endswith(".gz") or data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
        lower = lower.removesuffix(".gz")
    if lower.endswith(".fit") or data[8:12] == b".FIT":
        found = parse_fit(data)
    elif lower.endswith(".tcx") or b"TrainingCenterDatabase" in data[:2000]:
        found = parse_tcx(data)
    elif lower.endswith(".gpx") or data.lstrip()[:1] == b"<":
        found = parse_gpx(data)
    else:
        return None
    found["file"] = name
    return found


# ------------------------------------------------------------- watches

DIST_UNITS = {"m": 1.0, "km": 1000.0, "mi": 1609.344, "ft": 0.3048, "yd": 0.9144}
APPLE_STEPS = "HKQuantityTypeIdentifierStepCount"
APPLE_WALK = "HKQuantityTypeIdentifierDistanceWalkingRunning"


def _apple_time(text: str) -> tuple[int, int]:
    """'2023-09-17 10:00:00 +0200' into (UTC, wall clock on the photos' scale)."""
    when = datetime.datetime.strptime(text, "%Y-%m-%d %H:%M:%S %z")
    utc = int(when.timestamp())
    return utc, utc + int(when.utcoffset().total_seconds())


def _meters(value, unit) -> float | None:
    try:
        return float(value) * DIST_UNITS[(unit or "km").strip()]
    except (TypeError, ValueError, KeyError):
        return None


def parse_apple(archive: zipfile.ZipFile, xml_name: str) -> tuple[list[dict], dict]:
    """Workouts (with their routes) and daily totals from Apple Health's export.
    The XML runs to gigabytes for a few years of a watch, so it is streamed and
    each element dropped as soon as it has been read."""
    routes = {n.rsplit("/", 1)[-1]: n for n in archive.namelist() if n.lower().endswith(".gpx")}
    per_source: dict[tuple[str, str], list] = {}
    workouts = []
    root = None
    with archive.open(xml_name) as f:
        for event, node in ET.iterparse(f, events=("start", "end")):
            if root is None:
                root = node
            if event != "end":
                continue
            if node.tag == "Record":
                kind = node.get("type")
                if kind in (APPLE_STEPS, APPLE_WALK) and node.get("startDate"):
                    day = node.get("startDate")[:10]
                    cell = per_source.setdefault((day, node.get("sourceName") or ""), [0, 0.0])
                    if kind == APPLE_STEPS:
                        cell[0] += int(float(node.get("value") or 0))
                    else:
                        cell[1] += _meters(node.get("value"), node.get("unit")) or 0
                root.clear()
            elif node.tag == "Workout":
                workouts.append(_apple_workout(node, archive, routes))
                root.clear()
    daily: dict[str, dict] = {}
    for (day, _), (steps, dist) in per_source.items():
        cur = daily.setdefault(day, {"steps": 0, "distance_m": 0.0})
        cur["steps"] = max(cur["steps"], steps)
        cur["distance_m"] = max(cur["distance_m"], dist)
    return [w for w in workouts if w], daily


def _apple_workout(node, archive, routes) -> dict | None:
    if not node.get("startDate") or not node.get("endDate"):
        return None
    kind = (node.get("workoutActivityType") or "").removeprefix("HKWorkoutActivityType")
    start_utc, start_wall = _apple_time(node.get("startDate"))
    end_utc, _ = _apple_time(node.get("endDate"))
    stats: dict = {"elapsed_s": float(end_utc - start_utc)}
    try:
        duration = float(node.get("duration") or 0)
        stats["moving_s"] = duration * {"min": 60, "s": 1, "hr": 3600}.get(node.get("durationUnit") or "min", 60)
    except ValueError:
        pass
    dist = _meters(node.get("totalDistance"), node.get("totalDistanceUnit"))
    if dist:
        stats["distance_m"] = dist
    try:
        if node.get("totalEnergyBurned"):
            stats["calories"] = float(node.get("totalEnergyBurned"))
    except ValueError:
        pass
    pts = []
    for child in node:
        if child.tag == "WorkoutStatistics":
            t = child.get("type") or ""
            if "Distance" in t and child.get("sum") and "distance_m" not in stats:
                stats["distance_m"] = _meters(child.get("sum"), child.get("unit"))
            elif t.endswith("ActiveEnergyBurned") and child.get("sum") and "calories" not in stats:
                stats["calories"] = float(child.get("sum"))
            elif t.endswith("HeartRate"):
                if child.get("average"):
                    stats["avg_hr"] = float(child.get("average"))
                if child.get("maximum"):
                    stats["max_hr"] = float(child.get("maximum"))
        elif child.tag == "WorkoutRoute":
            for ref in child:
                path = (ref.get("path") or "").rsplit("/", 1)[-1]
                if ref.tag == "FileReference" and path in routes:
                    pts = parse_gpx(archive.read(routes[path]))["points"]
    stats = {k: v for k, v in stats.items() if v is not None}
    stamp = datetime.datetime.fromtimestamp(start_wall, datetime.UTC).strftime("%Y-%m-%d")
    return {"name": f"{kind or 'Workout'} {stamp}", "sport": kind, "points": pts, "stats": stats,
            "start_utc": start_utc, "local_ts": start_wall, "file": "export.xml"}


DATE_KEYS = ("date", "calendardate", "summarydate")
STEP_KEYS = ("step count", "steps", "totalsteps", "total steps", "step_count")
METER_KEYS = ("distance (m)", "totaldistancemeters", "distance_m", "distancemeters", "distance (meters)")
KM_KEYS = ("distance (km)", "distance_km", "totaldistancekm")


def _number(value) -> float | None:
    try:
        return float(str(value).replace(",", "")) if value not in (None, "") else None
    except ValueError:
        return None


def parse_daily(name: str, data: bytes) -> dict:
    """{day: {"steps", "distance_m"}} from a CSV or JSON of daily summaries,
    found by column name. A file with no such columns gives nothing."""
    text = data.decode("utf-8-sig", errors="replace")
    if name.lower().endswith(".csv"):
        records = list(csv.DictReader(io.StringIO(text)))
    else:
        try:
            doc = json.loads(text)
        except ValueError:
            return {}
        if isinstance(doc, dict):
            doc = next((v for v in doc.values() if isinstance(v, list)), [doc])
        records = [r for r in doc if isinstance(r, dict)] if isinstance(doc, list) else []
    out: dict[str, dict] = {}
    for rec in records:
        low = {str(k).strip().lower(): v for k, v in rec.items()}
        date = next((low[k] for k in DATE_KEYS if k in low), None)
        if isinstance(date, dict):
            date = date.get("date")
        day = str(date or "")[:10]
        try:
            datetime.date.fromisoformat(day)
        except ValueError:
            continue
        steps = next((_number(low[k]) for k in STEP_KEYS if k in low), None)
        dist = next((_number(low[k]) for k in METER_KEYS if k in low), None)
        if dist is None:
            km = next((_number(low[k]) for k in KM_KEYS if k in low), None)
            dist = km * 1000 if km is not None else None
        if steps or dist:
            cur = out.setdefault(day, {"steps": 0, "distance_m": 0.0})
            cur["steps"] = max(cur["steps"], int(steps or 0))
            cur["distance_m"] = max(cur["distance_m"], dist or 0.0)
    return out


def parse(name: str, data: bytes) -> tuple[list[dict], list[tuple[str, dict]]]:
    """(workouts, [(source, daily totals)]) from one uploaded file."""
    lower = name.lower()
    if not (lower.endswith(".zip") or data[:4] == b"PK\x03\x04"):
        if lower.endswith((".csv", ".json")):
            daily = parse_daily(name, data)
            if not daily:
                raise ValueError(f"{name}: no daily steps or distance in it")
            return [], [(name.rsplit("/", 1)[-1], daily)]
        found = _one(name, data)
        if found is None:
            raise ValueError(f"{name}: not a GPX, TCX, FIT, CSV or JSON file")
        return [found], []
    out, days = [], []
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        apple = next((n for n in archive.namelist() if n.lower().endswith("export.xml")
                      and "cda" not in n.lower()), None)
        if apple:
            workouts, daily = parse_apple(archive, apple)
            return workouts, ([("apple-health", daily)] if daily else [])
        # Strava's export: activities.csv names every file and says what it was.
        meta = {}
        listing = next((n for n in archive.namelist() if n.lower().endswith("activities.csv")), None)
        if listing:
            text = archive.read(listing).decode("utf-8-sig", errors="replace")
            for row in csv.DictReader(io.StringIO(text)):
                if row.get("Filename"):
                    meta[row["Filename"].strip()] = (row.get("Activity Name") or "", row.get("Activity Type") or "")
        for info in archive.infolist():
            inner = info.filename.lower()
            if info.is_dir():
                continue
            if inner.endswith((".csv", ".json")) and not inner.endswith("activities.csv"):
                daily = parse_daily(info.filename, archive.read(info))
                if daily:
                    days.append((info.filename.rsplit("/", 1)[-1], daily))
                continue
            if not inner.endswith((".gpx", ".tcx", ".fit", ".gpx.gz", ".tcx.gz", ".fit.gz")):
                continue
            try:
                found = _one(info.filename, archive.read(info))
            except Exception:  # one broken file must not lose the rest of an export
                continue
            if not found:
                continue
            label, kind = meta.get(info.filename, ("", ""))
            found["name"] = label or found["name"]
            found["sport"] = kind or found["sport"]
            out.append(found)
    return out, days


# -------------------------------------------------------------------- stats

def derive(points: list, stated: dict) -> dict:
    """Fill in what the file did not state, from the points."""
    stats = dict(stated)
    if len(points) < 2:
        return stats
    dist = moving = 0.0
    top = 0.0
    for a, b in zip(points, points[1:]):
        dt = b[0] - a[0]
        d = places.km(a[1], a[2], b[1], b[2]) * 1000
        dist += d
        if 0 < dt <= MAX_SAMPLE_GAP and d / dt >= MOVING_MPS:
            moving += dt
            if dt >= 3:
                top = max(top, d / dt)
    stats.setdefault("elapsed_s", float(points[-1][0] - points[0][0]))
    stats.setdefault("distance_m", dist)
    stats.setdefault("moving_s", moving or stats["elapsed_s"])
    if stats["moving_s"]:
        stats.setdefault("avg_speed", stats["distance_m"] / stats["moving_s"])
    if top:
        stats.setdefault("max_speed", top)

    eles = [p[3] for p in points if p[3] is not None]
    if eles and "ascent_m" not in stats:
        up = down = 0.0
        ref = eles[0]
        for e in eles[1:]:
            if e - ref >= CLIMB_NOISE_M:
                up += e - ref
                ref = e
            elif ref - e >= CLIMB_NOISE_M:
                down += ref - e
                ref = e
        stats["ascent_m"] = up
        stats.setdefault("descent_m", down)

    for col, idx in (("avg_hr", 4), ("avg_cadence", 5), ("avg_power", 6)):
        vals = [p[idx] for p in points if p[idx]]
        if vals and col not in stats:
            stats[col] = sum(vals) / len(vals)
    hrs = [p[4] for p in points if p[4]]
    if hrs:
        stats.setdefault("max_hr", max(hrs))
    return stats


def _local_ts(utc: int, lon: float) -> int:
    """The start on the wall-clock scale photos use. A file keeps UTC and rarely
    says where it was; the longitude's own time zone is close enough to put an
    activity on the right day, which is all this is used for."""
    return utc + round(lon / 15) * 3600


# ------------------------------------------------------------------ storage

def store(found: dict, source: str) -> dict | None:
    pts = sorted(found["points"])
    if not pts and found.get("start_utc") is None:
        return None
    start = found.get("start_utc") or pts[0][0]
    conn = db.connect()
    # The same workout imported twice - two exports overlapping - is kept once.
    if conn.execute("SELECT 1 FROM activities WHERE ABS(start_ts - ?) < 60", (start,)).fetchone():
        return None
    stats = derive(pts, found["stats"])
    sport = sport_of(found["sport"])
    stamp = datetime.datetime.fromtimestamp(start, datetime.UTC).strftime("%Y-%m-%d")
    name = (found["name"] or f"{sport.capitalize()} {stamp}")[:200]
    track = tracks.store(name, "fitness", [(p[0], p[1], p[2]) for p in pts]) if pts else None
    local = found.get("local_ts") or _local_ts(start, pts[0][2])
    cols = ("track_id", "name", "sport", "source", "start_ts", "local_ts", *STAT_FIELDS, "imported_ts")
    vals = (track["id"] if track else None, name, sport, source, start, local,
            *(stats.get(k) for k in STAT_FIELDS), int(time.time()))
    with db.write_lock:
        cur = conn.execute(f"INSERT INTO activities({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", vals)
        conn.commit()
    return get(cur.lastrowid)


def store_daily(source: str, daily: dict) -> int:
    conn = db.connect()
    with db.write_lock:
        conn.executemany(
            "INSERT INTO daily_stats(day, source, steps, distance_m) VALUES (?,?,?,?)"
            " ON CONFLICT(day, source) DO UPDATE SET steps=excluded.steps, distance_m=excluded.distance_m",
            [(day, source[:120], v["steps"] or None, v["distance_m"] or None) for day, v in daily.items()],
        )
        conn.commit()
    return len(daily)


def daily_between(first: str, last: str) -> dict:
    """{day: {"steps", "distance_m"}}, the larger of any two sources for a day."""
    rows = db.connect().execute(
        "SELECT day, MAX(steps) steps, MAX(distance_m) distance_m FROM daily_stats"
        " WHERE day BETWEEN ? AND ? GROUP BY day", (first, last)).fetchall()
    return {r["day"]: {"steps": r["steps"] or 0, "distance_m": r["distance_m"] or 0.0} for r in rows}


def daily_status() -> dict:
    row = db.connect().execute("SELECT COUNT(DISTINCT day) n, MIN(day) a, MAX(day) b FROM daily_stats").fetchone()
    return {"days": row["n"], "first": row["a"], "last": row["b"]}


def clear_daily() -> None:
    conn = db.connect()
    with db.write_lock:
        conn.execute("DELETE FROM daily_stats")
        conn.commit()


def import_file(name: str, data: bytes) -> dict:
    found, daily = parse(name, data)
    saved, duplicates = [], 0
    for item in found:
        source = item["file"].lower().removesuffix(".gz").rsplit(".", 1)[-1]
        act = store(item, source)
        if act:
            saved.append(act)
        elif item["points"] or item.get("start_utc"):
            duplicates += 1
    days = sum(store_daily(source, d) for source, d in daily)
    return {"items": saved, "duplicates": duplicates, "files": len(found), "days": days}


def get(activity_id: int) -> dict | None:
    row = db.connect().execute("SELECT * FROM activities WHERE id=?", (activity_id,)).fetchone()
    return dict(row) if row else None


def list_all() -> list[dict]:
    return [dict(r) for r in db.connect().execute("SELECT * FROM activities ORDER BY start_ts DESC")]


def between(local_from: int, local_to: int) -> list[dict]:
    rows = db.connect().execute(
        "SELECT * FROM activities WHERE local_ts BETWEEN ? AND ? ORDER BY local_ts", (local_from, local_to)
    ).fetchall()
    return [dict(r) for r in rows]


def delete(activity_id: int) -> bool:
    act = get(activity_id)
    if not act:
        return False
    if act["track_id"]:
        tracks.delete(act["track_id"])
    conn = db.connect()
    with db.write_lock:
        conn.execute("DELETE FROM activities WHERE id=?", (activity_id,))
        conn.commit()
    return True


def route(activity: dict, limit: int = 600) -> list[list[float]]:
    """The activity's own line, thinned evenly, for drawing."""
    if not activity.get("track_id"):
        return []
    rows = db.connect().execute(
        "SELECT lat, lon FROM track_points WHERE track_id=? ORDER BY ts", (activity["track_id"],)
    ).fetchall()
    step = max(1, -(-len(rows) // limit))
    return [[round(r["lat"], 5), round(r["lon"], 5)] for r in rows[::step]]
