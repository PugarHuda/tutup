import {
  createPublicClient, createWalletClient, custom, http, defineChain, parseAbi,
  formatUnits, parseUnits, keccak256, encodeAbiParameters, toHex,
} from "./viem.js"; // viem 2.21.0, bundled locally

// Production values, set after deploy. On localhost only, ?rpc=…&tutup=0x…&from=N points the page at a local fork:
// a link to the live site must never be able to swap the contract the page asks people to approve.
const DEFAULT = { rpc: "https://rpc.mainnet.chain.robinhood.com", tutup: "0x0000000000000000000000000000000000000000", from: "0" };
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

// lot tokens are all 18 decimals. f5 = official 24/5 feed, f7 = 24/7 feed where Chainlink has one.
const TOKENS = [
  { sym: "NVDA", addr: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", f5: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", f7: "0x321A36e441DfBadA01Aa6f9884F14a344E133D1F", lot: true },
  { sym: "TSLA", addr: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", f5: "0x4A1166a659A55625345e9515b32adECea5547C38", f7: "0x39eDf5ef54150A30d2C4F1b982FbB8f93050BC37", lot: true },
  { sym: "SPY", addr: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", f5: "0x319724394D3A0e3669269846abE664Cd621f9f6A", lot: true },
  { sym: "AAPL", addr: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", f5: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0", lot: true },
  { sym: "AMZN", addr: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", f5: "0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C", lot: true },
  { sym: "QQQ", addr: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68", f5: "0x80901d846d5D7B030F26B480776EE3b29374C2ae", lot: true },
  { sym: "MSFT", addr: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", f5: "0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E", lot: true },
  { sym: "WIF", addr: "0x5173b8eA6923c2d40267890D45C46a3480954773", lot: true, quote: true },
  { sym: "USDG", addr: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", quote: true },
  { sym: "WETH", addr: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", quote: true },
];
const WIF = TOKENS.find((t) => t.sym === "WIF").addr;
const NONE = "0x0000000000000000000000000000000000000000";

const abi = parseAbi([
  "function auctionCount() view returns (uint256)",
  "function totalBurned() view returns (uint256)",
  "function listFee() view returns (uint256)",
  "function bond() view returns (uint256)",
  "function auctions(uint256) view returns (address seller, address lot, address quote, address feed, uint128 lotAmount, uint128 reserve, uint64 commitEnd, uint64 revealEnd, uint32 commits, uint32 reveals, bool settled)",
  "function bids(uint256) view returns ((address bidder, uint128 qty, uint128 price)[])",
  "function create(address lot, address quote, uint128 lotAmount, uint128 reserve, uint64 commitDuration, uint64 revealDuration, address feed) returns (uint256)",
  "function commit(uint256 id, bytes32 hash)",
  "function reveal(uint256 id, uint128 qty, uint128 price, bytes32 salt)",
  "function settle(uint256 id)",
  "event Settled(uint256 indexed id, uint256 clearingPrice, uint256 sold, uint256 proceeds, int256 refPrice, uint256 refUpdatedAt)",
  "event Filled(uint256 indexed id, address indexed bidder, uint256 qty, uint256 paid)",
  "event Burned(uint256 indexed id, uint256 amount, string reason)",
]);
const erc20 = parseAbi([
  "function decimals() view returns (uint8)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
]);
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);

const pub = createPublicClient({ chain, transport: http(RPC) });
let wallet, account;
const $ = (id) => document.getElementById(id);
const view = $("view");
const sym = (a) => TOKENS.find((t) => t.addr.toLowerCase() === a.toLowerCase())?.sym || a.slice(0, 8);
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const decCache = {};
const decimals = async (a) => (decCache[a] ??= await pub.readContract({ address: a, abi: erc20, functionName: "decimals" }));
const fmt = (v, d, max = 4) => Number(formatUnits(v, d)).toLocaleString(undefined, { maximumFractionDigits: max });
const tok = (a) => `<span class="tok"><i>${sym(a).slice(0, 4)}</i>${sym(a)}</span>`;
const read = (functionName, args = []) => pub.readContract({ address: TUTUP, abi, functionName, args });
const saveKey = (id, who) => `tutup:${TUTUP}:${id}:${who}`;

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

async function connect() {
  if (!window.ethereum) throw new Error("no wallet found");
  wallet = createWalletClient({ chain, transport: custom(window.ethereum) });
  [account] = await wallet.requestAddresses();
  try { await wallet.switchChain({ id: chain.id }); } catch { await wallet.addChain({ chain }); }
  $("connect").textContent = short(account);
  route();
}

async function readFeed(addr) {
  const [, p, , at] = await pub.readContract({ address: addr, abi: feedAbi, functionName: "latestRoundData" });
  return { price: Number(p) / 1e8, ageH: (Date.now() / 1000 - Number(at)) / 3600 };
}

// --- data ---

function phaseOf(a, now) {
  if (a.settled) return "settled";
  if (now < a.commitEnd) return "commit";
  if (now < a.revealEnd) return "reveal";
  return "settle";
}

const left = (t, now) => {
  const s = Number(t - now);
  if (s <= 0) return "–";
  return s > 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

async function loadAuction(id) {
  const [seller, lot, quote, feed, lotAmount, reserve, commitEnd, revealEnd, commits, reveals, settled] = await read("auctions", [id]);
  return { id, seller, lot, quote, feed, lotAmount, reserve, commitEnd, revealEnd, commits, reveals, settled, qd: await decimals(quote) };
}

async function loadAll() {
  const [count, now] = await Promise.all([read("auctionCount"), pub.getBlock().then((b) => b.timestamp)]);
  const ids = [...Array(Number(count)).keys()].reverse().map(BigInt);
  const list = await Promise.all(ids.map(loadAuction));
  return { now, list };
}

const events = (eventName, args) =>
  pub.getContractEvents({ address: TUTUP, abi, eventName, args, fromBlock: FROM_BLOCK }).catch(() => []);

// --- views ---

const notDeployed = `<div class="card empty">The contract address isn't set yet. Auctions will appear here once Tutup is live on mainnet.</div>`;

async function vAuctions(filter = "all") {
  view.innerHTML = `<div class="head"><div><p class="eyebrow">sealed-bid batch auctions · one clearing price</p><h1>Auctions</h1></div>
    <div class="tabs">${["all", "live", "settled"].map((f) => `<button class="tab ${f === filter ? "on" : ""}" data-f="${f}">${f}</button>`).join("")}</div></div>
    <section class="stats">
      <div class="card stat burn"><div class="k">$wif burned</div><div class="v" id="s-burned">…</div></div>
      <div class="card stat"><div class="k">auctions</div><div class="v" id="s-count">…</div></div>
      <div class="card stat"><div class="k">nvda · 24/5 feed</div><div class="v" id="s-n5">…</div><div id="s-mkt"></div></div>
      <div class="card stat"><div class="k">nvda · 24/7 feed</div><div class="v" id="s-n7">…</div></div>
    </section>
    <div class="card tablescroll" id="tbl"><div class="empty">loading…</div></div>`;
  view.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => vAuctions(b.dataset.f)));

  const nv = TOKENS[0];
  Promise.all([readFeed(nv.f5), readFeed(nv.f7)]).then(([a, b]) => {
    $("s-n5").textContent = "$" + a.price.toFixed(2);
    $("s-n7").textContent = "$" + b.price.toFixed(2);
    const closed = a.ageH > 2; // ponytail: "closed" = official feed silent for 2h
    $("s-mkt").innerHTML = `<span class="badge ${closed ? "b-closed" : "b-open"}">${closed ? `market closed · ${a.ageH.toFixed(1)}h` : "market open"}</span>`;
  }).catch(() => {});

  if (!DEPLOYED) { $("s-burned").textContent = "–"; $("s-count").textContent = "–"; $("tbl").innerHTML = notDeployed; return; }
  const [burned, { now, list }] = await Promise.all([read("totalBurned"), loadAll()]);
  $("s-burned").textContent = fmt(burned, 18, 0);
  $("s-count").textContent = list.length;
  const rows = list.filter((a) => filter === "all" || (filter === "settled") === a.settled);
  if (!rows.length) { $("tbl").innerHTML = `<div class="empty">No auctions here yet. <a href="#create">List the first lot →</a></div>`; return; }
  $("tbl").innerHTML = `<table><thead><tr><th>auction</th><th>lot → paid in</th><th>size</th><th>reserve</th><th>sealed bids</th><th>phase</th><th>closes in</th></tr></thead><tbody>
    ${rows.map((a) => {
      const ph = phaseOf(a, now);
      const end = ph === "commit" ? a.commitEnd : a.revealEnd;
      return `<tr class="click" data-id="${a.id}"><td>#${a.id}</td><td>${tok(a.lot)}<span class="arrow">→</span>${tok(a.quote)}</td>
        <td>${fmt(a.lotAmount, 18)}</td><td>${fmt(a.reserve, a.qd)} ${sym(a.quote)}</td><td>${a.commits}</td>
        <td><span class="badge b-${ph}">${ph}</span></td><td>${ph === "settled" ? "–" : left(end, now)}</td></tr>`;
    }).join("")}</tbody></table>`;
  $("tbl").querySelectorAll("tr[data-id]").forEach((r) => (r.onclick = () => (location.hash = `#a/${r.dataset.id}`)));
}

async function vAuction(id) {
  view.innerHTML = `<div class="card empty">loading auction #${id}…</div>`;
  if (!DEPLOYED) { view.innerHTML = notDeployed; return; }
  const [a, now] = await Promise.all([loadAuction(id), pub.getBlock().then((b) => b.timestamp)]);
  const ph = phaseOf(a, now);
  const saved = account && JSON.parse(localStorage.getItem(saveKey(id, account)) || "null");
  const steps = ["commit", "reveal", "settle", "settled"];
  const idx = steps.indexOf(ph);

  let action = "";
  if (ph === "commit" && !(saved && saved.committed)) {
    action = `<h3>Seal a bid</h3><div class="form">
      <div class="two"><label>quantity (${sym(a.lot)})<input id="qty" placeholder="0.5" inputmode="decimal"></label>
      <label>your price (${sym(a.quote)} each)<input id="price" placeholder="${fmt(a.reserve, a.qd)}" inputmode="decimal"></label></div>
      <p class="note">Posts a 50 $WIF bond. Your quantity, price and salt are saved in this browser only. Lose them and you can't reveal, and the bond burns.</p>
      <button class="btn" data-act="commit">Seal bid · 50 $WIF bond</button></div>`;
  } else if (ph === "commit") {
    action = `<h3>Your bid</h3><div class="callout">Sealed: ${fmt(BigInt(saved.qty), 18)} ${sym(a.lot)} at ${fmt(BigInt(saved.price), a.qd)} ${sym(a.quote)}. Come back to reveal in ${left(a.commitEnd, now)}.</div>`;
  } else if (ph === "reveal" && saved && !saved.revealed) {
    action = `<h3>Reveal</h3><div class="form"><div class="callout">You sealed ${fmt(BigInt(saved.qty), 18)} ${sym(a.lot)} at ${fmt(BigInt(saved.price), a.qd)} ${sym(a.quote)}. Revealing escrows payment and returns your bond.</div>
      <button class="btn" data-act="reveal">Reveal my bid</button></div>`;
  } else if (ph === "reveal") {
    action = `<h3>Reveal phase</h3><p class="note">${saved ? "Your bid is revealed." : "Bidding is closed. Bidders are opening their bids."} Settlement opens in ${left(a.revealEnd, now)}.</p>`;
  } else if (ph === "settle") {
    action = `<h3>Ready to settle</h3><div class="form"><p class="note">Anyone can settle. Highest bids fill first and all winners pay the lowest winning price.</p><button class="btn" data-act="settle">Settle auction</button></div>`;
  }

  view.innerHTML = `<div class="head"><div><p class="eyebrow"><a href="#auctions">← auctions</a></p><h1>Auction #${id}</h1></div><span class="badge b-${ph}">${ph}</span></div>
    <div class="g2">
      <div class="card pad">
        <div class="timeline">${steps.map((s, i) => `<div class="${i < idx ? "done" : i === idx ? "now" : ""}">${s}</div>`).join("")}</div>
        <div class="kv"><span>lot</span><b>${fmt(a.lotAmount, 18)} ${sym(a.lot)}</b></div>
        <div class="kv"><span>paid in</span><b>${sym(a.quote)}</b></div>
        <div class="kv"><span>reserve</span><b>${fmt(a.reserve, a.qd)} ${sym(a.quote)}</b></div>
        <div class="kv"><span>seller</span><b><a href="${EXPLORER}/address/${a.seller}" target="_blank" rel="noopener">${short(a.seller)}</a></b></div>
        <div class="kv"><span>sealed bids</span><b>${a.commits}</b></div>
        <div class="kv"><span>revealed</span><b>${a.reveals}</b></div>
        <div class="kv"><span>commits close</span><b>${new Date(Number(a.commitEnd) * 1000).toLocaleString()}</b></div>
        <div class="kv"><span>reveals close</span><b>${new Date(Number(a.revealEnd) * 1000).toLocaleString()}</b></div>
        <div id="result"></div>
      </div>
      <div class="card pad" id="act">${action || `<h3>Settled</h3><p class="note">This auction is closed.</p>`}</div>
    </div>
    <h3 style="margin-top:22px">Bid book</h3>
    <div class="card tablescroll" id="book"><div class="empty">${ph === "commit" ? "Bids are sealed. Nothing is visible until commits close." : "loading…"}</div></div>`;

  if (ph !== "commit") {
    const [bids, settledLogs, fills] = await Promise.all([read("bids", [id]), events("Settled", { id }), events("Filled", { id })]);
    const s = settledLogs[0]?.args;
    if (s) {
      $("result").innerHTML = `<div class="kv"><span>clearing price</span><b>${fmt(s.clearingPrice, a.qd)} ${sym(a.quote)}</b></div>
        <div class="kv"><span>sold</span><b>${fmt(s.sold, 18)} ${sym(a.lot)}</b></div>
        <div class="kv"><span>proceeds to seller</span><b>${fmt(s.proceeds, a.qd)} ${sym(a.quote)}</b></div>
        ${s.refPrice > 0n ? `<div class="kv"><span>Chainlink at settle</span><b>$${(Number(s.refPrice) / 1e8).toFixed(2)}</b></div>` : ""}
        <div class="kv"><span>unrevealed bonds burned</span><b>${a.commits - a.reveals}</b></div>`;
    }
    const filled = Object.fromEntries(fills.map((f) => [f.args.bidder.toLowerCase(), f.args]));
    const sorted = [...bids].sort((x, y) => (y.price > x.price ? 1 : y.price < x.price ? -1 : 0));
    $("book").innerHTML = sorted.length ? `<table><thead><tr><th>bidder</th><th>quantity</th><th>bid price</th>${s ? "<th>filled</th><th>paid</th><th>result</th>" : ""}</tr></thead><tbody>
      ${sorted.map((b) => {
        const f = filled[b.bidder.toLowerCase()];
        return `<tr><td><a href="${EXPLORER}/address/${b.bidder}" target="_blank" rel="noopener">${short(b.bidder)}</a>${account && b.bidder.toLowerCase() === account.toLowerCase() ? " (you)" : ""}</td>
        <td>${fmt(b.qty, 18)}</td><td>${fmt(b.price, a.qd)} ${sym(a.quote)}</td>
        ${s ? `<td>${f ? fmt(f.qty, 18) : "0"}</td><td>${f ? fmt(f.paid, a.qd) + " " + sym(a.quote) : "refunded"}</td><td><span class="badge ${f ? "b-won" : "b-lost"}">${f ? "won" : "lost"}</span></td>` : ""}</tr>`;
      }).join("")}</tbody></table>` : `<div class="empty">No bids revealed yet.</div>`;
  }

  $("act").addEventListener("click", async (e) => {
    const act = e.target.dataset?.act;
    if (!act) return;
    e.target.disabled = true;
    try {
      if (!account) await connect();
      if (act === "commit") {
        const qty = parseUnits($("qty").value, 18);
        const price = parseUnits($("price").value, a.qd);
        const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
        const hash = keccak256(encodeAbiParameters(
          [{ type: "uint256" }, { type: "address" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes32" }],
          [id, account, qty, price, salt]));
        // save before sending: losing the salt means losing the bond
        const k = saveKey(id, account);
        localStorage.setItem(k, JSON.stringify({ qty: qty.toString(), price: price.toString(), salt }));
        await ensureAllowance(WIF, await read("bond"));
        await send("commit", [id, hash], "seal bid");
        localStorage.setItem(k, JSON.stringify({ qty: qty.toString(), price: price.toString(), salt, committed: true }));
      }
      if (act === "reveal") {
        const qty = BigInt(saved.qty), price = BigInt(saved.price);
        await ensureAllowance(a.quote, (qty * price + 10n ** 18n - 1n) / 10n ** 18n);
        await send("reveal", [id, qty, price, saved.salt], "reveal");
        localStorage.setItem(saveKey(id, account), JSON.stringify({ ...saved, revealed: true }));
      }
      if (act === "settle") await send("settle", [id], "settle");
      vAuction(id);
    } catch (err) {
      toast(err.shortMessage || err.message, 8000);
      e.target.disabled = false;
    }
  });
}

function vCreate() {
  view.innerHTML = `<div class="head"><div><p class="eyebrow">escrow a lot · burns 100 $wif</p><h1>List a lot</h1></div></div>
    <div class="g2"><div class="card pad"><form id="create" class="form">
      <div class="two"><label>lot token<select name="lot">${TOKENS.filter((t) => t.lot).map((t) => `<option value="${t.addr}">${t.sym}</option>`).join("")}</select></label>
      <label>paid in<select name="quote">${TOKENS.filter((t) => t.quote).map((t) => `<option value="${t.addr}" ${t.sym === "USDG" ? "selected" : ""}>${t.sym}</option>`).join("")}</select></label></div>
      <div class="two"><label>amount<input name="amount" required inputmode="decimal" placeholder="1"></label>
      <label>reserve price (per token)<input name="reserve" required inputmode="decimal" placeholder="150"></label></div>
      <div class="two"><label>commit window (minutes)<input name="commitMin" type="number" min="5" value="60"></label>
      <label>reveal window (minutes)<input name="revealMin" type="number" min="5" value="30"></label></div>
      <button class="btn" type="submit">List auction</button></form></div>
    <div class="card pad"><h3>What happens</h3>
      <div class="kv"><span>listing fee</span><b>100 $WIF, burned</b></div>
      <div class="kv"><span>your lot</span><b>escrowed until settle</b></div>
      <div class="kv"><span>unsold amount</span><b>returned to you</b></div>
      <div class="kv"><span>below reserve</span><b>can't be revealed</b></div>
      <div class="kv"><span>reference price</span><b>Chainlink, 24/7 feed where available</b></div>
      <p class="note" style="margin-top:12px">List before the close, for example at Friday 16:00 ET, and settle over the weekend while mint and burn are shut.</p></div></div>`;
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
      const t = TOKENS.find((x) => x.addr === lot);
      const fee = await read("listFee");
      await ensureAllowance(lot, lot === WIF ? amount + fee : amount);
      if (lot !== WIF) await ensureAllowance(WIF, fee);
      await send("create", [lot, quote, amount, reserve, BigInt(f.get("commitMin")) * 60n, BigInt(f.get("revealMin")) * 60n, t.f7 || t.f5 || NONE], "list auction");
      location.hash = `#a/${(await read("auctionCount")) - 1n}`;
    } catch (err) {
      toast(err.shortMessage || err.message, 8000);
    } finally {
      btn.disabled = false;
    }
  });
}

async function vMine() {
  view.innerHTML = `<div class="head"><div><p class="eyebrow">sealed in this browser</p><h1>My bids</h1></div></div><div class="card tablescroll" id="mine"><div class="empty">loading…</div></div>`;
  if (!account) { $("mine").innerHTML = `<div class="empty">Connect your wallet to see your bids.</div>`; return; }
  const prefix = `tutup:${TUTUP}:`;
  const mine = Object.keys(localStorage).filter((k) => k.startsWith(prefix) && k.toLowerCase().endsWith(account.toLowerCase()))
    .map((k) => ({ id: BigInt(k.slice(prefix.length).split(":")[0]), ...JSON.parse(localStorage.getItem(k)) }));
  if (!mine.length) { $("mine").innerHTML = `<div class="empty">No sealed bids from this browser yet. <a href="#auctions">Find an auction →</a></div>`; return; }
  const now = (await pub.getBlock()).timestamp;
  const rows = await Promise.all(mine.map(async (m) => ({ m, a: await loadAuction(m.id) })));
  $("mine").innerHTML = `<table><thead><tr><th>auction</th><th>lot</th><th>your bid</th><th>phase</th><th>next</th></tr></thead><tbody>
    ${rows.map(({ m, a }) => {
      const ph = phaseOf(a, now);
      const next = ph === "reveal" && !m.revealed ? "reveal now" : ph === "commit" ? `reveal in ${left(a.commitEnd, now)}` : ph === "settle" ? "settle" : m.revealed ? "done" : "bond burned";
      return `<tr class="click" data-id="${a.id}"><td>#${a.id}</td><td>${tok(a.lot)}</td><td>${fmt(BigInt(m.qty), 18)} @ ${fmt(BigInt(m.price), a.qd)} ${sym(a.quote)}</td>
        <td><span class="badge b-${ph}">${ph}</span></td><td>${next}</td></tr>`;
    }).join("")}</tbody></table>`;
  $("mine").querySelectorAll("tr[data-id]").forEach((r) => (r.onclick = () => (location.hash = `#a/${r.dataset.id}`)));
}

async function vMarket() {
  view.innerHTML = `<div class="head"><div><p class="eyebrow">chainlink on robinhood chain</p><h1>Market hours</h1></div></div>
    <div class="callout" style="margin-bottom:14px">Official Stock Token feeds update 24/5. When one has been silent for hours the market is closed, and that's when a Tutup auction gives a fairer price than a stale feed or a thin RFQ quote. Chainlink publishes 24/7 feeds for a few names, which Tutup records as the reference.</div>
    <div class="card tablescroll" id="mkt"><div class="empty">reading feeds…</div></div>`;
  const rows = await Promise.all(TOKENS.filter((t) => t.f5).map(async (t) => ({ t, a: await readFeed(t.f5).catch(() => null), b: t.f7 ? await readFeed(t.f7).catch(() => null) : null })));
  $("mkt").innerHTML = `<table><thead><tr><th>token</th><th>24/5 price</th><th>last update</th><th>24/7 price</th><th>status</th><th>contract</th></tr></thead><tbody>
    ${rows.map(({ t, a, b }) => `<tr><td>${tok(t.addr)}</td><td>${a ? "$" + a.price.toFixed(2) : "–"}</td><td>${a ? a.ageH.toFixed(1) + "h ago" : "–"}</td>
      <td>${b ? "$" + b.price.toFixed(2) : "–"}</td><td>${a ? `<span class="badge ${a.ageH > 2 ? "b-closed" : "b-open"}">${a.ageH > 2 ? "closed" : "open"}</span>` : "–"}</td>
      <td><a href="${EXPLORER}/token/${t.addr}" target="_blank" rel="noopener">${short(t.addr)}</a></td></tr>`).join("")}</tbody></table>`;
}

async function vBurns() {
  view.innerHTML = `<div class="head"><div><p class="eyebrow">every burn is on chain</p><h1>$WIF burns</h1></div></div>
    <section class="stats"><div class="card stat burn"><div class="k">total burned</div><div class="v" id="b-total">…</div></div>
    <div class="card stat"><div class="k">listing fee</div><div class="v">100</div></div><div class="card stat"><div class="k">bid bond</div><div class="v">50</div></div>
    <div class="card stat"><div class="k">owner / admin</div><div class="v">none</div></div></section>
    <div class="card tablescroll" id="burns"><div class="empty">loading…</div></div>`;
  if (!DEPLOYED) { $("b-total").textContent = "–"; $("burns").innerHTML = notDeployed; return; }
  const [total, logs] = await Promise.all([read("totalBurned"), events("Burned")]);
  $("b-total").textContent = fmt(total, 18, 0);
  $("burns").innerHTML = logs.length ? `<table><thead><tr><th>auction</th><th>amount</th><th>reason</th><th>tx</th></tr></thead><tbody>
    ${[...logs].reverse().map((l) => `<tr><td><a href="#a/${l.args.id}">#${l.args.id}</a></td><td><span class="badge b-burn">${fmt(l.args.amount, 18, 0)} $WIF</span></td>
      <td>${l.args.reason === "listing" ? "listing fee" : "unrevealed bond"}</td><td><a href="${EXPLORER}/tx/${l.transactionHash}" target="_blank" rel="noopener">${l.transactionHash.slice(0, 12)}…</a></td></tr>`).join("")}</tbody></table>`
    : `<div class="empty">No burns yet.</div>`;
}

function vDocs() {
  view.innerHTML = `<div class="head"><div><p class="eyebrow">how tutup works</p><h1>Docs</h1></div></div>
    <div class="g2"><div class="card pad docs">
      <h3>The problem</h3>
      <p>Stock Tokens on Robinhood Chain are ERC-20s that trade 24/7. Their official Chainlink feeds update 24/5, and Authorised Participants can only mint and burn from Monday 02:00 to Saturday 02:00 CET. On weekends and during corporate actions (<code>oraclePaused()</code>) nobody can arbitrage a token back to its share. Quotes go thin, and on a first-come-first-served sequencer the fastest bot sets the price.</p>
      <h3>The mechanism</h3>
      <p><b>Commit.</b> Post <code>keccak256(abi.encode(id, bidder, qty, price, salt))</code> and a 50 $WIF bond.<br><b>Reveal.</b> Open the bid and escrow <code>qty × price</code>. Your bond comes back. If you never reveal, the bond is burned.<br><b>Settle.</b> Anyone can call it. Bids sort by price and ties break on <code>keccak256(id, bidder)</code>. The highest bids fill, and every winner pays the marginal (lowest winning) price. Losers are refunded and unsold lot returns to the seller.</p>
      <h3>$WIF</h3>
      <p>Each listing burns 100 $WIF through WIF's own <code>burn()</code>, and unrevealed bonds burn too. The bond is what makes a sealed bid credible: without it, a fake bid costs nothing.</p>
      <h3>Limits, honestly</h3>
      <p>An auction takes at most 64 bids, because they are sorted on chain. Payouts are pushed at settlement. Bid sizes become public at reveal, but only after commits have closed.</p>
    </div>
    <div class="card pad"><h3>Contract</h3>
      <div class="kv"><span>Tutup</span><b>${DEPLOYED ? `<a href="${EXPLORER}/address/${TUTUP}" target="_blank" rel="noopener">${short(TUTUP)}</a>` : "deploying"}</b></div>
      <div class="kv"><span>owner</span><b>none</b></div><div class="kv"><span>upgradeable</span><b>no</b></div>
      <div class="kv"><span>$WIF</span><b><a href="${EXPLORER}/token/${WIF}" target="_blank" rel="noopener">${short(WIF)}</a></b></div>
      <div class="kv"><span>chain</span><b>Robinhood Chain · 4663</b></div>
      <div class="kv"><span>min phase</span><b>5 minutes</b></div><div class="kv"><span>max bids</span><b>64</b></div>
      <div class="kv"><span>source</span><b><a href="https://github.com/PugarHuda/tutup" target="_blank" rel="noopener">github</a></b></div>
    </div></div>
    <p class="foot">Not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc. Stock Tokens are not available to U.S. persons or in restricted jurisdictions.</p>`;
}

// --- router ---

function route() {
  const h = location.hash.slice(1) || "auctions";
  const m = h.match(/^a\/(\d+)$/);
  document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.view === (m ? "auctions" : h)));
  const run = m ? vAuction(BigInt(m[1])) : ({ create: vCreate, mine: vMine, market: vMarket, burns: vBurns, docs: vDocs }[h] || vAuctions)();
  Promise.resolve(run).catch((e) => { console.error(e); toast(e.shortMessage || e.message, 8000); });
}

$("connect").addEventListener("click", () => connect().catch((e) => toast(e.message)));
if (RPC !== DEFAULT.rpc) $("net").textContent = "local fork · " + short(TUTUP) + " · " + RPC.replace(/^https?:\/\//, "");
addEventListener("hashchange", route);
route();
setInterval(() => { if (!["#create", "#docs"].includes(location.hash) && !document.querySelector("input:focus, select:focus")) route(); }, 30000);
