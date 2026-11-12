// Same-origin, read-only JSON-RPC proxy for Robinhood Chain. The public endpoint rate-limits bursts and its 429s
// carry no CORS header, so a busy page saw "CORS errors". Reads go here first: the public RPC, then GetBlock's
// endpoint (GETBLOCK_RPC, kept server-side) if the first fails. Writes never pass through; wallets send those.
const READ = new Set([
  "eth_chainId", "eth_blockNumber", "eth_call", "eth_getBalance", "eth_getCode", "eth_getLogs",
  "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getTransactionByHash", "eth_getTransactionReceipt",
  "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_getStorageAt",
]);
const UPSTREAMS = ["https://rpc.mainnet.chain.robinhood.com", process.env.GETBLOCK_RPC].filter(Boolean);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "null") : req.body;
  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length || calls.length > 100 || calls.some((c) => !c || !READ.has(c.method))) {
    return res.status(400).json({ error: "read-only methods, at most 100 per batch" });
  }
  for (const url of UPSTREAMS) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (r.status === 429 || r.status >= 500) continue;
      res.setHeader("content-type", "application/json");
      return res.status(r.status).send(await r.text());
    } catch {
      // try the next upstream
    }
  }
  return res.status(502).json({ error: "all upstreams failed" });
}
