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
ck("server no_book is remembered per token for a bounded time and re-checked, never terminal", /noBookUntil\.set\(String\(sig\.token_id\), Date\.now\(\) \+ NO_BOOK_MEMO_MS\)/.test(src) && /tr\?\.block\("venue_no_book", \{/.test(src) && /NO_BOOK_MEMO_MS = N\("COPY_NO_BOOK_MEMO_MS", 10 \* 60_000\)/.test(src));
for (const hard of ["cash_insufficient", "local_floor", "portfolio_floor", "cooldown", "inflight", "already_holding", "buy_once", "no_rebuy", "add_below_min", "target_below_min", "tier_zero", "window_dead", "window_wait", "venue_no_book"]) {
  const lines = src.split("\n").filter((l) => l.includes(`"${hard}"`));
  ck(`hard gate ${hard} is never behind G() (${lines.length} site(s))`, lines.length > 0 && lines.every((l) => !/G\(\)\./.test(l)));
}
ck("the profile is consulted only through G()", count(/gateProfile\(/g) === 1 && /const G = \(\) => gateProfile\(state\.highCapture === true, V2_MAX_ENTRY_CENTS\)/.test(src));
// ask fallback (2026-09-07): only when there is no midpoint, only for high-capture, never a cached price
ck("no-midpoint entries fall back to the best ASK under high-capture only (one live top-of-book read)", count(/if \(!G\(\)\.priceBand && typeof pm\.getBookTopCents === "function"\) \{\r?\n\s+const top = await pm\.getBookTopCents\(tokenId\);/g) === 1);
ck("the fallback never uses a cached price: getPriceCents is called fresh", /pm\.getPriceCents\(tokenId, \{ fresh: true \}\)/.test(src));
const pmSrc = fs.readFileSync(new URL("../src/polymarket.mjs", import.meta.url), "utf8");
ck("polymarket.getBestAskCents exists and returns the LOWEST resting ask with size", /async getBestAskCents\(tokenId\)/.test(pmSrc) && /price < best/.test(pmSrc.slice(pmSrc.indexOf("async getBestAskCents")).slice(0, 900)));
// decision-time book context (2026-09-07): recorded BEFORE any order is built, high-capture only, observation only
ck("priceFor stamps px {bid, ask, mid, src, book_ts} on the trace for high-capture entries", /tr\.note\("px", \{ bid: top\.bid, ask: top\.ask, mid: mid > 0 \? mid : null, src, book_ts: top\.book_ts, read_ms: top\.read_ms \}\)/.test(src));
ck("the book context is guarded by !G().priceBand (never read for the default profile)", /if \(!G\(\)\.priceBand && typeof pm\.getBookTopCents === "function"\) \{/.test(src));
ck("price source is best_ask ONLY when the midpoint is unavailable", /if \(!\(mid > 0\) && top\.ask > 0\) \{ mid = top\.ask; src = "best_ask"; \}/.test(src));
ck("the book is read LIVE (getBookTopCents calls getOrderBook, no cache)", /async getBookTopCents\(tokenId\) \{\r?\n\s+const t0 = Date\.now\(\);\r?\n\s+try \{\r?\n\s+const book = await client\.getOrderBook\(tokenId\);/.test(pmSrc));
ck("a missing ask never fabricates a price (no ask, no midpoint -> null)", /if \(mid == null \|\| !\(mid > 0\)\) return null;/.test(src) && /bid: bid > 0 \? Math\.round\(bid \* 100\) : null, ask: ask > 0 \? Math\.round\(ask \* 100\) : null/.test(pmSrc));
ck("every priceFor call site passes the trace", count(/priceFor\(sig\.token_id, [^\n]*, tr\)/g) === 4);
ck("the no_book memo is lifted by a fresh usable ask, else blocks venue_no_book", /if \(top && top\.ask > 0\) \{ noBookUntil\.delete\(tok\);/.test(src) && /tr\?\.block\("venue_no_book", \{ bid: top\?\.bid \?\? null, ask: top\?\.ask \?\? null \}\)/.test(src));
const bot = fs.readFileSync(new URL("../src/bot.mjs", import.meta.url), "utf8");
ck("bot maps settings.high_capture === true only (never truthy strings)", /qtState\.highCapture = settings\.high_capture === true;/.test(bot));
console.log("\n" + (fail === 0 ? "ALL PASS" : "FAILURES") + ": " + pass + " passed, " + fail + " failed");
assert.equal(fail, 0);
