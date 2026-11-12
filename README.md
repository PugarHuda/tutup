# Tutup

**Sealed-bid batch auctions for Stock Tokens on Robinhood Chain, for the hours the market is closed. Bonds in $WIF.**

*Tutup* is Indonesian for "closed".

Stock Tokens trade 24/7. Their official Chainlink feeds update 24/5, and Authorised Participants can only mint and burn from Monday 02:00 to Saturday 02:00 CET. On weekends and during corporate actions nobody can arbitrage a token back to its share. RFQ quotes widen or vanish, and on a first-come-first-served sequencer, whoever is fastest sets the price.

Tutup replaces the race with a sealed-bid batch auction:

1. **commit**: a bidder posts `keccak256(abi.encode(id, bidder, qty, price, salt))` and a **50 $WIF bond**
2. **reveal**: the bidder opens the bid and escrows payment, and the bond comes back. A bond that is never revealed is **burned**.
3. **settle**: anyone can settle. The highest bids fill first and every winner pays the lowest winning price. Ties break on a hash, not on arrival order. Losers are refunded in full, and unsold lot returns to the seller.

Each listing burns **100 $WIF** through WIF's own `burn()`. Settlement records the Chainlink reference price next to the clearing price.

## Contract
- `src/Tutup.sol` is a single contract with no owner, admin, pause or upgrade
- Robinhood Chain (4663), v2: [`0x408bbe1cB335Bd81EACFD5d364Bb5970d8C4fe30`](https://robinhoodchain.blockscout.com/address/0x408bbe1cB335Bd81EACFD5d364Bb5970d8C4fe30), verified on Sourcify (exact match)
- v1 (first deployment, auction #0): [`0x0abdDa286cCD2033c0aF5d80d5132E52Ede177FE`](https://robinhoodchain.blockscout.com/address/0x0abdDa286cCD2033c0aF5d80d5132E52Ede177FE)

## Live on Robinhood Chain mainnet

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

## Integrations
- **Chainlink:** every Stock Token feed on 4663, both 24/5 and 24/7, and the ETH/USD and USDG/USD feeds for USD conversion. The feed is recorded at settlement.
- **ERC-8056 and Robinhood's token views:** `uiMultiplier`, `newUIMultiplier` and `effectiveAt` show pending corporate actions, and `oraclePaused()` flags them while they run.
- **Robinhood Stock Token API:** quotes and trading halts, read through a same-origin Vercel function (`web/api/rhj.js`) because the API sends no CORS headers.
- **Lighter:** the Robinhood Chain order book (`api.rh.lighter.xyz`) gives the last trade and best bid/ask when the official feed is frozen.
- **Relay:** "Get $WIF" quotes and executes ETH on Robinhood Chain, Arbitrum, Base or Ethereum into $WIF on 4663, then tracks the request with `/intents/status/v3`. This is how the project's own WIF was acquired.
- **Registry:** all 203 Stock Tokens from `api.robinhood.com/rhj/assets`, joined to Chainlink's feed directory by `scripts/tokens.py`.
- **GetBlock:** RPC for the mainnet fork tests.
- **Sourcify:** both deployments are verified with an exact match.

## Known limits
- Up to 64 bids per auction because the bids are sorted on-chain.
- Payouts are pushed at settlement, so a token that blocks a recipient would block settlement. Stock Tokens and USDG don't block recipients.
- The reveal makes bid size public, but only after commits have closed.

## Web
`web/` is a static page (viem from esm.sh). It reads the NVDA 24/5 and 24/7 Chainlink feeds to show whether the market is open.

Not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc.
