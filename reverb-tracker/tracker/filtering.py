"""Parse raw Reverb listings and decide which ones are guitars.

Each excluded listing gets a reason code so the UI can count and show them:

  parts_category   - Reverb category is Parts (pickguards, necks, pickups, ...)
  accessory_category - Reverb category is Accessories (cases, straps, ...)
  parts_keywords   - in a guitar category, but the title says it is a part/accessory
  other_category   - another kind of gear (amps, pedals, basses when not wanted, ...)
  non_functioning  - condition "Non Functioning"
"""
from __future__ import annotations

import re
from datetime import datetime

GUITAR_ROOTS = {
    "electric": {"Electric Guitars"},
    "acoustic": {"Acoustic Guitars"},
    "bass": {"Bass Guitars"},
    "any": {"Electric Guitars", "Acoustic Guitars"},
}
PRODUCT_TYPE_PARAM = {
    "electric": "electric-guitars",
    "acoustic": "acoustic-guitars",
    "bass": "bass-guitars",
    "any": None,
}

REASON_LABELS = {
    "parts_category": "Parts (Reverb category)",
    "accessory_category": "Accessories (Reverb category)",
    "parts_keywords": "Parts / accessories (title)",
    "other_category": "Other categories",
    "non_functioning": "Non-functioning",
}
# How reasons roll up into the summary line.
REASON_GROUP = {
    "parts_category": "parts",
    "accessory_category": "parts",
    "parts_keywords": "parts",
    "other_category": "other",
    "non_functioning": "non_functioning",
}

# Titles that say the listing is not a whole guitar. These only run on
# listings that are already in a guitar category, so they are a safety net
# for miscategorised parts. They are worded so that "RG550 with hard case"
# or "w/ upgraded pickups" stay in.
_PART_NOUNS = (r"neck(?![- ]?(?:thru|through))|body|bodies|pickguard|pick guard|scratch ?plate|"
               r"pickups?|pick ?ups|tremolo|trem|bridge|tuners?|tuning (?:keys|machines|pegs)|"
               r"knobs?|decals?|case|gig ?bag|backplate|back plate|cavity cover|trem cover|"
               r"truss rod cover|control plate|jack plate|wiring harness|harness|locking nut|nut|"
               r"saddles?|whammy bar|tremolo arm|trem arm|strap|fretboard|fingerboard|"
               r"headstock|baseplate|pots?|switch|electronics|hardware|(?:\w+ )?cover")
_MODIFIERS = r"(?:(?:original|oem|genuine|vintage|new|used|loaded|replacement|set of|pair of|\d+)\s+)*"

# Always a part/accessory, wherever the phrase appears.
STRONG_PATTERNS = [
    rf"\b(?:{_PART_NOUNS})\s+only\b",                       # "neck only", "case only"
    r"\bonly\s+(?:the\s+)?(?:neck|body|case|pickguard|pickups?)\b",
    r"\bfor\s+parts\b", r"\bparts\s+only\b", r"\bparts\s+(?:lot|guitar)\b",
    r"\bfits\s+(?:most\s+)?(?:ibanez|fender|gibson|squier|epiphone|prs|jackson|esp|schecter|strat|tele|les paul)",
    r"\bloaded\s+(?:body|pickguard|pick guard|scratch ?plate)\b",
    r"\bdecals?\b", r"\bwaterslide\b",
    r"\bproject\s+body\b",
]
# "<part> for <guitar>" ("Pickguard for Ibanez RG550"), unless it is "for sale"
# or the part is an extra introduced by "with"/"w/".
NOUN_FOR = rf"\b(?:{_PART_NOUNS})\s+(?:for|fits|to fit)\b(?!\s+(?:sale|trade))"
# Title starts with a part noun: "Pickguard Ibanez RG550 HSH".
STARTS_WITH_NOUN = rf"^\s*{_MODIFIERS}(?:{_PART_NOUNS})\b"
# Title ends with a case/bag: "Ibanez RG Hard Case" (but "RG550 w/ hard case" is kept).
ENDS_WITH_CASE = r"\b(?:case|gig ?bag|bag|neck|body|pickguard|pick guard|pickups?|tremolo|bridge|tuners|cover|plate)\s*$"
EXTRA_PREFIX = r"(?:\b(?:w/|w\.|with|incl\.?|including|includes|plus|and|upgraded)|\+|&)\s*(?:[\w-]+\s+){0,3}$"

_strong = [re.compile(p, re.I) for p in STRONG_PATTERNS]
_noun_for = re.compile(NOUN_FOR, re.I)
_starts = re.compile(STARTS_WITH_NOUN, re.I)
_ends_case = re.compile(ENDS_WITH_CASE, re.I)
_extra_prefix = re.compile(EXTRA_PREFIX, re.I)


def _introduced_as_extra(title: str, pos: int) -> bool:
    return bool(_extra_prefix.search(title[:pos]))


def looks_like_part(title: str) -> str | None:
    """Return the matched phrase if the title looks like a part/accessory, else None."""
    t = " ".join((title or "").split())
    for rx in _strong:
        m = rx.search(t)
        if m:
            return m.group(0).strip()
    m = _starts.search(t)
    if m:
        return m.group(0).strip()
    for m in _noun_for.finditer(t):
        if not _introduced_as_extra(t, m.start()):
            return m.group(0).strip()
    m = _ends_case.search(t)
    if m and not _introduced_as_extra(t, m.start()):
        # "Ibanez RG Hard Case" is a case; "Ibanez RG550 Genesis w/ Hard Case" is a guitar
        # Only short titles: long dealer titles often end with a spec list ("..., Edge Tremolo").
        if len(t.split()) <= 6 and not re.search(r"\bguitar\b", t[:m.start()], re.I):
            return m.group(0).strip()
    return None


def _money(obj) -> float | None:
    if not obj:
        return None
    if obj.get("amount_cents") is not None:
        return obj["amount_cents"] / 100.0
    try:
        return float(obj.get("amount"))
    except (TypeError, ValueError):
        return None


def _parse_year(text: str) -> int | None:
    m = re.search(r"\b(19[4-9]\d|20[0-3]\d)\b", text or "")
    if m:
        return int(m.group(1))
    m = re.search(r"\b(19[4-9]0|20[0-2]0)'?s\b", text or "")
    return int(m.group(1)) if m else None


def parse_listing(raw: dict) -> dict:
    """Flatten a raw REST listing into the fields the app uses."""
    cats = [c.get("full_name") or "" for c in raw.get("categories") or []]
    roots = sorted({c.split(" / ")[0] for c in cats if c})
    price = _money(raw.get("price"))
    buyer = _money(raw.get("buyer_price"))
    original = _money(raw.get("original_price"))
    ship = None
    shipping = raw.get("shipping") or {}
    urr = shipping.get("user_region_rate")
    if urr and urr.get("rate"):
        ship = _money(urr["rate"])
    effective = buyer if (buyer is not None and price is not None and buyer < price) else price
    photo = None
    photos = raw.get("photos") or []
    if photos:
        links = photos[0].get("_links") or {}
        photo = (links.get("small_crop") or links.get("thumbnail") or links.get("full") or {}).get("href")
    photo = photo or ((raw.get("_links") or {}).get("photo") or {}).get("href")
    cond = raw.get("condition") or {}
    ribbon = raw.get("ribbon") or {}
    return {
        "id": str(raw.get("id")),
        "title": (raw.get("title") or "").strip(),
        "make": (raw.get("make") or "").strip(),
        "model_field": (raw.get("model") or "").strip(),
        "finish": raw.get("finish") or "",
        "year_text": (raw.get("year") or "").strip(),
        "year": _parse_year(raw.get("year") or ""),
        "condition": cond.get("slug") or "",
        "condition_name": cond.get("display_name") or "",
        "price": price,
        "sale_price": buyer if effective is buyer and buyer != price else None,
        "original_price": original if (original and price and original > price) else None,
        "ribbon": ribbon.get("display"),
        "shipping": ship,
        "ships_to_region": ship is not None or bool(shipping.get("free_expedited_shipping")),
        "local_pickup": bool(shipping.get("local")),
        "total": round((effective or 0) + (ship or 0), 2) if effective is not None else None,
        "currency": (raw.get("price") or {}).get("currency") or "",
        "photo": photo,
        "url": ((raw.get("_links") or {}).get("web") or {}).get("href")
               or f"https://reverb.com/item/{raw.get('id')}",
        "published_at": raw.get("published_at") or raw.get("created_at"),
        "offers_enabled": bool(raw.get("offers_enabled")),
        "categories": cats,
        "category_roots": roots,
        "shop_name": raw.get("shop_name") or "",
    }


def classify(listing: dict, guitar_type: str = "electric", include_non_functioning: bool = False):
    """Return (reason_code, detail) for an excluded listing, or None to keep it."""
    allowed = GUITAR_ROOTS.get(guitar_type, GUITAR_ROOTS["electric"])
    roots = set(listing["category_roots"])
    if not roots & allowed:
        if "Parts" in roots:
            return "parts_category", ", ".join(listing["categories"])
        if "Accessories" in roots:
            return "accessory_category", ", ".join(listing["categories"])
        return "other_category", ", ".join(listing["categories"]) or "no category"
    hit = looks_like_part(listing["title"])
    if hit:
        return "parts_keywords", f'title contains "{hit}"'
    if listing["condition"] == "non-functioning" and not include_non_functioning:
        return "non_functioning", "condition: Non Functioning"
    if listing["total"] is None:
        return "other_category", "no price"
    return None


def published_age_days(listing: dict, now: datetime | None = None) -> float | None:
    try:
        ts = datetime.fromisoformat(listing["published_at"])
    except (TypeError, ValueError):
        return None
    now = now or datetime.now(ts.tzinfo)
    return (now - ts).total_seconds() / 86400
