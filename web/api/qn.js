// Quicknode's Stock Token API (an add-on on our Robinhood Chain endpoint), proxied so the endpoint key stays
// server-side. Only its five read methods pass through, each cached for as long as its answer stays useful.
const METHODS = {
  qn_getOracleHealth: 20, // feed state, US session, Robinhood mint window, sequencer
  qn_getStockTokens: 300, // registry with live multiplier, oracle pause, trading capabilities
  qn_getCorporateActions: 1800, // split and dividend history, matched to Robinhood's records
  qn_getStockTokenBalances: 0, // a wallet's holdings in shares, valued from Chainlink
  qn_getTransactionFinality: 10, // soft → posted → safe → finalized on Ethereum
};
const ORIGINS = /^https:\/\/(tutup\.vercel\.app|tutup-[a-z0-9-]+\.vercel\.app)$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export async function quicknode(method, params) {
  if (!process.env.QUICKNODE_RPC) throw Object.assign(new Error("Quicknode endpoint not configured"), { status: 503 });
  if (!(method in METHODS)) throw Object.assign(new Error("method not allowed"), { status: 400 });
  const r = await fetch(process.env.QUICKNODE_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || [] }),
  });
  const body = await r.json();
  if (body.error) throw Object.assign(new Error(body.error.message), { status: 502 });
  return body.result;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!ORIGINS.test(req.headers.origin || "")) return res.status(403).json({ error: "origin not allowed" });
  const { method, params } = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  try {
    const result = await quicknode(method, params);
    const ttl = METHODS[method];
    res.setHeader("cache-control", ttl ? `public, s-maxage=${ttl}, stale-while-revalidate=${ttl}` : "no-store");
    return res.status(200).json({ result });
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.message });
  }
}
