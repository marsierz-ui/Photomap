"""One journal entry per calendar day, and where that day happened.

Lifted out of the API layer because two different callers write a day now: the
app on this computer, and the cloud viewer, whose entries arrive through the
bucket and are applied by `sync`. Both have to place a day the same way and
sanitise it to the same whitelist, and the way to guarantee that is for there to
be one function rather than two that look alike.
"""
import datetime
import re
import time

from . import db

# A photo taken months from the day says nothing about where that day happened,
# so the fallback gives up rather than guess wildly.
NEAREST_PHOTO_WINDOW = 2 * 86400

# A day is a page, not a document. Long enough for anything anyone writes on a
# phone, short enough that the inbox cannot be filled with one entry. Kept in
# step with the Worker's own cap, which a cloud entry meets first.
TEXT_MAX = 20000

DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Entries are HTML, and everything that comes back out of the database is
# rebuilt from this whitelist by the client. This is the server-side backstop:
# it strips every tag that is not on the list along with every attribute, so
# nothing that could carry a handler is ever stored in the first place.
ALLOWED_TAGS = {"b", "strong", "i", "em", "u", "s", "strike", "ul", "ol", "li", "br", "div", "p"}
TAG = re.compile(r"<(/?)([A-Za-z][A-Za-z0-9]*)\b[^>]*>")


def valid_day(day: str) -> bool:
    if not DAY.match(day or ""):
        return False
    try:
        datetime.date.fromisoformat(day)
    except ValueError:
        return False
    return True


def sanitise(html: str) -> str:
    """Keep the listed tags, drop every attribute, drop everything else.

    Deliberately blunt - a tag that is not on the list loses its markup and
    keeps its text, which is what the client's own whitelist does. It is not
    the only guard, it is the one that runs where the client cannot be trusted:
    a cloud entry is written by whatever posted to the Worker.
    """
    def keep(match: re.Match) -> str:
        name = match.group(2).lower()
        return f"<{match.group(1)}{name}>" if name in ALLOWED_TAGS else ""

    return TAG.sub(keep, html or "")[:TEXT_MAX].strip()


def anchor(day: str) -> int:
    """Midday of a YYYY-MM-DD, on the same wall-clock-through-UTC scale as
    taken_ts - so the comparison is date against date, not zone against zone."""
    year, month, date = (int(part) for part in day.split("-"))
    return int(datetime.datetime(year, month, date, 12, tzinfo=datetime.UTC).timestamp())


def nearest_photo(anchor_ts: int) -> tuple[float, float] | None:
    row = db.connect().execute(
        "SELECT lat, lon, ABS(taken_ts - ?) AS gap FROM photos"
        " WHERE missing=0 AND lat IS NOT NULL AND taken_ts IS NOT NULL"
        " ORDER BY gap LIMIT 1",
        (anchor_ts,),
    ).fetchone()
    if not row or row["gap"] > NEAREST_PHOTO_WINDOW:
        return None
    return row["lat"], row["lon"]


def listing() -> list[dict]:
    return [dict(r) for r in db.connect().execute("SELECT * FROM day_notes ORDER BY day DESC")]


def save(day: str, text: str, lat=None, lon=None, loc_src: str | None = None) -> dict:
    """Write one day. Empty text deletes it - a blank day is not worth keeping."""
    conn = db.connect()
    text = sanitise(text)
    if not text:
        with db.write_lock:
            conn.execute("DELETE FROM day_notes WHERE day=?", (day,))
            conn.commit()
        return {"day": day, "text": "", "lat": None, "lon": None, "loc_src": None}

    source = (loc_src or "device") if lat is not None and lon is not None else None
    if source is None:
        found = nearest_photo(anchor(day))
        if found:
            lat, lon = found
            source = "photo"

    with db.write_lock:
        conn.execute(
            "INSERT INTO day_notes(day, text, lat, lon, loc_src, updated_ts) VALUES (?,?,?,?,?,?)"
            " ON CONFLICT(day) DO UPDATE SET text=excluded.text, lat=excluded.lat,"
            " lon=excluded.lon, loc_src=excluded.loc_src, updated_ts=excluded.updated_ts",
            (day, text, lat, lon, source, int(time.time())),
        )
        conn.commit()
    return {"day": day, "text": text, "lat": lat, "lon": lon, "loc_src": source}
