"""Place names in a chosen language, from GeoNames' alternate names.

    .venv\\Scripts\\python.exe tests\\test_placenames.py

The GeoNames server is replaced by an in-memory one serving small versions of
the three files, so this runs offline and checks the whole path: download,
reduce, rename, search, switch back.
"""
import io
import sys
import tempfile
import time
import zipfile
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT))

TMP = Path(tempfile.mkdtemp(prefix="photomap_names_"))
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

from backend import main  # noqa: E402

failures = []


def check(label, condition, detail=""):
    print(f"{'PASS' if condition else 'FAIL'}  {label}{'' if condition else f' -> {detail}'}")
    if not condition:
        failures.append(label)


def zipped(name, text):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(name, text)
    return buf.getvalue()


def city(gid, name, lat, lon, cc, a1, pop):
    cols = [""] * 19
    cols[0], cols[1], cols[2], cols[4], cols[5], cols[8], cols[10], cols[14] = (
        str(gid), name, name, str(lat), str(lon), cc, a1, str(pop))
    return "\t".join(cols)


FILES = {
    "admin1CodesASCII.txt": "AT.09\tVienna\tVienna\t2761367\nIE.C\tConnacht\tConnacht\t7521315\n".encode(),
    "cities1000.zip": zipped("cities1000.txt", "\n".join([
        city(2761369, "Wien", 48.20849, 16.37208, "AT", "09", 1691468),
        city(2964180, "Gaillimh", 53.27194, -9.04889, "IE", "C", 79934),
    ]) + "\n"),
    "alternateNamesV2.zip": zipped("alternateNamesV2.txt", "\n".join([
        "1\t2761369\ten\tVienna\t1\t\t\t\t\t",
        "2\t2761369\tpl\tWiedeń\t1\t\t\t\t\t",
        "3\t2761369\ten\tVindobona\t\t\t\t1\t\t",        # historic
        "4\t2964180\ten\tGalway\t\t\t\t\t\t",
        "5\t2964180\ten\tThe City of the Tribes\t\t\t1\t\t\t",  # colloquial
        "6\t2761367\ten\tVienna State\t\t\t\t\t\t",
        "7\t2761367\tpl\tWiedeń (kraj)\t\t\t\t\t\t",
        "8\t999\ten\tNot on our list\t1\t\t\t\t\t",
    ]) + "\n"),
}


class Response(io.BytesIO):
    def __init__(self, data):
        super().__init__(data)
        self.headers = {"Content-Length": str(len(data))}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def fake_urlopen(url, timeout=None):
    return Response(FILES[url.rsplit("/", 1)[-1]])


geocode.urllib.request.urlopen = fake_urlopen

conn = db.connect()
conn.executemany("INSERT INTO photos(id, path, folder, filename, lat, lon, taken_ts) VALUES (?,?,?,?,?,?,?)",
                 [(1, "/p/1.jpg", "/p", "1.jpg", 48.21, 16.37, 1), (2, "/p/2.jpg", "/p", "2.jpg", 53.27, -9.05, 2)])
conn.commit()


def place(pid):
    return conn.execute("SELECT place FROM photos WHERE id=?", (pid,)).fetchone()["place"]


def settle():
    for _ in range(200):
        st = geocode.status()
        if not st["names"]["running"] and not st["filling"] and not st["pending"]:
            return
        geocode.fill()
        time.sleep(0.02)


geocode.download()
settle()
check("the list keeps GeoNames ids", geocode.has_ids())
check("names as GeoNames spells them", place(1) == "Wien, Vienna" and place(2) == "Gaillimh, Connacht",
      (place(1), place(2)))

main.geocode_language({"lang": "en"})
settle()
check("translations downloaded", geocode.status()["translated"], geocode.status())
check("names in English", place(1) == "Vienna, Vienna State" and place(2) == "Galway, Connacht",
      (place(1), place(2)))
table = geocode.names_file("en").read_text(encoding="utf-8")
check("historic and colloquial names are left out", "Vindobona" not in table and "Tribes" not in table)
check("places not on the list are left out", "Not on our list" not in table)
check("the archive is deleted afterwards", not list(geocode.DIR.glob("*.part")))

hits = main.geocode_search(q="vienna")["items"]
check("search finds the translated name", hits and hits[0]["name"] == "Vienna" and hits[0]["local"] == "Wien", hits)
check("and still the local one", main.geocode_search(q="wien")["items"][0]["name"] == "Vienna")
check("photos found by translated name", main.list_photos(
    __import__("starlette.requests", fromlist=["Request"]).Request(
        {"type": "http", "method": "GET", "path": "/", "headers": [], "query_string": b"q=Galway"}))["total"] == 1)

main.geocode_language({"lang": "pl"})
settle()
check("another language", place(1) == "Wiedeń, Wiedeń (kraj)", place(1))
check("a place without a Polish name keeps its own", place(2) == "Gaillimh, Connacht", place(2))

main.geocode_language({"lang": ""})
settle()
check("back to GeoNames spelling", place(1) == "Wien, Vienna", place(1))
try:
    main.geocode_language({"lang": "../x"})
    check("a bad code is refused", False)
except Exception:
    check("a bad code is refused", True)

# A list downloaded before ids were kept: translation asks for a fresh download.
geocode.PLACES.write_text("Wien\t48.2\t16.37\tAT\tVienna\t1691468\n", encoding="utf-8")
geocode._index = None
check("an old list is recognised", not geocode.has_ids())
main.geocode_language({"lang": "de"})
time.sleep(0.1)
check("and no download starts for it", not geocode.names_file("de").exists() and not geocode.status()["names"]["running"])
check("lookup still works with it", geocode.lookup(48.2, 16.37)[0] == "Wien, Vienna")

print()
if failures:
    print(f"{len(failures)} FAILED")
    sys.exit(1)
print("all passed")
