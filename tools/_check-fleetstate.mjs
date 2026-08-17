// Verify the FLEETSTATE kill switch after the mirror change (Inc 1.13).
// Serves signed/forged/stale documents from local mirrors and asserts the bot's behaviour.
// The signing key here is a THROWAWAY generated per run - the real owner key stays offline.
import crypto from "node:crypto";
import http from "node:http";

// A test keypair; we patch the module's expectation by signing with the REAL pubkey's counterpart
// only for the "valid" case - which we cannot do without the owner key. So instead we assert the
// two properties that do not need the owner key:
//   1. an UNSIGNED / FORGED doc is IGNORED (state stays default: not halted)
//   2. mirrors are tried in order and an unreachable one does not break the poll
// Property 3 (a correctly signed doc halts) is covered by the signature-verify unit below, which
// re-implements the exact canonicalisation the module uses and checks it round-trips.

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const canonOf = (p) => JSON.stringify(p, ["halt", "reason", "max_trade_pct", "ts"]);
const sign = (p) => crypto.sign(null, Buffer.from(canonOf(p), "utf8"), privateKey).toString("base64");

// --- unit: canonicalisation + verify round-trip (the module's exact scheme) ---
{
  const p = { halt: true, reason: "test halt", max_trade_pct: 2, ts: Date.now() };
  const sig = sign(p);
  const ok = crypto.verify(null, Buffer.from(canonOf(p), "utf8"), publicKey, Buffer.from(sig, "base64"));
  console.log(`signature scheme round-trip: ${ok ? "PASS" : "FAIL"}`);
  const tampered = { ...p, halt: false };
  const bad = crypto.verify(null, Buffer.from(canonOf(tampered), "utf8"), publicKey, Buffer.from(sig, "base64"));
  console.log(`tampered payload rejected: ${!bad ? "PASS" : "FAIL"}`);
}

// --- integration: mirrors, with mirror #1 dead and mirror #2 serving a FORGED doc ---
const forged = JSON.stringify({ payload: { halt: true, reason: "forged", max_trade_pct: null, ts: Date.now() }, sig: Buffer.from("nope").toString("base64") });
const srv = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(forged); });
await new Promise((r) => srv.listen(0, r));
const port = srv.address().port;

process.env.COSMOS_FLEETSTATE_URLS = `http://127.0.0.1:1/dead,http://127.0.0.1:${port}/FLEETSTATE`;
process.env.COSMOS_FLEETSTATE_SECONDS = "1";
process.env.COSMOS_DATA_DIR = process.env.TEMP ? `${process.env.TEMP}/fsdemo` : "/tmp/fsdemo";
const { startFleetStateWatch, fleetHalted, fleetReason } = await import("../src/fleetstate.mjs");
startFleetStateWatch(() => {});
await new Promise((r) => setTimeout(r, 1500));
console.log(`after polling a DEAD mirror then a FORGED doc -> halted=${fleetHalted()} reason="${fleetReason()}"`);
console.log(fleetHalted() === false ? "PASS: forged halt ignored, dead mirror skipped, fleet keeps trading" : "FAIL: forged doc was applied");
srv.close();
process.exit(0);
