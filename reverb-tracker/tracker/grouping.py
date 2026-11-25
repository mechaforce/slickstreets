"""Model grouping: which listings are "the same guitar".

1. If Reverb links the listing to a product page (CSP), group by CSP id.
2. Otherwise extract a model code from the title ("RG550", "RG 550" and
   "RG-550" all become RG550; finish suffixes like RG550PN are dropped)
   and group by make + code. If exactly one CSP group in the search has that
   code, the listing joins it.
3. Listings with no CSP and no model code go into an "unidentified" group per
   make; they are shown but not rated.
"""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from datetime import date
from statistics import median

ERA_GAP_YEARS = 12   # a model-code match is not used across eras (e.g. 1994 RG550 vs 2020s Genesis)

SEGMENTS = ("new", "b-stock", "used")
USED_TIERS = ("mint", "excellent", "very-good", "good-or-worse")
TIER_LABELS = {
    "new": "Brand new", "b-stock": "B-stock", "mint": "Mint", "excellent": "Excellent",
    "very-good": "Very good", "good-or-worse": "Good or worse", "used": "Used",
}


def segment_of(condition_slug: str) -> str:
    if condition_slug == "brand-new":
        return "new"
    if condition_slug == "b-stock":
        return "b-stock"
    return "used"


def tier_of(condition_slug: str) -> str:
    seg = segment_of(condition_slug)
    if seg != "used":
        return seg
    if condition_slug in ("mint", "mint-inventory"):
        return "mint"
    if condition_slug == "excellent":
        return "excellent"
    if condition_slug == "very-good":
        return "very-good"
    return "good-or-worse"


_STOP_PREFIXES = {
    "SN", "NO", "NR", "S", "SER", "SERIAL", "USA", "MIJ", "MIK", "MII", "MIA", "MIC", "MIM", "PC",
    "PCS", "LBS", "LB", "OZ", "MM", "IN", "FT", "X", "V", "VOL", "Q", "W", "WITH", "AND", "OF",
    "THE", "TO", "FOR", "GEN", "MODEL", "STR", "FRET", "FRETS", "YEAR", "CA", "EUR", "USD", "US",
    "UK", "JP", "ITEM", "SKU", "LOT", "SET", "ID", "REF", "NEW", "OLD", "MK", "TYPE", "SERIES",
    "STRING", "STRINGS", "CIRCA", "FROM", "LATE", "EARLY", "MID", "AT", "BY", "ON", "OR", "A",
    "E", "H", "HH", "HSH", "HSS", "SSS", "UP", "TO", "VS", "X", "XL", "HZ", "K", "KG",
}
_CODE_RE = re.compile(r"(?<![A-Za-z0-9])([A-Za-z]{1,6})([\s\-]?)(\d{1,5})([A-Za-z]{0,6})(?![A-Za-z0-9])")


def extract_model_codes(text: str, make: str = "") -> list[str]:
    """Model codes in text, normalised: 'RG 550', 'rg-550', 'RG550PN' -> 'RG550'."""
    if not text:
        return []
    t = text
    if make:
        t = re.sub(re.escape(make), " ", t, flags=re.I)
    out = []
    for m in _CODE_RE.finditer(t):
        prefix, sep, digits, _suffix = m.groups()
        p = prefix.upper()
        if p in _STOP_PREFIXES:
            continue
        if sep and len(digits) < 2:
            continue          # "RG 7-string", "Gen 2"
        if len(digits) == 1 and len(p) < 2:
            continue
        if sep == " " and re.fullmatch(r"19[4-9]\d|20[0-3]\d", digits):
            continue          # "LTD 1994" is a year, not a model
        if sep == " " and len(p) > 3 and p.isalpha() and p.capitalize() == prefix:
            continue          # "Standard 50", "Series 7" - an ordinary word, not a code
        code = p + digits
        if code not in out:
            out.append(code)
    return out


def extract_raw_codes(text: str) -> list[str]:
    """Like extract_model_codes but keeps the letter suffix: 'RG550L' stays 'RG550L'."""
    out = []
    for m in _CODE_RE.finditer(text or ""):
        prefix, sep, digits, suffix = m.groups()
        if prefix.upper() in _STOP_PREFIXES or (sep and len(digits) < 2):
            continue
        out.append((prefix + digits + suffix).upper())
    return out


_LEFTY = re.compile(r"\b(left[- ]?hand(?:ed)?|lefty|LH)\b", re.I)


def query_hints(query: str) -> tuple[list[str], list[str]]:
    """(codes in the query, alpha prefixes in the query) used to pick the best code."""
    codes = extract_model_codes(query or "")
    prefixes = [w.upper() for w in re.findall(r"[A-Za-z]{2,6}", query or "")]
    return codes, prefixes


def pick_code(listing: dict, query: str = "") -> str | None:
    make = listing.get("make") or ""
    codes = extract_model_codes(listing.get("title", ""), make)
    for c in extract_model_codes(listing.get("model_field", ""), make):
        if c not in codes:
            codes.append(c)
    if not codes:
        return None
    q_codes, q_prefixes = query_hints(query)
    for c in codes:
        if c in q_codes:
            return c
    for c in codes:
        if any(c.startswith(p) for p in q_prefixes if p.upper() != make.upper()):
            return c
    return codes[0]


def effective_year(listing: dict) -> int | None:
    """Listed year, or this year for brand-new stock (dealers rarely fill in the year)."""
    if listing.get("year"):
        return listing["year"]
    if listing.get("condition") in ("brand-new", "b-stock"):
        return date.today().year
    return None


def norm_make(make: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (make or "").lower()) or "unknown"


def _brand_matches(csp_name: str, listing: dict) -> bool:
    brand = norm_make((csp_name or "").split()[0] if csp_name else "")
    hay = norm_make(listing.get("make", "")) + norm_make(listing.get("title", ""))
    return brand in hay


def _narrow_matches(matches: set, groups: dict, code: str, listing: dict) -> set:
    """Several product pages share a code (RG550 Genesis vs RG550L left-handed): pick the plain one."""
    lefty = bool(_LEFTY.search(listing.get("title", "")))
    hand = {k for k in matches if bool(_LEFTY.search(groups[k]["name"])) == lefty}
    if hand:
        matches = hand
    if len(matches) > 1:
        plain = {k for k in matches if code in extract_raw_codes(groups[k]["name"])}
        if plain:
            matches = plain
    return matches


def assign_groups(listings: list[dict], products: dict[str, dict], query: str = "") -> dict[str, dict]:
    """Set listing['group_key'] etc. in place and return {group_key: group_info}."""
    groups: dict[str, dict] = {}
    csp_codes: dict[str, set] = defaultdict(set)   # code -> csp keys present in this search

    for l in listings:
        info = products.get(l["id"]) or {}
        l["csp_id"] = info.get("csp_id")
        l["canonical_product_id"] = info.get("canonical_product_id")
        l["model_code"] = pick_code(l, query)
        if info.get("csp_id"):
            key = f"csp:{info['csp_id']}"
            g = groups.setdefault(key, {"key": key, "name": info.get("csp_title") or l["title"],
                                        "source": "csp", "csp_id": info["csp_id"],
                                        "csp_slug": info.get("csp_slug"), "identified": True})
            for c in extract_model_codes(g["name"]) or ([l["model_code"]] if l["model_code"] else []):
                csp_codes[c].add(key)
            l["group_key"] = key

    group_years: dict[str, list] = defaultdict(list)
    for l in listings:
        if l.get("group_key") and effective_year(l):
            group_years[l["group_key"]].append(effective_year(l))

    def same_era(l, key):
        y, ys = effective_year(l), group_years.get(key)
        return not (y and ys) or abs(y - median(ys)) <= ERA_GAP_YEARS

    for l in listings:
        if l.get("group_key"):
            continue
        mk = norm_make(l["make"])
        code = l["model_code"]
        if code:
            matches = {k for k in csp_codes.get(code, set())
                       if same_era(l, k) and _brand_matches(groups[k]["name"], l)}
            if len(matches) > 1:
                matches = _narrow_matches(matches, groups, code, l)
            if len(matches) == 1:
                l["group_key"] = next(iter(matches))
                l["group_via"] = "code"
                continue
            key = f"code:{mk}:{code}"
            groups.setdefault(key, {"key": key, "name": f"{l['make'] or ''} {code}".strip(),
                                    "source": "model code", "identified": True})
        else:
            key = f"unid:{mk}"
            groups.setdefault(key, {"key": key, "name": f"{l['make'] or 'Unknown make'} (model not identified)",
                                    "source": "unidentified", "identified": False})
        l["group_key"] = key

    counts = Counter(l["group_key"] for l in listings)
    for key, g in groups.items():
        g["count"] = counts.get(key, 0)
    for l in listings:
        l["group_name"] = groups[l["group_key"]]["name"]
        l["segment"] = segment_of(l["condition"])
        l["tier"] = tier_of(l["condition"])
    return {k: g for k, g in groups.items() if g["count"]}
