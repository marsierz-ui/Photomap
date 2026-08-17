"""Collect what a phone left in the bucket, without the app being open.

The app watches the bucket while it is running. This is the same job for the rest
of the time: one look, one sync if there is anything new, then exit. Meant to be
run by a scheduled task.

    python collect.py               one pass, then exit
    python collect.py --install     register a task that runs it every 15 minutes
    python collect.py --remove      remove that task
    python collect.py --status      show whether the task exists

Nothing here is a daemon. A scheduled task that starts a process and lets it
finish is far easier to reason about - and to stop - than a service, and the work
itself is a few seconds long.
"""
import argparse
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

TASK_NAME = "Photo Map collector"
DEFAULT_PORT = 8712


def app_is_running(port: int) -> bool:
    """Whether the app already has this covered.

    It watches the bucket itself while it is open, and two processes syncing the
    same library at the same time is worth avoiding: they would both drain the
    inbox and both write the manifest. A listening port is the cheapest honest
    signal that it is there.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.4)
        try:
            return probe.connect_ex(("127.0.0.1", port)) == 0
        except OSError:
            return False


def collect(verbose: bool = True) -> int:
    from backend import db, sync

    db.init()
    port = int(db.get_setting("server_port", DEFAULT_PORT) or DEFAULT_PORT)

    def say(message: str) -> None:
        if verbose:
            print(message, flush=True)

    if app_is_running(port):
        say(f"Photo Map is open on port {port} - it is collecting already.")
        return 0
    if not sync.configured():
        say("R2 is not set up, so there is nothing to collect from.")
        return 0
    if db.get_setting("cloud_watch_enabled", "1") != "1":
        say("Collecting by itself is switched off in the app.")
        return 0

    # The same key-tracking the in-app watcher uses, and the same record: an
    # import still waiting for its full-resolution half keeps its inbox key on
    # purpose, so counting rather than tracking would sync on every single run.
    started = sync._watch_once()
    if not started:
        say("Nothing new in the bucket.")
        return 0

    say("Found something new - syncing…")
    while sync.status()["running"]:
        time.sleep(0.2)
    state = sync.status()
    if state.get("error"):
        print(f"Sync finished with an error: {state['error']}", file=sys.stderr)
        return 1
    received = state.get("received") or {}
    say(f"Done. Imported {received.get('imported', 0)}, "
        f"albums {received.get('albums', 0)}, favourites {received.get('favourites', 0)}.")
    return 0


def _python_for_task() -> Path:
    """pythonw, so a run started by the scheduler flashes no console window."""
    windowless = Path(sys.executable).with_name("pythonw.exe")
    return windowless if windowless.exists() else Path(sys.executable)


def install(minutes: int) -> int:
    if os.name != "nt":
        print("--install writes a Windows scheduled task. On another system, point "
              "cron at:\n  " + f"{sys.executable} {ROOT / 'collect.py'}", file=sys.stderr)
        return 1
    command = f'"{_python_for_task()}" "{ROOT / "collect.py"}"'
    result = subprocess.run(
        ["schtasks", "/Create", "/TN", TASK_NAME, "/SC", "MINUTE", "/MO", str(minutes),
         "/TR", command, "/F"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(result.stdout or result.stderr, file=sys.stderr)
        return result.returncode
    print(f"Installed. '{TASK_NAME}' runs every {minutes} minutes, whether or not the "
          f"app is open.\nIt does nothing while the app is running, and nothing when "
          f"the bucket is empty.")
    return 0


def remove() -> int:
    if os.name != "nt":
        print("Nothing to remove: --install only writes a task on Windows.", file=sys.stderr)
        return 1
    result = subprocess.run(["schtasks", "/Delete", "/TN", TASK_NAME, "/F"],
                            capture_output=True, text=True)
    print((result.stdout or result.stderr).strip())
    return result.returncode


def status() -> int:
    if os.name != "nt":
        print("Task scheduling here is Windows only.", file=sys.stderr)
        return 1
    result = subprocess.run(["schtasks", "/Query", "/TN", TASK_NAME],
                            capture_output=True, text=True)
    print((result.stdout or result.stderr).strip())
    return result.returncode


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", action="store_true", help="register the scheduled task")
    parser.add_argument("--remove", action="store_true", help="remove the scheduled task")
    parser.add_argument("--status", action="store_true", help="is the task registered?")
    parser.add_argument("--every", type=int, default=15, help="minutes between runs")
    parser.add_argument("--quiet", action="store_true", help="say nothing unless it fails")
    args = parser.parse_args()

    if args.install:
        raise SystemExit(install(args.every))
    if args.remove:
        raise SystemExit(remove())
    if args.status:
        raise SystemExit(status())
    raise SystemExit(collect(verbose=not args.quiet))
