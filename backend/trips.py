"""Trips, worked out from the photos each time rather than stored.

A day is "away" when a photo that day was taken more than AWAY_KM from home.
Away days in a row are one trip, and so are away days a day or two apart with
no photos between them - nobody takes pictures on every day of a holiday. A day
with photos only at home ends the trip.

Home comes from the home timeline (home.py), so a move does not turn the old
neighbourhood into a trip. Without one, it is the saved place marked as home,
and without that it is guessed: the spot photographed on the most different
days, which for nearly everyone is home.

Nothing is stored, so there is nothing to go stale after a rescan, a location
fix or a GPX import: the next look sees the change. Only names typed over the
generated ones, and chosen travel modes, are kept, keyed by the trip's first day.
"""
import datetime
import json
from collections import Counter

from . import activities, db, geocode, home, places

AWAY_KM = 50
# Days without photos that can sit inside one trip.
QUIET_DAYS = 2
# Cell size for guessing home: about 5 km.
HOME_CELL = 0.05
# Photos this close together are one stop; a move further than this is a leg.
STOP_KM = 2.0
MODES = ("foot", "bike", "car", "bus", "train", "plane", "boat")
# What a workout says about how a leg was travelled.
SPORT_MODE = {"cycling": "bike", "running": "foot", "walking": "foot", "hiking": "foot", "rowing": "boat"}


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


def modes() -> dict:
    try:
        return json.loads(db.get_setting("trip_modes") or "{}")
    except ValueError:
        return {}


def set_modes(key: str, body: dict) -> dict:
    """Merge a trip's travel modes: `trip` for the whole trip, `legs` for single
    legs by id. An empty value goes back to the default."""
    current = modes()
    entry = current.setdefault(key, {"trip": "", "legs": {}})
    if "trip" in body:
        mode = str(body["trip"] or "")
        if mode and mode not in MODES:
            raise ValueError(f"Unknown travel mode {mode}")
        entry["trip"] = mode
    for leg, mode in (body.get("legs") or {}).items():
        mode = str(mode or "")
        if mode and mode not in MODES:
            raise ValueError(f"Unknown travel mode {mode}")
        if mode:
            entry["legs"][str(leg)] = mode
        else:
            entry["legs"].pop(str(leg), None)
    if not entry["trip"] and not entry["legs"]:
        current.pop(key, None)
    db.set_setting("trip_modes", json.dumps(current))
    return current.get(key, {"trip": "", "legs": {}})


def _timeline(conn):
    """(timeline, current home, whether the timeline was set by the person)."""
    periods = home.listing()
    if periods:
        latest = periods[-1]
        return home.Timeline(periods), {"lat": latest["lat"], "lon": latest["lon"], "name": latest["name"],
                                        "id": None, "guessed": False}, True
    fallback = guess_home(conn)
    if not fallback:
        return None, None, False
    return home.Timeline([{"since": "1970-01-01", **fallback}]), fallback, False


def _runs(conn, away_km: float):
    timeline, current, configured = _timeline(conn)
    if not timeline:
        return None
    rows = conn.execute(
        "SELECT id, lat, lon, taken_ts, place, country, favorite FROM photos"
        " WHERE missing=0 AND lat IS NOT NULL AND taken_ts IS NOT NULL ORDER BY taken_ts, id"
    ).fetchall()

    # One pass: which days are away, and the photos of each.
    days: dict[int, list] = {}
    away: dict[int, bool] = {}
    for r in rows:
        day = r["taken_ts"] // 86400
        h = timeline.at(day)
        d = places.km(h["lat"], h["lon"], r["lat"], r["lon"])
        days.setdefault(day, []).append((r, d))
        if d > away_km:
            away[day] = True
        else:
            away.setdefault(day, False)

    runs: list = []
    for day in sorted(days):
        if not away[day]:
            if runs and runs[-1] is not None:
                runs.append(None)  # home day: closes whatever was open
            continue
        if runs and runs[-1] is not None and day - runs[-1][-1] <= QUIET_DAYS + 1:
            runs[-1].append(day)
        else:
            runs.append([day])
    return timeline, current, configured, days, [run for run in runs if run]


def compute(conn=None, away_km: float = AWAY_KM) -> dict:
    conn = conn or db.connect()
    found = _runs(conn, away_km)
    if not found:
        return {"home": None, "items": [], "timeline": [], "timeline_set": False}
    _, current, configured, days, runs = found
    if geocode.available():
        current["place"], current["cc"] = geocode.lookup(current["lat"], current["lon"])
    named = titles()
    items = [_describe(run, days, named, away_km) for run in runs]
    items.reverse()  # newest first
    return {"home": current, "items": items, "away_km": away_km,
            "timeline": home.listing(), "timeline_set": configured}


def _away(run: list[int], days: dict, away_km: float) -> list:
    photos = [pair for day in run for pair in days[day]]
    # Only the photos actually away belong to the trip; the morning at home on
    # the day of leaving does not.
    return [r for r, d in photos if d > away_km / 4] or [r for r, _ in photos]


def _describe(run: list[int], days: dict, named: dict, away_km: float) -> dict:
    photos = [pair for day in run for pair in days[day]]
    trip = _away(run, days, away_km)
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


# --------------------------------------------------------------------- detail

def _town(r) -> str:
    return (r["place"] or "").split(",")[0]


def _stops(photos: list) -> list[dict]:
    """Runs of photos within STOP_KM of the first photo of the run."""
    stops: list[dict] = []
    for r in photos:
        s = stops[-1] if stops else None
        if s and places.km(s["lat"], s["lon"], r["lat"], r["lon"]) <= STOP_KM:
            s["last"] = r["taken_ts"]
            s["n"] += 1
            s["name"] = s["name"] or _town(r)
            continue
        stops.append({"lat": r["lat"], "lon": r["lon"], "first": r["taken_ts"], "last": r["taken_ts"],
                      "n": 1, "name": _town(r)})
    return stops


def _leg(a: dict, b: dict, start: int, end: int, assumed: bool = False) -> dict:
    return {"id": f"{start}-{end}", "start_ts": start, "end_ts": end, "day": start // 86400,
            "from": a["name"], "to": b["name"], "from_ll": [a["lat"], a["lon"]], "to_ll": [b["lat"], b["lon"]],
            "km": round(places.km(a["lat"], a["lon"], b["lat"], b["lon"]), 1), "assumed": assumed}


def _leg_mode(leg: dict, chosen: dict, acts: list[dict]) -> tuple[str, str]:
    if leg["id"] in chosen.get("legs", {}):
        return chosen["legs"][leg["id"]], "chosen"
    for a in acts:
        end = a["local_ts"] + (a["elapsed_s"] or 0)
        if a["local_ts"] <= leg["end_ts"] and end >= leg["start_ts"] and a["sport"] in SPORT_MODE:
            return SPORT_MODE[a["sport"]], "activity"
    if chosen.get("trip"):
        return chosen["trip"], "trip"
    return "", ""


def detail(key: str, away_km: float = AWAY_KM) -> dict | None:
    conn = db.connect()
    found = _runs(conn, away_km)
    if not found:
        return None
    timeline, current, _, days, runs = found
    run = next((r for r in runs if str(r[0]) == key), None)
    if not run:
        return None
    summary = _describe(run, days, titles(), away_km)
    everything = [r for day in run for r, _ in days[day]]
    trip = _away(run, days, away_km)
    chosen = modes().get(key, {"trip": "", "legs": {}})
    first_day, last_day = run[0], run[-1]
    acts = activities.between(first_day * 86400, (last_day + 1) * 86400 - 1)

    stops = _stops(everything)
    legs = [_leg(a, b, a["last"], b["first"]) for a, b in zip(stops, stops[1:])]
    # A trip whose first photo is already away got there somehow: the journey
    # from home is a leg too, with no time of its own. Likewise the way back.
    start_home, end_home = timeline.at(first_day), timeline.at(last_day)
    h0 = {"lat": start_home["lat"], "lon": start_home["lon"], "name": start_home.get("name") or "Home"}
    h1 = {"lat": end_home["lat"], "lon": end_home["lon"], "name": end_home.get("name") or "Home"}
    if stops and places.km(h0["lat"], h0["lon"], stops[0]["lat"], stops[0]["lon"]) > away_km / 4:
        legs.insert(0, _leg(h0, stops[0], stops[0]["first"], stops[0]["first"], assumed=True))
        legs[0]["id"] = "home-" + legs[0]["id"]
    if stops and places.km(h1["lat"], h1["lon"], stops[-1]["lat"], stops[-1]["lon"]) > away_km / 4:
        legs.append(_leg(stops[-1], h1, stops[-1]["last"], stops[-1]["last"], assumed=True))
        legs[-1]["id"] += "-home"
    for leg in legs:
        leg["mode"], leg["mode_src"] = _leg_mode(leg, chosen, acts)

    for a in acts:
        a["route"] = activities.route(a)
    iso = lambda d: (datetime.date(1970, 1, 1) + datetime.timedelta(days=d)).isoformat()  # noqa: E731
    walked = activities.daily_between(iso(first_day), iso(last_day))

    out_days = []
    for day in range(first_day, last_day + 1):
        mine = [r for r in trip if r["taken_ts"] // 86400 == day]
        day_legs = [leg for leg in legs if leg["day"] == day]
        by_mode = Counter()
        for leg in day_legs:
            by_mode[leg["mode"]] += leg["km"]
        day_acts = [a for a in acts if a["local_ts"] // 86400 == day]
        towns = Counter(_town(r) for r in mine if r["place"])
        out_days.append({
            "day": day,
            "photos": len(mine),
            "ids": [r["id"] for r in mine],
            "towns": [n for n, _ in towns.most_common(5)],
            "km": round(sum(leg["km"] for leg in day_legs), 1),
            "km_by_mode": {m: round(v, 1) for m, v in by_mode.items()},
            "activities": [a["id"] for a in day_acts],
            "act_km": round(sum((a["distance_m"] or 0) for a in day_acts) / 1000, 1),
            "act_moving_s": round(sum((a["moving_s"] or 0) for a in day_acts)),
            "act_ascent_m": round(sum((a["ascent_m"] or 0) for a in day_acts)),
            "steps": walked.get(iso(day), {}).get("steps", 0),
            "walk_km": round(walked.get(iso(day), {}).get("distance_m", 0) / 1000, 1),
            "first_ts": mine[0]["taken_ts"] if mine else None,
            "last_ts": mine[-1]["taken_ts"] if mine else None,
        })

    by_mode = Counter()
    for leg in legs:
        by_mode[leg["mode"]] += leg["km"]
    summary.update({
        "home": current,
        "trip_mode": chosen.get("trip", ""),
        "modes": MODES,
        "legs": legs,
        "stops": [{k: s[k] for k in ("lat", "lon", "first", "last", "n", "name")} for s in stops],
        "days_detail": out_days,
        "activities": acts,
        "km_by_mode": {m: round(v, 1) for m, v in by_mode.items()},
        "points": {"ids": [r["id"] for r in everything], "lat": [r["lat"] for r in everything],
                   "lon": [r["lon"] for r in everything], "ts": [r["taken_ts"] for r in everything]},
    })
    return summary
