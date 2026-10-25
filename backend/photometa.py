"""EXIF extraction: GPS position, capture time, camera, dimensions."""
import calendar
import datetime
import os
import warnings

from PIL import Image

from . import nametime, videometa

Image.MAX_IMAGE_PIXELS = None  # personal library: panoramas are not an attack
warnings.simplefilter("ignore", Image.DecompressionBombWarning)

HEIF_ERROR = None
try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except Exception as exc:  # missing wheel, or a blocked native library
    HEIF_ERROR = f"{type(exc).__name__}: {exc}"

# Only claim the extensions Pillow can actually open in this environment.
CANDIDATE_EXTS = (
    ".jpg", ".jpeg", ".jpe", ".png", ".tif", ".tiff", ".webp", ".bmp", ".gif",
    ".heic", ".heif", ".avif",
)
IMAGE_EXTS = {e for e in CANDIDATE_EXTS if e in Image.registered_extensions()}
HEIF_OK = ".heic" in IMAGE_EXTS

# Videos are indexed alongside photos rather than beside them: one row, one map
# point, one place in the timeline. Nothing here decodes a frame - `videometa`
# reads the container's own boxes - so the set is not conditional on Pillow.
VIDEO_EXTS = videometa.VIDEO_EXTS
MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS


def is_video(path: str) -> bool:
    return os.path.splitext(path)[1].lower() in VIDEO_EXTS


# GPSProcessingMethod values that mean the position was worked out from mobile
# towers or wifi rather than satellites. Such a fix can be tens of kilometres
# out, which is how a photo taken on the Aran Islands ended up in Co. Clare.
APPROX_METHODS = ("CELLID", "NETWORK", "WIFI")

GPS_IFD = 0x8825
EXIF_IFD = 0x8769

TAG_DATETIME = 306
TAG_MAKE = 271
TAG_MODEL = 272
TAG_ORIENTATION = 274
TAG_DT_ORIGINAL = 36867
TAG_DT_DIGITIZED = 36868
TAG_PIXEL_X = 40962
TAG_PIXEL_Y = 40963


def _clean(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        value = value.decode("utf-8", "ignore")
    value = str(value).strip().strip("\x00").strip()
    return value or None


def _parse_dt(value) -> datetime.datetime | None:
    text = _clean(value)
    if not text:
        return None
    text = text.replace("/", ":").replace("-", ":")
    if text.startswith("0000"):
        return None
    try:
        return datetime.datetime.strptime(text[:19], "%Y:%m:%d %H:%M:%S")
    except ValueError:
        pass
    try:
        return datetime.datetime.strptime(text[:10], "%Y:%m:%d")
    except ValueError:
        return None


def wall_ts(dt: datetime.datetime) -> int:
    """Seconds for a naive local wall-clock time.

    EXIF timestamps carry no timezone, so the whole app treats a capture time as
    the wall clock shown on the camera and normalizes it through UTC. A photo
    taken at 15:00 always reads back as 15:00, wherever it was shot.
    """
    return calendar.timegm(dt.timetuple())


def _to_degrees(value) -> float | None:
    """Degrees, minutes and seconds as a magnitude - the hemisphere is the Ref
    tag's job, which is what the format intends.

    A GPS rational is unsigned, and an encoder that writes a negative degree for
    a west longitude leaves a number just under 2**32 in the field. Read plainly
    that is not a coordinate at all, it is nonsense large enough to fail the
    range check and take the latitude down with it, so the fix disappears
    entirely rather than landing in the wrong hemisphere. Reading it back as
    signed costs a correct file nothing: no real component comes near 2**31.

    Mirrored in viewer/exif.js - see the note at the top of that file.
    """
    def signed(number: float) -> float:
        return number - 4294967296.0 if number >= 2147483648.0 else number

    try:
        deg, minute, sec = (signed(float(part)) for part in value)
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    return abs(deg) + abs(minute) / 60.0 + abs(sec) / 3600.0


def _gps(gps_ifd: dict) -> tuple[float | None, float | None, float | None]:
    lat = _to_degrees(gps_ifd.get(2))
    lon = _to_degrees(gps_ifd.get(4))
    if lat is None or lon is None:
        return None, None, None
    if (_clean(gps_ifd.get(1)) or "N").upper().startswith("S"):
        lat = -lat
    if (_clean(gps_ifd.get(3)) or "E").upper().startswith("W"):
        lon = -lon
    if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
        return None, None, None
    if lat == 0.0 and lon == 0.0:  # null island: a missing fix, not a location
        return None, None, None

    alt = None
    try:
        raw_alt = gps_ifd.get(6)
        if raw_alt is not None:
            alt = float(raw_alt)
            if int(gps_ifd.get(5) or 0) == 1:
                alt = -alt
    except (TypeError, ValueError, ZeroDivisionError):
        alt = None
    return lat, lon, alt


def _gps_method(gps_ifd: dict) -> str | None:
    """Tag 27 is an undefined-type blob: an 8-byte character code ("ASCII" padded
    with zeros) followed by the text."""
    raw = gps_ifd.get(27)
    if isinstance(raw, bytes):
        raw = raw[8:] if len(raw) > 8 else raw
    text = _clean(raw)
    return text.upper() if text else None


def read(path: str) -> dict:
    """Return metadata for one file. Never raises.

    Videos come back through here too, in the same shape, so every caller - the
    scanner, the cloud import - stays one code path with one row layout.
    """
    if is_video(path):
        return videometa.read(path)

    stat = os.stat(path)
    meta = {
        "path": path,
        "folder": os.path.dirname(path),
        "filename": os.path.basename(path),
        "ext": os.path.splitext(path)[1].lower(),
        "filesize": stat.st_size,
        "mtime": stat.st_mtime,
        "taken_ts": None,
        "taken_src": "mtime",
        "lat": None,
        "lon": None,
        "altitude": None,
        "width": None,
        "height": None,
        "orientation": 1,
        "camera_make": None,
        "camera_model": None,
        "duration": None,
        "gps_method": None,
        "error": None,
    }

    try:
        with Image.open(path) as img:
            meta["width"], meta["height"] = img.size
            exif = img.getexif()
    except Exception as exc:  # unreadable/corrupt file still belongs in the index
        meta["error"] = f"{type(exc).__name__}: {exc}"
        exif = None

    if exif:
        try:
            meta["camera_make"] = _clean(exif.get(TAG_MAKE))
            meta["camera_model"] = _clean(exif.get(TAG_MODEL))
            meta["orientation"] = int(exif.get(TAG_ORIENTATION) or 1)

            sub = {}
            try:
                sub = exif.get_ifd(EXIF_IFD) or {}
            except Exception:
                sub = {}

            dt = (
                _parse_dt(sub.get(TAG_DT_ORIGINAL))
                or _parse_dt(sub.get(TAG_DT_DIGITIZED))
                or _parse_dt(exif.get(TAG_DATETIME))
            )
            if dt:
                meta["taken_ts"] = wall_ts(dt)
                meta["taken_src"] = "exif"

            if not meta["width"]:
                meta["width"] = sub.get(TAG_PIXEL_X)
                meta["height"] = sub.get(TAG_PIXEL_Y)

            try:
                gps_ifd = exif.get_ifd(GPS_IFD) or {}
            except Exception:
                gps_ifd = {}
            if gps_ifd:
                meta["lat"], meta["lon"], meta["altitude"] = _gps(gps_ifd)
                if meta["lat"] is not None:
                    meta["gps_method"] = _gps_method(gps_ifd)
        except Exception as exc:
            meta["error"] = meta["error"] or f"exif: {exc}"

    if meta["taken_ts"] is None:
        # No EXIF date. The filename is far more trustworthy than the file's
        # modified time, which is usually the import moment - see nametime.
        named, _ = nametime.parse(meta["filename"])
        if named is not None:
            meta["taken_ts"] = named
            meta["taken_src"] = "filename"
        else:
            meta["taken_ts"] = wall_ts(datetime.datetime.fromtimestamp(stat.st_mtime))
            meta["taken_src"] = "mtime"

    return meta
