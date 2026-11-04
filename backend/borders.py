"""Town borders from OpenStreetMap, for naming photos by the town they are in.

GeoNames gives a point per town; the range rule in geocode.py guesses how far
each one reaches. OpenStreetMap has the actual borders, the same ones a map
draws: a photo is filed under the town whose border it is inside, and a photo
just over a national border under the right country.

The borders are not downloaded - a planet's worth is tens of gigabytes. The
Overpass API is asked which areas contain each spot instead, a few dozen spots
per request. Photos are grouped in cells of CELL degrees (about 500 m), and
each cell is asked about once, at the position of its photo nearest the middle
of the cell's photos, rounded to about 10 m. The cell's own centre would be
simpler, but it can sit in a bay or over a border the photos are not across.
That one position per cell is what leaves the machine. The answers are kept
in `border_cells` with every name OSM has for the areas, so
changing language needs no new request. Off until turned on in Settings.

What counts as the town, most specific first: an area tagged as a city, town,
village or hamlet; else the municipality (admin level 8, then 7). Countries
draw municipalities differently - a German Gemeinde holds villages and fields,
an English district is large - and where none of these contain a spot, the
GeoNames range rule names it as before.
"""
import json
import threading
import time
import urllib.parse
import urllib.request

from . import db

URL = "https://overpass-api.de/api/interpreter"
CELL = 0.005
BATCH = 40
PAUSE_S = 2.0
RETRY_WAITS_S = (15, 45, 90)
SETTLEMENTS = ("hamlet", "village", "town", "city")  # smallest first: the most specific wins
SCHEMA = """
CREATE TABLE IF NOT EXISTS border_cells (
    cell       TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    fetched_ts INTEGER
);
"""

_cache: dict[str, dict] | None = None
_lock = threading.Lock()
_fill_lock = threading.Lock()
_state = {"error": None, "done": 0}


def init_schema() -> None:
    conn = db.connect()
    conn.executescript(SCHEMA)
    conn.commit()


def enabled() -> bool:
    return db.get_setting("place_borders", "0") == "1"


def cell_of(lat: float, lon: float) -> str:
    return f"{round(lat / CELL) * CELL:.3f},{round(lon / CELL) * CELL:.3f}"


def _known() -> dict[str, dict]:
    global _cache
    with _lock:
        if _cache is None:
            _cache = {r["cell"]: json.loads(r["data"]) for r in db.connect().execute("SELECT cell, data FROM border_cells")}
        return _cache


def _named(tags: dict | None) -> dict | None:
    if not tags or not tags.get("name"):
        return None
    return {"name": tags["name"], "names": {k[5:]: v for k, v in tags.items() if k.startswith("name:")}}


def choose(areas: list[dict]) -> dict:
    """The town, region and country among the areas containing one spot."""
    places = sorted((a for a in areas if a.get("place") in SETTLEMENTS), key=lambda a: SETTLEMENTS.index(a["place"]))
    admin = sorted((a for a in areas if a.get("boundary") == "administrative" and a.get("admin_level") in ("7", "8")),
                   key=lambda a: -int(a["admin_level"]))
    region = next((a for a in areas if a.get("admin_level") == "4"), None)
    country = next((a for a in areas if a.get("admin_level") == "2"), None)
    cc = (country or {}).get("ISO3166-1:alpha2") or (country or {}).get("ISO3166-1") or ""
    return {"town": _named((places or admin or [None])[0]), "region": _named(region), "cc": cc.upper()[:2]}


def lookup(lat: float, lon: float, lang: str) -> tuple[str, str, str] | None:
    """(town, region, country code) from the stored borders, or None when the
    spot has not been asked about or no town border contains it."""
    if not enabled():
        return None
    hit = _known().get(cell_of(lat, lon))
    if not hit or not hit.get("town"):
        return None
    pick = lambda n: (n["names"].get(lang) or n["name"]) if n else ""  # noqa: E731
    return pick(hit["town"]), pick(hit.get("region")), hit.get("cc") or ""


def _query(spots: list[tuple[float, float]]) -> str:
    parts = ["[out:json][timeout:120];"]
    for i, (lat, lon) in enumerate(spots):
        parts.append(
            f'is_in({lat:.4f},{lon:.4f})->.a{i};make cell idx="{i}";out;'
            f'(area.a{i}[boundary=administrative][admin_level~"^(2|4|7|8)$"];'
            f'area.a{i}[place~"^({"|".join(SETTLEMENTS)})$"];);out tags;')
    return "".join(parts)


def _post(query: str) -> dict:
    req = urllib.request.Request(URL, data=urllib.parse.urlencode({"data": query}).encode(),
                                 headers={"User-Agent": "PhotoMap/1.0 (personal photo map)"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch(cells: dict[str, tuple[float, float]]) -> dict[str, dict]:
    """Ask Overpass about a batch of cells, each at its own position; every
    cell gets an answer, empty when nothing contains it (open sea), so it is
    not asked about again."""
    keys = list(cells)
    found: dict[int, list] = {i: [] for i in range(len(keys))}
    current = None
    for el in _post(_query([cells[k] for k in keys])).get("elements", []):
        if el.get("type") == "cell":
            current = int(el["tags"]["idx"])
        elif el.get("type") == "area" and current is not None:
            found[current].append(el.get("tags") or {})
    return {keys[i]: choose(areas) for i, areas in found.items()}


def store(results: dict[str, dict]) -> None:
    now = int(time.time())
    conn = db.connect()
    with db.write_lock:
        conn.executemany("INSERT OR REPLACE INTO border_cells(cell, data, fetched_ts) VALUES (?,?,?)",
                         [(c, json.dumps(d, ensure_ascii=False), now) for c, d in results.items()])
        conn.commit()
    with _lock:
        if _cache is not None:
            _cache.update(results)


def _photo_cells() -> dict[str, list]:
    """{cell: [(id, lat, lon), ...]} for every located photo."""
    cells: dict[str, list] = {}
    for r in db.connect().execute("SELECT id, lat, lon FROM photos WHERE missing=0 AND lat IS NOT NULL"):
        cells.setdefault(cell_of(r["lat"], r["lon"]), []).append((r["id"], r["lat"], r["lon"]))
    return cells


def _spot(photos: list) -> tuple[float, float]:
    """The photo nearest the middle of a cell's photos: a place someone stood."""
    mlat = sum(p[1] for p in photos) / len(photos)
    mlon = sum(p[2] for p in photos) / len(photos)
    _, lat, lon = min(photos, key=lambda p: (p[1] - mlat) ** 2 + (p[2] - mlon) ** 2)
    return round(lat, 4), round(lon, 4)


def status() -> dict:
    cells = _photo_cells() if enabled() else {}
    known = _known()
    return {"enabled": enabled(), "cells": len(cells), "pending": sum(1 for c in cells if c not in known),
            "running": _fill_lock.locked(), "error": _state["error"]}


def fill() -> None:
    """Ask about every photo cell not asked about yet, a batch at a time, and
    have the photos in each answered batch named again."""
    if not enabled() or not _fill_lock.acquire(blocking=False):
        return
    from . import geocode
    try:
        _state["error"] = None
        cells = _photo_cells()
        known = _known()
        todo = sorted(c for c in cells if c not in known)
        for start in range(0, len(todo), BATCH):
            if not enabled():
                break
            batch = todo[start:start + BATCH]
            results = None
            # The public Overpass server is often busy (429, 502, 504) for a
            # minute; a few spaced retries ride that out. Past them, offline or
            # refused: tried again on the next kick.
            for wait in RETRY_WAITS_S:
                try:
                    results = fetch({c: _spot(cells[c]) for c in batch})
                    _state["error"] = None
                    break
                except Exception as exc:
                    _state["error"] = str(exc)
                    time.sleep(wait)
            if results is None:
                break
            store(results)
            ids = [p[0] for c in batch for p in cells[c]]
            conn = db.connect()
            with db.write_lock:
                for k in range(0, len(ids), 500):
                    part = ids[k:k + 500]
                    conn.execute(f"UPDATE photos SET place_at=NULL WHERE id IN ({','.join('?' * len(part))})", part)
                conn.commit()
            geocode.kick()
            time.sleep(PAUSE_S)
    finally:
        _fill_lock.release()


def kick() -> None:
    if enabled() and not _fill_lock.locked():
        threading.Thread(target=fill, daemon=True).start()


def set_enabled(on: bool) -> dict:
    from . import geocode
    db.set_setting("place_borders", "1" if on else "0")
    # Every name may change either way: borders win where they are known, and
    # turning them off goes back to the range rule.
    geocode.rename()
    geocode.kick()
    return status()
