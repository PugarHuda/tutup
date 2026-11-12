// End-to-end: an "agent" bids through the MCP server on a local anvil fork of Robinhood Chain.
// The MCP prepares calls; the agent sends them from its own unlocked fork account; then reveal and settle.
// usage: MCP_TEST_RPC=http://127.0.0.1:8545 MCP_TEST_TUTUP=0x… MCP_TEST_FROM=<fork block> node scripts/mcp-fork-test.mjs <auctionId> <agent>
import assert from "node:assert/strict";
const { default: handler } = await import(new URL("../web/api/mcp.js", import.meta.url));
const RPC = process.env.MCP_TEST_RPC;
const [id, agent] = [Number(process.argv[2]), process.argv[3]];
let n = 0;
const node = async (method, params = []) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) })).json());
const mcp = (name, args) => new Promise((resolve) => {
  const res = { status() { return this; }, setHeader() {}, end() {}, json: resolve, send: resolve };
  handler({ method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } }, res);
}).then((r) => { const t = r.result.content[0].text; if (r.result.isError) throw new Error(t); return JSON.parse(t); });
const send = async (calls) => {
  for (const c of calls) {
    const { result: hash, error } = await node("eth_sendTransaction", [{ from: agent, to: c.to, data: c.data }]);
    assert.ok(!error, `${c.note}: ${error?.message}`);
    let r;
    for (let i = 0; i < 50 && !r; i++) { r = (await node("eth_getTransactionReceipt", [hash])).result; if (!r) await new Promise((x) => setTimeout(x, 200)); }
    assert.equal(r.status, "0x1", `${c.note} reverted`);
    console.log("  sent:", c.note, hash.slice(0, 12));
  }
};
const warp = async (s) => { await node("evm_increaseTime", [s]); await node("evm_mine"); };

const bid = await mcp("prepare_bid", { auction_id: id, bidder: agent, quantity: "0.5", price: "0.07" });
console.log("prepare_bid → escrow at reveal", bid.escrowAtReveal);
await send(bid.calls);
await assert.rejects(mcp("prepare_reveal", { receipt: bid.receipt }), /reveal/, "reveal refused during commit");
await warp(301);
const rev = await mcp("prepare_reveal", { receipt: bid.receipt });
await send(rev.calls);
await warp(301);
await send((await mcp("prepare_settle", { auction_id: id })).calls);
const a = await mcp("get_auction", { id });
console.log("result:", a.result);
assert.equal(a.result.clearingPrice, "0.07");
assert.equal(a.bids[0].bidder.toLowerCase(), agent.toLowerCase());
console.log("agent bid through MCP: ok");
