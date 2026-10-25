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

# ------------------------------------------------------ anchoring on a real day
# A few strays long before the trip would drag it with them if the earliest photo
# were the anchor, so the day that really was the first day can be named.
school = LIB / "school"
stray = photo(school / "stray.jpg", "2000:01:03 21:27:00")
day1 = photo(school / "d1.jpg", "2000:01:21 09:00:00")
day3 = photo(school / "d3.jpg", "2000:01:23 18:00:00")
index(stray, day1, day3)
scanner.shift_dates(conn, str(school), "2021-09-27", from_day="2000-01-21")
check("the named clock day lands on the real day", day(day1).date().isoformat() == "2021-09-27",
      str(day(day1)))
check("the rest of the trip follows it", day(day3).date().isoformat() == "2021-09-29", str(day(day3)))
check("a stray moves by the same offset rather than anchoring the trip",
      day(stray).date().isoformat() == "2021-09-09", str(day(stray)))
index(stray, day1, day3)
check("and a rescan keeps that", day(day1).date().isoformat() == "2021-09-27", str(day(day1)))

# --------------------------------------------- copying positions in bulk, 2 hours
from backend import main  # noqa: E402

batch = LIB / "batch"
real1 = photo(batch / "real1.jpg", "2026:09:01 13:20:00", 53.12, -9.70, "GPS")
near = photo(batch / "near.jpg", "2026:09:01 13:50:00", 52.0, -9.0, "CELLID")        # 30 min from real1
chain = photo(batch / "chain.jpg", "2026:09:01 15:30:00", 52.0, -9.0, "CELLID")      # 2h10 from real1
alone = photo(batch / "alone.jpg", "2026:09:01 20:00:00", 52.0, -9.0, "CELLID")      # hours from any fix
steady = photo(batch / "steady.jpg", "2026:09:01 22:30:00", 53.2, -9.8, "GPS")       # not a tower guess, and 2.5 h from the next
index(real1, near, chain, alone, steady)
ids = [row(p)["id"] for p in (near, chain, alone, steady)]

result = main.fix_locations({"ids": ids})
check("a tower photo within 2 hours of a real fix is fixed", result["fixed"] >= 1, str(result))
check("it takes the position of that photo", abs(row(near)["lat"] - 53.12) < 1e-6, str(row(near)["lat"]))
check("and is tagged as copied from a neighbour", row(near)["gps_method"] == "NEIGHBOUR",
      str(row(near)["gps_method"]))
check("a photo 2h10 from the nearest real fix is left alone", row(chain)["lat"] == 52.0
      and row(chain)["gps_method"] == "CELLID", str(dict(row(chain))))
check("a fix copied onto one photo is not then copied onward to another",
      row(chain)["gps_method"] != "NEIGHBOUR")
check("a photo with no real fix anywhere near is left alone", row(alone)["gps_method"] == "CELLID")
check("a photo that was never a tower guess is not touched",
      row(steady)["lat"] == 53.2 and row(steady)["gps_method"] == "GPS")
check("the counts say what happened",
      (result["fixed"], result["no_neighbour"], result["skipped"]) == (1, 2, 1), str(result))
check("the window is two hours", result["window_hours"] == 2)

index(near)  # the file still says CELLID and the wrong position
check("a rescan keeps the copied position and its tag",
      abs(row(near)["lat"] - 53.12) < 1e-6 and row(near)["gps_method"] == "NEIGHBOUR",
      f"{row(near)['lat']} {row(near)['gps_method']}")

# ------------------------------------------- one position for a whole selection
nowhere = photo(LIB / "multi" / "none.jpg", "2026:10:01 10:00:00")
guessed = photo(LIB / "multi" / "guess.jpg", "2026:10:01 10:05:00", 52.0, -9.0, "CELLID")
wrong = photo(LIB / "multi" / "wrong.jpg", "2026:10:01 10:10:00", 10.0, 10.0, "GPS")
index(nowhere, guessed, wrong)
picked = [row(p)["id"] for p in (nowhere, guessed, wrong)]

result = main.set_locations({"ids": picked + [999999], "lat": 53.12, "lon": -9.7})
check("every selected photo gets the position", result["changed"] == 3, str(result))
check("a photo that had none now has one", abs(row(nowhere)["lat"] - 53.12) < 1e-6)
check("a tower guess is replaced", abs(row(guessed)["lon"] + 9.7) < 1e-6)
check("so is a real fix that was wrong", abs(row(wrong)["lat"] - 53.12) < 1e-6)
check("all are marked as set by hand", {row(p)["gps_method"] for p in (nowhere, guessed, wrong)} == {"MANUAL"})
index(nowhere, guessed, wrong)
check("a rescan keeps it, for a photo that has none in the file as well",
      abs(row(nowhere)["lat"] - 53.12) < 1e-6 and abs(row(guessed)["lat"] - 53.12) < 1e-6)
for bad in ({"lat": 99, "lon": 0}, {"lat": "x", "lon": 0}, {"lon": 0}):
    try:
        main.set_locations({"ids": picked, **bad})
        refused = False
    except Exception:
        refused = True
    check(f"an impossible position {bad} is refused", refused)
try:
    main.set_locations({"ids": [], "lat": 1, "lon": 1})
    refused = False
except Exception:
    refused = True
check("an empty selection is refused", refused)

# ------------------------------------------------------------------- undoing it
u_real = photo(LIB / "undo" / "real.jpg", "2026:11:01 13:20:00", 53.12, -9.70, "GPS")
u_cell = photo(LIB / "undo" / "cell.jpg", "2026:11:01 13:50:00", 52.0, -9.0, "CELLID")
u_none = photo(LIB / "undo" / "none.jpg", "2026:11:01 14:00:00")
u_plain = photo(LIB / "undo" / "plain.jpg", "2026:11:01 14:10:00", 51.0, -8.0, "CELLID")
index(u_real, u_cell, u_none, u_plain)
main.fix_locations({"ids": [row(u_cell)["id"]]})
main.set_locations({"ids": [row(u_none)["id"]], "lat": 50.0, "lon": -7.0})
check("the batch fix did change it", row(u_cell)["gps_method"] == "NEIGHBOUR")

result = main.undo_locations({"ids": [row(p)["id"] for p in (u_cell, u_none, u_plain)]})
check("a copied position goes back to the tower guess in the file",
      row(u_cell)["gps_method"] == "CELLID" and abs(row(u_cell)["lat"] - 52.0) < 1e-6,
      f"{row(u_cell)['gps_method']} {row(u_cell)['lat']}")
check("a position given to a photo with none goes back to none",
      row(u_none)["lat"] is None and row(u_none)["gps_method"] is None)
check("a photo that was never changed is left alone",
      row(u_plain)["gps_method"] == "CELLID" and abs(row(u_plain)["lat"] - 51.0) < 1e-6)
check("the counts say so", (result["restored"], result["unchanged"]) == (2, 1), str(result))
index(u_cell, u_none)
check("and a rescan no longer re-applies it",
      row(u_cell)["gps_method"] == "CELLID" and row(u_none)["lat"] is None)
check("the fix records are gone",
      conn.execute("SELECT COUNT(*) FROM location_fixes WHERE path IN (?,?)",
                   (u_cell, u_none)).fetchone()[0] == 0)

# a second fix on top of a first, then one undo, must reach the file's own value
main.set_locations({"ids": [row(u_cell)["id"]], "lat": 40.0, "lon": -5.0})
main.set_locations({"ids": [row(u_cell)["id"]], "lat": 41.0, "lon": -6.0})
main.undo_locations({"ids": [row(u_cell)["id"]]})
check("two fixes in a row are undone in one step",
      row(u_cell)["gps_method"] == "CELLID" and abs(row(u_cell)["lat"] - 52.0) < 1e-6)
check("the set-by-hand filter finds photos changed by hand",
      conn.execute("SELECT COUNT(*) FROM photos WHERE gps_method='MANUAL'").fetchone()[0] > 0)

# ------------------------------------------------------- one photo's own date
dated = photo(LIB / "reset" / "20150101_010214 (2023_02_22 20_13_06 UTC).jpg", "2015:01:01 01:02:14")
index(dated)
check("a phone that reset itself reads as 2015",
      day(dated).year == 2015, str(day(dated)))
target = photometa.wall_ts(datetime.datetime(2020, 1, 1, 1, 2, 14))
check("the date can be set", scanner.set_taken(conn, row(dated)["id"], target))
check("only the year moves", (day(dated).year, day(dated).month, day(dated).day,
                              day(dated).hour, day(dated).minute, day(dated).second)
      == (2020, 1, 1, 1, 2, 14), str(day(dated)))
check("it is marked as set by hand", row(dated)["taken_src"] == "manual")
index(dated)
check("a rescan keeps it, though the file still says 2015", day(dated).year == 2020, str(day(dated)))
check("an unknown photo is reported as such", scanner.set_taken(conn, 999999, 0) is False)

# ------------------------------- a suggestion taken one photo at a time is tagged too
single = photo(LIB / "single" / "cell.jpg", "2026:12:01 10:00:00", 52.0, -9.0, "CELLID")
index(single)
main.set_location(row(single)["id"], {"lat": 53.0, "lon": -9.5, "method": "NEIGHBOUR"})
check("a suggestion accepted in the lightbox is tagged as from a neighbour",
      row(single)["gps_method"] == "NEIGHBOUR", str(row(single)["gps_method"]))
index(single)
check("and stays tagged after a rescan", row(single)["gps_method"] == "NEIGHBOUR")
main.set_location(row(single)["id"], {"lat": 54.0, "lon": -9.5})
check("a position picked on the map is not", row(single)["gps_method"] == "MANUAL")

# --------------------------------------------- a gallery of exactly the photos picked
wanted = [row(p)["id"] for p in (u_real, u_cell, nowhere)]
page = main.query_photos({"ids": wanted, "limit": 2, "offset": 0, "sort": "name"})
check("only the named photos are counted", page["total"] == 3, str(page["total"]))
check("a page is the size asked for", len(page["items"]) == 2, str(len(page["items"])))
rest = main.query_photos({"ids": wanted, "limit": 2, "offset": 2, "sort": "name"})
check("and the next page carries on from it", len(rest["items"]) == 1
      and {i["id"] for i in page["items"] + rest["items"]} == set(wanted))
check("an empty selection is an empty gallery, not the whole library",
      main.query_photos({"ids": []})["total"] == 0)
many = main.query_photos({"ids": list(range(1, 6000)), "limit": 1})
check("a selection too long for a URL is accepted", many["total"] >= 1)

print()
print(f"{len(failures)} FAILED" if failures else "ALL FIX CHECKS PASSED")
sys.exit(1 if failures else 0)
