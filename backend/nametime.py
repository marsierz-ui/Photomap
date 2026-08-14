"""Recover capture times from filenames.

Measured against the real library (26,729 photos): EXIF disagrees with the
filename in 2 cases out of 20,896, while the file-modified fallback disagrees in
2,945 out of 5,833 (median error 164 days). So the precedence is
EXIF > filename > file date, and a filename date only ever replaces a file date.

Deliberately rule-based rather than model-based: the formats are a short, closed
set, and rules are exact, instant, offline and free. See `unmatched()` for the
tail that no rule covers.
"""
import calendar
import datetime
import os
import re

THIS_YEAR = datetime.date.today().year

# Google Takeout appends the export moment, which is not a capture time.
TAKEOUT = re.compile(r"\s*\(\d{4}_\d{2}_\d{2}[ _]\d{2}_\d{2}_\d{2}\s*UTC\)")
# Trailing " (1)", "(2)", "(0)" copy markers.
COPY_MARK = re.compile(r"\s*\(\d{1,3}\)\s*$")

Y = r"(19[7-9]\d|20[0-4]\d)"          # 1970-2049
SEP = r"[-_.:]?"

PATTERNS = [
    # 20180613_214221 / 20180613-214221 / 20180613 214221 / IMG_20250812_130813
    ("datetime", re.compile(rf"(?<!\d){Y}(\d{{2}})(\d{{2}})[-_. T]?(\d{{2}})(\d{{2}})(\d{{2}})(?!\d)")),
    # 2020-07-14-19-44-48 / 2020_07_14 19.44.48
    ("datetime_sep", re.compile(
        rf"(?<!\d){Y}{SEP}(\d{{2}}){SEP}(\d{{2}})[-_. T]+(\d{{2}}){SEP}(\d{{2}}){SEP}(\d{{2}})(?!\d)")),
    # 20230118 (WhatsApp IMG-20230118-WA0000, and other date-only names)
    ("date", re.compile(rf"(?<!\d){Y}(\d{{2}})(\d{{2}})(?!\d)")),
    # 2023-01-18
    ("date_sep", re.compile(rf"(?<!\d){Y}[-_.](\d{{2}})[-_.](\d{{2}})(?!\d)")),
]


def _build(groups) -> int | None:
    try:
        year, month, day = int(groups[0]), int(groups[1]), int(groups[2])
        hour, minute, second = (
            (int(groups[3]), int(groups[4]), int(groups[5])) if len(groups) > 3 else (12, 0, 0)
        )
        dt = datetime.datetime(year, month, day, hour, minute, second)
    except (ValueError, IndexError):
        return None
    if not (1970 <= dt.year <= THIS_YEAR + 1):
        return None
    # Wall-clock seconds, matching how the rest of the app stores capture times.
    return calendar.timegm(dt.timetuple())


def parse(filename: str) -> tuple[int | None, str | None]:
    """Return (timestamp, pattern name) for a filename, or (None, None)."""
    stem = os.path.splitext(filename)[0]
    stem = TAKEOUT.sub("", stem)
    stem = COPY_MARK.sub("", stem)
    for label, pattern in PATTERNS:
        for match in pattern.finditer(stem):
            ts = _build(match.groups())
            if ts is not None:
                return ts, label
    return None, None


def unmatched(filenames) -> list[str]:
    """Filenames no rule recognises - the list to look at before adding patterns."""
    return [name for name in filenames if parse(name)[0] is None]
