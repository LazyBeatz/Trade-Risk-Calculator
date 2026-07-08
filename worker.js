// Cloudflare Worker — serves the static app AND the /api/quote endpoint.
//
// How it works:
//   • Requests to /api/quote?symbol=...  -> handled here (market router below)
//   • Everything else (/, /index.html…)  -> served from the ./public folder
//     via the [assets] binding in wrangler.toml (env.ASSETS).
//
// QUOTE SOURCES (in order):
//   1) Yahoo Finance v8 chart endpoint  — no key, no hard rate limit, rich data
//      (price, name, change, day range, 52-week range, volume). US + Canadian.
//   2) Finnhub (US) / Alpha Vantage (CA) — keyed fallbacks if Yahoo fails or is
//      blocked. These use your existing secrets and stay as a safety net.
//
// Secrets (dashboard → your Worker → Settings → Variables and Secrets, ENCRYPTED):
//   FINNHUB_KEY        = your free Finnhub API key      (fallback only)
//   ALPHAVANTAGE_KEY   = your free Alpha Vantage API key (fallback only)
// Yahoo needs NO key.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/quote") return handleQuote(url, env);
    if (url.pathname === "/api/options") return handleOptions(url);
    if (url.pathname === "/api/history") return handleHistory(url);
    return env.ASSETS.fetch(request);
  },
};

async function handleQuote(url, env) {
  const raw = (url.searchParams.get("symbol") || "").trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
    return json({ error: "Invalid or missing symbol." }, 400);
  }
  const isCanadian = /\.(TO|TRT|V|VN|NE|CN)$/.test(raw);

  // 1) Primary: Yahoo (no key, rich data). If it throws or returns nothing, fall through.
  try {
    const y = await fromYahoo(raw);
    if (y) {
      if (url.searchParams.get("extra") === "1") {
        try { y.marketCap = await yahooMarketCap(raw); } catch (e) { y.marketCap = null; }
      }
      return json(y, 200, 30);
    }
  } catch (e) { /* fall through to keyed providers */ }

  // 2) Fallback: keyed providers (US -> Finnhub, CA -> Alpha Vantage)
  try {
    const quote = isCanadian
      ? await fromAlphaVantage(raw, env.ALPHAVANTAGE_KEY)
      : await fromFinnhub(raw, env.FINNHUB_KEY);
    if (!quote) return json({ error: "No quote found for " + raw + "." }, 404);
    return json(quote, 200, 30);
  } catch (e) {
    const status = e && e.status ? e.status : 502;
    return json({ error: e && e.message ? e.message : "Upstream error." }, status);
  }
}

// ---- Yahoo Finance v8 chart (primary; no key) ------------------------------
async function fromYahoo(symbol) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  const r = await fetch(u, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Accept": "application/json" },
    cf: { cacheTtl: 30 },
  });
  if (r.status === 429) throw withStatus(new Error("Yahoo rate limit."), 429);
  if (!r.ok) throw withStatus(new Error("Yahoo error " + r.status + "."), 502);
  const d = await r.json();
  const res = d && d.chart && d.chart.result && d.chart.result[0];
  const m = res && res.meta;
  if (!m || typeof m.regularMarketPrice !== "number" || m.regularMarketPrice <= 0) return null;

  const price = m.regularMarketPrice;
  const prev = (typeof m.chartPreviousClose === "number") ? m.chartPreviousClose
             : (typeof m.previousClose === "number") ? m.previousClose : null;
  const change    = (prev != null) ? round2(price - prev) : null;
  const changePct = (prev != null && prev !== 0) ? round2((price - prev) / prev * 100) : null;

  return {
    symbol,
    price: round2(price),
    change,
    changePct,
    prevClose: prev != null ? round2(prev) : null,
    high:   typeof m.regularMarketDayHigh === "number" ? round2(m.regularMarketDayHigh) : null,
    low:    typeof m.regularMarketDayLow  === "number" ? round2(m.regularMarketDayLow)  : null,
    wkHigh: typeof m.fiftyTwoWeekHigh === "number" ? round2(m.fiftyTwoWeekHigh) : null,
    wkLow:  typeof m.fiftyTwoWeekLow  === "number" ? round2(m.fiftyTwoWeekLow)  : null,
    volume: typeof m.regularMarketVolume === "number" ? m.regularMarketVolume : null,
    name:   m.longName || m.shortName || null,
    currency: m.currency || null,
    delayed: true,
    asOf: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : null,
    source: "Yahoo",
  };
}

// ---- Finnhub (US fallback) --------------------------------------------------
async function fromFinnhub(symbol, key) {
  if (!key) throw withStatus(new Error("Finnhub key not configured."), 500);
  const u = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`;
  const r = await fetch(u, { cf: { cacheTtl: 30 } });
  if (r.status === 429) throw withStatus(new Error("Rate limit."), 429);
  if (!r.ok) throw withStatus(new Error("Finnhub error."), 502);
  const d = await r.json();
  const price = d && typeof d.c === "number" ? d.c : null;
  if (!price || price <= 0) return null;
  const prev = typeof d.pc === "number" ? d.pc : null;
  return {
    symbol,
    price: round2(price),
    change: prev != null ? round2(price - prev) : null,
    changePct: (prev != null && prev !== 0) ? round2((price - prev) / prev * 100) : null,
    prevClose: prev != null ? round2(prev) : null,
    high: typeof d.h === "number" ? round2(d.h) : null,
    low:  typeof d.l === "number" ? round2(d.l) : null,
    delayed: true,
    asOf: d.t ? new Date(d.t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : null,
    source: "Finnhub",
  };
}

// ---- Alpha Vantage (Canadian fallback) -------------------------------------
async function fromAlphaVantage(symbol, key) {
  if (!key) throw withStatus(new Error("Alpha Vantage key not configured."), 500);
  const u = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${key}`;
  const r = await fetch(u, { cf: { cacheTtl: 30 } });
  if (!r.ok) throw withStatus(new Error("Alpha Vantage error."), 502);
  const d = await r.json();
  if (d && (d.Note || d.Information)) throw withStatus(new Error("Rate limit."), 429);
  const q = d && d["Global Quote"];
  const price = q && q["05. price"] ? parseFloat(q["05. price"]) : null;
  if (!price || price <= 0) return null;
  const prev = q["08. previous close"] ? parseFloat(q["08. previous close"]) : null;
  return {
    symbol,
    price: round2(price),
    change: prev != null ? round2(price - prev) : null,
    changePct: (prev != null && prev !== 0) ? round2((price - prev) / prev * 100) : null,
    prevClose: prev != null ? round2(prev) : null,
    delayed: true,
    asOf: q["07. latest trading day"] || null,
    source: "Alpha Vantage",
  };
}

// ---- helpers ----------------------------------------------------------------
function round2(n) { return Math.round(n * 100) / 100; }
function withStatus(err, status) { err.status = status; return err; }
function json(obj, status = 200, cacheSeconds = 0) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (cacheSeconds > 0) headers["cache-control"] = `public, max-age=${cacheSeconds}`;
  return new Response(JSON.stringify(obj), { status, headers });
}

// ============================================================================
// /api/options — SPY-put auto-pick (hedge) & first-OTM auto-fill (options sizer)
// Uses Yahoo's options chain via the crumb handshake. Fragile by nature; the
// app keeps manual entry as a fallback if this ever returns an error.
//
//   GET /api/options?symbol=SPY&type=put&mode=hedge&floor=707.56&minDays=180
//   GET /api/options?symbol=AAPL&type=call&mode=firstotm&minDays=180
// ============================================================================
const YUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

async function handleOptions(url) {
  const raw  = (url.searchParams.get("symbol") || "").trim().toUpperCase();
  const type = (url.searchParams.get("type") || "call").trim().toLowerCase();
  const mode = (url.searchParams.get("mode") || "firstotm").trim().toLowerCase();
  const floor = parseFloat(url.searchParams.get("floor") || "0");
  const minDays = parseInt(url.searchParams.get("minDays") || "180", 10) || 180;

  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) return json({ error: "Invalid or missing symbol." }, 400);
  if (type !== "call" && type !== "put") return json({ error: "type must be call or put." }, 400);

  // 1) Primary: Yahoo (crumb handshake, rich chain)
  try { const y = await yahooOptionsPick(raw, type, mode, floor, minDays); if (y) return json(y, 200, 60); } catch (e) { /* fall through */ }
  // 2) Fallback: CBOE (15-min delayed, no crumb, provides delta directly)
  try { const c = await cboeOptionsPick(raw, type, mode, floor, minDays); if (c) return json(c, 200, 60); } catch (e) { /* fall through */ }

  return json({ error: "Couldn't find an option from Yahoo or CBOE — enter manually." }, 404);
}

// shared contract selection (identical logic for both sources)
function pickContract(list, type, mode, under, floor) {
  if (mode === "hedge" && type === "put") {
    const fl = floor > 0 ? floor : under * 0.95;
    const liquid = list.filter(p => p.ask > 0 && p.iv > 0 && p.oi >= 10 && (p.strike - p.ask) > fl);
    liquid.sort((a, b) => (a.strike - a.ask) - (b.strike - b.ask)); // breakeven closest to floor
    return liquid[0] || null;
  }
  if (type === "call") return list.filter(c => c.strike > under && c.ask >= 0).sort((a, b) => a.strike - b.strike)[0] || null;
  return list.filter(p => p.strike < under && p.ask >= 0).sort((a, b) => b.strike - a.strike)[0] || null;
}

// shared response builder
function buildOptionResult(raw, type, mode, under, targetExpSec, pick, source) {
  const premium = pick.ask > 0 ? pick.ask : pick.last;
  const breakeven = type === "put" ? (pick.strike - premium) : (pick.strike + premium);
  const now = Date.now() / 1000;
  return {
    symbol: raw, type, mode,
    underlying: round2(under),
    expiry: new Date(targetExpSec * 1000).toISOString().slice(0, 10),
    daysOut: Math.round((targetExpSec - now) / 86400),
    strike: pick.strike,
    ask: pick.ask > 0 ? round2(pick.ask) : null,
    last: pick.last != null ? round2(pick.last) : null,
    price: premium != null ? round2(premium) : null,
    impliedVolatility: pick.iv,
    openInterest: pick.oi,
    delta: (typeof pick.delta === "number") ? pick.delta : null,   // CBOE supplies delta; Yahoo doesn't
    breakeven: round2(breakeven),
    source,
  };
}

// ---- Yahoo options pick ----
async function yahooOptionsPick(raw, type, mode, floor, minDays) {
  const sess = await yahooSession();
  const first = await yahooOptions(raw, sess, null);
  if (!first) return null;
  const under = first.underlying;
  const now = Date.now() / 1000;
  const exps = (first.expirationDates || []).filter(e => (e - now) / 86400 >= minDays).sort((a, b) => a - b);
  if (!exps.length) return null;
  const targetExp = exps[0];
  const chain = await yahooOptions(raw, sess, targetExp);
  if (!chain) return null;
  const list = type === "put" ? chain.puts : chain.calls;
  if (!list || !list.length) return null;
  const pick = pickContract(list, type, mode, under, floor);
  if (!pick) return null;
  return buildOptionResult(raw, type, mode, under, targetExp, pick, "Yahoo");
}

// ---- CBOE options pick (free, 15-min delayed, no crumb) ----
async function cboeOptionsPick(raw, type, mode, floor, minDays) {
  // ETFs/equities use PLAIN symbol; indices (SPX, VIX, NDX…) use an underscore prefix
  const urls = [
    `https://cdn.cboe.com/api/global/delayed_quotes/options/${raw}.json`,
    `https://cdn.cboe.com/api/global/delayed_quotes/options/_${raw}.json`,
  ];
  let d = null;
  for (const u of urls) {
    const r = await fetch(u, { headers: { "User-Agent": YUA, "Accept": "application/json" }, cf: { cacheTtl: 60 } });
    if (r.ok) { const j = await r.json(); if (j && j.data && Array.isArray(j.data.options) && j.data.options.length) { d = j; break; } }
  }
  if (!d) return null;
  const under = d.data.current_price || d.data.close || d.data.last || 0;
  if (!under || under <= 0) return null;
  const now = Date.now() / 1000;
  // OCC symbol tail = YYMMDD + C/P + 8-digit strike (strike × 1000); last 15 chars, root-length-agnostic
  const parsed = d.data.options.map(o => {
    const occ = o.option || o.symbol || "";
    const tail = String(occ).slice(-15);
    if (tail.length < 15) return null;
    const expSec = Date.parse("20" + tail.slice(0, 2) + "-" + tail.slice(2, 4) + "-" + tail.slice(4, 6) + "T00:00:00Z") / 1000;
    return {
      type: tail.slice(6, 7) === "C" ? "call" : "put",
      strike: parseInt(tail.slice(7), 10) / 1000,
      exp: expSec,
      days: (expSec - now) / 86400,
      ask: typeof o.ask === "number" ? o.ask : 0,
      last: typeof o.last_trade_price === "number" ? o.last_trade_price : (typeof o.last === "number" ? o.last : null),
      iv: typeof o.iv === "number" ? o.iv : 0,
      delta: typeof o.delta === "number" ? o.delta : undefined,
      oi: typeof o.open_interest === "number" ? o.open_interest : 0,
    };
  }).filter(c => c && c.type === type && isFinite(c.exp) && c.days >= minDays);
  if (!parsed.length) return null;
  const targetExp = parsed.map(c => c.exp).sort((a, b) => a - b)[0];
  const atExp = parsed.filter(c => c.exp === targetExp);
  const pick = pickContract(atExp, type, mode, under, floor);
  if (!pick) return null;
  return buildOptionResult(raw, type, mode, under, targetExp, pick, "CBOE (15-min delayed)");
}

// get a Yahoo session (consent cookie + crumb)
async function yahooSession() {
  const r = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": YUA } });
  let cookies = "";
  if (typeof r.headers.getSetCookie === "function") {
    cookies = r.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  } else {
    const sc = r.headers.get("set-cookie") || "";
    cookies = sc.split(/,(?=[^;]+=[^;]+)/).map(c => c.split(";")[0]).join("; ");
  }
  const cr = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": YUA, "Cookie": cookies } });
  if (!cr.ok) throw withStatus(new Error("Yahoo auth failed."), 502);
  const crumb = (await cr.text()).trim();
  if (!crumb || crumb.length > 40) throw withStatus(new Error("No crumb."), 502);
  return { cookies, crumb };
}

// fetch an options chain (date optional). Returns normalized contracts.
async function yahooOptions(symbol, sess, date) {
  let u = `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}?crumb=${encodeURIComponent(sess.crumb)}`;
  if (date) u += `&date=${date}`;
  const r = await fetch(u, { headers: { "User-Agent": YUA, "Cookie": sess.cookies }, cf: { cacheTtl: 60 } });
  if (r.status === 429) throw withStatus(new Error("Yahoo rate limit."), 429);
  if (!r.ok) throw withStatus(new Error("Yahoo options error " + r.status + "."), 502);
  const d = await r.json();
  const res = d && d.optionChain && d.optionChain.result && d.optionChain.result[0];
  if (!res) return null;
  const q = res.quote || {};
  const opt = (res.options && res.options[0]) || {};
  const norm = arr => (arr || []).map(o => ({
    strike: o.strike,
    ask: typeof o.ask === "number" ? o.ask : 0,
    last: typeof o.lastPrice === "number" ? o.lastPrice : null,
    iv: typeof o.impliedVolatility === "number" ? o.impliedVolatility : 0,
    oi: typeof o.openInterest === "number" ? o.openInterest : 0,
  }));
  return {
    underlying: q.regularMarketPrice,
    expirationDates: res.expirationDates || [],
    puts: norm(opt.puts),
    calls: norm(opt.calls),
  };
}

// ============================================================================
// /api/history — daily OHLC series for the Portfolio Mirror's indicators
//   GET /api/history?symbol=AAPL&range=6mo
//   -> { symbol, name, price, closes[], highs[], lows[] }  (Yahoo, no key)
// ============================================================================
async function handleHistory(url) {
  const raw = (url.searchParams.get("symbol") || "").trim().toUpperCase();
  const range = (url.searchParams.get("range") || "6mo").trim();
  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) return json({ error: "Invalid or missing symbol." }, 400);
  if (!/^(3mo|6mo|1y|2y)$/.test(range)) return json({ error: "Bad range." }, 400);

  try {
    const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(raw)}?interval=1d&range=${range}`;
    const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Accept": "application/json" }, cf: { cacheTtl: 300 } });
    if (r.status === 429) return json({ error: "Rate limit." }, 429);
    if (!r.ok) return json({ error: "History unavailable." }, 502);
    const d = await r.json();
    const res = d && d.chart && d.chart.result && d.chart.result[0];
    const q = res && res.indicators && res.indicators.quote && res.indicators.quote[0];
    const m = res && res.meta;
    if (!res || !q || !m) return json({ error: "No history for " + raw + "." }, 404);

    // strip nulls, keeping the three series index-aligned
    const closes = [], highs = [], lows = [];
    const C = q.close || [], H = q.high || [], L = q.low || [];
    for (let i = 0; i < C.length; i++) {
      if (C[i] == null || H[i] == null || L[i] == null) continue;
      closes.push(round2(C[i])); highs.push(round2(H[i])); lows.push(round2(L[i]));
    }
    if (closes.length < 60) return json({ error: "Not enough history for " + raw + "." }, 404);

    return json({
      symbol: raw,
      name: m.longName || m.shortName || null,
      price: round2(m.regularMarketPrice),
      currency: m.currency || null,
      closes, highs, lows,
      delayed: true,
      source: "Yahoo",
    }, 200, 120);
  } catch (e) {
    return json({ error: "History upstream error." }, 502);
  }
}

// market cap via quoteSummary (crumb handshake — best-effort, returns null on any failure)
async function yahooMarketCap(symbol) {
  const sess = await yahooSession();
  const u = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=price&crumb=${encodeURIComponent(sess.crumb)}`;
  const r = await fetch(u, { headers: { "User-Agent": YUA, "Cookie": sess.cookies }, cf: { cacheTtl: 300 } });
  if (!r.ok) return null;
  const d = await r.json();
  const p = d && d.quoteSummary && d.quoteSummary.result && d.quoteSummary.result[0] && d.quoteSummary.result[0].price;
  const mc = p && p.marketCap;
  return (mc && (mc.fmt || mc.raw != null)) ? { raw: mc.raw != null ? mc.raw : null, fmt: mc.fmt || null } : null;
}
