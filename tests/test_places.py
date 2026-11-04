"""Subalbums, and coordinates turned into place and country.

    .venv\\Scripts\\python.exe tests\\test_places.py
"""
import sys
import tempfile
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT))

TMP = Path(tempfile.mkdtemp(prefix="photomap_places_"))
DATA = TMP / "data"
DATA.mkdir()

from backend import db  # noqa: E402

db.DATA_DIR = DATA
db.DB_PATH = DATA / "photomap.db"
db.THUMB_DIR = DATA / "thumbs"
db.TRASH_DIR = DATA / "trash"

from fastapi import HTTPException  # noqa: E402
from starlette.requests import Request  # noqa: E402

from backend import geocode  # noqa: E402

geocode.DIR = DATA / "geonames"
geocode.PLACES = geocode.DIR / "places.tsv"
geocode.DIR.mkdir()
geocode.PLACES.write_text("\n".join([
    "Galway\t53.27194\t-9.04889\tIE\tConnacht",
    "Kilronan\t53.1219\t-9.6666\tIE\tConnacht",
    "Strasbourg\t48.58392\t7.74553\tFR\tGrand Est",
    "Kehl\t48.57297\t7.81523\tDE\tBaden-Wurttemberg",
    "Fiji Town\t-17.8\t178.0\tFJ\t",
    "Taveuni\t-16.85\t-179.95\tFJ\t",
]), encoding="utf-8")

from backend import main  # noqa: E402

failures = []


def check(label, condition, detail=""):
    print(f"{'PASS' if condition else 'FAIL'}  {label}{'' if condition else f' -> {detail}'}")
    if not condition:
        failures.append(label)


def request(**query):
    qs = "&".join(f"{k}={v}" for k, v in query.items()).encode()
    return Request({"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": qs})


conn = db.connect()
for i, (lat, lon) in enumerate([(53.27, -9.05), (53.12, -9.66), (48.58, 7.75), (None, None), (0.0, -30.0)], 1):
    conn.execute(
        "INSERT INTO photos(id, path, folder, filename, lat, lon, taken_ts) VALUES (?,?,?,?,?,?,?)",
        (i, f"/p/{i}.jpg", "/p", f"{i}.jpg", lat, lon, 1_700_000_000 + i * 86400),
    )
conn.commit()

# ------------------------------------------------------------------- places
check("Galway named", geocode.lookup(53.27, -9.05) == ("Galway, Connacht", "IE"), geocode.lookup(53.27, -9.05))
check("nearest wins on the islands", geocode.lookup(53.12, -9.66)[0].startswith("Kilronan"))
check("mid-Atlantic is nowhere", geocode.lookup(0.0, -30.0) == ("", ""))
check("search crosses the antimeridian", geocode.lookup(-16.85, 179.99)[1] == "FJ", geocode.lookup(-16.85, 179.99))

geocode.fill()
rows = {r["id"]: dict(r) for r in conn.execute("SELECT id, place, country, place_at FROM photos")}
check("fill names located photos", rows[1]["country"] == "IE" and rows[3]["country"] == "FR", rows)
check("fill leaves unlocated photos alone", rows[4]["place_at"] is None)
check("nothing left pending", geocode.status()["pending"] == 0, geocode.status())

main.set_location(1, {"lat": 48.573, "lon": 7.815})
check("a moved photo is pending again", geocode.status()["pending"] == 1, geocode.status())
check("the lightbox names it straight away", main.photo_detail(1)["country"] == "DE")
check("and it is no longer pending", geocode.status()["pending"] == 0)

res = main.countries(request())
by_cc = {r["cc"]: r for r in res["items"]}
check("country counts", by_cc.get("IE", {}).get("c") == 1 and by_cc.get("DE", {}).get("c") == 1
      and by_cc.get("FR", {}).get("c") == 1, res["items"])
check("no blank country row", "" not in by_cc and None not in by_cc)

# ------------------------------------------------------------------ albums
trip = main.create_album({"name": "Trip", "ids": [1]})["id"]
rome = main.create_album({"name": "Rome", "parent_id": trip, "ids": [2]})["id"]
day = main.create_album({"name": "Day 1", "parent_id": rome, "ids": [3]})["id"]
albums = {a["id"]: a for a in main.list_albums()}
check("parent counts its subalbums", albums[trip]["photo_count"] == 3, albums[trip])
check("middle counts below only", albums[rome]["photo_count"] == 2, albums[rome])
check("parent recorded", albums[day]["parent_id"] == rome)

ids = main.photo_ids(request(album=trip))["ids"]
check("filtering a parent includes subalbums", sorted(ids) == [1, 2, 3], ids)
check("filtering a leaf is just the leaf", main.photo_ids(request(album=day))["ids"] == [3])

for bad in (trip, day):
    try:
        main.update_album(trip, {"parent_id": bad})
        check(f"loop through {bad} refused", False)
    except HTTPException as exc:
        check(f"loop through {bad} refused", exc.status_code == 400)

main.update_album(day, {"parent_id": None})
check("moved to the top", {a["id"]: a for a in main.list_albums()}[day]["parent_id"] is None)
main.update_album(day, {"parent_id": rome})

main.delete_album(rome)
albums = {a["id"]: a for a in main.list_albums()}
check("deleting an album lifts its subalbums", albums[day]["parent_id"] == trip, albums)
check("photos of the deleted album leave the parent", albums[trip]["photo_count"] == 2, albums[trip])

print(f"\n{len(failures)} failure(s)" if failures else "\nall passed")
sys.exit(1 if failures else 0)
