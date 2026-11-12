# Drafts to post after submitting

## Project update 1 (worldisflat.fun project page)
Tutup is live: sealed-bid auctions that set the weekend price for Robinhood Stock Tokens, bonded in $WIF.

Two auctions are open right now and run through this weekend's market close:
• #2: 0.0025 NVDA (a real Stock Token, bought through the Uniswap v3 pool on Robinhood Chain) for WETH
• #1: 100 $WIF for WETH

Commits close Sat 15 Nov 14:00 UTC, while the official Chainlink feeds are frozen. Reveals close Sun 12:00 UTC, and a keeper settles at 12:15. Every winner pays one clearing price, and the price is written onchain as lastPrint (TutupFeed serves it behind Chainlink's interface).

Bid: https://tutup.vercel.app/app.html#a/2. The 50 $WIF bond comes back when you reveal. Need WIF? There's a "Get $WIF" page (Relay).

## Project update 2
What a judge can check in two minutes:
• Contract v3, no owner, Sourcify exact match: 0xd2Bfe52d5A0680DC7C3BE5BB19E1f75a568a5428
• 300 $WIF burned so far through WIF's own burn()
• 3 settled auctions across v1–v3 plus 2 open now
• Each auction compares 7 price sources: Chainlink 24/5 and 24/7, Lighter, Robinhood's quote, Uniswap v3, Quicknode oracle health and ERC-8056
• Agents can bid through MCP (https://tutup.vercel.app/api/mcp), and the MCP server is ERC-8004 agent #25584 on Robinhood Chain
• Quicknode's Stock Token API shows our settlement FINALIZED on Ethereum

## X thread
1/ Robinhood Stock Tokens trade 24/7. Their official price feeds don't. From Friday night to Sunday night, and during every corporate action, nobody can mint, nobody can arbitrage, and the fastest bot sets the price.

Tutup sets that price with sealed bids instead. 🔒 https://tutup.vercel.app

2/ How it works:
• seal a bid (hash + $WIF bond)
• reveal together after bidding closes
• everyone who wins pays the same clearing price
Being first wins nothing. Never reveal → your $WIF bond is burned.

3/ Live this weekend on Robinhood Chain: a real NVDA Stock Token lot and a 100 $WIF lot. Commits close Saturday, during the weekend gap. Come bid: https://tutup.vercel.app/app.html#a/2

4/ Every clearing price is written onchain and served through a Chainlink-compatible feed (TutupFeed), so a lending market can read the weekend price with zero new code.

5/ Built for agents too: an MCP server that prepares sealed bids for an agent's own wallet, registered onchain as ERC-8004 agent #25584. Powered by @Quicknode's Stock Token API and @getblockio RPC.

6/ One contract, no owner, verified, fuzz and invariant tested, fork-tested on mainnet. Built for the @WIFonRH hackathon. github.com/PugarHuda/tutup
