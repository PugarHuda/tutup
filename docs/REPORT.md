# Tutup: integration audit and QA report

**Date:** 12 Nov 2026
**Live:** https://tutup.vercel.app
**Network:** Robinhood Chain mainnet (4663)
**Contract:** `0xd2Bfe52d5A0680DC7C3BE5BB19E1f75a568a5428`, verified on Sourcify

## 1. How deep each integration goes

| Integration | Depth | What is real, and where |
|---|---|---|
| **Robinhood Chain / Stock Tokens** | Deep | Three contract versions on mainnet, each with a settled auction. Stock Token ERC-8056 `uiMultiplier` / `newUIMultiplier` / `effectiveAt` and `oraclePaused()` are read in the desk and the MCP server. The Robinhood API (prices, corporate actions, `/api/rhj`) and the mint window show on the Market hours page. A real NVDA lot (auction #2) was bought on Uniswap. |
| **$WIF** | Deep | Every listing burns 100 WIF (`totalBurned`). A bond that is never revealed is burned. WIF can be the lot itself (auctions #0 and #1). WIF is bought in-app through Relay (real swap, tx `0x43d43f89…`). Burns are listed on the `$WIF burns` page. |
| **Quicknode** | Deep | 1) Primary RPC for the proxy, MCP, keeper and failover. 2) Stock Token API, all 5 methods (oracle health, registry, corporate actions, balances, tx finality). 3) **Streams**: stream `tutup-auctions` filters Tutup logs and calls the HMAC-verified `/api/stream` webhook, which wakes the keeper. 4) **ERC-8004 API** add-on: Tutup's reputation score, pinned to `robinhood-mainnet`. |
| **GetBlock** | Medium | Third upstream in `/api/rpc`, MCP and keeper. It takes wide `eth_getLogs` whenever the public RPC is unreachable (Quicknode's free plan caps logs at 5 blocks), so the desk's history reads depend on it. It has no API of its own to deepen. |
| **Chainlink** | Deep | 24/5 and 24/7 feeds for each Stock Token. The contract records `refPrice` at settle. `TutupFeed` exposes Tutup's clearing price as an `AggregatorV3Interface`, deployed for both live pairs: WIF/WETH `0xDe80aC53…69dE` and NVDA/WETH `0x1Db46a08…C3f7` (answers after auction #2 settles on 16 Nov). |
| **Relay** | Deep | Quote, execute and status tracking. Every step is validated against an allowlist, chain id, value cap and forbidden selectors. Proven by a real swap on mainnet. |
| **Lighter** | Medium | Best bid/ask plus an order-book simulation of a market sell. It is read-only. |
| **Uniswap v3** | Medium | QuoterV2 tries four fee tiers to show what a market sell would return. The NVDA for the demo lot was bought through this pool. |
| **ERC-8004** | Deep | Identity: agent #25584 is registered, with `agent.json`. Reputation: read from the registry and Quicknode, and bidders in a settled auction can rate it. Self-feedback is blocked by the registry (simulation proves it). |
| **MCP server** | Deep | 11 tools validated against their JSON schemas. The `prepare_*` tools return unsigned calls. The server is discoverable through `llms.txt` and `agent.json`. |
| **drand tlock** | Deep, unique | The receipt is encrypted into the commit calldata and unlocks 60 s after commit close. It can be recovered from the desk, from MCP, or by the keeper. Proof: desk bid `0xd7afd881…` and MCP bid `0x8754635e…`. |
| **EIP-5792** | Medium | `wallet_sendCalls` with atomic batching when the wallet supports it. **Only the sequential fallback was tested** against a real wallet (the injected EOA in the E2E suite and video). The atomic path has not been run with a wallet that supports batching. |
| **EIP-6963** | Deep | Multi-wallet discovery with a wallet picker. |
| **Keeper agent** | Deep | Vercel Cron twice a day, plus Streams. It settles, bids by a public rule on house listings only (security review fix), and reveals using a derived salt or the tlock receipt. |
| **Pyth** | Not implemented (blocker) | Since the Pyth Core upgrade, Hermes needs an API key, and equities need the Pro plan ($2,500/mo). The code is ready (`/api/pyth`), but it returns `{configured:false}` and stays hidden in the UI until `PYTH_API_KEY` is set. |

## 2. What is unique

1. **A weekend price for Stock Tokens set by sealed bids.** It fills the gap when the official Chainlink 24/5 feed stops. The result is published back on chain as a Chainlink-compatible feed (`TutupFeed`).
2. **Receipts that can't be lost (drand timelock in calldata).** There is no new contract and no server storage. Nobody can read the receipt before commit close, and anyone can recover it afterwards. This removes the classic commit-reveal failure: a forgotten salt and a burned bond.
3. **An agent that bids, reveals and settles by itself.** It is woken by Quicknode Streams, gated to house listings, and can reveal bids placed by hand from the desk through tlock recovery.
4. **Tutup as an ERC-8004 agent with an MCP interface.** Other agents can find it on chain, bid through the `prepare_*` tools, and read its reputation from the registry and Quicknode.
5. **WIF economics.** Every listing is a burn and every unrevealed bond is a burn, so bonds are a real cost, not decoration.

## 3. Not implemented, or blocked

| Item | Why | What is needed |
|---|---|---|
| Pyth prices | Hermes needs a Pro key ($2,500/mo for equities) | `PYTH_API_KEY` |
| Gasless bids (paymaster / ERC-4337) | No bundler or paymaster on chain 4663 has been verified | A provider that supports 4663 |
| ERC-8004 ratings from real users | Only the people who bid can rate, and our own wallets must not | Outside bidders |
| Outside bidders / traction | All bids so far are from house wallets, all labelled in the UI | Distribution: X thread in `DRAFTS.md` |
| Blockscout verification | Blockscout is behind Cloudflare for the CLI. Every contract is verified on Sourcify instead | — |

## 4. Tests

- **Foundry:** 22 of 22 pass. That covers 13 unit/fuzz, 6 deep (minSold, reentrancy, 64-bid gas, …), 1 invariant (128k calls), 1 feed and 1 mainnet fork.
- **Script checks:** keeper fork test, MCP fork test, the tlock round-trip and margin, and Streams HMAC.
- **Playwright E2E:** see section 5.

## 5. E2E results

**49 of 49 pass** on the live site (Chrome desktop + Pixel 7 mobile, 2.4 min, `e2e/`), and the route checks also pass on **Firefox and WebKit (iPhone 14): 24 of 24**.

Demo video: https://youtu.be/eXyt-ZirmPc

Coverage: landing numbers come from the contract, `llms.txt`/`agent.json`, every desk route (no console errors, no placeholder text), deep links and back/forward, an unknown auction id, house-wallet labels, Quicknode finality, the NVDA lot against all its references (Chainlink, Lighter, Robinhood, Uniswap, ERC-8056, Quicknode corporate actions), ERC-8004 reputation, bid-form validation, a rejected signature, Relay down, chain RPC down, Lighter down, and axe accessibility.

Bugs the suite found on 12 Nov, all fixed and deployed:
1. The public Robinhood RPC was unreachable from our network on 12 Nov (503, bad TLS cert; it answered again over a VPN, so likely an ISP block, which real users can hit too) and Quicknode's free plan caps `eth_getLogs` at 5 blocks, so the desk hung on "loading". The proxy now skips a `-32615` limit to GetBlock, and the browser reads only through the proxy.
2. An unknown auction id stayed on "loading" forever. It now says the auction doesn't exist.
3. A failed page load left "loading" on screen. It now shows the error and asks to retry.
4. Typing "abc" as an amount showed "Cannot convert abc… to a BigInt". It now says the number is invalid.
5. Quicknode's free plan allows 1 add-on call per second, so ERC-8004 panels returned 502 under load. The proxy retries twice.
6. A Relay outage showed a JSON parse error. It now says Relay is unavailable, with the HTTP status.
