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
    // ── VIBE FENCE (Q1 blast-radius law): all /api/vibe/* traffic is dispatched
    //    here, wrapped so a Vibe bug can ONLY fail into its own JSON 500 and can
    //    never take down /api/quote, /api/options, or /api/history below. ──
    if (url.pathname.startsWith("/api/vibe/")) {
      try { return await handleVibe(request, env, url); }
      catch (e) {
        console.error("vibe fence caught:", (e && e.stack) || e);   // internals → worker logs only
        return json({ error: "vibe hiccup" }, 500);                 // public surface stays generic
      }
    }
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

/* ═══════════════════════════════════════════════════════════════════════════
   VIBE MODULE — Portfolio Vibe backend (Phase A)
   Stage 1: bootstrap only — fence, health ping, and the VibeRoom Durable
   Object scaffold the wrangler.toml migration points at. Chat loop arrives
   stage 3. Zero shared functions with calculator endpoints (uses only the
   generic json() helper). All routes live under /api/vibe/*.
   ═══════════════════════════════════════════════════════════════════════════ */

async function handleVibe(request, env, url) {
  const path = url.pathname;

  // GET /api/vibe/ping — stage-1 acceptance test, callable from any browser.
  //   ?boom=1 deliberately throws so the blast-radius fence can be verified
  //   LIVE: expect a vibe-scoped 500 here while /api/quote keeps serving.
  if (path === "/api/vibe/ping") {
    if (url.searchParams.get("boom") === "1") {
      throw new Error("deliberate test throw — fence check");
    }

    // D1 binding check (real round-trip, not just presence)
    let d1 = "missing binding — add [[d1_databases]] to wrangler.toml";
    try {
      if (env.VIBE_DB) {
        const row = await env.VIBE_DB.prepare("SELECT 1 AS ok").first();
        d1 = row && row.ok === 1 ? "ok" : "unexpected result";
      }
    } catch (e) {
      console.error("vibe ping D1 check:", (e && e.message) || e);
      d1 = "error — check worker logs";
    }

    // Durable Object binding check (real stub round-trip into VibeRoom)
    let durable = "missing binding — add [[durable_objects.bindings]] to wrangler.toml";
    try {
      if (env.VIBE_ROOM) {
        const stub = env.VIBE_ROOM.get(env.VIBE_ROOM.idFromName("ping"));
        const r = await stub.fetch("https://vibe-room/ping");
        const j = await r.json();
        durable = j && j.online
          ? (j.sqlite ? "ok (sqlite-backed)" : "online but NOT sqlite — check new_sqlite_classes migration")
          : "unexpected response";
      }
    } catch (e) {
      console.error("vibe ping DO check:", (e && e.message) || e);
      durable = "error — check worker logs";
    }

    return json({ vibe: "alive", stage: 3, d1, durableObject: durable }, 200);
  }

  // ── Stage-2 routes (identity + rooms) — need D1; schema bootstraps lazily ──
  if (path === "/api/vibe/handle" || path === "/api/vibe/rooms") {
    if (!env.VIBE_DB) {
      console.error("vibe: VIBE_DB binding missing");
      return json({ error: "vibe backend not configured" }, 503);
    }
    await vibeEnsureSchema(env);
    if (path === "/api/vibe/handle") return vibeHandleRoute(request, env, url);
    return vibeRoomsRoute(request, env, url);
  }

  // ── Stage-3 route: WebSocket upgrade → room DO. Auth happens INSIDE the
  //    socket (first message), never in the URL — POST-only law extended.
  if (path === "/api/vibe/ws") {
    if (request.headers.get("Upgrade") !== "websocket") {
      return json({ error: "Expected websocket upgrade." }, 426);
    }
    const roomId = String(url.searchParams.get("room") || "");
    if (!/^[a-z0-9-]{1,32}$/.test(roomId)) return json({ error: "Bad room id." }, 400);
    if (!env.VIBE_DB || !env.VIBE_ROOM) {
      console.error("vibe ws: bindings missing");
      return json({ error: "vibe backend not configured" }, 503);
    }
    await vibeEnsureSchema(env);
    const room = await env.VIBE_DB.prepare(
      "SELECT id FROM rooms WHERE id=?").bind(roomId).first();
    if (!room) return json({ error: "No such room." }, 404);
    const stub = env.VIBE_ROOM.get(env.VIBE_ROOM.idFromName(roomId));
    return stub.fetch(request);
  }

  return json({ error: "Unknown vibe endpoint." }, 404);
}

// ── VibeRoom Durable Object — STAGE 3: the chat engine ──────────────────────
// WebSocket Hibernation API. Auth = FIRST MESSAGE (never the URL). Ingest law:
// staple(2000) → lexicon filter → per-handle rate limit → room daily cap →
// persist (1 sqlite row = the oxygen) → broadcast (outgoing = free).
// Healthy rooms write ZERO D1; only filtered messages touch modtrail.
export class VibeRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.buckets = new Map();          // per-handle token buckets (memory; cap backs it)
    this.lex = { phrases: null, at: 0 }; // lexicon cache, 5-min TTL
    this.dayCount = null;              // {day, n} — rebuilt with one COUNT per wake
    this.roomId = null;
    this.schemaDone = false;
  }

  sqlA(q, ...b) { return this.ctx.storage.sql.exec(q, ...b).toArray(); }

  roomSchema() {
    if (this.schemaDone) return;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, handle TEXT, body TEXT, ts INTEGER)");
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts)");
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)");
    this.schemaDone = true;
  }

  getRoomId() {
    if (this.roomId) return this.roomId;
    const r = this.sqlA("SELECT v FROM meta WHERE k='roomId'");
    this.roomId = r.length ? r[0].v : null;
    return this.roomId;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/ping") {
      const sqlite = !!(this.ctx && this.ctx.storage && this.ctx.storage.sql
        && typeof this.ctx.storage.sql.exec === "function");
      return new Response(
        JSON.stringify({ online: true, room: "VibeRoom", stage: 3, sqlite }),
        { headers: { "content-type": "application/json; charset=utf-8" } });
    }
    if (request.headers.get("Upgrade") === "websocket") {
      this.roomSchema();
      const rid = url.searchParams.get("room");
      if (rid) {
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO meta(k, v) VALUES('roomId', ?)", rid);
        this.roomId = rid;
      }
      const pair = new WebSocketPair();
      const client = pair[0], server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ authed: false });
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response(JSON.stringify({ error: "Unknown room endpoint." }),
      { status: 404, headers: { "content-type": "application/json; charset=utf-8" } });
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) { /* gone */ } }

  broadcast(obj, exceptWs) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exceptWs) continue;
      let att = null;
      try { att = ws.deserializeAttachment(); } catch (e) { att = null; }
      if (att && att.authed) { try { ws.send(s); } catch (e) { /* gone */ } }
    }
  }

  roster() {
    const names = [];
    for (const ws of this.ctx.getWebSockets()) {
      let att = null;
      try { att = ws.deserializeAttachment(); } catch (e) { att = null; }
      if (att && att.authed && att.handle) names.push(att.handle);
    }
    return names;
  }

  async lexHit(body) {
    const now = Date.now();
    if (!this.lex.phrases || now - this.lex.at > 300_000) {
      try {
        const rows = await this.env.VIBE_DB.prepare("SELECT phrase FROM lexicon").all();
        this.lex = {
          phrases: (rows && rows.results ? rows.results : []).map(r => String(r.phrase).toLowerCase()),
          at: now,
        };
      } catch (e) {
        console.error("vibe lexicon load:", (e && e.message) || e);
        if (!this.lex.phrases) this.lex = { phrases: [], at: now }; // fail-open, retry next TTL
      }
    }
    const low = body.toLowerCase();
    for (const p of this.lex.phrases) if (p && low.includes(p)) return p;
    return null;
  }

  todayCount() {
    this.roomSchema();
    const day = new Date().toISOString().slice(0, 10);
    if (this.dayCount && this.dayCount.day === day) return this.dayCount.n;
    const d = new Date();
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const r = this.sqlA("SELECT COUNT(*) AS n FROM messages WHERE ts >= ?", dayStart);
    this.dayCount = { day, n: r.length ? Number(r[0].n) : 0 };
    return this.dayCount.n;
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string") { this.send(ws, { t: "err", error: "Text frames only." }); return; }
    let msg = null;
    try { msg = JSON.parse(raw); } catch (e) { this.send(ws, { t: "err", error: "Bad message." }); return; }
    let att = null;
    try { att = ws.deserializeAttachment(); } catch (e) { att = { authed: false }; }
    att = att || { authed: false };
    this.roomSchema();

    if (msg.op === "auth") {
      if (att.authed) { this.send(ws, { t: "err", error: "Already signed in." }); return; }
      let auth = null;
      try { auth = await vibeAuth(this.env.VIBE_DB, msg.handle, msg.syncCode); }
      catch (e) { console.error("vibe ws auth:", (e && e.message) || e); this.send(ws, { t: "err", error: "vibe hiccup" }); return; }
      if (!auth.ok) {
        this.send(ws, { t: "err", error: auth.status === 429 ? "Too many attempts — wait a minute." : "Handle and code don't match." });
        try { ws.close(1008, "auth failed"); } catch (e) {}
        return;
      }
      const roomId = this.getRoomId();
      let member = null;
      try {
        member = await this.env.VIBE_DB.prepare(
          "SELECT 1 AS x FROM memberships WHERE roomId=? AND handle_lc=?")
          .bind(roomId, auth.lc).first();
      } catch (e) { console.error("vibe ws membership:", (e && e.message) || e); }
      if (!member) {
        this.send(ws, { t: "err", error: "Join this room first." });
        try { ws.close(1008, "not a member"); } catch (e) {}
        return;
      }
      att = { authed: true, handle: auth.handle, lc: auth.lc };
      ws.serializeAttachment(att);
      const rows = this.sqlA(
        "SELECT id, handle, body, ts FROM messages ORDER BY ts DESC, id DESC LIMIT " + VIBE_BACKFILL
      ).reverse();
      this.send(ws, { t: "welcome", room: roomId, handle: auth.handle, roster: this.roster(), backfill: rows });
      this.broadcast({ t: "join", handle: auth.handle, ts: Date.now() }, ws);
      return;
    }

    if (!att.authed) { this.send(ws, { t: "err", error: "Sign in first." }); return; }

    if (msg.op === "msg") {
      const body = String(msg.body == null ? "" : msg.body);
      if (!body.trim()) { this.send(ws, { t: "err", error: "Empty message." }); return; }
      if (body.length > 2000) { this.send(ws, { t: "err", error: "Message exceeds 2,000 characters." }); return; }

      const hit = await this.lexHit(body);
      if (hit) {
        try {
          await this.env.VIBE_DB.prepare(
            "INSERT INTO modtrail(msgId, roomId, handle, body, reason, ts) VALUES(?,?,?,?,?,?)")
            .bind("f" + vibeRandB32(12), this.getRoomId(), att.handle, body, "lexicon", Date.now()).run();
        } catch (e) { console.error("vibe modtrail:", (e && e.message) || e); }
        this.send(ws, { t: "held", error: "Message held by the scam filter." });
        return;
      }

      const now = Date.now();
      let b = this.buckets.get(att.lc);
      if (!b) { b = { tokens: 5, last: now }; this.buckets.set(att.lc, b); }
      b.tokens = Math.min(5, b.tokens + (now - b.last) / 1000);
      b.last = now;
      if (b.tokens < 1) { this.send(ws, { t: "err", error: "Slow down — 1 message per second." }); return; }
      b.tokens -= 1;

      if (this.todayCount() >= VIBE_ROOM_DAILY_CAP) {
        this.send(ws, { t: "err", error: "Room's cooling off until midnight UTC — daily message limit reached (free tier)." });
        return;
      }

      const id = now.toString(36) + vibeRandB32(6);
      this.ctx.storage.sql.exec(
        "INSERT INTO messages(id, handle, body, ts) VALUES(?,?,?,?)", id, att.handle, body, now);
      this.dayCount.n += 1;
      const out = { t: "msg", id, handle: att.handle, body, ts: now };
      this.send(ws, out);
      this.broadcast(out, ws);
      return;
    }

    this.send(ws, { t: "err", error: "Unknown op." });
  }

  webSocketClose(ws) {
    let att = null;
    try { att = ws.deserializeAttachment(); } catch (e) { att = null; }
    if (att && att.authed && !att.left) {
      try { ws.serializeAttachment({ ...att, left: true }); } catch (e) {}
      this.broadcast({ t: "leave", handle: att.handle, ts: Date.now() }, ws);
    }
  }

  webSocketError(ws) { this.webSocketClose(ws); }
}

/* ─────────────────────────────────────────────────────────────────────────────
   STAGE 2 — Identity (handle + sync-code) and Rooms API.
   Laws in force: entropy law (generated-only codes, ≥128 bits — this build uses
   160), case-insensitive handle uniqueness, reserved-handle seed, 5/min verify
   rate limit, information hygiene (generic public errors, internals → logs).
   Sync-codes are NEVER stored (SHA-256 only) and must NEVER appear in URLs —
   claims/verifies are POST-body only.
   ───────────────────────────────────────────────────────────────────────────── */

// ── Schema bootstrap (lazy, idempotent, memoized per isolate) ────────────────
let _vibeSchemaReady = null;
function vibeEnsureSchema(env) {
  if (!_vibeSchemaReady) _vibeSchemaReady = vibeBootstrap(env).catch(e => {
    _vibeSchemaReady = null;            // allow retry on next request
    throw e;                            // fence turns this into a generic 500
  });
  return _vibeSchemaReady;
}

async function vibeBootstrap(env) {
  const db = env.VIBE_DB;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS handles(
       handle_lc TEXT PRIMARY KEY, handle TEXT NOT NULL, codeHash TEXT,
       createdAt INTEGER, isAdmin INTEGER DEFAULT 0, reserved INTEGER DEFAULT 0,
       verifyCount INTEGER DEFAULT 0, verifyWindow INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS rooms(
       id TEXT PRIMARY KEY, name TEXT NOT NULL, official INTEGER DEFAULT 0,
       createdBy TEXT, inviteCode TEXT UNIQUE, createdAt INTEGER)`,
    `CREATE TABLE IF NOT EXISTS memberships(
       roomId TEXT, handle_lc TEXT, joinedAt INTEGER,
       PRIMARY KEY(roomId, handle_lc))`,
    `CREATE TABLE IF NOT EXISTS modtrail(
       id INTEGER PRIMARY KEY AUTOINCREMENT, msgId TEXT, roomId TEXT,
       handle TEXT, body TEXT, reason TEXT, ts INTEGER)`,
    `CREATE TABLE IF NOT EXISTS reports(
       id INTEGER PRIMARY KEY AUTOINCREMENT, modtrailId INTEGER,
       reporter_lc TEXT, roomId TEXT, msgId TEXT, reason TEXT, ts INTEGER)`,
    `CREATE TABLE IF NOT EXISTS blocks(
       blocker_lc TEXT, blocked_lc TEXT, ts INTEGER,
       PRIMARY KEY(blocker_lc, blocked_lc))`,
    `CREATE TABLE IF NOT EXISTS mutes(
       muter_lc TEXT, muted_lc TEXT, ts INTEGER,
       PRIMARY KEY(muter_lc, muted_lc))`,
    `CREATE TABLE IF NOT EXISTS outclicks(
       day TEXT, dest TEXT, symbol TEXT, count INTEGER DEFAULT 0,
       PRIMARY KEY(day, dest, symbol))`,
    `CREATE TABLE IF NOT EXISTS lexicon(
       phrase TEXT PRIMARY KEY, addedBy TEXT, ts INTEGER)`,
    `CREATE TABLE IF NOT EXISTS ipclaims(
       day TEXT, iphash TEXT, count INTEGER DEFAULT 0,
       PRIMARY KEY(day, iphash))`,
  ];
  await db.batch(stmts.map(s => db.prepare(s)));

  // Reserved handles — squatters evicted at bootstrap (case-insensitive law).
  const RESERVED = [
    "LazyBeatz", "LazyBeats", "Lazy_Beatz", "LexBeatz", "Lex_Beatz",
    "admin", "administrator", "official", "support", "mod", "moderator",
    "portfoliovibe", "vibe", "staff", "help", "verified",
  ];
  const now = Date.now();
  const seedH = db.prepare(
    "INSERT OR IGNORE INTO handles(handle_lc, handle, codeHash, createdAt, reserved) VALUES(?,?,NULL,?,1)");
  const seedR = db.prepare(
    "INSERT OR IGNORE INTO rooms(id, name, official, createdBy, inviteCode, createdAt) VALUES(?,?,1,'official',NULL,?)");
  const LEXICON_SEED = [
    "guaranteed returns", "guaranteed profits", "risk-free returns",
    "double your money", "insider tip", "join my telegram",
    "join my whatsapp", "dm me to invest", "send me crypto",
  ];
  const seedL = db.prepare(
    "INSERT OR IGNORE INTO lexicon(phrase, addedBy, ts) VALUES(?,'seed',?)");
  await db.batch([
    ...RESERVED.map(h => seedH.bind(h.toLowerCase(), h, now)),
    seedR.bind("trading-floor", "The Trading Floor", now),
    seedR.bind("casino-lounge", "Casino Lounge", now),
    ...LEXICON_SEED.map(p => seedL.bind(p, now)),
  ]);
}

// ── Identity helpers ─────────────────────────────────────────────────────────
const VIBE_B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: no I L O U
const VIBE_ROOM_CAP = 50;   // v1 member cap per room — the D8 free/paid seam.
                            // Raising it is the paid tier's job, not a hotfix.
const VIBE_BACKFILL = 50;   // stage-3 constant, locked now: join backfill sends
                            // the last N messages, never the whole scroll.
const VIBE_CLAIMS_PER_IP_DAY = 10; // third wall: handle claims per hashed IP/day
const VIBE_ROOMS_PER_DAY = 5;      // third wall: room creations per handle/day
                                   // (the 20 lifetime cap stays alongside)
const VIBE_ROOM_DAILY_CAP = 10000; // second governor (consultant-approved):
                                   // msgs/room/day — one maxed room = 10% of
                                   // daily oxygen; resets midnight UTC.
const HANDLE_RX = /^[A-Za-z][A-Za-z0-9_]{2,19}$/;    // 3–20, letter-first, ASCII

function vibeRandB32(chars) {
  const buf = new Uint8Array(chars);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < chars; i++) out += VIBE_B32[buf[i] % 32]; // 256%32===0 → no bias
  return out;
}

function vibeNewSyncCode() {
  // 32 Crockford chars × 5 bits = 160 bits entropy (law: ≥128). Grouped for humans.
  const raw = vibeRandB32(32);
  return "VIBE-" + raw.match(/.{4}/g).join("-");
}

function vibeNormalizeCode(input) {
  // tolerate dashes/spaces/case; strip the VIBE prefix only when lengths prove it
  const s = String(input || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (s.length === 36 && s.startsWith("VIBE")) return s.slice(4);
  if (s.length === 32) return s;
  return null; // wrong shape → caller treats as auth failure
}

async function vibeSha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// auth check shared by every authed op — enforces the 5/min verify rate limit
async function vibeAuth(db, handle, syncCode) {
  const lc = String(handle || "").toLowerCase();
  const row = await db.prepare(
    "SELECT handle, handle_lc, codeHash, isAdmin, reserved, verifyCount, verifyWindow FROM handles WHERE handle_lc=?"
  ).bind(lc).first();
  if (!row || !row.codeHash) return { ok: false, status: 401 };

  const now = Date.now();
  let count = row.verifyCount || 0, win = row.verifyWindow || 0;
  if (now - win > 60_000) { count = 0; win = now; }
  if (count >= 5) return { ok: false, status: 429 };

  const norm = vibeNormalizeCode(syncCode);
  const ok = norm ? (await vibeSha256Hex(norm)) === row.codeHash : false;
  // D1 write-budget guard: clean success (ok, no strikes) is a no-op — skip the
  // UPDATE entirely. Failures always write; successes only write to clear strikes.
  if (!ok || count > 0) {
    await db.prepare("UPDATE handles SET verifyCount=?, verifyWindow=? WHERE handle_lc=?")
      .bind(ok ? 0 : count + 1, win, lc).run();
  }
  return ok
    ? { ok: true, handle: row.handle, lc, isAdmin: !!row.isAdmin }
    : { ok: false, status: 401 };
}

async function vibeReadJson(request) {
  try { return await request.json(); } catch (e) { return null; }
}

// ── /api/vibe/handle — claim & verify ────────────────────────────────────────
async function vibeHandleRoute(request, env, url) {
  if (request.method !== "POST") return json({ error: "POST only." }, 405);
  const db = env.VIBE_DB;
  const body = await vibeReadJson(request);
  if (!body) return json({ error: "Bad request." }, 400);

  if (body.op === "claim") {
    const handle = String(body.handle || "").trim();
    if (!HANDLE_RX.test(handle)) {
      return json({ error: "Handle must be 3–20 chars, start with a letter, letters/numbers/_ only." }, 400);
    }
    const lc = handle.toLowerCase();
    const existing = await db.prepare(
      "SELECT codeHash, reserved FROM handles WHERE handle_lc=?").bind(lc).first();

    // Reserved handles unlock ONLY with the founder's VIBE_ADMIN_KEY secret.
    let admin = false;
    if (existing && existing.reserved && !existing.codeHash) {
      const key = body.adminKey ? String(body.adminKey) : "";
      const match = env.VIBE_ADMIN_KEY && key &&
        (await vibeSha256Hex(key)) === (await vibeSha256Hex(env.VIBE_ADMIN_KEY));
      if (!match) return json({ error: "That handle is reserved." }, 403);
      admin = true;
    } else if (existing && existing.codeHash) {
      return json({ error: "Handle already taken." }, 409);
    }

    // Third wall — per-IP daily claim throttle (hashed IP, zero-PII; admin
    // claims bypass so the founder can crown reserved handles in one sitting).
    const day = new Date().toISOString().slice(0, 10);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const iphash = (await vibeSha256Hex("vibe-ip|" + ip)).slice(0, 16);
    if (!admin) {
      const used = await db.prepare(
        "SELECT count FROM ipclaims WHERE day=? AND iphash=?").bind(day, iphash).first();
      if (used && used.count >= VIBE_CLAIMS_PER_IP_DAY) {
        return json({ error: "Too many new handles from your network today — try again tomorrow." }, 429);
      }
    }

    const syncCode = vibeNewSyncCode();
    const codeHash = await vibeSha256Hex(vibeNormalizeCode(syncCode));
    const now = Date.now();
    if (existing) {
      await db.prepare(
        "UPDATE handles SET handle=?, codeHash=?, createdAt=?, isAdmin=? WHERE handle_lc=? AND codeHash IS NULL")
        .bind(handle, codeHash, now, admin ? 1 : 0, lc).run();
    } else {
      // INSERT OR IGNORE + verify: two same-name claims can race; only one wins.
      await db.prepare(
        "INSERT OR IGNORE INTO handles(handle_lc, handle, codeHash, createdAt, isAdmin) VALUES(?,?,?,?,0)")
        .bind(lc, handle, codeHash, now).run();
    }
    const winner = await db.prepare(
      "SELECT codeHash FROM handles WHERE handle_lc=?").bind(lc).first();
    if (!winner || winner.codeHash !== codeHash) {
      return json({ error: "Handle already taken." }, 409);
    }
    if (!admin) {
      await db.prepare(
        `INSERT INTO ipclaims(day, iphash, count) VALUES(?,?,1)
         ON CONFLICT(day, iphash) DO UPDATE SET count = count + 1`)
        .bind(day, iphash).run();
    }
    return json({
      ok: true, handle, isAdmin: admin, syncCode,
      warning: "Your sync-code IS your identity. Lost code = lost handle, permanently — there is no recovery until accounts arrive. Save it now.",
    }, 200);
  }

  if (body.op === "verify") {
    const auth = await vibeAuth(db, body.handle, body.syncCode);
    if (!auth.ok) return json({ error: auth.status === 429 ? "Too many attempts — wait a minute." : "Handle and code don't match." }, auth.status);
    return json({ ok: true, handle: auth.handle, isAdmin: auth.isAdmin }, 200);
  }

  return json({ error: "Unknown op." }, 400);
}

// ── /api/vibe/rooms — create / join / joinOfficial / mine / official ─────────
async function vibeRoomsRoute(request, env, url) {
  const db = env.VIBE_DB;

  // Public, read-only: the official curated rooms (GET-friendly for testing).
  const opQ = url.searchParams.get("op");
  if (request.method === "GET" && opQ === "official") return vibeOfficialList(db);

  if (request.method !== "POST") return json({ error: "POST only." }, 405);
  const body = await vibeReadJson(request);
  if (!body) return json({ error: "Bad request." }, 400);
  if (body.op === "official") return vibeOfficialList(db);

  // Everything below requires identity.
  const auth = await vibeAuth(db, body.handle, body.syncCode);
  if (!auth.ok) return json({ error: auth.status === 429 ? "Too many attempts — wait a minute." : "Sign in first — handle and code don't match." }, auth.status);
  const now = Date.now();

  if (body.op === "create") {
    let name = String(body.name || "").replace(/[\u0000-\u001F\u007F]/g, "").trim().replace(/\s+/g, " ");
    if (name.length < 1 || name.length > 50) return json({ error: "Room name must be 1–50 characters." }, 400);
    const mine = await db.prepare(
      "SELECT COUNT(*) AS n FROM rooms WHERE createdBy=?").bind(auth.lc).first();
    if ((mine && mine.n) >= 20) return json({ error: "Room limit reached (20)." }, 403);
    const d = new Date();
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const today = await db.prepare(
      "SELECT COUNT(*) AS n FROM rooms WHERE createdBy=? AND createdAt>=?")
      .bind(auth.lc, dayStart).first();
    if ((today && today.n) >= VIBE_ROOMS_PER_DAY) {
      return json({ error: "Room-creation limit for today (" + VIBE_ROOMS_PER_DAY + "/day on the free tier)." }, 429);
    }
    const id = vibeRandB32(16).toLowerCase();
    const inviteCode = vibeRandB32(10);
    await db.batch([
      db.prepare("INSERT INTO rooms(id, name, official, createdBy, inviteCode, createdAt) VALUES(?,?,0,?,?,?)")
        .bind(id, name, auth.lc, inviteCode, now),
      db.prepare("INSERT OR IGNORE INTO memberships(roomId, handle_lc, joinedAt) VALUES(?,?,?)")
        .bind(id, auth.lc, now),
    ]);
    return json({ ok: true, room: { id, name, official: false, inviteCode } }, 200);
  }

  if (body.op === "join") {
    const invite = String(body.invite || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
    if (!invite) return json({ error: "Invite code required." }, 400);
    const room = await db.prepare(
      "SELECT id, name, official, inviteCode FROM rooms WHERE inviteCode=?").bind(invite).first();
    if (!room) return json({ error: "Invite not found." }, 404);
    const full = await vibeJoinCapCheck(db, room.id, auth.lc, now);
    if (full) return full;
    return json({ ok: true, room: { id: room.id, name: room.name, official: !!room.official, inviteCode: room.inviteCode } }, 200);
  }

  if (body.op === "joinOfficial") {
    const roomId = String(body.roomId || "");
    const room = await db.prepare(
      "SELECT id, name FROM rooms WHERE id=? AND official=1").bind(roomId).first();
    if (!room) return json({ error: "No such official room." }, 404);
    const full = await vibeJoinCapCheck(db, room.id, auth.lc, now);
    if (full) return full;
    return json({ ok: true, room: { id: room.id, name: room.name, official: true } }, 200);
  }

  if (body.op === "mine") {
    const rows = await db.prepare(
      `SELECT r.id, r.name, r.official, r.inviteCode, m.joinedAt
         FROM rooms r JOIN memberships m ON m.roomId = r.id
        WHERE m.handle_lc=? ORDER BY m.joinedAt DESC`).bind(auth.lc).all();
    const rooms = (rows && rows.results ? rows.results : []).map(r => ({
      id: r.id, name: r.name, official: !!r.official,
      inviteCode: r.official ? null : r.inviteCode, joinedAt: r.joinedAt,
    }));
    return json({ ok: true, rooms }, 200);
  }

  return json({ error: "Unknown op." }, 400);
}

// Join-path cap law: existing members re-join freely (idempotent) even at cap;
// new member #51 bounces. Returns a Response when full, null when joined.
async function vibeJoinCapCheck(db, roomId, lc, now) {
  const already = await db.prepare(
    "SELECT 1 AS x FROM memberships WHERE roomId=? AND handle_lc=?").bind(roomId, lc).first();
  if (already) return null;
  const n = await db.prepare(
    "SELECT COUNT(*) AS n FROM memberships WHERE roomId=?").bind(roomId).first();
  if ((n && n.n) >= VIBE_ROOM_CAP) {
    return json({ error: "Room is full (" + VIBE_ROOM_CAP + " members max on the free tier)." }, 403);
  }
  await db.prepare("INSERT OR IGNORE INTO memberships(roomId, handle_lc, joinedAt) VALUES(?,?,?)")
    .bind(roomId, lc, now).run();
  return null;
}

async function vibeOfficialList(db) {
  const rows = await db.prepare(
    "SELECT id, name FROM rooms WHERE official=1 ORDER BY createdAt ASC").all();
  const rooms = (rows && rows.results ? rows.results : []).map(r => ({ id: r.id, name: r.name, official: true }));
  return json({ ok: true, rooms }, 200);
}
