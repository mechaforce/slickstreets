import copy
import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
FIX = Path(__file__).resolve().parent / "fixtures"

from tracker.reverb import ReverbClient  # noqa: E402


def load(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))


def gql_products(*names):
    out = {}
    for n in names:
        for row in load(n)["data"]["listings"]:
            csp = row.get("csp") or {}
            out[str(row["id"])] = {"csp_id": csp.get("id"), "csp_title": (csp.get("title") or "").replace("\t", " ") or None,
                                   "csp_slug": csp.get("slug"), "canonical_product_id": row.get("canonicalProductId") or None}
    return out


class FakeClient:
    """Serves saved fixtures through the same interface as ReverbClient."""
    build_search_url = staticmethod(ReverbClient.build_search_url)

    def __init__(self, pages, products=None, estimates=None, states=None, unfiltered_total=None):
        self.pages = [copy.deepcopy(p) for p in pages]
        for i, p in enumerate(self.pages):   # rewrite pagination links to fake urls
            p.setdefault("_links", {})
            if i + 1 < len(self.pages):
                p["_links"]["next"] = {"href": f"fake://page={i + 2}"}
            else:
                p["_links"].pop("next", None)
        self.products = products or {}
        self.estimates = estimates or {}
        self.states = states or {}
        self.unfiltered_total = unfiltered_total
        self.urls = []
        self.request_count = 0

    def search_page(self, url):
        self.urls.append(url)
        self.request_count += 1
        m = re.search(r"page=(\d+)", url)
        idx = int(m.group(1)) - 1 if m and url.startswith("fake://") else 0
        return self.pages[idx]

    def search_total(self, url):
        return self.unfiltered_total if self.unfiltered_total is not None else self.pages[0].get("total", 0)

    def listing_products(self, ids):
        return {i: self.products[i] for i in ids if i in self.products}

    def price_estimates(self, pairs):
        return {p: self.estimates.get(p) for p in pairs}

    def sold_records(self, cps):
        return {"total": 3, "records": [{"cents": 100000, "condition": "excellent", "ts": 1}]}

    def listing_state(self, lid):
        return self.states.get(lid, "sold")


@pytest.fixture
def rg_client():
    return FakeClient([load("listings_ibanez_rg_p1.json"), load("listings_ibanez_rg_p2.json")],
                      products=gql_products("gql_listings_ibanez_rg_p1_p2.json"))


@pytest.fixture
def genesis_client():
    return FakeClient([load("listings_ibanez_rg550_genesis.json")],
                      products=gql_products("gql_listings_ibanez_rg550_genesis.json"))
