"""Saved places, automatic trips, GPX / Google Timeline import and geotagging,
place search and the location export.

    .venv\\Scripts\\python.exe tests\\test_trips.py
"""
import json
import sys
import tempfile
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT))

TMP = Path(tempfile.mkdtemp(prefix="photomap_trips_"))
DATA = TMP / "data"
DATA.mkdir()

from backend import db  # noqa: E402

db.DATA_DIR = DATA
db.DB_PATH = DATA / "photomap.db"
db.THUMB_DIR = DATA / "thumbs"
db.TRASH_DIR = DATA / "trash"

from starlette.requests import Request  # noqa: E402

from backend import geocode  # noqa: E402

geocode.DIR = DATA / "geonames"
geocode.PLACES = geocode.DIR / "places.tsv"
geocode.DIR.mkdir()
geocode.PLACES.write_text("\n".join([
    "Galway\t53.27194\t-9.04889\tIE\tConnacht\t79934",
    "Kilronan\t53.1219\t-9.6666\tIE\tConnacht\t270",
    "Galway Bay\t53.2\t-9.2\tIE\tConnacht\t0",
    "Paris\t48.85341\t2.3488\tFR\tÎle-de-France\t2138551",
    "Zürich\t47.36667\t8.55\tCH\tZurich\t341730",
    "Lyon\t45.74846\t4.84671\tFR\tAuvergne-Rhône-Alpes\t472317",
]), encoding="utf-8")

from backend import main, places, tracks, trips  # noqa: E402

failures = []


def check(label, condition, detail=""):
    print(f"{'PASS' if condition else 'FAIL'}  {label}{'' if condition else f' -> {detail}'}")
    if not condition:
        failures.append(label)


def request(**query):
    qs = "&".join(f"{k}={v}" for k, v in query.items()).encode()
    return Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": qs})


DAY = 86400
T0 = 1_700_006_400 - (1_700_006_400 % DAY)  # a midnight
GALWAY = (53.2720, -9.0490)
PARIS = (48.8534, 2.3488)
LYON = (45.7485, 4.8467)
ZURICH = (47.3667, 8.5500)

conn = db.connect()
rows = []
pid = 0


def photo(day, hour, at, **extra):
    global pid
    pid += 1
    rows.append((pid, f"/p/{pid}.jpg", "/p", f"{pid}.jpg", at[0] if at else None, at[1] if at else None,
                 T0 + day * DAY + hour * 3600, extra.get("method"), extra.get("fav", 0)))
    return pid


# Home life: Galway on many days.
for d in range(0, 40, 2):
    if d not in (10, 12, 14, 20, 22):
        photo(d, 12, GALWAY)
# Trip 1: days 10-14 Paris then Lyon, with a quiet day 12 in the middle.
photo(10, 9, GALWAY)                    # leaving in the morning
photo(10, 18, PARIS)
photo(11, 10, PARIS, fav=1)
photo(13, 11, LYON)
photo(14, 15, LYON)
# Day 16 is home again (photo above), then trip 2: Zürich on day 21.
z = photo(21, 14, ZURICH)
# An unlocated camera shot during trip 2, 30 minutes after the GPS photo.
camera = photo(21, 14, None)
rows[-1] = rows[-1][:6] + (T0 + 21 * DAY + 14 * 3600 + 1800,) + rows[-1][7:]
conn.executemany(
    "INSERT INTO photos(id, path, folder, filename, lat, lon, taken_ts, gps_method, favorite)"
    " VALUES (?,?,?,?,?,?,?,?,?)", rows)
conn.commit()

# ------------------------------------------------------------------ places

home = main.create_place({"name": "Home", "lat": GALWAY[0], "lon": GALWAY[1], "radius_m": 500, "is_home": True})
check("a saved place is created", home["id"] and home["is_home"] == 1)
cafe = main.create_place({"name": "Café", "lat": PARIS[0], "lon": PARIS[1]})
listed = {p["name"]: p for p in main.list_places()}
check("home counts its photos", listed["Home"]["photos"] == 16, listed["Home"])
check("a place counts its photos", listed["Café"]["photos"] == 2, listed["Café"])
check("near filters to the circle", main.list_photos(request(near=cafe["id"]))["total"] == 2)
main.update_place(cafe["id"], {"is_home": True})
check("only one place is home", [p["name"] for p in main.list_places() if p["is_home"]] == ["Café"])
main.update_place(home["id"], {"is_home": True})
try:
    main.create_place({"name": "", "lat": 1, "lon": 1})
    check("a nameless place is refused", False)
except Exception:
    check("a nameless place is refused", True)
main.delete_place(cafe["id"])
check("a place is deleted", len(main.list_places()) == 1)

# ------------------------------------------------------------------- trips

res = main.list_trips()
items = res["items"]
check("home is the saved one", res["home"]["name"] == "Home" and not res["home"]["guessed"])
check("two trips found", len(items) == 2, [(i["start_ts"], i["days"]) for i in items])
older = items[-1]
check("a quiet day does not split a trip", older["days"] == 5, older)
check("the morning at home is not part of the trip", older["photos"] == 4, older)
check("the favourite is the cover", older["cover"] in {r[0] for r in rows if r[8]}, older)
check("countries of the trip", [c["cc"] for c in older["countries"]] == [], older["countries"])  # not named yet
# list_trips() starts naming in the background; wait for it rather than race it.
import time  # noqa: E402
for _ in range(100):
    geocode.fill()
    if not geocode.status()["pending"] and not geocode.status()["filling"]:
        break
    time.sleep(0.05)
older = main.list_trips()["items"][-1]
check("countries once named", [c["cc"] for c in older["countries"]] == ["FR"], older["countries"])
check("route length is counted", 380 < older["route_km"] < 450, older["route_km"])
main.name_trip(older["key"], {"title": "France 2023"})
check("a trip keeps a typed name", main.list_trips()["items"][-1]["title"] == "France 2023")
main.delete_place(home["id"])
guessed = main.list_trips()
check("without a saved home, it is guessed", guessed["home"]["guessed"]
      and abs(guessed["home"]["lat"] - GALWAY[0]) < 0.1, guessed["home"])

# ----------------------------------------------------------------- search

hits = main.geocode_search(q="galway")["items"]
check("exact name first", hits and hits[0]["name"] == "Galway", hits)
check("accents do not matter", main.geocode_search(q="zurich")["items"][0]["name"] == "Zürich")
check("photos found by place name", main.list_photos(request(q="Lyon"))["total"] == 2)
check("photos found by country code", main.list_photos(request(q="France", cc="FR"))["total"] == 4)
cs = main.countries(request())
check("world share", cs["world"]["visited"] == 3 and cs["world"]["total"] > 240, cs["world"])
eu = next(c for c in cs["continents"] if c["code"] == "EU")
check("continent share", eu["visited"] == 3, eu)

# ------------------------------------------------------------------ tracks

def utc(ts):
    return tracks.datetime.datetime.fromtimestamp(ts, tracks.datetime.timezone.utc).replace(tzinfo=None)


z_utc = T0 + 21 * DAY + 14 * 3600 - 3600  # the camera ran on UTC+1
gpx = f"""<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>
<trkpt lat="{ZURICH[0]}" lon="{ZURICH[1]}"><time>{utc(z_utc - 600).isoformat()}Z</time></trkpt>
<trkpt lat="{ZURICH[0] + 0.01}" lon="{ZURICH[1]}"><time>{utc(z_utc + 1200).isoformat()}Z</time></trkpt>
<trkpt lat="{ZURICH[0] + 0.02}" lon="{ZURICH[1]}"><time>{utc(z_utc + 2400).isoformat()}Z</time></trkpt>
</trkseg></trk></gpx>""".encode()
saved = tracks.import_file("walk.gpx", gpx)
check("a GPX file is imported", len(saved) == 1 and saved[0]["points"] == 3, saved)
est = tracks.estimate_offset()
check("too few GPS photos to guess the clock", est["offset_s"] is None, est)
dry = tracks.geotag(3600, dry_run=True)
check("the dry run finds the camera shot", dry["placed"] == 1 and dry["samples"][0]["id"] == camera, dry)
check("and changes nothing", conn.execute("SELECT lat FROM photos WHERE id=?", (camera,)).fetchone()["lat"] is None)
wrong = tracks.geotag(-5 * 3600, dry_run=True)
check("the wrong offset finds nothing", wrong["placed"] == 0, wrong)
done = tracks.geotag(3600, dry_run=False)
row = conn.execute("SELECT lat, lon, gps_method FROM photos WHERE id=?", (camera,)).fetchone()
check("the photo is placed between two points", row["gps_method"] == "TRACK"
      and ZURICH[0] + 0.01 < row["lat"] < ZURICH[0] + 0.02, dict(row))
check("and kept across a rescan", conn.execute(
    "SELECT method FROM location_fixes WHERE path=?", (f"/p/{camera}.jpg",)).fetchone()["method"] == "TRACK")
check("track filter", main.list_photos(request(gps="track"))["total"] == 1)

# Three phone photos on the track, their clocks on UTC+1: enough to work the
# offset out, and the nearest fit must win over the ones merely within 1 km.
for k, (dt, dlat) in enumerate([(-600, 0.0), (1200, 0.01), (2400, 0.02)]):
    conn.execute("INSERT INTO photos(id, path, folder, filename, lat, lon, taken_ts) VALUES (?,?,?,?,?,?,?)",
                 (900 + k, f"/p/phone{k}.jpg", "/p", f"phone{k}.jpg", ZURICH[0] + dlat, ZURICH[1], z_utc + dt + 3600))
conn.commit()
est = tracks.estimate_offset()
check("the camera clock is worked out from phone photos", est["offset_s"] == 3600, est)

records = {"locations": [
    {"latitudeE7": 533000000, "longitudeE7": -90000000, "timestamp": "2023-01-01T10:00:00.000Z"},
    {"latitudeE7": 533100000, "longitudeE7": -90100000, "timestampMs": "1672567200000",
     "activity": [{"timestamp": "2023-01-01T10:05:00Z", "activity": []}]},
]}
check("Records.json", len(tracks.parse_json(records)) == 2, tracks.parse_json(records))
semantic = {"timelineObjects": [
    {"placeVisit": {"location": {"latitudeE7": 480000000, "longitudeE7": 20000000},
                    "duration": {"startTimestamp": "2022-05-01T08:00:00Z", "endTimestamp": "2022-05-01T09:00:00Z"}}},
    {"activitySegment": {"startLocation": {"latitudeE7": 480000000, "longitudeE7": 20000000},
                         "endLocation": {"latitudeE7": 481000000, "longitudeE7": 21000000},
                         "duration": {"startTimestamp": "2022-05-01T09:00:00Z", "endTimestamp": "2022-05-01T10:00:00Z"},
                         "simplifiedRawPath": {"points": [{"latE7": 480500000, "lngE7": 20500000, "timestamp": "2022-05-01T09:30:00Z"}]}}},
]}
check("Semantic Location History", len(tracks.parse_json(semantic)) == 5, tracks.parse_json(semantic))
device = {"semanticSegments": [
    {"startTime": "2024-03-01T10:00:00.000+01:00", "endTime": "2024-03-01T11:00:00.000+01:00",
     "timelinePath": [{"point": "53.2720°, -9.0490°", "time": "2024-03-01T10:15:00.000+01:00"}]},
    {"startTime": "2024-03-01T11:00:00+01:00", "endTime": "2024-03-01T12:00:00+01:00",
     "visit": {"topCandidate": {"placeLocation": {"latLng": "53.1°, -9.6°"}}}},
], "rawSignals": [{"position": {"LatLng": "53.0°, -9.0°", "timestamp": "2024-03-01T12:30:00Z"}}]}
pts = tracks.parse_json(device)
check("on-device Timeline", len(pts) == 4, pts)
check("offsets are honoured", pts[0][0] == 1709284500, pts[0])
ios = [{"startTime": "2024-03-01T10:00:00Z", "endTime": "2024-03-01T11:00:00Z",
        "timelinePath": [{"point": "geo:53.27,-9.05", "durationMinutesOffsetFromStartTime": "30"}]},
       {"startTime": "2024-03-01T11:00:00Z", "endTime": "2024-03-01T12:00:00Z",
        "visit": {"topCandidate": {"placeLocation": "geo:53.1,-9.6"}}}]
pts = tracks.parse_json(ios)
check("iPhone Timeline", len(pts) == 3 and pts[0] == (1709289000, 53.27, -9.05), pts)
check("Null Island is not a position", not tracks.parse_json({"locations": [
    {"latitudeE7": 0, "longitudeE7": 0, "timestamp": "2023-01-01T10:00:00Z"}]}))
try:
    tracks.parse("x.json", b"hello")
    check("garbage is refused", False)
except ValueError:
    check("garbage is refused", True)
check("GPX export", "<trkpt" in main.export_tracks().body.decode())

# ------------------------------------------------------------------ export

geo = json.loads(main.export_locations(request(), format="geojson").body)
check("GeoJSON has every located photo", len(geo["features"]) == conn.execute(
    "SELECT COUNT(*) c FROM photos WHERE lat IS NOT NULL").fetchone()["c"])
check("coordinates are lon, lat", geo["features"][0]["geometry"]["coordinates"][:2] == [GALWAY[1], GALWAY[0]])
csv_text = main.export_locations(request(country="FR"), format="csv").body.decode()
check("CSV follows the filters", len(csv_text.strip().splitlines()) == 5, csv_text[:200])

# --------------------------------------------------------- no-location queue

q = main.fix_locations({"ids": [camera + 0], "include_unlocated": True})
check("the queue can fix unlocated photos", q["skipped"] == 1)  # it is located now, by the track

print()
if failures:
    print(f"{len(failures)} FAILED")
    sys.exit(1)
print("all passed")
