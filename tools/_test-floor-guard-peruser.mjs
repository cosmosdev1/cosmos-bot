// The 2G local guard must refuse at the SAME line as the server backstop for THIS user (floor - 5),
// never at the fleet constant: with a $50 per-user floor the server allows down to $45, so a local
// line of $48 would refuse buys the server would sign - the bot/server mismatch the end-to-end
// floor removes. Fail-open behaviour and the env override are unchanged.
import assert from "node:assert";
import { floorGuardVerdict, DEFAULTS } from "../src/floor-guard.mjs";
let pass = 0, fail = 0;
const ck = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const now = 1_000_000, fresh = now - 10_000;
const v = (o) => floorGuardVerdict({ cash: 20, pmValue: 26, portfolioAt: fresh, now, env: {}, ...o });   // gate-like $46
ck("fleet default: line is 50 - 2 = 48, $46 is a deny", v({}).line === 48 && v({}).verdict === "deny");
ck("per-user floor $50 -> server line 45 -> local line 43: $46 is ALLOWED (tolerance band)", v({ floorUsd: 45 }).line === 43 && v({ floorUsd: 45 }).verdict === "allow");
ck("per-user floor $55 (no override) -> line 48, identical to the fleet default", v({ floorUsd: 50 }).line === 48);
ck("gate-like $42 under a $43 line still denies", floorGuardVerdict({ cash: 20, pmValue: 22, portfolioAt: fresh, now, floorUsd: 45 }).verdict === "deny");
ck("env COPY_2G_GATE_FLOOR_USD still overrides the per-user value", v({ floorUsd: 45, env: { COPY_2G_GATE_FLOOR_USD: "60" } }).line === 58);
ck("junk floorUsd falls back to the default", v({ floorUsd: NaN }).line === 48 && v({ floorUsd: -3 }).line === 48 && v({ floorUsd: null }).line === 48);
ck("fail-open unchanged: no cash read -> unknown", floorGuardVerdict({ cash: null, pmValue: 26, portfolioAt: fresh, now, floorUsd: 45 }).verdict === "unknown");
ck("fail-open unchanged: stale portfolio -> unknown", floorGuardVerdict({ cash: 20, pmValue: 26, portfolioAt: now - 400_000, now, floorUsd: 45 }).verdict === "unknown");
ck("DEFAULTS untouched", DEFAULTS.GATE_FLOOR_USD === 50 && DEFAULTS.MARGIN_USD === 2);
console.log("\n" + (fail === 0 ? "ALL PASS" : "FAILURES") + ": " + pass + " passed, " + fail + " failed");
assert.equal(fail, 0);
