import sqlite3
import threading
import time
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
DB_PATH = DATA_DIR / "photomap.db"
THUMB_DIR = DATA_DIR / "thumbs"
TRASH_DIR = DATA_DIR / "trash"
# Photos uploaded from the cloud viewer land here. Created and registered as a
# library root lazily, on the first accepted import, so a library that never
# imports never grows a phantom root.
IMPORT_DIR = DATA_DIR / "imported"

_local = threading.local()
write_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS photos (
    id           INTEGER PRIMARY KEY,
    path         TEXT NOT NULL UNIQUE,
    folder       TEXT NOT NULL,
    filename     TEXT NOT NULL,
    ext          TEXT,
    taken_ts     INTEGER,
    taken_src    TEXT,
    lat          REAL,
    lon          REAL,
    altitude     REAL,
    width        INTEGER,
    height       INTEGER,
    orientation  INTEGER DEFAULT 1,
    camera_make  TEXT,
    camera_model TEXT,
    filesize     INTEGER,
    mtime        REAL,
    favorite     INTEGER NOT NULL DEFAULT 0,
    missing      INTEGER NOT NULL DEFAULT 0,
    added_ts     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_photos_ts      ON photos(taken_ts);
CREATE INDEX IF NOT EXISTS idx_photos_geo     ON photos(lat, lon);
CREATE INDEX IF NOT EXISTS idx_photos_missing ON photos(missing);
CREATE INDEX IF NOT EXISTS idx_photos_folder  ON photos(folder);

CREATE TABLE IF NOT EXISTS albums (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    color      TEXT NOT NULL DEFAULT '#ff5a5f',
    created_ts INTEGER
);

CREATE TABLE IF NOT EXISTS album_photos (
    album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    PRIMARY KEY (album_id, photo_id)
);
CREATE INDEX IF NOT EXISTS idx_ap_photo ON album_photos(photo_id);

-- One journal entry per calendar day, keyed by its local YYYY-MM-DD. The
-- coordinates are where the day happened: either the device's own position when
-- the entry was written, or the photo nearest it in time.
CREATE TABLE IF NOT EXISTS day_notes (
    day        TEXT PRIMARY KEY,
    text       TEXT NOT NULL,
    lat        REAL,
    lon        REAL,
    loc_src    TEXT,
    updated_ts INTEGER
);

CREATE TABLE IF NOT EXISTS roots (
    id       INTEGER PRIMARY KEY,
    path     TEXT NOT NULL UNIQUE,
    added_ts INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- Objects known to exist in the R2 bucket, so a sync only uploads what changed.
CREATE TABLE IF NOT EXISTS synced (
    key         TEXT PRIMARY KEY,
    size        INTEGER,
    uploaded_ts INTEGER
);

-- When this machine first saw each queued cloud import. The upload's own id
-- carries the phone's clock, which cannot be trusted to expire anything: a
-- device set a year fast would look brand new on every sync and never age out.
CREATE TABLE IF NOT EXISTS import_seen (
    uid      TEXT PRIMARY KEY,
    first_ts INTEGER NOT NULL
);

-- Corrections that have to survive a rescan, which re-reads the file and would
-- otherwise put the wrong value straight back. Both are keyed by something that
-- identifies the photo rather than by id: a rescan can recreate a row.
--
-- A folder whose camera clock was never set: every photo under it dated before
-- `before_ts` is moved by `offset_s`. The cut-off is what leaves the folder's
-- other photos alone - they carry real dates and must not move.
CREATE TABLE IF NOT EXISTS date_shifts (
    folder   TEXT PRIMARY KEY,
    offset_s INTEGER NOT NULL,
    before_ts INTEGER NOT NULL
);
-- A position set by hand, for a photo whose own was a cell-tower guess.
CREATE TABLE IF NOT EXISTS location_fixes (
    path TEXT PRIMARY KEY,
    lat  REAL NOT NULL,
    lon  REAL NOT NULL
);

-- Cached content hash of each snapshot thumbnail, keyed by photo. Recomputed
-- only when the source file's mtime moves, so repeat syncs stay cheap.
CREATE TABLE IF NOT EXISTS snapshot_thumbs (
    photo_id INTEGER PRIMARY KEY,
    mtime    REAL,
    hash     TEXT,
    size     INTEGER
);
"""

DEFAULTS = {
    "thumb_size": "256",
    "preview_size": "1600",
    "snapshot_thumb_size": "160",
    "snapshot_scope": "all",
    # Deleting ordinary photos from the cloud viewer is off until this machine
    # opts in. Duplicate cleanup is allowed regardless, since a copy survives.
    "cloud_delete_enabled": "0",
    # Accepting photos uploaded from the cloud viewer is off until this machine
    # opts in. They land in data/imported and become ordinary library photos.
    "cloud_import_enabled": "0",
    # Look in the bucket for photos and edits made in the viewer, and sync when
    # any turn up, rather than leaving them there until someone presses Sync.
    "cloud_watch_enabled": "1",
    "sync_on_scan": "1",
    "r2_account_id": "",
    "r2_bucket": "",
    "r2_access_key_id": "",
    "r2_secret_key": "",
    "viewer_url": "",
}

# Never leave the machine running the server.
SECRET_SETTINGS = {"access_token", "r2_secret_key", "r2_access_key_id"}


def connect() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=30.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        _local.conn = conn
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    """Add columns to an existing photos table. CREATE TABLE IF NOT EXISTS will
    not do it, so new columns have to be applied explicitly."""
    existing = {r["name"] for r in conn.execute("PRAGMA table_info(photos)")}
    for column, ddl in (
        ("content_hash", "ALTER TABLE photos ADD COLUMN content_hash TEXT"),
        ("hashed_mtime", "ALTER TABLE photos ADD COLUMN hashed_mtime REAL"),
        ("note", "ALTER TABLE photos ADD COLUMN note TEXT"),
        # Seconds, and NULL for a photo. It is the one fact a video has that a
        # photo does not, and the one the gallery has to draw on the tile.
        ("duration", "ALTER TABLE photos ADD COLUMN duration REAL"),
        # What produced the position: GPS, or a guess from the network. See
        # photometa.APPROX_METHODS.
        ("gps_method", "ALTER TABLE photos ADD COLUMN gps_method TEXT"),
    ):
        if column not in existing:
            conn.execute(ddl)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_photos_hash ON photos(content_hash)")

    # Trips were removed. Clear out what a previous version left behind - the
    # index has to go before the column it covers, or SQLite refuses the drop.
    conn.execute("DROP INDEX IF EXISTS idx_photos_trip")
    if "trip_id" in existing:
        conn.execute("ALTER TABLE photos DROP COLUMN trip_id")
    conn.execute("DROP TABLE IF EXISTS trips")
    conn.execute("DROP TABLE IF EXISTS trip_names")
    conn.execute(
        "DELETE FROM settings WHERE key IN ('trip_gap_hours','trip_jump_km','trip_move_hours')"
    )


def init() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    conn = connect()
    conn.executescript(SCHEMA)
    _migrate(conn)
    for key, value in DEFAULTS.items():
        conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (key, value))
    conn.commit()


def get_setting(key: str, default=None):
    row = connect().execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key: str, value) -> None:
    conn = connect()
    with write_lock:
        conn.execute(
            "INSERT INTO settings(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, str(value)),
        )
        conn.commit()


def get_roots() -> list[str]:
    return [r["path"] for r in connect().execute("SELECT path FROM roots ORDER BY path")]


def add_root(path: str) -> None:
    conn = connect()
    with write_lock:
        conn.execute(
            "INSERT OR IGNORE INTO roots(path, added_ts) VALUES (?, ?)", (path, int(time.time()))
        )
        conn.commit()


def remove_root(path: str) -> None:
    conn = connect()
    with write_lock:
        conn.execute("DELETE FROM roots WHERE path=?", (path,))
        conn.commit()
