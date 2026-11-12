// The keeper agent on an anvil fork of Robinhood Chain: it bids by its public rule, reveals with a salt it
// re-derives (nothing stored), and settles. usage: KEEPER_TEST_RPC=… KEEPER_TEST_TUTUP=0x… KEEPER_KEY=0x… node scripts/keeper-fork-test.mjs <id>
import assert from "node:assert/strict";
const { runKeeper, mayBid } = await import(new URL("../web/api/keeper.js", import.meta.url));
const RPC = process.env.KEEPER_TEST_RPC, id = Number(process.argv[2]);
let n = 0;
const node = async (method, params = []) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) })).json()).result;
const warp = async (s) => { await node("evm_increaseTime", [s]); await node("evm_mine"); };
const pick = (r) => r.actions.find((a) => a.id === id);

// the bidding rule refuses hostile listings: a stranger's lot, a reveal window the cron could miss, an oversized bond
const house = { seller: "0x87252ce2342f89bDD97517d0E34d38A6B0148872", commitEnd: 0n, revealEnd: 17n * 3600n, bond: 50n * 10n ** 18n };
assert.ok(mayBid(house));
assert.ok(!mayBid({ ...house, seller: "0x000000000000000000000000000000000000dEaD" }));
assert.ok(!mayBid({ ...house, revealEnd: 300n }));
assert.ok(!mayBid({ ...house, bond: 51n * 10n ** 18n }));
// usage: list the fork auction as the house seller (anvil_impersonateAccount) with a reveal window of at least 17h
const r1 = await runKeeper();
console.log("run 1 (commit phase):", pick(r1));
assert.ok(pick(r1)?.committed, "agent sealed a bid");
assert.equal(pick((await runKeeper()))?.committed, undefined, "never bids twice");
await warp(Number(process.env.COMMIT_SECONDS || 301));
const r2 = await runKeeper();
console.log("run 2 (reveal phase):", pick(r2));
assert.ok(pick(r2)?.revealed, "agent revealed with its derived salt");
await warp(17 * 3600 + 1);
const r3 = await runKeeper();
console.log("run 3 (after reveals):", pick(r3));
assert.ok(pick(r3)?.settled, "agent settled");
console.log("keeper agent: ok");
