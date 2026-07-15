// One-time: deploy the owner's Polymarket deposit wallet on-chain so ERC-1271 order
// validation can run. Gasless (relayer pays), permissionless CREATE2, moves no funds.
// Run: node deploy-deposit-wallet.mjs   (reads qtable-live.env in this dir)
import { readFileSync } from "fs";
import { createWalletClient, http, createPublicClient } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { RelayClient } from "@polymarket/builder-relayer-client";

const env = readFileSync(new URL("./qtable-live.env", import.meta.url), "utf8");
const key = (env.match(/^POLYMARKET_PRIVATE_KEY=(.+)$/m) || [])[1]?.trim();
const funder = (env.match(/^POLYMARKET_FUNDER=(.+)$/m) || [])[1]?.trim();
if (!key) { console.error("no POLYMARKET_PRIVATE_KEY in qtable-live.env"); process.exit(1); }

const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain: polygon, transport: http() });
const pub = createPublicClient({ chain: polygon, transport: http() });
const client = new RelayClient("https://relayer-v2.polymarket.com", 137, wallet);

console.log("EOA signer            :", account.address);
const derived = await client.deriveDepositWalletAddress();
console.log("derived deposit wallet:", derived);
console.log("funder in env         :", funder);
console.log("addresses match       :", derived.toLowerCase() === (funder || "").toLowerCase() ? "YES ✅" : "NO ❌");

const code0 = await pub.getCode({ address: derived });
if (code0 && code0 !== "0x") {
  console.log(`already deployed (code len ${code0.length}) — nothing to do`);
  process.exit(0);
}
console.log("not deployed on-chain — submitting WALLET-CREATE to the relayer…");
const resp = await client.deployDepositWallet();
console.log("submitted:", { id: resp.transactionID, state: resp.state, hash: resp.transactionHash });
const final = await resp.wait();
console.log("final:", final ? { state: final.state, hash: final.transactionHash } : "TIMED OUT / FAILED");
const code1 = await pub.getCode({ address: derived });
console.log("getCode after deploy  :", code1 && code1 !== "0x" ? `DEPLOYED ✅ (len ${code1.length})` : "STILL EMPTY ❌");
