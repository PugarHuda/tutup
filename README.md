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
- Robinhood Chain (4663): `TBD`

## Tests
```
forge test                                                   # unit + fuzz
FORK_RPC=<robinhood rpc> forge test --match-contract Fork    # real WIF, NVDA, USDG on mainnet
```

## Known limits
- Up to 64 bids per auction because the bids are sorted on-chain.
- Payouts are pushed at settlement, so a token that blocks a recipient would block settlement. Stock Tokens and USDG don't block recipients.
- The reveal makes bid size public, but only after commits have closed.

## Web
`web/` is a static page (viem from esm.sh). It reads the NVDA 24/5 and 24/7 Chainlink feeds to show whether the market is open.

Not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc.
