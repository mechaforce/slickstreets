"""Reverb API client (REST listing search + public GraphQL lookups).

Stdlib only. Requests are paced (default 1 per second) with exponential
backoff on 429 and 5xx. See docs/reverb-api-notes.md for what each call returns.
"""
from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

log = logging.getLogger(__name__)

REST_BASE = "https://api.reverb.com/api"
GRAPHQL_URL = "https://rql.reverb.com/graphql"
PER_PAGE = 50  # Reverb's hard cap

# Condition uuids from /api/listing_conditions, used for price-guide estimates.
CONDITION_UUIDS = {
    "brand-new": "7c3f45de-2ae0-4c81-8400-fdb6b1d74890",
    "b-stock": "7c3f45de-2ae0-4c81-8400-fdb6b1d74890",  # estimate as new
    "mint": "ac5b9c1e-dc78-466d-b0b3-7cf712967a48",
    "mint-inventory": "ac5b9c1e-dc78-466d-b0b3-7cf712967a48",
    "excellent": "df268ad1-c462-4ba6-b6db-e007e23922ea",
    "very-good": "ae4d9114-1bd7-4ec5-a4ba-6653af5ac84d",
    "good": "f7a3f48c-972a-44c6-b01a-0cd27488d3f6",
    "fair": "98777886-76d0-44c8-865e-bb40e669e934",
    "poor": "6a9dfcad-600b-46c8-9e08-ce6e5057921e",
}

Q_LISTING_CSPS = """query($ids:[String]){ listings(input:{ids:$ids}) {
  id csp { id slug title } canonicalProductId } }"""

Q_PRICE_RECS = """query($q:[Input_reverb_pricing_PriceRecommendationQuery]){
  priceRecommendations(input:{priceRecommendationQueries:$q}) { priceRecommendations {
    priceLow{amountCents} priceMiddle{amountCents} priceHigh{amountCents}
    priceMiddleThirtyDaysAgo{amountCents} } } }"""

Q_SOLD = """query($ids:[String], $countries:[String]){
  priceRecordsSearch(input:{canonicalProductIds:$ids, sellerCountries:$countries,
    actionableStatuses:["shipped","picked_up","received"], limit:50, offset:0}) {
  total priceRecords { amountProduct{amountCents currency} condition{conditionSlug}
    createdAt{seconds} listingId } } }"""


class ReverbError(Exception):
    pass


class RateLimiter:
    """Shared across clients so all Reverb traffic stays at ~1 request/second."""

    def __init__(self):
        self.lock = threading.Lock()
        self.last = 0.0

    def wait(self, interval):
        with self.lock:
            delay = self.last + interval - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            self.last = time.monotonic()


SHARED_LIMITER = RateLimiter()


class ReverbClient:
    """Live client. Tests use a fake with the same public methods."""

    def __init__(self, currency="USD", region="US_CON", country_code="US", token="",
                 request_interval=1.0, cache=None, max_retries=4, timeout=30):
        self.currency = currency
        self.region = region
        self.country_code = country_code
        self.token = token
        self.request_interval = request_interval
        self.cache = cache
        self.max_retries = max_retries
        self.timeout = timeout
        self.limiter = SHARED_LIMITER
        self.request_count = 0

    # -- low level -------------------------------------------------------
    def _pace(self):
        self.limiter.wait(self.request_interval)

    def _request(self, url, data=None, headers=None):
        headers = dict(headers or {})
        headers.setdefault("User-Agent", "reverb-price-tracker/1.0 (personal use)")
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        body = json.dumps(data).encode() if data is not None else None
        delay = 2.0
        for attempt in range(self.max_retries + 1):
            self._pace()
            self.request_count += 1
            req = urllib.request.Request(url, data=body, headers=headers,
                                         method="POST" if body else "GET")
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                if e.code in (429, 500, 502, 503, 504) and attempt < self.max_retries:
                    retry_after = e.headers.get("Retry-After")
                    sleep_for = float(retry_after) if retry_after and retry_after.isdigit() else delay
                    log.warning("Reverb %s on %s, retrying in %.0fs", e.code, url, sleep_for)
                    time.sleep(sleep_for)
                    delay *= 2
                    continue
                detail = e.read().decode("utf-8", "replace")[:300]
                raise ReverbError(f"Reverb returned HTTP {e.code}: {detail}") from e
            except (urllib.error.URLError, TimeoutError) as e:
                if attempt < self.max_retries:
                    time.sleep(delay)
                    delay *= 2
                    continue
                raise ReverbError(f"Could not reach Reverb: {e}") from e
        raise ReverbError("Too many retries")

    def _rest(self, url):
        return self._request(url, headers={
            "Accept": "application/hal+json",
            "Accept-Version": "3.0",
            "X-Display-Currency": self.currency,
            "X-Shipping-Region": self.region,
        })

    def _graphql(self, query, variables):
        out = self._request(GRAPHQL_URL, data={"query": query, "variables": variables}, headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-Display-Currency": self.currency,
            "X-Shipping-Region": self.region,
        })
        if out.get("errors") and not out.get("data"):
            raise ReverbError("GraphQL error: " + "; ".join(e.get("message", "") for e in out["errors"]))
        return out.get("data") or {}

    def _cached(self, key, ttl, fn):
        if self.cache is not None:
            hit = self.cache.cache_get(key)
            if hit is not None:
                return hit
        value = fn()
        if self.cache is not None:
            self.cache.cache_set(key, value, ttl)
        return value

    # -- public API --------------------------------------------------------
    @staticmethod
    def build_search_url(params: dict) -> str:
        q = {"per_page": PER_PAGE}
        for k in ("query", "make", "product_type", "price_min", "price_max", "year_min", "year_max", "sort"):
            if params.get(k) not in (None, ""):
                q[k] = params[k]
        url = f"{REST_BASE}/listings?" + urllib.parse.urlencode(q)
        conds = params.get("conditions") or []
        if conds:
            url += "&" + "&".join("condition%5B%5D=" + urllib.parse.quote(c) for c in conds)
        return url

    def search_page(self, url: str) -> dict:
        return self._rest(url)

    def search_total(self, url: str) -> int:
        """Total result count for a search URL (fetches a 1-listing page)."""
        url = url.replace(f"per_page={PER_PAGE}", "per_page=1")
        return int(self._rest(url).get("total") or 0)

    def listing_products(self, ids: list[str]) -> dict[str, dict]:
        """Map listing id -> {csp_id, csp_title, csp_slug, canonical_product_id}. Cached forever."""
        result, missing = {}, []
        for i in ids:
            hit = self.cache.cache_get(f"lp:{i}") if self.cache is not None else None
            if hit is not None:
                result[i] = hit
            else:
                missing.append(i)
        for start in range(0, len(missing), 100):
            chunk = missing[start:start + 100]
            data = self._graphql(Q_LISTING_CSPS, {"ids": chunk})
            for row in data.get("listings") or []:
                if not row:
                    continue
                csp = row.get("csp") or {}
                info = {
                    "csp_id": csp.get("id"),
                    "csp_title": (csp.get("title") or "").replace("\t", " ").strip() or None,
                    "csp_slug": csp.get("slug"),
                    "canonical_product_id": row.get("canonicalProductId") or None,
                }
                result[str(row["id"])] = info
                if self.cache is not None:
                    self.cache.cache_set(f"lp:{row['id']}", info, 90 * 86400)
        return result

    def price_estimates(self, pairs: list[tuple[str, str]]) -> dict[tuple, dict | None]:
        """(canonical_product_id, condition_slug) -> {low, mid, high, mid_30d} in cents, or None."""
        out, todo = {}, []
        for cp, slug in pairs:
            key = f"pe:{self.country_code}:{self.currency}:{cp}:{slug}"
            hit = self.cache.cache_get(key) if self.cache is not None else None
            if hit is not None:
                out[(cp, slug)] = hit or None
            elif slug in CONDITION_UUIDS:
                todo.append((cp, slug))
        for start in range(0, len(todo), 50):
            chunk = todo[start:start + 50]
            q = [{"canonicalProductId": cp, "conditionUuid": CONDITION_UUIDS[slug],
                  "countryCode": self.country_code} for cp, slug in chunk]
            data = self._graphql(Q_PRICE_RECS, {"q": q})
            recs = ((data.get("priceRecommendations") or {}).get("priceRecommendations")) or []
            for (cp, slug), rec in zip(chunk, recs):
                val = None
                if rec and rec.get("priceMiddle"):
                    def c(k):
                        return (rec.get(k) or {}).get("amountCents")
                    val = {"low": c("priceLow"), "mid": c("priceMiddle"), "high": c("priceHigh"),
                           "mid_30d": c("priceMiddleThirtyDaysAgo")}
                out[(cp, slug)] = val
                if self.cache is not None:
                    self.cache.cache_set(f"pe:{self.country_code}:{self.currency}:{cp}:{slug}", val or {}, 86400)
        return out

    def sold_records(self, canonical_ids: list[str]) -> dict:
        """Recent sold transactions for a product: {total, records:[{cents, condition, ts}]}."""
        ids = sorted(set(canonical_ids))
        key = f"sold:{self.country_code}:{','.join(ids)}"

        def fetch():
            data = self._graphql(Q_SOLD, {"ids": ids, "countries": [self.country_code]})
            prs = data.get("priceRecordsSearch") or {}
            recs = []
            for r in prs.get("priceRecords") or []:
                amt = r.get("amountProduct") or {}
                if amt.get("currency") and amt["currency"] != self.currency:
                    continue
                recs.append({"cents": amt.get("amountCents"),
                             "condition": (r.get("condition") or {}).get("conditionSlug"),
                             "ts": (r.get("createdAt") or {}).get("seconds")})
            return {"total": prs.get("total") or 0, "records": recs}
        return self._cached(key, 86400, fetch)

    def listing_state(self, listing_id) -> str | None:
        """'live', 'sold', 'ended', ... or None if not found."""
        try:
            data = self._rest(f"{REST_BASE}/listings/{listing_id}")
        except ReverbError as e:
            if "HTTP 404" in str(e):
                return "removed"
            raise
        return (data.get("state") or {}).get("slug")
