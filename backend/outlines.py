"""A place's outline, for drawing it when the place is picked from search.

OpenStreetMap's Nominatim answers "what is at this point, at this scale" with
the area's own shape. It is asked only when someone picks a place from the
search box - the position of a town they typed, not of any photo - and every
answer is kept, so the same town is asked about once. Nominatim's usage policy
asks for an identifying User-Agent and no more than a request a second, which
a person picking places from a list stays well inside.
"""
import json
import threading
import time
import urllib.parse
import urllib.request

from . import db

URL = "https://nominatim.openstreetmap.org/reverse"
SCHEMA = """
CREATE TABLE IF NOT EXISTS place_outlines (
    key        TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    fetched_ts INTEGER
);
"""
_lock = threading.Lock()
_last = [0.0]


def init_schema() -> None:
    conn = db.connect()
    conn.executescript(SCHEMA)
    conn.commit()


def zoom_for(population: int) -> int:
    """Nominatim's scale: 10 a city, 12 a town, 13 a village."""
    return 10 if population >= 100_000 else 12 if population >= 5_000 else 13


def outline(lat: float, lon: float, population: int = 0) -> dict:
    zoom = zoom_for(population)
    key = f"{lat:.3f},{lon:.3f},{zoom}"
    conn = db.connect()
    row = conn.execute("SELECT data FROM place_outlines WHERE key=?", (key,)).fetchone()
    if row:
        return json.loads(row["data"])
    query = urllib.parse.urlencode({"lat": f"{lat:.5f}", "lon": f"{lon:.5f}", "zoom": zoom, "format": "jsonv2",
                                    "polygon_geojson": 1, "polygon_threshold": 0.0005})
    with _lock:
        time.sleep(max(0.0, 1.0 - (time.time() - _last[0])))
        req = urllib.request.Request(f"{URL}?{query}", headers={"User-Agent": "PhotoMap/1.0 (personal photo map)"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                answer = json.loads(r.read().decode("utf-8"))
        finally:
            _last[0] = time.time()
    shape = answer.get("geojson") or {}
    data = {"name": answer.get("name") or "",
            "geojson": shape if shape.get("type") in ("Polygon", "MultiPolygon") else None}
    with db.write_lock:
        conn.execute("INSERT OR REPLACE INTO place_outlines(key, data, fetched_ts) VALUES (?,?,?)",
                     (key, json.dumps(data), int(time.time())))
        conn.commit()
    return data
