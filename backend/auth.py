"""Access gate for non-loopback clients.

Binding to the LAN exposes the whole photo library, the folder browser and the
delete endpoints to every device on the network, so anything that is not talking
to us over loopback has to present the access key.
"""
import os
import secrets

from . import db

LOOPBACK = {"127.0.0.1", "::1", "localhost", ""}
COOKIE = "pm_key"


def required() -> bool:
    """True when the server was started on a non-loopback interface."""
    return os.environ.get("PHOTOMAP_REQUIRE_KEY") == "1"


def token() -> str:
    value = db.get_setting("access_token")
    if not value:
        value = secrets.token_urlsafe(9)
        db.set_setting("access_token", value)
    return value


def reset() -> str:
    db.set_setting("access_token", secrets.token_urlsafe(9))
    return token()


def valid(candidate: str | None) -> bool:
    return bool(candidate) and secrets.compare_digest(candidate, token())


LOGIN_PAGE = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Photo Map</title>
<style>
 body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
      background:#0e1116;color:#e6edf3;font:15px/1.5 system-ui,"Segoe UI",sans-serif}
 form{background:#161b22;border:1px solid #2a323d;border-radius:8px;padding:28px;
      width:min(360px,90vw);text-align:center}
 h1{font-size:18px;margin:0 0 4px}
 p{color:#8b97a6;font-size:13px;margin:0 0 18px}
 input{width:100%;box-sizing:border-box;background:#1c232d;border:1px solid #2a323d;
       border-radius:6px;padding:11px;color:inherit;font:inherit;text-align:center;
       letter-spacing:1px;margin-bottom:12px}
 button{width:100%;background:#4aa3ff;border:0;border-radius:6px;padding:11px;
        color:#06121f;font:600 15px system-ui;cursor:pointer}
 .err{color:#ff9ea1;font-size:13px;margin-bottom:12px}
</style></head>
<body><form method="get" action="/">
  <h1>Photo Map</h1>
  <p>This library is shared over your local network.</p>
  __ERROR__
  <input name="k" placeholder="Access key" autofocus autocomplete="off"
         autocapitalize="off" autocorrect="off" spellcheck="false">
  <button type="submit">Unlock</button>
</form></body></html>
"""


def login_page(bad_attempt: bool) -> str:
    return LOGIN_PAGE.replace(
        "__ERROR__", '<div class="err">That key was not right.</div>' if bad_attempt else ""
    )
