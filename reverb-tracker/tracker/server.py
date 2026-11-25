"""HTTP server (stdlib) serving the single-page UI and a small JSON API."""
from __future__ import annotations

import base64
import hmac
import json
import logging
import mimetypes
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from . import market
from .reverb import ReverbClient
from .search import DEFAULT_PARAMS, SCAN_LIMITS, normalize_params, run_search
from .store import Store
from .tracking import Jobs, Scheduler, check_saved_search

log = logging.getLogger(__name__)
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

REGIONS = [
    ("US_CON", "United States (lower 48)", "US"),
    ("US_AK", "Alaska", "US"), ("US_HI", "Hawaii", "US"),
    ("CA", "Canada", "CA"), ("GB", "United Kingdom", "GB"), ("AU", "Australia", "AU"),
    ("DE", "Germany", "DE"), ("FR", "France", "FR"), ("NL", "Netherlands", "NL"),
    ("IT", "Italy", "IT"), ("ES", "Spain", "ES"), ("JP", "Japan", "JP"),
]
REGION_COUNTRY = {code: cc for code, _, cc in REGIONS}


class App:
    def __init__(self, config, store: Store | None = None, client_factory=None):
        self.config = config
        self.store = store or Store(config.db_path)
        self.jobs = Jobs()
        self._clients: dict[str, ReverbClient] = {}
        self._client_lock = threading.Lock()
        self._client_factory = client_factory
        self.scheduler = None

    def client_for(self, region: str | None = None):
        region = region or self.config.region
        if self._client_factory:
            return self._client_factory(region)
        with self._client_lock:
            if region not in self._clients:
                self._clients[region] = ReverbClient(
                    currency=self.config.currency, region=region,
                    country_code=REGION_COUNTRY.get(region, self.config.country_code),
                    token=self.config.reverb_token, request_interval=self.config.request_interval,
                    cache=self.store)
            return self._clients[region]

    def start_scheduler(self):
        self.scheduler = Scheduler(self.store, self.client_for, self.config.check_interval_hours, self.jobs,
                                   sold_lookup_groups=self.config.sold_lookup_groups)
        self.scheduler.start()

    # -- job bodies ---------------------------------------------------------
    def _search_job(self, params, progress=None):
        return run_search(params, self.client_for(params.get("region")), progress=progress,
                          sold_lookup_groups=self.config.sold_lookup_groups)

    def _check_job(self, search_id, progress=None):
        s = self.store.get_search(search_id)
        diff = check_saved_search(self.store, self.client_for(s["params"].get("region")), search_id,
                                  progress=progress, sold_lookup_groups=self.config.sold_lookup_groups)
        return {"search_id": search_id, "diff": _diff_counts(diff)}

    def _check_all_job(self, progress=None):
        out = []
        searches = self.store.list_searches()
        for i, s in enumerate(searches):
            def sub(msg, frac=None, i=i):
                if progress:
                    progress(f"[{i + 1}/{len(searches)}] {s['name']}: {msg}",
                             (i + (frac or 0)) / max(1, len(searches)))
            try:
                diff = check_saved_search(self.store, self.client_for(s["params"].get("region")), s["id"],
                                          progress=sub, sold_lookup_groups=self.config.sold_lookup_groups)
                out.append({"search_id": s["id"], "diff": _diff_counts(diff)})
            except Exception as e:
                out.append({"search_id": s["id"], "error": str(e)})
        return out


def _diff_counts(diff):
    return {k: (len(v) if isinstance(v, list) else v) for k, v in diff.items()}


class Handler(BaseHTTPRequestHandler):
    app: App = None  # set by make_server
    server_version = "ReverbTracker/1.0"

    def log_message(self, fmt, *args):
        log.debug("%s - %s", self.address_string(), fmt % args)

    # -- helpers ------------------------------------------------------------
    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith(("text", "application/j")) else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _json_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8"))

    def _authorized(self) -> bool:
        cfg = self.app.config
        if not cfg.password:
            return True
        h = self.headers.get("Authorization") or ""
        if h.startswith("Basic "):
            try:
                user, _, pw = base64.b64decode(h[6:]).decode("utf-8").partition(":")
            except Exception:
                return False
            return hmac.compare_digest(pw, cfg.password) and hmac.compare_digest(user, cfg.username)
        return False

    def _guard(self) -> bool:
        if self._authorized():
            return True
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="Reverb Price Tracker"')
        self.send_header("Content-Length", "0")
        self.end_headers()
        return False

    # -- routing ------------------------------------------------------------
    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method):
        if not self._guard():
            return
        path = urlparse(self.path).path
        try:
            for m, pattern, fn in ROUTES:
                if m != method:
                    continue
                match = re.fullmatch(pattern, path)
                if match:
                    return fn(self, *match.groups())
            if method == "GET":
                return self._static(path)
            self._send(404, {"error": "not found"})
        except ValueError as e:
            self._send(400, {"error": str(e)})
        except KeyError as e:
            self._send(404, {"error": f"not found: {e}"})
        except Exception as e:  # pragma: no cover
            log.exception("request failed")
            self._send(500, {"error": str(e)})

    def _static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        f = (STATIC_DIR / path.lstrip("/")).resolve()
        if STATIC_DIR not in f.parents or not f.is_file():
            return self._send(404, {"error": "not found"})
        ctype = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
        self._send(200, f.read_bytes(), ctype)

    # -- API ----------------------------------------------------------------
    def api_config(self):
        c = self.app.config
        self._send(200, {
            "defaults": {**DEFAULT_PARAMS, "region": c.region},
            "regions": [{"code": code, "name": name} for code, name, _ in REGIONS],
            "scan_limits": SCAN_LIMITS,
            "currency": c.currency,
            "check_interval_hours": c.check_interval_hours,
            "token_configured": bool(c.reverb_token),
            "thresholds": {
                "labels": [[b if b != float("inf") else None, l] for b, l in market.LABELS],
                "high": market.HIGH_CONFIDENCE, "medium": market.MEDIUM_CONFIDENCE,
                "min_comps": market.MIN_COMPS_TO_RATE, "verify_below": market.VERIFY_BELOW,
                "wide_spread": market.WIDE_SPREAD,
            },
        })

    def api_search(self):
        params = normalize_params(self._json_body().get("params") or {})
        if not params["query"]:
            raise ValueError("Type something to search for, e.g. Ibanez RG")
        job = self.app.jobs.start("search", self.app._search_job, params)
        self._send(200, {"job_id": job})

    def api_job(self, job_id):
        job = self.app.jobs.get(job_id)
        if not job:
            raise KeyError(job_id)
        self._send(200, job)

    def api_saved_list(self):
        cards = [self.app.store.search_card(s["id"]) for s in self.app.store.list_searches()]
        running = self.app.jobs.running_check_ids()
        for c in cards:
            c["checking"] = c["id"] in running
        self._send(200, {"searches": cards, "check_interval_hours": self.app.config.check_interval_hours})

    def api_saved_create(self):
        body = self._json_body()
        params = normalize_params(body.get("params") or {})
        if not params["query"]:
            raise ValueError("A saved search needs a query")
        name = (body.get("name") or params["query"]).strip()[:120]
        sid = self.app.store.create_search(name, params)
        job = None
        src = self.app.jobs.get(body.get("from_job") or "")
        if src and src.get("status") == "done" and src.get("result") and \
                normalize_params(src["result"]["params"]) == params:
            self.app.store.record_check(sid, src["result"])      # first check = the search just shown
        else:
            job = self.app.jobs.start("check", self.app._check_job, sid, meta={"search_id": sid})
        self._send(200, {"id": sid, "job_id": job})

    def api_saved_get(self, sid):
        sid = int(sid)
        card = self.app.store.search_card(sid)
        if not card:
            raise KeyError(sid)
        self._send(200, {"search": card, "result": self.app.store.latest_result(sid)})

    def api_saved_update(self, sid):
        body = self._json_body()
        fields = {}
        if "name" in body:
            fields["name"] = str(body["name"]).strip()[:120] or "Saved search"
        if "auto_check" in body:
            fields["auto_check"] = int(bool(body["auto_check"]))
        if "params" in body:
            fields["params"] = normalize_params(body["params"])
        self.app.store.update_search(int(sid), **fields)
        self._send(200, {"ok": True})

    def api_saved_delete(self, sid):
        self.app.store.delete_search(int(sid))
        self._send(200, {"ok": True})

    def api_saved_viewed(self, sid):
        self.app.store.update_search(int(sid), last_viewed_at=time.time())
        self._send(200, {"ok": True})

    def api_saved_check(self, sid):
        sid = int(sid)
        if not self.app.store.get_search(sid):
            raise KeyError(sid)
        job = self.app.jobs.start("check", self.app._check_job, sid, meta={"search_id": sid})
        self._send(200, {"job_id": job})

    def api_saved_check_all(self):
        job = self.app.jobs.start("check_all", self.app._check_all_job)
        self._send(200, {"job_id": job})

    def api_saved_history(self, sid):
        sid = int(sid)
        st = self.app.store
        if not st.get_search(sid):
            raise KeyError(sid)
        self._send(200, {"series": st.model_series(sid), "events": st.events(sid),
                         "checks": st.checks(sid), "gone": st.gone_listings(sid)})


ROUTES = [
    ("GET", r"/api/config", Handler.api_config),
    ("POST", r"/api/search", Handler.api_search),
    ("GET", r"/api/jobs/([0-9a-f]+)", Handler.api_job),
    ("GET", r"/api/saved", Handler.api_saved_list),
    ("POST", r"/api/saved", Handler.api_saved_create),
    ("POST", r"/api/saved/check-all", Handler.api_saved_check_all),
    ("GET", r"/api/saved/(\d+)", Handler.api_saved_get),
    ("PATCH", r"/api/saved/(\d+)", Handler.api_saved_update),
    ("DELETE", r"/api/saved/(\d+)", Handler.api_saved_delete),
    ("POST", r"/api/saved/(\d+)/viewed", Handler.api_saved_viewed),
    ("POST", r"/api/saved/(\d+)/check", Handler.api_saved_check),
    ("GET", r"/api/saved/(\d+)/history", Handler.api_saved_history),
]


def make_server(app: App, host: str, port: int) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {"app": app})
    srv = ThreadingHTTPServer((host, port), handler)
    srv.daemon_threads = True
    return srv
