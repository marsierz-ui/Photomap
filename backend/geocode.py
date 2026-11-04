"""Coordinates into place names, offline.

GeoNames' list of every place with at least 1,000 people (CC BY 4.0) is fetched
once, on request, and reduced to name, position, country and region. A photo is
given the nearest of those places. Nearest-place is not a border test, so a photo
a few hundred metres from a frontier can be filed under the neighbour; for
"which countries have I been to" that is the right trade against shipping
country outlines.

Positions change after the fact (fixes, undo, a rescan), so each photo records
the coordinates it was named for in `place_at` and anything that no longer
matches is looked up again. No write site has to remember to clear it.
"""
import io
import unicodedata
import math
import threading
import urllib.request
import zipfile

from . import db

SOURCE = "https://download.geonames.org/export/dump/"
DIR = db.DATA_DIR / "geonames"
PLACES = DIR / "places.tsv"

# Past this the nearest place is not where the photo was, just the closest
# thing on the list. Country holds out further, for coast and lake shots.
PLACE_KM = 40
COUNTRY_KM = 150

_index = None
_pops: list = []
_folded = None
_index_lock = threading.Lock()
_fill_lock = threading.Lock()
_download = {"running": False, "error": None}

STALE = (
    "p.lat IS NOT NULL AND (p.place_at IS NULL"
    " OR p.place_at != printf('%.4f,%.4f', p.lat, p.lon))"
)


def available() -> bool:
    return PLACES.exists()


def status() -> dict:
    pending = 0
    if available():
        pending = db.connect().execute(f"SELECT COUNT(*) c FROM photos p WHERE {STALE}").fetchone()["c"]
    return {"available": available(), "downloading": _download["running"],
            "error": _download["error"], "pending": pending, "filling": _fill_lock.locked()}


# ------------------------------------------------------------------ download

def download() -> None:
    """Fetch and reduce the GeoNames files. Run in a thread; see status()."""
    if _download["running"]:
        return
    _download.update(running=True, error=None)
    try:
        with urllib.request.urlopen(SOURCE + "admin1CodesASCII.txt", timeout=60) as r:
            regions = {}
            for line in r.read().decode("utf-8").splitlines():
                parts = line.split("\t")
                if len(parts) >= 2:
                    regions[parts[0]] = parts[1]
        with urllib.request.urlopen(SOURCE + "cities1000.zip", timeout=300) as r:
            archive = zipfile.ZipFile(io.BytesIO(r.read()))
        rows = []
        with archive.open("cities1000.txt") as f:
            for raw in io.TextIOWrapper(f, encoding="utf-8"):
                c = raw.rstrip("\n").split("\t")
                if len(c) < 11:
                    continue
                region = regions.get(f"{c[8]}.{c[10]}", "")
                pop = c[14] if len(c) > 14 else ""
                rows.append("\t".join((c[1], c[4], c[5], c[8], region, pop)))
        DIR.mkdir(parents=True, exist_ok=True)
        tmp = PLACES.with_suffix(".tmp")
        tmp.write_text("\n".join(rows), encoding="utf-8")
        tmp.replace(PLACES)
        global _index
        _index = None
    except Exception as exc:  # network, disk: reported to the settings dialog
        _download["error"] = str(exc)
    finally:
        _download["running"] = False
    if available():
        fill()


# --------------------------------------------------------------------- lookup

def _load():
    global _index
    with _index_lock:
        if _index is None:
            names, lats, lons, ccs, regions, grid = [], [], [], [], [], {}
            pops = []
            for i, line in enumerate(PLACES.read_text(encoding="utf-8").splitlines()):
                # Files written before population was kept have five columns.
                name, lat, lon, cc, region, *rest = line.split("\t")
                lat, lon = float(lat), float(lon)
                names.append(name); lats.append(lat); lons.append(lon)
                ccs.append(cc); regions.append(region)
                pops.append(int(rest[0]) if rest and rest[0].isdigit() else 0)
                grid.setdefault((math.floor(lat), math.floor(lon)), []).append(i)
            _index = (names, lats, lons, ccs, regions, grid)
            global _pops, _folded
            _pops = pops
            _folded = None
    return _index


def lookup(lat: float, lon: float) -> tuple[str, str]:
    """(place, country code) for a position, either empty when nothing is near."""
    names, lats, lons, ccs, regions, grid = _load()
    cy, cx = math.floor(lat), math.floor(lon)
    shrink = max(math.cos(math.radians(lat)), 0.05)
    best, best_km = None, float("inf")
    # Rings of one-degree cells outwards, until no unsearched cell could hold
    # anything nearer than what has been found.
    for ring in range(0, 30):
        if best is not None and (ring - 1) * 111 * shrink > best_km:
            break
        for dy in range(-ring, ring + 1):
            for dx in range(-ring, ring + 1):
                if max(abs(dy), abs(dx)) != ring:
                    continue
                key = (cy + dy, (cx + dx + 180) % 360 - 180)
                for i in grid.get(key, ()):
                    x = math.radians((lons[i] - lon + 540) % 360 - 180) * math.cos(math.radians((lats[i] + lat) / 2))
                    y = math.radians(lats[i] - lat)
                    km = 6371 * math.hypot(x, y)
                    if km < best_km:
                        best, best_km = i, km
    if best is None or best_km > COUNTRY_KM:
        return "", ""
    place = ", ".join(p for p in (names[best], regions[best]) if p) if best_km <= PLACE_KM else ""
    return place, ccs[best]


def place_for(photo: dict) -> dict:
    """Name one photo now, for the lightbox, rather than waiting on fill()."""
    if photo.get("lat") is None or not available():
        return photo
    at = f"{photo['lat']:.4f},{photo['lon']:.4f}"
    if photo.get("place_at") != at:
        photo["place"], photo["country"] = lookup(photo["lat"], photo["lon"])
        photo["place_at"] = at
        conn = db.connect()
        with db.write_lock:
            conn.execute("UPDATE photos SET place=?, country=?, place_at=? WHERE id=?",
                         (photo["place"], photo["country"], at, photo["id"]))
            conn.commit()
    return photo


def fill() -> None:
    """Name every photo whose position has no name yet or has moved since."""
    if not available() or not _fill_lock.acquire(blocking=False):
        return
    try:
        conn = db.connect()
        while True:
            rows = conn.execute(f"SELECT p.id, p.lat, p.lon FROM photos p WHERE {STALE} LIMIT 2000").fetchall()
            if not rows:
                break
            updates = []
            for r in rows:
                place, cc = lookup(r["lat"], r["lon"])
                updates.append((place, cc, f"{r['lat']:.4f},{r['lon']:.4f}", r["id"]))
            with db.write_lock:
                conn.executemany("UPDATE photos SET place=?, country=?, place_at=? WHERE id=?", updates)
                conn.commit()
    finally:
        _fill_lock.release()


def kick() -> None:
    """fill() in the background, if there is anything to do it with."""
    if available() and not _fill_lock.locked():
        threading.Thread(target=fill, daemon=True).start()


# ----------------------------------------------------------------- search

def _fold(text: str) -> str:
    """Lower case without accents, so "zurich" finds Zürich."""
    return "".join(c for c in unicodedata.normalize("NFKD", text.casefold())
                   if not unicodedata.combining(c))


def search(query: str, limit: int = 10) -> list[dict]:
    """Places on the GeoNames list whose name matches, best first: exact, then
    starting with it, then containing it; bigger places first within each."""
    if not available():
        return []
    q = _fold(query.strip())
    if len(q) < 2:
        return []
    names, lats, lons, ccs, regions, _ = _load()
    global _folded
    if _folded is None:
        _folded = [_fold(n) for n in names]
    hits = []
    for i, name in enumerate(_folded):
        if q not in name:
            continue
        rank = 0 if name == q else 1 if name.startswith(q) else 2 if f" {q}" in name else 3
        hits.append((rank, -_pops[i], i))
    hits.sort()
    return [{"name": names[i], "region": regions[i], "cc": ccs[i],
             "lat": lats[i], "lon": lons[i], "population": _pops[i]} for _, _, i in hits[:limit]]


# GeoNames' continent for each country and territory code. Fixed: borders do
# not move often enough to be worth downloading.
CONTINENTS = {
    "AF": "DZ AO BJ BW BF BI CM CV CF TD KM CG CD CI DJ EG GQ ER ET GA GM GH GN GW KE LS LR LY MG"
          " MW ML MR MU YT MA MZ NA NE NG RE RW SH ST SN SC SL SO ZA SS SD SZ TZ TG TN UG EH ZM ZW",
    "AS": "AF AM AZ BH BD BT BN KH CN CX CC CY IO GE HK IN ID IR IQ IL JP JO KZ KW KG LA LB MO MY"
          " MV MN MM NP KP OM PK PS PH QA SA SG KR LK SY TW TJ TH TR TM AE UZ VN YE",
    "EU": "AX AL AD AT BY BE BA BG HR CZ DK EE FO FI FR DE GI GR GG VA HU IS IE IM IT JE XK LV LI"
          " LT LU MK MT MD MC ME NL NO PL PT RO RU SM RS SK SI ES SJ SE CH UA GB",
    "NA": "AI AG AW BS BB BZ BM BQ VG CA KY CR CU CW DM DO SV GL GD GP GT HT HN JM MQ MX MS NI PA"
          " PR BL KN LC MF PM VC SX TT TC US VI",
    "SA": "AR BO BR CL CO EC FK GF GY PY PE SR UY VE",
    "OC": "AS AU CK FJ PF GU KI MH FM NR NC NZ NU NF MP PW PG PN WS SB TK TL TO TV UM VU WF",
    "AN": "AQ BV GS HM TF",
}
CONTINENT_OF = {cc: k for k, v in CONTINENTS.items() for cc in v.split()}
