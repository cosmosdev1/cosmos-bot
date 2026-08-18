// Verify the batched balance read: does multicall3 on Polygon return the SAME numbers as the three
// sequential balanceOf calls it replaces, and how much faster? Read-only.
import { createPublicClient, http, fallback } from "viem";
import { polygon } from "viem/chains";

const ABI = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] }];
const TOKENS = [
  "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB", // pUSD
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC.e
  "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // native USDC
];
// A funder passed on the command line, else a known-funded Polymarket wallet.
const funder = process.argv[2] || "0x4b3c4565Ee415F4Bd0dD5f9C4e1B4C1e2f0a5C63";
const RPCS = (process.env.COSMOS_RPC_URLS || "https://polygon-bor-rpc.publicnode.com,https://polygon-rpc.com").split(",");
const client = createPublicClient({ chain: polygon, transport: fallback(RPCS.map((u) => http(u.trim()))) });

console.log(`funder ${funder}`);

// sequential (the old path)
const t0 = Date.now();
let seq = 0; const seqEach = [];
for (const token of TOKENS) {
  const raw = await client.readContract({ address: token, abi: ABI, functionName: "balanceOf", args: [funder] }).catch(() => 0n);
  seqEach.push(Number(raw) / 1e6);
  seq += Number(raw) / 1e6;
}
const seqMs = Date.now() - t0;

// batched (the new path)
const t1 = Date.now();
let batch = null, batchEach = [];
try {
  const res = await client.multicall({
    contracts: TOKENS.map((address) => ({ address, abi: ABI, functionName: "balanceOf", args: [funder] })),
    allowFailure: true,
  });
  batchEach = res.map((r) => (r?.status === "success" ? Number(r.result) / 1e6 : null));
  batch = res.every((r)=>r?.status==="success") ? res.reduce((t, r) => t + Number(r.result) / 1e6, 0) : null;
} catch (e) {
  console.log(`multicall threw: ${e?.message?.slice(0, 120)}`);
}
const batchMs = Date.now() - t1;

console.log(`sequential: $${seq.toFixed(6)}  [${seqEach.map((v) => v.toFixed(2)).join(", ")}]  ${seqMs}ms (3 requests)`);
console.log(`batched:    ${batch == null ? "FAILED -> falls back to sequential (safe)" : `$${batch.toFixed(6)}  [${batchEach.map((v) => (v == null ? "fail" : v.toFixed(2))).join(", ")}]  ${batchMs}ms (1 request)`}`);
if (batch != null) {
  const same = Math.abs(batch - seq) < 0.000001;
  console.log(`agreement: ${same ? "PASS - identical" : `FAIL - differs by $${Math.abs(batch - seq)}`}`);
  console.log(`requests: 3 -> 1 (${(seqMs / Math.max(batchMs, 1)).toFixed(1)}x faster)`);
}
