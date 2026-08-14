"""On-demand thumbnail and preview cache."""
import os
import threading
from pathlib import Path

from PIL import Image, ImageOps

from . import db
from .photometa import IMAGE_EXTS  # noqa: F401  (registers HEIF/AVIF openers)

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
