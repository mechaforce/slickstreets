/* Reverb Guitar Price Tracker - plain JS, no build step. */
"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
const app = $("#app");

const state = {
  config: null,
  params: null,          // current search form values
  job: null,             // {id, message, progress}
  result: null,          // last search result (search page)
  jobId: null,           // job that produced state.result
  view: freshView(),     // result filters for the visible result
};

function freshView() {
  return { model: null, label: null, market: "all", sort: "market", limit: 60, dealsOnly: false };
}

/* ---------- helpers ---------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function money(v, opts = {}) {
  if (v === null || v === undefined || isNaN(v)) return "–";
  const cur = (state.config && state.config.currency) || "USD";
  const digits = opts.cents && Math.round(v) !== v ? 2 : 0;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v);
  } catch (e) { return "$" + Math.round(v).toLocaleString(); }
}
function signedPct(v) {
  if (v === null || v === undefined) return "–";
  const r = Math.round(v);
  return (r > 0 ? "+" : r < 0 ? "−" : "±") + Math.abs(r) + "%";
}
function relTime(ts) {
  if (!ts) return "never";
  const s = Date.now() / 1000 - ts;
  if (s < 60) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
}
function dateStr(ts) {
  return new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function plural(n, w, p) { return n + " " + (n === 1 ? w : (p || w + "s")); }
async function api(method, path, body) {
  const res = await fetch(path, {
    method, headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}
function store(key, val) {
  try {
    if (val === undefined) return JSON.parse(localStorage.getItem(key) || "null");
    localStorage.setItem(key, JSON.stringify(val));
  } catch (e) { return null; }
}
const LABEL_CLASS = {
  "Great deal": "lbl-great", "Good deal": "lbl-good", "Fair": "lbl-fair",
  "Above market": "lbl-above", "Overpriced": "lbl-over", "Not enough comps": "lbl-none", "Unrated": "lbl-none",
};
const LABEL_ORDER = ["Great deal", "Good deal", "Fair", "Above market", "Overpriced", "Not enough comps", "Unrated"];
const SEG_LABEL = { "new": "Brand new", "b-stock": "B-stock", "used": "Used" };
const TIER_LABEL = { "mint": "Mint", "excellent": "Excellent", "very-good": "Very good", "good-or-worse": "Good or worse", "new": "Brand new", "b-stock": "B-stock" };

async function pollJob(jobId, onProgress) {
  for (;;) {
    const job = await api("GET", "/api/jobs/" + jobId);
    onProgress && onProgress(job);
    if (job.status === "done") return job.result;
    if (job.status === "error") throw new Error(job.error || "Failed");
    await new Promise(r => setTimeout(r, 700));
  }
}

/* ---------- routing ---------- */
window.addEventListener("hashchange", route);
async function route() {
  const h = location.hash || "#/";
  $$("nav a").forEach(a => a.classList.toggle("active",
    (a.dataset.nav === "saved" && h.startsWith("#/saved")) || (a.dataset.nav === "search" && !h.startsWith("#/saved"))));
  let m;
  if ((m = h.match(/^#\/saved\/(\d+)\/history/))) return renderHistory(+m[1]);
  if ((m = h.match(/^#\/saved\/(\d+)/))) return renderSaved(+m[1]);
  if (h.startsWith("#/saved")) return renderSavedList();
  return renderSearchPage();
}

/* ---------- search page ---------- */
function defaultParams() {
  const d = Object.assign({}, state.config.defaults);
  const last = store("rt-last-params");
  return last ? Object.assign(d, last) : d;
}

function filtersHtml(p) {
  const c = state.config;
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? "selected" : ""}>${esc(label)}</option>`;
  const conds = p.conditions || [];
  return `
  <div class="filter-grid">
    <label class="f">Guitar type
      <select name="guitar_type">
        ${opt("electric", "Electric guitars", p.guitar_type)}${opt("acoustic", "Acoustic guitars", p.guitar_type)}
        ${opt("bass", "Bass guitars", p.guitar_type)}${opt("any", "Any guitar (electric + acoustic)", p.guitar_type)}
      </select></label>
    <label class="f">Condition
      <span class="checks">
        <label><input type="checkbox" name="cond" value="new" ${conds.includes("new") ? "checked" : ""}> New</label>
        <label><input type="checkbox" name="cond" value="b-stock" ${conds.includes("b-stock") ? "checked" : ""}> B-stock</label>
        <label><input type="checkbox" name="cond" value="used" ${conds.includes("used") ? "checked" : ""}> Used</label>
      </span></label>
    <label class="f">Price (${esc(c.currency)})
      <span class="pair"><input name="price_min" type="number" min="0" placeholder="min" value="${esc(p.price_min ?? "")}">–<input name="price_max" type="number" min="0" placeholder="max" value="${esc(p.price_max ?? "")}"></span></label>
    <label class="f">Year
      <span class="pair"><input name="year_min" type="number" min="1900" max="2100" placeholder="from" value="${esc(p.year_min ?? "")}">–<input name="year_max" type="number" min="1900" max="2100" placeholder="to" value="${esc(p.year_max ?? "")}"></span></label>
    <label class="f">Ship to
      <select name="region">${c.regions.map(r => opt(r.code, r.name, p.region || c.defaults.region)).join("")}</select></label>
    <label class="f">Listings to scan
      <select name="scan_limit">${c.scan_limits.map(n => opt(n, n.toLocaleString() + (n >= 1000 ? " (slow)" : ""), p.scan_limit)).join("")}</select></label>
    <label class="f">&nbsp;
      <span class="checks"><label><input type="checkbox" name="include_non_functioning" ${p.include_non_functioning ? "checked" : ""}> Include non-functioning</label></span></label>
  </div>`;
}

function readForm(form) {
  const fd = new FormData(form);
  return {
    query: (fd.get("query") || "").trim(),
    guitar_type: fd.get("guitar_type"),
    conditions: fd.getAll("cond"),
    price_min: fd.get("price_min") || null, price_max: fd.get("price_max") || null,
    year_min: fd.get("year_min") || null, year_max: fd.get("year_max") || null,
    region: fd.get("region"), scan_limit: +fd.get("scan_limit"),
    include_non_functioning: !!fd.get("include_non_functioning"),
  };
}

function activeFilterCount(p) {
  const d = state.config.defaults;
  let n = 0;
  if (p.guitar_type && p.guitar_type !== d.guitar_type) n++;
  if ((p.conditions || []).length) n++;
  if (p.price_min || p.price_max) n++;
  if (p.year_min || p.year_max) n++;
  if (p.region && p.region !== d.region) n++;
  if (p.include_non_functioning) n++;
  return n;
}

function renderSearchPage() {
  state.params = state.params || defaultParams();
  const p = state.params;
  const nf = activeFilterCount(p);
  app.innerHTML = `
    <form class="panel" id="search-form" autocomplete="off">
      <div class="searchbar">
        <input type="search" name="query" placeholder='Search Reverb, e.g. "Ibanez RG550 Genesis"' value="${esc(p.query)}" autofocus>
        <button class="btn primary" type="submit">Search</button>
      </div>
      <details class="filters" ${nf ? "open" : ""}><summary>Filters${nf ? ` (${nf} on)` : ""} · scanning ${(+p.scan_limit).toLocaleString()} listings</summary>${filtersHtml(p)}</details>
    </form>
    <div id="job"></div>
    <div id="results"></div>`;
  $("#search-form").addEventListener("submit", e => { e.preventDefault(); startSearch(readForm(e.target)); });
  if (state.job) showJob();
  if (state.result) renderResults($("#results"), state.result, { saved: null });
  else if (!state.job) $("#results").innerHTML = introHtml();
}

function introHtml() {
  return `<div class="panel muted">
    <h2>How it works</h2>
    <p>Type a make and model. The app scans Reverb listings, drops parts and accessories, groups the rest by model,
    and ranks every guitar by how its total price (with shipping) compares with other listings of the <b>same model and condition</b>.</p>
    <p class="small">Labels: <span class="badge lbl-great">Great deal</span> 20%+ below the model median ·
    <span class="badge lbl-good">Good deal</span> 8–20% below · <span class="badge lbl-fair">Fair</span> within ±8% ·
    <span class="badge lbl-above">Above market</span> 8–25% above · <span class="badge lbl-over">Overpriced</span> 25%+ above.
    Save a search to track new listings and price changes over time.</p></div>`;
}

async function startSearch(params) {
  if (!params.query) { $("input[name=query]").focus(); return; }
  state.params = params;
  store("rt-last-params", Object.assign({}, params, { query: params.query }));
  state.result = null;
  state.view = freshView();
  $("#results").innerHTML = "";
  try {
    const { job_id } = await api("POST", "/api/search", { params });
    state.job = { id: job_id, message: "Starting…", progress: 0 };
    showJob();
    const result = await pollJob(job_id, j => { state.job = { id: job_id, message: j.message, progress: j.progress }; showJob(); });
    state.job = null;
    state.result = result;
    state.jobId = job_id;
    if (!location.hash.startsWith("#/saved")) { showJob(); renderResults($("#results"), result, { saved: null }); }
  } catch (e) {
    state.job = null;
    showJob();
    const r = $("#results");
    if (r) r.innerHTML = `<div class="error">Search failed: ${esc(e.message)}</div>`;
  }
}

function showJob(target) {
  const el = target || $("#job");
  if (!el) return;
  const j = state.job;
  el.innerHTML = j ? `<div class="panel"><div class="small">${esc(j.message)}</div><div class="progress"><div style="width:${Math.round((j.progress || 0) * 100)}%"></div></div>
    <div class="tiny">Reverb is queried politely (about one request per second), so a large scan takes a little while.</div></div>` : "";
}

/* ---------- results ---------- */
function renderResults(el, result, opts) {
  const s = result.summary;
  const v = state.view;
  const groupsByKey = Object.fromEntries(result.groups.map(g => [g.key, g]));
  if (v.model && !groupsByKey[v.model]) v.model = null;
  const eg = s.excluded_by_group;
  const xLink = (grp, n, label) => n ? `<button class="linkbtn" data-x="${grp}">${label} <b>${n.toLocaleString()}</b></button>` : `${label} <b>0</b>`;
  const ptName = { "electric-guitars": "electric-guitar", "acoustic-guitars": "acoustic-guitar", "bass-guitars": "bass" }[s.product_type];

  const labelCounts = LABEL_ORDER.filter(l => s.labels[l]).map(l =>
    `<button class="chip ${v.label === l ? "on" : ""}" data-label="${esc(l)}"><span class="badge ${LABEL_CLASS[l]}">${esc(l)}</span><span class="n">${s.labels[l]}</span></button>`).join("");

  el.innerHTML = `
    ${(result.explanations || []).map(n => `<div class="note ${n.level === "warn" ? "warn" : ""}">${esc(n.text)}</div>`).join("")}
    <section class="panel">
      <div class="summary-line">
        Reverb found <b>${s.reverb_total.toLocaleString()}</b> listings<span class="sep">·</span>
        scanned <b>${s.scanned.toLocaleString()}</b><span class="sep">·</span>
        kept <b>${s.kept.toLocaleString()}</b> guitars<span class="sep">·</span>
        ${s.excluded ? `<button class="linkbtn" data-x="all">excluded <b>${s.excluded.toLocaleString()}</b></button>` : "excluded <b>0</b>"}
        (${xLink("parts", eg.parts, "parts/accessories")}, ${xLink("other", eg.other, "other categories")}, ${xLink("non_functioning", eg.non_functioning, "non-functioning")})<span class="sep">·</span>
        split into <b>${s.models}</b> model${s.models === 1 ? "" : "s"}
      </div>
      <div class="tiny" style="margin-top:4px">
        ${s.api_prefiltered ? `Before scanning, Reverb's ${ptName || ""} category filter already set aside ${s.api_prefiltered.toLocaleString()} listings (parts, cases, other gear). ` : ""}
        ${s.rated} of ${s.kept} rated (${s.rated - (s.rated_by_estimate || 0)} against same-model listings${s.rated_by_estimate ? `, ${s.rated_by_estimate} against Reverb's price guide` : ""}) · ${s.with_estimate} with a Reverb price-guide estimate
        ${s.estimate_error ? " · price-guide lookup failed this time" : ""} · ${s.seconds}s${s.requests ? `, ${s.requests} requests` : ""}
        ${result.checked_at ? ` · checked ${relTime(result.checked_at)}` : ""}
      </div>
      ${labelCounts ? `<div class="chips">${labelCounts}</div>` : ""}
      <div class="tiny" style="margin-top:10px">Comparisons use <b>asking prices</b> of live listings. Asking prices usually run higher than what guitars actually sell for,
        so Reverb's price-guide estimate and recent sold prices (from completed sales) are shown alongside where available.</div>
    </section>
    ${modelTableHtml(result.groups, v)}
    <div id="list-area"></div>`;

  $$("[data-x]", el).forEach(b => b.addEventListener("click", () => showExcluded(result, b.dataset.x)));
  $$("[data-label]", el).forEach(b => b.addEventListener("click", () => {
    v.label = v.label === b.dataset.label ? null : b.dataset.label; v.limit = 60; renderResults(el, result, opts);
  }));
  $$("tr.row", el).forEach(tr => tr.addEventListener("click", () => {
    v.model = v.model === tr.dataset.key ? null : tr.dataset.key; v.limit = 60; renderResults(el, result, opts);
    $("#list-area").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  const more = $("#show-all-models", el);
  if (more) more.addEventListener("click", () => { v.allModels = true; renderResults(el, result, opts); });
  renderList($("#list-area", el), result, groupsByKey, opts, () => renderResults(el, result, opts));
}

function modelTableHtml(groups, v) {
  if (!groups.length) return "";
  const cap = v.allModels ? groups.length : 12;
  const rows = groups.slice(0, cap).map(g => {
    const main = g.main_segment ? g.segments[g.main_segment] : null;
    const soldSeg = g.sold && g.sold.by_market ? (g.sold.by_market[g.main_segment] || g.sold.by_market.used) : null;
    const otherSegs = Object.keys(g.segments).filter(k => k !== g.main_segment)
      .map(k => `${SEG_LABEL[k]} ${g.segments[k].count} · ${money(g.segments[k].median)}`).join("<br>");
    return `<tr class="row ${v.model === g.key ? "sel" : ""}" data-key="${esc(g.key)}">
      <td class="name">${esc(g.name)}${g.source !== "csp" ? ` <span class="tiny">(${esc(g.source)})</span>` : ""}
        ${g.deals ? ` <span class="badge lbl-good">${g.deals} deal${g.deals > 1 ? "s" : ""}</span>` : ""}</td>
      <td class="num">${g.count}</td>
      <td>${main ? `${SEG_LABEL[g.main_segment]} <span class="tiny">(${main.count})</span>` : "–"}${otherSegs ? `<div class="tiny">${otherSegs}</div>` : ""}</td>
      <td class="num">${main ? money(main.median) : "–"}</td>
      <td class="num">${main ? `${money(main.min)} – ${money(main.max)}` : "–"}</td>
      <td class="num">${soldSeg ? `${money(soldSeg.median)} <span class="tiny">(${soldSeg.count} sold)</span>` : "<span class='tiny'>–</span>"}</td>
      <td class="conf-${g.confidence}" title="${esc(g.confidence_reason)}">${g.confidence === "none" ? "n/a" : g.confidence}</td>
    </tr>`;
  }).join("");
  return `<section class="panel">
    <h2>Models in this search</h2>
    <div class="table-wrap"><table class="models">
      <thead><tr><th>Model</th><th class="num">Listings</th><th>Main market</th><th class="num">Median ask</th><th class="num">Range</th><th class="num">Recent sold median</th><th>Confidence</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${groups.length > cap ? `<div class="more"><button class="btn small" id="show-all-models">Show all ${groups.length} models</button></div>` : ""}
    <div class="tiny">Click a model to show only its listings. Confidence: high = 8+ comparable listings, medium = 4–7, low = fewer or a very wide price spread.</div>
  </section>`;
}

function filteredListings(result) {
  const v = state.view;
  let ls = result.listings.slice();
  if (v.model) ls = ls.filter(l => l.group_key === v.model);
  if (v.label) ls = ls.filter(l => l.label === v.label);
  if (v.market !== "all") ls = ls.filter(l => l.segment === v.market);
  if (v.dealsOnly) ls = ls.filter(l => l.label === "Great deal" || l.label === "Good deal");
  if (v.newOnly) ls = ls.filter(l => l.new_since_view || (l.is_new && !("new_since_view" in l)));
  const drop = l => {
    const was = l.tracked_was_total || (l.was_price ? l.was_price + (l.shipping || 0) : null);
    return was ? (was - l.total) / was : 0;
  };
  const sorts = {
    market: (a, b) => rank(a) - rank(b),
    price: (a, b) => a.total - b.total,
    price_desc: (a, b) => b.total - a.total,
    newest: (a, b) => (b.published_at || "").localeCompare(a.published_at || ""),
    drop: (a, b) => drop(b) - drop(a) || rank(a) - rank(b),
    vs_estimate: (a, b) => (a.pct_vs_estimate ?? 999) - (b.pct_vs_estimate ?? 999),
  };
  ls.sort(sorts[v.sort] || sorts.market);
  return ls;
}
function rank(l) { return l.pct_vs_median === null || l.pct_vs_median === undefined ? 10000 + (l.total || 0) / 1e6 : l.pct_vs_median; }

function renderList(el, result, groupsByKey, opts, rerender) {
  const v = state.view;
  const ls = filteredListings(result);
  const markets = ["new", "b-stock", "used"].filter(m => result.listings.some(l => l.segment === m));
  const opt = (val, label) => `<option value="${val}" ${v.sort === val ? "selected" : ""}>${label}</option>`;
  const hasNew = result.listings.some(l => l.new_since_view);
  el.innerHTML = `
    <div class="toolbar">
      <h2 style="margin:0">${plural(ls.length, "listing")}</h2>
      ${v.model ? `<span class="active-filter">${esc(groupsByKey[v.model].name)} <button title="Show all models" data-clear="model">×</button></span>` : ""}
      ${v.label ? `<span class="active-filter">${esc(v.label)} <button data-clear="label">×</button></span>` : ""}
      <span class="grow"></span>
      ${hasNew ? `<label class="small"><input type="checkbox" id="new-only" ${v.newOnly ? "checked" : ""}> New since last visit</label>` : ""}
      <label class="small"><input type="checkbox" id="deals-only" ${v.dealsOnly ? "checked" : ""}> Deals only</label>
      ${markets.length > 1 ? `<select id="market-sel" title="Market">
        <option value="all">All conditions</option>${markets.map(m => `<option value="${m}" ${v.market === m ? "selected" : ""}>${SEG_LABEL[m]}</option>`).join("")}</select>` : ""}
      <select id="sort-sel" title="Sort">
        ${opt("market", "Best value first")}${opt("price", "Price: low to high")}${opt("price_desc", "Price: high to low")}
        ${opt("newest", "Newest")}${opt("drop", "Biggest price drop")}${opt("vs_estimate", "Furthest below Reverb estimate")}
      </select>
      ${opts.saved ? "" : `<button class="btn small primary" id="save-btn">Save search</button>`}
    </div>
    ${ls.length ? `<div class="cards">${ls.slice(0, v.limit).map(cardHtml).join("")}</div>` :
      `<div class="empty">${result.listings.length ? "No listings match these filters." : "No guitar listings to show. See the notes above for why."}</div>`}
    ${ls.length > v.limit ? `<div class="more"><button class="btn" id="more-btn">Show ${Math.min(60, ls.length - v.limit)} more (${ls.length - v.limit} left)</button></div>` : ""}`;
  $$("[data-clear]", el).forEach(b => b.addEventListener("click", () => { v[b.dataset.clear] = null; rerender(); }));
  const on = (id, ev, fn) => { const x = $("#" + id, el); if (x) x.addEventListener(ev, fn); };
  on("deals-only", "change", e => { v.dealsOnly = e.target.checked; v.limit = 60; rerender(); });
  on("new-only", "change", e => { v.newOnly = e.target.checked; v.limit = 60; rerender(); });
  on("market-sel", "change", e => { v.market = e.target.value; v.limit = 60; rerender(); });
  on("sort-sel", "change", e => { v.sort = e.target.value; rerender(); });
  on("more-btn", "click", () => { v.limit += 60; rerender(); });
  on("save-btn", "click", () => saveSearch(result));
}

function cardHtml(l) {
  const cls = LABEL_CLASS[l.label] || "lbl-none";
  const st = l.comp_stats;
  const shipping = l.shipping === null || l.shipping === undefined
    ? (l.local_pickup ? " + local pickup" : " + shipping n/a")
    : l.shipping === 0 ? " + free shipping" : ` + ${money(l.shipping)} ship`;
  const priceShown = l.sale_price ?? l.price;
  const badges = [];
  badges.push(`<span class="badge ${cls}">${esc(l.label)}</span>`);
  if (l.new_since_view) badges.push(`<span class="badge new" title="First seen ${l.first_seen_at ? dateStr(l.first_seen_at) : ""}">NEW</span>`);
  else if (l.is_new && !("new_since_view" in l)) badges.push(`<span class="badge new" title="Listed in the last 3 days">NEW</span>`);
  const wasTotal = l.tracked_was_total;
  if (wasTotal) badges.push(`<span class="badge drop">Price dropped (was ${money(wasTotal)})</span>`);
  else if (l.was_price) badges.push(`<span class="badge drop">Price dropped (was ${money(l.was_price)})</span>`);
  if (l.sale_price) badges.push(`<span class="badge drop" title="${esc(l.ribbon || "")}">Sale ${money(l.price)} → ${money(l.sale_price)}</span>`);
  if (l.offers_enabled) badges.push(`<span class="badge outline">Accepts offers</span>`);
  if (l.verify) badges.push(`<span class="badge verify" title="More than 50% below the model median">⚠ Verify carefully</span>`);

  let market = "";
  if (l.pct_vs_median !== null && l.pct_vs_median !== undefined && l.comp_basis === "Reverb price guide") {
    market = `<div class="market"><span class="pct">${signedPct(l.pct_vs_median)}</span> vs Reverb price guide ${money(l.market_ref)}</div>
      <div class="tiny" title="${esc(l.confidence_reason)}">${plural(l.comp_count, "live comp")} only · <span class="conf-low">low confidence</span> · estimate is sold-based</div>`;
  } else if (l.pct_vs_median !== null && l.pct_vs_median !== undefined) {
    const cheaperThan = Math.round(100 - l.percentile);
    market = `<div class="market"><span class="pct">${signedPct(l.pct_vs_median)}</span> vs model median ${money(st.median)}
      <span class="tiny" title="Cheaper than ${cheaperThan}% of comparable listings">· P${Math.round(l.percentile)}</span></div>
      <div class="tiny" title="Comps: ${esc(l.comp_basis)} · min ${money(st.min)}, 25% ${money(st.p25)}, median ${money(st.median)}, 75% ${money(st.p75)}, max ${money(st.max)}. ${esc(l.confidence_reason)}">
        ${plural(l.comp_count, "comp")} (${esc(l.comp_basis)}) · <span class="conf-${l.confidence}">${esc(l.confidence)} confidence</span></div>`;
  } else {
    market = `<div class="tiny">${esc(l.label === "Unrated" ? "Model not identified, so no like-for-like comparison." : "Not rated: " + l.confidence_reason + ".")}</div>`;
  }
  const est = l.estimate && l.comp_basis !== "Reverb price guide" ? `<div class="tiny" title="Reverb's estimate of what this model sells for in this condition">Reverb price guide ${money(l.estimate.low)}–${money(l.estimate.high)} · ${signedPct(l.pct_vs_estimate)}</div>` : "";
  const meta = [l.condition_name, l.year_text, l.finish].filter(Boolean).map(esc).join(" · ");
  return `<article class="card">
    <a href="${esc(l.url)}" target="_blank" rel="noopener">${l.photo ? `<img class="ph" loading="lazy" src="${esc(l.photo)}" alt="">` : `<div class="ph"></div>`}</a>
    <div class="body">
      <a class="title" href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.title)}">${esc(l.title)}</a>
      ${state.view.model ? "" : `<div class="tiny" title="Model group">${esc(l.group_name)}</div>`}
      <div class="price">${money(priceShown, { cents: true })}${shipping} = <b>${money(l.total)}</b></div>
      <div class="meta">${meta}</div>
      <div class="badges">${badges.join("")}</div>
      ${market}${est}
    </div></article>`;
}

function showExcluded(result, grp) {
  const map = { parts: ["parts_category", "accessory_category", "parts_keywords"], other: ["other_category"], non_functioning: ["non_functioning"] };
  const items = result.excluded.filter(l => grp === "all" || map[grp].includes(l.exclude_reason));
  const labels = result.summary.reason_labels;
  const byReason = {};
  items.forEach(l => (byReason[l.exclude_reason] = byReason[l.exclude_reason] || []).push(l));
  const sections = Object.entries(byReason).map(([r, ls]) => `
    <h2 style="margin-top:14px">${esc(labels[r] || r)} <span class="muted">(${ls.length})</span></h2>
    <ul class="xlist">${ls.map(l => `<li>${l.photo ? `<img src="${esc(l.photo)}" loading="lazy" alt="">` : `<span class="noimg"></span>`}
      <div><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a>
      <div class="why">${money(l.total)} · ${esc(l.condition_name)} · ${esc(l.exclude_detail)}</div></div></li>`).join("")}</ul>`).join("");
  openModal(`Excluded listings (${items.length})`, sections || "<p>None.</p>");
}

function openModal(title, html) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-bg"><div class="modal" role="dialog" aria-modal="true">
    <div class="modal-head"><h2 style="margin:0">${esc(title)}</h2><button class="btn small" data-close>Close</button></div>${html}</div></div>`;
  const close = () => { root.innerHTML = ""; document.removeEventListener("keydown", onKey); };
  const onKey = e => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  $(".modal-bg", root).addEventListener("click", e => { if (e.target.classList.contains("modal-bg") || e.target.hasAttribute("data-close")) close(); });
}

async function saveSearch(result) {
  const name = prompt("Name this saved search:", result.params.query);
  if (name === null) return;
  try {
    const r = await api("POST", "/api/saved", { name, params: result.params, from_job: state.jobId });
    location.hash = "#/saved/" + r.id;
  } catch (e) { alert("Could not save: " + e.message); }
}

/* ---------- saved searches ---------- */
function paramsSummary(p) {
  const bits = [];
  const gt = { electric: "electric", acoustic: "acoustic", bass: "bass", any: "any guitar" }[p.guitar_type];
  bits.push(gt);
  if ((p.conditions || []).length) bits.push(p.conditions.join("/"));
  if (p.price_min || p.price_max) bits.push(`${p.price_min ? money(p.price_min) : "any"}–${p.price_max ? money(p.price_max) : "any"}`);
  if (p.year_min || p.year_max) bits.push(`${p.year_min || "…"}–${p.year_max || "…"}`);
  if (p.region && p.region !== state.config.defaults.region) bits.push("ship to " + p.region);
  bits.push(`scan ${p.scan_limit}`);
  return bits.join(" · ");
}

function sparkline(values, w = 120, h = 32) {
  const vals = values.filter(v => v !== null && v !== undefined);
  if (vals.length < 2) return `<span class="tiny">${vals.length ? "1 check so far" : ""}</span>`;
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const pts = vals.map((v, i) => [2 + (i / (vals.length - 1)) * (w - 6), 3 + (1 - (v - min) / span) * (h - 6)]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join("");
  const last = pts[pts.length - 1];
  const delta = vals[vals.length - 1] - vals[0];
  const label = `Median ${delta < 0 ? "down" : delta > 0 ? "up" : "flat"} ${money(Math.abs(delta))} over ${vals.length} checks`;
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>
    <path d="${d}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="3" fill="var(--series-1)" stroke="var(--surface)" stroke-width="2"/></svg>`;
}

async function renderSavedList() {
  app.innerHTML = `<div class="toolbar"><h1 style="margin:0">Saved searches</h1><span class="grow"></span>
    <button class="btn" id="check-all">Check all now</button></div><div id="job"></div><div id="saved-list"><div class="muted">Loading…</div></div>`;
  $("#check-all").addEventListener("click", async () => {
    const { job_id } = await api("POST", "/api/saved/check-all");
    state.job = { id: job_id, message: "Starting…", progress: 0 }; showJob();
    try { await pollJob(job_id, j => { state.job = { message: j.message, progress: j.progress }; showJob(); }); }
    catch (e) { alert(e.message); }
    state.job = null; renderSavedList();
  });
  const data = await api("GET", "/api/saved");
  updateSavedBadge(data.searches);
  const list = $("#saved-list");
  if (!data.searches.length) {
    list.innerHTML = `<div class="panel empty">No saved searches yet. Run a search, then click <b>Save search</b>.</div>`;
    return;
  }
  const interval = data.check_interval_hours;
  list.innerHTML = `<div class="tiny" style="margin-bottom:10px">${interval > 0 ? `Searches with auto-check on are re-checked every ${interval} hours while the app is running.` : "Auto-check is turned off (RT_CHECK_INTERVAL_HOURS=0)."}</div>
    <div class="saved-grid">${data.searches.map(savedCardHtml).join("")}</div>`;
  $$("[data-act]", list).forEach(b => b.addEventListener("click", () => savedAction(b.dataset.act, +b.dataset.id, b)));
}

function savedCardHtml(s) {
  const sum = s.summary || {};
  const labels = sum.labels || {};
  const models = (s.main_models || []).map(m => `<div class="trend"><div><div>${esc(m.group_name)}</div>
      <div class="tiny">${SEG_LABEL[m.segment]} · median <b>${money(m.median)}</b> · ${m.count} listed</div></div>${sparkline(m.spark)}</div>`).join("");
  const changes = [];
  if (s.new_since_view) changes.push(`<span class="badge new">${s.new_since_view} new</span>`);
  if (s.drops_since_view) changes.push(`<span class="badge drop">${plural(s.drops_since_view, "price drop")}</span>`);
  if (s.gone_since_view) changes.push(`<span class="badge outline">${s.gone_since_view} sold/removed</span>`);
  return `<div class="scard">
    <div><h3><a href="#/saved/${s.id}">${esc(s.name)}</a></h3>
      <div class="tiny">"${esc(s.params.query)}" · ${esc(paramsSummary(s.params))}</div></div>
    <div class="tiny">${s.checking ? "Checking now…" : `Last checked ${relTime(s.last_checked_at)}`}${s.checks ? ` · ${plural(s.checks, "check")}` : ""}
      ${s.last_error ? `<div class="error small">Last check failed: ${esc(s.last_error)}</div>` : ""}</div>
    <div class="stats">
      <div class="stat"><div class="v">${sum.kept ?? "–"}</div><div class="k">listings</div></div>
      <div class="stat"><div class="v">${labels["Great deal"] || 0}</div><div class="k">great deals</div></div>
      <div class="stat"><div class="v">${labels["Good deal"] || 0}</div><div class="k">good deals</div></div>
    </div>
    ${models}
    <div class="badges">${changes.length ? changes.join("") + `<span class="tiny">since you last looked</span>` : `<span class="tiny">Nothing new since you last looked</span>`}</div>
    <div class="actions">
      <a class="btn small primary" href="#/saved/${s.id}">Open</a>
      <button class="btn small" data-act="check" data-id="${s.id}">Check now</button>
      <a class="btn small" href="#/saved/${s.id}/history">History</a>
      <button class="btn small" data-act="auto" data-id="${s.id}" data-on="${s.auto_check ? 1 : 0}">Auto-check: ${s.auto_check ? "on" : "off"}</button>
      <button class="btn small" data-act="rename" data-id="${s.id}">Rename</button>
      <button class="btn small danger" data-act="delete" data-id="${s.id}">Delete</button>
    </div></div>`;
}

async function savedAction(act, id, btn) {
  try {
    if (act === "check") {
      btn.disabled = true; btn.textContent = "Checking…";
      const { job_id } = await api("POST", `/api/saved/${id}/check`);
      await pollJob(job_id, j => { btn.textContent = Math.round((j.progress || 0) * 100) + "%"; });
    } else if (act === "auto") {
      await api("PATCH", `/api/saved/${id}`, { auto_check: btn.dataset.on !== "1" });
    } else if (act === "rename") {
      const name = prompt("New name:", btn.closest(".scard, .panel").querySelector("h3, h1").textContent.trim());
      if (!name) return;
      await api("PATCH", `/api/saved/${id}`, { name });
    } else if (act === "delete") {
      if (!confirm("Delete this saved search and its history?")) return;
      await api("DELETE", `/api/saved/${id}`);
      if (location.hash !== "#/saved") { location.hash = "#/saved"; return; }
    }
  } catch (e) { alert(e.message); }
  route();
}

function updateSavedBadge(searches) {
  const n = searches.reduce((a, s) => a + (s.new_since_view || 0), 0);
  $("#saved-badge").innerHTML = n ? `<span class="pill-count" title="New listings since you last looked">${n}</span>` : "";
}

async function renderSaved(id) {
  app.innerHTML = `<div class="muted">Loading…</div>`;
  let data;
  try { data = await api("GET", `/api/saved/${id}`); }
  catch (e) { app.innerHTML = `<div class="error">${esc(e.message)}</div>`; return; }
  const s = data.search;
  state.view = state.savedViewFor === id ? state.view : freshView();
  state.savedViewFor = id;
  const changes = [];
  if (s.new_since_view) changes.push(`<button class="chip" id="show-new"><span class="badge new">${s.new_since_view} new</span></button>`);
  if (s.drops_since_view) changes.push(`<span class="badge drop">${plural(s.drops_since_view, "price drop")}</span>`);
  if (s.gone_since_view) changes.push(`<a class="badge outline" href="#/saved/${id}/history">${s.gone_since_view} sold/removed</a>`);
  app.innerHTML = `
    <div class="panel">
      <div class="toolbar" style="margin:0">
        <div><h1 style="margin:0">${esc(s.name)}</h1>
          <div class="tiny">"${esc(s.params.query)}" · ${esc(paramsSummary(s.params))} · last checked ${relTime(s.last_checked_at)}</div></div>
        <span class="grow"></span>
        <button class="btn small primary" data-act="check" data-id="${id}">Check now</button>
        <a class="btn small" href="#/saved/${id}/history">History &amp; trends</a>
        <button class="btn small" data-act="rename" data-id="${id}">Rename</button>
        <button class="btn small danger" data-act="delete" data-id="${id}">Delete</button>
      </div>
      ${changes.length ? `<div class="badges" style="margin-top:10px">${changes.join("")} <span class="tiny">since you last looked</span></div>` : ""}
      ${s.last_error ? `<div class="error small" style="margin-top:8px">Last check failed: ${esc(s.last_error)}</div>` : ""}
    </div>
    <div id="results"></div>`;
  $$("[data-act]", app).forEach(b => b.addEventListener("click", () => savedAction(b.dataset.act, id, b)));
  const res = $("#results");
  if (data.result) {
    renderResults(res, data.result, { saved: s });
    const sn = $("#show-new");
    if (sn) sn.addEventListener("click", () => { state.view.newOnly = true; renderResults(res, data.result, { saved: s }); });
  } else {
    res.innerHTML = `<div class="panel empty">No results stored yet. ${s.checking ? "A check is running…" : "Click <b>Check now</b>."}</div>`;
  }
  api("POST", `/api/saved/${id}/viewed`).then(() => api("GET", "/api/saved")).then(d => updateSavedBadge(d.searches)).catch(() => {});
}

/* ---------- history ---------- */
async function renderHistory(id) {
  app.innerHTML = `<div class="muted">Loading…</div>`;
  const [card, h] = await Promise.all([api("GET", `/api/saved/${id}`), api("GET", `/api/saved/${id}/history`)]);
  const s = card.search;
  const segs = ["used", "new", "b-stock"].filter(seg => h.series.some(x => x.segment === seg));
  state.histSeg = segs.includes(state.histSeg) ? state.histSeg : segs[0];
  const draw = () => {
    const series = h.series.filter(x => x.segment === state.histSeg).slice(0, 6);
    $("#seg-tabs").innerHTML = segs.map(seg => `<button class="chip ${seg === state.histSeg ? "on" : ""}" data-seg="${seg}">${SEG_LABEL[seg]}</button>`).join("");
    $$("[data-seg]").forEach(b => b.addEventListener("click", () => { state.histSeg = b.dataset.seg; draw(); }));
    lineChart($("#chart"), series.map((x, i) => ({ name: x.group_name, color: `var(--series-${i + 1})`, points: x.points.map(p => ({ t: p.t, v: p.median, n: p.count })) })));
    $("#chart-table").innerHTML = seriesTable(series);
  };
  const ev = h.events.filter(e => e.kind !== "price_up" || true);
  const evLabel = { new: ["NEW", "new"], price_drop: ["Price drop", "drop"], price_up: ["Price up", "outline"], gone: ["Gone", "outline"], back: ["Back", "outline"] };
  const goneLabel = { sold: "Sold", ended: "Ended", removed: "Removed", missing: "No longer in results" };
  app.innerHTML = `
    <div class="panel"><div class="toolbar" style="margin:0"><div><h1 style="margin:0">${esc(s.name)}: history</h1>
      <div class="tiny">${plural(h.checks.length, "check")} since ${h.checks.length ? dateStr(h.checks[0].checked_at) : "–"}</div></div>
      <span class="grow"></span><a class="btn small" href="#/saved/${id}">Back to results</a></div></div>
    <section class="panel">
      <h2>Median asking price over time</h2>
      <div class="tabs" id="seg-tabs"></div>
      ${h.checks.length < 2 ? `<div class="note">Only one check so far. The chart fills in as the search is re-checked (automatically every ${state.config.check_interval_hours} hours, or with “Check now”).</div>` : ""}
      <div id="chart" class="chart"></div>
      <details><summary class="small muted">Show as table</summary><div id="chart-table" class="table-wrap"></div></details>
    </section>
    <section class="panel">
      <h2>Listings that came and went</h2>
      ${ev.length ? `<ul class="events">${ev.map(e => {
        const [lab, cls] = evLabel[e.kind] || [e.kind, "outline"];
        const price = e.kind === "price_drop" || e.kind === "price_up" ? `${money(e.old_total)} → <b>${money(e.new_total)}</b>`
          : e.kind === "gone" ? `${money(e.old_total)} · ${goneLabel[e.status] || "gone"}` : money(e.new_total);
        return `<li>${e.photo ? `<img src="${esc(e.photo)}" loading="lazy" alt="">` : `<span class="noimg"></span>`}
          <div style="flex:1;min-width:0"><span class="badge ${cls}">${lab}</span> <a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title || e.listing_id)}</a>
          <div class="tiny">${price} · ${esc(e.group_name || "")}</div></div><span class="when">${dateStr(e.at)}</span></li>`;
      }).join("")}</ul>` : `<div class="muted small">No changes yet. New listings, price changes and sold or removed listings appear here after the next check.</div>`}
    </section>
    <section class="panel"><h2>Checks</h2><div class="table-wrap"><table class="models"><thead><tr><th>When</th><th class="num">Scanned</th><th class="num">Guitars</th><th class="num">Deals</th><th class="num">New</th><th class="num">Price drops</th><th class="num">Gone</th></tr></thead>
      <tbody>${h.checks.slice().reverse().map(c => `<tr><td>${dateStr(c.checked_at)}${c.baseline ? ' <span class="tiny">(first)</span>' : ""}</td><td class="num">${c.summary.scanned}</td><td class="num">${c.summary.kept}</td><td class="num">${c.summary.deals}</td><td class="num">${c.new_count}</td><td class="num">${c.drop_count}</td><td class="num">${c.gone_count}</td></tr>`).join("")}</tbody></table></div></section>`;
  if (segs.length) draw(); else $("#chart").innerHTML = `<div class="muted small">No data yet.</div>`;
}

function seriesTable(series) {
  const ts = [...new Set(series.flatMap(s => s.points.map(p => p.t)))].sort();
  return `<table class="models"><thead><tr><th>Check</th>${series.map(s => `<th class="num">${esc(s.group_name)}</th>`).join("")}</tr></thead><tbody>
    ${ts.map(t => `<tr><td>${dateStr(t)}</td>${series.map(s => { const p = s.points.find(p => p.t === t); return `<td class="num">${p ? money(p.median) + ` <span class="tiny">(${p.count})</span>` : "–"}</td>`; }).join("")}</tr>`).join("")}</tbody></table>`;
}

/* Multi-series line chart with a crosshair tooltip. series: [{name, color, points:[{t, v, n}]}] */
function lineChart(el, series) {
  if (!series.length) { el.innerHTML = `<div class="muted small">No data for this market.</div>`; return; }
  const hidden = new Set(el._hidden || []);
  const W = 860, H = 300, m = { l: 64, r: 16, t: 12, b: 28 };
  const vis = series.filter(s => !hidden.has(s.name));
  const all = vis.flatMap(s => s.points);
  const ts = [...new Set(series.flatMap(s => s.points.map(p => p.t)))].sort((a, b) => a - b);
  const tmin = ts[0], tmax = ts[ts.length - 1] === tmin ? tmin + 3600 : ts[ts.length - 1];
  const vals = all.map(p => p.v).filter(v => v != null);
  let vmin = vals.length ? Math.min(...vals) : 0, vmax = vals.length ? Math.max(...vals) : 1;
  const pad = Math.max((vmax - vmin) * 0.1, vmax * 0.03, 5); vmin = Math.max(0, vmin - pad); vmax += pad;
  const x = t => m.l + (ts.length === 1 ? (W - m.l - m.r) / 2 : (t - tmin) / (tmax - tmin) * (W - m.l - m.r));
  const y = v => m.t + (1 - (v - vmin) / (vmax - vmin)) * (H - m.t - m.b);
  const ticks = 4, grid = [];
  for (let i = 0; i <= ticks; i++) { const v = vmin + (vmax - vmin) * i / ticks; grid.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`); }
  const ylabels = Array.from({ length: ticks + 1 }, (_, i) => { const v = vmin + (vmax - vmin) * i / ticks; return `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${esc(money(v))}</text>`; }).join("");
  const xt = ts.length <= 6 ? ts : [ts[0], ts[Math.floor(ts.length / 3)], ts[Math.floor(2 * ts.length / 3)], ts[ts.length - 1]];
  const xlabels = xt.map(t => `<text x="${x(t)}" y="${H - 8}" text-anchor="middle">${esc(new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }))}</text>`).join("");
  const lines = vis.map(s => {
    const pts = s.points.filter(p => p.v != null);
    const d = pts.map((p, i) => (i ? "L" : "M") + x(p.t).toFixed(1) + "," + y(p.v).toFixed(1)).join("");
    const dots = pts.length <= 40 ? pts.map(p => `<circle cx="${x(p.t)}" cy="${y(p.v)}" r="3.5" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`).join("") : "";
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
  }).join("");
  el.innerHTML = `
    <div class="legend">${series.map(s => `<span class="key ${hidden.has(s.name) ? "off" : ""}" data-name="${esc(s.name)}"><span class="sw" style="background:${s.color}"></span>${esc(s.name)}</span>`).join("")}</div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Median asking price over time per model">
      <g class="grid">${grid.join("")}</g><g class="axis">${ylabels}${xlabels}</g>
      ${lines}
      <line class="xhair" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" stroke="var(--text-3)" stroke-width="1" stroke-dasharray="3 3" style="display:none"/>
      <rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent" class="hit"/>
    </svg><div class="tip"></div>`;
  $$(".legend .key", el).forEach(k => k.addEventListener("click", () => {
    const n = k.dataset.name; hidden.has(n) ? hidden.delete(n) : hidden.add(n); el._hidden = [...hidden]; lineChart(el, series);
  }));
  const svg = $("svg", el), tip = $(".tip", el), xh = $(".xhair", el);
  const move = ev => {
    const r = svg.getBoundingClientRect();
    const px = (ev.clientX - r.left) / r.width * W;
    let best = ts[0];
    ts.forEach(t => { if (Math.abs(x(t) - px) < Math.abs(x(best) - px)) best = t; });
    xh.setAttribute("x1", x(best)); xh.setAttribute("x2", x(best)); xh.style.display = "";
    const rows = vis.map(s => { const p = s.points.find(p => p.t === best); return p ? `<div class="row"><span><span class="sw" style="display:inline-block;width:10px;height:3px;background:${s.color};margin-right:5px;vertical-align:middle"></span>${esc(s.name)}</span><b>${money(p.v)}</b></div>` : ""; }).join("");
    tip.innerHTML = `<div class="tiny" style="margin-bottom:4px">${dateStr(best)}</div>${rows || "–"}`;
    tip.style.display = "block";
    const left = x(best) / W * r.width;
    tip.style.left = Math.min(Math.max(0, left + 12), r.width - tip.offsetWidth) + "px";
    tip.style.top = "30px";
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerleave", () => { tip.style.display = "none"; xh.style.display = "none"; });
}

/* ---------- boot ---------- */
(async function boot() {
  try {
    state.config = await api("GET", "/api/config");
  } catch (e) {
    app.innerHTML = `<div class="error">Could not reach the app server: ${esc(e.message)}</div>`;
    return;
  }
  route();
  api("GET", "/api/saved").then(d => updateSavedBadge(d.searches)).catch(() => {});
})();
