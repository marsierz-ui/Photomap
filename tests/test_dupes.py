"""Duplicate detection, keep-suggestion, and the safety rules around deletion."""
import shutil
import sys
import tempfile
import time
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT))

TMP = Path(tempfile.mkdtemp(prefix="photomap_dupes_"))
PHOTOS = TMP / "photos"
DATA = TMP / "data"
PHOTOS.mkdir(parents=True)
DATA.mkdir(parents=True)

from backend import db  # noqa: E402

db.DATA_DIR = DATA
db.DB_PATH = DATA / "photomap.db"
db.THUMB_DIR = DATA / "thumbs"
db.TRASH_DIR = DATA / "trash"

from PIL import Image  # noqa: E402

from backend import dupes, main, scanner  # noqa: E402

# Keep the OS recycle bin out of the test: files land in data/trash instead.
main.RECYCLE_OK = False
db.TRASH_DIR = DATA / "trash"

failures = []


def check(label, condition, detail=""):
    print(f"{'PASS' if condition else 'FAIL'}  {label}{'' if condition else f' -> {detail}'}")
    if not condition:
        failures.append(label)


def make(name, colour, size=(300, 200)):
    Image.new("RGB", size, colour).save(PHOTOS / name)


# 3 identical, 2 identical, 1 unique, plus a same-size-but-different pair.
make("original.jpg", (10, 120, 200))
shutil.copy(PHOTOS / "original.jpg", PHOTOS / "original (1).jpg")
shutil.copy(PHOTOS / "original.jpg", PHOTOS / "copy of original.jpg")
make("pair.jpg", (200, 30, 60))
shutil.copy(PHOTOS / "pair.jpg", PHOTOS / "pair (2).jpg")
make("unique.jpg", (5, 200, 90))
# Same pixel dimensions, different content: must NOT be called duplicates.
make("twinA.jpg", (1, 2, 3))
make("twinB.jpg", (3, 2, 1))

db.init()
db.add_root(str(PHOTOS))
db.set_setting("sync_on_scan", "0")
scanner.start()
while scanner.status()["running"]:
    time.sleep(0.1)
print(f"indexed {scanner.status()['added']} files\n")

dupes.start()
while dupes.status()["running"]:
    time.sleep(0.05)
state = dupes.status()
print(f"hash scan: phase={state['phase']} hashed={state['hashed']} errors={state['errors']}\n")

summary = dupes.summarise()
print(f"summary: sets={summary['sets']} redundant={summary['redundant']}"
      f" reclaimable={summary['reclaimable']} bytes\n")
check("finds exactly 2 duplicate sets", summary["sets"] == 2, f"got {summary['sets']}")
check("counts 3 redundant copies", summary["redundant"] == 3, f"got {summary['redundant']}")

groups = dupes.groups()
for g in groups:
    names = [p["filename"] for p in g["photos"]]
    keep = next(p["filename"] for p in g["photos"] if p["id"] == g["keep_id"])
    print(f"  set of {g['count']} ({g['size']} bytes) keep={keep!r} all={names}")

three = next(g for g in groups if g["count"] == 3)
keep_name = next(p["filename"] for p in three["photos"] if p["id"] == three["keep_id"])
check("suggests the non-copy name to keep", keep_name == "original.jpg", f"suggested {keep_name}")

different = [g for g in groups if {"twinA.jpg", "twinB.jpg"} & {p["filename"] for p in g["photos"]}]
check("same size but different content is not a duplicate", not different)

# --- safety rules -----------------------------------------------------------
print()
res = main.resolve_duplicates({"hashes": [three["hash"]], "keep": [], "mode": "trash"})
check("refuses a set with no keeper", res["deleted"] == 0 and res["skipped"] == [three["hash"]], str(res))

res = main.resolve_duplicates(
    {"hashes": [three["hash"]], "keep": [p["id"] for p in three["photos"]], "mode": "trash"})
check("refuses when everything is marked keep", res["deleted"] == 0, str(res))

res = main.resolve_duplicates({"hashes": [three["hash"]], "keep": [999999], "mode": "trash"})
check("refuses a keeper that is not in the set", res["deleted"] == 0, str(res))

still_there = db.connect().execute(
    "SELECT COUNT(*) c FROM photos WHERE content_hash=? AND missing=0", (three["hash"],)
).fetchone()["c"]
check("nothing deleted by the refused calls", still_there == 3, f"{still_there} left")

# --- the real deletion ------------------------------------------------------
res = main.resolve_duplicates(
    {"hashes": [three["hash"]], "keep": [three["keep_id"]], "mode": "trash"})
print(f"\nresolve: deleted={res['deleted']} location={res['location']} failed={res['failed']}")
check("deletes exactly the extras", res["deleted"] == 2, str(res))

left = db.connect().execute(
    "SELECT filename FROM photos WHERE content_hash=? AND missing=0", (three["hash"],)
).fetchall()
check("one copy survives in the index", len(left) == 1, f"{len(left)} left")
check("the survivor is the suggested keeper", left and left[0]["filename"] == "original.jpg",
      left[0]["filename"] if left else "none")
check("the kept file is still on disk", (PHOTOS / "original.jpg").exists())
check("removed files left the folder", not (PHOTOS / "original (1).jpg").exists())
trashed = list((DATA / "trash").glob("*")) if (DATA / "trash").exists() else []
check("removed files are recoverable from trash", len(trashed) == 2, f"{len(trashed)} in trash")

after = dupes.summarise()
check("set is resolved afterwards", after["sets"] == 1, f"{after['sets']} sets left")

# Unrelated photos untouched
total = db.connect().execute("SELECT COUNT(*) c FROM photos WHERE missing=0").fetchone()["c"]
check("only the extras were removed", total == 6, f"{total} photos remain")

print()
if failures:
    print(f"{len(failures)} FAILED: {failures}")
    sys.exit(1)
print("ALL DUPLICATE CHECKS PASSED")
shutil.rmtree(TMP, ignore_errors=True)
