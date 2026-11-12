// Timelocked bid receipts (drand quicknet + tlock). A sealed bid's receipt { qty, price, salt } is encrypted to the
// drand round at the auction's commitEnd and appended to the commit transaction's calldata. Solidity ignores
// trailing calldata, so the contract is unchanged. Before commits close nobody can read it. Once they close the
// drand beacon for that round is public, so the bidder (or their agent) can recover the receipt from the chain
// alone: a lost receipt file no longer means a burned bond.
// Used by the desk (bundled to tlock.bundle.js) and by the MCP server (api/mcp.js).
import { timelockEncrypt, timelockDecrypt, mainnetClient, roundAt, Buffer } from "tlock-js";

const MAGIC = "54555450"; // "TUTP", marks a Tutup backup after the 68-byte commit(uint256,bytes32) calldata
const COMMIT_LEN = 2 + (4 + 32 + 32) * 2; // "0x" + selector + two words, in hex chars
let client;
const drand = () => (client ??= mainnetClient()); // drand quicknet, 3s rounds, unchained BLS on G1
// roundAt(t) is the round already published at t, so locking to commitEnd itself could open a few seconds early,
// and the sequencer's block.timestamp can trail wall-clock time. Lock 60s past commitEnd so nobody can read sealed
// bids while commits are still accepted.
// ponytail: fixed 60s margin; an Orbit sequencer may lag further in theory, raise it if timestamps are seen drifting
export const UNLOCK_MARGIN_S = 60;

/// Hex (no 0x) to append to commit calldata: the receipt, locked until a minute after `unlockAt` (unix seconds).
export async function sealReceipt(receipt, unlockAt) {
  const info = await drand().chain().info();
  const round = roundAt((Number(unlockAt) + UNLOCK_MARGIN_S) * 1000, info) + 1; // + 1: first round published after that time
  const ct = await timelockEncrypt(round, Buffer.from(JSON.stringify({ qty: String(receipt.qty), price: String(receipt.price), salt: receipt.salt })), drand());
  return MAGIC + Buffer.from(ct, "utf8").toString("hex");
}

/// Does this commit calldata carry a backup?
export const hasBackup = (input) => typeof input === "string" && input.slice(COMMIT_LEN, COMMIT_LEN + 8).toLowerCase() === MAGIC.toLowerCase();

/// Decrypt the receipt from commit calldata. Throws "too early" until its round (a minute after commitEnd) is published.
export async function openReceipt(input) {
  if (!hasBackup(input)) throw new Error("this commit carries no timelocked backup");
  const ct = Buffer.from(input.slice(COMMIT_LEN + 8), "hex").toString("utf8");
  const r = JSON.parse((await timelockDecrypt(ct, drand())).toString("utf8"));
  if (!/^\d+$/.test(r.qty) || !/^\d+$/.test(r.price) || !/^0x[0-9a-fA-F]{64}$/.test(r.salt)) throw new Error("backup is not a Tutup receipt");
  return r;
}
