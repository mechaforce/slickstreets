import pytest

from conftest import load
from tracker.filtering import classify, looks_like_part, parse_listing


def parsed(name):
    return [parse_listing(r) for r in load(name)["listings"]]


def test_ibanez_rg_search_keeps_no_parts():
    listings = parsed("listings_ibanez_rg_p1.json") + parsed("listings_ibanez_rg_p2.json")
    kept = [l for l in listings if classify(l, "electric") is None]
    excluded = [l for l in listings if classify(l, "electric") is not None]
    assert len(kept) + len(excluded) == 100
    for l in kept:
        assert not any(c.startswith(("Parts", "Accessories")) for c in l["categories"]), l["title"]
        assert "pickguard" not in l["title"].lower()
        assert "backplate" not in l["title"].lower()
    titles = " ".join(l["title"].lower() for l in excluded)
    assert "pickguard" in titles and "backplate" in titles
    assert len(excluded) == 13


def test_parts_product_type_page_is_all_excluded():
    listings = parsed("listings_ibanez_rg_parts.json")
    reasons = {classify(l, "electric")[0] for l in listings}
    assert reasons <= {"parts_category", "accessory_category", "other_category"}
    assert all(classify(l, "any") is not None for l in listings)


def test_non_functioning_excluded_by_default():
    listings = [l for l in parsed("listings_ibanez_rg_non_functioning.json")
                if "Electric Guitars" in l["category_roots"]]
    assert listings
    for l in listings:
        if looks_like_part(l["title"]):
            continue
        assert classify(l, "electric")[0] == "non_functioning"
        assert classify(l, "electric", include_non_functioning=True) is None


def test_guitar_type_filters_roots():
    bass = {"category_roots": ["Bass Guitars"], "categories": ["Bass Guitars / 4-String"], "title": "Ibanez SR500",
            "condition": "excellent", "total": 500}
    assert classify(bass, "electric")[0] == "other_category"
    assert classify(bass, "bass") is None


@pytest.mark.parametrize("title", [
    "Ibanez RG550 with hard case",
    "Ibanez RG550 Genesis w/ Hard Case",
    "Ibanez RG Prestige 7-String Electric Guitar w/Case",
    "Ibanez RG550-EB Genesis Collection 2025 Electric Blue + case",
    "Ibanez RG550 Genesis Collection - Purple Neon, Maple Fingerboard, Edge Tremolo",
    "Ibanez RG with DiMarzio pickups for sale",
    "Ibanez RG550 w/ upgraded pickups for metal",
    "Neck-thru Ibanez RG",
    "Ibanez RG Standard Guitar - Mahogany Oil",
])
def test_guitar_titles_are_kept(title):
    assert looks_like_part(title) is None


@pytest.mark.parametrize("title", [
    "Ibanez RG neck only",
    "Ibanez RG550 body only",
    "Pickguard for Ibanez Japan RG550 Jem RG HSH - Gold",
    "Ibanez Backplate Tremolo Cover for JEM & RG Models - Red",
    "Ibanez RG Hard Case",
    "Ibanez RG body for parts",
    "1990s Ibanez RG550 Loaded Pickguard",
    "Ibanez RG decal",
    "Ibanez RG Edge tremolo bridge for RG550",
    "Case only for Ibanez RG",
    "Ibanez RG550 neck",
])
def test_part_titles_are_excluded(title):
    assert looks_like_part(title)


def test_parse_listing_totals_and_shipping():
    raw = load("listings_ibanez_rg_p1.json")["listings"][0]
    l = parse_listing(raw)
    assert l["price"] == 2299.99
    assert l["shipping"] == 45.0
    # a checkout sale price (buyer_price) is what you pay
    assert l["sale_price"] == 2069.99
    assert l["total"] == round(2069.99 + 45.0, 2)
    assert l["url"].startswith("https://reverb.com/item/")
