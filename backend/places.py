"""Saved places: a name and a circle on the map, chosen by the person.

They answer "which photos were taken at the cottage", give the map shortcuts,
and one of them can be home, which is what trips are measured from.
"""
import math
import time

from . import db

EARTH_KM = 6371.0088


def km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_KM * math.asin(min(1.0, math.sqrt(a)))


def circle_sql(lat: float, lon: float, radius_m: float, alias: str = "p") -> tuple[str, list]:
    """A WHERE fragment for "within radius_m of here".

    SQLite has no trigonometry by default, so the cosine is worked out here and
    the test is an equirectangular one, which at a few kilometres is exact enough
    to be indistinguishable. The box in front of it is what lets the lat/lon
    index do the work.
    """
    dlat = radius_m / 111_320.0
    shrink = max(math.cos(math.radians(lat)), 0.01)
    dlon = min(180.0, dlat / shrink)
    sql = (
        f"{alias}.lat BETWEEN ? AND ? AND {alias}.lon BETWEEN ? AND ?"
        f" AND (({alias}.lat - ?) * ({alias}.lat - ?)"
        f" + ({alias}.lon - ?) * ({alias}.lon - ?) * ?) <= ?"
    )
    return sql, [lat - dlat, lat + dlat, lon - dlon, lon + dlon,
                 lat, lat, lon, lon, shrink * shrink, dlat * dlat]


def get(place_id: int) -> dict | None:
    row = db.connect().execute("SELECT * FROM saved_places WHERE id=?", (place_id,)).fetchone()
    return dict(row) if row else None


def home() -> dict | None:
    row = db.connect().execute("SELECT * FROM saved_places WHERE is_home=1 LIMIT 1").fetchone()
    return dict(row) if row else None


def list_all() -> list[dict]:
    conn = db.connect()
    items = []
    for row in conn.execute("SELECT * FROM saved_places ORDER BY is_home DESC, name COLLATE NOCASE"):
        item = dict(row)
        where, params = circle_sql(item["lat"], item["lon"], item["radius_m"])
        item["photos"] = conn.execute(
            f"SELECT COUNT(*) c FROM photos p WHERE p.missing=0 AND {where}", params
        ).fetchone()["c"]
        items.append(item)
    return items


def _clean(body: dict, partial: bool) -> dict:
    out = {}
    if "name" in body or not partial:
        name = str(body.get("name") or "").strip()[:80]
        if not name:
            raise ValueError("A place needs a name")
        out["name"] = name
    if "lat" in body or "lon" in body or not partial:
        try:
            lat, lon = float(body["lat"]), float(body["lon"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("lat and lon are required")
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise ValueError("Not a position")
        out["lat"], out["lon"] = lat, lon
    if "radius_m" in body:
        out["radius_m"] = int(min(50_000, max(25, float(body["radius_m"]))))
    if "is_home" in body:
        out["is_home"] = 1 if body["is_home"] else 0
    return out


def create(body: dict) -> dict:
    values = _clean(body, partial=False)
    values.setdefault("radius_m", 300)
    values.setdefault("is_home", 0)
    conn = db.connect()
    with db.write_lock:
        if values["is_home"]:
            conn.execute("UPDATE saved_places SET is_home=0")
        cur = conn.execute(
            "INSERT INTO saved_places(name, lat, lon, radius_m, is_home, created_ts) VALUES (?,?,?,?,?,?)",
            (values["name"], values["lat"], values["lon"], values["radius_m"], values["is_home"], int(time.time())),
        )
        conn.commit()
    return get(cur.lastrowid)


def update(place_id: int, body: dict) -> dict | None:
    values = _clean(body, partial=True)
    if not get(place_id):
        return None
    conn = db.connect()
    with db.write_lock:
        if values.get("is_home"):
            conn.execute("UPDATE saved_places SET is_home=0")
        if values:
            sets = ", ".join(f"{k}=?" for k in values)
            conn.execute(f"UPDATE saved_places SET {sets} WHERE id=?", [*values.values(), place_id])
        conn.commit()
    return get(place_id)


def delete(place_id: int) -> bool:
    conn = db.connect()
    with db.write_lock:
        gone = conn.execute("DELETE FROM saved_places WHERE id=?", (place_id,)).rowcount
        conn.commit()
    return bool(gone)
