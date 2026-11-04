"""How the index holds up at 100,000 photos (or as many as asked for).

Builds a synthetic library in a temporary folder - a home cluster, a few
hundred trips, some photos with no position - and times the requests the map,
trips and insights make. With --serve PORT it then keeps a server running on
that library, for timing the browser side by hand or with Playwright.

    .venv\\Scripts\\python.exe tests\\bench_large.py
    .venv\\Scripts\\python.exe tests\\bench_large.py --photos 250000 --serve 8799
"""
import argparse
import random
import sys
import tempfile
import time
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT))

parser = argparse.ArgumentParser()
parser.add_argument("--photos", type=int, default=100_000)
parser.add_argument("--serve", type=int, default=0)
parser.add_argument("--places", help="a GeoNames places.tsv, to time place naming too")
args = parser.parse_args()

TMP = Path(tempfile.mkdtemp(prefix="photomap_bench_"))
DATA = TMP / "data"
DATA.mkdir()

from backend import db  # noqa: E402

db.DATA_DIR = DATA
db.DB_PATH = DATA / "photomap.db"
db.THUMB_DIR = DATA / "thumbs"
db.TRASH_DIR = DATA / "trash"

from backend import geocode  # noqa: E402

geocode.DIR = DATA / "geonames"
geocode.PLACES = geocode.DIR / "places.tsv"
geocode.DIR.mkdir()
default_places = PROJECT / "data" / "geonames" / "places.tsv"
source = Path(args.places) if args.places else default_places
if source.exists():
    geocode.PLACES.write_bytes(source.read_bytes())

from starlette.requests import Request  # noqa: E402

from backend import main, trips  # noqa: E402

random.seed(7)
HOME = (53.2720, -9.0490)
CITIES = [(48.8566, 2.3522), (41.9028, 12.4964), (40.4168, -3.7038), (52.52, 13.405), (51.5074, -0.1278),
          (40.7128, -74.006), (35.6762, 139.6503), (-33.8688, 151.2093), (38.7223, -9.1393), (59.3293, 18.0686),
          (45.4642, 9.19), (50.0755, 14.4378), (64.1466, -21.9426), (37.9838, 23.7275), (55.6761, 12.5683)]
T0 = 1_262_304_000  # 2010-01-01

rows = []
n = args.photos
day = 0
pid = 0
while pid < n:
    day += random.randint(1, 3)
    if random.random() < 0.06:  # a trip
        city = random.choice(CITIES)
        for d in range(random.randint(2, 12)):
            for _ in range(random.randint(10, 60)):
                pid += 1
                lat = city[0] + random.gauss(0, 0.05)
                lon = city[1] + random.gauss(0, 0.05)
                rows.append((pid, lat, lon, T0 + (day + d) * 86400 + random.randint(28_000, 80_000)))
        day += 12
    else:
        for _ in range(random.randint(1, 25)):
            pid += 1
            nogps = random.random() < 0.08
            lat = None if nogps else HOME[0] + random.gauss(0, 0.03)
            lon = None if nogps else HOME[1] + random.gauss(0, 0.03)
            rows.append((pid, lat, lon, T0 + day * 86400 + random.randint(28_000, 80_000)))
rows = rows[:n]

conn = db.connect()
t = time.perf_counter()
conn.executemany(
    "INSERT INTO photos(id, path, folder, filename, lat, lon, taken_ts, filesize, camera_make, camera_model)"
    " VALUES (?,?,?,?,?,?,?,?,?,?)",
    [(i, f"/lib/{i // 1000}/IMG_{i}.jpg", f"/lib/{i // 1000}", f"IMG_{i}.jpg", lat, lon, ts,
      3_000_000, "Phone", "X") for i, lat, lon, ts in rows],
)
conn.commit()
print(f"{len(rows):,} photos inserted in {time.perf_counter() - t:.1f} s ({DATA})")


def request(**query):
    qs = "&".join(f"{k}={v}" for k, v in query.items()).encode()
    return Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": qs})


def timed(label, fn, budget):
    t = time.perf_counter()
    out = fn()
    ms = (time.perf_counter() - t) * 1000
    flag = "ok  " if ms <= budget else "SLOW"
    print(f"{flag} {label:<38} {ms:8.0f} ms   (budget {budget} ms)")
    return out


if geocode.available():
    timed("name every photo (first run)", geocode.fill, 120_000)
pts = timed("map points, everything", lambda: main.points(request()), 1500)
timed("map points, one year", lambda: main.points(request(**{"from": T0 + 365 * 86400, "to": T0 + 730 * 86400})), 500)
timed("timeline", lambda: main.timeline(request()), 800)
timed("stats", lambda: main.stats(request()), 800)
timed("countries", lambda: main.countries(request()), 800)
res = timed("trips", lambda: trips.compute(), 3000)
print(f"     {len(res['items'])} trips found")
timed("gallery page", lambda: main.list_photos(request(), limit=200), 300)
timed("no-location gallery page", lambda: main.list_photos(request(gps="no"), limit=200), 300)
timed("search by place", lambda: main.list_photos(request(q="Paris"), limit=200), 1500)
place = main.create_place({"name": "Home", "lat": HOME[0], "lon": HOME[1], "radius_m": 5000, "is_home": True})
timed("saved place counts", main.list_places, 500)
timed("photos at a saved place", lambda: main.list_photos(request(near=place["id"]), limit=200), 500)
timed("export GeoJSON, everything", lambda: main.export_locations(request()), 6000)
print(f"\nPayload for the map: {len(pts.body) / 1e6:.1f} MB for {pts.body.count(b',') // 4:,} points")

if args.serve:
    import uvicorn
    print(f"\nServing on http://127.0.0.1:{args.serve}/ - Ctrl+C to stop")
    uvicorn.run(main.app, host="127.0.0.1", port=args.serve, log_level="warning")
