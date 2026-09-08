// DISTINCT-ADD CONTRACT (owner 2026-09-07). Three halves:
//   1. the pure helpers (src/distinct-add.mjs): identity, poll watermark, one-add sizing under the ceiling + $2 floor;
//   2. the tracer (src/opp-trace.mjs): one record per source id, closed by its first block or its attempt, exported as `se`;
//   3. the SOURCE (src/copytrade.mjs): the new semantics live ONLY behind DISTINCT_ADD() in the two ADD branches and
//      the two open clips; the legacy top-up arithmetic is still present byte-for-byte for everyone else; every hard
//      gate is still consulted inside the new branches; no SELL/exit site references the switch.
import assert from "node:assert";
import fs from "node:fs";
import { sourceId, isNewPollAdd, addSize, rememberSource, seenSource, POLL_SHARES_TOL } from "../src/distinct-add.mjs";
import { createTracer, STAGE } from "../src/opp-trace.mjs";
let pass = 0, fail = 0;
const ck = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };

// ---- 1. helpers ---------------------------------------------------------------------------------------
const W = "0xABCDEF0000000000000000000000000000000001", T = "123456789";
ck("fast id = whale + token + the on-chain fill identity, lower-cased whale", sourceId({ path: "fast", whale: W, token: T, fillId: "0xtx#12#0" }) === "f:" + W.toLowerCase() + ":" + T + ":0xtx#12#0");
ck("same fill re-delivered -> the same id (dedup key)", sourceId({ path: "fast", whale: W, token: T, fillId: "0xtx#12#0" }) === sourceId({ path: "fast", whale: W, token: T, fillId: "0xtx#12#0" }));
ck("a different fill of the same whale on the same token -> a different id", sourceId({ path: "fast", whale: W, token: T, fillId: "0xtx#12#1" }) !== sourceId({ path: "fast", whale: W, token: T, fillId: "0xtx#12#0" }));
ck("poll id = whale + token + cumulative shares (2dp); unchanged row -> same id", sourceId({ path: "poll", whale: W, token: T, hisShares: 1234.567 }) === "p:" + W.toLowerCase() + ":" + T + ":1234.57" && sourceId({ path: "poll", whale: W, token: T, hisShares: 1234.567 }) === sourceId({ path: "poll", whale: W, token: T, hisShares: 1234.5671 }));
ck("fast path without a fill id falls back to the poll identity, never null-ids a real fill", sourceId({ path: "fast", whale: W, token: T, hisShares: 10 }) === "p:" + W.toLowerCase() + ":" + T + ":10.00");
ck("no whale / no token / no shares -> null (nothing to key on)", sourceId({ path: "poll", whale: "", token: T, hisShares: 10 }) === null && sourceId({ path: "poll", whale: W, token: "", hisShares: 10 }) === null && sourceId({ path: "poll", whale: W, token: T, hisShares: 0 }) === null);
ck("poll watermark: a rise beyond the sweep tolerance is a new ADD; within it is the same row", isNewPollAdd(100 + POLL_SHARES_TOL + 0.01, 100) === true && isNewPollAdd(100 + POLL_SHARES_TOL, 100) === false && isNewPollAdd(100, 100) === false && isNewPollAdd(90, 100) === false);
ck("poll watermark: unknown watermark is never a new ADD (pre-existing positions get no retroactive add)", isNewPollAdd(500, undefined) === false && isNewPollAdd(500, null) === false && isNewPollAdd(NaN, 100) === false);
ck("one add = tier size, clipped to the room under the ceiling", addSize({ tierUsd: 6, held: 2, posCeil: 5, floorUsd: 2 }).add === 3);
ck("room under the ceiling below the $2 floor -> position_ceiling, no order", addSize({ tierUsd: 6, held: 4, posCeil: 5, floorUsd: 2 }).why === "position_ceiling" && addSize({ tierUsd: 6, held: 4, posCeil: 5, floorUsd: 2 }).add === 0);
ck("tier size below the floor is lifted to the $2 floor when there is room", addSize({ tierUsd: 1.2, held: 0, posCeil: 5, floorUsd: 2 }).add === 2);
ck("held at or over the ceiling -> position_ceiling", addSize({ tierUsd: 6, held: 5, posCeil: 5, floorUsd: 2 }).why === "position_ceiling" && addSize({ tierUsd: 6, held: 9, posCeil: 5, floorUsd: 2 }).why === "position_ceiling");
{ const p = {}; rememberSource(p, "a", 10); rememberSource(p, "b", 8); ck("rememberSource keeps ids and only raises the watermark", seenSource(p, "a") && seenSource(p, "b") && !seenSource(p, "c") && p.src_hi === 10); rememberSource(p, null, 12); ck("watermark can be seeded without an id", p.src_hi === 12 && Object.keys(p.src).length === 2); for (let i = 0; i < 60; i++) rememberSource(p, "x" + i, 0); ck("ids are bounded (50) - the oldest fall off", Object.keys(p.src).length === 50 && !seenSource(p, "a")); }
ck("seenSource is false on a position without a src map", seenSource({}, "a") === false && seenSource(null, "a") === false);

// ---- 2. tracer -----------------------------------------------------------------------------------------
{ let t = 1_000_000; const tr = createTracer({ userId: "u", now: () => (t += 1000), enabled: true, sampleN: 1 });
  const r = tr.open({ tokenId: T, gen: 0, path: "poll", conditionId: "0xc", outcome: "Yes", category: "SPORTS", whale: W, question: "q" }); r.stage(STAGE.WINDOW_OPEN);
  r.source("s1", "add"); r.block("position_ceiling");
  r.source("s1", "add");                       // the same id again: must NOT reopen
  r.source("s2", "add"); r.attempt({ kind: "add", usd: 3 });
  r.source("s3", "add"); r.block("cash_insufficient");
  const rows = tr.drain ? tr.drain() : tr.flush();
  const row = rows.find((x) => x.t === T); const se = row?.se || [];
  ck("one record per distinct source id; a repeated id does not reopen", se.length === 3 && se.map((s) => s.id).join(",") === "s1,s2,s3");
  ck("a source event closes on its first blocker with that blocker", se[0].by === "position_ceiling" && se[0].bl.join() === "position_ceiling" && se[0].end > 0 && se[0].an == null);
  ck("a source event closes on its attempt and carries the attempt number", se[1].by === "attempt" && se[1].an === 1 && se[1].aa > 0);
  ck("a later hard block on a NEW source does not touch the closed ones", se[2].by === "cash_insufficient" && se[0].by === "position_ceiling" && se[1].by === "attempt");
  ck("the attempt record is stamped with the source id it belongs to", (row.at || [])[0]?.src === "s2"); }

// ---- 3. source contract -------------------------------------------------------------------------------
const src = fs.readFileSync(new URL("../src/copytrade.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const count = (re) => (src.match(re) || []).length;
ck("the switch is consulted at exactly 4 sites: fast ADD, poll ADD, fast open clip, poll open clip", count(/DISTINCT_ADD\(\)/g) === 4);
ck("the legacy top-up arithmetic is still present at both sites (flag off = byte-for-byte old behaviour)", count(/let add = Math\.min\(target, posCeil\) - held;/g) === 1 && count(/const add = Math\.min\(target, posCeil\) - \(Number\(mine\.size_usd\) \|\| 0\);/g) === 1);
ck("legacy add_below_min still guards both legacy sites", count(/if \(add < MIN_ADD_USD\) \{ tr\.block\("add_below_min"\)/g) === 2);
ck("new branches: one source record per evaluation, opened AFTER the dedup check (no record for a re-observed fill)", count(/tr\.source\(srcId, "add"\)/g) === 2 && count(/seenSource\(mine, srcId\)\) return;/g) === 1 && count(/seenSource\(mine, srcId\)\) continue;/g) === 1);
ck("new branches keep no_rebuy (HARD_DUPLICATE after an exit) at both sites", count(/if \(V2\(\) && \(Number\(sig\.sell_seq\) \|\| 0\) > 0\) \{ tr\.block\("no_rebuy"\)/g) === 4);
ck("new branches size ONE add under the ceiling with the $2 floor (position_ceiling is a HARD_RISK blocker)", count(/addSize\(\{ tierUsd: target, held, posCeil, floorUsd: V2_FLOOR_USD \}\)/g) === 2 && count(/tr\.block\("position_ceiling"/g) === 2);
ck("new branches keep the exposure cap, the reserve and the cash clamp at both sites", count(/copyExposure\(positions\) \+ add > exposureCap/g) === 4 && count(/v2ReserveBlocked\(sig, add\)/g) === 4 && count(/buy\(sig, Math\.min\(add, state\.cash \?\? 0\), px, "add"/g) === 4);
ck("poll branch: unknown watermark is seeded and skipped (no retroactive add); unchanged count is skipped silently", count(/if \(mine\.src_hi == null\) \{ rememberSource\(mine, null, sig\.his_shares\); store\.save\(positions\); continue; \}/g) === 1 && count(/if \(!isNewPollAdd\(sig\.his_shares, mine\.src_hi\)\) continue;/g) === 1);
ck("fast branch: the fill's shares raise the watermark so the next sweep does not re-count the same fill", count(/rememberSource\(mine, srcId, \(Number\(mine\.src_hi\) \|\| 0\) \+ \(Number\(meta\?\.shares\) \|\| 0\)\)/g) === 1);
ck("open clips record their source and seed the watermark only when the flag is on", count(/const openSrc = DISTINCT_ADD\(\) \? sourceId\(/g) === 2 && count(/if \(openSrc && ok && positions\[key\]\) \{ rememberSource\(positions\[key\], openSrc, sig\.his_shares\)/g) === 2);
ck("the strategy gates inside the new branches still go through the high-capture profile", count(/G\(\)\.priceBand \? addCapFor\(sig\) : G\(\)\.entryCap, G\(\)\.priceBand \? MIN_ADD_CENTS : G\(\)\.entryFloor/g) === 4 && count(/G\(\)\.driverMatch && boundTo/g) === 2);
// SELL / exit semantics: no exit site mentions the switch, and the sell helpers are untouched by name
const sellSites = src.split("\n").filter((l) => /\bsell\(|mirrorSell|copyExit|exitStep|sell_seq/.test(l) && /DISTINCT_ADD|sourceId|rememberSource/.test(l));
ck("no SELL/exit line references the distinct-add switch or helpers", sellSites.length === 0);
ck("bot.mjs: the switch is hosted-only and server-delivered", /qtState\.distinctAdd = HOSTED && settings\.distinct_add === true;/.test(fs.readFileSync(new URL("../src/bot.mjs", import.meta.url), "utf8")));
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
