#!/usr/bin/env python3
"""Reverb Guitar Price Tracker - start with:  python app.py

Opens http://127.0.0.1:8765 in your browser. Settings: config.json or env vars
(see README.md). Needs Python 3.10+ and nothing else.
"""
import logging
import sys
import threading
import webbrowser

if sys.version_info < (3, 10):
    sys.exit("Python 3.10 or newer is required (you have %s)." % sys.version.split()[0])

from tracker.config import load_config  # noqa: E402
from tracker.server import App, make_server  # noqa: E402


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = load_config()
    app = App(cfg)
    try:
        srv = make_server(app, cfg.host, cfg.port)
    except OSError as e:
        sys.exit(f"Could not start on {cfg.host}:{cfg.port} ({e}). Is it already running? "
                 "Set RT_PORT to use another port.")
    app.start_scheduler()
    shown_host = "127.0.0.1" if cfg.host in ("0.0.0.0", "") else cfg.host
    url = f"http://{shown_host}:{cfg.port}/"
    print(f"\n  Reverb Price Tracker is running at {url}")
    if cfg.check_interval_hours > 0:
        print(f"  Saved searches are re-checked every {cfg.check_interval_hours:g} hours while this runs.")
    if cfg.password:
        print(f"  Password protection is on (user: {cfg.username}).")
    print("  Press Ctrl+C to stop.\n")
    if cfg.open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
