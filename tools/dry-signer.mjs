// Proves the signer refactor is behaviour-preserving for the LOCAL path.
// Run: node tools/dry-signer.mjs
//
// The refactor moved account creation out of makePolymarket() and behind makeSigner(). If that
// changed the signing identity or the produced signature by even one byte, every order this fleet
// places would be rejected (or worse, signed by an unexpected address). So: sign a REAL Polymarket
// Order struct and a REAL ClobAuthDomain message both ways and require byte-identical output.
//
// Uses a throwaway key generated here. No real key is ever read by this script.

import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { makeSigner, signerMode } from "../src/signer.mjs";

const KEY = generatePrivateKey();
const old = privateKeyToAccount(KEY);
const { account: neu, address, mode } = await makeSigner({ polymarket: { privateKey: KEY } });

let fail = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
};

console.log(`signer mode: ${mode} (COSMOS_SIGNER=${signerMode()})\n`);
check("mode is local by default", mode === "local");
check("address matches privateKeyToAccount", old.address === neu.address, `${old.address} vs ${neu.address}`);
check("makeSigner returns the same address it reports", address === neu.address);

// --- the real Polymarket Order struct (clob-client-v2 V2 order) ---
const orderTypedData = {
  domain: { name: "Polymarket CTF Exchange", version: "2", chainId: 137, verifyingContract: "0xE111180000d2663C0091e4f400237545B87B996B" },
  types: {
    Order: [
      { name: "salt", type: "uint256" }, { name: "maker", type: "address" }, { name: "signer", type: "address" },
      { name: "tokenId", type: "uint256" }, { name: "makerAmount", type: "uint256" }, { name: "takerAmount", type: "uint256" },
      { name: "side", type: "uint8" }, { name: "signatureType", type: "uint8" }, { name: "timestamp", type: "uint256" },
      { name: "metadata", type: "bytes32" }, { name: "builder", type: "bytes32" },
    ],
  },
  primaryType: "Order",
  message: {
    salt: 123456789n, maker: old.address, signer: old.address,
    tokenId: 5796422734184917167767864171106581710564038766185046082507000537377191105585n,
    makerAmount: 2000000n, takerAmount: 3225806n, side: 0, signatureType: 2, timestamp: 1784875846n,
    metadata: "0x0000000000000000000000000000000000000000000000000000000000000000",
    builder: "0xbb05bc9c71cb8e40ba9a0fab6e58bcac9df3cb53fb0b2553628b3c2bde5d6bf7",
  },
};

// --- the real CLOB L1 auth message ---
const authTypedData = {
  domain: { name: "ClobAuthDomain", version: "1", chainId: 137 },
  types: {
    ClobAuth: [
      { name: "address", type: "address" }, { name: "timestamp", type: "string" },
      { name: "nonce", type: "uint256" }, { name: "message", type: "string" },
    ],
  },
  primaryType: "ClobAuth",
  message: { address: old.address, timestamp: "1784875846", nonce: 0n, message: "This message attests that I control the given wallet" },
};

for (const [label, td] of [["Order", orderTypedData], ["ClobAuth", authTypedData]]) {
  const a = await old.signTypedData(td);
  const b = await neu.signTypedData(td);
  check(`${label} signature is byte-identical`, a === b, a === b ? `${a.slice(0, 22)}...` : `${a.slice(0, 22)} vs ${b.slice(0, 22)}`);
}

// --- the failure modes must be loud, never silent ---
let threw = false;
try { await makeSigner({ polymarket: {} }); } catch { threw = true; }
check("missing key throws instead of returning a broken signer", threw);

process.env.COSMOS_SIGNER = "nonsense";
const { makeSigner: fresh } = await import("../src/signer.mjs?bust=" + Date.now());
threw = false;
try { await fresh({ polymarket: { privateKey: KEY } }); } catch { threw = true; }
check("unknown COSMOS_SIGNER throws", threw);

console.log(`\n${fail === 0 ? "LOCAL PATH IS BYTE-IDENTICAL" : fail + " FAILURE(S)"}`);
process.exit(fail === 0 ? 0 : 1);
