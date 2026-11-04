"""Town ranges, the home timeline, trip detail with travel modes, and fitness
activity import (GPX, TCX, FIT, gzipped, Strava zip).

    .venv\\Scripts\\python.exe tests\\test_homeline.py
"""
import gzip
import json
import io
import struct
import sys
import tempfile
import zipfile
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT))

TMP = Path(tempfile.mkdtemp(prefix="photomap_home_"))
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
    "Dublin\t53.34399\t-6.26719\tIE\tLeinster\t1024027",
    "Paris\t48.85341\t2.3488\tFR\tÎle-de-France\t2138551",
    "Lyon\t45.74846\t4.84671\tFR\tAuvergne-Rhône-Alpes\t472317",
    "Tinyville\t50.0\t10.0\tDE\tBavaria\t300",
]), encoding="utf-8")

from backend import activities, home, main, trips  # noqa: E402

failures = []


def check(label, condition, detail=""):
    print(f"{'PASS' if condition else 'FAIL'}  {label}{'' if condition else f' -> {detail}'}")
    if not condition:
        failures.append(label)


def request(**query):
    qs = "&".join(f"{k}={v}" for k, v in query.items()).encode()
    return Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": qs})


# ------------------------------------------------------------- town ranges

check("village range is about 3 km", 3.0 < geocode.range_km(300) < 3.5, geocode.range_km(300))
check("a million-person city reaches further", 12 < geocode.range_km(1_000_000) < 14)
check("inside a village's range", geocode.lookup(50.01, 10.0) == ("Tinyville, Bavaria", "DE"))
outside = geocode.lookup(50.08, 10.0)  # ~9 km out
check("outside every range keeps only the country", outside == ("", "DE"), outside)
check("a city's outskirts are the city", geocode.lookup(53.40, -6.40)[0].startswith("Dublin"))

# ------------------------------------------------------------ photos

DAY = 86400
T0 = 1_700_006_400 - (1_700_006_400 % DAY)
GALWAY = (53.2720, -9.0490)
DUBLIN = (53.3440, -6.2670)
PARIS = (48.8534, 2.3488)
LYON = (45.7485, 4.8467)

conn = db.connect()
rows = []


def photo(day, hour, at):
    pid = len(rows) + 1
    rows.append((pid, f"/p/{pid}.jpg", "/p", f"{pid}.jpg", at[0] if at else None, at[1] if at else None,
                 T0 + day * DAY + hour * 3600))
    return pid


# Lived in Galway for days 0-99, then moved to Dublin.
for d in range(0, 100, 3):
    photo(d, 12, GALWAY)
for d in range(100, 200, 3):
    photo(d, 12, DUBLIN)
# A visit to Galway after the move: a trip now, not home.
photo(151, 12, GALWAY)
photo(152, 12, GALWAY)
# Paris and Lyon by bike, days 170-172.
photo(170, 9, PARIS)
photo(170, 15, PARIS)
photo(171, 18, LYON)
photo(172, 10, LYON)
unlocated = [photo(173, 10, None), photo(5, 10, None)]
conn.executemany("INSERT INTO photos(id, path, folder, filename, lat, lon, taken_ts) VALUES (?,?,?,?,?,?,?)", rows)
conn.commit()

ids = main.photo_ids(request(gps="no"), sort="date_asc")["ids"]
check("unlocated queue runs oldest first", ids == [unlocated[1], unlocated[0]], ids)

# ----------------------------------------------------------- home timeline

before = main.list_trips()
check("no timeline set yet", not before["timeline_set"])
suggested = main.home_timeline()["suggested"]
check("the move is suggested", [round(x["lat"], 1) for x in suggested] == [53.3, 53.3] and len(suggested) == 2, suggested)

iso = lambda day: __import__("datetime").date.fromtimestamp(T0 + day * DAY).isoformat()  # noqa: E731
main.save_home_timeline({"items": [
    {"since": iso(0), "name": "Galway", "lat": GALWAY[0], "lon": GALWAY[1]},
    {"since": iso(100), "name": "Dublin", "lat": DUBLIN[0], "lon": DUBLIN[1]},
]})
res = main.list_trips()
check("timeline is used", res["timeline_set"] and res["home"]["name"] == "Dublin", res["home"])
starts = sorted((t["start_ts"] - T0) // DAY for t in res["items"])
check("home before the move is not a trip, Galway after it is", starts == [151, 170], starts)
try:
    main.save_home_timeline({"items": [{"since": "nope", "lat": 1, "lon": 1}]})
    check("a bad date is refused", False)
except Exception:
    check("a bad date is refused", True)

# ------------------------------------------------------------- activities

def gpx_ride():
    pts = []
    for i in range(0, 121):
        lat = PARIS[0] + i * 0.0005
        ele = 100 + (i % 20) * 1.0
        pts.append((lat, ele))
    base = T0 + 170 * DAY + 10 * 3600 - 3600  # 10:00 wall clock at UTC+1
    import datetime as dt
    body = "".join(
        f'<trkpt lat="{lat}" lon="{PARIS[1]}"><ele>{ele}</ele>'
        f'<time>{dt.datetime.fromtimestamp(base + i * 10, dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")}</time>'
        f'<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>{120 + i % 10}</gpxtpx:hr>'
        f'</gpxtpx:TrackPointExtension></extensions></trkpt>'
        for i, (lat, ele) in enumerate(pts))
    return (f'<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1" '
            f'xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"><trk>'
            f'<name>Morning Ride</name><type>cycling</type><trkseg>{body}</trkseg></trk></gpx>').encode()


res = activities.import_file("ride.gpx", gpx_ride())
ride = res["items"][0]
check("GPX activity imported", ride["sport"] == "cycling" and ride["name"] == "Morning Ride", ride)
check("distance derived", 6000 < ride["distance_m"] < 7000, ride["distance_m"])
check("heart rate averaged", 120 <= ride["avg_hr"] <= 130, ride["avg_hr"])
check("moving time derived", 1150 <= ride["moving_s"] <= 1210, ride["moving_s"])
check("stored as a track too", ride["track_id"] is not None)
check("local day from longitude", ride["local_ts"] // DAY == T0 // DAY + 170, (ride["local_ts"] - T0) / DAY)
again = activities.import_file("ride.gpx", gpx_ride())
check("re-import is skipped", not again["items"] and again["duplicates"] == 1, again)

TCX = f"""  <?xml version="1.0"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
<Activities><Activity Sport="Running"><Id>2023-01-01T08:00:00Z</Id>
<Lap StartTime="2023-01-01T08:00:00Z"><TotalTimeSeconds>600</TotalTimeSeconds><DistanceMeters>2000</DistanceMeters>
<Calories>150</Calories><Track>
<Trackpoint><Time>2023-01-01T08:00:00Z</Time><Position><LatitudeDegrees>53.27</LatitudeDegrees><LongitudeDegrees>-9.05</LongitudeDegrees></Position><HeartRateBpm><Value>140</Value></HeartRateBpm></Trackpoint>
<Trackpoint><Time>2023-01-01T08:10:00Z</Time><Position><LatitudeDegrees>53.28</LatitudeDegrees><LongitudeDegrees>-9.05</LongitudeDegrees></Position><HeartRateBpm><Value>160</Value></HeartRateBpm></Trackpoint>
</Track></Lap></Activity></Activities></TrainingCenterDatabase>""".encode()
run = activities.import_file("run.tcx.gz", gzip.compress(TCX))["items"][0]
check("gzipped TCX imported", run["sport"] == "running" and run["distance_m"] == 2000 and run["calories"] == 150, run)
check("TCX heart rate", run["avg_hr"] == 150, run["avg_hr"])


def fit_file(start_utc, n=60):
    """A minimal FIT: one record definition, n records, one session."""
    out = bytearray()
    # definition: local 0 -> record (20): timestamp, lat, lon, enhanced altitude, heart rate
    out += bytes([0x40, 0, 0]) + struct.pack("<H", 20) + bytes([5])
    out += bytes([253, 4, 0x86, 0, 4, 0x85, 1, 4, 0x85, 78, 4, 0x86, 3, 1, 0x02])
    semi = lambda deg: int(deg / (180 / 2 ** 31))  # noqa: E731
    for i in range(n):
        out += bytes([0x00]) + struct.pack("<IiiIB", start_utc - activities.FIT_EPOCH + i * 5,
                                           semi(LYON[0] + i * 0.0002), semi(LYON[1]), (200 + 500) * 5, 110)
    # definition: local 1 -> session (18): sport, total_distance, total_ascent, total_timer_time
    out += bytes([0x41, 0, 0]) + struct.pack("<H", 18) + bytes([4])
    out += bytes([5, 1, 0x00, 9, 4, 0x86, 22, 2, 0x84, 8, 4, 0x86])
    out += bytes([0x01]) + struct.pack("<BIHI", 2, 1234500, 321, 900000)
    header = struct.pack("<BBHI4s", 12, 0x10, 2100, len(out), b".FIT")
    return header + bytes(out) + b"\x00\x00"


fit_start = T0 + 171 * DAY + 8 * 3600
strava = io.BytesIO()
with zipfile.ZipFile(strava, "w") as z:
    z.writestr("activities.csv", "Activity ID,Activity Date,Activity Name,Activity Type,Filename\n"
                                  "1,x,Lyon loop,Ride,activities/1.fit.gz\n")
    z.writestr("activities/1.fit.gz", gzip.compress(fit_file(fit_start)))
    z.writestr("activities/broken.fit", b"garbage")
res = activities.import_file("export.zip", strava.getvalue())
fit = res["items"][0] if res["items"] else {}
check("Strava zip: FIT read, name and type from the CSV",
      fit.get("name") == "Lyon loop" and fit.get("sport") == "cycling", fit)
check("FIT session totals used", fit.get("distance_m") == 12345 and fit.get("ascent_m") == 321
      and fit.get("moving_s") == 900, fit)
check("FIT heart rate from records", fit.get("avg_hr") == 110, fit.get("avg_hr"))
check("FIT positions decoded", abs(activities.route(fit)[0][0] - LYON[0]) < 1e-4, activities.route(fit)[:1])

# ------------------------------------------------------------------ watches

import datetime as _dt  # noqa: E402

walk_day = _dt.date.fromtimestamp(T0 + 170 * DAY).isoformat()
apple_xml = f"""<?xml version="1.0"?><HealthData>
<Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" value="6000"
  startDate="{walk_day} 09:00:00 +0100" endDate="{walk_day} 10:00:00 +0100"/>
<Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" value="4000"
  startDate="{walk_day} 15:00:00 +0100" endDate="{walk_day} 16:00:00 +0100"/>
<Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" value="12000"
  startDate="{walk_day} 09:00:00 +0100" endDate="{walk_day} 18:00:00 +0100"/>
<Record type="HKQuantityTypeIdentifierDistanceWalkingRunning" sourceName="Watch" unit="km" value="9.5"
  startDate="{walk_day} 09:00:00 +0100" endDate="{walk_day} 18:00:00 +0100"/>
<Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="90" durationUnit="min"
  startDate="{walk_day} 11:00:00 +0100" endDate="{walk_day} 12:40:00 +0100">
  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="6.2" unit="km"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="101" maximum="130" unit="count/min"/>
</Workout>
</HealthData>"""
health = io.BytesIO()
with zipfile.ZipFile(health, "w") as z:
    z.writestr("apple_health_export/export.xml", apple_xml)
res = activities.import_file("export.zip", health.getvalue())
walk = res["items"][0] if res["items"] else {}
check("Apple workout without a route is kept", walk.get("sport") == "walking" and walk.get("distance_m") == 6200
      and walk.get("moving_s") == 5400 and walk.get("avg_hr") == 101 and walk.get("track_id") is None, walk)
check("Apple workout keeps its own local time",
      walk.get("local_ts", 0) - T0 - 170 * DAY == 11 * 3600, (walk.get("local_ts", 0) - T0) / 3600)
daily = activities.daily_between(walk_day, walk_day).get(walk_day, {})
check("phone and watch are not added up", daily.get("steps") == 12000 and daily.get("distance_m") == 9500, daily)

fit_csv = "Date,Move Minutes count,Calories (kcal),Distance (m),Step count\n2020-05-01,50,300,4321.5,7000\n"
res = activities.import_file("Daily activity metrics.csv", fit_csv.encode())
check("Google Fit daily CSV", res["days"] == 1 and activities.daily_between("2020-05-01", "2020-05-01")
      ["2020-05-01"] == {"steps": 7000, "distance_m": 4321.5}, res)
garmin = b'[{"calendarDate": "2020-05-02", "totalSteps": 9000, "totalDistanceMeters": 7000}]'
res = activities.import_file("UDSFile_2020.json", garmin)
check("Garmin daily JSON", activities.daily_between("2020-05-02", "2020-05-02")["2020-05-02"]["steps"] == 9000, res)

# -------------------------------------------------------------- trip detail

paris_trip = next(t for t in main.list_trips()["items"] if (t["start_ts"] - T0) // DAY == 170)
d = main.trip_detail(paris_trip["key"])
check("detail has a day per calendar day", [x["day"] - T0 // DAY for x in d["days_detail"]] == [170, 171, 172])
check("leg from home is added", d["legs"][0]["assumed"] and d["legs"][0]["from"] == "Dublin", d["legs"][0])
paris_lyon = next(leg for leg in d["legs"] if leg["from"].startswith("Paris") and leg["to"].startswith("Lyon"))
check("Paris to Lyon is a leg", 380 < paris_lyon["km"] < 410, paris_lyon)
check("a ride that day makes it a bike leg", paris_lyon["mode"] == "bike" and paris_lyon["mode_src"] == "activity",
      paris_lyon)
check("activities listed with routes", len(d["activities"]) == 3 and d["activities"][0]["route"], len(d["activities"]))
check("steps and walking per day", d["days_detail"][0]["steps"] == 12000 and d["days_detail"][0]["walk_km"] == 9.5,
      d["days_detail"][0])
day171 = d["days_detail"][1]
check("day stats include the FIT ride", day171["act_km"] == 12.3 and day171["act_ascent_m"] == 321, day171)

main.trip_modes(paris_trip["key"], {"trip": "train", "legs": {d["legs"][0]["id"]: "plane"}})
d = main.trip_detail(paris_trip["key"])
check("chosen leg mode wins", d["legs"][0]["mode"] == "plane" and d["legs"][0]["mode_src"] == "chosen")
check("trip mode fills the rest", d["legs"][-1]["mode"] == "train", d["legs"][-1])
check("km by mode", d["km_by_mode"].get("plane", 0) > 700, d["km_by_mode"])
try:
    main.trip_modes(paris_trip["key"], {"trip": "rocket"})
    check("unknown mode refused", False)
except Exception:
    check("unknown mode refused", True)

check("deleting an activity removes its track", activities.delete(fit["id"])
      and not db.connect().execute("SELECT 1 FROM tracks WHERE id=?", (fit["track_id"],)).fetchone())

# --------------------------------------------------------------------- music

from backend import music  # noqa: E402

music.init_schema()
paris_photo = next(r[0] for r in rows if r[4] == PARIS[0] and r[6] == T0 + 170 * DAY + 15 * 3600)
utc_then = T0 + 170 * DAY + 15 * 3600  # Paris, longitude 2.35: offset guessed as 0
iso_z = lambda ts: _dt.datetime.fromtimestamp(ts, _dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")  # noqa: E731
extended = [
    {"ts": iso_z(utc_then + 60), "ms_played": 200_000, "master_metadata_track_name": "La Vie en rose",
     "master_metadata_album_artist_name": "Edith Piaf", "master_metadata_album_album_name": "Best of",
     "spotify_track_uri": "spotify:track:abc"},
    {"ts": iso_z(utc_then - 4000), "ms_played": 240_000, "master_metadata_track_name": "Song B",
     "master_metadata_album_artist_name": "Band", "spotify_track_uri": "spotify:track:b"},
    {"ts": iso_z(utc_then - 2000), "ms_played": 240_000, "master_metadata_track_name": "Song B",
     "master_metadata_album_artist_name": "Band", "spotify_track_uri": "spotify:track:b"},
    {"ts": iso_z(utc_then - 100), "ms_played": 5_000, "master_metadata_track_name": None,
     "episode_name": "A podcast"},
]
basic = [{"endTime": _dt.datetime.fromtimestamp(utc_then - 4000, _dt.UTC).strftime("%Y-%m-%d %H:%M"),
          "artistName": "Band", "trackName": "Song C", "msPlayed": 100_000}]
spotify = io.BytesIO()
with zipfile.ZipFile(spotify, "w") as z:
    z.writestr("Spotify Extended Streaming History/Streaming_History_Audio_2023.json", json.dumps(extended))
    z.writestr("Spotify Account Data/StreamingHistory_music_0.json", json.dumps(basic))
res = music.import_file("my_spotify_data.zip", spotify.getvalue())
check("Spotify zip: plays read, podcast skipped", res["read"] == 4 and res["playable"] == 3, res)
again = music.import_file("my_spotify_data.zip", spotify.getvalue())
check("re-import adds nothing", again["added"] == 0, again)
m = main.photo_music(paris_photo)
check("the song playing when the photo was taken", m["now"] and m["now"]["track"] == "La Vie en rose", m["now"])
check("the day's most played comes first", [x["track"] for x in m["day"]][:2] == ["Song B", "La Vie en rose"],
      m["day"])

# ------------------------------------------------------------------- borders

from backend import borders  # noqa: E402

borders.init_schema()
# What Overpass answered for Lyon and Galway, trimmed to the tags used.
LYON_AREAS = [
    {"name": "Lyon", "name:en": "Lyon", "admin_level": "8", "boundary": "administrative"},
    {"name": "Lyon", "admin_level": "7", "boundary": "administrative"},
    {"name": "France", "admin_level": "2", "boundary": "administrative", "ISO3166-1:alpha2": "FR"},
    {"name": "Auvergne-Rhône-Alpes", "admin_level": "4", "boundary": "administrative"},
]
GALWAY_AREAS = [
    {"name": "Éire / Ireland", "admin_level": "2", "boundary": "administrative", "ISO3166-1:alpha2": "IE"},
    {"name": "Cathair na Gaillimhe", "name:en": "Galway", "admin_level": "7", "place": "city",
     "boundary": "administrative"},
    {"name": "Galway Municipal District", "name:en": "Galway City", "admin_level": "8", "boundary": "administrative"},
]
picked = borders.choose(GALWAY_AREAS)
check("a settlement area beats the municipality", picked["town"]["name"] == "Cathair na Gaillimhe"
      and picked["cc"] == "IE", picked)
check("most local municipality without one", borders.choose(LYON_AREAS)["town"]["name"] == "Lyon")

sent = []


def fake_post(query):
    sent.append(query)
    elements = []
    for i, part in enumerate(query.split("is_in(")[1:]):
        lat, lon = (float(x) for x in part.split(")")[0].split(","))
        elements.append({"type": "cell", "tags": {"idx": str(i)}})
        if abs(lat - 45.75) < 0.1 and abs(lon - 4.85) < 0.1:
            elements += [{"type": "area", "tags": t} for t in LYON_AREAS]
        elif abs(lat - 53.27) < 0.1 and abs(lon + 9.05) < 0.1:
            elements += [{"type": "area", "tags": t} for t in GALWAY_AREAS]
    return {"elements": elements}


borders._post = fake_post
borders.PAUSE_S = 0
db.set_setting("place_borders", "1")
borders.fill()
check("one request covers the cells", len(sent) == 1 and sent[0].count("is_in(") == borders.status()["cells"],
      len(sent))
check("nothing left to ask", borders.status()["pending"] == 0, borders.status())
check("inside a border: named by it, region from GeoNames", geocode.lookup(*GALWAY) == ("Cathair na Gaillimhe, Connacht", "IE"),
      geocode.lookup(*GALWAY))
db.set_setting("place_lang", "en")
check("named in the chosen language", geocode.lookup(*GALWAY)[0].startswith("Galway,"), geocode.lookup(*GALWAY))
check("region from OSM when it has one", geocode.lookup(*LYON)[0] == "Lyon, Auvergne-Rhône-Alpes",
      geocode.lookup(*LYON))
check("no border known: the range rule", geocode.lookup(*DUBLIN)[0].startswith("Dublin"), geocode.lookup(*DUBLIN))
borders.fill()
check("cells are asked about once", len(sent) == 1, len(sent))
db.set_setting("place_borders", "0")
check("turned off: the range rule again", geocode.lookup(*GALWAY)[0].startswith("Galway, Connacht"),
      geocode.lookup(*GALWAY))

# ------------------------------------------------------------ places visited

geocode.rename()
geocode.fill()
france = next(t for t in main.list_trips()["items"] if (t["start_ts"] - T0) // DAY == 170)
check("a trip lists the places it reached, in order",
      [v["name"] for v in france["visited"]] == ["Paris", "Lyon"]
      and [v["photos"] for v in france["visited"]] == [2, 2], france["visited"])

print()
print("FAILED:" if failures else "All passed.", ", ".join(failures))
sys.exit(1 if failures else 0)
