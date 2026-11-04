"""Listening history from Spotify, matched to photos by time.

Spotify has no API for history older than the last 50 plays, so it comes from
the account's data download (Privacy settings, "Download your data"):

  * Extended streaming history - the whole life of the account, one record
    per play: `ts` (UTC, when the play ended), `ms_played`,
    `master_metadata_track_name`, `master_metadata_album_artist_name`,
    `master_metadata_album_album_name`, `spotify_track_uri`. Podcast episodes
    carry no track name and are skipped.
  * Account data - the last year only: `endTime` (UTC, minutes), `artistName`,
    `trackName`, `msPlayed`, and no track URI, so those plays can be named
    beside a photo but not played back.

Either as the .json files or the .zip they come in.

A photo's time is its camera's wall clock and a play's is UTC, so the photo's
UTC offset is needed: the one the weather lookup found for that place and
day, else one guessed from the longitude, else this computer's own.
"""
import io
import json
import zipfile

from . import db, tracks

SCHEMA = """
CREATE TABLE IF NOT EXISTS music_plays (
    end_ts INTEGER NOT NULL,
    ms     INTEGER NOT NULL,
    track  TEXT NOT NULL,
    artist TEXT,
    album  TEXT,
    uri    TEXT,
    PRIMARY KEY (end_ts, track)
);
"""
# No song is longer than this; bounds the search for the play under a moment.
LONGEST_S = 3 * 3600
# A play shorter than this was a skip and says nothing about the day.
SKIP_MS = 30_000


def init_schema() -> None:
    conn = db.connect()
    conn.executescript(SCHEMA)
    conn.commit()


def _plays(doc) -> list[tuple]:
    out = []
    if not isinstance(doc, list):
        return out
    for r in doc:
        if not isinstance(r, dict):
            continue
        if "ts" in r:
            track = r.get("master_metadata_track_name")
            end, ms = tracks._utc(r.get("ts")), r.get("ms_played")
            artist, album = r.get("master_metadata_album_artist_name"), r.get("master_metadata_album_album_name")
            uri = r.get("spotify_track_uri")
        elif "endTime" in r:
            track = r.get("trackName")
            end, ms = tracks._utc(str(r.get("endTime")).replace(" ", "T") + ":00Z"), r.get("msPlayed")
            artist, album, uri = r.get("artistName"), None, None
        else:
            continue
        if track and end is not None and isinstance(ms, int) and ms > 0:
            out.append((end, ms, track, artist, album, uri))
    return out


def parse(name: str, data: bytes) -> list[tuple]:
    if name.lower().endswith(".zip") or data[:4] == b"PK\x03\x04":
        out = []
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for info in archive.infolist():
                if info.filename.lower().endswith(".json"):
                    try:
                        out.extend(_plays(json.loads(archive.read(info).decode("utf-8-sig"))))
                    except ValueError:
                        continue
        return out
    try:
        return _plays(json.loads(data.decode("utf-8-sig")))
    except (UnicodeDecodeError, ValueError):
        raise ValueError(f"{name}: not a Spotify streaming history file")


def import_file(name: str, data: bytes) -> dict:
    plays = parse(name, data)
    if not plays:
        raise ValueError(f"{name}: no plays found. Use the streaming history files from Spotify's data download.")
    conn = db.connect()
    with db.write_lock:
        before = conn.execute("SELECT COUNT(*) c FROM music_plays").fetchone()["c"]
        # An extended history replaces the URI-less row the account data gave the same play.
        conn.executemany(
            "INSERT INTO music_plays(end_ts, ms, track, artist, album, uri) VALUES (?,?,?,?,?,?)"
            " ON CONFLICT(end_ts, track) DO UPDATE SET uri=COALESCE(excluded.uri, uri),"
            " album=COALESCE(excluded.album, album)", plays)
        conn.commit()
        after = conn.execute("SELECT COUNT(*) c FROM music_plays").fetchone()["c"]
    return {"read": len(plays), "added": after - before, **status()}


def status() -> dict:
    row = db.connect().execute(
        "SELECT COUNT(*) n, SUM(uri IS NOT NULL) playable, MIN(end_ts) a, MAX(end_ts) b FROM music_plays").fetchone()
    return {"plays": row["n"], "playable": row["playable"] or 0, "first": row["a"], "last": row["b"]}


def clear() -> None:
    conn = db.connect()
    with db.write_lock:
        conn.execute("DELETE FROM music_plays")
        conn.commit()


def utc_offset(photo: dict) -> int:
    try:
        offset = (json.loads(photo.get("weather") or "null") or {}).get("utc_offset")
    except ValueError:
        offset = None
    if offset is not None:
        return int(offset)
    if photo.get("lon") is not None:
        return round(photo["lon"] / 15) * 3600
    return tracks.local_offset(photo["taken_ts"])


def _shape(r) -> dict:
    return {"track": r["track"], "artist": r["artist"], "album": r["album"], "uri": r["uri"],
            "ms": r["ms"], "end_ts": r["end_ts"]}


def for_photo(photo_id: int) -> dict:
    """What was playing when a photo was taken, and the day's most played."""
    conn = db.connect()
    photo = conn.execute("SELECT * FROM photos WHERE id=?", (photo_id,)).fetchone()
    if not photo or photo["taken_ts"] is None:
        return {"now": None, "day": []}
    photo = dict(photo)
    offset = utc_offset(photo)
    utc = photo["taken_ts"] - offset
    now = conn.execute(
        "SELECT * FROM music_plays WHERE end_ts BETWEEN ? AND ? AND end_ts - ms / 1000 <= ?"
        " ORDER BY ms DESC LIMIT 1", (utc, utc + LONGEST_S, utc)).fetchone()
    start = (photo["taken_ts"] // 86400) * 86400 - offset
    day = conn.execute(
        "SELECT track, artist, MAX(album) album, MAX(uri) uri, SUM(ms) ms, MAX(end_ts) end_ts FROM music_plays"
        " WHERE end_ts BETWEEN ? AND ? AND ms >= ? GROUP BY track, artist ORDER BY SUM(ms) DESC LIMIT 5",
        (start, start + 86400, SKIP_MS)).fetchall()
    return {"now": _shape(now) if now else None, "day": [_shape(r) for r in day], "utc_offset": offset}
