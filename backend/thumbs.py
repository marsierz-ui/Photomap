"""On-demand thumbnail and preview cache."""
import io
import os
import shutil
import subprocess
import threading
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

from . import db
from .photometa import IMAGE_EXTS, is_video  # noqa: F401  (registers HEIF/AVIF openers)

# A frame out of a video needs a decoder, and the only one worth depending on is
# the one that may already be on the machine. Looked up once: `which` on every
# thumbnail of a 26,000-item library is 26,000 path searches.
FFMPEG = shutil.which("ffmpeg")
# A second in is past the black frame most recordings start on, and short enough
# that seeking costs nothing. A clip shorter than that falls back to the start.
FRAME_AT = ("1", "0")
FRAME_TIMEOUT = 20  # seconds; a wedged ffmpeg must not hold a request open

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        lock = _locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _locks[key] = lock
        return lock


def cache_path(photo_id: int, size: int) -> Path:
    return db.THUMB_DIR / str(size) / str(photo_id // 1000) / f"{photo_id}.jpg"


def _frame(src: str, into: Path) -> bool:
    """One frame of a video, written as a JPEG. False if it could not be had.

    ffmpeg applies the track's display matrix itself, so a clip shot upright
    comes out upright without anything here knowing about rotation.
    """
    if not FFMPEG:
        return False
    for at in FRAME_AT:
        try:
            result = subprocess.run(
                [FFMPEG, "-v", "error", "-ss", at, "-i", src, "-frames:v", "1",
                 "-f", "image2", "-y", str(into)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=FRAME_TIMEOUT,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except (OSError, subprocess.SubprocessError):
            return False
        if result.returncode == 0 and into.exists() and into.stat().st_size > 0:
            return True
    return False


def _placeholder(size: int) -> Image.Image:
    """What a video looks like when there is no decoder to look inside it.

    Drawn rather than left blank: a tile with nothing in it reads as a broken
    thumbnail, and the gallery, the map preview and the cloud snapshot all
    expect an image. Installing ffmpeg and clearing the thumbnail cache turns
    these into real frames with no other change.
    """
    img = Image.new("RGB", (size, size), (26, 30, 38))
    draw = ImageDraw.Draw(img)
    mid, arm = size / 2, size / 7
    draw.polygon(
        [(mid - arm * 0.6, mid - arm), (mid - arm * 0.6, mid + arm), (mid + arm, mid)],
        fill=(120, 132, 148),
    )
    return img


def adopt(photo_id: int, jpeg: bytes, size: int) -> None:
    """Take a poster that arrived with an upload as this item's thumbnail.

    A phone draws the first frame of a video into a canvas and sends it as the
    proxy, which is the only picture of that video this machine may ever be able
    to make - `ffmpeg` is not a dependency and may not be here.
    """
    out = cache_path(photo_id, size)
    try:
        with Image.open(io.BytesIO(jpeg)) as img:
            img = ImageOps.exif_transpose(img)
            img.thumbnail((size, size), Image.LANCZOS)
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            out.parent.mkdir(parents=True, exist_ok=True)
            tmp = out.with_suffix(".tmp")
            img.save(tmp, "JPEG", quality=84, optimize=True)
            os.replace(tmp, out)
    except Exception:
        pass  # the poster was a bonus; build() falls back to a drawn tile


def build(photo_id: int, src: str, size: int) -> Path | None:
    """Return a cached JPEG of at most `size` px on the long edge."""
    out = cache_path(photo_id, size)
    if out.exists() and out.stat().st_size > 0:
        return out
    if not os.path.exists(src):
        return None

    with _lock_for(f"{photo_id}:{size}"):
        if out.exists() and out.stat().st_size > 0:
            return out
        if is_video(src):
            return _build_video(src, out, size)
        try:
            with Image.open(src) as img:
                img = ImageOps.exif_transpose(img)
                img.thumbnail((size, size), Image.LANCZOS)
                if img.mode not in ("RGB", "L"):
                    img = img.convert("RGB")
                out.parent.mkdir(parents=True, exist_ok=True)
                tmp = out.with_suffix(".tmp")
                img.save(tmp, "JPEG", quality=84, optimize=True)
                os.replace(tmp, out)
        except Exception:
            return None
    return out


def _build_video(src: str, out: Path, size: int) -> Path | None:
    """The caller already holds this item's lock."""
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    # Named rather than a mkstemp handle: an open descriptor on Windows is a
    # lock, and ffmpeg has to be able to write this file itself. The item's own
    # lock is what keeps two of these apart.
    raw = out.with_suffix(".frame.jpg")
    try:
        try:
            with (Image.open(raw) if _frame(src, raw) else _placeholder(size)) as img:
                img.thumbnail((size, size), Image.LANCZOS)
                if img.mode not in ("RGB", "L"):
                    img = img.convert("RGB")
                img.save(tmp, "JPEG", quality=84, optimize=True)
        finally:
            raw.unlink(missing_ok=True)
        os.replace(tmp, out)
    except Exception:
        tmp.unlink(missing_ok=True)
        return None
    return out


def drop(photo_id: int) -> None:
    for size_dir in db.THUMB_DIR.glob("*"):
        try:
            size = int(size_dir.name)
        except ValueError:
            continue
        path = cache_path(photo_id, size)
        if path.exists():
            try:
                path.unlink()
            except OSError:
                pass


def clear_all() -> int:
    removed = 0
    for path in db.THUMB_DIR.rglob("*.jpg"):
        try:
            path.unlink()
            removed += 1
        except OSError:
            pass
    return removed
