"""Checking saved searches, background jobs and the auto-check scheduler."""
from __future__ import annotations

import logging
import threading
import time
import uuid

from .search import run_search

log = logging.getLogger(__name__)
VERIFY_GONE_LIMIT = 25   # listings per check whose disappearance is confirmed with Reverb


def check_saved_search(store, client, search_id: int, progress=None, sold_lookup_groups: int = 8) -> dict:
    s = store.get_search(search_id)
    if not s:
        raise KeyError(f"saved search {search_id} not found")
    try:
        result = run_search(s["params"], client, progress=progress, sold_lookup_groups=sold_lookup_groups)
        current = {l["id"] for l in result["listings"]} | {l["id"] for l in result["excluded"]}
        missing = sorted(store.active_listing_ids(search_id) - current)
        states = {}
        for i, lid in enumerate(missing[:VERIFY_GONE_LIMIT]):
            if progress:
                progress(f"Checking listings that disappeared ({i + 1}/{min(len(missing), VERIFY_GONE_LIMIT)})", 0.95)
            try:
                states[lid] = client.listing_state(lid) or "removed"
            except Exception as e:
                log.warning("state lookup for %s failed: %s", lid, e)
        diff = store.record_check(search_id, result, states)
    except Exception as e:
        store.update_search(search_id, last_error=str(e), last_checked_at=time.time())
        raise
    return diff


class Jobs:
    """Runs searches/checks in background threads so the page can show progress."""

    def __init__(self):
        self._jobs: dict[str, dict] = {}
        self._lock = threading.Lock()
        self.check_lock = threading.Lock()   # one Reverb-heavy job at a time

    def start(self, kind: str, fn, *args, meta: dict | None = None) -> str:
        job_id = uuid.uuid4().hex[:12]
        job = {**(meta or {}), "id": job_id, "kind": kind, "status": "queued", "message": "Waiting…", "progress": 0.0,
               "result": None, "error": None, "started": time.time()}
        with self._lock:
            self._jobs[job_id] = job
            # forget old finished jobs
            for k in [k for k, j in self._jobs.items() if j["status"] in ("done", "error")
                      and time.time() - j["started"] > 3600]:
                del self._jobs[k]

        def progress(msg, frac=None):
            job["message"] = msg
            if frac is not None:
                job["progress"] = frac

        def run():
            with self.check_lock:
                job["status"] = "running"
                try:
                    job["result"] = fn(*args, progress=progress)
                    job["status"] = "done"
                except Exception as e:  # shown to the user
                    log.exception("job %s failed", kind)
                    job["error"] = str(e)
                    job["status"] = "error"
        threading.Thread(target=run, daemon=True, name=f"job-{kind}").start()
        return job_id

    def get(self, job_id: str) -> dict | None:
        return self._jobs.get(job_id)

    def running_check_ids(self) -> set:
        return {j.get("search_id") for j in self._jobs.values() if j["status"] in ("queued", "running")}


class Scheduler(threading.Thread):
    """Re-checks saved searches whose last check is older than the interval."""

    def __init__(self, store, client_for, interval_hours: float, jobs: Jobs, sold_lookup_groups=8, tick=60):
        super().__init__(daemon=True, name="auto-check")
        self.store, self.client_for, self.jobs = store, client_for, jobs
        self.interval_hours = interval_hours
        self.sold_lookup_groups = sold_lookup_groups
        self.tick = tick
        self._stop = threading.Event()

    def due(self, now=None) -> list[int]:
        if self.interval_hours <= 0:
            return []
        now = now or time.time()
        out = []
        for s in self.store.list_searches():
            if s["auto_check"] and (not s["last_checked_at"] or now - s["last_checked_at"] >= self.interval_hours * 3600):
                out.append(s["id"])
        return out

    def run(self):
        while not self._stop.wait(self.tick):
            for sid in self.due():
                s = self.store.get_search(sid)
                if not s:
                    continue
                log.info("auto-checking saved search %s (%s)", sid, s["name"])
                try:
                    with self.jobs.check_lock:
                        check_saved_search(self.store, self.client_for(s["params"].get("region")), sid,
                                           sold_lookup_groups=self.sold_lookup_groups)
                except Exception as e:
                    log.warning("auto-check of %s failed: %s", sid, e)

    def stop(self):
        self._stop.set()
