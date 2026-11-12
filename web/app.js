import {
  createPublicClient, createWalletClient, custom, http, fallback, defineChain, parseAbi,
  formatUnits, parseUnits, keccak256, encodeAbiParameters, toHex,
} from "./viem.js"; // viem 2.21.0, bundled locally

// Production values, set after deploy. On localhost only, ?rpc=…&tutup=0x…&from=N points the page at a local fork:
// a link to the live site must never be able to swap the contract the page asks people to approve.
const DEFAULT = { rpc: "https://rpc.mainnet.chain.robinhood.com", tutup: "0xd2Bfe52d5A0680DC7C3BE5BB19E1f75a568a5428", from: "112356368" };
const PAST = [["v1", "0x0abdDa286cCD2033c0aF5d80d5132E52Ede177FE"], ["v2", "0x408bbe1cB335Bd81EACFD5d364Bb5970d8C4fe30"]]; // earlier deployments, each with a settled auction #0
const q = new URLSearchParams(location.search);
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const pick = (k, ok) => (LOCAL && q.get(k) && ok.test(q.get(k)) ? q.get(k) : DEFAULT[k]);
const RPC = pick("rpc", /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
const TUTUP = pick("tutup", /^0x[0-9a-fA-F]{40}$/);
const FROM_BLOCK = BigInt(pick("from", /^\d+$/));
const DEPLOYED = !/^0x0+$/.test(TUTUP);

const chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [DEFAULT.rpc] } }, // what a wallet gets told; the page reads through RPC
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});
const EXPLORER = chain.blockExplorers.default.url;
// origin chains for "Get $WIF" through Relay
const ORIGINS = [
  { id: 4663, name: "Robinhood Chain", rpc: DEFAULT.rpc, explorer: EXPLORER },
  { id: 42161, name: "Arbitrum", rpc: "https://arb1.arbitrum.io/rpc", explorer: "https://arbiscan.io" },
  { id: 8453, name: "Base", rpc: "https://mainnet.base.org", explorer: "https://basescan.org" },
  { id: 1, name: "Ethereum", rpc: "https://eth.llamarpc.com", explorer: "https://etherscan.io" },
];

const WIF = "0x5173b8eA6923c2d40267890D45C46a3480954773";
// Chainlink-compatible feeds (TutupFeed) that serve lastPrint behind AggregatorV3Interface
const PRINT_FEEDS = [{ pair: "WIF / WETH", addr: "0xDe80aC53aBB6bB595Ea4D023f4B826F7F4C269dE" }];
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const NONE = "0x0000000000000000000000000000000000000000";
const FEED_ETH = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9";
const FEED_USDG = "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2";
const BASE_TOKENS = [
  { sym: "WIF", name: "World is Flat", addr: WIF, lot: true, quote: true },
  { sym: "USDG", name: "Global Dollar", addr: USDG, quote: true },
  { sym: "WETH", name: "Wrapped Ether", addr: WETH, quote: true },
];
let TOKENS = BASE_TOKENS; // + every Stock Token from tokens.json (built by scripts/tokens.py)
const tokensReady = fetch("tokens.json").then((r) => r.json())
  .then((list) => { TOKENS = [...BASE_TOKENS, ...list.map((t) => ({ ...t, lot: true }))]; }).catch(() => {});

const abi = parseAbi([
  "function auctionCount() view returns (uint256)",
  "function totalBurned() view returns (uint256)",
  "function listFee() view returns (uint256)",
  "function minBond() view returns (uint256)",
  "function auctions(uint256) view returns (address seller, address lot, address quote, address feed, uint128 lotAmount, uint128 reserve, uint128 bond, uint128 minSold, uint64 commitEnd, uint64 revealEnd, uint32 commits, uint32 reveals, bool settled)",
  "function bids(uint256) view returns ((address bidder, uint128 qty, uint128 price)[])",
  "function lastPrint(address, address) view returns (uint128 price, uint128 sold, uint64 at, uint64 auctionId)",
  "function owed(address, address) view returns (uint256)",
  "function create(address lot, address quote, uint128 lotAmount, uint128 reserve, uint128 bond, uint128 minSold, uint64 commitDuration, uint64 revealDuration, address feed) returns (uint256)",
  "function cancel(uint256 id)",
  "function commit(uint256 id, bytes32 hash)",
  "function reveal(uint256 id, uint128 qty, uint128 price, bytes32 salt)",
  "function settle(uint256 id)",
  "function claim(address token)",
  "event Settled(uint256 indexed id, uint256 clearingPrice, uint256 sold, uint256 proceeds, int256 refPrice, uint256 refUpdatedAt)",
  "event Filled(uint256 indexed id, address indexed bidder, uint256 qty, uint256 paid)",
  "event Burned(uint256 indexed id, uint256 amount, string reason)",
  "event Cancelled(uint256 indexed id)",
  "event Owed(address indexed token, address indexed to, uint256 amount)",
]);
const erc20 = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
]);
// ERC-8056 (Scaled UI Amount) and Robinhood's advisory oracle pause, both read from the Stock Token itself
const stockAbi = parseAbi([
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
  "function oraclePaused() view returns (bool)",
]);
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);

// Reads: the same-origin proxy first (no CORS, server-side failover), then the public RPC directly. Batched and retried.
const rpcOpts = { batch: { batchSize: 30, wait: 16 }, retryCount: 4, retryDelay: 300 };
const transport = RPC !== DEFAULT.rpc ? http(RPC, rpcOpts) : fallback([http("/api/rpc", rpcOpts), http(RPC, rpcOpts)]);
const pub = createPublicClient({ chain, transport });
let wallet, account;
// A view keeps rendering async data after the user may have moved on; writes to its gone elements land in a
// detached node instead of throwing. ponytail: one fallback here instead of a null check at every await.
const $ = (id) => document.getElementById(id) || document.createElement("div");
const view = $("view");
const tokenOf = (a) => TOKENS.find((t) => t.addr.toLowerCase() === a.toLowerCase());
const sym = (a) => tokenOf(a)?.sym || a.slice(0, 8);
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
// Tutup's own keeper agent (api/keeper.js): its bids are labelled so they are never read as outside demand
const KEEPER = "0xBCbC638826C37b1B9460ECf722C86DFb1a82D024";
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const decCache = {};
const decimals = async (a) => (decCache[a] ??= await pub.readContract({ address: a, abi: erc20, functionName: "decimals" }));
const fmt = (v, d, max = 4) => { const n = Number(formatUnits(v, d)); return n !== 0 && Math.abs(n) < 1 ? n.toLocaleString(undefined, { maximumSignificantDigits: 4 }) : n.toLocaleString(undefined, { maximumFractionDigits: max }); };
const usd = (n) => n == null ? "–" : "$" + (n < 1 ? n.toPrecision(3) : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));
const pct = (a, b) => (a == null || !b ? "" : `${a >= b ? "+" : ""}${(((a - b) / b) * 100).toFixed(2)}%`);
const tok = (a) => `<span class="tok"><i>${esc(sym(a).slice(0, 4))}</i>${esc(sym(a))}</span>`;
const read = (functionName, args = []) => pub.readContract({ address: TUTUP, abi, functionName, args });
const balanceOf = (token, who) => pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [who] });
const saveKey = (id, who) => `tutup:${TUTUP}:${id}:${who.toLowerCase()}`;
const cost = (qty, price) => (qty * price + 10n ** 18n - 1n) / 10n ** 18n;

function toast(msg, ms = 4000) {
  const t = $("toast");
  t.textContent = msg;
  t.style.display = "block";
  clearTimeout(toast.h);
  toast.h = setTimeout(() => (t.style.display = "none"), ms);
}

async function send(fn, args, label) {
  if (!account) await connect();
  toast(`${label}: confirm in your wallet…`, 60000);
  const hash = await wallet.writeContract({ address: TUTUP, abi, functionName: fn, args, account, chain });
  toast(`${label}: waiting for ${hash.slice(0, 10)}…`, 60000);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted`);
  toast(`${label}: done ✓`);
  return hash;
}

async function ensureAllowance(token, amount) {
  const cur = await pub.readContract({ address: token, abi: erc20, functionName: "allowance", args: [account, TUTUP] });
  if (cur >= amount) return;
  toast(`approve ${sym(token)}: confirm in your wallet…`, 60000);
  const hash = await wallet.writeContract({ address: token, abi: erc20, functionName: "approve", args: [TUTUP, amount], account, chain }); // exact amount, never unlimited
  await pub.waitForTransactionReceipt({ hash });
}

async function need(token, amount, what) {
  const have = await balanceOf(token, account);
  if (have < amount) {
    const d = await decimals(token);
    throw new Error(`${what} needs ${fmt(amount, d)} ${sym(token)}, you have ${fmt(have, d)}.${token === WIF ? " Get $WIF from the sidebar." : ""}`);
  }
}

async function switchTo(c) {
  try { await wallet.switchChain({ id: c.id }); } catch {
    await wallet.addChain({ chain: defineChain({ id: c.id, name: c.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [c.rpc] } } }) });
  }
}

// EIP-6963: every installed wallet announces itself, so two extensions fighting over window.ethereum don't matter
const wallets = [];
addEventListener("eip6963:announceProvider", (e) => {
  if (!wallets.some((w) => w.info.uuid === e.detail.info.uuid)) wallets.push(e.detail);
});
dispatchEvent(new Event("eip6963:requestProvider"));
let provider;

function pickWallet() {
  if (wallets.length <= 1) return Promise.resolve(wallets[0]?.provider || window.ethereum);
  return new Promise((resolve, reject) => {
    const box = document.createElement("div");
    box.className = "picker";
    box.innerHTML = `<div class="card pad"><h2 class="sub">Choose a wallet</h2>${wallets.map((w, i) =>
      `<button class="btn ghost" data-i="${i}">${/^data:image\//.test(w.info.icon) ? `<img src="${esc(w.info.icon)}" alt="" width="20" height="20">` : ""}${esc(w.info.name)}</button>`).join("")}
      <button class="btn ghost" data-x="1">Cancel</button></div>`;
    box.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      box.remove();
      b.dataset.x ? reject(new Error("no wallet chosen")) : resolve(wallets[Number(b.dataset.i)].provider);
    };
    document.body.append(box);
    box.querySelector("button").focus();
  });
}

async function connect() {
  provider = await pickWallet();
  if (!provider) throw new Error("no wallet found");
  wallet = createWalletClient({ chain, transport: custom(provider) });
  [account] = await wallet.requestAddresses();
  await switchTo(ORIGINS[0]);
  $("connect").textContent = short(account);
  if (!provider.__tutup) {
    provider.__tutup = true;
    provider.on?.("accountsChanged", (a) => { account = a[0]; $("connect").textContent = account ? short(account) : "Connect wallet"; route(); });
    provider.on?.("chainChanged", (id) => { if (Number(id) !== chain.id) toast("Your wallet left Robinhood Chain. Transactions will ask to switch back.", 6000); });
  }
  route();
}

// --- prices: Chainlink first, Lighter's onchain order book when the feed is frozen, Robinhood's API for halts ---

async function readFeed(addr) {
  const [, p, , at] = await pub.readContract({ address: addr, abi: feedAbi, functionName: "latestRoundData" });
  return { price: Number(p) / 1e8, ageH: (Date.now() / 1000 - Number(at)) / 3600 };
}

let lighterMarkets;
async function lighter(symb) {
  try {
    lighterMarkets ??= fetch("https://api.rh.lighter.xyz/api/v1/orderBooks").then((r) => r.json()).then((d) => d.order_books || []);
    const m = (await lighterMarkets).find((o) => o.market_type === "spot" && o.symbol === `${symb}/USDG` && o.status === "active");
    if (!m) return null;
    const [det, book] = await Promise.all([
      fetch(`https://api.rh.lighter.xyz/api/v1/orderBookDetails?market_id=${m.market_id}`).then((r) => r.json()),
      fetch(`https://api.rh.lighter.xyz/api/v1/orderBookOrders?market_id=${m.market_id}&limit=1`).then((r) => r.json()),
    ]);
    const d = (det.spot_order_book_details || det.order_book_details || [])[0] || {};
    return { last: Number(d.last_trade_price) || null, bid: Number(book.bids?.[0]?.price) || null, ask: Number(book.asks?.[0]?.price) || null, vol: Number(d.daily_quote_token_volume) || 0, market: m.market_id };
  } catch { return null; }
}

/// Walk Lighter's bids to price selling `qty` right now: the alternative to an auction.
async function lighterSell(symb, qty) {
  try {
    lighterMarkets ??= fetch("https://api.rh.lighter.xyz/api/v1/orderBooks").then((r) => r.json()).then((d) => d.order_books || []);
    const m = (await lighterMarkets).find((o) => o.market_type === "spot" && o.symbol === `${symb}/USDG` && o.status === "active");
    if (!m) return null;
    const book = await fetch(`https://api.rh.lighter.xyz/api/v1/orderBookOrders?market_id=${m.market_id}&limit=100`).then((r) => r.json());
    let left = qty, got = 0;
    for (const b of book.bids || []) {
      const take = Math.min(left, Number(b.remaining_base_amount));
      got += take * Number(b.price);
      left -= take;
      if (left <= 0) break;
    }
    const best = Number(book.bids?.[0]?.price) || null;
    return { filled: qty - left, avg: qty - left > 0 ? got / (qty - left) : null, best, short: left > 0 ? left : 0 };
  } catch { return null; }
}

// Pyth (Equity.US session feed and Equity.Index 24/7 feed) through /api/pyth, which holds the Pyth Pro key.
// Hidden entirely until a key is configured.
async function pyth(symb) {
  if (RPC !== DEFAULT.rpc) return null;
  try {
    const r = await fetch(`/api/pyth?symbol=${encodeURIComponent(symb)}`).then((x) => x.json());
    if (!r.configured || r.error) return null;
    const age = (p) => p && { ...p, ageH: (Date.now() / 1000 - p.publishTime) / 3600 };
    return { us: age(r.us), d247: age(r.d247) };
  } catch { return null; }
}

// Uniswap v3 on Robinhood Chain (Stock Tokens have deep USDG and WETH pools there): what selling this lot
// into the pool would return right now, from QuoterV2. The other half of "auction or market sell?".
const UNI_QUOTER = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7";
const quoterAbi = parseAbi(["function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160, uint32, uint256)"]);
async function uniswapSell(lot, quote, amount) {
  if (![USDG, WETH].includes(quote)) quote = WETH;
  let best = null;
  for (const fee of [500, 3000, 100, 10000]) {
    try {
      const { result } = await pub.simulateContract({ address: UNI_QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: lot, tokenOut: quote, amountIn: amount, fee, sqrtPriceLimitX96: 0n }] });
      if (!best || result[0] > best.out) best = { out: result[0], fee, quote };
    } catch { /* no pool at this fee tier */ }
  }
  return best;
}

async function robinhood(symb) {
  try {
    const r = await fetch(`/api/rhj/prices/${encodeURIComponent(symb)}`);
    if (!r.ok) return null;
    const qte = (await r.json()).quotes?.[0];
    return qte ? { bid: Number(qte.tokenBid || qte.bid), ask: Number(qte.tokenAsk || qte.ask), halt: !!qte.isTradingHalt } : null;
  } catch { return null; }
}

async function stockState(t) {
  const call = (functionName) => pub.readContract({ address: t.addr, abi: stockAbi, functionName }).catch(() => null);
  const [mult, next, at, paused] = await Promise.all([call("uiMultiplier"), call("newUIMultiplier"), call("effectiveAt"), call("oraclePaused")]);
  return { mult, paused, pending: mult != null && next != null && next !== mult && Number(at) > Date.now() / 1000 ? { next, at: Number(at) } : null };
}

/// US equity session from the New York clock. ponytail: ignores exchange holidays, the feed staleness check catches those.
function session(d = new Date()) {
  const ny = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = ny.getDay(), m = ny.getHours() * 60 + ny.getMinutes();
  if (day === 6 || (day === 0 && m < 20 * 60) || (day === 5 && m >= 20 * 60)) return "weekend";
  if (m >= 570 && m < 960) return "regular";
  if (m >= 240 && m < 570) return "pre-market";
  if (m >= 960 && m < 1200) return "after-hours";
  return "overnight";
}

/// Everything known about one Stock Token right now, in USD.
async function reference(t) {
  const [f5, f7, lt, rh, st, py] = await Promise.all([
    t.f5 ? readFeed(t.f5).catch(() => null) : null,
    t.f7 ? readFeed(t.f7).catch(() => null) : null,
    lighter(t.sym), robinhood(t.sym), t.addr === WIF ? null : stockState(t), pyth(t.sym),
  ]);
  const closed = !f5 || f5.ageH > 2 || st?.paused || rh?.halt;
  const best = f7 && f7.ageH < 1 ? { price: f7.price, src: "Chainlink 24/7" }
    : f5 && !closed ? { price: f5.price, src: "Chainlink 24/5" }
    : py?.d247 && py.d247.ageH < 0.25 ? { price: py.d247.price, src: "Pyth 24/7" }
    : lt?.last ? { price: lt.last, src: "Lighter last trade" }
    : f5 ? { price: f5.price, src: "Chainlink 24/5 (frozen)" } : null;
  return { f5, f7, lt, rh, st, py, closed, best };
}

/// Quicknode Stock Token API through /api/qn (the endpoint key never reaches the browser). null if unavailable.
async function qn(method, params = []) {
  if (RPC !== DEFAULT.rpc) return null; // local fork runs don't touch mainnet add-ons
  try {
    const r = await fetch("/api/qn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
    return r.ok ? (await r.json()).result : null;
  } catch { return null; }
}
const SESSION_NAMES = { REGULAR: "regular", PRE_MARKET: "pre-market", POST_MARKET: "after-hours", AFTER_HOURS: "after-hours", OVERNIGHT: "overnight", CLOSED: "closed", WEEKEND: "weekend", HOLIDAY: "holiday" };
const sessionName = (h) => (h?.session?.name ? SESSION_NAMES[h.session.name] || h.session.name.toLowerCase().replace(/_/g, " ") : session());

let wifUsdCache;
async function quoteUsd(token) {
  if (token === USDG) return (await readFeed(FEED_USDG)).price;
  if (token === WETH) return (await readFeed(FEED_ETH)).price;
  if (token === WIF) return (wifUsdCache ??= fetch("/api/rhj/wif-price").then((r) => r.json()).then((d) => d.usd).catch(() => null));
  return null;
}

// --- data ---

function phaseOf(a, now) {
  if (a.settled) return a.cancelled ? "cancelled" : "settled";
  if (now < a.commitEnd) return "commit";
  if (now < a.revealEnd) return "reveal";
  return "settle";
}

const left = (t, now) => {
  const s = Number(t - now);
  if (s <= 0) return "–";
  return s > 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

let cancelledIds;
const events = (eventName, args) =>
  pub.getContractEvents({ address: TUTUP, abi, eventName, args, fromBlock: FROM_BLOCK }).catch(() => []);

async function loadAuction(id) {
  const [seller, lot, quote, feed, lotAmount, reserve, bond, minSold, commitEnd, revealEnd, commits, reveals, settled] = await read("auctions", [id]);
  cancelledIds ??= events("Cancelled").then((l) => new Set(l.map((x) => x.args.id)));
  const cancelled = settled && (await cancelledIds).has(id);
  return { id, seller, lot, quote, feed, lotAmount, reserve, bond, minSold, commitEnd, revealEnd, commits, reveals, settled, cancelled, qd: await decimals(quote) };
}

async function loadAll() {
  cancelledIds = null;
  const [count, now] = await Promise.all([read("auctionCount"), pub.getBlock().then((b) => b.timestamp)]);
  const ids = [...Array(Number(count)).keys()].reverse().map(BigInt);
  return { now, list: await Promise.all(ids.map(loadAuction)) };
}

// --- bid receipts: the salt is the only way to reveal, so it can leave this browser as a file ---

function icsReminder(id, a) {
  const z = (t) => new Date(Number(t) * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const url = `${location.origin}/app.html#a/${id}`;
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tutup//EN", "BEGIN:VEVENT", `UID:tutup-${TUTUP}-${id}@tutup.vercel.app`,
    `DTSTAMP:${z(BigInt(Math.floor(Date.now() / 1000)))}`, `DTSTART:${z(a.commitEnd)}`, `DTEND:${z(a.revealEnd)}`,
    `SUMMARY:Reveal your Tutup bid (auction #${id})`, `DESCRIPTION:Reveal before the window closes or your ${fmt(a.bond, 18, 0)} $WIF bond burns. ${url}`, `URL:${url}`,
    "BEGIN:VALARM", "TRIGGER:PT0M", "ACTION:DISPLAY", "DESCRIPTION:Reveal your Tutup bid", "END:VALARM", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const el = document.createElement("a");
  el.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  el.download = `tutup-reveal-${id}.ics`;
  el.click();
  URL.revokeObjectURL(el.href);
}

let chainSkew = 0; // chain time minus browser time, so countdowns follow the chain
setInterval(() => {
  const now = BigInt(Math.floor(Date.now() / 1000 + chainSkew));
  document.querySelectorAll("[data-end]").forEach((el) => (el.textContent = left(BigInt(el.dataset.end), now)));
}, 1000);
const countdown = (end, now) => { chainSkew = Number(now) - Date.now() / 1000; return `<span data-end="${end}">${left(end, now)}</span>`; };

function saveReceipt(id, r) {
  localStorage.setItem(saveKey(id, account), JSON.stringify(r));
}

function downloadReceipt(id, r) {
  const blob = new Blob([JSON.stringify({ tutup: TUTUP, chainId: 4663, auction: id.toString(), bidder: account, ...r }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `tutup-bid-${id}-${account.slice(2, 8)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importReceipt(file, id) {
  const r = JSON.parse(await file.text());
  if (r.tutup?.toLowerCase() !== TUTUP.toLowerCase() || r.auction !== id.toString() || r.bidder?.toLowerCase() !== account.toLowerCase()) {
    throw new Error("that receipt is for a different auction or wallet");
  }
  if (!/^0x[0-9a-f]{64}$/i.test(r.salt) || !/^\d+$/.test(r.qty) || !/^\d+$/.test(r.price)) throw new Error("receipt is malformed");
  saveReceipt(id, { qty: r.qty, price: r.price, salt: r.salt, committed: true });
}

// --- views ---

const notDeployed = `<div class="card empty">The contract address isn't set yet. Auctions will appear here once Tutup is live on mainnet.</div>`;

async function vAuctions(filter = "all") {
  view.innerHTML = `<div class="head"><div><p class="eyebrow">sealed-bid batch auctions · one clearing price</p><h1>Auctions</h1></div>
    <div class="tabs">${["all", "live", "settled"].map((f) => `<button class="tab ${f === filter ? "on" : ""}" data-f="${f}">${f}</button>`).join("")}</div></div>
    <section class="stats">
      <div class="card stat burn"><div class="k">$wif burned</div><div class="v" id="s-burned">…</div></div>
      <div class="card stat"><div class="k">auctions</div><div class="v" id="s-count">…</div></div>
      <div class="card stat"><div class="k">us equities now</div><div class="v" id="s-sess">${session()}</div><div id="s-mkt"></div></div>
      <div class="card stat"><div class="k">nvda · chainlink 24/7</div><div class="v" id="s-n7">…</div><div class="muted" id="s-n5" style="font-size:11px"></div></div>
    </section>
    <div class="card tablescroll" id="tbl"><div class="empty">loading…</div></div>`;
  view.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => vAuctions(b.dataset.f)));

  qn("qn_getOracleHealth", [{ symbols: ["NVDA"] }]).then((h) => {
    if (!h) return;
    $("s-sess").textContent = sessionName(h);
    $("s-sess").title = `Quicknode Stock Token API · mint window ${h.session?.mintWindowOpen ? "open" : "closed"}`;
  });
  await tokensReady;
  const nv = TOKENS.find((t) => t.sym === "NVDA");
  if (nv) reference(nv).then((r) => {
    $("s-n7").textContent = usd(r.f7?.price);
    $("s-n5").textContent = r.f5 ? `24/5 feed ${usd(r.f5.price)} · ${r.f5.ageH.toFixed(1)}h old` : "";
    $("s-mkt").innerHTML = `<span class="badge ${r.closed ? "b-closed" : "b-open"}">${r.closed ? "official feed frozen" : "official feed live"}</span>`;
  });

  if (!DEPLOYED) { $("s-burned").textContent = "–"; $("s-count").textContent = "–"; $("tbl").innerHTML = notDeployed; return; }
  const [burned, { now, list }] = await Promise.all([read("totalBurned"), loadAll()]);
  $("s-burned").textContent = fmt(burned, 18, 0);
  $("s-count").textContent = list.length;
  const rows = list.filter((a) => filter === "all" || (filter === "settled") === a.settled);
  if (!rows.length) { $("tbl").innerHTML = `<div class="empty">No auctions here yet. <a href="#create">List the first lot →</a></div>`; return; }
  $("tbl").innerHTML = `<table><thead><tr><th>auction</th><th>lot → paid in</th><th>size</th><th>reserve</th><th>bond</th><th>sealed bids</th><th>phase</th><th>closes in</th></tr></thead><tbody>
    ${rows.map((a) => {
      const ph = phaseOf(a, now);
      const end = ph === "commit" ? a.commitEnd : a.revealEnd;
      return `<tr class="click" tabindex="0" role="link" data-id="${a.id}"><td>#${a.id}</td><td>${tok(a.lot)}<span class="arrow">→</span>${tok(a.quote)}</td>
        <td>${fmt(a.lotAmount, 18)}</td><td>${fmt(a.reserve, a.qd)} ${esc(sym(a.quote))}</td><td>${fmt(a.bond, 18, 0)} WIF</td><td>${a.commits}</td>
        <td><span class="badge b-${ph}">${ph}</span></td><td>${a.settled ? "–" : countdown(end, now)}</td></tr>`;
    }).join("")}</tbody></table>`;
  $("tbl").querySelectorAll("tr[data-id]").forEach((r) => (r.onclick = () => (location.hash = `#a/${r.dataset.id}`)));
}

function refPanel(t, r, quoteUsdPrice, reserveUnits, clearingUnits) {
  const rows = [];
  if (r.f7) rows.push(["Chainlink 24/7", usd(r.f7.price), `${r.f7.ageH.toFixed(1)}h old`]);
  if (r.f5) rows.push(["Chainlink 24/5 (official)", usd(r.f5.price), r.f5.ageH > 2 ? `frozen ${r.f5.ageH.toFixed(1)}h` : "live"]);
  if (r.py?.d247) rows.push(["Pyth 24/7 (Equity.Index)", usd(r.py.d247.price), `±${usd(r.py.d247.conf)} · ${(r.py.d247.ageH * 60).toFixed(0)} min old`]);
  if (r.py?.us) rows.push(["Pyth US session (Equity.US)", usd(r.py.us.price), `${r.py.us.ageH.toFixed(1)}h old`]);
  if (r.lt) rows.push([`Lighter ${t.sym}/USDG`, usd(r.lt.last), `bid ${usd(r.lt.bid)} · ask ${usd(r.lt.ask)}`]);
  if (r.rh) rows.push(["Robinhood quote", `${usd(r.rh.bid)} / ${usd(r.rh.ask)}`, r.rh.halt ? "trading halt" : "no halt"]);
  if (r.uni) rows.push(["sell this lot on Uniswap v3 now", `${r.uni.text}`, `fee tier ${r.uni.fee / 10000}%`]);
  if (r.sell) rows.push(["sell this lot on Lighter now", r.sell.avg ? usd(r.sell.avg) + " avg" : "no bids",
    r.sell.short > 0 ? `book only absorbs ${r.sell.filled.toFixed(4)}` : r.sell.avg && r.sell.best ? `${pct(r.sell.avg, r.sell.best)} vs best bid` : ""]);
  if (r.st?.mult) rows.push(["ERC-8056 multiplier", (Number(r.st.mult) / 1e18).toFixed(6), r.st.pending ? `changes to ${(Number(r.st.pending.next) / 1e18).toFixed(6)} on ${new Date(r.st.pending.at * 1000).toLocaleDateString()}` : "no pending corporate action"]);
  if (r.st) rows.push(["oraclePaused()", r.st.paused ? "true" : "false", r.st.paused ? "corporate action in progress" : ""]);
  const ref = r.best?.price;
  const reserveUsd = quoteUsdPrice && reserveUnits != null ? reserveUnits * quoteUsdPrice : null;
  const clearUsd = quoteUsdPrice && clearingUnits != null ? clearingUnits * quoteUsdPrice : null;
  return `<h2 class="sub" style="margin-top:6px">Reference price</h2>
    <div class="kv"><span>best reference</span><b>${usd(ref)} <span class="muted">${esc(r.best?.src || "none")}</span></b></div>
    ${reserveUsd != null ? `<div class="kv"><span>reserve in USD</span><b>${usd(reserveUsd)} <span class="muted">${pct(reserveUsd, ref)}</span></b></div>` : ""}
    ${clearUsd != null ? `<div class="kv"><span>clearing in USD</span><b>${usd(clearUsd)} <span class="muted">${pct(clearUsd, ref)} vs reference now</span></b></div>` : ""}
    ${rows.map(([k, v, n]) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)} <span class="muted">${esc(n)}</span></b></div>`).join("")}`;
}

async function vAuction(id) {
  await tokensReady;
  view.innerHTML = `<div class="card empty">loading auction #${id}…</div>`;
  if (!DEPLOYED) { view.innerHTML = notDeployed; return; }
  cancelledIds = null; // a cancel may have just happened
  const [a, now] = await Promise.all([loadAuction(id), pub.getBlock().then((b) => b.timestamp)]);
  const ph = phaseOf(a, now);
  const saved = account && JSON.parse(localStorage.getItem(saveKey(id, account)) || "null");
  const isSeller = account && account.toLowerCase() === a.seller.toLowerCase();
  const steps = ["commit", "reveal", "settle", "settled"];
  const idx = steps.indexOf(ph === "cancelled" ? "settled" : ph);
  const bondTxt = `${fmt(a.bond, 18, 0)} $WIF`;

  let action = "";
  if (ph === "commit" && isSeller) {
    action = `<h2 class="sub">Your auction</h2><p class="note">Sellers can't bid in their own auction, because a seller bid would only move its own clearing price.</p>
      ${a.commits === 0 ? `<div class="form" style="margin-top:10px"><p class="note">Nobody has bid yet, so you can still take the lot back. The listing fee stays burned.</p><button class="btn ghost" data-act="cancel">Cancel and return lot</button></div>` : ""}`;
  } else if (ph === "commit" && !(saved && saved.committed)) {
    action = `<h2 class="sub">Seal a bid</h2><div class="form">
      <div class="two"><label>quantity (${esc(sym(a.lot))})<input id="qty" placeholder="0.5" inputmode="decimal"></label>
      <label>your price (${esc(sym(a.quote))} each)<input id="price" placeholder="${fmt(a.reserve, a.qd)}" inputmode="decimal"></label></div>
      <p class="note" id="bidcost">Posts a ${bondTxt} bond. At reveal you'll escrow quantity × price.</p>
      <p class="note">We save your quantity, price and salt in this browser and download a receipt file. Without them you can't reveal, and the bond burns.</p>
      <button class="btn" data-act="commit">Seal bid · ${bondTxt} bond</button></div>`;
  } else if (ph === "commit") {
    action = `<h2 class="sub">Your bid</h2><div class="callout">Sealed: ${fmt(BigInt(saved.qty), 18)} ${esc(sym(a.lot))} at ${fmt(BigInt(saved.price), a.qd)} ${esc(sym(a.quote))}. Reveal opens in ${countdown(a.commitEnd, now)}.</div>
      <div class="two" style="margin-top:10px"><button class="btn ghost" data-act="receipt">Download receipt again</button><button class="btn ghost" data-act="ics">Add reveal to calendar</button></div>`;
  } else if (ph === "reveal" && saved && !saved.revealed) {
    action = `<h2 class="sub">Reveal</h2><div class="form"><div class="callout">You sealed ${fmt(BigInt(saved.qty), 18)} ${esc(sym(a.lot))} at ${fmt(BigInt(saved.price), a.qd)} ${esc(sym(a.quote))}. Revealing escrows ${fmt(cost(BigInt(saved.qty), BigInt(saved.price)), a.qd)} ${esc(sym(a.quote))} and returns your ${bondTxt}.</div>
      <button class="btn" data-act="reveal">Reveal my bid</button></div>`;
  } else if (ph === "reveal") {
    action = `<h2 class="sub">Reveal phase</h2><p class="note">${saved ? "Your bid is revealed." : "Bidding is closed and bidders are opening their bids."} Settlement opens in ${countdown(a.revealEnd, now)}.</p>
      ${account && !saved ? `<label style="margin-top:12px">bid on another device? import its receipt<input type="file" id="rcpt" accept="application/json"></label>` : ""}`;
  } else if (ph === "settle") {
    action = `<h2 class="sub">Ready to settle</h2><div class="form"><p class="note">Anyone can settle. The highest bids fill first and every winner pays the lowest winning price. If a payout can't be delivered to someone (for example a frozen USDG account), it's held for them to claim, so nobody else is blocked.</p><button class="btn" data-act="settle">Settle auction</button></div>`;
  } else if (ph === "cancelled") {
    action = `<h2 class="sub">Cancelled</h2><p class="note">The seller took the lot back before anyone bid.</p>`;
  }

  const shareText = encodeURIComponent(`Sealed-bid auction #${id} on Tutup: ${fmt(a.lotAmount, 18)} ${sym(a.lot)}, paid in ${sym(a.quote)}. Bid while the market is closed, every winner pays one price. $WIF`);
  const share = `https://x.com/intent/post?text=${shareText}&url=${encodeURIComponent(`${location.origin}/app.html#a/${id}`)}`;
  view.innerHTML = `<div class="head"><div><p class="eyebrow"><a href="#auctions">← auctions</a></p><h1>Auction #${id}</h1></div><div style="display:flex;gap:8px;align-items:center"><a class="btn ghost" href="${share}" target="_blank" rel="noopener">Share on X</a><span class="badge b-${ph}">${ph}</span></div></div>
    <div class="g2">
      <div class="card pad">
        <div class="timeline">${steps.map((s, i) => `<div class="${i < idx ? "done" : i === idx ? "now" : ""}">${s}</div>`).join("")}</div>
        <div class="kv"><span>lot</span><b>${fmt(a.lotAmount, 18)} ${esc(sym(a.lot))}</b></div>
        <div class="kv"><span>paid in</span><b>${esc(sym(a.quote))}</b></div>
        <div class="kv"><span>reserve</span><b>${fmt(a.reserve, a.qd)} ${esc(sym(a.quote))}</b></div>
        <div class="kv"><span>bond per bid</span><b>${bondTxt}</b></div>
        <div class="kv"><span>minimum sold</span><b>${a.minSold > 0n ? `${fmt(a.minSold, 18)} ${esc(sym(a.lot))}, or everyone is refunded` : "none"}</b></div>
        <div class="kv"><span>seller</span><b><a href="${EXPLORER}/address/${a.seller}" target="_blank" rel="noopener">${short(a.seller)}</a>${isSeller ? " (you)" : ""}</b></div>
        <div class="kv"><span>sealed bids</span><b>${a.commits}</b></div>
        <div class="kv"><span>revealed</span><b>${a.reveals}</b></div>
        <div class="kv"><span>commits close</span><b>${new Date(Number(a.commitEnd) * 1000).toLocaleString()}</b></div>
        <div class="kv"><span>reveals close</span><b>${new Date(Number(a.revealEnd) * 1000).toLocaleString()}</b></div>
        <div id="result"></div>
      </div>
      <div style="display:grid;gap:16px"><div class="card pad" id="act">${action || `<h2 class="sub">Settled</h2><p class="note">This auction is closed.</p>`}</div>
      <div class="card pad" id="ref"><h2 class="sub">Reference price</h2><p class="note">reading Chainlink, Lighter and Robinhood…</p></div></div>
    </div>
    <h2 class="sub" style="margin-top:22px">Bid book</h2>
    <div class="card tablescroll" id="book"><div class="empty">${ph === "commit" ? "Bids are sealed. Nothing is visible until commits close." : "loading…"}</div></div>`;

  let settledArgs;
  if (ph !== "commit" && ph !== "cancelled") {
    const [bids, settledLogs, fills] = await Promise.all([read("bids", [id]), events("Settled", { id }), events("Filled", { id })]);
    settledArgs = settledLogs[0]?.args;
    const s = settledArgs;
    if (s) {
      $("result").innerHTML = `<div class="kv"><span>clearing price</span><b>${fmt(s.clearingPrice, a.qd)} ${esc(sym(a.quote))}</b></div>
        <div class="kv"><span>sold</span><b>${fmt(s.sold, 18)} ${esc(sym(a.lot))}</b></div>
        <div class="kv"><span>proceeds to seller</span><b>${fmt(s.proceeds, a.qd)} ${esc(sym(a.quote))}</b></div>
        ${s.refPrice > 0n ? `<div class="kv"><span>Chainlink at settle</span><b>${usd(Number(s.refPrice) / 1e8)}</b></div>` : ""}
        <div class="kv"><span>unrevealed bonds burned</span><b>${a.commits - a.reveals} × ${bondTxt}</b></div>
        <div class="kv"><span>settlement tx</span><b><a href="${EXPLORER}/tx/${settledLogs[0].transactionHash}" target="_blank" rel="noopener">${settledLogs[0].transactionHash.slice(0, 12)}…</a> <span id="fin" class="muted"></span></b></div>`;
      qn("qn_getTransactionFinality", [settledLogs[0].transactionHash]).then((f) => {
        if (!f) return;
        const stage = String(f.stage || "").toLowerCase();
        $("fin").innerHTML = `<span class="badge ${stage === "finalized" ? "b-won" : "b-reveal"}" title="Quicknode Stock Token API">${esc(stage)}${f.batchNumber ? ` · batch ${f.batchNumber}` : ""}</span>`;
      });
    }
    const filled = Object.fromEntries(fills.map((f) => [f.args.bidder.toLowerCase(), f.args]));
    const sorted = [...bids].sort((x, y) => (y.price > x.price ? 1 : y.price < x.price ? -1 : 0));
    $("book").innerHTML = sorted.length ? `<table><thead><tr><th>bidder</th><th>quantity</th><th>bid price</th>${s ? "<th>filled</th><th>paid</th><th>result</th>" : ""}</tr></thead><tbody>
      ${sorted.map((b) => {
        const f = filled[b.bidder.toLowerCase()];
        return `<tr><td><a href="${EXPLORER}/address/${b.bidder}" target="_blank" rel="noopener">${short(b.bidder)}</a>${account && b.bidder.toLowerCase() === account.toLowerCase() ? " (you)" : ""}${b.bidder.toLowerCase() === KEEPER.toLowerCase() ? " (Tutup agent)" : ""}</td>
        <td>${fmt(b.qty, 18)}</td><td>${fmt(b.price, a.qd)} ${esc(sym(a.quote))}</td>
        ${s ? `<td>${f ? fmt(f.qty, 18) : "0"}</td><td>${f ? fmt(f.paid, a.qd) + " " + esc(sym(a.quote)) : "refunded"}</td><td><span class="badge ${f ? "b-won" : "b-lost"}">${f ? "won" : "lost"}</span></td>` : ""}</tr>`;
      }).join("")}</tbody></table>` : `<div class="empty">No bids revealed.</div>`;
  }

  // reference prices, in the background so the page never waits on a third party
  const t = tokenOf(a.lot);
  if (t && t.addr !== WIF) {
    Promise.all([reference(t), quoteUsd(a.quote), lighterSell(t.sym, Number(formatUnits(a.lotAmount, 18))), uniswapSell(a.lot, a.quote, a.lotAmount)]).then(async ([r, qu, sell, uni]) => {
      r.sell = sell;
      if (uni) {
        const d = await decimals(uni.quote);
        const usdNow = await quoteUsd(uni.quote);
        r.uni = { fee: uni.fee, text: `${fmt(uni.out, d)} ${sym(uni.quote)}${usdNow ? ` (${usd(Number(formatUnits(uni.out, d)) * usdNow)})` : ""}` };
      }
      const units = (v) => Number(formatUnits(v, a.qd));
      $("ref").innerHTML = refPanel(t, r, qu, units(a.reserve), settledArgs ? units(settledArgs.clearingPrice) : null);
      qn("qn_getCorporateActions", [{ symbols: [t.sym] }]).then((c) => {
        const acts = (c?.actions || []).slice(-3).reverse();
        if (!c) return;
        $("ref").insertAdjacentHTML("beforeend", `<h2 class="sub" style="margin-top:14px">Corporate actions <span class="muted" style="text-transform:none;letter-spacing:0">· Quicknode</span></h2>${acts.length
          ? acts.map((x) => `<div class="kv"><span>${esc(x.type.toLowerCase().replace(/_/g, " "))} · ${esc(x.status.toLowerCase())}</span><b>${esc((x.effectiveAtIso || "").slice(0, 10))} · ×${Number(x.ratio).toFixed(5)}</b></div>`).join("")
          : `<p class="note">No splits or dividends on record.</p>`}`);
      });
    }).catch(() => ($("ref").innerHTML = `<h2 class="sub">Reference price</h2><p class="note">Reference sources unavailable right now.</p>`));
  } else {
    quoteUsd(WIF).then((w) => ($("ref").innerHTML = `<h2 class="sub">Reference price</h2><div class="kv"><span>$WIF (worldisflat.fun)</span><b>${usd(w)}</b></div><p class="note" style="margin-top:8px">WIF pools are thin, so a sealed auction is a better way to move a block of WIF than a swap.</p>`));
  }

  const qtyIn = $("qty"), priceIn = $("price");
  if (qtyIn) {
    const upd = () => {
      try {
        const c = cost(parseUnits(qtyIn.value || "0", 18), parseUnits(priceIn.value || "0", a.qd));
        $("bidcost").textContent = `Posts a ${bondTxt} bond now. At reveal you'll escrow ${fmt(c, a.qd)} ${sym(a.quote)}, and anything above the clearing price comes back.`;
      } catch {}
    };
    qtyIn.oninput = priceIn.oninput = upd;
  }
  const rc = $("rcpt");
  if (rc) rc.onchange = async () => { try { await importReceipt(rc.files[0], id); toast("receipt imported ✓"); vAuction(id); } catch (e) { toast(e.message, 8000); } };

  $("act").addEventListener("click", async (e) => {
    const act = e.target.dataset?.act;
    if (!act) return;
    e.target.disabled = true;
    try {
      if (!account) await connect();
      if (act === "commit") {
        const qty = parseUnits($("qty").value, 18);
        const price = parseUnits($("price").value, a.qd);
        if (qty === 0n || qty > a.lotAmount) throw new Error(`quantity must be between 0 and ${fmt(a.lotAmount, 18)}`);
        if (price < a.reserve) throw new Error(`price is below the reserve of ${fmt(a.reserve, a.qd)} ${sym(a.quote)}; the reveal would be refused`);
        await need(WIF, a.bond, "The bond");
        const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
        const hash = keccak256(encodeAbiParameters(
          [{ type: "uint256" }, { type: "address" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes32" }],
          [id, account, qty, price, salt]));
        const r = { qty: qty.toString(), price: price.toString(), salt };
        saveReceipt(id, r); // save before sending: losing the salt means losing the bond
        downloadReceipt(id, r);
        await ensureAllowance(WIF, a.bond);
        await send("commit", [id, hash], "seal bid");
        saveReceipt(id, { ...r, committed: true });
        icsReminder(id, a); // the bond burns if the reveal is missed, so put it on the calendar
      }
      if (act === "receipt") downloadReceipt(id, saved);
      if (act === "ics") icsReminder(id, a);
      if (act === "reveal") {
        const qty = BigInt(saved.qty), price = BigInt(saved.price);
        await need(a.quote, cost(qty, price), "Revealing");
        await ensureAllowance(a.quote, cost(qty, price));
        await send("reveal", [id, qty, price, saved.salt], "reveal");
        saveReceipt(id, { ...saved, revealed: true });
      }
      if (act === "settle") await send("settle", [id], "settle");
      if (act === "cancel") await send("cancel", [id], "cancel");
      vAuction(id);
    } catch (err) {
      toast(err.shortMessage || err.message, 9000);
      e.target.disabled = false;
    }
  });
}

async function vCreate() {
  await tokensReady;
  const stock = TOKENS.filter((t) => t.lot && t.addr !== WIF);
  view.innerHTML = `<div class="head"><div><p class="eyebrow">escrow a lot · burns 100 $wif</p><h1>List a lot</h1></div></div>
    <div class="g2"><div class="card pad"><form id="create" class="form">
      <div class="two"><label>lot token<select name="lot" id="lotSel"><option value="${WIF}">WIF · World is Flat</option>
        <optgroup label="Stock Tokens with Chainlink feeds">${stock.filter((t) => t.f5).map((t) => `<option value="${t.addr}">${esc(t.sym)} · ${esc(t.name)}</option>`).join("")}</optgroup>
        <optgroup label="Other Stock Tokens">${stock.filter((t) => !t.f5).map((t) => `<option value="${t.addr}">${esc(t.sym)} · ${esc(t.name)}</option>`).join("")}</optgroup></select></label>
      <label>paid in<select name="quote" id="quoteSel">${TOKENS.filter((t) => t.quote).map((t) => `<option value="${t.addr}" ${t.sym === "USDG" ? "selected" : ""}>${t.sym}</option>`).join("")}</select></label></div>
      <div class="two"><label>amount <span id="lotBal" class="muted"></span><input name="amount" required inputmode="decimal" placeholder="1"></label>
      <label>reserve price (per token) <a href="#" id="suggest" style="text-transform:none">suggest</a><input name="reserve" id="reserveIn" required inputmode="decimal" placeholder="150"></label></div>
      <div class="two"><label>minimum sold (0 = sell any amount)<input name="minSold" inputmode="decimal" value="0"></label>
      <label>bond per bid ($WIF, min <span id="minb">50</span>)<input name="bond" id="bondIn" inputmode="decimal" value="50"></label></div>
      <div class="two">
      <label>your $WIF <span id="wifBal" class="muted"></span><input disabled value="listing burns 100"></label><span></span></div>
      <div class="two"><label>commit window (minutes)<input name="commitMin" type="number" min="5" value="60"></label>
      <label>reveal window (minutes)<input name="revealMin" type="number" min="5" value="30"></label></div>
      <p class="note" id="refNote"></p>
      <button class="btn" type="submit">List auction</button></form></div>
    <div class="card pad"><h2 class="sub">What happens</h2>
      <div class="kv"><span>listing fee</span><b>100 $WIF, burned</b></div>
      <div class="kv"><span>your lot</span><b>escrowed until settle</b></div>
      <div class="kv"><span>unsold amount</span><b>returned to you</b></div>
      <div class="kv"><span>nobody bids yet?</span><b>you can cancel</b></div>
      <div class="kv"><span>thin demand?</span><b>set a minimum sold</b></div>
      <div class="kv"><span>bond</span><b>raise it to price out griefers</b></div>
      <div class="kv"><span>reference price</span><b>Chainlink, recorded at settle</b></div>
      <p class="note" style="margin-top:12px">Right now US equities are in <b>${session()}</b>. List before the Friday close and settle over the weekend, while mint and burn are shut.</p></div></div>`;

  const preset = sessionStorage.getItem("tutup:list");
  if (preset && tokenOf(preset)) { $("lotSel").value = tokenOf(preset).addr; sessionStorage.removeItem("tutup:list"); }
  if (DEPLOYED) read("minBond").then((m) => { $("minb").textContent = fmt(m, 18, 0); $("bondIn").value = formatUnits(m, 18); }).catch(() => {});
  const refresh = async () => {
    const lot = $("lotSel").value, quote = $("quoteSel").value;
    $("refNote").textContent = "";
    if (account) {
      Promise.all([balanceOf(lot, account), balanceOf(WIF, account)]).then(([l, w]) => {
        $("lotBal").textContent = `· you have ${fmt(l, 18)}`;
        $("wifBal").textContent = `· you have ${fmt(w, 18, 0)}`;
      }).catch(() => {});
    }
    const t = tokenOf(lot);
    if (t && t.addr !== WIF) {
      const [r, qu] = await Promise.all([reference(t), quoteUsd(quote)]);
      refresh.suggest = r.best && qu ? (r.best.price / qu) * 0.97 : null;
      $("refNote").textContent = r.best ? `Reference ${usd(r.best.price)} from ${r.best.src}${r.closed ? ", and the official feed is frozen right now" : ""}. "Suggest" sets the reserve 3% under it.` : "No reference price for this token.";
    } else {
      const [w, qu] = await Promise.all([quoteUsd(WIF), quoteUsd(quote)]);
      refresh.suggest = w && qu ? (w / qu) * 0.97 : null;
      $("refNote").textContent = w ? `$WIF trades around ${usd(w)}. "Suggest" sets the reserve 3% under it.` : "";
    }
  };
  $("lotSel").onchange = $("quoteSel").onchange = refresh;
  $("suggest").onclick = (e) => { e.preventDefault(); if (refresh.suggest) $("reserveIn").value = refresh.suggest.toPrecision(6); };
  refresh();

  $("create").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    try {
      if (!DEPLOYED) throw new Error("contract not deployed yet");
      if (!account) await connect();
      const lot = f.get("lot"), quote = f.get("quote");
      if (lot === quote) throw new Error("lot and payment token must differ");
      const qd = await decimals(quote);
      const amount = parseUnits(f.get("amount"), 18);
      const reserve = parseUnits(f.get("reserve"), qd);
      const bond = parseUnits(f.get("bond"), 18);
      const minSold = parseUnits(f.get("minSold") || "0", 18);
      if (minSold > amount) throw new Error("minimum sold can't be more than the amount");
      const [fee, minBond] = await Promise.all([read("listFee"), read("minBond")]);
      if (bond < minBond) throw new Error(`bond must be at least ${fmt(minBond, 18, 0)} $WIF`);
      if (lot === WIF) await need(WIF, amount + fee, "Listing WIF");
      else { await need(lot, amount, "The lot"); await need(WIF, fee, "The listing fee"); }
      const t = tokenOf(lot);
      await ensureAllowance(lot, lot === WIF ? amount + fee : amount);
      if (lot !== WIF) await ensureAllowance(WIF, fee);
      await send("create", [lot, quote, amount, reserve, bond, minSold, BigInt(f.get("commitMin")) * 60n, BigInt(f.get("revealMin")) * 60n, t?.f7 || t?.f5 || NONE], "list auction");
      location.hash = `#a/${(await read("auctionCount")) - 1n}`;
    } catch (err) {
      toast(err.shortMessage || err.message, 9000);
    } finally {
      btn.disabled = false;
    }
  });
}

async function vMine() {
  await tokensReady;
  view.innerHTML = `<div class="head"><div><p class="eyebrow">balances · bids · payouts held for you</p><h1>My account</h1></div></div>
    <section class="stats" id="bals"></section><div id="owedBox"></div><div id="stocks"></div>
    <h2 class="sub" style="margin-top:6px">My sealed bids</h2><div class="card tablescroll" id="mine"><div class="empty">loading…</div></div>`;
  if (!account) { $("mine").innerHTML = `<div class="empty">Connect your wallet to see your account.</div>`; return; }
  const ethBal = await pub.getBalance({ address: account });
  const bals = await Promise.all(BASE_TOKENS.map((t) => balanceOf(t.addr, account).then((b) => [t, b]).catch(() => [t, 0n])));
  $("bals").innerHTML = `<div class="card stat"><div class="k">eth (gas)</div><div class="v">${fmt(ethBal, 18, 5)}</div></div>`
    + bals.map(([t, b]) => `<div class="card stat"><div class="k">${t.sym.toLowerCase()}</div><div class="v">${fmt(b, t.addr === USDG ? 6 : 18, 2)}</div></div>`).join("");

  qn("qn_getStockTokenBalances", [account]).then((r) => {
    if (!r) return;
    const h = (r.holdings || []).filter((x) => x.balanceRaw !== "0");
    $("stocks").innerHTML = `<h2 class="sub">My Stock Tokens <span class="muted" style="text-transform:none;letter-spacing:0">· Quicknode Stock Token API, in shares with multipliers applied</span></h2>
      <div class="card tablescroll" style="margin-bottom:16px">${h.length ? `<table><thead><tr><th>token</th><th>tokens</th><th>shares</th><th>value</th><th></th></tr></thead><tbody>
      ${h.map((x) => `<tr><td>${tok(x.token)}</td><td>${Number(x.balanceRaw) / 1e18}</td><td>${Number(x.balanceUiDecimal).toLocaleString(undefined, { maximumFractionDigits: 6 })}${x.pending ? ` <span class="badge b-reveal">corp action pending</span>` : ""}</td>
        <td>${x.valueUsd ? usd(Number(x.valueUsd)) : "–"}${x.priceStale ? ` <span class="badge b-closed">price stale</span>` : ""}</td><td><a class="btn ghost" href="#create" data-list="${x.token}">List this</a></td></tr>`).join("")}</tbody></table>`
      : `<div class="empty">No Robinhood Stock Tokens in this wallet.</div>`}</div>`;
    $("stocks").querySelectorAll("[data-list]").forEach((a) => (a.onclick = () => sessionStorage.setItem("tutup:list", a.dataset.list)));
  });

  if (DEPLOYED) {
    const owedLogs = await events("Owed", { to: account });
    const tokens = [...new Set(owedLogs.map((l) => l.args.token))];
    const owed = (await Promise.all(tokens.map(async (tk) => [tk, await read("owed", [tk, account])]))).filter(([, v]) => v > 0n);
    $("owedBox").innerHTML = owed.length ? `<div class="card pad" style="margin-bottom:16px"><h2 class="sub">Held for you</h2>${await Promise.all(owed.map(async ([tk, v]) =>
      `<div class="kv"><span>${fmt(v, await decimals(tk))} ${esc(sym(tk))}</span><b><button class="btn" data-claim="${tk}">Claim</button></b></div>`)).then((x) => x.join(""))}</div>` : "";
    $("owedBox").querySelectorAll("[data-claim]").forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try { await send("claim", [b.dataset.claim], "claim"); vMine(); } catch (err) { toast(err.shortMessage || err.message, 8000); b.disabled = false; }
    }));
  }

  const prefix = `tutup:${TUTUP}:`;
  const mine = Object.keys(localStorage).filter((k) => k.startsWith(prefix) && k.endsWith(account.toLowerCase()))
    .map((k) => ({ id: BigInt(k.slice(prefix.length).split(":")[0]), ...JSON.parse(localStorage.getItem(k)) }));
  if (!mine.length) { $("mine").innerHTML = `<div class="empty">No sealed bids from this browser yet. <a href="#auctions">Find an auction →</a></div>`; return; }
  const now = (await pub.getBlock()).timestamp;
  const rows = await Promise.all(mine.map(async (m) => ({ m, a: await loadAuction(m.id) })));
  $("mine").innerHTML = `<table><thead><tr><th>auction</th><th>lot</th><th>your bid</th><th>phase</th><th>next</th></tr></thead><tbody>
    ${rows.map(({ m, a }) => {
      const ph = phaseOf(a, now);
      const next = ph === "reveal" && !m.revealed ? "<b>reveal now</b>" : ph === "commit" ? `reveal in ${left(a.commitEnd, now)}` : ph === "settle" ? "settle" : m.revealed ? "done" : m.committed ? "bond burned" : "not sent";
      return `<tr class="click" tabindex="0" role="link" data-id="${a.id}"><td>#${a.id}</td><td>${tok(a.lot)}</td><td>${fmt(BigInt(m.qty), 18)} @ ${fmt(BigInt(m.price), a.qd)} ${esc(sym(a.quote))}</td>
        <td><span class="badge b-${ph}">${ph}</span></td><td>${next}</td></tr>`;
    }).join("")}</tbody></table>`;
  $("mine").querySelectorAll("tr[data-id]").forEach((r) => (r.onclick = () => (location.hash = `#a/${r.dataset.id}`)));
}

async function vMarket() {
  await tokensReady;
  view.innerHTML = `<div class="head"><div><p class="eyebrow">chainlink · lighter · quicknode · erc-8056 · robinhood</p><h1>Market hours</h1></div><span class="badge b-commit">US equities: ${session()}</span></div>
    <div class="callout" style="margin-bottom:14px">Official Stock Token feeds update 24/5. When one goes silent, or the token reports <code>oraclePaused()</code> during a corporate action, the market behind it is closed. That's when a Tutup auction finds a fairer price than a frozen feed. Lighter's onchain order book and Chainlink's 24/7 feeds show where trading actually is.</div>
    <div class="card tablescroll" id="mkt"><div class="empty">reading ${TOKENS.filter((t) => t.f5).length} feeds, order books and multipliers…</div></div>`;
  const list = TOKENS.filter((t) => t.f5);
  const health = await qn("qn_getOracleHealth", [{ symbols: list.map((t) => t.sym) }]);
  if (health) {
    const sq = health.sequencer?.operatorStatus?.status || health.sequencer?.status || "unknown";
    const nextAt = health.session?.nextChangeAt, mintAt = health.session?.nextMintWindowChangeAt;
    const now = BigInt(Math.floor(Date.now() / 1000));
    view.querySelector(".callout")?.insertAdjacentHTML("afterend", `<section class="stats">
      <div class="card stat"><div class="k">us session · quicknode</div><div class="v">${esc(sessionName(health))}</div>${nextAt ? `<div class="muted" style="font-size:11px">changes in ${countdown(BigInt(nextAt), now)}</div>` : ""}</div>
      <div class="card stat"><div class="k">robinhood mint window</div><div class="v">${health.session?.mintWindowOpen ? "open" : "closed"}</div>${mintAt ? `<div class="muted" style="font-size:11px">${health.session?.mintWindowOpen ? "closes" : "opens"} in ${countdown(BigInt(mintAt), now)}</div>` : ""}</div>
      <div class="card stat"><div class="k">sequencer</div><div class="v">${esc(String(sq).toLowerCase())}</div><div class="muted" style="font-size:11px">latest block ${health.sequencer?.latestBlockAgeSeconds ?? "?"}s old</div></div>
      <div class="card stat"><div class="k">feeds stale or paused</div><div class="v">${(health.feeds || []).filter((f) => f.status !== "OK" && f.status !== "NOT_CONFIGURED").length} / ${(health.feeds || []).filter((f) => f.status !== "NOT_CONFIGURED").length}</div><div class="muted" style="font-size:11px">"ok" = within the feed's heartbeat</div></div>
    </section>`);
  }
  const qnStatus = Object.fromEntries((health?.feeds || []).map((f) => [f.symbol, f.status]));
  const rows = await Promise.all(list.map(async (t) => ({ t, r: await reference(t) })));
  $("mkt").innerHTML = `<table><thead><tr><th>token</th><th>24/5 feed</th><th>age</th><th>24/7 feed</th><th>Lighter last</th><th>multiplier</th><th>status</th>${health ? "<th>quicknode feed state</th>" : ""}</tr></thead><tbody>
    ${rows.map(({ t, r }) => `<tr><td>${tok(t.addr)} <span class="muted">${esc(t.name)}</span></td><td>${usd(r.f5?.price)}</td><td>${r.f5 ? r.f5.ageH.toFixed(1) + "h" : "–"}</td>
      <td>${usd(r.f7?.price)}</td><td>${r.lt?.last ? usd(r.lt.last) + ` <span class="muted">${pct(r.lt.last, r.f5?.price)}</span>` : "–"}</td>
      <td>${r.st?.mult ? (Number(r.st.mult) / 1e18).toFixed(4) : "–"}${r.st?.pending ? ` <span class="badge b-reveal">pending</span>` : ""}</td>
      <td><span class="badge ${r.closed ? "b-closed" : "b-open"}">${r.st?.paused ? "corp action" : r.rh?.halt ? "halted" : r.closed ? "frozen" : "live"}</span></td>
      ${health ? `<td><span class="badge ${qnStatus[t.sym] === "OK" ? "b-open" : "b-closed"}">${esc((qnStatus[t.sym] || "–").toLowerCase().replace(/_/g, " "))}</span></td>` : ""}</tr>`).join("")}</tbody></table>`;
}

async function vPrints() {
  await tokensReady;
  view.innerHTML = `<div class="head"><div><p class="eyebrow">clearing prices vs chainlink at settle</p><h1>Weekend prints</h1></div></div>
    <div class="callout" style="margin-bottom:14px">Every sale writes <code>lastPrint(lot, quote)</code> on chain: the clearing price, the amount sold and when. Any contract can read it, so the price a sealed auction discovered while the market was shut becomes something a lending market or vault can use.</div>
    <div class="card tablescroll" id="prints"><div class="empty">loading…</div></div>
    <h2 class="sub" style="margin-top:22px">Chainlink-compatible feeds</h2>
    <div class="card tablescroll" id="pfeeds"><div class="empty">reading…</div></div>`;
  Promise.all(PRINT_FEEDS.map(async (f) => {
    const [round, answer, , at] = await pub.readContract({ address: f.addr, abi: feedAbi, functionName: "latestRoundData" }).catch(() => [null, null, null, null]);
    return `<tr><td>${esc(f.pair)}</td><td><a href="${EXPLORER}/address/${f.addr}" target="_blank" rel="noopener">${short(f.addr)}</a></td>
      <td>${answer != null ? (Number(answer) / 1e8).toPrecision(4) : "–"}</td><td>${round != null ? "#" + round : "–"}</td><td>${at ? new Date(Number(at) * 1000).toLocaleString() : "–"}</td></tr>`;
  })).then((rows) => ($("pfeeds").innerHTML = `<table><thead><tr><th>pair</th><th>TutupFeed</th><th>latestRoundData().answer</th><th>round = auction</th><th>updatedAt</th></tr></thead><tbody>${rows.join("")}</tbody></table>
    <p class="note" style="padding:0 14px 12px">Same interface as a Chainlink feed (<code>decimals() = 8</code>), so a lending market that reads Chainlink can read Tutup's weekend price with no new code. With no sale yet it reverts instead of answering 0.</p>`));
  if (!DEPLOYED) { $("prints").innerHTML = notDeployed; return; }
  const logs = await events("Settled");
  const sold = logs.filter((l) => l.args.sold > 0n).reverse();
  if (!sold.length) { $("prints").innerHTML = `<div class="empty">No prints yet. The first settled sale will appear here.</div>`; return; }
  const rows = await Promise.all(sold.map(async (l) => {
    const a = await loadAuction(l.args.id);
    const qu = await quoteUsd(a.quote);
    const clearUsd = qu ? Number(formatUnits(l.args.clearingPrice, a.qd)) * qu : null;
    const ref = l.args.refPrice > 0n ? Number(l.args.refPrice) / 1e8 : null;
    const blk = await pub.getBlock({ blockNumber: l.blockNumber });
    return `<tr class="click" tabindex="0" role="link" data-id="${a.id}"><td>#${a.id}</td><td>${new Date(Number(blk.timestamp) * 1000).toLocaleString()}</td><td>${tok(a.lot)}</td>
      <td>${fmt(l.args.clearingPrice, a.qd)} ${esc(sym(a.quote))}</td><td>${usd(clearUsd)}</td><td>${usd(ref)}</td><td>${pct(clearUsd, ref) || "–"}</td><td>${fmt(l.args.sold, 18)}</td></tr>`;
  }));
  $("prints").innerHTML = `<table><thead><tr><th>auction</th><th>settled</th><th>lot</th><th>clearing</th><th>in USD</th><th>Chainlink then</th><th>vs Chainlink</th><th>sold</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
  $("prints").querySelectorAll("tr[data-id]").forEach((r) => (r.onclick = () => (location.hash = `#a/${r.dataset.id}`)));
}

async function vBurns() {
  view.innerHTML = `<div class="head"><div><p class="eyebrow">every burn is on chain</p><h1>$WIF burns</h1></div></div>
    <section class="stats"><div class="card stat burn"><div class="k">total burned</div><div class="v" id="b-total">…</div></div>
    <div class="card stat"><div class="k">listing fee</div><div class="v">100</div></div><div class="card stat"><div class="k">min bond</div><div class="v" id="b-min">…</div></div>
    <div class="card stat"><div class="k">owner / admin</div><div class="v">none</div></div></section>
    <div class="card tablescroll" id="burns"><div class="empty">loading…</div></div>`;
  if (!DEPLOYED) { $("b-total").textContent = "–"; $("burns").innerHTML = notDeployed; return; }
  const [total, minBond, logs] = await Promise.all([read("totalBurned"), read("minBond"), events("Burned")]);
  $("b-total").textContent = fmt(total, 18, 0);
  $("b-min").textContent = fmt(minBond, 18, 0);
  $("burns").innerHTML = logs.length ? `<table><thead><tr><th>auction</th><th>amount</th><th>reason</th><th>tx</th></tr></thead><tbody>
    ${[...logs].reverse().map((l) => `<tr><td><a href="#a/${l.args.id}">#${l.args.id}</a></td><td><span class="badge b-burn">${fmt(l.args.amount, 18, 0)} $WIF</span></td>
      <td>${l.args.reason === "listing" ? "listing fee" : "unrevealed bond"}</td><td><a href="${EXPLORER}/tx/${l.transactionHash}" target="_blank" rel="noopener">${l.transactionHash.slice(0, 12)}…</a></td></tr>`).join("")}</tbody></table>`
    : `<div class="empty">No burns yet.</div>`;
}

async function vGetWif() {
  view.innerHTML = `<div class="head"><div><p class="eyebrow">relay · any chain to robinhood chain</p><h1>Get $WIF</h1></div></div>
    <div class="g2"><div class="card pad"><form id="relay" class="form">
      <div class="two"><label>pay with ETH on<select name="origin">${ORIGINS.map((c) => `<option value="${c.id}">${c.name}</option>`).join("")}</select></label>
      <label>amount of ETH<input name="amount" inputmode="decimal" value="0.0005"></label></div>
      <button class="btn ghost" type="button" id="quoteBtn">Get quote</button>
      <div id="quoteOut"></div>
      <button class="btn" type="submit" id="goBtn" disabled>Swap to $WIF</button></form></div>
    <div class="card pad"><h2 class="sub">How it works</h2><p class="note">Relay quotes a route from ETH on the chain you pick to $WIF on Robinhood Chain, delivered to the same address. You sign one transaction on the origin chain, a Relay solver fills it on Robinhood Chain in seconds, and this page tracks the request until it lands. Bonds and listing fees are paid in $WIF, so this is how a new bidder gets ready.</p>
      <div class="kv"><span>delivered to</span><b>${account ? short(account) : "your connected wallet"}</b></div>
      <div class="kv"><span>status API</span><b>/intents/status/v3</b></div></div></div>`;
  let quote, quoted;
  // Relay's own contracts per chain, plus its depository (it receives cross-chain deposits and isn't in /chains)
  const RELAY_DEPOSITORY = "0x4cd00e387622c35bddb9b4c962c136462338bc31";
  const relayContracts = fetch("https://api.relay.link/chains").then((r) => r.json()).then((d) => {
    const m = {};
    for (const c of d.chains || []) {
      const set = new Set([RELAY_DEPOSITORY]);
      const walk = (o) => Object.values(o || {}).forEach((v) => (typeof v === "string" ? /^0x[0-9a-fA-F]{40}$/.test(v) && set.add(v.toLowerCase()) : walk(v)));
      walk(c.contracts);
      m[c.id] = set;
    }
    return m;
  });
  // approve, transfer, transferFrom, permit, setApprovalForAll, increaseAllowance: never signed from a quote
  const FORBIDDEN = ["0x095ea7b3", "0xa9059cbb", "0x23b872dd", "0xd505accf", "0xa22cb465", "0x39509351"];
  const check = async (d) => {
    const allowed = (await relayContracts)[quoted.origin];
    if (d.chainId !== quoted.origin) throw new Error(`Relay asked to sign on chain ${d.chainId}, but you chose ${quoted.origin}`);
    if (!allowed?.has(String(d.to).toLowerCase())) throw new Error(`Relay asked to call ${d.to}, which isn't a Relay contract`);
    if (BigInt(d.value || 0) > quoted.amount) throw new Error("Relay asked for more ETH than you entered");
    if (FORBIDDEN.includes(String(d.data || "").slice(0, 10).toLowerCase())) throw new Error("Relay asked for a token approval or transfer; refusing");
  };
  const getQuote = async () => {
    if (!account) await connect();
    const f = new FormData($("relay"));
    const amount = parseUnits(f.get("amount"), 18).toString();
    $("quoteOut").innerHTML = `<p class="note">quoting…</p>`;
    const r = await fetch("https://api.relay.link/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      user: account, recipient: account, originChainId: Number(f.get("origin")), destinationChainId: 4663,
      originCurrency: NONE, destinationCurrency: WIF, amount, tradeType: "EXACT_INPUT" }) }).then((x) => x.json());
    if (!r.steps) throw new Error(r.message || "no route");
    quote = r;
    quoted = { origin: Number(f.get("origin")), amount: BigInt(amount) };
    const out = r.details?.currencyOut;
    $("quoteOut").innerHTML = `<div class="callout">You receive about <b>${Number(out.amountFormatted).toLocaleString(undefined, { maximumFractionDigits: 2 })} $WIF</b> (${usd(Number(out.amountUsd))}) on Robinhood Chain.<br>Fees ${usd(Number(r.fees?.relayer?.amountUsd || 0) + Number(r.fees?.gas?.amountUsd || 0))} · about ${r.details?.timeEstimate ?? "?"}s.</div>`;
    $("goBtn").disabled = false;
  };
  $("quoteBtn").onclick = () => getQuote().catch((e) => { $("quoteOut").innerHTML = `<div class="callout">Relay can't route this: ${esc(e.message)}</div>`; $("goBtn").disabled = true; });
  $("relay").onsubmit = async (e) => {
    e.preventDefault();
    $("goBtn").disabled = true;
    try {
      // check the whole quote before signing anything: every item, and the ETH they spend together
      const items = quote.steps.flatMap((st) => st.items.map((it) => ({ st, d: it.data })));
      if (quote.steps.some((st) => st.kind !== "transaction")) throw new Error("this route needs a signature step, which this page doesn't support");
      for (const { d } of items) await check(d);
      const total = items.reduce((t, { d }) => t + BigInt(d.value || 0), 0n);
      if (total > quoted.amount) throw new Error("Relay's route spends more ETH than you entered");
      for (const step of quote.steps) {
        for (const item of step.items) {
          const d = item.data;
          await check(d);
          const origin = ORIGINS.find((c) => c.id === quoted.origin);
          await switchTo(origin);
          toast(`${step.description || step.id}: confirm in your wallet…`, 60000);
          const oc = defineChain({ id: origin.id, name: origin.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [origin.rpc] } } });
          const w = createWalletClient({ account, chain: oc, transport: custom(provider) });
          const hash = await w.sendTransaction({ account, chain: oc, to: d.to, data: d.data, value: BigInt(d.value || 0) });
          toast(`sent ${hash.slice(0, 10)}… on ${origin.name}, waiting for Relay`, 60000);
        }
      }
      const id = quote.steps[0].requestId;
      for (let i = 0; i < 90; i++) {
        const s = await fetch(`https://api.relay.link/intents/status/v3?requestId=${id}`).then((x) => x.json());
        if (s.status === "success") { toast("$WIF arrived on Robinhood Chain ✓", 8000); break; }
        if (s.status === "refund" || s.status === "failure") throw new Error(`Relay ${s.status}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
      await switchTo(ORIGINS[0]);
      location.hash = "#mine";
    } catch (err) {
      toast(err.shortMessage || err.message, 9000);
      $("goBtn").disabled = false;
    }
  };
}

function vDocs() {
  view.innerHTML = `<div class="head"><div><p class="eyebrow">how tutup works</p><h1>Docs</h1></div></div>
    <div class="g2"><div class="card pad docs">
      <h2 class="sub">The problem</h2>
      <p>Stock Tokens on Robinhood Chain are ERC-20s that trade 24/7. Their official Chainlink feeds update 24/5, and Authorised Participants can only mint and burn from Monday 02:00 to Saturday 02:00 CET. On weekends and during corporate actions (<code>oraclePaused()</code>) nobody can arbitrage a token back to its share. Quotes go thin, and on a first-come-first-served sequencer the fastest bot sets the price.</p>
      <h2 class="sub">The mechanism</h2>
      <p><b>Commit.</b> Post <code>keccak256(abi.encode(id, bidder, qty, price, salt))</code> and the auction's $WIF bond. The page also downloads a receipt file, so you can reveal from any device.<br><b>Reveal.</b> Open the bid and escrow <code>qty × price</code>, and your bond comes back. If you never reveal, the bond is burned.<br><b>Settle.</b> Anyone can call it. Bids sort by price and ties break on <code>keccak256(id, bidder)</code>. The highest bids fill, and every winner pays the marginal (lowest winning) price. Losers are refunded and unsold lot returns to the seller.</p>
      <h2 class="sub">Safety</h2>
      <p>Every entry point shares one reentrancy lock, so no token callback can re-enter while escrow is pooled. Payouts that can't be delivered, for example to a frozen USDG account, are held in <code>owed</code> for <code>claim()</code>, so one bad recipient can't lock an auction. If demand doesn't reach the seller's <code>minSold</code>, nothing sells and every escrow comes back. Fee-on-transfer tokens are refused. Sellers can't bid in their own auction. Each seller sets the bond, at least the floor, so griefing a book of 64 bids costs whatever the seller decides. A seller can cancel only while nobody has bid.</p>
      <h2 class="sub">Prints</h2>
      <p>Every sale writes <code>lastPrint(lot, quote)</code>, the weekend price that sealed bids discovered, for any contract to read.</p>
      <h2 class="sub">$WIF</h2>
      <p>Each listing burns 100 $WIF through WIF's own <code>burn()</code>, and unrevealed bonds burn too. The bond is what makes a sealed bid credible: without it, a fake bid costs nothing. New bidders can get $WIF from any chain through Relay.</p>
      <h2 class="sub">Limits, honestly</h2>
      <p>An auction takes at most 64 bids, because they are sorted on chain. Bid sizes become public at reveal, but only after commits have closed. Robinhood Chain has no Chainlink sequencer-uptime feed, so prices are judged by staleness instead.</p>
      <h2 class="sub">For AI agents (MCP)</h2>
      <p>Tutup is also an MCP server: <code>claude mcp add --transport http tutup https://tutup.vercel.app/api/mcp</code>. Agents can call <code>list_auctions</code>, <code>get_auction</code>, <code>market_status</code> and <code>weekend_prints</code>, then <code>prepare_bid</code>, <code>prepare_reveal</code> and <code>prepare_settle</code>. Those return unsigned calls for the agent's own wallet, and the server never holds a key. An agent can watch the 24/5 feeds freeze and bid while people sleep.</p>
      <h2 class="sub">Quicknode</h2>
      <p>Reads go through our Quicknode Robinhood Chain endpoint first. Its Stock Token API add-on supplies the US session and Robinhood mint window (<code>qn_getOracleHealth</code>), wallet holdings in shares (<code>qn_getStockTokenBalances</code>), split and dividend history (<code>qn_getCorporateActions</code>) and how final a settlement is on Ethereum (<code>qn_getTransactionFinality</code>). The MCP server exposes them to agents too. The endpoint key stays server-side.</p>
      <h2 class="sub">Onchain agent identity (ERC-8004)</h2>
      <p>Tutup's MCP server is registered in the ERC-8004 IdentityRegistry on Robinhood Chain (<code>0x8004A169…a432</code>) as <b>agent #25584</b>. Its registration file (<a href="/agent.json" target="_blank" rel="noopener">agent.json</a>) lists the MCP endpoint, so other agents can find it onchain and check its reputation.</p>
      <h2 class="sub">Uniswap v3 as the alternative</h2>
      <p>Stock Tokens have deep Uniswap v3 and v4 pools on Robinhood Chain. Each auction shows what selling the same lot into the pool would return now (QuoterV2), next to Lighter's order book and Chainlink. The NVDA lot in auction #2 was bought through that pool.</p>
      <h2 class="sub">Keeper agent</h2>
      <p>A Vercel Cron job runs Tutup's own agent (<code>/api/keeper</code>, wallet <code>${short(KEEPER)}</code>) twice a day. It settles every auction whose reveals have closed, so no lot waits for a human. On the house's own listings it also bids by a public rule (the whole lot at reserve + 5%) when its wallet can fund it. It skips strangers' lots, reveal windows its schedule could miss, and bonds over 50 WIF, and reveals with a salt derived from its key and the auction id, so it never loses a salt. Its bids show as "Tutup agent" in the book. They are the house's bids, not outside demand.</p>
      <h2 class="sub">Composability</h2>
      <p><code>TutupFeed</code> serves a pair's <code>lastPrint</code> behind Chainlink's <code>AggregatorV3Interface</code>, so any protocol that already reads a Chainlink feed can use the weekend price that sealed bids discovered.</p>
      <h2 class="sub">Prior art</h2>
      <p>The uniform clearing price follows batch auctions like Gnosis EasyAuction and CoW. The commit–reveal bond is the classic sealed-bid answer when a chain has no private compute.</p>
    </div>
    <div class="card pad"><h2 class="sub">Contract</h2>
      <div class="kv"><span>Tutup</span><b>${DEPLOYED ? `<a href="${EXPLORER}/address/${TUTUP}" target="_blank" rel="noopener">${short(TUTUP)}</a>` : "deploying"}</b></div>
      ${PAST.map(([v, addr]) => `<div class="kv"><span>${v} (auction #0 settled)</span><b><a href="${EXPLORER}/address/${addr}" target="_blank" rel="noopener">${short(addr)}</a></b></div>`).join("")}
      <div class="kv"><span>verified</span><b><a href="https://repo.sourcify.dev/4663/${TUTUP}" target="_blank" rel="noopener">Sourcify</a></b></div>
      <div class="kv"><span>owner</span><b>none</b></div><div class="kv"><span>upgradeable</span><b>no</b></div>
      <div class="kv"><span>$WIF</span><b><a href="${EXPLORER}/token/${WIF}" target="_blank" rel="noopener">${short(WIF)}</a></b></div>
      <div class="kv"><span>chain</span><b>Robinhood Chain · 4663</b></div>
      <div class="kv"><span>min phase</span><b>5 minutes</b></div><div class="kv"><span>max bids</span><b>64</b></div>
      <div class="kv"><span>stock tokens listed</span><b>${TOKENS.length - BASE_TOKENS.length}</b></div>
      ${PRINT_FEEDS.map((f) => `<div class="kv"><span>TutupFeed ${esc(f.pair)}</span><b><a href="${EXPLORER}/address/${f.addr}" target="_blank" rel="noopener">${short(f.addr)}</a></b></div>`).join("")}
      <div class="kv"><span>MCP endpoint</span><b>/api/mcp</b></div>
      <div class="kv"><span>ERC-8004 agent</span><b><a href="${EXPLORER}/token/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432/instance/25584" target="_blank" rel="noopener">#25584</a></b></div>
      <div class="kv"><span>source</span><b><a href="https://github.com/PugarHuda/tutup" target="_blank" rel="noopener">github</a></b></div>
    </div></div>
    <p class="foot">Not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc. Stock Tokens are not available to U.S. persons or in restricted jurisdictions.</p>`;
}

// --- router ---

addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches?.("tr.click[data-id]")) e.target.click(); });

function route() {
  const h = location.hash.slice(1) || "auctions";
  const m = h.match(/^a\/(\d+)$/);
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.view === (m ? "auctions" : h)));
  const run = m ? vAuction(BigInt(m[1])) : ({ create: vCreate, mine: vMine, market: vMarket, prints: vPrints, burns: vBurns, wif: vGetWif, docs: vDocs }[h] || vAuctions)();
  Promise.resolve(run).catch((e) => { console.error(e); toast(e.shortMessage || e.message, 8000); });
}

$("connect").addEventListener("click", () => connect().catch((e) => toast(e.message)));
if (RPC !== DEFAULT.rpc) $("net").textContent = "local fork · " + short(TUTUP) + " · " + RPC.replace(/^https?:\/\//, "");
addEventListener("hashchange", route);
route(); // render now; only views that list Stock Tokens wait for the registry
// ponytail: refresh live views on a timer; forms and long reads are left alone
setInterval(() => { if (["", "#auctions", "#burns"].includes(location.hash) || /^#a\/\d+$/.test(location.hash)) { if (!document.querySelector("input:focus, select:focus")) route(); } }, 30000);
