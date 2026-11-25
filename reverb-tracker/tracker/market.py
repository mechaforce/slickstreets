"""Market position math. All thresholds are documented in the README.

Every listing is compared with *comps*: other listings in the same model
group and the same market, on total price (price + shipping to your region),
never counting the listing itself.

Comp sets, in order of preference:
  brand new  -> other brand-new listings; fallback: new + B-stock
  B-stock    -> other B-stock; fallback: new + B-stock
  used       -> same condition tier (mint / excellent / very good / good or worse);
                fallback: all used listings of the model
A fallback is used when the preferred set has fewer than MIN_TIER_COMPS comps.
If even the fallback has fewer than MIN_COMPS_TO_RATE comps, the listing is
compared with Reverb's price-guide estimate (sold-based) when one exists, at
low confidence; otherwise it is "Not enough comps".
"""
from __future__ import annotations

from statistics import median as _median

MIN_COMPS_TO_RATE = 3     # fewer comps than this -> "Not enough comps"
MIN_TIER_COMPS = 4        # preferred comp set must have at least this many
HIGH_CONFIDENCE = 8       # >= 8 comps
MEDIUM_CONFIDENCE = 4     # 4-7 comps; fewer is low
WIDE_SPREAD = 0.5         # IQR / median above this lowers confidence one level
VERIFY_BELOW = -50.0      # % vs median at or below this -> "verify carefully"

# (upper bound of % vs median, label); first match wins.
LABELS = [
    (-20.0, "Great deal"),
    (-8.0, "Good deal"),
    (8.0, "Fair"),
    (25.0, "Above market"),
    (float("inf"), "Overpriced"),
]
LABEL_RANK = {"Great deal": 0, "Good deal": 1, "Fair": 2, "Above market": 3, "Overpriced": 4,
              "Not enough comps": 5, "Unrated": 6}


def quantile(sorted_vals: list[float], q: float) -> float:
    """Linear-interpolation quantile (same as numpy's default)."""
    if not sorted_vals:
        raise ValueError("empty")
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    pos = (len(sorted_vals) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)


def describe(values: list[float]) -> dict | None:
    if not values:
        return None
    v = sorted(values)
    return {
        "count": len(v), "min": v[0], "p25": round(quantile(v, 0.25), 2),
        "median": round(_median(v), 2), "p75": round(quantile(v, 0.75), 2), "max": v[-1],
    }


def percentile_of(value: float, comps: list[float]) -> float:
    """Share of comps cheaper than value (ties count half), 0-100. Low = cheap."""
    if not comps:
        return 50.0
    below = sum(1 for c in comps if c < value)
    equal = sum(1 for c in comps if c == value)
    return round(100.0 * (below + 0.5 * equal) / len(comps), 1)


def label_for(pct_vs_median: float) -> str:
    for bound, label in LABELS:
        if pct_vs_median <= bound if bound < 0 else pct_vs_median < bound:
            return label
    return "Overpriced"


def confidence_for(n: int, stats: dict | None = None) -> tuple[str, str]:
    """(level, reason). high >= 8 comps, medium 4-7, low < 4; wide spread lowers one level."""
    if n >= HIGH_CONFIDENCE:
        level = "high"
    elif n >= MEDIUM_CONFIDENCE:
        level = "medium"
    else:
        level = "low"
    reason = f"{n} comp{'s' if n != 1 else ''}"
    if stats and stats.get("median"):
        spread = (stats["p75"] - stats["p25"]) / stats["median"]
        if spread > WIDE_SPREAD and level != "low":
            level = "medium" if level == "high" else "low"
            reason += f", wide price spread (middle half spans {spread:.0%} of median)"
    return level, reason


def _comp_set(listing, group_listings):
    others = [o for o in group_listings if o is not listing and o.get("total") is not None]
    seg, tier = listing["segment"], listing["tier"]
    if seg in ("new", "b-stock"):
        preferred = [o for o in others if o["segment"] == seg]
        if len(preferred) >= MIN_TIER_COMPS:
            return preferred, "brand new" if seg == "new" else "B-stock"
        return [o for o in others if o["segment"] in ("new", "b-stock")], "new + B-stock"
    preferred = [o for o in others if o["tier"] == tier]
    if len(preferred) >= MIN_TIER_COMPS:
        return preferred, f"used, {tier.replace('-', ' ')}"
    return [o for o in others if o["segment"] == "used"], "all used"


def rate_listings(listings: list[dict], groups: dict[str, dict]) -> None:
    """Fill market fields on each listing in place."""
    by_group: dict[str, list] = {}
    for l in listings:
        by_group.setdefault(l["group_key"], []).append(l)
    for key, members in by_group.items():
        identified = groups[key]["identified"]
        for l in members:
            comps, basis = _comp_set(l, members)
            values = [c["total"] for c in comps]
            stats = describe(values)
            l["comp_basis"] = basis
            l["comp_stats"] = stats
            l["comp_count"] = len(values)
            l["verify"] = False
            l["market_ref"] = None
            if not identified:
                l.update(label="Unrated", pct_vs_median=None, percentile=None,
                         confidence="none", confidence_reason="model not identified")
                continue
            if len(values) < MIN_COMPS_TO_RATE and (l.get("estimate") or {}).get("mid"):
                # Too few live comps: fall back to Reverb's price-guide estimate (based on sales).
                mid = l["estimate"]["mid"]
                pct = round((l["total"] - mid) / mid * 100, 1)
                l.update(label=label_for(pct), pct_vs_median=pct, percentile=None, confidence="low",
                         comp_basis="Reverb price guide",
                         confidence_reason=f"only {len(values)} comparable listing{'s' if len(values) != 1 else ''}; "
                                           "compared with Reverb's sold-price estimate instead",
                         market_ref=mid, verify=pct <= VERIFY_BELOW)
                continue
            if len(values) < MIN_COMPS_TO_RATE:
                l.update(label="Not enough comps", pct_vs_median=None, percentile=None,
                         confidence="none",
                         confidence_reason=f"only {len(values)} comparable listing{'s' if len(values) != 1 else ''}")
                continue
            pct = round((l["total"] - stats["median"]) / stats["median"] * 100, 1)
            level, why = confidence_for(len(values), stats)
            l.update(label=label_for(pct), pct_vs_median=pct, percentile=percentile_of(l["total"], values),
                     market_ref=stats["median"], confidence=level, confidence_reason=why, verify=pct <= VERIFY_BELOW)


def group_summaries(listings: list[dict], groups: dict[str, dict]) -> list[dict]:
    out = []
    for key, g in groups.items():
        members = [l for l in listings if l["group_key"] == key]
        seg_stats = {}
        for seg in ("new", "b-stock", "used"):
            vals = [l["total"] for l in members if l["segment"] == seg]
            if vals:
                seg_stats[seg] = describe(vals)
        tier_stats = {}
        for tier in ("mint", "excellent", "very-good", "good-or-worse"):
            vals = [l["total"] for l in members if l["tier"] == tier]
            if vals:
                tier_stats[tier] = describe(vals)
        main_seg = max(seg_stats, key=lambda s: seg_stats[s]["count"]) if seg_stats else None
        overall = describe([l["total"] for l in members])
        if g["identified"] and main_seg:
            level, why = confidence_for(seg_stats[main_seg]["count"], seg_stats[main_seg])
        else:
            level, why = "none", "model not identified"
        out.append({
            **g,
            "count": len(members),
            "stats": overall,
            "segments": seg_stats,
            "tiers": tier_stats,
            "main_segment": main_seg,
            "confidence": level,
            "confidence_reason": why,
            "deals": sum(1 for l in members if l.get("label") in ("Great deal", "Good deal")),
        })
    out.sort(key=lambda g: (not g["identified"], -g["count"], g["name"]))
    return out


def sold_summary(records: list[dict], tier_of) -> dict | None:
    """Summarise sold transactions (cents) by market."""
    if not records:
        return None
    by = {}
    for r in records:
        if r.get("cents") is None:
            continue
        seg_tier = tier_of(r.get("condition") or "")
        by.setdefault(seg_tier, []).append(r["cents"] / 100.0)
        if seg_tier not in ("new", "b-stock"):
            by.setdefault("used", []).append(r["cents"] / 100.0)
    tss = [r["ts"] for r in records if r.get("ts")]
    return {
        "count": len(records),
        "oldest_ts": min(tss) if tss else None,
        "newest_ts": max(tss) if tss else None,
        "by_market": {k: describe(v) for k, v in by.items()},
    }
