// Keeper: settles every auction whose reveal window has closed. settle() is permissionless, so this only saves
// people a click; it runs from Vercel Cron (vercel.json) with its own throwaway wallet (KEEPER_KEY, a few cents of
// gas). Vercel signs cron calls with CRON_SECRET, so nobody else can make the keeper spend gas.
import { createPublicClient, createWalletClient, http, fallback, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const TUTUP = "0xd2Bfe52d5A0680DC7C3BE5BB19E1f75a568a5428";
const chain = { id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } };
const abi = parseAbi([
  "function auctionCount() view returns (uint256)",
  "function auctions(uint256) view returns (address seller, address lot, address quote, address feed, uint128 lotAmount, uint128 reserve, uint128 bond, uint128 minSold, uint64 commitEnd, uint64 revealEnd, uint32 commits, uint32 reveals, bool settled)",
  "function settle(uint256 id)",
]);

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "cron only" });
  }
  if (!process.env.KEEPER_KEY) return res.status(200).json({ configured: false });
  const transport = fallback([...(process.env.QUICKNODE_RPC ? [http(process.env.QUICKNODE_RPC)] : []), http("https://rpc.mainnet.chain.robinhood.com"), ...(process.env.GETBLOCK_RPC ? [http(process.env.GETBLOCK_RPC)] : [])]);
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ chain, transport, account: privateKeyToAccount(process.env.KEEPER_KEY) });
  const now = (await pub.getBlock()).timestamp;
  const n = Number(await pub.readContract({ address: TUTUP, abi, functionName: "auctionCount" }));
  const done = [];
  for (let id = 0; id < n; id++) {
    const a = await pub.readContract({ address: TUTUP, abi, functionName: "auctions", args: [BigInt(id)] });
    const [revealEnd, settled] = [a[9], a[12]];
    if (settled || now < revealEnd) continue;
    try {
      const hash = await wallet.writeContract({ address: TUTUP, abi, functionName: "settle", args: [BigInt(id)] });
      const r = await pub.waitForTransactionReceipt({ hash });
      done.push({ id, hash, status: r.status });
    } catch (e) {
      done.push({ id, error: e.shortMessage || e.message });
    }
  }
  return res.status(200).json({ checked: n, settled: done });
}
