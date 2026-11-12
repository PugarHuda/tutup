// Tutup as an MCP server (Streamable HTTP, JSON responses), so AI agents can read the market and bid in sealed
// auctions. The server never holds a key: prepare_* tools return unsigned calls for the agent's own wallet.
//   claude mcp add --transport http tutup https://tutup.vercel.app/api/mcp
import { createPublicClient, http, fallback, parseAbi, formatUnits, parseUnits, keccak256, encodeAbiParameters, encodeFunctionData, toHex, isAddress, getAddress } from "viem";
import { randomBytes } from "node:crypto";
import TOKENS from "../tokens.json" with { type: "json" };
import { quicknode } from "./qn.js";
import { pythPrices } from "./pyth.js";

// MCP_TEST_RPC / MCP_TEST_TUTUP only exist for the local fork test (scripts/mcp-fork-test.mjs); Vercel never sets them
const TUTUP = process.env.MCP_TEST_TUTUP || "0xd2Bfe52d5A0680DC7C3BE5BB19E1f75a568a5428";
const FROM_BLOCK = process.env.MCP_TEST_TUTUP ? BigInt(process.env.MCP_TEST_FROM || 0) : 112356368n;
const FEED = { "WIF/WETH": "0xDe80aC53aBB6bB595Ea4D023f4B826F7F4C269dE" };
const WIF = "0x5173b8eA6923c2d40267890D45C46a3480954773";
const BASE = [
  { sym: "WIF", addr: WIF },
  { sym: "USDG", addr: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" },
  { sym: "WETH", addr: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" },
];
const ALL = [...BASE, ...TOKENS];
const chain = { id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } };
const pub = createPublicClient({
  chain,
  transport: process.env.MCP_TEST_RPC ? http(process.env.MCP_TEST_RPC) : fallback([...(process.env.QUICKNODE_RPC ? [http(process.env.QUICKNODE_RPC, { batch: true })] : []), http("https://rpc.mainnet.chain.robinhood.com", { batch: true }), ...(process.env.GETBLOCK_RPC ? [http(process.env.GETBLOCK_RPC, { batch: true })] : [])]),
});

const abi = parseAbi([
  "function auctionCount() view returns (uint256)",
  "function totalBurned() view returns (uint256)",
  "function auctions(uint256) view returns (address seller, address lot, address quote, address feed, uint128 lotAmount, uint128 reserve, uint128 bond, uint128 minSold, uint64 commitEnd, uint64 revealEnd, uint32 commits, uint32 reveals, bool settled)",
  "function bids(uint256) view returns ((address bidder, uint128 qty, uint128 price)[])",
  "function commitOf(uint256, address) view returns (bytes32)",
  "function lastPrint(address, address) view returns (uint128 price, uint128 sold, uint64 at, uint64 auctionId)",
  "function commit(uint256 id, bytes32 hash)",
  "function reveal(uint256 id, uint128 qty, uint128 price, bytes32 salt)",
  "function settle(uint256 id)",
  "event Settled(uint256 indexed id, uint256 clearingPrice, uint256 sold, uint256 proceeds, int256 refPrice, uint256 refUpdatedAt)",
]);
const erc20 = parseAbi(["function decimals() view returns (uint8)", "function approve(address, uint256) returns (bool)", "function allowance(address, address) view returns (uint256)"]);
const stock = parseAbi(["function uiMultiplier() view returns (uint256)", "function newUIMultiplier() view returns (uint256)", "function effectiveAt() view returns (uint256)", "function oraclePaused() view returns (bool)"]);
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);

const sym = (a) => ALL.find((t) => t.addr.toLowerCase() === a.toLowerCase())?.sym || a;
const dec = {};
const decimals = async (a) => (dec[a] ??= await pub.readContract({ address: a, abi: erc20, functionName: "decimals" }));
const read = (functionName, args = []) => pub.readContract({ address: TUTUP, abi, functionName, args });
const cost = (q, p) => (q * p + 10n ** 18n - 1n) / 10n ** 18n;

async function auction(id) {
  const [seller, lot, quote, , lotAmount, reserve, bond, minSold, commitEnd, revealEnd, commits, reveals, settled] = await read("auctions", [BigInt(id)]);
  if (lotAmount === 0n) throw new Error(`auction ${id} doesn't exist`);
  const now = (await pub.getBlock()).timestamp;
  const qd = await decimals(quote);
  const phase = settled ? "settled" : now < commitEnd ? "commit" : now < revealEnd ? "reveal" : "settle";
  return {
    id: Number(id), phase, seller, lot: sym(lot), lotAddress: lot, quote: sym(quote), quoteAddress: quote, quoteDecimals: qd,
    lotAmount: formatUnits(lotAmount, 18), reserve: formatUnits(reserve, qd), bondWif: formatUnits(bond, 18), minSold: formatUnits(minSold, 18),
    commitEnd: new Date(Number(commitEnd) * 1000).toISOString(), revealEnd: new Date(Number(revealEnd) * 1000).toISOString(),
    secondsLeftInPhase: phase === "commit" ? Number(commitEnd - now) : phase === "reveal" ? Number(revealEnd - now) : 0,
    sealedBids: commits, revealed: reveals, raw: { lotAmount, reserve, bond, commitEnd, revealEnd, lot, quote, qd },
  };
}
const pub_ = ({ raw, ...a }) => a;

async function feed(addr) {
  if (!addr) return null;
  const [, p, , at] = await pub.readContract({ address: addr, abi: feedAbi, functionName: "latestRoundData" });
  return { price: Number(p) / 1e8, ageHours: +((Date.now() / 1000 - Number(at)) / 3600).toFixed(2) };
}

const TOOLS = [
  { name: "list_auctions", description: "List Tutup sealed-bid auctions on Robinhood Chain, newest first, with phase and time left.", inputSchema: { type: "object", properties: { limit: { type: "number", description: "max results, default 20" } } } },
  { name: "get_auction", description: "One auction: lot, reserve, bond, minimum sold, phase, revealed bids once commits close, and the clearing result after settlement.", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "market_status", description: "Is the market behind a Stock Token open? Chainlink 24/5 and 24/7 feeds with their age, Quicknode's oracle health (US session, mint window), Lighter's last trade, the token's ERC-8056 multiplier, pending corporate action and oraclePaused().", inputSchema: { type: "object", properties: { symbol: { type: "string", description: "e.g. NVDA" } }, required: ["symbol"] } },
  { name: "weekend_prints", description: "Every sale's clearing price next to the Chainlink price at settlement, plus Chainlink-compatible feeds that serve those prints on chain.", inputSchema: { type: "object", properties: {} } },
  { name: "portfolio", description: "A wallet's Robinhood Stock Token holdings in shares (multipliers applied), valued in USD from Chainlink, via Quicknode's Stock Token API. Use it to see what an agent could list.", inputSchema: { type: "object", properties: { address: { type: "string" } }, required: ["address"] } },
  { name: "corporate_actions", description: "Split and dividend history for Stock Tokens (Quicknode Stock Token API, matched to Robinhood's records). Upcoming actions freeze the oracle: a moment when sealed auctions matter.", inputSchema: { type: "object", properties: { symbols: { type: "array", items: { type: "string" } } } } },
  { name: "tx_finality", description: "How final a Robinhood Chain transaction is: soft, posted to Ethereum, safe or finalized, with estimates (Quicknode Stock Token API). Use it on a settlement before treating it as done.", inputSchema: { type: "object", properties: { tx_hash: { type: "string" } }, required: ["tx_hash"] } },
  { name: "prepare_bid", description: "Seal a bid. Returns the salt, the commit hash, a receipt to keep (losing it means the bond burns), and the unsigned calls to send from `bidder`: approve the $WIF bond, then commit. The server never sees a key.", inputSchema: { type: "object", properties: { auction_id: { type: "number" }, bidder: { type: "string" }, quantity: { type: "string", description: "lot tokens, e.g. \"0.5\"" }, price: { type: "string", description: "quote tokens per lot token, e.g. \"160.5\"" } }, required: ["auction_id", "bidder", "quantity", "price"] } },
  { name: "prepare_reveal", description: "Open a sealed bid during the reveal phase. Takes the receipt from prepare_bid and returns the unsigned calls: approve the payment escrow, then reveal.", inputSchema: { type: "object", properties: { receipt: { type: "object" } }, required: ["receipt"] } },
  { name: "prepare_settle", description: "Anyone can settle once reveals close. Returns the unsigned settle call.", inputSchema: { type: "object", properties: { auction_id: { type: "number" } }, required: ["auction_id"] } },
];

const call = (to, data, note) => ({ chainId: 4663, to, data, value: "0", note });

async function run(name, args = {}) {
  if (name === "list_auctions") {
    const n = Number(await read("auctionCount"));
    const ids = [...Array(n).keys()].reverse().slice(0, Math.min(Number(args.limit) || 20, 50));
    return { contract: TUTUP, totalBurnedWif: formatUnits(await read("totalBurned"), 18), auctions: (await Promise.all(ids.map(auction))).map(pub_) };
  }
  if (name === "get_auction") {
    const a = await auction(args.id);
    const out = pub_(a);
    if (a.phase !== "commit") {
      out.bids = (await read("bids", [BigInt(args.id)])).map((b) => ({ bidder: b.bidder, quantity: formatUnits(b.qty, 18), price: formatUnits(b.price, a.raw.qd) }));
    }
    const s = (await pub.getContractEvents({ address: TUTUP, abi, eventName: "Settled", args: { id: BigInt(args.id) }, fromBlock: FROM_BLOCK }))[0]?.args;
    if (s) out.result = { clearingPrice: formatUnits(s.clearingPrice, a.raw.qd), sold: formatUnits(s.sold, 18), proceeds: formatUnits(s.proceeds, a.raw.qd), chainlinkAtSettle: s.refPrice > 0n ? Number(s.refPrice) / 1e8 : null };
    return out;
  }
  if (name === "portfolio") {
    if (!isAddress(args.address)) throw new Error("address must be an address");
    return quicknode("qn_getStockTokenBalances", [getAddress(args.address)]);
  }
  if (name === "corporate_actions") {
    return quicknode("qn_getCorporateActions", [args.symbols?.length ? { symbols: args.symbols.map((x) => String(x).toUpperCase()) } : {}]);
  }
  if (name === "tx_finality") {
    if (!/^0x[0-9a-fA-F]{64}$/.test(args.tx_hash || "")) throw new Error("tx_hash must be 0x + 64 hex");
    return quicknode("qn_getTransactionFinality", [args.tx_hash]);
  }
  if (name === "market_status") {
    const t = TOKENS.find((x) => x.sym === String(args.symbol || "").toUpperCase());
    if (!t) throw new Error(`unknown Stock Token ${args.symbol}`);
    const r = (fn) => pub.readContract({ address: t.addr, abi: stock, functionName: fn }).catch(() => null);
    const [f5, f7, mult, next, at, paused] = await Promise.all([feed(t.f5).catch(() => null), feed(t.f7).catch(() => null), r("uiMultiplier"), r("newUIMultiplier"), r("effectiveAt"), r("oraclePaused")]);
    let lighter = null;
    try {
      const books = (await (await fetch("https://api.rh.lighter.xyz/api/v1/orderBooks")).json()).order_books || [];
      const m = books.find((o) => o.market_type === "spot" && o.symbol === `${t.sym}/USDG`);
      if (m) {
        const d = (await (await fetch(`https://api.rh.lighter.xyz/api/v1/orderBookDetails?market_id=${m.market_id}`)).json());
        lighter = { lastTrade: Number((d.spot_order_book_details || d.order_book_details || [])[0]?.last_trade_price) || null };
      }
    } catch {}
    const health = await quicknode("qn_getOracleHealth", [{ symbols: [t.sym] }]).catch(() => null);
    const qf = health?.feeds?.find((x) => x.symbol === t.sym);
    const pyth = await pythPrices(t.sym).catch(() => null);
    // Quicknode's status says whether the feed is within its heartbeat (OK) or STALE/PAUSED; the age check says
    // whether the price is still moving. Either one failing means the official price can't be trusted right now.
    const frozen = !f5 || f5.ageHours > 2 || paused === true || (qf && qf.status !== "OK");
    return { symbol: t.sym, name: t.name, token: t.addr, officialFeed24x5: f5, feed24x7: f7, lighter, erc8056Multiplier: mult ? Number(mult) / 1e18 : null,
      pendingCorporateAction: mult && next && next !== mult && Number(at) > Date.now() / 1000 ? { newMultiplier: Number(next) / 1e18, effectiveAt: new Date(Number(at) * 1000).toISOString() } : null,
      pyth: pyth?.configured ? { session: pyth.us, feed24x7: pyth.d247 } : "Pyth Pro key not configured", oraclePaused: paused, officialPriceFrozen: frozen,
      quicknodeOracleHealth: health ? { feedStatus: qf?.status, session: health.session, sequencer: health.sequencer?.operatorStatus?.status || health.sequencer?.status } : "Quicknode endpoint not configured", hint: frozen ? "The official feed is frozen: a sealed auction is the fair way to trade this now." : "The official feed is live." };
  }
  if (name === "weekend_prints") {
    const logs = await pub.getContractEvents({ address: TUTUP, abi, eventName: "Settled", fromBlock: FROM_BLOCK });
    const prints = await Promise.all(logs.filter((l) => l.args.sold > 0n).map(async (l) => {
      const a = await auction(l.args.id);
      return { auction: Number(l.args.id), lot: a.lot, quote: a.quote, clearingPrice: formatUnits(l.args.clearingPrice, a.raw.qd), sold: formatUnits(l.args.sold, 18), chainlinkAtSettle: l.args.refPrice > 0n ? Number(l.args.refPrice) / 1e8 : null };
    }));
    return { prints, chainlinkCompatibleFeeds: FEED, howToRead: "lastPrint(lot, quote) on the Tutup contract, or latestRoundData() on a feed above (8 decimals)." };
  }
  if (name === "prepare_bid") {
    if (!isAddress(args.bidder)) throw new Error("bidder must be an address");
    const bidder = getAddress(args.bidder);
    const a = await auction(args.auction_id);
    if (a.phase !== "commit") throw new Error(`auction ${a.id} is in ${a.phase}; bids can only be sealed during commit`);
    if (bidder.toLowerCase() === a.seller.toLowerCase()) throw new Error("the seller can't bid in their own auction");
    if ((await read("commitOf", [BigInt(a.id), bidder])) !== "0x0000000000000000000000000000000000000000000000000000000000000000") throw new Error("this bidder already sealed a bid here");
    const qty = parseUnits(String(args.quantity), 18), price = parseUnits(String(args.price), a.raw.qd);
    if (qty === 0n || qty > a.raw.lotAmount) throw new Error(`quantity must be between 0 and ${a.lotAmount}`);
    if (price < a.raw.reserve) throw new Error(`price is below the reserve ${a.reserve} ${a.quote}; the reveal would be refused`);
    const salt = toHex(randomBytes(32));
    const hash = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes32" }], [BigInt(a.id), bidder, qty, price, salt]));
    return {
      receipt: { tutup: TUTUP, chainId: 4663, auction: String(a.id), bidder, qty: qty.toString(), price: price.toString(), salt },
      warning: "Store the receipt. Without it you can't reveal, and the bond burns.",
      revealWindow: { opens: a.commitEnd, closes: a.revealEnd },
      escrowAtReveal: `${formatUnits(cost(qty, price), a.raw.qd)} ${a.quote}`,
      calls: [
        call(WIF, encodeFunctionData({ abi: erc20, functionName: "approve", args: [TUTUP, a.raw.bond] }), `approve ${a.bondWif} WIF bond`),
        call(TUTUP, encodeFunctionData({ abi, functionName: "commit", args: [BigInt(a.id), hash] }), "commit the sealed bid"),
      ],
    };
  }
  if (name === "prepare_reveal") {
    const r = args.receipt || {};
    if (String(r.tutup).toLowerCase() !== TUTUP.toLowerCase() || !isAddress(r.bidder) || !/^0x[0-9a-f]{64}$/i.test(r.salt) || !/^\d+$/.test(r.qty) || !/^\d+$/.test(r.price)) throw new Error("not a Tutup receipt for this contract");
    const a = await auction(r.auction);
    if (a.phase !== "reveal") throw new Error(`auction ${a.id} is in ${a.phase}; reveals are only accepted during reveal`);
    const qty = BigInt(r.qty), price = BigInt(r.price);
    return {
      escrow: `${formatUnits(cost(qty, price), a.raw.qd)} ${a.quote}`,
      calls: [
        call(a.raw.quote, encodeFunctionData({ abi: erc20, functionName: "approve", args: [TUTUP, cost(qty, price)] }), `approve the ${a.quote} escrow`),
        call(TUTUP, encodeFunctionData({ abi, functionName: "reveal", args: [BigInt(a.id), qty, price, r.salt] }), "reveal; the bond comes back"),
      ],
    };
  }
  if (name === "prepare_settle") {
    const a = await auction(args.auction_id);
    if (a.phase !== "settle") throw new Error(`auction ${a.id} is in ${a.phase}; settle opens after reveals close`);
    return { calls: [call(TUTUP, encodeFunctionData({ abi, functionName: "settle", args: [BigInt(a.id)] }), "settle; anyone can send this")] };
  }
  throw new Error(`unknown tool ${name}`);
}

const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);

export default async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, mcp-session-id, mcp-protocol-version");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(405).json({ error: "POST JSON-RPC to this endpoint (MCP Streamable HTTP)" });
  const msg = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const reply = (result) => res.status(200).json({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => res.status(200).json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined) return res.status(202).end(); // notifications
  try {
    if (msg.method === "initialize") {
      return reply({ protocolVersion: msg.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "tutup", version: "1.0.0", erc8004: "eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432#25584" },
        instructions: "Tutup runs sealed-bid batch auctions for Robinhood Chain Stock Tokens and $WIF while the market is closed. Read with list_auctions / get_auction / market_status / weekend_prints. To bid: prepare_bid during commit, keep the receipt, prepare_reveal during reveal. Every prepare_* tool returns unsigned calls for your own wallet." });
    }
    if (msg.method === "ping") return reply({});
    if (msg.method === "tools/list") return reply({ tools: TOOLS });
    if (msg.method === "tools/call") {
      try {
        const out = await run(msg.params?.name, msg.params?.arguments);
        return reply({ content: [{ type: "text", text: json(out) }] });
      } catch (e) {
        return reply({ content: [{ type: "text", text: e.shortMessage || e.message }], isError: true });
      }
    }
    return fail(-32601, `method not found: ${msg.method}`);
  } catch (e) {
    return fail(-32603, e.message);
  }
}
