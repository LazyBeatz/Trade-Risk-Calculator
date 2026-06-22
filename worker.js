// Cloudflare Worker — serves the static app AND the /api/quote endpoint.
// "With the grain" of Cloudflare's Workers-first direction.
//
// How it works:
//   • Requests to /api/quote?symbol=...  -> handled here (market router below)
//   • Everything else (/, /index.html…)  -> served from the ./public folder
//     automatically via the [assets] binding in wrangler.toml (env.ASSETS).
//
// Secrets (set in dashboard → your Worker → Settings → Variables and Secrets,
// as ENCRYPTED secrets — never in this file):
//   FINNHUB_KEY        = your free Finnhub API key
//   ALPHAVANTAGE_KEY   = your free Alpha Vantage API key

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API route
    if (url.pathname === "/api/quote") {
      return handleQuote(url, env);
    }

    // Everything else -> static assets (index.html, etc.)
    return env.ASSETS.fetch(request);
  },
};

async function handleQuote(url, env) {
  const raw = (url.searchParams.get("symbol") || "").trim().toUpperCase();

  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
    return json({ error: "Invalid or missing symbol." }, 400);
  }

  const isCanadian = /\.(TO|TRT|V|VN|NE|CN)$/.test(raw);

  try {
    const quote = isCanadian
      ? await fromAlphaVantage(raw, env.ALPHAVANTAGE_KEY)
      : await fromFinnhub(raw, env.FINNHUB_KEY);

    if (!quote) return json({ error: "No quote found." }, 404);
    return json(quote, 200, 30);
  } catch (e) {
    const status = e && e.status ? e.status : 502;
    return json({ error: e && e.message ? e.message : "Upstream error." }, status);
  }
}

// ---- Finnhub (US) -----------------------------------------------------------
async function fromFinnhub(symbol, key) {
  if (!key) throw withStatus(new Error("Finnhub key not configured."), 500);
  const u = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`;
  const r = await fetch(u, { cf: { cacheTtl: 30 } });
  if (r.status === 429) throw withStatus(new Error("Rate limit."), 429);
  if (!r.ok) throw withStatus(new Error("Finnhub error."), 502);
  const d = await r.json();
  const price = d && typeof d.c === "number" ? d.c : null;
  if (!price || price <= 0) return null; // unknown symbol returns c:0
  return {
    symbol,
    price: round2(price),
    delayed: true,
    asOf: d.t ? new Date(d.t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : null,
    source: "Finnhub",
  };
}

// ---- Alpha Vantage (TSX / Canadian) ----------------------------------------
async function fromAlphaVantage(symbol, key) {
  if (!key) throw withStatus(new Error("Alpha Vantage key not configured."), 500);
  const u = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${key}`;
  const r = await fetch(u, { cf: { cacheTtl: 30 } });
  if (!r.ok) throw withStatus(new Error("Alpha Vantage error."), 502);
  const d = await r.json();
  if (d && (d.Note || d.Information)) throw withStatus(new Error("Rate limit."), 429);
  const q = d && d["Global Quote"];
  const priceStr = q && q["05. price"];
  const price = priceStr ? parseFloat(priceStr) : null;
  if (!price || price <= 0) return null;
  return {
    symbol,
    price: round2(price),
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
