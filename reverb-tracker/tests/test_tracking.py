import copy

from conftest import FakeClient, load
from tracker.search import run_search
from tracker.store import Store
from tracker.tracking import check_saved_search


def genesis_page():
    return copy.deepcopy(load("listings_ibanez_rg550_genesis.json"))


def test_new_listings_price_drops_and_gone_across_two_checks(tmp_path):
    store = Store(str(tmp_path / "t.db"))
    params = {"query": "Ibanez RG550 Genesis", "scan_limit": 50}
    sid = store.create_search("Genesis", params)

    page1 = genesis_page()
    first = check_saved_search(store, FakeClient([page1]), sid)
    assert first["baseline"] is True and first["new"] == []

    page2 = genesis_page()
    rows = page2["listings"]
    sold_id, live_id = str(rows[0]["id"]), str(rows[1]["id"])
    dropped_id = str(rows[2]["id"])
    rows[2]["price"]["amount_cents"] -= 10000           # $100 price drop
    rows[2]["price"]["amount"] = str(rows[2]["price"]["amount_cents"] / 100)
    rows[2]["buyer_price"] = copy.deepcopy(rows[2]["price"])
    new_row = copy.deepcopy(rows[3])
    new_row["id"] = 999000111
    page2["listings"] = rows[2:] + [new_row]             # rows[0], rows[1] disappear
    client = FakeClient([page2], states={sold_id: "sold", live_id: "live"})
    diff = check_saved_search(store, client, sid)

    assert diff["baseline"] is False
    assert diff["new"] == ["999000111"]
    assert diff["price_drops"] == [dropped_id]
    assert diff["gone"] == [sold_id]                     # 'live' one is just outside the scan

    card = store.search_card(sid)
    assert card["checks"] == 2
    assert card["new_since_view"] == 1
    assert card["drops_since_view"] == 1
    assert card["gone_since_view"] == 1
    gone = store.gone_listings(sid)
    assert [g["listing_id"] for g in gone] == [sold_id] and gone[0]["status"] == "sold"

    latest = store.latest_result(sid)
    by_id = {l["id"]: l for l in latest["listings"]}
    assert by_id["999000111"]["new_since_view"] is True
    assert by_id[dropped_id]["tracked_was_total"] > by_id[dropped_id]["total"]

    series = store.model_series(sid)
    assert series and len(series[0]["points"]) == 2
    kinds = {e["kind"] for e in store.events(sid)}
    assert {"new", "price_drop", "gone"} <= kinds

    # viewing clears "new since last view"
    store.update_search(sid, last_viewed_at=card["last_checked_at"] + 1)
    assert store.search_card(sid)["new_since_view"] == 0


def test_saved_searches_persist_across_restarts(tmp_path):
    path = str(tmp_path / "persist.db")
    store = Store(path)
    params = {"query": "Ibanez RG550 Genesis", "scan_limit": 50, "guitar_type": "electric"}
    sid = store.create_search("My Genesis", params)
    result = run_search(params, FakeClient([genesis_page()]))
    store.record_check(sid, result)
    del store

    reopened = Store(path)
    searches = reopened.list_searches()
    assert [s["name"] for s in searches] == ["My Genesis"]
    assert searches[0]["params"]["query"] == "Ibanez RG550 Genesis"
    assert reopened.latest_result(sid)["summary"]["kept"] == result["summary"]["kept"]
    reopened.update_search(sid, name="Renamed", auto_check=0)
    assert reopened.get_search(sid)["name"] == "Renamed"
    assert reopened.get_search(sid)["auto_check"] is False
    reopened.delete_search(sid)
    assert reopened.list_searches() == []


def test_api_cache_roundtrip(tmp_path):
    store = Store(str(tmp_path / "c.db"))
    store.cache_set("k", {"a": 1}, 60)
    assert store.cache_get("k") == {"a": 1}
    store.cache_set("old", 1, -1)
    assert store.cache_get("old") is None
