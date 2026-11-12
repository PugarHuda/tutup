# Tutup — submission draft

## Step 1 · your team
- team name: Ampun Bang
- github profile: https://github.com/PugarHuda
- contact handle: @BangDropID (X) / @bangdropid (Telegram)
- email: (yours)

## Step 2 · your project
- name: Tutup
- one liner (<=80 chars): Sealed-bid auctions for Stock Tokens when the market is closed. Bonds in $WIF.
- categories: Stock Tokens, hooks and defi, tools and infra

### what it does
Tutup ("closed" in Indonesian) runs sealed-bid batch auctions on Robinhood Chain for the hours the stock market is shut.

Stock Tokens trade 24/7, but their 24/5 Chainlink feeds stop at the close and Authorised Participants can only mint and burn from Monday 02:00 to Saturday 02:00 CET. On weekends and during corporate actions nobody can arbitrage the token back to the share, RFQ quotes widen or vanish, and on a first-come-first-served sequencer whoever is fastest takes the price.

A seller escrows a lot (NVDA, SPY, any Stock Token, or a block of $WIF). Bidders commit a hash of their quantity and price plus a $WIF bond, then reveal and escrow payment. At settlement the highest bids fill first and every winner pays one price: the lowest winning bid. Order inside a phase doesn't matter, ties break on a hash, and losers are refunded in full. The settlement records the Chainlink reference price next to the clearing price, so every weekend auction leaves a public, comparable price.

### who it's for
- Stock Token holders who need to sell or rebalance on a weekend without being picked off
- buyers who want a fair weekend price instead of a stale feed or a wide RFQ quote
- large $WIF holders and buyers: WIF pools hold very little liquidity, so a block of WIF clears better in a sealed auction than in a pool

## Step 3 · how it connects to $wif
### wif usage
$WIF is the cost of making a credible bid and the price of listing:
- every listing burns 100 $WIF through WIF's own burn()
- every sealed bid posts a 50 $WIF bond. Reveal and it comes back; don't reveal and it's burned. This is what stops fake bids, spam and last-minute griefing, because a sealed bid costs nothing to fake otherwise.
- $WIF itself can be the lot or the payment token, so WIF blocks get a fair venue too

- integration types: (pick: token burn / bond-collateral / payment)
- contract addresses: Tutup v3 = 0xd2Bfe52d5A0680DC7C3BE5BB19E1f75a568a5428 · TutupFeed WIF/WETH = 0xDe80aC53aBB6bB595Ea4D023f4B826F7F4C269dE · v2 = 0x408bbe1cB335Bd81EACFD5d364Bb5970d8C4fe30 (v1 = 0x0abdDa286cCD2033c0aF5d80d5132E52Ede177FE) · WIF 0x5173b8eA6923c2d40267890D45C46a3480954773

## Step 4 · your flywheel
- action: sellers list a lot for the next market close; bidders seal bids
- wif: each listing burns WIF, each bid locks a WIF bond, unrevealed bonds burn
- return: every settled auction publishes a clearing price next to the oracle price. More bidders make that price fairer, which brings sellers back for the next close, which brings bidders back. Auctions recur every night, every weekend and every corporate action.

## Step 5 · proof of build
- repo: https://github.com/PugarHuda/tutup
- demo video (2:17): https://youtu.be/eXyt-ZirmPc
- live url: https://tutup.vercel.app
- tx hashes (v3):
  - 0x128b9402f2fffb25ca6c2c3bba84f3c760ab7a91d776fab68281204a5c26b9b8  (deploy v3)
  - 0x626f29532a47305451c0e22684b1846ec606765bd4aa41a9b47e2918efb92a8d  (create (100 $WIF burned, minSold 40))
  - 0x783ff1eb7a91d99e53b97a42d70b5f0de4ff0231ab5624d7ee24fd92e00062ca  (commit, bidder 1)
  - 0x3524ac9aa9bf9c3dfc93d58089b53a5b8d0083d3f43f0af5d60a09a25900d3c9  (commit, bidder 2)
  - 0x9d74a8ead4246c01f561034e88c4fff98e0c270f53b0985cfae845e9d40f4fa3  (reveal, bidder 1)
  - 0xae3fd2025b76d6d9f8d3fc74af13baa73f1cdf095b476396b3657bbffac54512  (reveal, bidder 2)
  - 0xcbcbefacec6a383d85b0c63300e70b7c7839cf029d156710574c274c11368ba0  (settle (writes lastPrint))
  - 0x2cb7704eecc26406593b8e10a2999b595bfa665a25d6faebda88b8c72d8b1ce7  (deploy TutupFeed WIF/WETH)
  - 0x2a3ee4fc78b5efd84cb46f275c7a72d591e10f717838d42c633e7fdc2276fa88  (deploy TutupFeed NVDA/WETH 0x1Db46a08C722A9ac57bd6aa5d07cbb9c5ec5C3f7)
- tx hashes (v2):
  - 0xc0e46b461e3a50271c051eebccf279ecce23aaa035e804f1a9f3200ab2a6f8d1  (deploy v2)
  - 0x444d6cfb38e29b440ae825f69adcab5b97b36ea28bd4137038f4dd75c8f72fa8  (create (100 $WIF burned))
  - 0xa84be072f54034b8a8dda0f1a27f328b44f88b599d1c64c11d6a955df4118df6  (commit, bidder 1)
  - 0xa39f3f1fd0ea26e6e8708efab699d365f8b7e32945802ebc5855a9a6949d2f69  (commit, bidder 2)
  - 0x5c9e7dccc5aea0ddd2b5fd83881cb8db706257d90dbf86a12eb5d94ef62c7f88  (reveal, bidder 1)
  - 0xe53577cc700e1fabc4356dcff0bf0e7a531a819e4e53de47499bf4cc0eeb3861  (reveal, bidder 2)
  - 0x5e7af74a6e1a6053af07d50da9809fcc876eae3eb75f3864b8167c8a60ac55fc  (settle (writes lastPrint))
- tx hashes (v1):
  - 0x84183838c9287eddac276891e53c643004f756d374470ffc892d3e86aa37aa77  (create (100 $WIF burned))
  - 0xdcec7e21e3f8630f7a3174cd5aedf5866dad5ecc6caaa07a5b6898ba73e10d2c  (commit, bidder 1)
  - 0x5a44b7a9f22ba2bfeff835011fc47345122bd41ca99ffed09ae6b06ed6961349  (commit, bidder 2)
  - 0x22ab9181ed09d167b88d564809d7511a9f840298781706e7aa83428294528d13  (reveal, bidder 1)
  - 0x322d409fde8cbe94a6b6c83bad606a48722866f533d79f083c804d6cff87c962  (reveal, bidder 2)
  - 0x71b67d9ec902dd930019a148bca9aa8bb5984fb11b87cff3ed30092852b080f2  (settle)

### how it's made
- Solidity 0.8.24, Foundry. One contract, no owner, no admin, no pause, no upgrade. Source verified on Sourcify (exact match).
- Unit and fuzz tests (uniform price, partial fill, refunds, conservation of every token) plus a fork test against Robinhood Chain mainnet with the real WIF, NVDA and USDG contracts, which proves the listing burn reduces WIF's real totalSupply.
- Chainlink: the NVDA/TSLA/GOOGL 24/7 feeds as the reference price, the 24/5 feeds to show when the market is closed.
- RPC: Quicknode first (plus its Stock Token API, Streams and ERC-8004 API), then the public RPC, then GetBlock, which serves wide log reads that Quicknode's free plan caps at 5 blocks.
- Bid receipts are drand-timelocked into the commit calldata, so a lost salt no longer burns a bond.
- Tests: 22 Foundry tests and 49 Playwright E2E tests against the live site (`e2e/`, report in `docs/REPORT.md`).
- Commit-reveal instead of TEE or FHE: Robinhood Chain has neither, and a sealed bid only needs to stay hidden until the commit window closes.
- Built by a solo builder whose sealed-bid desks won 1st at iExec Vibe Coding (Diam) and 1st + Best in Track at HackCanton S3 (Talang). Tutup carries that auction design to Robinhood Chain.

### known limits (honest)
- Up to 64 bids per auction (on-chain sort). An off-chain sorted hint would lift it.
- Payouts are pushed at settlement; a token that blocks a recipient would block settlement. Stock Tokens and USDG don't, and pull claims are the fix if one does.
- Reveal escrows payment, so the bid size becomes public once reveals open. That's after commits close, so it can't be front-run.

### what's next
Auto-opening auctions on corporate actions (oraclePaused), a keeper that lists for market makers every Friday close, TutupFeeds for every Stock Token pair, gasless bids once a paymaster supports Robinhood Chain, and outside bidders and agents rating Tutup on ERC-8004.

## Step 6 · review
- payout address: (your wallet)
- ok to feature: yes
- agree to terms: yes
