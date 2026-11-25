import pytest

from tracker import market
from tracker.market import confidence_for, describe, label_for, percentile_of, quantile, rate_listings


def test_quantiles():
    v = [100, 200, 300, 400, 500]
    assert quantile(v, 0.25) == 200
    assert quantile(v, 0.5) == 300
    d = describe([400, 100, 300, 200])
    assert d == {"count": 4, "min": 100, "p25": 175.0, "median": 250.0, "p75": 325.0, "max": 400}


def test_percentile():
    comps = [100, 200, 300, 400]
    assert percentile_of(50, comps) == 0
    assert percentile_of(250, comps) == 50
    assert percentile_of(500, comps) == 100
    assert percentile_of(200, comps) == 37.5   # ties count half


@pytest.mark.parametrize("pct,label", [
    (-60, "Great deal"), (-20, "Great deal"), (-19.9, "Good deal"), (-8, "Good deal"),
    (-7.9, "Fair"), (0, "Fair"), (7.9, "Fair"), (8, "Above market"), (24.9, "Above market"),
    (25, "Overpriced"), (300, "Overpriced"),
])
def test_label_thresholds(pct, label):
    assert label_for(pct) == label


def test_confidence_levels():
    tight = {"median": 1000, "p25": 950, "p75": 1050}
    wide = {"median": 1000, "p25": 600, "p75": 1400}
    assert confidence_for(8, tight)[0] == "high"
    assert confidence_for(12, tight)[0] == "high"
    assert confidence_for(7, tight)[0] == "medium"
    assert confidence_for(4, tight)[0] == "medium"
    assert confidence_for(3, tight)[0] == "low"
    assert confidence_for(10, wide)[0] == "medium"     # wide spread lowers one level
    assert confidence_for(5, wide)[0] == "low"
    assert "wide price spread" in confidence_for(10, wide)[1]


def L(i, total, cond="excellent", group="g", est=None):
    from tracker.grouping import segment_of, tier_of
    return {"id": str(i), "total": total, "condition": cond, "segment": segment_of(cond), "tier": tier_of(cond),
            "group_key": group, "estimate": {"mid": est} if est else None}


GROUPS = {"g": {"identified": True}, "u": {"identified": False}}


def test_listing_excluded_from_its_own_comps():
    ls = [L(i, p) for i, p in enumerate([1000, 1000, 1000, 1000, 500])]
    rate_listings(ls, GROUPS)
    cheap = ls[-1]
    assert cheap["comp_count"] == 4
    assert cheap["comp_stats"]["median"] == 1000
    assert cheap["pct_vs_median"] == -50.0
    assert cheap["label"] == "Great deal"
    assert cheap["verify"] is True
    assert cheap["percentile"] == 0
    assert ls[0]["comp_stats"]["median"] == 1000   # 3x1000 + 500


def test_condition_tier_with_fallback_to_all_used():
    ls = [L(i, 1000, "mint") for i in range(5)] + [L(10, 600, "good"), L(11, 650, "fair")]
    rate_listings(ls, GROUPS)
    mint = ls[0]
    assert mint["comp_basis"] == "used, mint" and mint["comp_count"] == 4
    good = ls[5]
    assert good["comp_basis"] == "all used" and good["comp_count"] == 6


def test_new_and_used_are_separate_markets():
    ls = [L(i, 1200, "brand-new") for i in range(5)] + [L(10 + i, 800, "excellent") for i in range(5)]
    rate_listings(ls, GROUPS)
    assert all(l["comp_stats"]["median"] == 1200 for l in ls[:5])
    assert all(l["comp_stats"]["median"] == 800 for l in ls[5:])
    assert all(l["label"] == "Fair" for l in ls)


def test_too_few_comps_and_estimate_fallback():
    ls = [L(1, 1000), L(2, 900), L(3, 700, est=1000)]
    rate_listings(ls, GROUPS)
    assert ls[0]["label"] == "Not enough comps" and ls[0]["pct_vs_median"] is None
    assert ls[2]["comp_basis"] == "Reverb price guide"
    assert ls[2]["pct_vs_median"] == -30.0 and ls[2]["label"] == "Great deal"
    assert ls[2]["confidence"] == "low"


def test_unidentified_models_are_unrated():
    ls = [L(i, 1000 + i, group="u") for i in range(6)]
    rate_listings(ls, GROUPS)
    assert {l["label"] for l in ls} == {"Unrated"}


def test_thresholds_documented_constants():
    assert market.HIGH_CONFIDENCE == 8 and market.MEDIUM_CONFIDENCE == 4
    assert market.VERIFY_BELOW == -50
