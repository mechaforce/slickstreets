from conftest import FakeClient, load
from tracker.search import run_search


def test_stats_panel_accounts_for_every_listing(rg_client):
    r = run_search({"query": "ibanez rg", "guitar_type": "any", "scan_limit": 100}, rg_client)
    s = r["summary"]
    assert s["reverb_total"] == 6019
    assert s["scanned"] == 100 and s["pages"] == 2
    assert s["kept"] + s["excluded"] == s["scanned"]
    assert s["kept"] == len(r["listings"]) and s["excluded"] == len(r["excluded"])
    assert s["excluded_by_group"]["parts"] == 13
    assert sum(s["excluded_by_reason"].values()) == s["excluded"]
    assert s["models"] == len(r["groups"]) and s["models"] > 20
    assert sum(g["count"] for g in r["groups"]) == s["kept"]
    assert sum(s["labels"].values()) == s["kept"]
    for l in r["listings"]:
        assert "label" in l and "group_key" in l
        assert not any(c.startswith("Parts") for c in l["categories"])
    # "any guitar" sends no product_type; electric does
    assert "product_type" not in rg_client.urls[0]


def test_electric_search_uses_api_category_filter(rg_client):
    rg_client.unfiltered_total = 9000
    r = run_search({"query": "ibanez rg", "scan_limit": 50}, rg_client)
    assert "product_type=electric-guitars" in rg_client.urls[0]
    assert r["summary"]["scanned"] == 50
    assert r["summary"]["api_prefiltered"] == 9000 - 6019


def test_narrow_search_gives_tight_high_confidence_comps(genesis_client):
    r = run_search({"query": "Ibanez RG550 Genesis", "scan_limit": 100}, genesis_client)
    main = r["groups"][0]
    assert main["name"] == "Ibanez RG550 Genesis Collection"
    assert main["count"] >= 0.9 * r["summary"]["kept"]
    assert main["confidence"] == "high"
    new = [l for l in r["listings"] if l["segment"] == "new"]
    assert new and all(l["confidence"] == "high" for l in new)


def test_sorted_best_value_first(genesis_client):
    r = run_search({"query": "Ibanez RG550 Genesis"}, genesis_client)
    rated = [l["pct_vs_median"] for l in r["listings"] if l["pct_vs_median"] is not None]
    assert rated == sorted(rated)


def test_few_results_explain_themselves():
    page = load("listings_ibanez_rg_p1.json")
    page = dict(page, total=3, listings=[page["listings"][i] for i in (0, 3, 12)])
    client = FakeClient([page])
    r = run_search({"query": "odd guitar"}, client)
    assert r["summary"]["kept"] == 3 and r["summary"]["rated"] == 0
    text = " ".join(n["text"] for n in r["explanations"])
    assert "aren't enough comparisons" in text


def test_only_parts_explain_themselves():
    client = FakeClient([load("listings_ibanez_rg_parts.json")])
    r = run_search({"query": "ibanez rg pickguard", "guitar_type": "any", "scan_limit": 50}, client)
    assert r["summary"]["kept"] == 0
    assert "none are whole guitars" in r["explanations"][0]["text"]


def test_no_results():
    client = FakeClient([{"total": 0, "listings": []}])
    r = run_search({"query": "zzzz"}, client)
    assert r["summary"]["scanned"] == 0
    assert "no listings" in r["explanations"][0]["text"]
