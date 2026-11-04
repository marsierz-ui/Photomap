"""The weather at the time and place a photo was taken, from Open-Meteo.

Open-Meteo's historical archive (ERA5 reanalysis and the models since) covers
every hour from 1940 to a few days ago, on a grid of roughly 10-25 km, and its
forecast API covers the last three months including today. Neither needs a key
for personal use. A commercial deployment needs an Open-Meteo API subscription:
put its key in the `open_meteo_key` setting and requests go to the customer
hosts instead.

Off by default: asking for the weather sends a position and a date to a third
party, which is exactly what the rest of the app avoids.

Requests are cached by grid cell and day, not by photo, so one request for a
city covers every photo taken there that day - and a stretch of days is one
request. Each photo records the coordinates and time it was looked up for in
`weather_at`, as place names do in `place_at`, so a fix to either is looked up
again without any write site having to remember.
"""
import datetime
import json
import threading
import time
import urllib.parse
import urllib.request

from . import db

# ERA5's own resolution is 0.25 degrees; a finer cell only buys more requests
# for the same numbers.
CELL = 0.25
HOURLY = ("temperature_2m", "weather_code", "precipitation", "rain", "snowfall",
          "cloud_cover", "wind_speed_10m", "relative_humidity_2m", "is_day")
DAILY = ("sunrise", "sunset")
# The archive lags by about five days; the forecast API reaches back 92.
RECENT_DAYS = 80
# Longest stretch fetched in one request. A year of hourly values is under a
# megabyte, and Open-Meteo weighs a request by its length.
MAX_SPAN = 366
# Gaps up to this many days are fetched through rather than split, since a
# request costs more than the days in between.
MERGE_GAP = 10

STALE = (
    "p.lat IS NOT NULL AND p.taken_ts IS NOT NULL AND (p.weather_at IS NULL"
    " OR p.weather_at != printf('%.4f,%.4f,%d', p.lat, p.lon, p.taken_ts))"
)

# WMO weather interpretation codes, as Open-Meteo reports them, and the kind of
# sky each one is: what the 3D map draws.
CODES = {
    0: ("Clear sky", "clear"), 1: ("Mainly clear", "clear"), 2: ("Partly cloudy", "cloudy"),
    3: ("Overcast", "overcast"), 45: ("Fog", "fog"), 48: ("Freezing fog", "fog"),
    51: ("Light drizzle", "rain"), 53: ("Drizzle", "rain"), 55: ("Heavy drizzle", "rain"),
    56: ("Freezing drizzle", "rain"), 57: ("Heavy freezing drizzle", "rain"),
    61: ("Light rain", "rain"), 63: ("Rain", "rain"), 65: ("Heavy rain", "rain"),
    66: ("Freezing rain", "rain"), 67: ("Heavy freezing rain", "rain"),
    71: ("Light snow", "snow"), 73: ("Snow", "snow"), 75: ("Heavy snow", "snow"), 77: ("Snow grains", "snow"),
    80: ("Light showers", "rain"), 81: ("Showers", "rain"), 82: ("Violent showers", "rain"),
    85: ("Snow showers", "snow"), 86: ("Heavy snow showers", "snow"),
    95: ("Thunderstorm", "storm"), 96: ("Thunderstorm with hail", "storm"), 99: ("Thunderstorm with heavy hail", "storm"),
}

_fill_lock = threading.Lock()
_fetch_lock = threading.Lock()
_state = {"error": None, "last_request": 0.0}


def enabled() -> bool:
    return db.get_setting("weather_enabled", "0") == "1"


def init_schema() -> None:
    conn = db.connect()
    with db.write_lock:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS weather_days ("
            " cell TEXT NOT NULL, day TEXT NOT NULL, data TEXT NOT NULL, fetched_ts INTEGER,"
            " PRIMARY KEY (cell, day))"
        )
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(photos)")}
        if "weather" not in cols:
            conn.execute("ALTER TABLE photos ADD COLUMN weather TEXT")
        if "weather_at" not in cols:
            conn.execute("ALTER TABLE photos ADD COLUMN weather_at TEXT")
        conn.commit()


def status() -> dict:
    conn = db.connect()
    pending = conn.execute(f"SELECT COUNT(*) c FROM photos p WHERE p.missing=0 AND {STALE}").fetchone()["c"]
    done = conn.execute("SELECT COUNT(*) c FROM photos WHERE weather IS NOT NULL AND weather != ''").fetchone()["c"]
    return {"enabled": enabled(), "pending": pending, "done": done,
            "filling": _fill_lock.locked(), "error": _state["error"],
            "commercial": bool(db.get_setting("open_meteo_key", ""))}


# ------------------------------------------------------------------- helpers

def cell_of(lat: float, lon: float) -> tuple[float, float]:
    return (round(round(lat / CELL) * CELL, 2), round(round(lon / CELL) * CELL, 2))


def cell_key(cell: tuple[float, float]) -> str:
    return f"{cell[0]:.2f},{cell[1]:.2f}"


def day_of(ts: int) -> str:
    # Capture times are the camera's wall clock stored as if UTC (see
    # photometa.wall_ts), and Open-Meteo is asked for local time, so the two
    # line up without knowing the time zone.
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%d")


def _url(start: str, end: str) -> str:
    key = db.get_setting("open_meteo_key", "")
    recent = (datetime.date.today() - datetime.date.fromisoformat(start)).days <= RECENT_DAYS
    host = "api.open-meteo.com/v1/forecast" if recent else "archive-api.open-meteo.com/v1/archive"
    if key:
        host = "customer-" + host
    return "https://" + host, key


def _fetch(cell: tuple[float, float], start: str, end: str) -> dict[str, dict]:
    """One request: every day from start to end, inclusive, for a cell.
    Returns {day: {"hours": {...}, "sunrise": ..., "sunset": ..., "utc_offset": s}}."""
    base, key = _url(start, end)
    params = {
        "latitude": cell[0], "longitude": cell[1], "start_date": start, "end_date": end,
        "hourly": ",".join(HOURLY), "daily": ",".join(DAILY), "timezone": "auto",
    }
    if key:
        params["apikey"] = key
    url = base + "?" + urllib.parse.urlencode(params)
    # Open-Meteo's free tier allows 600 requests a minute; a fill should leave
    # plenty of that for the person browsing.
    with _fetch_lock:
        wait = 0.25 - (time.time() - _state["last_request"])
        if wait > 0:
            time.sleep(wait)
        _state["last_request"] = time.time()
        req = urllib.request.Request(url, headers={"User-Agent": "PhotoMap/1.0"})
        with urllib.request.urlopen(req, timeout=60) as r:
            payload = json.loads(r.read().decode("utf-8"))
    offset = payload.get("utc_offset_seconds", 0)
    hourly = payload.get("hourly", {})
    times = hourly.get("time", [])
    days: dict[str, dict] = {}
    for i, stamp in enumerate(times):
        day = stamp[:10]
        hours = days.setdefault(day, {"hours": {}, "utc_offset": offset})["hours"]
        hours[stamp[11:13]] = {k: (hourly.get(k) or [None] * len(times))[i] for k in HOURLY}
    daily = payload.get("daily", {})
    for i, day in enumerate(daily.get("time", [])):
        if day in days:
            days[day]["sunrise"] = (daily.get("sunrise") or [None])[i]
            days[day]["sunset"] = (daily.get("sunset") or [None])[i]
    return days


def _store(cell, days: dict[str, dict]) -> None:
    conn = db.connect()
    now = int(time.time())
    with db.write_lock:
        conn.executemany(
            "INSERT OR REPLACE INTO weather_days(cell, day, data, fetched_ts) VALUES (?,?,?,?)",
            [(cell_key(cell), day, json.dumps(data, separators=(",", ":")), now) for day, data in days.items()],
        )
        conn.commit()


def _cached(cell, day: str) -> dict | None:
    row = db.connect().execute(
        "SELECT data, fetched_ts FROM weather_days WHERE cell=? AND day=?", (cell_key(cell), day)
    ).fetchone()
    if not row:
        return None
    data = json.loads(row["data"])
    # Today's and yesterday's hours were partly forecast when fetched; worth
    # asking again once they are history.
    age_days = (datetime.date.today() - datetime.date.fromisoformat(day)).days
    if age_days < 2 and time.time() - (row["fetched_ts"] or 0) > 3 * 3600:
        return None
    return data


def summarise(day_data: dict, ts: int) -> dict | None:
    """The hour a photo was taken in, in words and numbers."""
    hour = datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%H")
    h = (day_data.get("hours") or {}).get(hour)
    if not h or h.get("weather_code") is None:
        return None
    code = int(h["weather_code"])
    label, sky = CODES.get(code, ("Unknown", "clear"))
    return {
        "code": code, "label": label, "sky": sky,
        "temp": h.get("temperature_2m"), "precip": h.get("precipitation"),
        "rain": h.get("rain"), "snow": h.get("snowfall"), "cloud": h.get("cloud_cover"),
        "wind": h.get("wind_speed_10m"), "humidity": h.get("relative_humidity_2m"),
        "is_day": h.get("is_day"),
        "sunrise": day_data.get("sunrise"), "sunset": day_data.get("sunset"),
        "utc_offset": day_data.get("utc_offset"),
    }


def _at(photo) -> str:
    return f"{photo['lat']:.4f},{photo['lon']:.4f},{int(photo['taken_ts'])}"


def _save_photo(photo_id: int, summary: dict | None, at: str) -> None:
    conn = db.connect()
    with db.write_lock:
        conn.execute("UPDATE photos SET weather=?, weather_at=? WHERE id=?",
                     (json.dumps(summary) if summary else "", at, photo_id))
        conn.commit()


# -------------------------------------------------------------------- public

def for_photo(photo_id: int) -> dict:
    """The weather for one photo, fetched now if it is not known yet."""
    row = db.connect().execute(
        "SELECT id, lat, lon, taken_ts, weather, weather_at FROM photos WHERE id=?", (photo_id,)
    ).fetchone()
    if not row:
        return {"weather": None, "reason": "not_found"}
    if row["lat"] is None or row["taken_ts"] is None:
        return {"weather": None, "reason": "no_position" if row["lat"] is None else "no_date"}
    at = _at(row)
    if row["weather_at"] == at:
        return {"weather": json.loads(row["weather"]) if row["weather"] else None}
    if not enabled():
        return {"weather": None, "reason": "disabled"}
    day = day_of(row["taken_ts"])
    if datetime.date.fromisoformat(day) > datetime.date.today() + datetime.timedelta(days=1):
        _save_photo(row["id"], None, at)
        return {"weather": None, "reason": "future"}
    cell = cell_of(row["lat"], row["lon"])
    data = _cached(cell, day)
    if data is None:
        try:
            fetched = _fetch(cell, day, day)
        except Exception as exc:  # offline, rate limited: not stored, asked again later
            _state["error"] = str(exc)
            return {"weather": None, "reason": "unavailable", "error": str(exc)}
        _state["error"] = None
        _store(cell, fetched)
        data = fetched.get(day)
    summary = summarise(data, row["taken_ts"]) if data else None
    _save_photo(row["id"], summary, at)
    return {"weather": summary}


def _runs(days: list[str]) -> list[tuple[str, str]]:
    """Sorted days into (start, end) stretches worth one request each."""
    out = []
    start = prev = None
    for d in sorted(set(days)):
        cur = datetime.date.fromisoformat(d)
        if start and (cur - prev).days <= MERGE_GAP and (cur - start).days < MAX_SPAN:
            prev = cur
            continue
        if start:
            out.append((start.isoformat(), prev.isoformat()))
        start = prev = cur
    if start:
        out.append((start.isoformat(), prev.isoformat()))
    return out


def fill() -> None:
    """Look up every photo that has a position and a date but no weather yet."""
    if not enabled() or not _fill_lock.acquire(blocking=False):
        return
    try:
        conn = db.connect()
        today = datetime.date.today()
        rows = conn.execute(
            f"SELECT p.id, p.lat, p.lon, p.taken_ts FROM photos p WHERE p.missing=0 AND {STALE}"
        ).fetchall()
        by_cell: dict[tuple, list] = {}
        for r in rows:
            by_cell.setdefault(cell_of(r["lat"], r["lon"]), []).append(r)
        for cell, photos in by_cell.items():
            if not enabled():
                break
            wanted = {day_of(p["taken_ts"]) for p in photos}
            wanted = {d for d in wanted if datetime.date.fromisoformat(d) <= today}
            missing = [d for d in wanted if _cached(cell, d) is None]
            # Archive and forecast are different hosts, so a stretch never
            # crosses from one to the other.
            cut = (today - datetime.timedelta(days=RECENT_DAYS)).isoformat()
            for group in ([d for d in missing if d < cut], [d for d in missing if d >= cut]):
                for start, end in _runs(group):
                    try:
                        _store(cell, _fetch(cell, start, end))
                        _state["error"] = None
                    except Exception as exc:
                        _state["error"] = str(exc)
                        if "429" in str(exc):
                            return
            updates = []
            for p in photos:
                data = _cached(cell, day_of(p["taken_ts"]))
                if data is None and datetime.date.fromisoformat(day_of(p["taken_ts"])) <= today:
                    continue  # the request failed; left stale for the next fill
                summary = summarise(data, p["taken_ts"]) if data else None
                updates.append((json.dumps(summary) if summary else "", _at(p), p["id"]))
            with db.write_lock:
                conn.executemany("UPDATE photos SET weather=?, weather_at=? WHERE id=?", updates)
                conn.commit()
    finally:
        _fill_lock.release()


def kick() -> None:
    if enabled() and not _fill_lock.locked():
        threading.Thread(target=fill, daemon=True).start()
