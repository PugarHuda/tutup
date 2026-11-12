# Tutup

**Sealed-bid batch auctions for Stock Tokens on Robinhood Chain, for the hours the market is closed. Bonds in $WIF.**

*Tutup* is Indonesian for "closed".

**Live:** https://tutup.vercel.app · **Demo video (2:17):** https://youtu.be/eXyt-ZirmPc · **QA report:** [`docs/REPORT.md`](docs/REPORT.md)

Stock Tokens trade 24/7. Their official Chainlink feeds update 24/5, and Authorised Participants can only mint and burn from Monday 02:00 to Saturday 02:00 CET. On weekends and during corporate actions nobody can arbitrage a token back to its share. RFQ quotes widen or vanish, and on a first-come-first-served sequencer, whoever is fastest sets the price.

Tutup replaces the race with a sealed-bid batch auction:

1. **commit**: a bidder posts `keccak256(abi.encode(id, bidder, qty, price, salt))` and a **50 $WIF bond**
2. **reveal**: the bidder opens the bid and escrows payment, and the bond comes back. A bond that is never revealed is **burned**.
3. **settle**: anyone can settle. The highest bids fill first and every winner pays the lowest winning price. Ties break on a hash, not on arrival order. Losers are refunded in full, and unsold lot returns to the seller.

Each listing burns **100 $WIF** through WIF's own `burn()`. Settlement records the Chainlink reference price next to the clearing price.

## Contract
- `src/Tutup.sol` is a single contract with no owner, admin, pause or upgrade
- Robinhood Chain (4663), **v3 (current)**: [`0xd2Bfe52d5A0680DC7C3BE5BB19E1f75a568a5428`](https://robinhoodchain.blockscout.com/address/0xd2Bfe52d5A0680DC7C3BE5BB19E1f75a568a5428), verified on Sourcify (exact match)
- `TutupFeed` WIF/WETH (Chainlink-compatible): [`0xDe80aC53aBB6bB595Ea4D023f4B826F7F4C269dE`](https://robinhoodchain.blockscout.com/address/0xDe80aC53aBB6bB595Ea4D023f4B826F7F4C269dE), verified on Sourcify
- v2: [`0x408bbe1cB335Bd81EACFD5d364Bb5970d8C4fe30`](https://robinhoodchain.blockscout.com/address/0x408bbe1cB335Bd81EACFD5d364Bb5970d8C4fe30)
- v1 (first deployment, auction #0): [`0x0abdDa286cCD2033c0aF5d80d5132E52Ede177FE`](https://robinhoodchain.blockscout.com/address/0x0abdDa286cCD2033c0aF5d80d5132E52Ede177FE)

## Live on Robinhood Chain mainnet

### Open now, through the judging weekend
- **Auction #1** sells 100 $WIF for WETH. **Auction #2** sells **0.0025 NVDA**, a real Robinhood Stock Token bought through the Uniswap v3 NVDA/WETH pool on Robinhood Chain, also for WETH.
- For both, commits close **Sat 15 Nov 14:00 UTC** (the weekend gap, when the official feeds are frozen) and reveals close **Sun 16 Nov 12:00 UTC**.
- A Vercel Cron keeper settles both at 12:15 UTC.
- To bid: open https://tutup.vercel.app/app.html#a/2. Get the 50 $WIF bond from **Get $WIF** (Relay).
- Transactions:
  - NVDA purchase: https://robinhoodchain.blockscout.com/tx/0xf875190631c525ee19d0148d6f2b06ed66e1e74025b3a791d4d423aecad48372
  - auction #2 create: https://robinhoodchain.blockscout.com/tx/0x2999a1b095d46ff4ca9a4008f95970316f4b9d4d3bc499fd27a45c3fd03788df
  - auction #1 create: https://robinhoodchain.blockscout.com/tx/0xd48e26d2709cf5fe53d83700af7ba8e81a72feb3d08973e7315f8b327f019a03

### Onchain agent identity
Tutup's MCP server is **ERC-8004 agent #25584** in the IdentityRegistry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` on Robinhood Chain. Its registration file is https://tutup.vercel.app/agent.json, and it was registered in https://robinhoodchain.blockscout.com/tx/0x9eb7c762606b5d5b36907673b3b357e7950b72ea64a518c87336fee70d1fac31 Agents and crawlers can also start from https://tutup.vercel.app/llms.txt.

### v3 auction #0
70 $WIF paid in WETH, bond 50 $WIF, **minSold 40**. Bids were 30 @ 0.00000065 and 50 @ 0.0000006. Demand of 80 is at least 40, so both cleared at 0.0000006: 30 and 40 filled. `TutupFeed.latestRoundData()` now answers 60, which is 0.00000060 with 8 decimals.
- deploy v3: https://robinhoodchain.blockscout.com/tx/0x128b9402f2fffb25ca6c2c3bba84f3c760ab7a91d776fab68281204a5c26b9b8
- create (100 $WIF burned, minSold 40): https://robinhoodchain.blockscout.com/tx/0x626f29532a47305451c0e22684b1846ec606765bd4aa41a9b47e2918efb92a8d
- commit, bidder 1: https://robinhoodchain.blockscout.com/tx/0x783ff1eb7a91d99e53b97a42d70b5f0de4ff0231ab5624d7ee24fd92e00062ca
- commit, bidder 2: https://robinhoodchain.blockscout.com/tx/0x3524ac9aa9bf9c3dfc93d58089b53a5b8d0083d3f43f0af5d60a09a25900d3c9
- reveal, bidder 1: https://robinhoodchain.blockscout.com/tx/0x9d74a8ead4246c01f561034e88c4fff98e0c270f53b0985cfae845e9d40f4fa3
- reveal, bidder 2: https://robinhoodchain.blockscout.com/tx/0xae3fd2025b76d6d9f8d3fc74af13baa73f1cdf095b476396b3657bbffac54512
- settle (writes lastPrint): https://robinhoodchain.blockscout.com/tx/0xcbcbefacec6a383d85b0c63300e70b7c7839cf029d156710574c274c11368ba0
- deploy TutupFeed WIF/WETH: https://robinhoodchain.blockscout.com/tx/0x2cb7704eecc26406593b8e10a2999b595bfa665a25d6faebda88b8c72d8b1ce7

### v2 auction #0
100 $WIF paid in WETH, bond 50 $WIF. Bids were 60 @ 0.00000065 and 70 @ 0.0000006, and both cleared at 0.0000006. `lastPrint(WIF, WETH)` now reads (6e11, 100e18, …, 0).
- deploy v2: https://robinhoodchain.blockscout.com/tx/0xc0e46b461e3a50271c051eebccf279ecce23aaa035e804f1a9f3200ab2a6f8d1
- create (100 $WIF burned): https://robinhoodchain.blockscout.com/tx/0x444d6cfb38e29b440ae825f69adcab5b97b36ea28bd4137038f4dd75c8f72fa8
- commit, bidder 1: https://robinhoodchain.blockscout.com/tx/0xa84be072f54034b8a8dda0f1a27f328b44f88b599d1c64c11d6a955df4118df6
- commit, bidder 2: https://robinhoodchain.blockscout.com/tx/0xa39f3f1fd0ea26e6e8708efab699d365f8b7e32945802ebc5855a9a6949d2f69
- reveal, bidder 1: https://robinhoodchain.blockscout.com/tx/0x5c9e7dccc5aea0ddd2b5fd83881cb8db706257d90dbf86a12eb5d94ef62c7f88
- reveal, bidder 2: https://robinhoodchain.blockscout.com/tx/0xe53577cc700e1fabc4356dcff0bf0e7a531a819e4e53de47499bf4cc0eeb3861
- settle (writes lastPrint): https://robinhoodchain.blockscout.com/tx/0x5e7af74a6e1a6053af07d50da9809fcc876eae3eb75f3864b8167c8a60ac55fc

### v1 auction #0
- Tutup: [`0x0abdDa286cCD2033c0aF5d80d5132E52Ede177FE`](https://robinhoodchain.blockscout.com/address/0x0abdDa286cCD2033c0aF5d80d5132E52Ede177FE), source verified on Sourcify (exact match)
- Auction #0: 200 $WIF paid in WETH. Two sealed bids, 120 @ 0.0000007 and 150 @ 0.0000006. Both cleared at **0.0000006**: bidder 1 filled 120, bidder 2 filled the remaining 80, and both bonds came back. 100 $WIF was burned at listing, and WIF's totalSupply went down by exactly 100.
- create (100 $WIF burned): https://robinhoodchain.blockscout.com/tx/0x84183838c9287eddac276891e53c643004f756d374470ffc892d3e86aa37aa77
- commit, bidder 1: https://robinhoodchain.blockscout.com/tx/0xdcec7e21e3f8630f7a3174cd5aedf5866dad5ecc6caaa07a5b6898ba73e10d2c
- commit, bidder 2: https://robinhoodchain.blockscout.com/tx/0x5a44b7a9f22ba2bfeff835011fc47345122bd41ca99ffed09ae6b06ed6961349
- reveal, bidder 1: https://robinhoodchain.blockscout.com/tx/0x22ab9181ed09d167b88d564809d7511a9f840298781706e7aa83428294528d13
- reveal, bidder 2: https://robinhoodchain.blockscout.com/tx/0x322d409fde8cbe94a6b6c83bad606a48722866f533d79f083c804d6cff87c962
- settle: https://robinhoodchain.blockscout.com/tx/0x71b67d9ec902dd930019a148bca9aa8bb5984fb11b87cff3ed30092852b080f2

## Tests
```
forge test                                                   # unit + fuzz
FORK_RPC=<robinhood rpc> forge test --match-contract Fork    # real WIF, NVDA, USDG on mainnet
```

## v2: what changed after an audit
- **A frozen recipient can't lock settlement.** USDG can freeze accounts, so a payout that can't be delivered is held in `owed` for `claim()`, and everyone else is paid as normal.
- **Sellers set the bond.** Each auction has its own $WIF bond, at least `minBond`, so filling a 64-bid book with fake bids costs whatever the seller decides.
- **Sellers can't bid** in their own auction, so they can't shill the clearing price.
- **Fee-on-transfer tokens are refused.** Escrow checks the balance delta.
- **`cancel()`** returns the lot while nobody has bid. The listing fee stays burned.
- **`lastPrint(lot, quote)`** records the clearing price, amount sold and time of each sale for other contracts to read.

## v3: second audit pass
- **One reentrancy lock** on every entry point. Escrow is pooled per token, so no token callback may re-enter anywhere. Slither flagged the pattern, and `test/Deep.t.sol` proves a hostile token's re-entry is rejected.
- **`minSold`**, the seller's funding threshold (as in Gnosis EasyAuction): if demand can't clear it, nothing sells and every escrow comes back.
- **Invariant fuzzing**: 128k random create/commit/reveal/settle calls, and the contract always holds exactly its escrow and bonds.
- **Gas**: settling a full 64-bid book costs 3.7M gas.

## Composability: TutupFeed
`src/TutupFeed.sol` serves a pair's `lastPrint` behind Chainlink's `AggregatorV3Interface` (8 decimals, roundId = auction id, updatedAt = settlement). A lending market that already reads Chainlink can use Tutup's weekend price with no new code. With no sale yet it reverts rather than answering 0.

## For AI agents: MCP
```
claude mcp add --transport http tutup https://tutup.vercel.app/api/mcp
```
- Read tools: `list_auctions`, `get_auction`, `market_status` (Chainlink 24/5 and 24/7, Lighter, ERC-8056, `oraclePaused`) and `weekend_prints`.
- Write tools: `prepare_bid`, `prepare_reveal` and `prepare_settle`. They return **unsigned** calls for the agent's own wallet, and the server never holds a key.
- `scripts/mcp-fork-test.mjs` runs an agent through a full bid on an anvil fork of mainnet.

## Keeper agent

[`web/api/keeper.js`](web/api/keeper.js) runs on Vercel Cron at 12:15 and 20:00 UTC, using its own wallet [`0xBCbC…D024`](https://robinhoodchain.blockscout.com/address/0xBCbC638826C37b1B9460ECf722C86DFb1a82D024). Each run it:

1. **Settles** every auction whose reveal window has closed. `settle` is permissionless.
2. **Bids** by a public rule: the whole lot at reserve + 5%. It bids only on the house's own listings (Tutup is permissionless, so a stranger could list an inflated reserve to drain it). The reveal window has to outlast the longest gap between cron runs (17h), the bond is capped at 50 WIF, and the wallet must already hold the bond and the escrow, on top of escrow it has already promised. It takes the newest lot first.
3. **Reveals** using `salt = keccak256(key, tutup, id)`. The salt is derived, never stored, so the agent can't lose one and get its bond burned.

The desk labels its bids "Tutup agent wallet", and labels the test bidder and the deployer as house wallets too. They are the house's own bids, not outside demand. `scripts/keeper-fork-test.mjs` runs the full commit, no-double-bid, reveal and settle cycle on an anvil fork.

## Receipts that can't be lost: drand timelock in calldata

A commit-reveal bidder who loses their salt can't reveal, and their bond burns. Tutup now keeps a third copy of every receipt on chain, with no contract change:

- The desk and the MCP `prepare_bid` tool encrypt `{qty, price, salt}` with [tlock](https://github.com/drand/tlock-js) to the first drand quicknet round published 60s after the auction's `commitEnd`. The margin stops a round that is already out, or a lagging sequencer clock, from opening sealed bids while commits are still accepted. They append the result, marked `TUTP`, to the `commit(id, hash)` calldata. Solidity ignores trailing calldata.
- While bids are sealed nobody can decrypt it, not even us. Once unlocked anyone can read it, but by then the bid can't change, and reveals make bids public anyway. Once commits close the drand beacon is public. "Recover my bid from chain" on the desk, or `prepare_reveal` with just `auction_id` + `bidder`, finds the bidder's `Committed` log, decrypts the calldata and checks it against `commitOf` before building the reveal.
- Live proof: test-wallet bid on auction #1, tx [`0x8754635e…`](https://robinhoodchain.blockscout.com/tx/0x8754635e894c4c74d18327a646255d7747fd80e7a3eedf22ac63549154ed057e), 803 bytes of calldata, decryptable from 15 Nov 14:00 UTC. This bid was sealed before the 60s margin was added.

Source: [`web/tlock-backup.js`](web/tlock-backup.js), shared by the desk (bundled) and `api/mcp.js`.

## One confirmation: EIP-5792

If the wallet reports atomic batching for chain 4663 in `wallet_getCapabilities` (a smart account, or an EOA upgraded with EIP-7702), these go out as one `wallet_sendCalls` bundle: approve + list, approve + commit and approve + reveal. Every other wallet gets the same calls one at a time. Approvals are always for the exact amount.

## ERC-8004 reputation

Agent #25584's reputation lives in the ERC-8004 Reputation Registry on Robinhood Chain (`0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`).

- Only bidders in a settled auction see "Rate this auction", and each rating is tagged `tutup-auction` / `auction-<id>`.
- The Docs page and the MCP tool `agent_reputation` read the summary. The tool also prepares the `giveFeedback` call for a qualifying bidder.
- The registry rejects self-feedback from the agent owner, and Tutup's own wallets never rate it. It shows "no ratings yet" until real bidders rate.

## Quicknode Streams: an event-driven keeper

Stream `tutup-auctions` runs on Robinhood Chain mainnet with the `logs` dataset.

- A JavaScript filter ([`scripts/qn-stream-filter.js`](scripts/qn-stream-filter.js)) keeps only Tutup contract logs and skips every other block.
- It delivers to [`/api/stream`](web/api/stream.js). That endpoint rejects unsigned requests before reading the body, caps the body and gunzip size, checks the HMAC-SHA256 over `nonce + timestamp + payload` with the stream's security token, refuses stale deliveries, and decodes the events.
- A new listing (`Created`) wakes the keeper agent at once. The twice-daily cron stays as the fallback for reveals and settles.
- Tested end to end: Quicknode's own signed test delivery of the `Committed` log from auction #1 came back 200 and decoded. `scripts/stream-test.mjs` checks the signature and decoding.

## Quicknode ERC-8004 API

The Agent Discovery & Reputation add-on is installed on the same endpoint. `/api/qn` pins `erc8004_getAgent` and `erc8004_getAgentReputation` to agent #25584 on `robinhood-mainnet`, because ids are per chain: #25584 on Base is a different agent. The Docs page and the MCP `agent_reputation` tool show Quicknode's composite score (feedback, sybil resistance, reliability, confidence tier) next to the raw registry summary.

## Integrations
- **Uniswap v3 on Robinhood Chain:** each auction quotes what selling the same lot into the pool returns now, through QuoterV2 `0x33e8…a9e7`. The NVDA lot was bought through SwapRouter02 `0xcaf6…5cb2`.
- **ERC-8004:** the MCP agent identity above.
- **Keeper:** `/api/keeper` runs from Vercel Cron and settles any auction past its reveal window with a throwaway wallet. It is CRON_SECRET-gated.
- **Chainlink:** every Stock Token feed on 4663, both 24/5 and 24/7, and the ETH/USD and USDG/USD feeds for USD conversion. The feed is recorded at settlement.
- **ERC-8056 and Robinhood's token views:** `uiMultiplier`, `newUIMultiplier` and `effectiveAt` show pending corporate actions, and `oraclePaused()` flags them while they run.
- **Robinhood Stock Token API:** quotes and trading halts, read through a same-origin Vercel function (`web/api/rhj.js`) because the API sends no CORS headers.
- **Lighter:** the Robinhood Chain order book (`api.rh.lighter.xyz`) gives the last trade and best bid/ask when the official feed is frozen.
- **Relay:** "Get $WIF" quotes and executes ETH on Robinhood Chain, Arbitrum, Base or Ethereum into $WIF on 4663, then tracks the request with `/intents/status/v3`. This is how the project's own WIF was acquired.
- **Registry:** all 203 Stock Tokens from `api.robinhood.com/rhj/assets`, joined to Chainlink's feed directory by `scripts/tokens.py`.
- **Quicknode:** our Robinhood Chain mainnet endpoint is the primary upstream behind `/api/rpc` and the MCP server. Its **Stock Token API** add-on is served through `/api/qn`, with the key server-side:
  - `qn_getOracleHealth`: the US session (regular, pre-market, after-hours, overnight), Robinhood's mint window and sequencer status, shown in Market hours
  - `qn_getStockTokenBalances`: a wallet's Stock Tokens in shares and USD, shown in My account with "List this"
  - `qn_getTransactionFinality`: whether a settlement is soft, posted, safe or finalized on Ethereum, shown on each auction (auction #0's settlement shows FINALIZED in batch 388466)
  - `qn_getCorporateActions`: split and dividend history for a lot
  - MCP tools `portfolio`, `corporate_actions` and `tx_finality`, plus `market_status`, which uses oracle health
- **GetBlock:** RPC for the mainnet fork tests, and the server-side failover upstream (`GETBLOCK_RPC`) behind `/api/rpc`, the MCP server and the keeper. It serves the wide `eth_getLogs` reads that Quicknode's free plan caps at 5 blocks: the proxy skips Quicknode's `-32615` answer to the next upstream.
- **Pyth:** `/api/pyth` reads `Equity.US.X/USD` and `Equity.Index.X/USD` (24/7) from Hermes with a server-side Pyth Pro key. Since the Pyth Core upgrade (26 Aug 2026) Hermes needs a key, and equities need the Pro plan, so this stays dormant (`configured: false`) until a key is set. The Pyth contract on Robinhood Chain (`0xACeA…dF481`) has no pushed feeds to read instead.
- **Sourcify:** every deployment is verified with an exact match.
- **Slither:** static analysis on every version. The findings are triaged above and in the tests.

## Known limits
- Up to 64 bids per auction because the bids are sorted on-chain.
- Payouts are pushed at settlement, so a token that blocks a recipient would block settlement. Stock Tokens and USDG don't block recipients.
- The reveal makes bid size public, but only after commits have closed.

## Web
`web/` is a static page with viem bundled locally, plus Vercel functions under `web/api/`. The browser reads the chain only through `/api/rpc`, which fails over server-side (Quicknode → public RPC → GetBlock).

## Tests
- `forge test`: 22 tests (unit, fuzz, invariant, reentrancy, gas, mainnet fork).
- `cd e2e && npm i && npx playwright test`: 49 E2E tests against the live site on Chrome desktop and mobile, covering every desk route, chain and sponsor data, wallet flows, failure modes (Relay, RPC and Lighter down) and axe accessibility. Results and the bugs they caught are in [`docs/REPORT.md`](docs/REPORT.md).

Not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc.
