"""SQLite storage: saved searches, check snapshots, listing price history, API cache."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS saved_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  params_json TEXT NOT NULL,
  created_at REAL NOT NULL,
  last_checked_at REAL,
  last_viewed_at REAL,
  auto_check INTEGER NOT NULL DEFAULT 1,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id INTEGER NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
  checked_at REAL NOT NULL,
  summary_json TEXT NOT NULL,
  result_json TEXT,
  baseline INTEGER NOT NULL DEFAULT 0,
  new_count INTEGER NOT NULL DEFAULT 0,
  drop_count INTEGER NOT NULL DEFAULT 0,
  gone_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS checks_search ON checks(search_id, checked_at);
CREATE TABLE IF NOT EXISTS tracked_listings (
  search_id INTEGER NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL,
  title TEXT, url TEXT, photo TEXT, group_key TEXT, group_name TEXT, condition TEXT,
  first_seen_at REAL NOT NULL, first_check_id INTEGER NOT NULL, baseline INTEGER NOT NULL DEFAULT 0,
  last_seen_at REAL NOT NULL, last_check_id INTEGER NOT NULL,
  first_total REAL, last_total REAL, prev_total REAL,
  status TEXT NOT NULL DEFAULT 'active',
  gone_at REAL,
  PRIMARY KEY (search_id, listing_id)
);
CREATE TABLE IF NOT EXISTS price_points (
  search_id INTEGER NOT NULL, listing_id TEXT NOT NULL, check_id INTEGER NOT NULL,
  checked_at REAL NOT NULL, total REAL,
  PRIMARY KEY (search_id, listing_id, check_id)
);
CREATE TABLE IF NOT EXISTS group_points (
  search_id INTEGER NOT NULL, check_id INTEGER NOT NULL, checked_at REAL NOT NULL,
  group_key TEXT NOT NULL, group_name TEXT, segment TEXT NOT NULL,
  count INTEGER, median REAL, p25 REAL, p75 REAL, min REAL, max REAL,
  PRIMARY KEY (search_id, check_id, group_key, segment)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id INTEGER NOT NULL, check_id INTEGER NOT NULL, at REAL NOT NULL,
  listing_id TEXT NOT NULL, kind TEXT NOT NULL, old_total REAL, new_total REAL
);
CREATE INDEX IF NOT EXISTS events_search ON events(search_id, at);
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, expires_at REAL NOT NULL
);
"""
KEEP_FULL_RESULTS = 3   # full result JSON kept for the latest N checks per search
GONE_STATES = ("sold", "ended", "removed", "missing")


class Store:
    def __init__(self, path: str):
        self.path = path
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._mem = sqlite3.connect(":memory:", check_same_thread=False) if path == ":memory:" else None
        self._lock = threading.RLock()
        with self.conn() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def conn(self):
        with self._lock:
            c = self._mem or sqlite3.connect(self.path, timeout=30)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA foreign_keys = ON")
            try:
                yield c
                c.commit()
            except Exception:
                c.rollback()
                raise
            finally:
                if self._mem is None:
                    c.close()

    # -- cache ---------------------------------------------------------------
    def cache_get(self, key):
        with self.conn() as c:
            row = c.execute("SELECT value_json, expires_at FROM cache WHERE key=?", (key,)).fetchone()
        if not row or row["expires_at"] < time.time():
            return None
        return json.loads(row["value_json"])

    def cache_set(self, key, value, ttl):
        with self.conn() as c:
            c.execute("INSERT OR REPLACE INTO cache VALUES (?,?,?)", (key, json.dumps(value), time.time() + ttl))

    # -- saved searches ------------------------------------------------------
    def create_search(self, name: str, params: dict) -> int:
        with self.conn() as c:
            cur = c.execute("INSERT INTO saved_searches (name, params_json, created_at, last_viewed_at) VALUES (?,?,?,?)",
                            (name, json.dumps(params), time.time(), time.time()))
            return cur.lastrowid

    def update_search(self, search_id: int, **fields):
        allowed = {"name", "auto_check", "last_viewed_at", "last_checked_at", "last_error"}
        sets, vals = [], []
        for k, v in fields.items():
            if k == "params":
                sets.append("params_json=?")
                vals.append(json.dumps(v))
            elif k in allowed:
                sets.append(f"{k}=?")
                vals.append(v)
        if sets:
            with self.conn() as c:
                c.execute(f"UPDATE saved_searches SET {', '.join(sets)} WHERE id=?", (*vals, search_id))

    def delete_search(self, search_id: int):
        with self.conn() as c:
            for t in ("price_points", "group_points", "events"):
                c.execute(f"DELETE FROM {t} WHERE search_id=?", (search_id,))
            c.execute("DELETE FROM saved_searches WHERE id=?", (search_id,))

    def _search_row(self, row) -> dict:
        d = dict(row)
        d["params"] = json.loads(d.pop("params_json"))
        d["auto_check"] = bool(d["auto_check"])
        return d

    def get_search(self, search_id: int) -> dict | None:
        with self.conn() as c:
            row = c.execute("SELECT * FROM saved_searches WHERE id=?", (search_id,)).fetchone()
        return self._search_row(row) if row else None

    def list_searches(self) -> list[dict]:
        with self.conn() as c:
            rows = c.execute("SELECT * FROM saved_searches ORDER BY created_at").fetchall()
        return [self._search_row(r) for r in rows]

    def search_card(self, search_id: int) -> dict | None:
        """Everything the saved-search card shows."""
        s = self.get_search(search_id)
        if not s:
            return None
        with self.conn() as c:
            last = c.execute("SELECT id, checked_at, summary_json FROM checks WHERE search_id=? "
                             "ORDER BY checked_at DESC LIMIT 1", (search_id,)).fetchone()
            since = s["last_viewed_at"] or 0
            new_since_view = c.execute(
                "SELECT COUNT(*) FROM tracked_listings WHERE search_id=? AND baseline=0 AND first_seen_at>? AND status='active'",
                (search_id, since)).fetchone()[0]
            drops_since_view = c.execute(
                "SELECT COUNT(DISTINCT listing_id) FROM events WHERE search_id=? AND kind='price_drop' AND at>?",
                (search_id, since)).fetchone()[0]
            gone_since_view = c.execute(
                "SELECT COUNT(*) FROM events WHERE search_id=? AND kind='gone' AND at>?",
                (search_id, since)).fetchone()[0]
            checks = c.execute("SELECT COUNT(*) FROM checks WHERE search_id=?", (search_id,)).fetchone()[0]
        s["checks"] = checks
        s["new_since_view"] = new_since_view
        s["drops_since_view"] = drops_since_view
        s["gone_since_view"] = gone_since_view
        s["summary"] = json.loads(last["summary_json"]) if last else None
        s["main_models"] = self.main_model_trends(search_id, limit=2) if last else []
        return s

    # -- checks --------------------------------------------------------------
    def record_check(self, search_id: int, result: dict, gone_states: dict | None = None,
                     now: float | None = None) -> dict:
        """Store a check and diff it against what was seen before.

        gone_states: listing_id -> Reverb state for previously-active listings that were
        not in this scan ('live' means still listed, just outside this scan).
        """
        now = now or time.time()
        gone_states = gone_states or {}
        listings = result["listings"]
        with self.conn() as c:
            prev_checks = c.execute("SELECT COUNT(*) FROM checks WHERE search_id=?", (search_id,)).fetchone()[0]
            baseline = prev_checks == 0
            summary = dict(result["summary"])
            cur = c.execute("INSERT INTO checks (search_id, checked_at, summary_json, result_json, baseline) "
                            "VALUES (?,?,?,?,?)", (search_id, now, "{}", None, int(baseline)))
            check_id = cur.lastrowid
            known = {r["listing_id"]: dict(r) for r in c.execute(
                "SELECT * FROM tracked_listings WHERE search_id=?", (search_id,))}
            new_ids, drops, ups, gone, back = [], [], [], [], []
            seen = set()
            for l in listings:
                lid = l["id"]
                seen.add(lid)
                total = l.get("total")
                k = known.get(lid)
                if k is None:
                    c.execute("""INSERT INTO tracked_listings (search_id, listing_id, title, url, photo, group_key,
                                 group_name, condition, first_seen_at, first_check_id, baseline, last_seen_at,
                                 last_check_id, first_total, last_total, prev_total, status)
                                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'active')""",
                              (search_id, lid, l["title"], l["url"], l.get("photo"), l["group_key"], l["group_name"],
                               l["condition"], now, check_id, int(baseline), now, check_id, total, total))
                    c.execute("INSERT INTO price_points VALUES (?,?,?,?,?)", (search_id, lid, check_id, now, total))
                    if not baseline:
                        new_ids.append(lid)
                        c.execute("INSERT INTO events (search_id, check_id, at, listing_id, kind, new_total) "
                                  "VALUES (?,?,?,?,?,?)", (search_id, check_id, now, lid, "new", total))
                    continue
                prev_total = k["last_total"]
                changed = total is not None and prev_total is not None and abs(total - prev_total) >= 0.01
                if k["status"] != "active":
                    back.append(lid)
                    c.execute("INSERT INTO events (search_id, check_id, at, listing_id, kind, new_total) "
                              "VALUES (?,?,?,?,?,?)", (search_id, check_id, now, lid, "back", total))
                c.execute("""UPDATE tracked_listings SET title=?, url=?, photo=?, group_key=?, group_name=?,
                             condition=?, last_seen_at=?, last_check_id=?, last_total=?, prev_total=?,
                             status='active', gone_at=NULL WHERE search_id=? AND listing_id=?""",
                          (l["title"], l["url"], l.get("photo"), l["group_key"], l["group_name"], l["condition"],
                           now, check_id, total, prev_total if changed else k["prev_total"], search_id, lid))
                if changed:
                    kind = "price_drop" if total < prev_total else "price_up"
                    (drops if kind == "price_drop" else ups).append(lid)
                    c.execute("INSERT INTO events (search_id, check_id, at, listing_id, kind, old_total, new_total) "
                              "VALUES (?,?,?,?,?,?,?)", (search_id, check_id, now, lid, kind, prev_total, total))
                    c.execute("INSERT INTO price_points VALUES (?,?,?,?,?)", (search_id, lid, check_id, now, total))
            for lid, k in known.items():
                if lid in seen or k["status"] != "active":
                    continue
                state = gone_states.get(lid, "missing")
                if state == "live":
                    continue   # still listed on Reverb, just outside this scan or filters
                status = state if state in GONE_STATES else "ended"
                gone.append(lid)
                c.execute("UPDATE tracked_listings SET status=?, gone_at=? WHERE search_id=? AND listing_id=?",
                          (status, now, search_id, lid))
                c.execute("INSERT INTO events (search_id, check_id, at, listing_id, kind, old_total, new_total) "
                          "VALUES (?,?,?,?,?,?,NULL)", (search_id, check_id, now, lid, "gone", k["last_total"]))
            for g in result["groups"]:
                for seg, st in (g.get("segments") or {}).items():
                    c.execute("INSERT INTO group_points VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                              (search_id, check_id, now, g["key"], g["name"], seg, st["count"], st["median"],
                               st["p25"], st["p75"], st["min"], st["max"]))
            summary.update(baseline=baseline, new=len(new_ids), price_drops=len(drops), price_ups=len(ups),
                           gone=len(gone), back=len(back))
            c.execute("UPDATE checks SET summary_json=?, result_json=?, new_count=?, drop_count=?, gone_count=? "
                      "WHERE id=?", (json.dumps(summary), json.dumps(result), len(new_ids), len(drops),
                                     len(gone), check_id))
            c.execute("""UPDATE checks SET result_json=NULL WHERE search_id=? AND id NOT IN
                         (SELECT id FROM checks WHERE search_id=? ORDER BY checked_at DESC LIMIT ?)""",
                      (search_id, search_id, KEEP_FULL_RESULTS))
            c.execute("UPDATE saved_searches SET last_checked_at=?, last_error=NULL WHERE id=?", (now, search_id))
        return {"check_id": check_id, "baseline": baseline, "new": new_ids, "price_drops": drops,
                "price_ups": ups, "gone": gone, "back": back}

    def active_listing_ids(self, search_id: int) -> set[str]:
        with self.conn() as c:
            return {r[0] for r in c.execute(
                "SELECT listing_id FROM tracked_listings WHERE search_id=? AND status='active'", (search_id,))}

    def latest_result(self, search_id: int) -> dict | None:
        """Latest stored result, annotated with tracking info (new since view, price history)."""
        s = self.get_search(search_id)
        with self.conn() as c:
            row = c.execute("SELECT id, checked_at, result_json, summary_json FROM checks WHERE search_id=? "
                            "AND result_json IS NOT NULL ORDER BY checked_at DESC LIMIT 1", (search_id,)).fetchone()
            if not row:
                return None
            tracked = {r["listing_id"]: dict(r) for r in c.execute(
                "SELECT * FROM tracked_listings WHERE search_id=?", (search_id,))}
        result = json.loads(row["result_json"])
        result["summary"] = json.loads(row["summary_json"])
        since = (s or {}).get("last_viewed_at") or 0
        for l in result["listings"]:
            t = tracked.get(l["id"])
            if not t:
                continue
            l["first_seen_at"] = t["first_seen_at"]
            l["new_since_view"] = not t["baseline"] and t["first_seen_at"] > since
            if t["prev_total"] is not None and t["last_total"] is not None and t["last_total"] < t["prev_total"]:
                l["tracked_was_total"] = t["prev_total"]
            if t["first_total"] is not None and t["last_total"] is not None and t["last_total"] < t["first_total"]:
                l["tracked_first_total"] = t["first_total"]
        result["checked_at"] = row["checked_at"]
        result["check_id"] = row["id"]
        return result

    # -- history -------------------------------------------------------------
    def model_series(self, search_id: int, segment: str | None = None) -> list[dict]:
        """Median over time per model group (and segment)."""
        with self.conn() as c:
            rows = c.execute("SELECT * FROM group_points WHERE search_id=? ORDER BY checked_at", (search_id,)).fetchall()
        series = {}
        for r in rows:
            if segment and r["segment"] != segment:
                continue
            key = (r["group_key"], r["segment"])
            s = series.setdefault(key, {"group_key": r["group_key"], "group_name": r["group_name"],
                                        "segment": r["segment"], "points": []})
            s["points"].append({"t": r["checked_at"], "median": r["median"], "count": r["count"],
                                "p25": r["p25"], "p75": r["p75"]})
        out = list(series.values())
        out.sort(key=lambda s: -(s["points"][-1]["count"] if s["points"] else 0))
        return out

    def main_model_trends(self, search_id: int, limit: int = 2) -> list[dict]:
        series = self.model_series(search_id)
        return [{"group_name": s["group_name"], "segment": s["segment"],
                 "median": s["points"][-1]["median"], "count": s["points"][-1]["count"],
                 "spark": [p["median"] for p in s["points"]][-30:]} for s in series[:limit]]

    def events(self, search_id: int, limit: int = 300) -> list[dict]:
        with self.conn() as c:
            rows = c.execute("""SELECT e.*, t.title, t.url, t.photo, t.group_name, t.condition, t.status
                                FROM events e LEFT JOIN tracked_listings t
                                ON t.search_id=e.search_id AND t.listing_id=e.listing_id
                                WHERE e.search_id=? ORDER BY e.at DESC, e.id DESC LIMIT ?""",
                             (search_id, limit)).fetchall()
        return [dict(r) for r in rows]

    def checks(self, search_id: int) -> list[dict]:
        with self.conn() as c:
            rows = c.execute("SELECT id, checked_at, summary_json, baseline, new_count, drop_count, gone_count "
                             "FROM checks WHERE search_id=? ORDER BY checked_at", (search_id,)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["summary"] = json.loads(d.pop("summary_json"))
            out.append(d)
        return out

    def gone_listings(self, search_id: int) -> list[dict]:
        with self.conn() as c:
            rows = c.execute("SELECT * FROM tracked_listings WHERE search_id=? AND status!='active' "
                             "ORDER BY gone_at DESC", (search_id,)).fetchall()
        return [dict(r) for r in rows]
