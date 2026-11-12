// Quicknode Streams filter (Robinhood Chain mainnet, dataset "logs"). Paste into the stream's filter editor.
// Keeps only Tutup contract logs; returning null skips the delivery, so blocks without Tutup activity cost nothing downstream.
function main(stream) {
  const TUTUP = "0xd2bfe52d5a0680dc7c3be5bb19e1f75a568a5428";
  const logs = [stream.data].flat(3).filter((l) => l && String(l.address).toLowerCase() === TUTUP);
  if (!logs.length) return null;
  return { tutup: logs.map((l) => ({ address: l.address, topics: l.topics, transactionHash: l.transactionHash, blockNumber: l.blockNumber })) };
}
