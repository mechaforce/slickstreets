"""Run one search end to end: fetch -> filter -> group -> rate -> explain."""
from __future__ import annotations

import logging
import time
from collections import Counter

from . import filtering, grouping, market
from .filtering import REASON_GROUP, REASON_LABELS, PRODUCT_TYPE_PARAM

log = logging.getLogger(__name__)

DEFAULT_PARAMS = {
    "query": "",
    "guitar_type": "electric",      # electric | acoustic | bass | any
    "conditions": [],               # subset of new, b-stock, used ([] = all)
    "price_min": None, "price_max": None,
    "year_min": None, "year_max": None,
    "region": None,                 # None = app default
    "scan_limit": 250,
    "include_non_functioning": False,
}
SCAN_LIMITS = (50, 100, 250, 500, 1000, 2000)
NEW_LISTING_DAYS = 3


def normalize_params(p: dict) -> dict:
    out = dict(DEFAULT_PARAMS)
    for k in DEFAULT_PARAMS:
        if k in p and p[k] not in (None, ""):
            out[k] = p[k]
    out["query"] = " ".join(str(out["query"]).split())
    if out["guitar_type"] not in filtering.GUITAR_ROOTS:
        out["guitar_type"] = "electric"
    out["conditions"] = [c for c in (out["conditions"] or []) if c in ("new", "b-stock", "used")]
    for k in ("price_min", "price_max"):
        out[k] = float(out[k]) if out[k] not in (None, "") else None
    for k in ("year_min", "year_max"):
        out[k] = int(out[k]) if out[k] not in (None, "") else None
    out["scan_limit"] = max(50, min(int(out["scan_limit"] or 250), max(SCAN_LIMITS)))
    out["include_non_functioning"] = bool(out["include_non_functioning"])
    return out


def _api_params(p: dict) -> dict:
    return {
        "query": p["query"],
        "product_type": PRODUCT_TYPE_PARAM[p["guitar_type"]],
        "conditions": p["conditions"],
        "price_min": p["price_min"], "price_max": p["price_max"],
        "year_min": p["year_min"], "year_max": p["year_max"],
    }


def _fmt(v):
    return f"${v:,.0f}" if v is not None else "-"


def run_search(params: dict, client, progress=None, sold_lookup_groups: int = 8) -> dict:
    progress = progress or (lambda msg, frac=None: None)
    p = normalize_params(params)
    if not p["query"]:
        raise ValueError("Type something to search for, e.g. Ibanez RG")
    started = time.time()
    url = client.build_search_url(_api_params(p))

    # 1. fetch pages
    raws, seen, reverb_total, pages = [], set(), None, 0
    while url and len(raws) < p["scan_limit"]:
        progress(f"Fetching listings page {pages + 1}", min(0.6, 0.6 * len(raws) / p["scan_limit"]))
        page = client.search_page(url)
        pages += 1
        if reverb_total is None:
            reverb_total = page.get("total") or 0
        rows = page.get("listings") or []
        for r in rows:
            if str(r.get("id")) in seen:
                continue
            seen.add(str(r.get("id")))
            raws.append(r)
            if len(raws) >= p["scan_limit"]:
                break
        if not rows:
            break
        url = ((page.get("_links") or {}).get("next") or {}).get("href")

    # How many listings Reverb's own product-type filter already removed.
    prefiltered = None
    if PRODUCT_TYPE_PARAM[p["guitar_type"]] and reverb_total is not None and hasattr(client, "search_total"):
        try:
            unfiltered = client.search_total(client.build_search_url({**_api_params(p), "product_type": None}))
            prefiltered = max(0, unfiltered - reverb_total)
        except Exception as e:
            log.warning("unfiltered count failed: %s", e)

    # 2. filter
    progress("Filtering out parts and accessories", 0.62)
    kept, excluded = [], []
    for r in raws:
        l = filtering.parse_listing(r)
        verdict = filtering.classify(l, p["guitar_type"], p["include_non_functioning"])
        if verdict:
            l["exclude_reason"], l["exclude_detail"] = verdict
            excluded.append(l)
        else:
            kept.append(l)

    # 3. group by model
    progress("Matching listings to Reverb product pages", 0.7)
    products = client.listing_products([l["id"] for l in kept]) if kept else {}
    groups = grouping.assign_groups(kept, products, p["query"])

    # 4. Reverb price-guide estimates (sold-transaction based), when available
    progress("Looking up Reverb price-guide estimates", 0.8)
    estimate_errors = None
    try:
        pairs = sorted({(l["canonical_product_id"], l["condition"]) for l in kept if l.get("canonical_product_id")})
        est = client.price_estimates(pairs) if pairs else {}
        for l in kept:
            e = est.get((l.get("canonical_product_id"), l["condition"])) if l.get("canonical_product_id") else None
            if e and e.get("mid"):
                l["estimate"] = {k: (v / 100.0 if v else None) for k, v in e.items()}
                l["pct_vs_estimate"] = round((l["total"] - l["estimate"]["mid"]) / l["estimate"]["mid"] * 100, 1)
            else:
                l["estimate"], l["pct_vs_estimate"] = None, None
    except Exception as e:  # estimates are an extra signal; never fail the search for them
        log.warning("price estimates failed: %s", e)
        estimate_errors = str(e)
        for l in kept:
            l.setdefault("estimate", None)
            l.setdefault("pct_vs_estimate", None)

    # 5. market position
    market.rate_listings(kept, groups)
    for l in kept:
        age = filtering.published_age_days(l)
        l["age_days"] = round(age, 2) if age is not None else None
        l["is_new"] = age is not None and age <= NEW_LISTING_DAYS
        l["was_price"] = l.get("original_price")
        l["drop_pct"] = (round((l["original_price"] - l["price"]) / l["original_price"] * 100, 1)
                         if l.get("original_price") and l.get("price") else None)

    group_list = market.group_summaries(kept, groups)

    # 6. recent sold prices for the biggest identified models
    progress("Looking up recent sold prices", 0.9)
    for g in [g for g in group_list if g["source"] == "csp"][:sold_lookup_groups]:
        cps = sorted({l["canonical_product_id"] for l in kept
                      if l["group_key"] == g["key"] and l.get("canonical_product_id")})
        g["sold"] = None
        if not cps:
            continue
        try:
            sold = client.sold_records(cps)
            g["sold"] = market.sold_summary(sold.get("records") or [], grouping.tier_of)
            if g["sold"]:
                g["sold"]["total_all_time"] = sold.get("total")
        except Exception as e:
            log.warning("sold lookup failed: %s", e)

    # 7. summary + explanations
    reasons = Counter(l["exclude_reason"] for l in excluded)
    rolled = Counter()
    for code, n in reasons.items():
        rolled[REASON_GROUP[code]] += n
    labels = Counter(l["label"] for l in kept)
    summary = {
        "reverb_total": reverb_total or 0,
        "api_prefiltered": prefiltered,
        "product_type": PRODUCT_TYPE_PARAM[p["guitar_type"]],
        "scanned": len(raws),
        "pages": pages,
        "kept": len(kept),
        "excluded": len(excluded),
        "excluded_by_reason": dict(reasons),
        "excluded_by_group": {"parts": rolled["parts"], "other": rolled["other"],
                              "non_functioning": rolled["non_functioning"]},
        "reason_labels": REASON_LABELS,
        "models": len(group_list),
        "identified_models": sum(1 for g in group_list if g["identified"]),
        "labels": dict(labels),
        "rated": sum(1 for l in kept if l.get("pct_vs_median") is not None),
        "rated_by_estimate": sum(1 for l in kept if l.get("comp_basis") == "Reverb price guide"
                                 and l.get("pct_vs_median") is not None),
        "deals": labels.get("Great deal", 0) + labels.get("Good deal", 0),
        "verify": sum(1 for l in kept if l.get("verify")),
        "with_estimate": sum(1 for l in kept if l.get("estimate")),
        "requests": getattr(client, "request_count", None),
        "seconds": round(time.time() - started, 1),
        "estimate_error": estimate_errors,
    }
    assert summary["kept"] + summary["excluded"] == summary["scanned"]
    kept.sort(key=sort_key_market)
    progress("Done", 1.0)
    return {
        "params": p,
        "summary": summary,
        "groups": group_list,
        "listings": kept,
        "excluded": excluded,
        "explanations": explain(p, summary, group_list, kept),
        "ran_at": time.time(),
    }


def sort_key_market(l: dict):
    rated = l.get("pct_vs_median") is not None
    return (0 if rated else 1, l["pct_vs_median"] if rated else 0, l.get("total") or 0)


def explain(p: dict, s: dict, groups: list[dict], kept: list[dict]) -> list[dict]:
    """Plain-language notes about why the results look the way they do."""
    notes = []
    q = p["query"]

    def add(level, text):
        notes.append({"level": level, "text": text})

    if s["reverb_total"] == 0:
        add("warn", f'Reverb found no listings for "{q}" with these filters. Check the spelling, '
                    "remove filters, or set guitar type to \"Any guitar\".")
        return notes
    if s["kept"] == 0:
        bits = []
        eg = s["excluded_by_group"]
        if eg["parts"]:
            bits.append(f"{eg['parts']} parts/accessories")
        if eg["other"]:
            bits.append(f"{eg['other']} in other categories")
        if eg["non_functioning"]:
            bits.append(f"{eg['non_functioning']} non-functioning")
        add("warn", f"Reverb returned {s['scanned']} listings but none are whole guitars "
                    f"({', '.join(bits)}). Click the excluded counts above to see them. "
                    "If you are looking for a bass or acoustic, change the guitar type.")
        return notes
    if s["scanned"] >= p["scan_limit"] and s["scanned"] < s["reverb_total"]:
        add("info", f"Scanned the first {s['scanned']:,} of {s['reverb_total']:,} listings Reverb found. "
                    "Scan more listings, or make the search more specific, for more comparisons.")
    if s["rated"] == 0:
        if s["kept"] <= 5:
            add("warn", f"Only {s['kept']} guitar listing{'s' if s['kept'] != 1 else ''} matched"
                        + (f", across {s['models']} different models" if s["models"] > 1 else "")
                        + ", so there aren't enough comparisons to judge price. "
                        "Try a broader search or scan more listings.")
        else:
            add("warn", f"{s['kept']} guitars matched, but they split into {s['models']} models with "
                        f"fewer than {market.MIN_COMPS_TO_RATE + 1} listings each in the same market, so "
                        "none could be rated. Try a more specific search (a model number like RG550) "
                        "or scan more listings.")
    elif s["rated"] < s["kept"]:
        unrated = s["kept"] - s["rated"]
        unid = sum(g["count"] for g in groups if not g["identified"])
        msg = f"{unrated} of {s['kept']} guitars are not rated"
        parts = []
        if unid:
            parts.append(f"{unid} couldn't be matched to a specific model (no Reverb product page or model number in the title)")
        if unrated - unid > 0:
            parts.append(f"{unrated - unid} have too few comparable listings of the same model and condition")
        add("info", msg + (": " + "; ".join(parts) if parts else "") + ".")
    if s.get("rated_by_estimate"):
        add("info", f"{s['rated_by_estimate']} listing{'s' if s['rated_by_estimate'] != 1 else ''} had too few "
                    "same-model listings to compare with, so {} rated against Reverb's price-guide estimate "
                    "(based on recent sales) instead, at low confidence.".format(
                        "they are" if s["rated_by_estimate"] != 1 else "it is"))
    if s["deals"] == 0 and s["rated"]:
        add("info", "No listing is priced clearly below its model's market right now. "
                    "Everything is shown ranked, so the best-priced listings are still at the top.")
    if s["verify"]:
        add("warn", f"{s['verify']} listing{'s are' if s['verify'] != 1 else ' is'} priced more than 50% below "
                    "its model's median. Verify carefully: it could be mislabeled, missing parts, or a scam.")
    if len(groups) >= 15 and s["rated"]:
        add("info", f"This search spans {len(groups)} models. Click a model in the table to focus on it.")
    return notes
