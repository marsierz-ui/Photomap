"""Start the Photo Map server.

    python serve.py             local only, http://127.0.0.1:8712
    python serve.py --lan       also reachable from other devices on your network
"""
import argparse
import os
import threading
import webbrowser

parser = argparse.ArgumentParser()
parser.add_argument("--lan", action="store_true", help="listen on every interface so phones and laptops can connect")
parser.add_argument("--host", default=None, help="explicit bind address (overrides --lan)")
parser.add_argument("--port", type=int, default=8712)
parser.add_argument("--no-browser", action="store_true")
parser.add_argument("--reload", action="store_true")
parser.add_argument("--new-key", action="store_true", help="generate a fresh access key and exit")
args = parser.parse_args()

host = args.host or ("0.0.0.0" if args.lan else "127.0.0.1")
shared = host not in ("127.0.0.1", "localhost", "::1")

os.environ["PHOTOMAP_PORT"] = str(args.port)
if shared:
    os.environ["PHOTOMAP_REQUIRE_KEY"] = "1"

import uvicorn  # noqa: E402

from backend import auth, db, netinfo  # noqa: E402

db.init()  # first run: the schema has to exist before the access key is read
# Recorded so collect.py can tell whether this app is already open and watching
# the bucket, and stay out of the way if it is.
db.set_setting("server_port", args.port)

if args.new_key:
    print(f"New access key: {auth.reset()}")
    raise SystemExit(0)

local_url = f"http://127.0.0.1:{args.port}/"
print(f"\n  Photo Map\n  On this computer:  {local_url}")

if shared:
    key = auth.token()
    urls = netinfo.share_urls(key)
    if urls:
        print("\n  On your phone or laptop (same Wi-Fi):")
        for url in urls:
            print(f"    {url}")
        print(f"\n  Access key: {key}")
        try:
            import qrcode

            qr = qrcode.QRCode(border=1)
            qr.add_data(urls[0])
            print()
            qr.print_ascii(invert=True)
        except ImportError:
            print("  (pip install qrcode for a scannable QR code here)")
    else:
        print("\n  No network address found - is this machine connected to Wi-Fi?")
    print(
        "  If another device cannot connect, Windows Firewall is blocking the port.\n"
        "  In an ADMIN PowerShell, run:\n"
        f"    New-NetFirewallRule -DisplayName 'Photo Map' -Direction Inbound "
        f"-Action Allow -Protocol TCP -LocalPort {args.port} -Profile Private\n"
    )

if not args.no_browser:
    threading.Timer(1.2, webbrowser.open, args=(local_url,)).start()

uvicorn.run("backend.main:app", host=host, port=args.port, reload=args.reload, log_level="warning")
