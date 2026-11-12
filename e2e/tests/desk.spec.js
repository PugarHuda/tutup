import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { Desk, injectWallet, PLACEHOLDER } from "./desk.js";

const ROUTES = ["auctions", "a/0", "a/1", "a/2", "create", "mine", "market", "prints", "burns", "wif", "docs"];

test.describe("landing", () => {
  test("live numbers come from the contract @mobile", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#live")).toBeVisible();
    await expect(page.locator("#live-burned")).toHaveText(/^\d[\d,]*$/);
    await expect(page.locator("#live-auctions")).toHaveText(/^\d+$/);
    const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    expect(noHScroll).toBeTruthy();
  });
  test("llms.txt and agent.json are served for agents", async ({ request }) => {
    expect(await (await request.get("/llms.txt")).text()).toContain("/api/mcp");
    const a = await (await request.get("/agent.json")).json();
    expect(a.registrations?.[0]?.agentId).toBe(25584);
  });
});

test.describe("desk routes", () => {
  for (const r of ROUTES) {
    test(`#${r} renders real data, no errors, no placeholder text @mobile`, async ({ page }) => {
      const d = new Desk(page);
      await d.open(r);
      await expect(d.main()).not.toContainText("loading", { timeout: 30_000 });
      const text = await d.main().innerText();
      expect(text.length).toBeGreaterThan(80);
      expect(text).not.toMatch(PLACEHOLDER);
      expect(d.errors).toEqual([]);
    });
  }
  test("deep link survives reload and back/forward", async ({ page }) => {
    const d = new Desk(page);
    await d.open("a/0");
    await expect(d.main()).toContainText("clearing price");
    await page.reload(); await expect(d.main()).toContainText("clearing price");
    await d.open("burns"); await page.goBack(); await expect(d.main()).toContainText("Auction #0");
    await page.goForward(); await expect(d.main()).toContainText(/burned/i);
  });
  test("unknown auction id shows a clear state, not a crash", async ({ page }) => {
    const d = new Desk(page);
    await d.open("a/999");
    await expect(d.main()).toContainText(/doesn't exist|not found|no auction/i);
    expect(d.errors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
  });
});

test.describe("auction data from chain and sponsors", () => {
  test("settled auction #0: clearing price, house labels, Quicknode finality", async ({ page }) => {
    const d = new Desk(page);
    await d.open("a/0");
    await expect(d.main()).toContainText("clearing price");
    await expect(d.main()).toContainText("(Tutup agent wallet)");
    await expect(d.main()).toContainText("(Tutup test wallet)");
    await expect(page.locator("#fin")).toContainText(/finalized|safe|posted/i);
  });
  test("NVDA auction #2: Chainlink, Lighter, Robinhood, Uniswap, ERC-8056, Quicknode corporate actions", async ({ page }) => {
    const d = new Desk(page);
    await d.open("a/2");
    const ref = page.locator("#ref");
    for (const row of [/Chainlink 24\/5/, /Chainlink 24\/7/, /Lighter NVDA/, /Robinhood quote/, /Uniswap v3/, /ERC-8056 multiplier/, /Corporate actions/i]) await expect(ref).toContainText(row);
    await expect(ref).toContainText(/\$\d+\.\d+/);
  });
  test("docs show live ERC-8004 reputation from the registry and Quicknode", async ({ page }) => {
    const d = new Desk(page);
    await d.open("docs");
    await expect(page.locator("#rep")).toContainText(/Quicknode score \d+\/100/);
  });
});

test.describe("wallet flows", () => {
  test("my account without a wallet asks to connect", async ({ page }) => {
    const d = new Desk(page);
    await d.open("mine");
    await expect(d.main()).toContainText(/connect your wallet/i);
  });
  test("bid form validates input before any signature", async ({ page }) => {
    await injectWallet(page);
    const d = new Desk(page);
    await d.open("a/1");
    await d.connect();
    await expect(page.locator("#connect")).toHaveText(/0x6f8d/i);
    const seal = page.locator("[data-act=commit]");
    for (const [qty, price, msg] of [["", "0.000001", /quantity must be between/], ["0", "0.000001", /quantity must be between/], ["1000000", "0.000001", /quantity must be between/], ["10", "0.0000001", /below the reserve/], ["abc", "1", /invalid|number|quantity/i]]) {
      await page.locator("#qty").fill(qty);
      await page.locator("#price").fill(price);
      await seal.click();
      await expect(d.toast()).toContainText(msg);
      await expect(seal).toBeEnabled();
    }
  });
  test("a rejected signature is reported and the form stays usable", async ({ page }) => {
    await injectWallet(page);
    const d = new Desk(page);
    await d.open("a/1");
    await d.connect();
    await page.locator("#qty").fill("10");
    await page.locator("#price").fill("0.000001");
    await page.locator("[data-act=commit]").click();
    await expect(d.toast()).toContainText(/rejected/i);
    await expect(page.locator("[data-act=commit]")).toBeEnabled();
  });
});

test.describe("failure modes", () => {
  test("Relay down: the quote fails with a readable message", async ({ page }) => {
    await page.route("https://api.relay.link/**", (r) => r.fulfill({ status: 503, body: "upstream down" }));
    await injectWallet(page);
    const d = new Desk(page);
    await d.open("wif");
    await d.connect();
    await page.locator("#quoteBtn").click();
    await expect(page.locator("#quoteOut")).toContainText(/relay|503|quote|failed|unavailable/i);
    await expect(page.locator("#goBtn")).toBeDisabled();
  });
  test("chain RPC down: the desk shows an error instead of hanging or crashing", async ({ page }) => {
    await page.route("**/api/rpc", (r) => r.fulfill({ status: 502, contentType: "application/json", body: '{"error":"down"}' }));
    await page.route("https://rpc.mainnet.chain.robinhood.com/**", (r) => r.abort());
    const d = new Desk(page);
    await page.goto("/app.html#auctions");
    await expect(d.main()).toContainText(/can't reach|unavailable|error|failed|try again/i, { timeout: 60_000 });
  });
  test("Lighter down: the auction still renders with the other references", async ({ page }) => {
    await page.route("https://api.rh.lighter.xyz/**", (r) => r.abort());
    const d = new Desk(page);
    await d.open("a/2");
    await expect(page.locator("#ref")).toContainText(/Chainlink 24\/5/);
  });
});

test.describe("accessibility", () => {
  for (const r of ["auctions", "a/2", "docs"]) {
    test(`#${r} has no serious axe violations`, async ({ page }) => {
      const d = new Desk(page);
      await d.open(r);
      await expect(d.main()).not.toContainText("loading", { timeout: 30_000 });
      const res = await new AxeBuilder({ page }).disableRules(["color-contrast"]).analyze();
      const bad = res.violations.filter((v) => ["serious", "critical"].includes(v.impact)).map((v) => `${v.id}: ${v.nodes.length}`);
      expect(bad).toEqual([]);
    });
  }
});
