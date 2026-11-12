// Pyth price feeds for Stock Tokens: Equity.US.X/USD (session hours) and Equity.Index.X/USD (24/7), read from
// Hermes with a Pyth Pro key kept server-side (PYTH_API_KEY). Since the Pyth Core upgrade on 26 Aug 2026 Hermes
// requires a key, and equities need the Pro plan, so this answers { configured: false } until a key is set.
// The feed directory itself is public, so symbols resolve without a key.
import TOKENS from "../tokens.json" with { type: "json" };

const HERMES = "https://hermes.pyth.network";
const SYMBOLS = new Set(TOKENS.map((t) => t.sym)); // only official Robinhood Stock Tokens
const SITE = /^https:\/\/(tutup\.vercel\.app|tutup-[a-z0-9-]+\.vercel\.app)(\/|$)|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;
const ids = new Map();

async function feedIds(sym) {
  if (!ids.has(sym)) {
    ids.set(sym, fetch(`${HERMES}/v2/price_feeds?query=${encodeURIComponent(sym)}&asset_type=equity`)
      .then((r) => { if (!r.ok) throw new Error(`Hermes ${r.status}`); return r.json(); })
      .then((l) => {
        if (!Array.isArray(l)) throw new Error("unexpected feed list");
        return { us: l.find((f) => f.attributes?.symbol === `Equity.US.${sym}/USD`)?.id, d247: l.find((f) => f.attributes?.symbol === `Equity.Index.${sym}/USD`)?.id };
      })
      .catch((e) => { ids.delete(sym); throw e; })); // never cache a failure
  }
  return ids.get(sym);
}

export async function pythPrices(sym) {
  if (!process.env.PYTH_API_KEY) return { configured: false };
  if (!SYMBOLS.has(sym)) throw new Error("not a Robinhood Stock Token");
  const f = await feedIds(sym);
  const want = [f.us, f.d247].filter(Boolean);
  if (!want.length) return { configured: true, us: null, d247: null };
  const r = await fetch(`${HERMES}/v2/updates/price/latest?${want.map((i) => `ids[]=${i}`).join("&")}&parsed=true`, {
    headers: { authorization: `Bearer ${process.env.PYTH_API_KEY}` },
  });
  if (!r.ok) throw new Error(`Hermes ${r.status}`);
  const parsed = (await r.json()).parsed || [];
  const val = (id) => {
    const p = parsed.find((x) => x.id === id?.replace(/^0x/, ""))?.price;
    if (!p) return null;
    const e = 10 ** p.expo;
    return { price: Number(p.price) * e, conf: Number(p.conf) * e, publishTime: p.publish_time };
  };
  return { configured: true, us: val(f.us), d247: val(f.d247) };
}

export default async function handler(req, res) {
  // same-origin GETs carry no Origin header, so check how the browser says it was fetched
  const fromSite = req.headers["sec-fetch-site"] === "same-origin" || SITE.test(req.headers.origin || "") || SITE.test(req.headers.referer || "");
  if (!fromSite) return res.status(403).json({ error: "origin not allowed" });
  const sym = String(req.query.symbol || "");
  if (!SYMBOLS.has(sym)) return res.status(400).json({ error: "symbol must be an official Stock Token, upper case" });
  try {
    const out = await pythPrices(sym);
    res.setHeader("cache-control", out.configured ? "public, s-maxage=5, stale-while-revalidate=10" : "public, s-maxage=300");
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ configured: true, error: e.message });
  }
}
