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
- Robinhood Chain (4663): [`0x0abdDa286cCD2033c0aF5d80d5132E52Ede177FE`](https://robinhoodchain.blockscout.com/address/0x0abdDa286cCD2033c0aF5d80d5132E52Ede177FE)

## Live on Robinhood Chain mainnet
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

## Known limits
- Up to 64 bids per auction because the bids are sorted on-chain.
- Payouts are pushed at settlement, so a token that blocks a recipient would block settlement. Stock Tokens and USDG don't block recipients.
- The reveal makes bid size public, but only after commits have closed.

## Web
`web/` is a static page (viem from esm.sh). It reads the NVDA 24/5 and 24/7 Chainlink feeds to show whether the market is open.

Not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc.
