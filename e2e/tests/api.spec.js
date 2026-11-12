import { test, expect } from "@playwright/test";

const mcp = async (request, name, args) => {
  const r = await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
  const res = (await r.json()).result;
  return { error: !!res.isError, text: res.content[0].text };
};

test.describe("MCP server", () => {
  test("lists every tool", async ({ request }) => {
    const r = await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    const names = (await r.json()).result.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_auctions", "get_auction", "market_status", "weekend_prints", "portfolio", "corporate_actions", "tx_finality", "prepare_bid", "prepare_reveal", "agent_reputation", "prepare_settle"]));
  });
  test("reads live auctions and market status", async ({ request }) => {
    expect(JSON.parse((await mcp(request, "list_auctions", {})).text).auctions.length).toBeGreaterThan(2);
    const m = JSON.parse((await mcp(request, "market_status", { symbol: "NVDA" })).text);
    expect(m.officialFeed24x5.price).toBeGreaterThan(1);
  });
  test("validates arguments against each schema", async ({ request }) => {
    expect(await mcp(request, "get_auction", {})).toEqual({ error: true, text: "missing required argument: id" });
    expect((await mcp(request, "get_auction", { id: "abc" })).text).toMatch(/non-negative integer/);
    expect((await mcp(request, "prepare_settle", { id: 2 })).text).toMatch(/missing required argument: auction_id/);
    expect((await mcp(request, "nope", {})).text).toMatch(/unknown tool/);
    expect((await mcp(request, "get_auction", { id: 999 })).text).toMatch(/doesn't exist/);
  });
  test("prepare_bid timelocks the receipt into the commit calldata", async ({ request }) => {
    const r = await mcp(request, "prepare_bid", { auction_id: 1, bidder: "0x3aaa5b87bd13be841e824e62cc4c66004420b7c3", quantity: "10", price: "0.000000525" });
    const j = JSON.parse(r.text);
    expect(j.timelockedBackup.scheme).toMatch(/drand/);
    expect(j.calls[1].data.slice(138, 146)).toBe("54555450"); // "TUTP" marker after commit(uint256,bytes32)
  });
  test("prepare_reveal finds a sealed bid on chain and refuses to open it before commits close", async ({ request }) => {
    const r = await mcp(request, "prepare_reveal", { auction_id: 1, bidder: "0xd89f4f3b554db54d55395e437b365aa0ceb13194" });
    expect(r.text).toMatch(/too early|reveals are only accepted/i);
  });
  test("agent_reputation combines the registry and Quicknode's ERC-8004 API", async ({ request }) => {
    const j = JSON.parse((await mcp(request, "agent_reputation", {})).text);
    expect(j.registry).toBe("0x8004BAa17C55a88189AE136b182e5fdA19dE9b63");
    expect(j.quicknode.source).toMatch(/Quicknode/);
    expect((await mcp(request, "agent_reputation", { rate_auction_id: 0, rater: "0x000000000000000000000000000000000000dEaD" })).text).toMatch(/only bidders/);
  });
});

test.describe("API guards", () => {
  test("RPC proxy: foreign origin and writes are refused", async ({ request }) => {
    expect((await request.post("/api/rpc", { headers: { origin: "https://evil.example" }, data: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber" } })).status()).toBe(403);
    const w = await request.post("/api/rpc", { headers: { origin: "https://tutup.vercel.app" }, data: { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: ["0x00"] } });
    expect(await w.text()).toMatch(/read-only/);
  });
  test("keeper is cron-only", async ({ request }) => {
    expect((await request.get("/api/keeper")).status()).toBe(401);
  });
  test("Streams webhook refuses unsigned and wrongly signed deliveries", async ({ request }) => {
    expect((await request.post("/api/stream", { data: {} })).status()).toBe(401);
    const bad = await request.post("/api/stream", { data: {}, headers: { "x-qn-nonce": "n", "x-qn-timestamp": String(Math.floor(Date.now() / 1000)), "x-qn-signature": "0".repeat(64) } });
    expect(bad.status()).toBe(401);
  });
  test("Quicknode proxy pins the ERC-8004 agent to Tutup on Robinhood", async ({ request }) => {
    const r = await request.post("/api/qn", { headers: { origin: "https://tutup.vercel.app" }, data: { method: "erc8004_getAgent", params: [1, {}] } });
    const j = (await r.json()).result;
    expect(j.agent_id).toBe(25584);
    expect(j.network.slug).toBe("robinhood-mainnet");
  });
});
