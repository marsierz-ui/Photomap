"""Weather for photos: caching by cell and day, stretches of days per request,
and the opt-in switch. The network is stubbed out.

    .venv\\Scripts\\python.exe tests\\test_weather.py
"""
import calendar
import datetime
import sys
import tempfile
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT))

TMP = Path(tempfile.mkdtemp(prefix="photomap_weather_"))
DATA = TMP / "data"
DATA.mkdir()

from backend import db  # noqa: E402

db.DATA_DIR = DATA
db.DB_PATH = DATA / "photomap.db"
db.THUMB_DIR = DATA / "thumbs"
db.TRASH_DIR = DATA / "trash"
db.init()

from backend import weather  # noqa: E402

weather.init_schema()

calls = []


def fake_fetch(cell, start, end):
    calls.append((cell, start, end))
    out = {}
    day = datetime.date.fromisoformat(start)
    while day <= datetime.date.fromisoformat(end):
        hours = {f"{h:02d}": {"temperature_2m": 10 + h, "weather_code": 61 if h == 15 else 0,
                              "precipitation": 1.2 if h == 15 else 0, "rain": 1.2 if h == 15 else 0,
                              "snowfall": 0, "cloud_cover": 90 if h == 15 else 5, "wind_speed_10m": 12,
                              "relative_humidity_2m": 70, "is_day": 1 if 7 <= h <= 19 else 0}
                 for h in range(24)}
        out[day.isoformat()] = {"hours": hours, "sunrise": f"{day}T06:40", "sunset": f"{day}T19:50",
                                "utc_offset": 3600}
        day += datetime.timedelta(days=1)
    return out


weather._fetch = fake_fetch


def ts(y, m, d, h):
    return calendar.timegm((y, m, d, h, 0, 0))


conn = db.connect()
rows = [
    (1, 53.27, -9.05, ts(2023, 6, 1, 15)),
    (2, 53.28, -9.04, ts(2023, 6, 1, 9)),   # same cell, same day: no second request
    (3, 53.27, -9.05, ts(2023, 6, 4, 15)),  # same cell, three days on: one stretch
    (4, 48.58, 7.74, ts(2023, 6, 2, 15)),   # another cell
    (5, None, None, ts(2023, 6, 2, 15)),    # no position
]
for pid, lat, lon, taken in rows:
    conn.execute("INSERT INTO photos(id, path, folder, filename, lat, lon, taken_ts) VALUES (?,?,?,?,?,?,?)",
                 (pid, f"/p/{pid}.jpg", "/p", f"{pid}.jpg", lat, lon, taken))
conn.commit()

# Off by default: nothing is fetched.
assert weather.for_photo(1)["reason"] == "disabled"
assert not calls

db.set_setting("weather_enabled", "1")
w = weather.for_photo(1)["weather"]
assert w["label"] == "Light rain" and w["sky"] == "rain" and w["temp"] == 25, w
assert weather.for_photo(2)["weather"]["sky"] == "clear"
assert len(calls) == 1, calls
assert weather.for_photo(5)["reason"] == "no_position"

calls.clear()
weather.fill()
# Photo 3's day is fetched alone (photos 1-2 are done), photo 4's cell once.
assert len(calls) == 2, calls
assert weather.status()["pending"] == 0, weather.status()
assert weather.for_photo(3)["weather"]["code"] == 61
assert weather.for_photo(4)["weather"]["sunset"].endswith("19:50")

# Moving a photo makes it stale again.
conn.execute("UPDATE photos SET lat=40.0, lon=-3.7 WHERE id=1")
conn.commit()
assert weather.status()["pending"] == 1
calls.clear()
weather.for_photo(1)
assert len(calls) == 1 and calls[0][0] == (40.0, -3.75), calls

assert weather._runs(["2023-01-01", "2023-01-05", "2023-03-01"]) == [
    ("2023-01-01", "2023-01-05"), ("2023-03-01", "2023-03-01")]

print("weather: ok")
