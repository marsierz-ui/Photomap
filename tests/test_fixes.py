"""Hand corrections that must survive a rescan: dates of a folder whose camera clock
was never set, and the position of a photo whose own was a cell-tower guess.

    .venv\\Scripts\\python.exe tests\\test_fixes.py
"""
import datetime
import os
import sys
import tempfile
import time
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT))

TMP = Path(tempfile.mkdtemp(prefix="photomap_fix_"))
DATA = TMP / "data"
LIB = TMP / "lib"
DATA.mkdir()

from backend import db  # noqa: E402

db.DATA_DIR = DATA
db.DB_PATH = DATA / "photomap.db"
db.THUMB_DIR = DATA / "thumbs"
db.TRASH_DIR = DATA / "trash"

from PIL import Image  # noqa: E402

from backend import photometa, scanner  # noqa: E402

failures = []


def check(label, condition, detail=""):
    print(f"{'PASS' if condition else 'FAIL'}  {label}{'' if condition else f' -> {detail}'}")
    if not condition:
        failures.append(label)


def dms(value):
    value = abs(value)
    d = int(value)
    m = int((value - d) * 60)
    return (float(d), float(m), round((value - d - m / 60) * 3600, 4))


def photo(path: Path, when: str, lat=None, lon=None, method=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", (8, 8), (90, 120, 150))
    exif = Image.Exif()
    exif[0x8769] = {36867: when}
    if lat is not None:
        gps = {1: "N", 2: dms(lat), 3: "W" if lon < 0 else "E", 4: dms(lon)}
        if method:
            gps[27] = b"ASCII\x00\x00\x00" + method.encode()
        exif[0x8825] = gps
    img.save(path, "JPEG", exif=exif.tobytes())
    return str(path)


db.init()
conn = db.connect()


def index(*paths):
    now = int(time.time())
    with db.write_lock:
        for p in paths:
            scanner.upsert(conn, photometa.read(p), now)
        conn.commit()


def row(p):
    return conn.execute("SELECT * FROM photos WHERE path=?", (p,)).fetchone()


# ------------------------------------------------------------ position method
cell = photo(LIB / "a" / "cell.jpg", "2026:08:22 13:16:01", 52.63, -9.6, "CELLID")
gps = photo(LIB / "a" / "gps.jpg", "2026:08:22 13:20:00", 53.12, -9.7, "GPS")
bare = photo(LIB / "a" / "bare.jpg", "2026:08:22 13:25:00", 53.1, -9.7)
index(cell, gps, bare)

check("a cell-tower fix is recorded as such", row(cell)["gps_method"] == "CELLID", row(cell)["gps_method"])
check("a satellite fix is recorded as such", row(gps)["gps_method"] == "GPS", row(gps)["gps_method"])
check("a photo with no method tag has none", row(bare)["gps_method"] is None)
check("the approximate set names the tower guesses",
      {"CELLID", "NETWORK", "WIFI"} <= set(photometa.APPROX_METHODS))

# ------------------------------------------------------ a position set by hand
conn.execute("INSERT OR REPLACE INTO location_fixes(path, lat, lon) VALUES (?,?,?)", (cell, 53.12, -9.69))
conn.commit()
index(cell)  # a rescan reads the file again, and the file still has the wrong one
fixed = row(cell)
check("a rescan keeps the position set by hand",
      abs(fixed["lat"] - 53.12) < 1e-6 and abs(fixed["lon"] + 9.69) < 1e-6, f"{fixed['lat']}, {fixed['lon']}")
check("and marks it as set by hand, so it is no longer filtered as approximate",
      fixed["gps_method"] == "MANUAL", fixed["gps_method"])

# ------------------------------------------------------------ a folder's dates
trip = LIB / "trip"
real = photo(trip / "real.jpg", "2018:06:20 10:00:00")
early = [
    photo(trip / "sub" / "one.jpg", "2001:02:17 02:30:00"),
    photo(trip / "sub" / "two.jpg", "2001:02:17 17:16:00"),
    photo(trip / "three.jpg", "2001:02:19 13:09:00"),
]
index(real, *early)
before = {p: row(p)["taken_ts"] for p in early}

result = scanner.shift_dates(conn, str(trip), "2018-06-15")
day = lambda p: datetime.datetime.fromtimestamp(row(p)["taken_ts"], datetime.UTC)  # noqa: E731
check("the first photo's day becomes the day given", day(early[0]).date().isoformat() == "2018-06-15",
      str(day(early[0])))
check("its time of day is kept", (day(early[0]).hour, day(early[0]).minute) == (2, 30), str(day(early[0])))
check("the gaps between photos are kept",
      row(early[2])["taken_ts"] - row(early[0])["taken_ts"] == before[early[2]] - before[early[0]])
check("photos in subfolders move too", day(early[1]).date().isoformat() == "2018-06-15", str(day(early[1])))
check("a photo with a real date in the same folder does not move",
      row(real)["taken_ts"] == photometa.wall_ts(datetime.datetime(2018, 6, 20, 10, 0, 0)))
check("they are marked as set by hand", row(early[0])["taken_src"] == "manual")
check("it says how many moved", result["moved"] == 3, str(result))

# a rescan reads the camera's clock again, and must land in the same place
index(*early)
check("a rescan puts the shifted date back, not the camera's",
      day(early[0]).date().isoformat() == "2018-06-15", str(day(early[0])))
index(*early)
check("and doing it twice does not move it twice",
      day(early[0]).date().isoformat() == "2018-06-15", str(day(early[0])))
check("the real photo is still untouched after the rescan",
      day(real).date().isoformat() == "2018-06-20", str(day(real)))

# a folder with the same prefix in its name is a different folder
other = photo(LIB / "trip2" / "x.jpg", "2001:02:17 02:30:00")
index(other)
check("a folder that merely starts with the same letters is not shifted",
      day(other).year == 2001, str(day(other)))

print()
print(f"{len(failures)} FAILED" if failures else "ALL FIX CHECKS PASSED")
sys.exit(1 if failures else 0)
