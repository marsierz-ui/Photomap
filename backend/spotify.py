"""Spotify account connection: saves what you listen to from now on, by itself.

Spotify's Web API only tells an app about the last 50 plays
(`/v1/me/player/recently-played`), about two and a half hours of music, so
history is collected by asking every POLL_S while this app runs and keeping
everything in music_plays, beside what the data download brought in. Hours
of listening while this computer is off can fall out of that window; the data
download fills such gaps.

Sign-in is OAuth with PKCE, which needs no client secret: the person creates
their own app in Spotify's developer dashboard and pastes its Client ID here,
which is also what keeps each installation inside the dashboard's own user
limits. Spotify accepts plain http only for a loopback address written as an
IP, never `localhost`, so the redirect is to 127.0.0.1 and connecting has to
happen in a browser on the computer running this app. The refresh token is
kept with the other secrets and never sent to a browser.
"""
import base64
import hashlib
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from . import db, music, tracks

AUTHORIZE = "https://accounts.spotify.com/authorize"
TOKEN = "https://accounts.spotify.com/api/token"
RECENT = "https://api.spotify.com/v1/me/player/recently-played"
SCOPE = "user-read-recently-played"
# 50 plays is about two and a half hours of music; half an hour keeps well inside it.
POLL_S = 30 * 60
MAX_PAGES = 10

_pending: dict[str, str] = {}  # state -> PKCE verifier, for sign-ins under way
_access = {"token": None, "expires": 0.0}
_state = {"error": None, "last_sync": None, "last_added": 0}
_sync_lock = threading.Lock()
_poller = None


def redirect_uri() -> str:
    return f"http://127.0.0.1:{os.environ.get('PHOTOMAP_PORT', '8712')}/api/spotify/callback"


def client_id() -> str:
    return (db.get_setting("spotify_client_id") or "").strip()


def connected() -> bool:
    return bool(client_id() and db.get_setting("spotify_refresh_token"))


def status() -> dict:
    return {"client_id": client_id(), "connected": connected(), "redirect_uri": redirect_uri(),
            "error": _state["error"], "last_sync": _state["last_sync"], "last_added": _state["last_added"],
            "poll_minutes": POLL_S // 60}


def set_client_id(value: str) -> dict:
    value = (value or "").strip()
    if value and not value.isalnum():
        raise ValueError("A Client ID is letters and digits only")
    if value != client_id():
        db.set_setting("spotify_refresh_token", "")
        _access.update(token=None, expires=0.0)
    db.set_setting("spotify_client_id", value)
    return status()


def login_url() -> str:
    if not client_id():
        raise ValueError("Paste the Client ID of your Spotify app first")
    verifier = secrets.token_urlsafe(64)[:96]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)
    _pending[state] = verifier
    return AUTHORIZE + "?" + urllib.parse.urlencode({
        "response_type": "code", "client_id": client_id(), "scope": SCOPE, "redirect_uri": redirect_uri(),
        "code_challenge_method": "S256", "code_challenge": challenge, "state": state,
    })


def _token(form: dict) -> dict:
    req = urllib.request.Request(TOKEN, data=urllib.parse.urlencode(form).encode(),
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def _keep(answer: dict) -> None:
    _access.update(token=answer["access_token"], expires=time.time() + int(answer.get("expires_in", 3600)) - 60)
    if answer.get("refresh_token"):
        db.set_setting("spotify_refresh_token", answer["refresh_token"])


def finish_login(code: str, state: str) -> None:
    verifier = _pending.pop(state, None)
    if not verifier:
        raise ValueError("This sign-in was not started here, or has expired. Start it again from Settings.")
    _keep(_token({"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri(),
                  "client_id": client_id(), "code_verifier": verifier}))
    _state["error"] = None
    threading.Thread(target=sync, daemon=True).start()


def disconnect() -> dict:
    db.set_setting("spotify_refresh_token", "")
    _access.update(token=None, expires=0.0)
    return status()


def _access_token() -> str:
    if _access["token"] and time.time() < _access["expires"]:
        return _access["token"]
    _keep(_token({"grant_type": "refresh_token", "refresh_token": db.get_setting("spotify_refresh_token"),
                  "client_id": client_id()}))
    return _access["token"]


def _http(url: str, token: str) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def _get(url: str) -> dict:
    return _http(url, _access_token())


def plays_of(items: list[dict]) -> list[tuple]:
    """Rows for music_plays. Spotify does not say whether `played_at` is when a
    song started or ended; it is taken as the end, like the data download's
    `ts`, so a play is placed at most one song's length out. The API gives no
    time actually listened, so the song's length stands in for it."""
    out = []
    for item in items:
        t = item.get("track") or {}
        end = tracks._utc(item.get("played_at"))
        if not t.get("name") or end is None:
            continue
        artist = ", ".join(a.get("name", "") for a in t.get("artists") or [] if a.get("name")) or None
        out.append((end, int(t.get("duration_ms") or 0) or 1, t["name"], artist,
                    (t.get("album") or {}).get("name"), t.get("uri")))
    return out


def sync() -> int:
    """Fetch every play since the last one saved. Returns how many were new."""
    if not connected() or not _sync_lock.acquire(blocking=False):
        return 0
    try:
        after = db.get_setting("spotify_after_ms") or ""
        url = RECENT + "?" + urllib.parse.urlencode({"limit": 50, **({"after": after} if after else {})})
        added, newest = 0, int(after or 0)
        for _ in range(MAX_PAGES):
            page = _get(url)
            rows = plays_of(page.get("items") or [])
            added += music.store(rows)
            newest = max([newest, *(r[0] * 1000 for r in rows)])
            url = page.get("next")
            if not url or not rows:
                break
        if newest:
            db.set_setting("spotify_after_ms", str(newest))
        _state.update(error=None, last_sync=int(time.time()), last_added=added)
        return added
    except urllib.error.HTTPError as exc:
        _state["error"] = ("Spotify refused the saved sign-in: connect again" if exc.code in (400, 401)
                           else f"Spotify answered {exc.code}")
        if exc.code in (400, 401):
            _access.update(token=None, expires=0.0)
        return 0
    except Exception as exc:  # offline: tried again on the next round
        _state["error"] = str(exc)
        return 0
    finally:
        _sync_lock.release()


def _poll() -> None:
    while True:
        time.sleep(60)
        if connected() and time.time() - (_state["last_sync"] or 0) >= POLL_S:
            sync()


def start_polling() -> None:
    global _poller
    if _poller is None:
        _poller = threading.Thread(target=_poll, daemon=True)
        _poller.start()
