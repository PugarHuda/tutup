// Tutup's keeper agent, run by Vercel Cron (vercel.json). With its own small wallet (KEEPER_KEY) it:
//   1. bids in open auctions it can afford, by a public rule: the whole lot at the reserve + 5%;
//   2. reveals its own bids once reveals open. The salt is derived from its key and the auction id
//      (keccak256(key, tutup, id)), so it is never stored anywhere and can never be lost: no forgotten reveal;
//   3. settles every auction whose reveal window has closed (settle is permissionless);
//   4. lists for market makers: at the Friday US close, and whenever a Stock Token it holds reports
//      oraclePaused() (a corporate action), it lists one lot priced off Tutup's own last clearing price.
// It's labelled as Tutup's own agent in the UI, not as outside demand. CRON_SECRET-gated; KEEPER_TEST_* only
// exist for the anvil-fork test (scripts/keeper-fork-test.mjs).
import { createPublicClient, createWalletClient, http, fallback, parseAbi, keccak256, encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { openReceipt } from "../tlock-backup.js";

const TUTUP = process.env.KEEPER_TEST_TUTUP || "0xd2Bfe52d5A0680DC7C3BE5BB19E1f75a568a5428";
const WIF = "0x5173b8eA6923c2d40267890D45C46a3480954773";
const chain = { id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } };
const abi = parseAbi([
  "function auctionCount() view returns (uint256)",
  "function auctions(uint256) view returns (address seller, address lot, address quote, address feed, uint128 lotAmount, uint128 reserve, uint128 bond, uint128 minSold, uint64 commitEnd, uint64 revealEnd, uint32 commits, uint32 reveals, bool settled)",
  "function commitOf(uint256, address) view returns (bytes32)",
  "function commitHash(uint256 id, address bidder, uint128 qty, uint128 price, bytes32 salt) pure returns (bytes32)",
  "function commit(uint256 id, bytes32 hash)",
  "function reveal(uint256 id, uint128 qty, uint128 price, bytes32 salt)",
  "function settle(uint256 id)",
  "event Committed(uint256 indexed id, address indexed bidder)",
  "function create(address lot, address quote, uint128 lotAmount, uint128 reserve, uint128 bond, uint128 minSold, uint64 commitDuration, uint64 revealDuration, address feed) returns (uint256)",
  "function listFee() view returns (uint256)",
]);
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)", "function oraclePaused() view returns (bool)"]);
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
// lots the agent may list, each with the TutupFeed that prices it in WETH (8 decimals) from Tutup's last clearing price
export const LOTS = [
  { lot: WIF, feed: "0xDe80aC53aBB6bB595Ea4D023f4B826F7F4C269dE", friday: 20n * 10n ** 18n }, // 20 WIF every Friday close
  { lot: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", feed: "0x1Db46a08C722A9ac57bd6aa5d07cbb9c5ec5C3f7", stock: true }, // NVDA, on a corporate action
];
// Friday from 20:00 UTC (the 20:00 cron) through Saturday: the US close, when official feeds go quiet
export const fridayClose = (ts) => { const d = new Date(Number(ts) * 1000); return (d.getUTCDay() === 5 && d.getUTCHours() >= 20) || d.getUTCDay() === 6; };
// reserve 10% under the last clearing price; 8-decimal WETH price per whole token -> 18-decimal WETH
export const reserveFrom = (answer) => (BigInt(answer) * 10n ** 10n * 90n) / 100n;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address, address) view returns (uint256)", "function approve(address, uint256) returns (bool)"]);
// Tutup is permissionless, so anyone can list a lot with an inflated reserve, a huge bond or a 5-minute reveal
// window. The agent only bids on the house's own listings, and only when the reveal window outlasts the longest
// gap between two cron runs (20:00 -> 12:15 next day = 16h15m), so it can never miss its own reveal.
const HOUSE_SELLERS = new Set(["0x87252ce2342f89bdd97517d0e34d38a6b0148872"]);
const MIN_REVEAL_WINDOW = 17n * 3600n;
const MAX_BOND = 50n * 10n ** 18n;
export const mayBid = (a) => HOUSE_SELLERS.has(a.seller.toLowerCase()) && a.revealEnd - a.commitEnd >= MIN_REVEAL_WINDOW && a.bond <= MAX_BOND;
const cost = (q, p) => (q * p + 10n ** 18n - 1n) / 10n ** 18n;

/// The agent's public bidding rule: the whole lot, 5% over the reserve.
export const bidFor = (a) => ({ qty: a.lotAmount, price: (a.reserve * 105n) / 100n });

export async function runKeeper() {
  const transport = process.env.KEEPER_TEST_RPC ? http(process.env.KEEPER_TEST_RPC)
    : fallback([...(process.env.QUICKNODE_RPC ? [http(process.env.QUICKNODE_RPC)] : []), http("https://rpc.mainnet.chain.robinhood.com"), ...(process.env.GETBLOCK_RPC ? [http(process.env.GETBLOCK_RPC)] : [])]);
  const pub = createPublicClient({ chain, transport });
  const account = privateKeyToAccount(process.env.KEEPER_KEY);
  const wallet = createWalletClient({ chain, transport, account });
  const me = account.address;
  const salt = (id) => keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "uint256" }], [process.env.KEEPER_KEY, TUTUP, id]));
  const send = async (address, a, functionName, args) => {
    const hash = await wallet.writeContract({ address, abi: a, functionName, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted`);
    return hash;
  };
  const allow = async (token, amount) => {
    if ((await pub.readContract({ address: token, abi: erc20, functionName: "allowance", args: [me, TUTUP] })) < amount) {
      await send(token, erc20, "approve", [TUTUP, amount]);
    }
  };

  const now = (await pub.getBlock()).timestamp;
  const n = Number(await pub.readContract({ address: TUTUP, abi, functionName: "auctionCount" }));
  const log = [];
  const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";
  const all = await Promise.all([...Array(n).keys()].map(async (i) => {
    const id = BigInt(i);
    const [seller, , quote, , lotAmount, reserve, bond, , commitEnd, revealEnd, , , settled] = await pub.readContract({ address: TUTUP, abi, functionName: "auctions", args: [id] });
    const sealed = !settled && (await pub.readContract({ address: TUTUP, abi, functionName: "commitOf", args: [id, me] })) !== ZERO;
    return { i, id, seller, quote, bond, commitEnd, revealEnd, settled, sealed, ...bidFor({ lotAmount, reserve }) };
  }));
  // escrow already promised to sealed bids that still have to be revealed, per quote token
  const promised = {};
  for (const a of all) if (a.sealed && now < a.revealEnd) promised[a.quote.toLowerCase()] = (promised[a.quote.toLowerCase()] || 0n) + cost(a.qty, a.price);
  // newest first: when the wallet can only fund one bid, it goes to the latest lot
  for (const { i, id, seller, quote, bond, commitEnd, revealEnd, settled, sealed, qty, price } of all.reverse()) {
    if (settled) continue;
    try {
      if (now < commitEnd && !sealed && seller.toLowerCase() !== me.toLowerCase() && mayBid({ seller, commitEnd, revealEnd, bond })) {
        // bid only if the bond and the later escrow (on top of escrow already promised) are in the wallet
        const [wif, q] = await Promise.all([
          pub.readContract({ address: WIF, abi: erc20, functionName: "balanceOf", args: [me] }),
          pub.readContract({ address: quote, abi: erc20, functionName: "balanceOf", args: [me] }),
        ]);
        const k = quote.toLowerCase();
        const need = cost(qty, price) + (promised[k] || 0n);
        if (wif < bond || q < need + (k === WIF.toLowerCase() ? bond : 0n)) { log.push({ id: i, skip: "can't afford bond and escrow" }); continue; }
        const hash = await pub.readContract({ address: TUTUP, abi, functionName: "commitHash", args: [id, me, qty, price, salt(id)] });
        await allow(WIF, bond);
        log.push({ id: i, committed: await send(TUTUP, abi, "commit", [id, hash]) });
        promised[k] = need;
      } else if (now >= commitEnd && now < revealEnd && sealed) {
        // its own rule-based bids use the derived salt; a bid placed by hand from the desk with this wallet is
        // recovered from its commit calldata (drand timelock, unlocked once commits close) and revealed too
        let r = { qty, price, salt: salt(id) };
        const onchain = await pub.readContract({ address: TUTUP, abi, functionName: "commitOf", args: [id, me] });
        if ((await pub.readContract({ address: TUTUP, abi, functionName: "commitHash", args: [id, me, qty, price, r.salt] })) !== onchain) {
          const [ev] = (await pub.getLogs({ address: TUTUP, event: abi.find((x) => x.name === "Committed"), args: { id, bidder: me }, fromBlock: 112356368n })).slice(-1);
          const b = await openReceipt((await pub.getTransaction({ hash: ev.transactionHash })).input);
          r = { qty: BigInt(b.qty), price: BigInt(b.price), salt: b.salt };
        }
        await allow(quote, cost(r.qty, r.price));
        log.push({ id: i, revealed: await send(TUTUP, abi, "reveal", [id, r.qty, r.price, r.salt]) });
      } else if (now >= revealEnd) {
        log.push({ id: i, settled: await send(TUTUP, abi, "settle", [id]) });
      }
    } catch (e) {
      log.push({ id: i, error: e.shortMessage || e.message });
    }
  }
  // 4. market-making listings: at most one open listing of its own at a time
  try {
    if (!all.some((a) => !a.settled && a.seller.toLowerCase() === me.toLowerCase())) {
      for (const L of LOTS) {
        const held = await pub.readContract({ address: L.lot, abi: erc20, functionName: "balanceOf", args: [me] });
        const paused = L.stock && held > 0n && (await pub.readContract({ address: L.lot, abi: feedAbi, functionName: "oraclePaused" }).catch(() => false));
        const amount = paused ? held : !L.stock && fridayClose(now) ? L.friday : 0n;
        if (!amount) continue;
        // no clearing price yet for this pair means no honest reserve: skip rather than guess one
        const answer = await pub.readContract({ address: L.feed, abi: feedAbi, functionName: "latestRoundData" }).then((r) => r[1]).catch(() => 0n);
        if (answer <= 0n) { log.push({ list: L.lot, skip: "no clearing price for this pair yet" }); continue; }
        const fee = await pub.readContract({ address: TUTUP, abi, functionName: "listFee" });
        const wif = await pub.readContract({ address: WIF, abi: erc20, functionName: "balanceOf", args: [me] });
        if (wif < fee + (L.lot === WIF ? amount : 0n) || held < amount) { log.push({ list: L.lot, skip: "can't afford the listing fee and lot" }); continue; }
        await allow(WIF, fee + (L.lot === WIF ? amount : 0n));
        if (L.lot !== WIF) await allow(L.lot, amount);
        // commits run 44h (Friday 20:00 -> Sunday 16:00), reveals 20h: both outlast the gap between cron runs
        log.push({ listed: await send(TUTUP, abi, "create", [L.lot, WETH, amount, reserveFrom(answer), 50n * 10n ** 18n, 0n, 44n * 3600n, 20n * 3600n, L.feed]), lot: L.lot, why: paused ? "oraclePaused" : "friday close" });
        break;
      }
    }
  } catch (e) {
    log.push({ list: "error", error: e.shortMessage || e.message });
  }
  return { agent: me, checked: n, actions: log };
}

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "cron only" });
  }
  if (!process.env.KEEPER_KEY) return res.status(200).json({ configured: false });
  return res.status(200).json(await runKeeper());
}
