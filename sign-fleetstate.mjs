#!/usr/bin/env node
// FLEET HALT SIGNER (owner-only, offline). Produces a signed FLEETSTATE file that every bot verifies
// against the public key baked into src/fleetstate.mjs. The private key NEVER lives in this repo or on
// any server — you hold it offline and pass it here. FLEETSTATE can only HALT or TIGHTEN the fleet; it
// can never cause a trade, so its worst-case compromise is a denial of service, not a drain.
//
//   Halt everyone:     COSMOS_FLEET_KEY=./fleet-priv.pem node sign-fleetstate.mjs halt "reason here"
//   Resume everyone:   COSMOS_FLEET_KEY=./fleet-priv.pem node sign-fleetstate.mjs resume
//   Tighten sizing:    COSMOS_FLEET_KEY=./fleet-priv.pem node sign-fleetstate.mjs tighten 2   (max 2%/trade)
//
// Then commit the printed FLEETSTATE to this repo's main (bots pull it in <=60s), or paste it to the
// out-of-band URL the bot polls. `ts` must strictly increase — the bots reject any older state, so a
// replay of an old "resume" can't override a live "halt".
import crypto from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [mode, arg] = process.argv.slice(2);
const keyPath = process.env.COSMOS_FLEET_KEY;
if (!keyPath) { console.error("Set COSMOS_FLEET_KEY=/path/to/fleet-priv.pem"); process.exit(1); }
if (!["halt", "resume", "tighten"].includes(mode || "")) { console.error("usage: sign-fleetstate.mjs halt|resume|tighten [arg]"); process.exit(1); }

const privateKey = crypto.createPrivateKey(readFileSync(keyPath, "utf8"));
const payload = {
  halt: mode === "halt",
  reason: mode === "halt" ? String(arg || "manual halt") : "",
  max_trade_pct: mode === "tighten" ? Number(arg) || 1 : null,   // null = leave the bot's own cap
  ts: Math.floor(Date.now() / 1000),
};
// CANONICAL bytes: fixed key order, both signer and bot serialize identically.
const canon = JSON.stringify(payload, ["halt", "reason", "max_trade_pct", "ts"]);
const sig = crypto.sign(null, Buffer.from(canon, "utf8"), privateKey).toString("base64");
const out = JSON.stringify({ payload, sig }, null, 2);
writeFileSync("FLEETSTATE", out + "\n");
console.log(out);
console.error(`\nwrote FLEETSTATE (${mode}${arg ? " " + arg : ""}, ts ${payload.ts}). Commit it to main and the fleet applies it within ~60s.`);
