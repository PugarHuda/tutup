import {
  createPublicClient, createWalletClient, custom, http, defineChain, parseAbi,
  formatUnits, parseUnits, keccak256, encodeAbiParameters, toHex, maxUint256,
} from "./viem.js"; // viem 2.21.0, bundled locally

// set after deploy
const TUTUP = "0x0000000000000000000000000000000000000000";
const FROM_BLOCK = 0n;

const chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

// lot tokens are all 18 decimals; feed = Chainlink reference recorded at settlement (24/7 where it exists)
const TOKENS = [
  { sym: "NVDA", addr: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", feed: "0x321A36e441DfBadA01Aa6f9884F14a344E133D1F", lot: true },
  { sym: "TSLA", addr: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", feed: "0x39eDf5ef54150A30d2C4F1b982FbB8f93050BC37", lot: true },
  { sym: "SPY", addr: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", feed: "0x319724394D3A0e3669269846abE664Cd621f9f6A", lot: true },
  { sym: "AAPL", addr: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", feed: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0", lot: true },
  { sym: "AMZN", addr: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", feed: "0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C", lot: true },
  { sym: "QQQ", addr: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68", feed: "0x80901d846d5D7B030F26B480776EE3b29374C2ae", lot: true },
  { sym: "MSFT", addr: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", feed: "0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E", lot: true },
  { sym: "WIF", addr: "0x5173b8eA6923c2d40267890D45C46a3480954773", feed: "0x0000000000000000000000000000000000000000", lot: true, quote: true },
  { sym: "USDG", addr: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", quote: true },
  { sym: "WETH", addr: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", quote: true },
];
const WIF = TOKENS.find((t) => t.sym === "WIF").addr;
const NVDA_24_5 = "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15";
const NVDA_24_7 = "0x321A36e441DfBadA01Aa6f9884F14a344E133D1F";

const abi = parseAbi([
  "function auctionCount() view returns (uint256)",
  "function totalBurned() view returns (uint256)",
  "function listFee() view returns (uint256)",
  "function bond() view returns (uint256)",
  "function auctions(uint256) view returns (address seller, address lot, address quote, address feed, uint128 lotAmount, uint128 reserve, uint64 commitEnd, uint64 revealEnd, uint32 commits, uint32 reveals, bool settled)",
  "function commitOf(uint256, address) view returns (bytes32)",
  "function create(address lot, address quote, uint128 lotAmount, uint128 reserve, uint64 commitDuration, uint64 revealDuration, address feed) returns (uint256)",
  "function commit(uint256 id, bytes32 hash)",
  "function reveal(uint256 id, uint128 qty, uint128 price, bytes32 salt)",
  "function settle(uint256 id)",
  "event Settled(uint256 indexed id, uint256 clearingPrice, uint256 sold, uint256 proceeds, int256 refPrice, uint256 refUpdatedAt)",
]);
const erc20 = parseAbi([
  "function decimals() view returns (uint8)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
]);
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);

const pub = createPublicClient({ chain, transport: http() });
let wallet, account;
const $ = (id) => document.getElementById(id);
const sym = (a) => TOKENS.find((t) => t.addr.toLowerCase() === a.toLowerCase())?.sym || a.slice(0, 8);
const decCache = {};
const decimals = async (a) => (decCache[a] ??= await pub.readContract({ address: a, abi: erc20, functionName: "decimals" }));
const fmt = (v, d, max = 4) => Number(formatUnits(v, d)).toLocaleString(undefined, { maximumFractionDigits: max });

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
  const hash = await wallet.writeContract({ address: token, abi: erc20, functionName: "approve", args: [TUTUP, maxUint256], account, chain });
  await pub.waitForTransactionReceipt({ hash });
}

async function connect() {
  if (!window.ethereum) throw new Error("no wallet found");
  wallet = createWalletClient({ chain, transport: custom(window.ethereum) });
  [account] = await wallet.requestAddresses();
  try { await wallet.switchChain({ id: chain.id }); } catch { await wallet.addChain({ chain }); }
  $("connect").textContent = account.slice(0, 6) + "…" + account.slice(-4);
  render();
}

async function readFeed(addr) {
  const [, p, , at] = await pub.readContract({ address: addr, abi: feedAbi, functionName: "latestRoundData" });
  return { price: Number(p) / 1e8, ageH: (Date.now() / 1000 - Number(at)) / 3600 };
}

async function stats() {
  const [n5, n7] = await Promise.all([readFeed(NVDA_24_5), readFeed(NVDA_24_7)]);
  $("s-nvda5").textContent = "$" + n5.price.toFixed(2);
  $("s-nvda7").textContent = "$" + n7.price.toFixed(2);
  // ponytail: "closed" = the official feed hasn't moved for 2h; good enough for a badge
  const closed = n5.ageH > 2;
  $("s-mkt").innerHTML = `<span class="badge ${closed ? "closed" : "open"}">${closed ? "market closed · feed " + n5.ageH.toFixed(1) + "h old" : "market open"}</span>`;
  if (/^0x0+$/.test(TUTUP)) { $("s-burned").textContent = "–"; $("s-count").textContent = "–"; return 0n; }
  const [burned, count] = await Promise.all([
    pub.readContract({ address: TUTUP, abi, functionName: "totalBurned" }),
    pub.readContract({ address: TUTUP, abi, functionName: "auctionCount" }),
  ]);
  $("s-burned").textContent = fmt(burned, 18, 0);
  $("s-count").textContent = count.toString();
  return count;
}

function phase(a, now) {
  if (a.settled) return "settled";
  if (now < a.commitEnd) return "commit";
  if (now < a.revealEnd) return "reveal";
  return "settle";
}

const left = (t, now) => {
  const s = Number(t - now);
  return s > 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

async function card(id, now, settledLogs) {
  const r = await pub.readContract({ address: TUTUP, abi, functionName: "auctions", args: [id] });
  const [seller, lot, quote, feed, lotAmount, reserve, commitEnd, revealEnd, commits, reveals, settled] = r;
  const a = { seller, lot, quote, feed, lotAmount, reserve, commitEnd, revealEnd, commits, reveals, settled };
  const qd = await decimals(quote);
  const ph = phase(a, now);
  const el = document.createElement("div");
  el.className = "card";
  const key = `tutup:${TUTUP}:${id}:${account || ""}`;
  const saved = account && JSON.parse(localStorage.getItem(key) || "null");
  const log = settledLogs.find((l) => l.args.id === id);

  let body = `
    <div class="top"><span class="lot">${fmt(lotAmount, 18)} ${sym(lot)}</span><span class="badge">${ph}</span></div>
    <div class="row">auction <b>#${id}</b></div>
    <div class="row">reserve <b>${fmt(reserve, qd)} ${sym(quote)}</b></div>
    <div class="row">sealed bids <b>${commits}</b></div>`;
  if (ph === "commit") body += `<div class="row">commits close in <b>${left(commitEnd, now)}</b></div>`;
  if (ph === "reveal") body += `<div class="row">reveals close in <b>${left(revealEnd, now)}</b></div><div class="row">revealed <b>${reveals}/${commits}</b></div>`;
  if (log) {
    const { clearingPrice, sold, refPrice } = log.args;
    body += `<div class="row">cleared at <b>${fmt(clearingPrice, qd)} ${sym(quote)}</b></div>
      <div class="row">sold <b>${fmt(sold, 18)} ${sym(lot)}</b></div>
      ${refPrice > 0n ? `<div class="row">Chainlink at settle <b>$${(Number(refPrice) / 1e8).toFixed(2)}</b></div>` : ""}
      <div class="row">unrevealed bonds burned <b>${commits - reveals}</b></div>`;
  }

  if (ph === "commit" && !(saved && saved.committed)) {
    body += `<div class="form"><div class="two">
      <label>quantity<input data-q placeholder="0.5" inputmode="decimal" /></label>
      <label>your price (${sym(quote)})<input data-p placeholder="${fmt(reserve, qd)}" inputmode="decimal" /></label></div>
      <button class="primary" data-act="commit">seal bid · 50 $WIF bond</button></div>`;
  } else if (ph === "commit") {
    body += `<p class="muted" style="margin:0">Your bid is sealed. Come back to reveal after commits close.</p>`;
  }
  if (ph === "reveal" && saved && !saved.revealed) body += `<button class="primary" data-act="reveal">reveal my bid</button>`;
  if (ph === "settle") body += `<button class="primary" data-act="settle">settle</button>`;
  el.innerHTML = body;

  el.addEventListener("click", async (e) => {
    const act = e.target.dataset?.act;
    if (!act) return;
    e.target.disabled = true;
    try {
      if (!account) await connect();
      if (act === "commit") {
        const qty = parseUnits(el.querySelector("[data-q]").value, 18);
        const price = parseUnits(el.querySelector("[data-p]").value, qd);
        const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
        const hash = keccak256(encodeAbiParameters(
          [{ type: "uint256" }, { type: "address" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes32" }],
          [id, account, qty, price, salt]));
        // save before sending: losing the salt means losing the bond
        const k = `tutup:${TUTUP}:${id}:${account}`;
        localStorage.setItem(k, JSON.stringify({ qty: qty.toString(), price: price.toString(), salt }));
        const bond = await pub.readContract({ address: TUTUP, abi, functionName: "bond" });
        await ensureAllowance(WIF, bond);
        await send("commit", [id, hash], "seal bid");
        localStorage.setItem(k, JSON.stringify({ qty: qty.toString(), price: price.toString(), salt, committed: true }));
      }
      if (act === "reveal") {
        const qty = BigInt(saved.qty), price = BigInt(saved.price);
        await ensureAllowance(quote, (qty * price + 10n ** 18n - 1n) / 10n ** 18n);
        await send("reveal", [id, qty, price, saved.salt], "reveal");
        localStorage.setItem(key, JSON.stringify({ ...saved, revealed: true }));
      }
      if (act === "settle") await send("settle", [id], "settle");
      render();
    } catch (err) {
      toast(err.shortMessage || err.message, 8000);
      e.target.disabled = false;
    }
  });
  return el;
}

async function render() {
  const count = await stats().catch((e) => (console.error(e), 0n));
  const box = $("auctions");
  if (!count) { box.innerHTML = `<p class="muted">No auctions yet. List the first lot below.</p>`; return; }
  const now = BigInt(Math.floor(Date.now() / 1000));
  const logs = await pub.getContractEvents({ address: TUTUP, abi, eventName: "Settled", fromBlock: FROM_BLOCK }).catch(() => []);
  const ids = [...Array(Number(count)).keys()].reverse().map(BigInt);
  const cards = await Promise.all(ids.map((id) => card(id, now, logs)));
  box.replaceChildren(...cards);
}

function setupForm() {
  $("lot").innerHTML = TOKENS.filter((t) => t.lot).map((t) => `<option value="${t.addr}">${t.sym}</option>`).join("");
  $("quote").innerHTML = TOKENS.filter((t) => t.quote).map((t) => `<option value="${t.addr}" ${t.sym === "USDG" ? "selected" : ""}>${t.sym}</option>`).join("");
  $("create").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    try {
      if (!account) await connect();
      const lot = f.get("lot"), quote = f.get("quote");
      if (lot === quote) throw new Error("lot and payment token must differ");
      const qd = await decimals(quote);
      const amount = parseUnits(f.get("amount"), 18);
      const reserve = parseUnits(f.get("reserve"), qd);
      const feed = TOKENS.find((t) => t.addr === lot).feed;
      const fee = await pub.readContract({ address: TUTUP, abi, functionName: "listFee" });
      await ensureAllowance(lot, amount);
      await ensureAllowance(WIF, lot === WIF ? amount + fee : fee);
      await send("create", [lot, quote, amount, reserve, BigInt(f.get("commitMin")) * 60n, BigInt(f.get("revealMin")) * 60n, feed], "list auction");
      render();
    } catch (err) {
      toast(err.shortMessage || err.message, 8000);
    } finally {
      btn.disabled = false;
    }
  });
}

$("connect").addEventListener("click", () => connect().catch((e) => toast(e.message)));
$("c-link").textContent = TUTUP.slice(0, 10) + "…";
$("c-link").href = `${chain.blockExplorers.default.url}/address/${TUTUP}`;
setupForm();
render();
setInterval(render, 30000);
