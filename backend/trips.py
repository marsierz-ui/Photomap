"""Trips, worked out from the photos each time rather than stored.

A day is "away" when a photo that day was taken more than AWAY_KM from home.
Away days in a row are one trip, and so are away days a day or two apart with
no photos between them - nobody takes pictures on every day of a holiday. A day
with photos only at home ends the trip.

Home is the saved place marked as home. Without one, it is guessed: the spot
photographed on the most different days, which for nearly everyone is home.

Nothing is stored, so there is nothing to go stale after a rescan, a location
fix or a GPX import: the next look sees the change. Only names typed over the
generated ones are kept, keyed by the trip's first day.
"""
import json
from collections import Counter

from . import db, geocode, places

AWAY_KM = 50
# Days without photos that can sit inside one trip.
QUIET_DAYS = 2
# Cell size for guessing home: about 5 km.
HOME_CELL = 0.05


def guess_home(conn) -> dict | None:
    saved = places.home()
    if saved:
        return {"lat": saved["lat"], "lon": saved["lon"], "name": saved["name"], "id": saved["id"], "guessed": False}
    row = conn.execute(
        "SELECT CAST(ROUND(lat / ?) AS INTEGER) AS y, CAST(ROUND(lon / ?) AS INTEGER) AS x,"
        " COUNT(DISTINCT taken_ts / 86400) AS days, AVG(lat) AS lat, AVG(lon) AS lon,"
        " MAX(place) AS place"
        " FROM photos WHERE missing=0 AND lat IS NOT NULL AND taken_ts IS NOT NULL"
        " GROUP BY y, x ORDER BY days DESC LIMIT 1",
        (HOME_CELL, HOME_CELL),
    ).fetchone()
    if not row:
        return None
    return {"lat": row["lat"], "lon": row["lon"], "name": row["place"] or "", "id": None,
            "guessed": True, "days": row["days"]}


def titles() -> dict:
    try:
        return json.loads(db.get_setting("trip_titles") or "{}")
    except ValueError:
        return {}


def set_title(key: str, title: str) -> None:
    current = titles()
    title = title.strip()[:120]
    if title:
        current[key] = title
    else:
        current.pop(key, None)
    db.set_setting("trip_titles", json.dumps(current))


def compute(conn=None, away_km: float = AWAY_KM) -> dict:
    conn = conn or db.connect()
    home = guess_home(conn)
    if not home:
        return {"home": None, "items": []}
    hlat, hlon = home["lat"], home["lon"]
    if geocode.available():
        home["place"], home["cc"] = geocode.lookup(hlat, hlon)
    rows = conn.execute(
        "SELECT id, lat, lon, taken_ts, place, country, favorite FROM photos"
        " WHERE missing=0 AND lat IS NOT NULL AND taken_ts IS NOT NULL ORDER BY taken_ts, id"
    ).fetchall()

    # One pass: which days are away, and the photos of each.
    days: dict[int, list] = {}
    away: dict[int, bool] = {}
    for r in rows:
        day = r["taken_ts"] // 86400
        d = places.km(hlat, hlon, r["lat"], r["lon"])
        days.setdefault(day, []).append((r, d))
        if d > away_km:
            away[day] = True
        else:
            away.setdefault(day, False)

    runs: list[list[int]] = []
    for day in sorted(days):
        if not away[day]:
            if runs and runs[-1] is not None:
                runs.append(None)  # home day: closes whatever was open
            continue
        if runs and runs[-1] is not None and day - runs[-1][-1] <= QUIET_DAYS + 1:
            runs[-1].append(day)
        else:
            runs.append([day])
    named = titles()
    items = [_describe(run, days, named, away_km) for run in runs if run]
    items.reverse()  # newest first
    return {"home": home, "items": items, "away_km": away_km}


def _describe(run: list[int], days: dict, named: dict, away_km: float) -> dict:
    photos = [pair for day in run for pair in days[day]]
    # Only the photos actually away belong to the trip; the morning at home on
    # the day of leaving does not.
    trip = [r for r, d in photos if d > away_km / 4] or [r for r, _ in photos]
    countries = Counter(r["country"] for r in trip if r["country"])
    towns = Counter(r["place"].split(",")[0] for r in trip if r["place"])
    route = 0.0
    for a, b in zip(trip, trip[1:]):
        route += places.km(a["lat"], a["lon"], b["lat"], b["lon"])
    favs = [r for r in trip if r["favorite"]]
    pool = favs or trip
    cover = pool[len(pool) // 2]["id"]
    key = str(run[0])
    lats = [r["lat"] for r in trip]
    lons = [r["lon"] for r in trip]
    return {
        "key": key,
        "title": named.get(key, ""),
        "start_ts": trip[0]["taken_ts"],
        "end_ts": trip[-1]["taken_ts"],
        # Calendar span, so a Friday-to-Sunday weekend is three days.
        "days": run[-1] - run[0] + 1,
        "photo_days": len(run),
        "photos": len(trip),
        "cover": cover,
        "countries": [{"cc": cc, "c": c} for cc, c in countries.most_common()],
        "places": [{"name": n, "c": c} for n, c in towns.most_common(6)],
        "far_km": round(max(d for _, d in photos), 1),
        "route_km": round(route, 1),
        "bbox": [min(lats), min(lons), max(lats), max(lons)],
    }

