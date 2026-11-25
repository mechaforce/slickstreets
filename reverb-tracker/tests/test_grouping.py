from conftest import gql_products, load
from tracker.filtering import classify, parse_listing
from tracker.grouping import assign_groups, extract_model_codes, segment_of, tier_of


def test_model_code_normalisation():
    assert extract_model_codes("Ibanez RG550") == ["RG550"]
    assert extract_model_codes("Ibanez RG 550 Made in Japan") == ["RG550"]
    assert extract_model_codes("Ibanez RG-550 Desert Yellow") == ["RG550"]
    assert extract_model_codes("IBANEZ RG550-EB") == ["RG550"]
    assert extract_model_codes("Ibanez RG550PN Purple Neon") == ["RG550"]
    assert extract_model_codes("Ibanez RG5120M Prestige") == ["RG5120"]
    assert extract_model_codes("Ibanez RG550")[0] != extract_model_codes("Ibanez RG5120")[0]


def test_years_and_words_are_not_codes():
    assert extract_model_codes("Ibanez RG 550 LTD 1994") == ["RG550"]
    assert extract_model_codes("Ibanez RG 7-String w/ Case") == []
    assert extract_model_codes("Gibson Les Paul Standard 50s") == []
    assert extract_model_codes("Serial#: 2510490") == []


def test_condition_markets():
    assert segment_of("brand-new") == "new"
    assert segment_of("b-stock") == "b-stock"
    assert segment_of("mint-inventory") == "used"
    assert tier_of("mint-inventory") == "mint"
    assert tier_of("very-good") == "very-good"
    assert tier_of("fair") == "good-or-worse"


def _kept(*names):
    out = []
    for n in names:
        for r in load(n)["listings"]:
            l = parse_listing(r)
            if classify(l, "electric") is None:
                out.append(l)
    return out


def test_groups_by_reverb_product_page():
    listings = _kept("listings_ibanez_rg550_genesis.json")
    groups = assign_groups(listings, gql_products("gql_listings_ibanez_rg550_genesis.json"), "ibanez rg550 genesis")
    biggest = max(groups.values(), key=lambda g: g["count"])
    assert biggest["key"] == "csp:81220"
    assert biggest["name"] == "Ibanez RG550 Genesis Collection"
    # the one listing without a product page joins the RG550 group by model code
    assert biggest["count"] == len(listings)


def test_broad_search_splits_into_models():
    listings = _kept("listings_ibanez_rg_p1.json", "listings_ibanez_rg_p2.json")
    groups = assign_groups(listings, gql_products("gql_listings_ibanez_rg_p1_p2.json"), "ibanez rg")
    assert len(groups) > 20
    assert sum(g["count"] for g in groups.values()) == len(listings)
    by_key = {l["id"]: l["group_key"] for l in listings}
    names = {g["name"] for g in groups.values()}
    assert "Ibanez RG550 Genesis Collection" in names
    assert "Ibanez RG5120M Prestige" in names
    # model-code fallback when there is no product page
    assert any(k.startswith("code:ibanez:") for k in by_key.values())
    # listings with neither are kept but marked unidentified
    unid = [g for g in groups.values() if not g["identified"]]
    assert unid and all(g["key"] == "unid:ibanez" for g in unid)


def test_era_guard_keeps_vintage_out_of_modern_group():
    listings = _kept("listings_ibanez_rg_p1.json", "listings_ibanez_rg_p2.json")
    assign_groups(listings, gql_products("gql_listings_ibanez_rg_p1_p2.json"), "ibanez rg")
    vintage = [l for l in listings if "1994" in l["title"] and "550" in l["title"]]
    assert vintage
    assert all(l["group_key"] != "csp:81220" for l in vintage)
