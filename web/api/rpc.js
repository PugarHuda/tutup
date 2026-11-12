// Same-origin, read-only JSON-RPC proxy for Robinhood Chain. The public endpoint rate-limits bursts and its 429s
// carry no CORS header, so a busy page saw "CORS errors". Reads go to Quicknode, then the public RPC, then GetBlock
// (both sponsor keys stay server-side). Writes never pass through; wallets send those.
const READ = new Set([
  "eth_chainId", "eth_blockNumber", "eth_call", "eth_getBalance", "eth_getCode", "eth_getLogs",
  "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getTransactionByHash", "eth_getTransactionReceipt",
  "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_getStorageAt",
]);
// Quicknode first (our endpoint, sponsor), then the public RPC, then GetBlock (sponsor) as the last failover
const UPSTREAMS = [process.env.QUICKNODE_RPC, "https://rpc.mainnet.chain.robinhood.com", process.env.GETBLOCK_RPC].filter(Boolean);
const ORIGINS = /^https:\/\/(tutup\.vercel\.app|tutup-[a-z0-9-]+\.vercel\.app)$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const MAX_BATCH = 50;
const MAX_LOG_SPAN = 50_000n;
// ponytail: per-instance counter, a soft brake not a wall; move to Upstash/KV if someone actually hammers it
const hits = new Map();
function limited(ip) {
  const now = Date.now(), w = hits.get(ip) || { t: now, n: 0 };
  if (now - w.t > 60_000) { w.t = now; w.n = 0; }
  w.n++;
  hits.set(ip, w);
  return w.n > 600;
}
// Log reads must name a contract. A numeric range is capped at MAX_LOG_SPAN; an open range ("…to latest")
// is allowed because it's scoped to one address, which is how the page reads its own contract's events.
function logsOk(c) {
  try {
    const f = c.params?.[0] || {};
    if (!f.address) return false;
    if (f.blockHash || f.toBlock === undefined || f.toBlock === "latest") return true;
    const from = BigInt(f.fromBlock ?? "0x0"), to = BigInt(f.toBlock);
    return to >= from && to - from <= MAX_LOG_SPAN;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!ORIGINS.test(req.headers.origin || "")) return res.status(403).json({ error: "origin not allowed" });
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) return res.status(429).json({ error: "slow down" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "null") : req.body;
  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length || calls.length > MAX_BATCH || calls.some((c) => !c || !READ.has(c.method))) {
    return res.status(400).json({ error: `read-only methods, at most ${MAX_BATCH} per batch` });
  }
  if (calls.some((c) => c.method === "eth_getLogs" && !logsOk(c))) {
    return res.status(400).json({ error: "eth_getLogs needs an address and a bounded block range" });
  }
  for (const url of UPSTREAMS) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (r.status === 429 || r.status >= 500) continue;
      const text = await r.text();
      // Quicknode's Discover plan answers wide eth_getLogs with 200 + code -32615 ("limited to a 5 range"): next upstream
      if (text.includes("-32615") && url !== UPSTREAMS.at(-1)) continue;
      res.setHeader("content-type", "application/json");
      return res.status(r.status).send(text);
    } catch {
      // try the next upstream
    }
  }
  return res.status(502).json({ error: "all upstreams failed" });
}
