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

With town borders turned on (borders.py), a photo inside a town's border in
OpenStreetMap is named after that town, and the range rule only covers what
the borders do not.

Names come as GeoNames spells them, which is mostly the local form ("Wien",
"Gaillimh"). A language can be chosen instead: GeoNames' alternate names file
is streamed once for it and reduced to that language's name for each place on
the list (and each region), so "Vienna" or "Wiedeń" is a lookup in a small
table. Changing language renames every photo.
"""
import io
import math
import os
import tempfile
import threading
import unicodedata
import urllib.request
import zipfile

from . import borders, db

SOURCE = "https://download.geonames.org/export/dump/"
DIR = db.DATA_DIR / "geonames"
PLACES = DIR / "places.tsv"

# A photo is filed under a town only when it is within that town's range, which
# grows with its population: a village of 1,000 reaches about 3 km, a city of a
# million about 13 km, a megacity a little over 50. Outside every range the
# photo keeps its country and no town. Country holds out further, for coast and
# lake shots.
RANGE_BASE_KM = 3.0
RANGE_PER_SQRT_POP = 0.0103
RANGE_MAX_KM = 60.0
COUNTRY_KM = 150
# Bumped when the naming rule changes, so every photo is named again once.
RULE = "range-1"


def range_km(population: int) -> float:
    return min(RANGE_MAX_KM, RANGE_BASE_KM + RANGE_PER_SQRT_POP * math.sqrt(max(population, 1000)))

_index = None
_pops: list = []
_ids: list = []
_region_ids: list = []
_folded = None
_index_lock = threading.Lock()
_fill_lock = threading.Lock()
_download = {"running": False, "error": None}
# The alternate names download: which language, how far through the archive.
_names = {"running": False, "error": None, "lang": "", "done": 0, "total": 0}
_translated: dict = {}  # language -> {geonameid: name}, loaded on first use

STALE = (
    "p.lat IS NOT NULL AND (p.place_at IS NULL"
    " OR p.place_at != printf('%.4f,%.4f', p.lat, p.lon))"
)


def available() -> bool:
    return PLACES.exists()


def names_file(lang: str):
    return DIR / f"names-{lang}.tsv"


def language() -> str:
    """The chosen language for place names, '' for GeoNames' own spelling."""
    return (db.get_setting("place_lang") or "").strip().lower()


def has_ids() -> bool:
    """Whether places.tsv carries GeoNames ids, which translations are keyed by.
    Lists downloaded before translations existed do not."""
    if not available():
        return False
    with PLACES.open(encoding="utf-8") as f:
        return len(f.readline().rstrip("\n").split("\t")) >= 8


def status() -> dict:
    pending = 0
    if available():
        pending = db.connect().execute(f"SELECT COUNT(*) c FROM photos p WHERE {STALE}").fetchone()["c"]
    lang = language()
    return {"available": available(), "downloading": _download["running"],
            "error": _download["error"], "pending": pending, "filling": _fill_lock.locked(),
            "language": lang, "ids": has_ids(),
            "translated": bool(lang) and names_file(lang).exists(),
            "names": {k: _names[k] for k in ("running", "error", "lang", "done", "total")}}


# ------------------------------------------------------------------ download

def download() -> None:
    """Fetch and reduce the GeoNames files. Run in a thread; see status()."""
    if _download["running"]:
        return
    _download.update(running=True, error=None)
    try:
        with urllib.request.urlopen(SOURCE + "admin1CodesASCII.txt", timeout=60) as r:
            regions, region_ids = {}, {}
            for line in r.read().decode("utf-8").splitlines():
                parts = line.split("\t")
                if len(parts) >= 2:
                    regions[parts[0]] = parts[1]
                if len(parts) >= 4:
                    region_ids[parts[0]] = parts[3]
        with urllib.request.urlopen(SOURCE + "cities1000.zip", timeout=300) as r:
            archive = zipfile.ZipFile(io.BytesIO(r.read()))
        rows = []
        with archive.open("cities1000.txt") as f:
            for raw in io.TextIOWrapper(f, encoding="utf-8"):
                c = raw.rstrip("\n").split("\t")
                if len(c) < 11:
                    continue
                key = f"{c[8]}.{c[10]}"
                pop = c[14] if len(c) > 14 else ""
                # name, lat, lon, country, region, population, id, region id
                rows.append("\t".join((c[1], c[4], c[5], c[8], regions.get(key, ""), pop,
                                       c[0], region_ids.get(key, ""))))
        DIR.mkdir(parents=True, exist_ok=True)
        tmp = PLACES.with_suffix(".tmp")
        tmp.write_text("\n".join(rows), encoding="utf-8")
        tmp.replace(PLACES)
        global _index
        _index = None
        rename()
    except Exception as exc:  # network, disk: reported to the settings dialog
        _download["error"] = str(exc)
    finally:
        _download["running"] = False
    lang = language()
    if lang and not names_file(lang).exists():
        download_names(lang)
    if available():
        fill()


def download_names(lang: str) -> None:
    """Fetch GeoNames' alternate names and keep one language's, for the places
    on our list. The archive is about 190 MB; it is streamed to a temporary file
    (a zip has to be seekable), read once, and deleted, leaving a table of a few
    megabytes. Run in a thread; see status()."""
    lang = lang.strip().lower()
    if _names["running"] or not lang:
        return
    _names.update(running=True, error=None, lang=lang, done=0, total=0)
    part = None
    try:
        if not has_ids():
            raise RuntimeError("the place list predates translations: download place names again first")
        wanted = set()
        for line in PLACES.read_text(encoding="utf-8").splitlines():
            c = line.split("\t")
            wanted.add(c[6])
            if c[7]:
                wanted.add(c[7])
        DIR.mkdir(parents=True, exist_ok=True)
        fd, part = tempfile.mkstemp(dir=DIR, suffix=".zip.part")
        with os.fdopen(fd, "wb") as out, urllib.request.urlopen(SOURCE + "alternateNamesV2.zip", timeout=120) as r:
            _names["total"] = int(r.headers.get("Content-Length") or 0)
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
                _names["done"] += len(chunk)
        best: dict = {}
        with zipfile.ZipFile(part) as archive:
            member = next(n for n in archive.namelist() if n.startswith("alternateNames") and n.endswith(".txt"))
            with archive.open(member) as f:
                for raw in io.TextIOWrapper(f, encoding="utf-8"):
                    c = raw.rstrip("\n").split("\t")
                    # id, geonameid, language, name, preferred, short, colloquial, historic, from, to
                    if len(c) < 4 or c[2] != lang or c[1] not in wanted:
                        continue
                    flag = lambda k: len(c) > k and c[k] == "1"  # noqa: E731
                    if flag(6) or flag(7) or (len(c) > 9 and c[9]):
                        continue  # slang, or a former name
                    rank = 0 if flag(4) else 2 if flag(5) else 1
                    if c[1] not in best or rank < best[c[1]][0]:
                        best[c[1]] = (rank, c[3])
        tmp = names_file(lang).with_suffix(".tmp")
        tmp.write_text("\n".join(f"{k}\t{v[1]}" for k, v in best.items()), encoding="utf-8")
        tmp.replace(names_file(lang))
        _translated.pop(lang, None)
        if language() == lang:
            rename()
    except Exception as exc:  # network, disk, a changed archive layout
        _names["error"] = str(exc)
    finally:
        _names["running"] = False
        if part and os.path.exists(part):
            os.remove(part)
    kick()


def set_language(lang: str) -> dict:
    """Choose the language place names are shown in; '' for GeoNames' own.
    Fetches that language's names when they are not here yet, and renames
    every photo either way."""
    lang = (lang or "").strip().lower()[:8]
    if lang and not all(ch.isalpha() or ch == "-" for ch in lang):
        raise ValueError("Not a language code")
    if lang == language():
        return status()
    db.set_setting("place_lang", lang)
    global _folded
    _folded = None
    rename()
    if lang and not names_file(lang).exists() and has_ids():
        threading.Thread(target=download_names, args=(lang,), daemon=True).start()
    kick()
    return status()


def rename() -> None:
    """Mark every named photo for naming again, in the current language."""
    conn = db.connect()
    with db.write_lock:
        conn.execute("UPDATE photos SET place_at=NULL WHERE place_at IS NOT NULL")
        conn.commit()


def _names_for(lang: str) -> dict:
    if not lang:
        return {}
    if lang not in _translated:
        path = names_file(lang)
        table = {}
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                gid, _, name = line.partition("\t")
                if name:
                    table[gid] = name
        _translated[lang] = table
    return _translated[lang]


# --------------------------------------------------------------------- lookup

def _load():
    global _index
    with _index_lock:
        if _index is None:
            names, lats, lons, ccs, regions, grid = [], [], [], [], [], {}
            pops, ids, region_ids = [], [], []
            for i, line in enumerate(PLACES.read_text(encoding="utf-8").splitlines()):
                # Older lists have five columns (no population) or six (no ids).
                name, lat, lon, cc, region, *rest = line.split("\t")
                lat, lon = float(lat), float(lon)
                names.append(name); lats.append(lat); lons.append(lon)
                ccs.append(cc); regions.append(region)
                pops.append(int(rest[0]) if rest and rest[0].isdigit() else 0)
                ids.append(rest[1] if len(rest) > 1 else "")
                region_ids.append(rest[2] if len(rest) > 2 else "")
                grid.setdefault((math.floor(lat), math.floor(lon)), []).append(i)
            _index = (names, lats, lons, ccs, regions, grid)
            global _pops, _folded, _ids, _region_ids
            _pops, _ids, _region_ids = pops, ids, region_ids
            _folded = None
    return _index


def lookup(lat: float, lon: float) -> tuple[str, str]:
    """(place, country code) for a position. The place is the nearest town whose
    range covers the position, empty when none does; the country is the nearest
    town's, empty when nothing is within COUNTRY_KM."""
    names, lats, lons, ccs, regions, grid = _load()
    cy, cx = math.floor(lat), math.floor(lon)
    shrink = max(math.cos(math.radians(lat)), 0.05)
    best, best_km = None, float("inf")
    town, town_km = None, float("inf")
    # Rings of one-degree cells outwards, until no unsearched cell could hold
    # anything nearer than the nearest place, or a town whose range reaches here.
    for ring in range(0, 30):
        reach = (ring - 1) * 111 * shrink
        if best is not None and reach > best_km and (reach > town_km or reach > RANGE_MAX_KM):
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
                    if km < town_km and km <= range_km(_pops[i]):
                        town, town_km = i, km
    near = best is not None and best_km <= COUNTRY_KM
    # A town border from OpenStreetMap, where one is known, beats any range.
    border = borders.lookup(lat, lon, language())
    if border:
        name, region, cc = border
        cc = cc or (ccs[best] if near else "")
        if not region and near and ccs[best] == cc:
            region = _local(best)[1]
        return ", ".join(p for p in (name, region) if p), cc
    if not near:
        return "", ""
    if town is None:
        return "", ccs[best]
    name, region = _local(town)
    return ", ".join(p for p in (name, region) if p), ccs[town]


def _local(i: int) -> tuple[str, str]:
    """Place i's name and region, in the chosen language where GeoNames has it."""
    names, _, _, _, regions, _ = _load()
    table = _names_for(language())
    return (table.get(_ids[i]) or names[i],
            (table.get(_region_ids[i]) if _region_ids[i] else None) or regions[i])


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
    if available() and db.get_setting("place_rule") != RULE:
        rename()
        db.set_setting("place_rule", RULE)
    if available() and not _fill_lock.locked():
        threading.Thread(target=fill, daemon=True).start()
    borders.kick()


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
        # Both spellings are searched: "Vienna" and "Wien" find the same place.
        table = _names_for(language())
        _folded = [(_fold(n), _fold(table.get(_ids[i], ""))) for i, n in enumerate(names)]
    hits = []
    for i, pair in enumerate(_folded):
        rank = 9
        for name in pair:
            if name and q in name:
                rank = min(rank, 0 if name == q else 1 if name.startswith(q) else 2 if f" {q}" in name else 3)
        if rank < 9:
            hits.append((rank, -_pops[i], i))
    hits.sort()
    out = []
    for _, _, i in hits[:limit]:
        name, region = _local(i)
        out.append({"name": name, "local": names[i] if name != names[i] else "", "region": region,
                    "cc": ccs[i], "lat": lats[i], "lon": lons[i], "population": _pops[i]})
    return out


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
