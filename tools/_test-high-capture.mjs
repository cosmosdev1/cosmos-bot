// HIGH-CAPTURE V1 CONTRACT (owner 2026-09-06). Two halves:
//   1. the profile: default = every strategy gate on (old behaviour byte-for-byte); high_capture = exactly
//      the five old strategy gates off, the owner's v2 ceiling and the 1c tick as the band;
//   2. the SOURCE: the five strategy gates are routed through the profile at every site, and no hard
//      gate is - cash, floor, sizing floor, position ceiling, cooldown, in-flight, already-holding,
//      buy-once, no-rebuy, exits. A future edit that wraps a hard gate with G() fails here.
import assert from "node:assert";
import fs from "node:fs";
import { gateProfile } from "../src/high-capture.mjs";
let pass = 0, fail = 0;
const ck = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };

const off = gateProfile(false, 97), on = gateProfile(true, 97);
ck("default profile: all five strategy gates ON", off.priceBand && off.priceGate && off.rateLimit && off.driverMatch && off.venueBackoff);
ck("high-capture: all five strategy gates OFF", !on.priceBand && !on.priceGate && !on.rateLimit && !on.driverMatch && !on.venueBackoff);
ck("high-capture band: the owner's v2 ceiling (97c) and the 1c tick", on.entryCap === 97 && on.entryFloor === 1);
ck("undefined / junk / string 'true' are NOT high-capture (fail closed to the old behaviour)", gateProfile(undefined).priceGate && gateProfile(null).priceGate && gateProfile("true").priceGate && gateProfile(1).priceGate);
ck("ceiling never exceeds 99c and survives junk", gateProfile(true, 150).entryCap === 99 && gateProfile(true, NaN).entryCap === 97 && gateProfile(true, 0).entryCap === 97);
ck("profile is frozen (no runtime widening)", Object.isFrozen(on) && Object.isFrozen(off));
ck("profile has NO key for any hard gate", !("cash" in on) && !("floor" in on) && !("cooldown" in on) && !("inflight" in on) && !("buyOnce" in on) && !("noRebuy" in on) && !("risk" in on) && !("exit" in on));

// ---- source contract --------------------------------------------------------------------------------
const src = fs.readFileSync(new URL("../src/copytrade.mjs", import.meta.url), "utf8");
const count = (re) => (src.match(re) || []).length;
ck("venue_backoff is behind the profile", count(/G\(\)\.venueBackoff && Date\.now\(\) < venueBackoffUntil/g) === 1);
ck("rate_limited is behind the profile at all 3 sites (the fast path checks once for entry and top-up), and nowhere bare", count(/G\(\)\.rateLimit && rateLimited\(\)/g) === 3 && count(/if \(rateLimited\(\)\)/g) === 0);
ck("add_driver_mismatch is behind the profile", count(/G\(\)\.driverMatch && boundTo/g) === 1);
ck("price_gate is behind the profile at both sites, and nowhere bare", count(/G\(\)\.priceGate && \(ONESHOT \|\| V2\(\)\) && tooFarFromHisEntry/g) === 2 && count(/if \(\(ONESHOT \|\| V2\(\)\) && tooFarFromHisEntry/g) === 0);
ck("entry band is behind the profile at both sites (pair legs keep their arb cap)", count(/G\(\)\.priceBand \|\| sig\.is_pair \? inPlayBand\(sig, cap, floor\) : \{ cap: G\(\)\.entryCap, floor: G\(\)\.entryFloor \}/g) === 2);
ck("add band is behind the profile at both sites", count(/G\(\)\.priceBand \? addCapFor\(sig\) : G\(\)\.entryCap, G\(\)\.priceBand \? MIN_ADD_CENTS : G\(\)\.entryFloor/g) === 2);
// hard gates must never be guarded by the profile
for (const hard of ["cash_insufficient", "local_floor", "portfolio_floor", "cooldown", "inflight", "already_holding", "buy_once", "no_rebuy", "add_below_min", "target_below_min", "tier_zero", "window_dead", "window_wait"]) {
  const lines = src.split("\n").filter((l) => l.includes(`"${hard}"`));
  ck(`hard gate ${hard} is never behind G() (${lines.length} site(s))`, lines.length > 0 && lines.every((l) => !/G\(\)\./.test(l)));
}
ck("the profile is consulted only through G()", count(/gateProfile\(/g) === 1 && /const G = \(\) => gateProfile\(state\.highCapture === true, V2_MAX_ENTRY_CENTS\)/.test(src));
const bot = fs.readFileSync(new URL("../src/bot.mjs", import.meta.url), "utf8");
ck("bot maps settings.high_capture === true only (never truthy strings)", /qtState\.highCapture = settings\.high_capture === true;/.test(bot));
console.log("\n" + (fail === 0 ? "ALL PASS" : "FAILURES") + ": " + pass + " passed, " + fail + " failed");
assert.equal(fail, 0);
