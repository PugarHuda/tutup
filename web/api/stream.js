// Quicknode Streams webhook. A stream on Robinhood Chain mainnet filters every block's logs down to the Tutup
// contract (filter in scripts/qn-stream-filter.js) and posts them here. Each delivery is checked against the stream's
// security token: HMAC-SHA256 over nonce + timestamp + payload (X-QN-Nonce / X-QN-Timestamp / X-QN-Signature).
// A new listing wakes the keeper agent at once, so it can bid in the same minute instead of at the next cron run.
import { createHmac, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { parseAbi, toEventSelector } from "viem";
import { runKeeper } from "./keeper.js";

const TUTUP = "0xd2bfe52d5a0680dc7c3be5bb19e1f75a568a5428";
const EVENTS = parseAbi([
  "event Created(uint256 indexed id, address indexed seller, address lot, address quote, uint256 lotAmount, uint256 reserve, uint256 bond, uint256 minSold, uint64 commitEnd, uint64 revealEnd, address feed)",
  "event Cancelled(uint256 indexed id)",
  "event Committed(uint256 indexed id, address indexed bidder)",
  "event Revealed(uint256 indexed id, address indexed bidder, uint256 qty, uint256 price)",
  "event Settled(uint256 indexed id, uint256 clearingPrice, uint256 sold, uint256 proceeds, int256 refPrice, uint256 refUpdatedAt)",
  "event Burned(uint256 indexed id, uint256 amount, string reason)",
]);
const NAME = Object.fromEntries(EVENTS.map((e) => [toEventSelector(e), e.name]));
const WAKE = new Set(["Created"]); // events the keeper acts on right away
const MAX_AGE_S = 300;

/// Is this delivery from our stream? Exported for the check in scripts/stream-test.mjs.
export function verify(secret, nonce, timestamp, payload, signature) {
  if (!secret || !nonce || !timestamp || !/^[0-9a-f]{64}$/i.test(signature || "")) return false;
  const want = createHmac("sha256", Buffer.from(secret)).update(nonce + timestamp + payload).digest();
  return timingSafeEqual(want, Buffer.from(signature, "hex"));
}

/// The Tutup events in a delivery, named. Works on the filter's output or on raw log arrays.
export function tutupEvents(body) {
  const logs = (Array.isArray(body?.tutup) ? body.tutup : [body?.data ?? body].flat(3)).filter(Boolean);
  return logs
    .filter((l) => String(l.address || TUTUP).toLowerCase() === TUTUP && l.topics?.[0])
    .map((l) => ({ event: NAME[l.topics[0]] || "other", id: l.topics[1] ? Number(BigInt(l.topics[1])) : null, tx: l.transactionHash, block: l.blockNumber }));
}

const readRaw = (req) => new Promise((ok, fail) => {
  const parts = [];
  req.on("data", (c) => parts.push(c)).on("end", () => ok(Buffer.concat(parts))).on("error", fail);
});

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.QN_STREAM_TOKEN) return res.status(200).json({ configured: false });
  let raw = await readRaw(req);
  if (/gzip/i.test(req.headers["content-encoding"] || "")) raw = gunzipSync(raw);
  const payload = raw.toString("utf8");
  const nonce = req.headers["x-qn-nonce"], ts = req.headers["x-qn-timestamp"], sig = req.headers["x-qn-signature"];
  if (!verify(process.env.QN_STREAM_TOKEN, nonce, ts, payload, sig)) return res.status(401).json({ error: "bad signature" });
  const sec = Number(ts) > 1e12 ? Number(ts) / 1000 : Number(ts); // seconds or milliseconds
  if (!(Math.abs(Date.now() / 1000 - sec) <= MAX_AGE_S)) return res.status(401).json({ error: "stale delivery" });
  const events = tutupEvents(JSON.parse(payload || "null"));
  console.log("stream", JSON.stringify(events));
  const wake = events.some((e) => WAKE.has(e.event)) && process.env.KEEPER_KEY;
  return res.status(200).json({ received: events.length, events, keeper: wake ? await runKeeper() : null });
}
