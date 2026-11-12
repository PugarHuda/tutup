// Live numbers on the landing page, read straight from the Tutup contract through the same-origin RPC proxy.
// No library: three eth_calls in one JSON-RPC batch, then one per auction for its phase.
const TUTUP = "0xd2Bfe52d5A0680DC7C3BE5BB19E1f75a568a5428";
const call = (data, id) => ({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to: TUTUP, data }, "latest"] });
const word = (hex, i) => BigInt("0x" + hex.slice(2 + i * 64, 2 + (i + 1) * 64));

async function rpc(body) {
  const r = await fetch("/api/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}

(async () => {
  try {
    const [burned, count, block] = await rpc([
      call("0xd89135cd", 1), // totalBurned()
      call("0x2ad71573", 2), // auctionCount()
      { jsonrpc: "2.0", id: 3, method: "eth_getBlockByNumber", params: ["latest", false] },
    ]);
    const n = Number(BigInt(count.result));
    const now = BigInt(block.result.timestamp);
    const auctions = n ? await rpc([...Array(n).keys()].map((i) => call("0x571a26a0" + i.toString(16).padStart(64, "0"), 10 + i))) : [];
    // auctions(uint256) returns 13 words; word 9 is revealEnd, word 12 is settled
    const live = auctions.filter((a) => word(a.result, 12) === 0n && now < word(a.result, 9)).length;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set("live-burned", (Number(BigInt(burned.result) / 10n ** 18n)).toLocaleString());
    set("live-auctions", n.toString());
    set("live-open", live.toString());
    document.getElementById("live")?.removeAttribute("hidden");
  } catch {
    // the section stays hidden if the chain can't be read
  }
})();
