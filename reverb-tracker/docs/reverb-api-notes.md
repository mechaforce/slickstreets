# Reverb API notes (verified live, 2026-11-25)

Every finding below was checked against the live API, unauthenticated, at about
1 request per second. Raw responses are saved in `tests/fixtures/`.

Headers used for REST: `Accept: application/hal+json`, `Accept-Version: 3.0`,
`X-Display-Currency: USD`, `X-Shipping-Region: US_CON`.

## 1. Listing search: `GET https://api.reverb.com/api/listings`

Top-level response: `total`, `current_page`, `per_page`, `total_pages`,
`_links.next.href` / `_links.prev.href`, `humanized_params` (for example
`"ibanez rg" in Electric Guitars`), `listings[]`, and `ships_to`.

### Filters

| Param | Works? | Evidence (`query=ibanez rg`, 6,019 total unfiltered) |
|---|---|---|
| `query` | yes | full-text; matches parts too ("pickguard for Ibanez RG") |
| `make=ibanez` | yes | `query=rg&make=ibanez` gives 4,158 |
| `product_type=electric-guitars` | **yes** | 3,406. Values are root category slugs: `electric-guitars`, `acoustic-guitars`, `bass-guitars`, `parts`, … |
| `product_type[]=a&product_type[]=b` | **no** | HTTP 400. A comma list is silently ignored, so only one product type per request |
| `category=solid-body` | only together with `product_type` | alone it is ignored (6,019); with `product_type=electric-guitars` it gives 3,079 |
| `condition=new` / `used` / `b-stock` / `mint` / `non-functioning` | yes | 3,819 / 2,108 / 73 / 74 / 19 |
| `condition[]=used&condition[]=b-stock` | yes | 2,181 (array form OK here) |
| `price_min` / `price_max` | yes | in display currency |
| `year_min` / `year_max` | yes | but `year` is free text, so the filter is fuzzy |
| `sort=published_at\|desc`, `sort=price\|asc` | yes | |
| `per_page` | capped at **50** | `per_page=100` still returns 50 |
| `csp_id`, `comparison_shopping_page_id`, `csp_slug` | **no** | silently ignored |

### Pagination

Follow `_links.next.href`. Deep pages work (page 121 of 121 returned the last
19 rows). A page past the end returns `listings: []`. There is no hard cap at
6,000 listings, but the app limits a scan to a user-chosen number of listings
(default 250, which is 5 requests).

### Listing fields (search results)

| Need | Field | Notes |
|---|---|---|
| id | `id` | int |
| make | `make` | clean ("Ibanez") |
| model | `model` | **seller free text** and messy, e.g. "Ibanez RG RG5120M Electric Guitar w/ Case", "Ibanez RG 6 String Electric Guitar". Not a reliable model key |
| title | `title` | |
| year | `year` | free text: `""`, `"1994"`, `"1990's"`, `"1987-92"`, `"Current"`, `"2008 Spring Special Limited Edition"` |
| finish | `finish` | |
| condition | `condition.slug` / `.display_name` / `.uuid` | slugs seen: `brand-new`, `b-stock`, `mint`, `mint-inventory` (displayed "Mint", dealer used stock, included in `condition=used`), `excellent`, `very-good`, `good`, `fair`, `poor`, `non-functioning` |
| price | `price.amount` (string), `price.amount_cents`, `price.currency` | in `X-Display-Currency` |
| sale price | `buyer_price` | can be lower than `price` (for example, a Black Friday sale applied at checkout) |
| was-price | `original_price` + `ribbon {display, reason}` | present only when a price drop or sale is shown |
| shipping | `shipping.user_region_rate.rate.amount` | rate for the `X-Shipping-Region` header; `shipping.rates[]` lists every region; `shipping.local` = local pickup |
| photos | `photos[]._links.{thumbnail,small_crop,large_crop,full}.href`, `_links.photo.href` | |
| published | `published_at`, `created_at` | ISO 8601 with offset |
| offers | `offers_enabled` (bool) | |
| category | `categories[] {uuid, full_name}` | e.g. `"Electric Guitars / Solid Body"`, `"Parts / Pickguards"`. **No root slug in search results**: map the uuid with `/api/categories/flat` (`root_slug`) or take the prefix of `full_name` before " / " |
| state | `state.slug` (`live`) | |
| link | `_links.web.href` | |
| **CSP id** | **not in search results** | |

### Single listing: `GET /api/listings/{id}`

This adds `comparison_shopping_page_id`, `_links.comparison_shopping`
(`/api/csps/{id}`), `offer_count`, `stats {views, watches}`, `location`,
`sold_as_is` and `handmade`. Fetching it per listing would cost one request
per listing, which is too slow. GraphQL does the same lookup in bulk (§3).

### Other REST endpoints

- `GET /api/categories/flat` has 320 categories with `uuid`, `slug`, `full_name`, `root_slug`. Category slugs are **not unique** (`archtop`, `left-handed`, `12-string` each exist under several roots), so match on uuid.
- `GET /api/listing_conditions` lists conditions with uuid and display_name but **no slug**. The uuids are needed for GraphQL price estimates.
- `GET /api/csps/{id}` returns the comparison shopping page: `title` ("Ibanez RG5120M Prestige"), `used_total`, `new_total`, `new_low_price`, `used_low_price`, `root_category_slug`, and `_links.listings` → `/api/listings/all?cp_ids[]=…` (works: 24 listings, all that product).
- `GET /api/csps?query=…` searches product pages.
- `GET /api/priceguide…` and `/api/priceguide/{id}/transactions` return **HTTP 403 `{"Error": "This endpoint is no longer publicly available."}`**.

## 2. Telling guitars from parts

Category data is reliable. Every pickguard, neck, tremolo cover and pickup
seen was in a `Parts…` category (`Parts / Pickguards`, `Parts / Guitar Parts / Necks`,
`Parts / Guitar Pickups`, `Parts / Guitar Bodies`, `Parts / Tuning Heads`, plain `Parts`).
On `ibanez rg` page 2 without a product filter, 12 of 50 rows were parts, and
every one of them had a Parts category. Parts also **never have a CSP** in the sample.

Rare miscategorisation does happen: under `product_type=bass-guitars` there was an
"Ibanez RG470DXW" (a guitar), so the title filter stays as a second check.

Strategy:
1. Pass `product_type` to the API (electric by default; acoustic or bass can be chosen; "any guitar" sends no product filter and relies on step 2).
2. Keep a listing only if a category root is `electric-guitars` / `acoustic-guitars` (or `bass-guitars` when chosen).
3. Run a title keyword filter for parts and accessories.
4. Drop `non-functioning` by default.

## 3. GraphQL: `POST https://rql.reverb.com/graphql` (works unauthenticated)

Introspection is disabled, but the queries below work and are what the app uses.
Errors include "Did you mean" hints.

**Bulk CSP lookup** (100 ids in one call worked):
```graphql
query($ids:[String]){ listings(input:{ids:$ids}) { id csp { id slug title } canonicalProductId } }
```
For `ibanez rg` pages 1–2, 72 of 100 had a CSP. All 16 parts had none. Guitars without
a CSP are mostly dealer listings with no model number ("Ibanez RG Standard 6str
Electric Guitar - Blue Haze"). `canonicalProductId` is a variant (finish/year)
under a CSP; one CSP has several (`csp(input:{id}) { canonicalProductIds }`).

**Price-guide estimate** (the transaction-based range shown on Reverb's price guide):
```graphql
query($q:[Input_reverb_pricing_PriceRecommendationQuery]){
  priceRecommendations(input:{priceRecommendationQueries:$q}) {
    priceRecommendations { priceLow{amountCents} priceMiddle{amountCents} priceHigh{amountCents} priceMiddleThirtyDaysAgo{amountCents} } } }
# $q = [{canonicalProductId:"374211", conditionUuid:"df268ad1-…"(Excellent), countryCode:"US"}, …]
```
Batching works. The result is null when there is not enough data
(e.g. RG655 Prestige / Very Good). Example: RG5120M Excellent gave $1,335–$1,483,
mid $1,409. The cheapest live used listing was $1,700, which shows asking prices
running above sold prices.

**Sold transactions** (still public through GraphQL even though the REST version returns 403):
```graphql
{ priceRecordsSearch(input:{canonicalProductIds:["374211","205599"], sellerCountries:["US"],
    actionableStatuses:["shipped","picked_up","received"], limit:50, offset:0}) {
  total priceRecords { amountProduct{amountCents} condition{conditionSlug} createdAt{seconds} listingId } } }
```
This returned 279 sold records for the RG5120M Prestige.

`listingsSearch(input:{query, limit, offset})` exists too and returns `csp` inline, but the
documented REST search is the primary source. GraphQL is used only for the bulk CSP lookup and
for market estimates.

## 4. Auth, regions, limits

- **Token:** an `Authorization: Bearer <invalid>` header is ignored (still 200). Every
  call above works without a token, so the app treats the token as optional and sends it
  only when configured. A real token was not tested.
- **Region/currency:** `X-Shipping-Region: GB` + `X-Display-Currency: GBP` returns
  prices in £ and `user_region_rate` for GB. Region codes seen: `US_CON`, `US_AK`, `US_HI`, `GB`, …
  When a listing does not ship to the region, `user_region_rate` is absent.
- **Rate limits:** no rate-limit headers were returned. The app paces itself at 1 request per second and
  backs off exponentially on 429 or 5xx (honouring `Retry-After`).
