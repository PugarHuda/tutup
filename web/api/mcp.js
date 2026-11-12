// Tutup as an MCP server (Streamable HTTP, JSON responses), so AI agents can read the market and bid in sealed
// auctions. The server never holds a key: prepare_* tools return unsigned calls for the agent's own wallet.
//   claude mcp add --transport http tutup https://tutup.vercel.app/api/mcp
import { createPublicClient, http, fallback, parseAbi, formatUnits, parseUnits, keccak256, encodeAbiParameters, encodeFunctionData, toHex, isAddress, getAddress } from "viem";
import { randomBytes } from "node:crypto";
import TOKENS from "../tokens.json" with { type: "json" };
import { quicknode } from "./qn.js";
import { pythPrices } from "./pyth.js";
import { sealReceipt, openReceipt, hasBackup } from "../tlock-backup.js";

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
  "event Committed(uint256 indexed id, address indexed bidder)",
  "event Settled(uint256 indexed id, uint256 clearingPrice, uint256 sold, uint256 proceeds, int256 refPrice, uint256 refUpdatedAt)",
]);
const erc20 = parseAbi(["function decimals() view returns (uint8)", "function approve(address, uint256) returns (bool)", "function allowance(address, address) view returns (uint256)"]);
const stock = parseAbi(["function uiMultiplier() view returns (uint256)", "function newUIMultiplier() view returns (uint256)", "function effectiveAt() view returns (uint256)", "function oraclePaused() view returns (bool)"]);
const REPUTATION = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63", AGENT_ID = 25584n;
const repAbi = parseAbi([
  "function getClients(uint256) view returns (address[])",
  "function getSummary(uint256, address[], string, string) view returns (uint64 count, int128 value, uint8 decimals)",
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
]);
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
const ZERO32 = "0x" + "0".repeat(64);
const commitHash = (id, bidder, qty, price, salt) => keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes32" }], [BigInt(id), bidder, qty, price, salt]));

/// Rebuild a lost receipt from the chain: the bidder's commit tx carries it, timelocked to commitEnd with drand.
/// Checked against commitOf, so a forged or stale backup can never produce a wrong reveal.
async function recoverReceipt(id, bidder) {
  const [log] = (await pub.getLogs({ address: TUTUP, event: abi.find((x) => x.name === "Committed"), args: { id: BigInt(id), bidder }, fromBlock: FROM_BLOCK })).slice(-1);
  if (!log) throw new Error(`no sealed bid from ${bidder} in auction ${id}`);
  const tx = await pub.getTransaction({ hash: log.transactionHash });
  if (!hasBackup(tx.input)) throw new Error("that bid was sealed without a timelocked backup, so only its receipt file can reveal it");
  const r = await openReceipt(tx.input);
  const onchain = await read("commitOf", [BigInt(id), bidder]);
  if (onchain === ZERO32) throw new Error("this bid is already revealed");
  if (commitHash(id, bidder, BigInt(r.qty), BigInt(r.price), r.salt) !== onchain) throw new Error("backup doesn't match the sealed commitment");
  return { tutup: TUTUP, chainId: 4663, auction: String(id), bidder, ...r, recoveredFrom: log.transactionHash };
}

async function feed(addr) {
  if (!addr) return null;
  const [, p, , at] = await pub.readContract({ address: addr, abi: feedAbi, functionName: "latestRoundData" });
  return { price: Number(p) / 1e8, ageHours: +((Date.now() / 1000 - Number(at)) / 3600).toFixed(2) };
}

// Check arguments against the tool's own inputSchema, so an agent gets "auction_id must be a non-negative
// integer" instead of a BigInt conversion error from deep inside the handler.
export function checkArgs(name, args = {}) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return `unknown tool: ${name}. Call tools/list.`;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "arguments must be an object";
  const { properties = {}, required = [] } = t.inputSchema;
  for (const k of required) if (args[k] === undefined || args[k] === null || args[k] === "") return `missing required argument: ${k}`;
  for (const [k, v] of Object.entries(args)) {
    const want = properties[k]?.type;
    if (!want) return `unknown argument: ${k} (expected ${Object.keys(properties).join(", ") || "none"})`;
    if (want === "number" && !(Number.isSafeInteger(Number(v)) && Number(v) >= 0 && String(v).trim() !== "")) return `${k} must be a non-negative integer`;
    if (want === "string" && typeof v !== "string") return `${k} must be a string`;
    if (want === "array" && !Array.isArray(v)) return `${k} must be an array`;
    if (want === "object" && (typeof v !== "object" || Array.isArray(v))) return `${k} must be an object`;
    if (want === "boolean" && typeof v !== "boolean") return `${k} must be true or false`;
  }
  return null;
}

const TOOLS = [
  { name: "list_auctions", description: "List Tutup sealed-bid auctions on Robinhood Chain, newest first, with phase and time left.", inputSchema: { type: "object", properties: { limit: { type: "number", description: "max results, default 20" } } } },
  { name: "get_auction", description: "One auction: lot, reserve, bond, minimum sold, phase, revealed bids once commits close, and the clearing result after settlement.", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  { name: "market_status", description: "Is the market behind a Stock Token open? Chainlink 24/5 and 24/7 feeds with their age, Quicknode's oracle health (US session, mint window), Lighter's last trade, the token's ERC-8056 multiplier, pending corporate action and oraclePaused().", inputSchema: { type: "object", properties: { symbol: { type: "string", description: "e.g. NVDA" } }, required: ["symbol"] } },
  { name: "weekend_prints", description: "Every sale's clearing price next to the Chainlink price at settlement, plus Chainlink-compatible feeds that serve those prints on chain.", inputSchema: { type: "object", properties: {} } },
  { name: "portfolio", description: "A wallet's Robinhood Stock Token holdings in shares (multipliers applied), valued in USD from Chainlink, via Quicknode's Stock Token API. Use it to see what an agent could list.", inputSchema: { type: "object", properties: { address: { type: "string" } }, required: ["address"] } },
  { name: "corporate_actions", description: "Split and dividend history for Stock Tokens (Quicknode Stock Token API, matched to Robinhood's records). Upcoming actions freeze the oracle: a moment when sealed auctions matter.", inputSchema: { type: "object", properties: { symbols: { type: "array", items: { type: "string" } } } } },
  { name: "tx_finality", description: "How final a Robinhood Chain transaction is: soft, posted to Ethereum, safe or finalized, with estimates (Quicknode Stock Token API). Use it on a settlement before treating it as done.", inputSchema: { type: "object", properties: { tx_hash: { type: "string" } }, required: ["tx_hash"] } },
  { name: "prepare_bid", description: "Seal a bid. Returns the salt, the commit hash, a receipt to keep (losing it means the bond burns), and the unsigned calls to send from `bidder`: approve the $WIF bond, then commit. The server never sees a key.", inputSchema: { type: "object", properties: { auction_id: { type: "number" }, bidder: { type: "string" }, quantity: { type: "string", description: "lot tokens, e.g. \"0.5\"" }, price: { type: "string", description: "quote tokens per lot token, e.g. \"160.5\"" }, backup: { type: "boolean", description: "timelock the receipt into the commit calldata (drand), default true" } }, required: ["auction_id", "bidder", "quantity", "price"] } },
  { name: "prepare_reveal", description: "Open a sealed bid during the reveal phase. Takes the receipt from prepare_bid, or just auction_id and bidder: the receipt is then decrypted from the commit's calldata (drand timelock, readable once commits close) and checked against the sealed hash. Returns the unsigned calls: approve the payment escrow, then reveal.", inputSchema: { type: "object", properties: { receipt: { type: "object" }, auction_id: { type: "number" }, bidder: { type: "string" } } } },
  { name: "agent_reputation", description: "Tutup's ERC-8004 reputation on Robinhood Chain: agent #25584's ratings from bidders in settled auctions (Reputation Registry), and, given a bidder who took part in a settled auction, the unsigned giveFeedback call to rate it.", inputSchema: { type: "object", properties: { rate_auction_id: { type: "number" }, rater: { type: "string" }, score: { type: "number", description: "0-100" } } } },
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
    const hash = commitHash(a.id, bidder, qty, price, salt);
    // unless the agent opts out, the receipt rides along in the commit calldata, timelocked to commitEnd
    const tail = args.backup === false ? "" : await sealReceipt({ qty, price, salt }, a.raw.commitEnd);
    return {
      receipt: { tutup: TUTUP, chainId: 4663, auction: String(a.id), bidder, qty: qty.toString(), price: price.toString(), salt },
      warning: tail ? "Keep the receipt. If it's lost, prepare_reveal with auction_id and bidder recovers it from the chain once commits close (drand timelock)." : "Store the receipt. Without it you can't reveal, and the bond burns.",
      timelockedBackup: tail ? { scheme: "tlock / drand quicknet", unlocksAt: a.commitEnd, bytes: tail.length / 2 } : null,
      revealWindow: { opens: a.commitEnd, closes: a.revealEnd },
      escrowAtReveal: `${formatUnits(cost(qty, price), a.raw.qd)} ${a.quote}`,
      calls: [
        call(WIF, encodeFunctionData({ abi: erc20, functionName: "approve", args: [TUTUP, a.raw.bond] }), `approve ${a.bondWif} WIF bond`),
        call(TUTUP, encodeFunctionData({ abi, functionName: "commit", args: [BigInt(a.id), hash] }) + tail, tail ? "commit the sealed bid (receipt timelocked in calldata)" : "commit the sealed bid"),
      ],
    };
  }
  if (name === "prepare_reveal") {
    if (!args.receipt && !(args.auction_id !== undefined && isAddress(args.bidder || ""))) throw new Error("pass receipt, or auction_id and bidder to recover it from the chain");
    const r = args.receipt || await recoverReceipt(args.auction_id, getAddress(args.bidder));
    if (String(r.tutup).toLowerCase() !== TUTUP.toLowerCase() || !isAddress(r.bidder) || !/^0x[0-9a-f]{64}$/i.test(r.salt) || !/^\d+$/.test(r.qty) || !/^\d+$/.test(r.price)) throw new Error("not a Tutup receipt for this contract");
    const a = await auction(r.auction);
    if (a.phase !== "reveal") throw new Error(`auction ${a.id} is in ${a.phase}; reveals are only accepted during reveal`);
    const qty = BigInt(r.qty), price = BigInt(r.price);
    return {
      ...(r.recoveredFrom ? { recoveredReceipt: r } : {}),
      escrow: `${formatUnits(cost(qty, price), a.raw.qd)} ${a.quote}`,
      calls: [
        call(a.raw.quote, encodeFunctionData({ abi: erc20, functionName: "approve", args: [TUTUP, cost(qty, price)] }), `approve the ${a.quote} escrow`),
        call(TUTUP, encodeFunctionData({ abi, functionName: "reveal", args: [BigInt(a.id), qty, price, r.salt] }), "reveal; the bond comes back"),
      ],
    };
  }
  if (name === "agent_reputation") {
    const clients = await pub.readContract({ address: REPUTATION, abi: repAbi, functionName: "getClients", args: [AGENT_ID] });
    const [count, value, d] = clients.length ? await pub.readContract({ address: REPUTATION, abi: repAbi, functionName: "getSummary", args: [AGENT_ID, clients, "tutup-auction", ""] }) : [0n, 0n, 0];
    const out = { agent: "eip155:4663:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432#25584", registry: REPUTATION, ratings: Number(count), average: count ? Number(value) / 10 ** d : null, raters: clients.length };
    if (args.rate_auction_id === undefined) return out;
    if (!isAddress(args.rater || "")) throw new Error("rater must be an address");
    const score = Number(args.score ?? 100);
    if (!(score >= 0 && score <= 100)) throw new Error("score must be 0-100");
    const a = await auction(args.rate_auction_id);
    if (a.phase !== "settled") throw new Error(`auction ${a.id} isn't settled yet`);
    if (!(await read("bids", [BigInt(a.id)])).some((b) => b.bidder.toLowerCase() === args.rater.toLowerCase())) throw new Error("only bidders who revealed in that auction can rate it");
    return { ...out, calls: [call(REPUTATION, encodeFunctionData({ abi: repAbi, functionName: "giveFeedback", args: [AGENT_ID, BigInt(score), 0, "tutup-auction", `auction-${a.id}`, "https://tutup.vercel.app/api/mcp", `https://tutup.vercel.app/app.html#a/${a.id}`, keccak256(toHex(`${TUTUP}:${a.id}`))] }), `rate Tutup ${score}/100 for auction ${a.id}`)] };
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
        instructions: "Tutup runs sealed-bid batch auctions for Robinhood Chain Stock Tokens and $WIF while the market is closed. Read with list_auctions / get_auction / market_status / weekend_prints. To bid: prepare_bid during commit (the receipt is also timelocked into the commit calldata with drand), then prepare_reveal during reveal, with the receipt or just auction_id and bidder. Every prepare_* tool returns unsigned calls for your own wallet." });
    }
    if (msg.method === "ping") return reply({});
    if (msg.method === "tools/list") return reply({ tools: TOOLS });
    if (msg.method === "tools/call") {
      try {
        const bad = checkArgs(msg.params?.name, msg.params?.arguments);
        if (bad) return reply({ content: [{ type: "text", text: bad }], isError: true });
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
