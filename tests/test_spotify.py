"""Spotify account connection: PKCE sign-in, token refresh, saving recent plays.
Spotify itself is replaced by stand-ins; nothing leaves the machine.

    .venv\\Scripts\\python.exe tests\\test_spotify.py
"""
import base64
import hashlib
import sys
import tempfile
import urllib.error
import urllib.parse
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT))
DATA = Path(tempfile.mkdtemp(prefix="photomap_spotify_")) / "data"
DATA.mkdir()

from backend import db  # noqa: E402

db.DATA_DIR = DATA
db.DB_PATH = DATA / "photomap.db"
db.THUMB_DIR = DATA / "thumbs"
db.TRASH_DIR = DATA / "trash"

from starlette.requests import Request  # noqa: E402

from backend import main, music, spotify  # noqa: E402

failures = []


def check(label, condition, detail=""):
    print(f"{'PASS' if condition else 'FAIL'}  {label}{'' if condition else f' -> {detail}'}")
    if not condition:
        failures.append(label)


tokens = []


def fake_token(form):
    tokens.append(form)
    if form["grant_type"] == "refresh_token" and form["refresh_token"] == "revoked":
        raise urllib.error.HTTPError(spotify.TOKEN, 400, "invalid_grant", {}, None)
    return {"access_token": f"access-{len(tokens)}", "expires_in": 3600,
            **({"refresh_token": "refresh-1"} if form["grant_type"] == "authorization_code" else {})}


def item(track, played_at, uri):
    return {"track": {"name": track, "artists": [{"name": "Band"}, {"name": "Guest"}], "album": {"name": "LP"},
                      "uri": uri, "duration_ms": 180_000}, "played_at": played_at}


pages = {
    "first": {"items": [item("Song A", "2024-05-01T10:03:00.000Z", "spotify:track:a"),
                        item("Song B", "2024-05-01T10:06:00.000Z", "spotify:track:b")], "next": "page2"},
    "page2": {"items": [item("Song C", "2024-05-01T10:09:00.000Z", "spotify:track:c")], "next": None},
}
asked = []


def fake_http(url, token):
    asked.append(url)
    return pages["page2"] if url == "page2" else pages["first"] if "after" not in url else {"items": [], "next": None}


spotify._token = fake_token
spotify._http = fake_http

try:
    spotify.set_client_id("not valid!")
    check("a bad Client ID is refused", False)
except ValueError:
    check("a bad Client ID is refused", True)
spotify.set_client_id("abc123")
url = spotify.login_url()
q = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
check("redirect is a loopback IP, not localhost", q["redirect_uri"].startswith("http://127.0.0.1:"), q["redirect_uri"])
check("asks only for recent plays", q["scope"] == "user-read-recently-played", q["scope"])
verifier = spotify._pending[q["state"]]
expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
check("PKCE challenge matches its verifier", q["code_challenge"] == expected and q["code_challenge_method"] == "S256")

try:
    spotify.finish_login("code", "someone-elses-state")
    check("a sign-in not started here is refused", False)
except ValueError:
    check("a sign-in not started here is refused", True)
spotify.sync = lambda: 0  # finish_login syncs in a thread; run it by hand below instead
spotify.finish_login("the-code", q["state"])
check("code exchanged with the verifier", tokens[-1]["code_verifier"] == verifier and tokens[-1]["code"] == "the-code")
check("refresh token kept", db.get_setting("spotify_refresh_token") == "refresh-1")
check("refresh token never reaches the browser",
      "spotify_refresh_token" not in main.get_config(Request({"type": "http", "headers": [], "client": ("127.0.0.1", 1)}))["settings"])
check("connected", main.spotify_status()["connected"])

import importlib  # noqa: E402

spotify_sync = importlib.reload(spotify)  # the real sync again, with the stand-ins put back
spotify_sync._token = fake_token
spotify_sync._http = fake_http
main.spotify = spotify_sync
spotify_sync._access.update(token=None, expires=0)
added = spotify_sync.sync()
check("every page saved", added == 3 and music.status()["playable"] == 3, (added, music.status()))
check("the access token was refreshed first", tokens[-1]["grant_type"] == "refresh_token")
check("cursor kept at the newest play", db.get_setting("spotify_after_ms") == str(1714558140 * 1000),
      db.get_setting("spotify_after_ms"))
row = db.connect().execute("SELECT * FROM music_plays WHERE track='Song B'").fetchone()
check("artists joined, song length as time played", row["artist"] == "Band, Guest" and row["ms"] == 180_000, dict(row))
check("the next round asks only after the cursor", spotify_sync.sync() == 0 and "after=1714558140000" in asked[-1],
      asked[-1])

db.set_setting("spotify_refresh_token", "revoked")
spotify_sync._access.update(token=None, expires=0)
spotify_sync._state["last_sync"] = None
spotify_sync.sync()
check("a revoked sign-in says to connect again", "connect again" in (spotify_sync.status()["error"] or ""),
      spotify_sync.status())
import io  # noqa: E402

db.set_setting("spotify_refresh_token", "refresh-1")
spotify_sync._state["error"] = None


def forbidden(url, token):
    raise urllib.error.HTTPError(url, 403, "Forbidden", {}, io.BytesIO(
        b'{"error": {"status": 403, "message": "User not registered in the Developer Dashboard"}}'))


spotify_sync._http = forbidden
spotify_sync.sync()
err = spotify_sync.status()["error"] or ""
check("a 403 shows Spotify's own reason and what to check",
      "User not registered" in err and "Premium" in err and "User Management" in err, err)
check("disconnect forgets the account", not spotify_sync.disconnect()["connected"])

print()
print("FAILED:" if failures else "All passed.", ", ".join(failures))
sys.exit(1 if failures else 0)
