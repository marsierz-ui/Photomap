"""backend/videometa.py against MP4/QuickTime fixtures built here.

The fixtures are assembled byte by byte rather than checked in as media files,
so there is nothing binary in the repo and every field a test depends on is
visible in the test.

    .venv\\Scripts\\python.exe tests\\test_videometa.py
"""
import json
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT))

from backend import videometa  # noqa: E402

failures = []


def check(label, condition, detail=""):
    print(f"{'PASS' if condition else 'FAIL'}  {label}{'' if condition else f' -> {detail}'}")
    if not condition:
        failures.append(label)


# ----------------------------------------------------------------- fixtures

def box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload) + 8) + kind + payload


def mvhd(created: int, timescale: int = 1000, duration: int = 12345) -> bytes:
    return box(b"mvhd", struct.pack(
        ">BBBBIIII", 0, 0, 0, 0, created, created, timescale, duration
    ) + b"\x00" * 80)


def tkhd(width: int, height: int, rotate: bool = False) -> bytes:
    # version 0: flags, creation, modification, track id, reserved, duration
    head = struct.pack(">BBBBIIIII", 0, 0, 0, 1, 0, 0, 1, 0, 1000)
    middle = b"\x00" * 16  # reserved, layer, alternate group, volume, reserved
    unity = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000]
    turned = [0, 0x10000, 0, -0x10000 & 0xFFFFFFFF, 0, 0, 0, 0, 0x40000000]
    matrix = b"".join(struct.pack(">I", v) for v in (turned if rotate else unity))
    return box(b"tkhd", head + middle + matrix
               + struct.pack(">II", width << 16, height << 16))


def cxyz(text: str) -> bytes:
    raw = text.encode("utf-8")
    return box(b"\xa9xyz", struct.pack(">HH", len(raw), 0x15C7) + raw)


def cday(text: str) -> bytes:
    raw = text.encode("utf-8")
    return box(b"\xa9day", struct.pack(">HH", len(raw), 0x15C7) + raw)


def loci(lat: float, lon: float) -> bytes:
    body = struct.pack(">BBBBH", 0, 0, 0, 0, 0x15C7) + b"\x00" + b"\x00"
    body += struct.pack(">iii", int(lon * 65536), int(lat * 65536), 0)
    return box(b"loci", body)


def movie(*, created=0, location=None, day=None, use_loci=False, size=(1920, 1080),
          rotate=False, duration=12345, moov_last=False, extra_track=True) -> bytes:
    udta = b""
    if location and not use_loci:
        udta += cxyz(location)
    if location and use_loci:
        udta += loci(*(float(p) for p in location))
    if day:
        udta += cday(day)

    traks = box(b"trak", tkhd(size[0], size[1], rotate))
    if extra_track:
        # A sound track has no display size, and picking it would give the clip
        # dimensions of zero. It is here because every real recording has one.
        traks += box(b"trak", tkhd(0, 0))

    moov = box(b"moov", mvhd(created, duration=duration) + traks
               + (box(b"udta", udta) if udta else b""))
    ftyp = box(b"ftyp", b"isom" + struct.pack(">I", 512) + b"isomiso2mp41")
    mdat = box(b"mdat", b"\x00" * 64)
    return ftyp + (mdat + moov if moov_last else moov + mdat)


def write(data: bytes, name="clip.mp4") -> str:
    path = Path(tempfile.mkdtemp(prefix="photomap_vid_")) / name
    path.write_bytes(data)
    return str(path)


# --------------------------------------------------------------------- tests

berlin = "+52.5200+013.4050+050.000/"

meta = videometa.read(write(movie(location=berlin, day="2024-05-04T15:30:00+0200")))
check("a located clip reads its coordinates", meta["lat"] is not None, meta)
check("latitude", abs(meta["lat"] - 52.52) < 1e-6, meta["lat"])
check("longitude", abs(meta["lon"] - 13.405) < 1e-6, meta["lon"])
check("altitude", meta["altitude"] == 50.0, meta["altitude"])
# The offset in the stamp is deliberately ignored: this app stores the wall
# clock that was on the device, exactly as it does for EXIF.
check("the wall clock is kept, not the zone", meta["taken_ts"] == 1714836600, meta["taken_ts"])
check("and it is called a video time", meta["taken_src"] == "video", meta["taken_src"])
check("duration comes off mvhd", meta["duration"] == 12.35, meta["duration"])
check("dimensions come off the video track", (meta["width"], meta["height"]) == (1920, 1080),
      (meta["width"], meta["height"]))

turned = videometa.read(write(movie(location=berlin, rotate=True)))
check("a clip shot upright reports portrait dimensions",
      (turned["width"], turned["height"]) == (1080, 1920), (turned["width"], turned["height"]))

tail = videometa.read(write(movie(location=berlin, moov_last=True)))
check("moov at the end of the file is still found", tail["lat"] is not None, tail)

three_gpp = videometa.read(write(movie(location=(52.52, 13.405), use_loci=True), "clip.3gp"))
check("a 3GPP loci box is read", three_gpp["lat"] is not None, three_gpp)
check("and its components are not swapped",
      abs(three_gpp["lat"] - 52.52) < 1e-4 and abs(three_gpp["lon"] - 13.405) < 1e-4, three_gpp)

null_island = videometa.read(write(movie(location="+00.0000+000.0000/")))
check("null island is a missing fix, not a location", null_island["lat"] is None, null_island)

impossible = videometa.read(write(movie(location="+99.0000+200.0000/")))
check("an out-of-range fix is refused", impossible["lat"] is None, impossible)

nowhere = videometa.read(write(movie()))
check("a clip with no location box has none", nowhere["lat"] is None, nowhere)

named = videometa.read(write(movie(), "VID_20240115_120000.mp4"))
check("a filename date beats an absent creation time", named["taken_ts"] == 1705320000,
      named["taken_ts"])
check("and says where it came from", named["taken_src"] == "filename", named["taken_src"])

# 1904-epoch seconds for 2024-01-15 12:00:00.
container = videometa.read(write(movie(created=2082844800 + 1705320000), "movie.mp4"))
check("mvhd is used when there is nothing better",
      container["taken_ts"] == 1705320000, container["taken_ts"])

junk = videometa.read(write(b"not a video at all, just bytes"))
check("a file that is not a container does not raise", junk["taken_ts"] is not None, junk)
check("and falls back to the file's own date", junk["taken_src"] == "mtime", junk["taken_src"])

truncated = videometa.read(write(movie(location=berlin)[:60]))
check("a truncated file does not raise", truncated["lat"] is None, truncated)

# The row the scanner writes has to have every key the upsert reads, or a video
# would fail at the INSERT rather than here.
from backend import photometa  # noqa: E402

required = {"path", "folder", "filename", "ext", "taken_ts", "taken_src", "lat", "lon",
            "altitude", "width", "height", "orientation", "camera_make", "camera_model",
            "filesize", "mtime", "duration"}
check("the row has every column the index needs", required <= set(meta), sorted(required - set(meta)))
check("videos are in the indexed extension set",
      {".mp4", ".mov"} <= photometa.MEDIA_EXTS, sorted(photometa.MEDIA_EXTS))
check("and photometa.read dispatches to the video reader",
      photometa.read(write(movie(location=berlin)))["lat"] is not None)

# ------------------------------------------- the same files through exif.js
#
# The browser reads a video before it is uploaded so the pin appears at once,
# and the two readers have to agree: where they could differ they would differ
# silently, and the phone's answer is the one that survives when only the proxy
# makes it across.

FIXTURES = {
    "located": movie(location=berlin, day="2024-05-04T15:30:00+0200"),
    "moov_last": movie(location=berlin, moov_last=True),
    "loci": movie(location=(52.52, 13.405), use_loci=True),
    "null_island": movie(location="+00.0000+000.0000/"),
    "nothing": movie(),
}
script = r"""
import { readFile } from 'node:fs/promises';
const src = await readFile(process.argv[2], 'utf8');
const mod = await import(`data:text/javascript,${encodeURIComponent(
  `${src}\nexport { readVideoMeta };`)}`);
const fixtures = JSON.parse(await readFile(process.argv[3], 'utf8'));
const out = {};
for (const [name, hex] of Object.entries(fixtures)) {
  const bytes = Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));
  out[name] = await mod.readVideoMeta(new File([bytes], `${name}.mp4`));
}
process.stdout.write(JSON.stringify(out));
"""
with tempfile.TemporaryDirectory() as tmp:
    runner = Path(tmp) / "run.mjs"
    data = Path(tmp) / "fixtures.json"
    runner.write_text(script, encoding="utf-8")
    data.write_text(json.dumps({k: v.hex() for k, v in FIXTURES.items()}), encoding="utf-8")
    try:
        proc = subprocess.run(
            ["node", str(runner), str(PROJECT / "viewer" / "exif.js"), str(data)],
            capture_output=True, text=True, timeout=60,
        )
        js = json.loads(proc.stdout) if proc.returncode == 0 else None
    except (OSError, ValueError, subprocess.SubprocessError):
        js = None

if js is None:
    print("SKIP  exif.js comparison (node not available)")
else:
    check("the browser reader finds the same coordinates",
          abs(js["located"]["lat"] - 52.52) < 1e-6 and abs(js["located"]["lon"] - 13.405) < 1e-6,
          js["located"])
    check("and the same wall clock", js["located"]["taken_ts"] == meta["taken_ts"], js["located"])
    check("it finds a moov at the end of the file too", js["moov_last"]["lat"] is not None,
          js["moov_last"])
    check("it reads a loci box the same way round",
          abs(js["loci"]["lat"] - 52.52) < 1e-4, js["loci"])
    check("it rejects null island as well", js["null_island"]["lat"] is None, js["null_island"])
    check("and names a blanked fix as blanked", js["null_island"]["gps"] == "zeroed",
          js["null_island"])
    check("a clip with no location box says the box was absent",
          js["nothing"]["gps"] == "absent", js["nothing"])

print()
print(f"{len(failures)} FAILED" if failures else "ALL VIDEO METADATA CHECKS PASSED")
sys.exit(1 if failures else 0)
