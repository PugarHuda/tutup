// Quicknode's Stock Token API (an add-on on our Robinhood Chain endpoint), proxied so the endpoint key stays
// server-side. Only these read methods pass through, each cached for as long as its answer stays useful.
// The ERC-8004 add-on (Agent Discovery & Reputation) indexes every chain, and agent ids are per chain: #25584 on Base
// is someone else. So its methods are pinned to Tutup's agent on Robinhood Chain and ignore client params.
const METHODS = {
  qn_getOracleHealth: 20, // feed state, US session, Robinhood mint window, sequencer
  qn_getStockTokens: 300, // registry with live multiplier, oracle pause, trading capabilities
  qn_getCorporateActions: 1800, // split and dividend history, matched to Robinhood's records
  qn_getStockTokenBalances: 0, // a wallet's holdings in shares, valued from Chainlink
  qn_getTransactionFinality: 10, // soft → posted → safe → finalized on Ethereum
  erc8004_getAgent: 300, // Tutup's identity record as Quicknode indexed it (agent.json, protocol tag)
  erc8004_getAgentReputation: 300, // composite 0-100 score, sybil resistance, reliability, confidence tier
};
const TUTUP_AGENT = [25584, { network: "robinhood-mainnet" }];
const PINNED = { erc8004_getAgent: TUTUP_AGENT, erc8004_getAgentReputation: TUTUP_AGENT };
const ORIGINS = /^https:\/\/(tutup\.vercel\.app|tutup-[a-z0-9-]+\.vercel\.app)$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export async function quicknode(method, params) {
  if (!process.env.QUICKNODE_RPC) throw Object.assign(new Error("Quicknode endpoint not configured"), { status: 503 });
  if (!(method in METHODS)) throw Object.assign(new Error("method not allowed"), { status: 400 });
  // ponytail: the free plan allows 1 add-on call/second; two quick retries ride it out, a paid plan removes the need
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(process.env.QUICKNODE_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: PINNED[method] || params || [] }),
    });
    const body = await r.json();
    if (body.error && /request limit/i.test(body.error.message) && attempt < 2) { await new Promise((ok) => setTimeout(ok, 1100)); continue; }
    if (body.error) throw Object.assign(new Error(body.error.message), { status: 502 });
    return body.result;
  }
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
    // not configured yet is a normal state, not an error: the page just hides these panels
    if (e.status === 503) return res.status(200).json({ configured: false, result: null });
    return res.status(e.status || 502).json({ error: e.message });
  }
}
