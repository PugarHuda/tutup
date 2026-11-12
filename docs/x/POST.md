# X post draft: Tutup submission (World is Flat)

Attach: `1-landing.png`, `2-nvda-auction.png`, `3-auctions.png`, `4-wif-burns.png` (this folder). Post it from @BangDropID.

## Main post

Stock Tokens on Robinhood Chain trade 24/7. Their official price feeds don't.

Meet Tutup: sealed-bid auctions for the hours the market is closed, bonded in $WIF.

Seal a bid, reveal it, and every winner pays one clearing price. Every listing burns 100 $WIF.

Live on mainnet 👇
https://tutup.vercel.app

## Reply 1

How it works:
- commit a hash of your bid + a $WIF bond
- reveal after commits close, and the bond comes back
- never reveal, and the bond burns

The receipt is drand-timelocked inside the commit calldata, so a lost salt no longer costs you your bond.

## Reply 2

Every sale writes its price on chain behind a Chainlink-compatible feed, so other protocols can read the weekend price.

Feeds live: WIF/WETH and NVDA/WETH. A real NVDA lot is up for auction this weekend.

## Reply 3

Built for @WIFonRH's World is Flat hackathon with @QuickNode (RPC, Stock Token API, Streams, ERC-8004 API), @GetBlock_io, @chainlink and @RelayProtocol.

Tutup is also an MCP server and ERC-8004 agent #25584, so AI agents can bid too.

Demo (2:59): https://youtu.be/Dnh1mNN6ZME
Code: https://github.com/PugarHuda/tutup
