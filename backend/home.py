"""Where home was, over time.

People move, so one home measured against a decade of photos turns every week
in the old flat into a trip. The timeline is a list of homes, each from a date
until the next one starts; the first one also covers everything before it.

When none has been set, a timeline is suggested from the photos: for each
quarter, the spot photographed on the most different days, starting on the first
day it was photographed that quarter. Consecutive quarters at the same spot are
one period.
"""
import bisect
import datetime

from . import db, geocode, places

# About 5 km, the same cell trips used to guess one home.
CELL = 0.05
# A quarter with fewer days than this at its busiest spot says nothing about home.
MIN_DAYS = 5
SAME_KM = 5.0

SCHEMA = """
CREATE TABLE IF NOT EXISTS home_periods (
    id    INTEGER PRIMARY KEY,
    since TEXT NOT NULL UNIQUE,
    name  TEXT NOT NULL DEFAULT '',
    lat   REAL NOT NULL,
    lon   REAL NOT NULL
);
"""


def init_schema() -> None:
    conn = db.connect()
    conn.executescript(SCHEMA)
    conn.commit()


def _day_index(since: str) -> int:
    return int(datetime.datetime.fromisoformat(since).replace(tzinfo=datetime.UTC).timestamp()) // 86400


def listing() -> list[dict]:
    rows = db.connect().execute("SELECT since, name, lat, lon FROM home_periods ORDER BY since").fetchall()
    return [dict(r) for r in rows]


def save(items: list[dict]) -> list[dict]:
    """Replace the whole timeline. The earliest entry covers everything before it."""
    clean, seen = [], set()
    for item in items:
        since = str(item.get("since") or "").strip()
        try:
            datetime.date.fromisoformat(since)
            lat, lon = float(item["lat"]), float(item["lon"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("Every home needs a date and a position")
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise ValueError("Not a position")
        if since in seen:
            raise ValueError(f"Two homes start on {since}")
        seen.add(since)
        clean.append((since, str(item.get("name") or "").strip()[:80], lat, lon))
    conn = db.connect()
    with db.write_lock:
        conn.execute("DELETE FROM home_periods")
        conn.executemany("INSERT INTO home_periods(since, name, lat, lon) VALUES (?,?,?,?)", clean)
        conn.commit()
    return listing()


class Timeline:
    """Home for any day, from the stored periods or a single fallback home."""

    def __init__(self, periods: list[dict]):
        self.periods = sorted(periods, key=lambda p: p["since"])
        self.starts = [_day_index(p["since"]) for p in self.periods]

    def at(self, day: int) -> dict:
        i = bisect.bisect_right(self.starts, day) - 1
        return self.periods[max(i, 0)]


def suggest(conn=None) -> list[dict]:
    conn = conn or db.connect()
    rows = conn.execute(
        "SELECT CAST(strftime('%Y', taken_ts, 'unixepoch') AS INTEGER) * 4"
        " + (CAST(strftime('%m', taken_ts, 'unixepoch') AS INTEGER) - 1) / 3 AS quarter,"
        " CAST(ROUND(lat / ?) AS INTEGER) AS y, CAST(ROUND(lon / ?) AS INTEGER) AS x,"
        " COUNT(DISTINCT taken_ts / 86400) AS days, MIN(taken_ts) AS first,"
        " AVG(lat) AS lat, AVG(lon) AS lon"
        " FROM photos WHERE missing=0 AND lat IS NOT NULL AND taken_ts IS NOT NULL"
        " GROUP BY quarter, y, x ORDER BY quarter, days DESC",
        (CELL, CELL),
    ).fetchall()
    best: dict[int, dict] = {}
    for r in rows:
        if r["quarter"] not in best and r["days"] >= MIN_DAYS:
            best[r["quarter"]] = dict(r)
    out: list[dict] = []
    for quarter in sorted(best):
        r = best[quarter]
        if out and places.km(out[-1]["lat"], out[-1]["lon"], r["lat"], r["lon"]) <= SAME_KM:
            continue
        since = datetime.datetime.fromtimestamp(r["first"], datetime.UTC).date().isoformat()
        name = geocode.lookup(r["lat"], r["lon"])[0].split(",")[0] if geocode.available() else ""
        out.append({"since": since, "name": name, "lat": r["lat"], "lon": r["lon"], "days": r["days"]})
    return out
