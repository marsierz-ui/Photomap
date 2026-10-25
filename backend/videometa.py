"""Capture time, position and dimensions out of a video container.

ISO base media files only - .mp4, .m4v, .mov, .3gp - because that is what every
phone records and what every phone uploads. There is no Pillow for video and no
intention of adding a decoder here: everything below is a walk over box headers,
which is the standard library and nothing else.

The tree is small and always the same shape, so the whole `moov` box is read
into memory once and walked there rather than seeking around the file. A 4GB
recording has the same few hundred kilobytes of metadata as a five-second one.

Where it can differ from `photometa`, it deliberately does not:

  - a capture time is a naive wall clock, normalised through UTC exactly as
    EXIF times are, so a clip taken at 15:00 reads back as 15:00;
  - (0, 0) is a missing fix, not a location;
  - a fix outside -90..90 / -180..180 is refused.

Mirrored in viewer/exif.js, which reads the same boxes in the browser so a video
picked on a phone gets its pin before it has finished uploading.
"""
import calendar
import datetime
import math
import os
import re
import struct

from . import nametime

VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".3gp", ".3g2"}

# Movie times are counted from 1904-01-01, which is the QuickTime epoch.
EPOCH_1904 = 2082844800
# The metadata box of a phone recording is kilobytes. Anything claiming more
# than this is not a `moov` worth reading into memory.
MOOV_MAX = 32 * 1024 * 1024
# Boxes that hold other boxes. Anything not listed is a leaf and is not walked.
CONTAINERS = {b"moov", b"trak", b"mdia", b"udta", b"meta", b"ilst"}
# The leaves worth keeping. Everything else in the tree is skipped over.
WANTED = {b"mvhd", b"tkhd", b"loci", b"\xa9xyz", b"\xa9day", b"data"}

# "+52.5200+013.4050+050.000/" - ISO 6709, which is what a phone writes into
# the location box. Degrees-and-minutes forms exist in the standard and are not
# handled: no phone writes one, and a wrong guess would be a wrong pin.
ISO6709 = re.compile(
    r"^([+-]\d{1,3}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)(?:([+-]\d+(?:\.\d+)?))?"
)


def _walk(buf: bytes, start: int, end: int, depth: int, out: dict) -> None:
    """Collect the leaf boxes of interest, by type, into `out`."""
    offset = start
    while offset + 8 <= end:
        size = int.from_bytes(buf[offset:offset + 4], "big")
        kind = buf[offset + 4:offset + 8]
        head = 8
        if size == 1:  # 64-bit size, for a box larger than 4GB
            if offset + 16 > end:
                return
            size = int.from_bytes(buf[offset + 8:offset + 16], "big")
            head = 16
        elif size == 0:  # runs to the end of its parent
            size = end - offset
        if size < head or offset + size > end:
            return  # truncated or nonsense: stop rather than guess
        body_start, body_end = offset + head, offset + size
        if kind in WANTED:
            out.setdefault(kind, []).append((body_start, body_end))
        if kind in CONTAINERS and depth < 8:
            child = body_start + (_meta_skip(buf, body_start, body_end) if kind == b"meta" else 0)
            _walk(buf, child, body_end, depth + 1, out)
        offset += size


def _meta_skip(buf: bytes, start: int, end: int) -> int:
    """`meta` is a full box in ISO and a plain one in QuickTime.

    The four bytes of version and flags are there in a .mp4 and absent in a
    .mov, and reading the wrong one loses the whole subtree silently. Which it
    is can simply be looked at: a box type is four printable characters, and
    `hdlr` is always the first child.
    """
    for skip in (4, 0):
        at = start + skip
        if at + 8 <= end and _is_box_type(buf[at + 4:at + 8]):
            return skip
    return 4


def _is_box_type(raw: bytes) -> bool:
    return len(raw) == 4 and all(0x20 <= b <= 0x7E or b == 0xA9 for b in raw)


def _text(buf: bytes, span: tuple[int, int], in_ilst: bool) -> str | None:
    """The string inside a `©xyz` or `©day` box.

    Two layouts for the same tag: under `udta` it is a two-byte length and a
    two-byte language code followed by the text; under `ilst` it is wrapped in
    a `data` box with its own eight-byte header.
    """
    start, end = span
    start += 8 if in_ilst else 4
    if start >= end:
        return None
    return buf[start:end].decode("utf-8", "ignore").strip("\x00").strip() or None


def _from_iso6709(text: str) -> tuple[float, float, float | None] | None:
    match = ISO6709.match(text or "")
    if not match:
        return None
    try:
        lat, lon = float(match.group(1)), float(match.group(2))
        alt = float(match.group(3)) if match.group(3) else None
    except ValueError:
        return None
    return lat, lon, alt


def _from_loci(buf: bytes, span: tuple[int, int]) -> tuple[float, float, float | None] | None:
    """3GPP's own location box, which is what some Android encoders write.

    Version and flags, a language code, a null-terminated name, then a role byte
    and three 16.16 fixed-point components in longitude, latitude, altitude
    order - which is the opposite way round from every other box here.
    """
    start, end = span
    at = start + 4 + 2
    while at < end and buf[at] != 0:
        at += 1
    at += 1 + 1  # the terminator, then the role byte
    if at + 12 > end:
        return None
    lon, lat, alt = (struct.unpack(">i", buf[at + i * 4:at + i * 4 + 4])[0] / 65536.0
                     for i in range(3))
    return lat, lon, alt


def _valid(fix) -> tuple[float | None, float | None, float | None]:
    if not fix:
        return None, None, None
    lat, lon, alt = fix
    if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
        return None, None, None
    if lat == 0.0 and lon == 0.0:  # null island: a missing fix, not a location
        return None, None, None
    return lat, lon, alt


def _wall(dt: datetime.datetime) -> int:
    return calendar.timegm(dt.timetuple())


def _parse_day(text: str) -> int | None:
    """Apple's `©day`, which is an ISO 8601 stamp carrying the phone's offset.

    The offset is read and then thrown away on purpose: this app stores the wall
    clock that was on the device, exactly as it does for EXIF, so a clip shot at
    15:00 in Tokyo and one shot at 15:00 in Paris both read back as 15:00.
    """
    match = re.match(r"(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})", text or "")
    if not match:
        return None
    try:
        return _wall(datetime.datetime(*(int(g) for g in match.groups())))
    except ValueError:
        return None


def _mvhd(buf: bytes, span: tuple[int, int]) -> tuple[int | None, float | None]:
    """(creation time, duration in seconds) out of the movie header."""
    start, end = span
    if start + 4 > end:
        return None, None
    version = buf[start]
    try:
        if version == 1:
            created, = struct.unpack(">Q", buf[start + 4:start + 12])
            scale, = struct.unpack(">I", buf[start + 20:start + 24])
            length, = struct.unpack(">Q", buf[start + 24:start + 32])
        else:
            created, = struct.unpack(">I", buf[start + 4:start + 8])
            scale, = struct.unpack(">I", buf[start + 12:start + 16])
            length, = struct.unpack(">I", buf[start + 16:start + 20])
    except struct.error:
        return None, None
    stamp = created - EPOCH_1904 if created > EPOCH_1904 else None
    seconds = round(length / scale, 2) if scale and length else None
    return stamp, seconds


def _tkhd(buf: bytes, span: tuple[int, int]) -> tuple[int, int] | None:
    """The display size of one track, rotation included.

    A phone records in landscape and writes a rotation into the track's display
    matrix, so the stored width and height are the wrong way round for a video
    shot upright. Players apply the matrix; so does this, because a portrait
    clip listed as landscape is wrong everywhere it is shown.
    """
    start, end = span
    if start + 4 > end:
        return None
    fixed = 4 + (32 if buf[start] == 1 else 20) + 16
    at = start + fixed
    if at + 36 + 8 > end:
        return None
    try:
        a, b = (struct.unpack(">i", buf[at + i * 4:at + i * 4 + 4])[0] / 65536.0 for i in range(2))
        width, height = (struct.unpack(">I", buf[at + 36 + i * 4:at + 36 + i * 4 + 4])[0] / 65536.0
                         for i in range(2))
    except struct.error:
        return None
    if not width or not height:
        return None  # a sound or subtitle track has no display size
    rotation = round(math.degrees(math.atan2(b, a))) % 360
    if rotation in (90, 270):
        width, height = height, width
    return int(round(width)), int(round(height))


def _moov(path: str) -> dict:
    """Every leaf of interest, by box type. Empty if there is no readable moov.

    The box may be at either end of the file - a finished recording usually
    carries it at the front, one written straight off a camera at the back - so
    the top level is walked by its own sizes rather than searched for.
    """
    found: dict = {}
    with open(path, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        end = fh.tell()
        offset = 0
        while offset + 8 <= end:
            fh.seek(offset)
            header = fh.read(16)
            if len(header) < 8:
                return found
            size = int.from_bytes(header[0:4], "big")
            kind = header[4:8]
            head = 8
            if size == 1:
                size = int.from_bytes(header[8:16], "big")
                head = 16
            elif size == 0:
                size = end - offset
            if size < head or offset + size > end:
                return found
            if kind == b"moov":
                if size - head > MOOV_MAX:
                    return found
                fh.seek(offset + head)
                buf = fh.read(size - head)
                _walk(buf, 0, len(buf), 0, found)
                found["_buf"] = buf
                return found
            offset += size
    return found


def read(path: str) -> dict:
    """Metadata for one video file, in the shape `photometa.read` returns.

    Never raises: an unreadable container still belongs in the index, the same
    way an unreadable image does.
    """
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
        "error": None,
    }

    boxes: dict = {}
    try:
        boxes = _moov(path)
    except Exception as exc:
        meta["error"] = f"{type(exc).__name__}: {exc}"
    buf = boxes.pop("_buf", b"")

    if buf:
        try:
            created, seconds = (_mvhd(buf, boxes[b"mvhd"][0]) if b"mvhd" in boxes else (None, None))
            meta["duration"] = seconds

            # The largest track that has a display size. A phone writes one
            # video track and one sound track, and only one of them has pixels.
            sizes = [size for span in boxes.get(b"tkhd", []) if (size := _tkhd(buf, span))]
            if sizes:
                meta["width"], meta["height"] = max(sizes, key=lambda s: s[0] * s[1])

            fix = None
            for span in boxes.get(b"\xa9xyz", []):
                fix = fix or _from_iso6709(_text(buf, span, in_ilst=False) or "")
            # The same tag again, wrapped in `data`, which is where a QuickTime
            # file keeps it. Read second so a plain udta box wins.
            for span in boxes.get(b"data", []):
                fix = fix or _from_iso6709(_text(buf, span, in_ilst=True) or "")
            for span in boxes.get(b"loci", []):
                fix = fix or _from_loci(buf, span)
            meta["lat"], meta["lon"], meta["altitude"] = _valid(fix)

            # `©day` carries the wall clock the phone had, which is the scale
            # this app stores. `mvhd` is nominally UTC and in practice whatever
            # the encoder felt like, so it ranks below the filename - the same
            # order photometa uses, and for the same measured reason.
            for span in boxes.get(b"\xa9day", []):
                stamp = _parse_day(_text(buf, span, in_ilst=False) or "")
                if stamp:
                    meta["taken_ts"], meta["taken_src"] = stamp, "video"
                    break
            if meta["taken_ts"] is None:
                named, _ = nametime.parse(meta["filename"])
                if named is not None:
                    meta["taken_ts"], meta["taken_src"] = named, "filename"
                elif created:
                    meta["taken_ts"], meta["taken_src"] = created, "video"
        except Exception as exc:
            meta["error"] = meta["error"] or f"moov: {exc}"

    if meta["taken_ts"] is None:
        named, _ = nametime.parse(meta["filename"])
        if named is not None:
            meta["taken_ts"], meta["taken_src"] = named, "filename"
        else:
            meta["taken_ts"] = _wall(datetime.datetime.fromtimestamp(stat.st_mtime))
            meta["taken_src"] = "mtime"

    return meta
