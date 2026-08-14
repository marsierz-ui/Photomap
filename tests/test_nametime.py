"""Filename date extraction: real-world formats must parse, ID-like numbers must not."""
import datetime
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend import nametime  # noqa: E402


def ts(y, mo, d, h=12, mi=0, s=0):
    import calendar
    return calendar.timegm(datetime.datetime(y, mo, d, h, mi, s).timetuple())


SHOULD_PARSE = [
    # (filename, expected timestamp) - shapes taken from the real library
    ("20180613_214221 (2023_02_22 20_13_06 UTC).jpg", ts(2018, 6, 13, 21, 42, 21)),
    ("IMG-20230118-WA0000 (2023_12_21 09_40_11 UTC).jpg", ts(2023, 1, 18)),
    ("IMG_20250812_130813.jpg", ts(2025, 8, 12, 13, 8, 13)),
    ("Resized_20200817_193920_2841 (2023_02_22 20_13_06 UTC).jpg", ts(2020, 8, 17, 19, 39, 20)),
    ("IMG-20240123-WA0001.jpg", ts(2024, 1, 23)),
    ("20250426_160626.jpg", ts(2025, 4, 26, 16, 6, 26)),
    ("Screenshot_20240810-210743 (2025_03_30 19_51_00 UTC).jpg", ts(2024, 8, 10, 21, 7, 43)),
    ("Screenshot_2020-07-14-19-44-48 (2023_02_22 20_13_06 UTC).jpg", ts(2020, 7, 14, 19, 44, 48)),
    ("20220510_131214_01 (2023_02_22 20_13_06 UTC).jpg", ts(2022, 5, 10, 13, 12, 14)),
    ("20210516_201243 (1) (2023_02_22 20_13_06 UTC).jpg", ts(2021, 5, 16, 20, 12, 43)),
    ("20200707_110023(1) (2023_02_22 20_13_06 UTC).jpg", ts(2020, 7, 7, 11, 0, 23)),
    ("20250528_151407(0).jpg", ts(2025, 5, 28, 15, 14, 7)),
    ("20220614 (1) (2023_02_22 20_13_06 UTC).jpg", ts(2022, 6, 14)),
    ("IMG_20241026_144738_936 (2) (2025_03_30 19_51_00 UTC).jpg", ts(2024, 10, 26, 14, 47, 38)),
    ("VID_20230313_011400_holiday.jpg", ts(2023, 3, 13, 1, 14, 0)),
    ("photo_2023-07-12 15.43.05.jpg", ts(2023, 7, 12, 15, 43, 5)),
    ("Signal-2023-03-12-190300.jpg", ts(2023, 3, 12, 19, 3, 0)),
]

SHOULD_NOT_PARSE = [
    "Studniowka-grupowe-01.jpg",
    "DSC_0002 (2023_02_22 20_13_06 UTC).jpg",
    "DSCF1534 (2023_02_22 20_13_06 UTC).JPG",
    "P1020268.JPG",
    "IMG_0091.HEIC",
    "28LO  (1).jpg",
    "10430558 (2024_07_22 12_29_45 UTC).jpg",
    # Facebook-style IDs: long digit runs that must not look like dates
    "243372711_617454389422126_7857460652433655256_n.jpg",
    "FullSizeRender-1 (2024_06_06 19_48_30 UTC).jpg",
    "99999999.jpg",
    "20259999.jpg",     # valid-looking year, impossible month/day
    "20231345.jpg",     # month 13, day 45
]

failures = []

print("should parse:")
for name, expected in SHOULD_PARSE:
    got, label = nametime.parse(name)
    ok = got == expected
    when = datetime.datetime.utcfromtimestamp(got).strftime("%Y-%m-%d %H:%M:%S") if got else "None"
    print(f"  {'ok ' if ok else 'BAD'} {name[:52]:<54} -> {when} [{label}]")
    if not ok:
        want = datetime.datetime.utcfromtimestamp(expected).strftime("%Y-%m-%d %H:%M:%S")
        failures.append(f"{name}: got {when}, wanted {want}")

print("\nshould NOT parse (no date, or an ID that only looks like one):")
for name in SHOULD_NOT_PARSE:
    got, label = nametime.parse(name)
    ok = got is None
    when = datetime.datetime.utcfromtimestamp(got).strftime("%Y-%m-%d %H:%M:%S") if got else "-"
    print(f"  {'ok ' if ok else 'BAD'} {name[:52]:<54} -> {when} [{label}]")
    if not ok:
        failures.append(f"{name}: wrongly parsed as {when} via {label}")

print()
if failures:
    print(f"{len(failures)} FAILED")
    for f in failures:
        print(f"  {f}")
    sys.exit(1)
print(f"ALL {len(SHOULD_PARSE) + len(SHOULD_NOT_PARSE)} FILENAME CHECKS PASSED")
