import json
import threading
import time
import urllib.request

from conftest import FakeClient, load
from tracker.config import Config, load_config
from tracker.server import App, make_server
from tracker.store import Store


def call(base, method, path, body=None, auth=None):
    req = urllib.request.Request(base + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **({"Authorization": auth} if auth else {})})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def wait(base, job_id):
    for _ in range(100):
        j = call(base, "GET", f"/api/jobs/{job_id}")
        if j["status"] in ("done", "error"):
            return j
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def serve(tmp_path, password=""):
    cfg = Config(db_path=str(tmp_path / "s.db"), password=password, open_browser=False)
    app = App(cfg, store=Store(cfg.db_path),
              client_factory=lambda region: FakeClient([load("listings_ibanez_rg550_genesis.json")]))
    srv = make_server(app, "127.0.0.1", 0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


def test_search_save_and_check_flow(tmp_path):
    srv, base = serve(tmp_path)
    try:
        assert call(base, "GET", "/api/config")["defaults"]["scan_limit"] == 250
        job = call(base, "POST", "/api/search", {"params": {"query": "Ibanez RG550 Genesis"}})["job_id"]
        done = wait(base, job)
        assert done["status"] == "done" and done["result"]["summary"]["kept"] > 40
        saved = call(base, "POST", "/api/saved", {"name": "G", "params": done["result"]["params"], "from_job": job})
        assert saved["job_id"] is None                        # reused the search as the first check
        cards = call(base, "GET", "/api/saved")["searches"]
        assert cards[0]["name"] == "G" and cards[0]["checks"] == 1
        check = call(base, "POST", f"/api/saved/{saved['id']}/check")["job_id"]
        assert wait(base, check)["status"] == "done"
        hist = call(base, "GET", f"/api/saved/{saved['id']}/history")
        assert len(hist["checks"]) == 2
        got = call(base, "GET", f"/api/saved/{saved['id']}")
        assert got["result"]["listings"]
        with urllib.request.urlopen(base + "/") as r:
            assert b"Guitar Price Tracker" in r.read()
    finally:
        srv.shutdown()


def test_basic_auth(tmp_path):
    srv, base = serve(tmp_path, password="s3cret")
    try:
        try:
            call(base, "GET", "/api/config")
            raise AssertionError("expected 401")
        except urllib.error.HTTPError as e:
            assert e.code == 401
        import base64
        tok = "Basic " + base64.b64encode(b"admin:s3cret").decode()
        assert "defaults" in call(base, "GET", "/api/config", auth=tok)
    finally:
        srv.shutdown()


def test_config_env_overrides(tmp_path):
    (tmp_path / "config.json").write_text('{"port": 9000, "check_interval_hours": 2}')
    cfg = load_config(tmp_path / "config.json", env={"RT_CHECK_INTERVAL_HOURS": "12", "REVERB_TOKEN": "x"})
    assert cfg.port == 9000 and cfg.check_interval_hours == 12 and cfg.reverb_token == "x"
    hosted = load_config(tmp_path / "nope.json", env={"PORT": "10000"})
    assert hosted.port == 10000 and hosted.host == "0.0.0.0" and hosted.open_browser is False
