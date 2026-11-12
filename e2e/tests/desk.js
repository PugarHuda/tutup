// Page object for the Tutup desk, plus an injected EIP-6963 test wallet. The wallet reports a real mainnet address
// (read-only: balances and allowances come from the chain) and refuses every signature with EIP-1193 code 4001.
export const RICH = "0x6f8de009cd4fad0ab69dd519b60099e8ad2a1ee2"; // an EOA holding $WIF on Robinhood Chain, never signed for
export async function injectWallet(page, address = RICH) {
  await page.addInitScript((addr) => {
    const rpc = async (method, params) => (await (await fetch("/api/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
    const provider = {
      request: async ({ method, params }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [addr];
        if (method === "eth_chainId") return "0x1237";
        if (method === "wallet_switchEthereumChain") return null;
        if (["eth_sendTransaction", "wallet_sendCalls", "personal_sign", "eth_signTypedData_v4"].includes(method)) { const e = new Error("User rejected the request."); e.code = 4001; throw e; }
        if (method === "wallet_getCapabilities") { const e = new Error("unsupported"); e.code = 4200; throw e; }
        return rpc(method, params || []);
      },
      on() {}, removeListener() {},
    };
    window.ethereum = provider;
    addEventListener("eip6963:requestProvider", () => dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: { uuid: "e2e", name: "E2E wallet", icon: "data:image/svg+xml,", rdns: "e2e" }, provider }) })));
  }, address);
}
export class Desk {
  constructor(page) { this.page = page; this.errors = []; page.on("pageerror", (e) => this.errors.push(e.message)); page.on("console", (m) => m.type() === "error" && this.errors.push(m.text())); }
  async open(route) { await this.page.goto(`/app.html#${route}`); await this.page.waitForLoadState("networkidle"); }
  main() { return this.page.locator("main"); }
  toast() { return this.page.locator("#toast"); }
  async connect() { await this.page.locator("#connect").click(); }
}
export const PLACEHOLDER = /\b(lorem|ipsum|TODO|FIXME|coming soon|placeholder|undefined|NaN|\[object Object\])\b/i;
