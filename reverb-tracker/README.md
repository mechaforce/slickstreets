# Guitar Price Tracker for Reverb

A small app that runs on your own computer. Type a search like **Ibanez RG** and it:

- finds every matching **guitar** on Reverb, leaving out pickguards, necks, cases and other parts;
- groups the listings by **model** (RG550 Genesis, RG5120M Prestige, …);
- ranks every listing by how its **total price including shipping** compares with other listings of the same model and condition, and labels it *Great deal / Good deal / Fair / Above market / Overpriced*;
- shows Reverb's own **price-guide estimate** and **recent sold prices** where Reverb has them;
- lets you **save searches**. It re-checks them every 6 hours while it runs, then shows new listings, price drops, sold listings and price trends.

It needs only Python. There is nothing else to install and no account needed.

---

## Start it

### 1. Install Python (once)

Download Python 3.10 or newer from <https://www.python.org/downloads/> and install it.
On Windows, tick **"Add python.exe to PATH"** in the installer.

### 2. Start the tracker

- **Mac:** double-click `start-mac.command`. The first time, macOS may block it. If so, right-click the file, choose **Open**, then click **Open** again.
- **Windows:** double-click `start-windows.bat`.
- **Any system, from a terminal:** `python3 app.py` (on Windows: `py app.py`).

Your browser opens at <http://127.0.0.1:8765>. Leave the black window open while you use the app. Closing it (or pressing Ctrl+C) stops the tracker.

Saved searches and history are kept in `data/tracker.db`, so they survive restarts.

---

## Using it

1. Type a search and press **Search**. *Filters* lets you choose:
   - guitar type (electric / acoustic / bass / any)
   - condition, price range, year range
   - where it ships to
   - how many listings to scan (more listings give better comparisons but take longer; Reverb is queried at about one request per second)
2. The **summary** at the top accounts for every scanned listing:
   *Reverb found N · scanned X · kept Y guitars · excluded Z (parts/accessories, other categories, non-functioning) · split into M models.*
   Click an excluded count to see exactly what was removed and why.
3. The **models table** lists each model in the search with its listing count, median asking price, price range, recent sold median and confidence. Click a model to show only its listings.
4. The **results** show every guitar, best value first. You can also sort by price, newest, biggest price drop or distance below Reverb's estimate. Each card shows:
   - price + shipping = total, with condition and year
   - the deal label and "% vs model median"
   - its percentile (P10 means cheaper than 90% of comparable listings)
   - how many comps were used, and the confidence
   - offers, NEW and price-drop badges, and a link to Reverb
5. Click **Save search** to track it. Under **Saved**, each search shows:
   - when it was last checked, how many listings it has, and how many great/good deals
   - a median-price sparkline for its main models
   - what is new since you last looked
   - **Check now**, **Check all now**, and **History** (median price over time per model, plus every listing that appeared, dropped in price, or sold).

If a search returns few or no guitars, the page says why in plain words. For example: everything was parts, too few listings of the same model to compare, or the model couldn't be identified.

---

## How market position is calculated

**Guitars only.** The search asks Reverb for the chosen guitar category (for example `product_type=electric-guitars`), so most parts never arrive. Each listing is then checked again:

| Excluded as | Rule |
|---|---|
| Parts / accessories | Reverb category is *Parts…* or *Accessories…*, **or** the title clearly describes a part: "neck only", "body only", "case only", "for parts", "pickguard for…", "loaded pickguard", "decal", "fits Ibanez…", or a title that starts with a part name. Phrases like "with hard case", "w/ upgraded pickups" or "+ case" do not count. |
| Other categories | Not in the chosen guitar category (amps, pedals, basses when you asked for electrics, …) |
| Non-functioning | Condition "Non Functioning" (can be included with a filter) |

**Same model.** Listings are grouped by **Reverb's product page** (the "comparison shopping page"), looked up for every listing. A listing without one is grouped by its **model code** taken from the title: "RG550", "RG 550", "RG-550" and "RG550PN" are all RG550, while RG5120 is a different model. If exactly one product page in the search has that code, the listing joins it. A code match is not used across eras (more than 12 years apart), so a 1994 RG550 is not compared with today's RG550 Genesis. Listings with neither a product page nor a model code are shown as "model not identified" and are not rated.

**Same market.** Brand new, B-stock and used are separate markets. Used listings are compared within their condition tier: *Mint*, *Excellent*, *Very good*, or *Good or worse*. If a tier has fewer than 4 comparable listings, all used listings of the model are used instead. B-stock falls back to new + B-stock in the same way.

**The numbers.** Prices are compared as **total = price + shipping to your region**. A checkout sale price counts if it is lower. For each listing, the comparable listings (never including itself) give a count, minimum, 25th percentile, median, 75th percentile and maximum. Then:

- **% vs model median** = (total − median) ÷ median
- **Percentile** = share of comparable listings that are cheaper (ties count half). Lower means cheaper.

| Label | % vs model median |
|---|---|
| Great deal | 20% or more below |
| Good deal | 8–20% below |
| Fair | within ±8% |
| Above market | 8–25% above |
| Overpriced | 25% or more above |

**Confidence**

| Level | Rule |
|---|---|
| High | 8 or more comparable listings |
| Medium | 4–7 comparable listings |
| Low | 3 comparable listings |
| Wide spread | If the middle half of prices spans more than 50% of the median, confidence drops one level |

With fewer than 3 comparable listings the listing shows **Not enough comps**. The exception is when Reverb has a price-guide estimate for that exact product and condition: the listing is then compared with the estimate's midpoint at low confidence, and the card says so.

**Verify carefully.** Anything priced 50% or more below its model's median is flagged. It may be a scam, missing parts or mislabeled.

**Asking vs sold.** The comparisons use asking prices of live listings, which usually run higher than what guitars actually sell for. That's why Reverb's **price-guide estimate** (low–high range, based on completed sales) and **recent sold prices** (median of up to the last 50 sales per model) are shown alongside, where available.

All thresholds live at the top of `tracker/market.py`.

---

## Saved searches and tracking

Each check stores:

- **per-model statistics** (count, median, quartiles, min/max for new, B-stock and used), which drive the trend charts;
- **each listing's price**, which drives the **NEW** and **price dropped (was $X)** badges and the "came and went" list.

When a listing disappears, the app asks Reverb whether it **sold**, **ended**, or is still live. A still-live listing usually just fell outside the scan or your filters, so it isn't counted as gone. Up to 25 are confirmed per check; the rest are marked "no longer in results".

Saved searches with auto-check on are re-checked every 6 hours (configurable) while the app is running. You can also use **Check now** or **Check all now** at any time.

---

## Settings

Copy `config.example.json` to `config.json` and edit it, or set environment variables. Environment variables win.

| Setting | config.json | Environment variable | Default |
|---|---|---|---|
| Port | `port` | `RT_PORT` (or `PORT`) | 8765 |
| Listen address | `host` | `RT_HOST` | 127.0.0.1 (0.0.0.0 when `PORT` is set by a host) |
| Auto-check interval, hours (0 = off) | `check_interval_hours` | `RT_CHECK_INTERVAL_HOURS` | 6 |
| Display currency | `currency` | `RT_CURRENCY` | USD |
| Default ship-to region | `region` | `RT_REGION` | US_CON (lower 48) |
| Reverb personal access token (optional) | `reverb_token` | `REVERB_TOKEN` | none |
| App password (turns on login) | `password` | `RT_PASSWORD` | none |
| App username | `username` | `RT_USERNAME` | admin |
| Database file | `db_path` | `RT_DB_PATH` | `data/tracker.db` |
| Open browser on start | `open_browser` | `RT_OPEN_BROWSER` | true |
| Seconds between Reverb requests | `request_interval` | `RT_REQUEST_INTERVAL` | 1.0 |

A Reverb token is **not needed**. Everything the app uses works without one. If you set one, it is sent as `Authorization: Bearer …`.

---

## Hosting it online (Render, Railway, a home server)

The app is a single Python process with a SQLite file.

1. **Set a password:** `RT_PASSWORD=something-long` (and optionally `RT_USERNAME`). The browser then asks for it (HTTP basic auth). Use HTTPS, which Render and Railway provide.
2. **Start command:** `python app.py`. A `Procfile` is included. Hosts that set `PORT` are detected automatically: the app listens on `0.0.0.0` and doesn't try to open a browser.
3. **Keep the database:** point `RT_DB_PATH` at persistent storage, for example a Render Disk mounted at `/var/data` with `RT_DB_PATH=/var/data/tracker.db`, or a Railway volume. Without one, saved searches are lost when the service redeploys.
4. Auto-checks only run while the service is awake. Free tiers that sleep when idle will check less often.

On a **home server**, run `RT_HOST=0.0.0.0 RT_PASSWORD=… python3 app.py` and open `http://<server-ip>:8765`.

---

## Where the data comes from

The app checked Reverb's live API before building anything. The findings are in [`docs/reverb-api-notes.md`](docs/reverb-api-notes.md).

- **Listings:** Reverb's public REST API `api.reverb.com/api/listings` (50 per page).
- **Product pages, price-guide estimates, sold prices:** Reverb's public GraphQL endpoint `rql.reverb.com/graphql`, used without login. The old `/api/priceguide` endpoints now return "no longer publicly available". GraphQL is not formally documented, so if Reverb changes it, the app keeps working: estimates and sold prices simply disappear and the comparisons fall back to live listings.
- The app never scrapes web pages. It sends about one request per second and backs off when Reverb asks it to (HTTP 429). Product lookups are cached for 90 days and estimates for one day, so repeat searches are faster.

---

## For developers

```
app.py                 entry point (stdlib only)
tracker/reverb.py      Reverb REST + GraphQL client, rate limiting, retries
tracker/filtering.py   parse listings; guitar vs parts/accessories rules
tracker/grouping.py    model grouping (product page / model code), condition markets
tracker/market.py      comps, percentiles, labels, confidence
tracker/search.py      the search pipeline and plain-language explanations
tracker/store.py       SQLite: saved searches, snapshots, price history, cache
tracker/tracking.py    saved-search checks, background jobs, auto-check scheduler
tracker/server.py      HTTP server + JSON API
static/                the web page (plain HTML/CSS/JS, no build step)
tests/                 pytest suite using real API responses in tests/fixtures/
```

Run the tests with `pip install pytest` then `python -m pytest`. They use the saved fixtures and never touch the network.
