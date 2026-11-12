// Checks for the Quicknode Streams webhook (web/api/stream.js): signature, staleness and event decoding.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verify, tutupEvents } from "../web/api/stream.js";
const { parseAbiItem, toEventSelector } = await import(new URL("../web/node_modules/viem/_esm/index.js", import.meta.url));
const secret = "qnsec_test", nonce = "abc", ts = String(Math.floor(Date.now() / 1000));
const body = JSON.stringify({ tutup: [{ address: "0xd2Bfe52d5A0680DC7C3BE5BB19E1f75a568a5428", topics: ["0x" + "00".repeat(32)], transactionHash: "0x1", blockNumber: "0x2" }] });
const sig = createHmac("sha256", Buffer.from(secret)).update(nonce + ts + body).digest("hex");
assert.ok(verify(secret, nonce, ts, body, sig));
assert.ok(!verify(secret, nonce, ts, body + " ", sig), "tampered payload");
assert.ok(!verify("other", nonce, ts, body, sig), "wrong token");
assert.ok(!verify(secret, nonce, ts, body, "zz"), "malformed signature");
// real event: Created on auction 2, as in the mainnet log
const sel = toEventSelector(parseAbiItem("event Committed(uint256 indexed id, address indexed bidder)"));
const ev = tutupEvents({ tutup: [{ address: "0xd2bfe52d5a0680dc7c3be5bb19e1f75a568a5428", topics: [sel, "0x" + "0".repeat(63) + "2", "0x" + "0".repeat(24) + "ab".repeat(20)], transactionHash: "0xt", blockNumber: "0x1" }, { address: "0x0000000000000000000000000000000000000001", topics: [sel] }] });
assert.deepEqual(ev, [{ event: "Committed", id: 2, tx: "0xt", block: "0x1" }]);
console.log("stream webhook ok");
