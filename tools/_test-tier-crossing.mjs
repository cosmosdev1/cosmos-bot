// TIER-CROSSING CONTRACT (owner ruling 2026-09-08). The nine regression points, plus the source contract:
//   1 hosted ladder 6/5/4 · 2 same-tier ADD = no top-up · 3 upward crossing = exact delta · 4 a full tier-1 6% executes under 6.5%
//   5 the position never exceeds 6.5% locally · 6 the server 7% cap is untouched by the bot · 7 fast + poll same source tx executes once
//   8 SELL behaviour unchanged · 9 no switch can activate the withdrawn distinct-ADD semantics.
import assert from "node:assert";
import fs from "node:fs";
import { NC_PCTS_HOSTED, NC_PCTS_LEGACY, CANDLE_PCTS, POSITION_CEIL_PCT_HOSTED, POSITION_CEIL_PCT_LEGACY, SERVER_CONDITION_CAP_PCT, pctFromBands, topUp } from "../src/tier-ladder.mjs";
import { sourceId, fillIdsOnRow, newestFillIdOnRow, rememberSource, seenSource } from "../src/source-identity.mjs";
let pass = 0, fail = 0;
const ck = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const T = { t1_usd: 1000, t2_usd: 300, t3_usd: 100 };   // a whale's own thresholds (top 30% / 50% / 65%)
// 1. ladder
ck("1 hosted ladder is 6/5/4, legacy stays 5/4/3, candles 3/2", NC_PCTS_HOSTED.join() === "6,5,4" && NC_PCTS_LEGACY.join() === "5,4,3" && CANDLE_PCTS.join() === "3,2");
ck("1 money-in maps to the band: $1500->6, $500->5, $150->4, $50->0, no thresholds->null", pctFromBands(1500, T, NC_PCTS_HOSTED) === 6 && pctFromBands(500, T, NC_PCTS_HOSTED) === 5 && pctFromBands(150, T, NC_PCTS_HOSTED) === 4 && pctFromBands(50, T, NC_PCTS_HOSTED) === 0 && pctFromBands(500, null, NC_PCTS_HOSTED) === null);
// 2. same tier -> no top-up
{ const book = 100; const first = topUp({ pct: pctFromBands(150, T, NC_PCTS_HOSTED), portfolioUsd: book, heldUsd: 0, ceilPct: POSITION_CEIL_PCT_HOSTED, floorUsd: 2 });
  const same = topUp({ pct: pctFromBands(250, T, NC_PCTS_HOSTED), portfolioUsd: book, heldUsd: first.add, ceilPct: POSITION_CEIL_PCT_HOSTED, floorUsd: 2 });
  ck("2 first qualifying entry targets the current tier (4% of $100 = $4)", first.target === 4 && first.add === 4 && first.order);
  ck("2 a whale ADD inside the same tier ($150 -> $250, still 4%) creates NO top-up", same.add === 0 && same.order === false);
// 3. upward crossing -> exact delta
  const up = topUp({ pct: pctFromBands(350, T, NC_PCTS_HOSTED), portfolioUsd: book, heldUsd: 4, ceilPct: POSITION_CEIL_PCT_HOSTED, floorUsd: 2 });
  ck("3 crossing into 5% tops up exactly the delta: $5 target - $4 held = $1, under the $2 minimum -> no order", up.target === 5 && up.add === 1 && up.order === false);
  const up2 = topUp({ pct: pctFromBands(1200, T, NC_PCTS_HOSTED), portfolioUsd: book, heldUsd: 4, ceilPct: POSITION_CEIL_PCT_HOSTED, floorUsd: 2 });
  ck("3 crossing 4% -> 6% tops up $2 (the delta), which meets the $2 minimum", up2.add === 2 && up2.order === true);
  ck("3 a partial earlier fill is completed, not doubled: held $3.5 at tier 6% -> add $2.5", topUp({ pct: 6, portfolioUsd: book, heldUsd: 3.5, ceilPct: 6.5, floorUsd: 2 }).add === 2.5);
// 4. full tier-1 under 6.5
  ck("4 a full tier-1 6% executes under the 6.5% ceiling (target 6, cap 6.5, add 6)", topUp({ pct: 6, portfolioUsd: book, heldUsd: 0, ceilPct: POSITION_CEIL_PCT_HOSTED, floorUsd: 2 }).add === 6 && POSITION_CEIL_PCT_HOSTED === 6.5);
  ck("4 legacy ceiling stays 5%", POSITION_CEIL_PCT_LEGACY === 5);
// 5. never exceeds 6.5
  ck("5 held + add never exceeds 6.5% of the portfolio, whatever the target; a holding already at/over the cap gets add 0", [0, 1, 3, 5, 6, 6.4].every((h) => h + topUp({ pct: 9, portfolioUsd: book, heldUsd: h, ceilPct: 6.5, floorUsd: 2 }).add <= 6.5 + 1e-9) && [6.5, 9].every((h) => topUp({ pct: 9, portfolioUsd: book, heldUsd: h, ceilPct: 6.5, floorUsd: 2 }).add === 0) && topUp({ pct: 9, portfolioUsd: book, heldUsd: 0, ceilPct: 6.5, floorUsd: 2 }).add === 6.5);
// 6. server cap untouched
  ck("6 the server hard cap is documented as 7% and the bot never enforces it (no bot reference to the gate's caps)", SERVER_CONDITION_CAP_PCT === 7 && !/CLOUD_MAX_ORDER_PCT|maxOrderPct|maxMarketPct/.test(fs.readFileSync(new URL("../src/copytrade.mjs", import.meta.url), "utf8")));
}
// 7. one execution per source tx across paths
{ const W = "0xAbC", TOK = "9"; const pos = { size_usd: 4 };
  const fast = sourceId({ path: "fast", whale: W, token: TOK, fillId: "0xTX1#7#0" });
  const poll = newestFillIdOnRow({ token_id: TOK, wallets: [{ wallet: W, fills: [{ tx: "0xtx1" }, { tx: "0xtx0" }] }] });
  ck("7 the fast path's tx id and the poll path's newest stamped fill id are the SAME id", fast === poll && fast === "f:0xabc:9:0xtx1");
  rememberSource(pos, fast);
  ck("7 after the fast path executed it, the poll path sees the source as done", seenSource(pos, poll) === true);
  ck("7 a later distinct whale fill (other tx) is a new source", seenSource(pos, sourceId({ path: "fast", whale: W, token: TOK, fillId: "0xTX2#1#0" })) === false);
  ck("7 several maker fills of one whale order (same tx) are one source", sourceId({ path: "fast", whale: W, token: TOK, fillId: "0xtx1#8#1" }) === fast);
  ck("7 a row without stamped fills has no true identity (null), never a fabricated one", newestFillIdOnRow({ token_id: TOK, wallets: [{ wallet: W }] }) === null && fillIdsOnRow({ token_id: TOK, wallets: [{ wallet: W }] }) === null); }
// tracer: tier before/after ride the record and the export
{ let t = 1_000_000; const tr = (await import("../src/opp-trace.mjs")).createTracer({ userId: "u", now: () => (t += 1000), enabled: true, sampleN: 1 });
  const r = tr.open({ tokenId: "77", gen: 0, path: "poll", conditionId: "0xc", outcome: "Yes", category: "SPORTS", whale: "0xw", question: "q" }); r.stage(40);
  r.source("s1", "add", { tb: 4, ta: 5 }); r.block("add_below_min"); r.source("s2", "add", { tb: 5, ta: 6 }); r.attempt({ kind: "add", usd: 3 });
  const row = tr.drain().find((x) => x.t === "77"); const se = row.se;
  ck("tracer: a crossing record carries tier_before/tier_after and terminates as BELOW_MIN (add_below_min) or as its attempt", se.length === 2 && se[0].tb === 4 && se[0].ta === 5 && se[0].by === "add_below_min" && se[1].tb === 5 && se[1].ta === 6 && se[1].by === "attempt" && se[1].an === 1); }
// source contract
const src = fs.readFileSync(new URL("../src/copytrade.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const bot = fs.readFileSync(new URL("../src/bot.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const count = (re) => (src.match(re) || []).length;
ck("ladder wiring: the switch picks NC_PCTS_HOSTED, everyone else NC_PCTS_LEGACY (flag off = old 5/4/3 sizing)", count(/const LADDER_V2 = \(\) => ONESHOT && state\.tierLadderV2 === true;/g) === 1 && count(/const ncPcts = \(\) => \(LADDER_V2\(\) \? NC_PCTS_HOSTED : NC_PCTS_LEGACY\);/g) === 1 && count(/pctFromBands\(cost, v2t\.nc, ncPcts\(\)\)/g) === 1 && count(/\[5, 4, 3\]/g) === 0);
ck("ceiling wiring: both posCeil sites use positionCeilPct() (switch 6.5, everyone else MAX_POSITION_PCT = 5)", count(/\(\(state\.portfolio \|\| 0\) \* positionCeilPct\(\)\) \/ 100/g) === 2 && count(/const positionCeilPct = \(\) => \(LADDER_V2\(\) \? POSITION_CEIL_PCT_HOSTED : MAX_POSITION_PCT\);/g) === 1 && count(/\* MAX_POSITION_PCT\) \/ 100/g) === 0);
ck("top-up arithmetic is the tier-crossing delta at both sites (target - held), floored at the hosted $2 minimum", count(/let add = Math\.min\(target, posCeil\) - held;/g) === 1 && count(/const add = Math\.min\(target, posCeil\) - \(Number\(mine\.size_usd\) \|\| 0\);/g) === 1 && count(/if \(add < addFloorUsd\(\)\) \{ tr\.block\("add_below_min"\)/g) === 2 && count(/const addFloorUsd = \(\) => \(LADDER_V2\(\) \? V2_FLOOR_USD : MIN_ADD_USD\);/g) === 1);
ck("7 both top-up sites refuse a source already executed (source_done) BEFORE sizing, and remember it only on a fill", count(/if \(srcId && seenSource\(mine, srcId\)\) \{ tr\.block\("source_done"\)/g) === 2 && count(/if \(ok && srcId\) \{ rememberSource\(mine, srcId\); store\.save\(positions\); \}/g) === 2);
ck("ledger: a crossing record is opened at OBSERVATION (before source_done, sizing and every gate) at both top-up sites, with tier before/after; nothing is opened at attempt time", count(/observeCrossing\(tr, mine, sig, srcId, /g) === 2 && count(/const srcId = LADDER_V2\(\) \? /g) === 2 && count(/tr\.source\(srcId \|\| sourceId\(\{ path: "poll", whale, token: sig\.token_id, hisShares: sig\.his_shares \}\), srcId \? "add" : "agg", \{ tb, ta \}\)/g) === 1 && src.indexOf("observeCrossing(tr, mine, sig, srcId, driver") < src.indexOf('tr.block("source_done"); return;') && src.indexOf("observeCrossing(tr, mine, sig, srcId, String(") < src.indexOf('tr.block("source_done"); continue;'));
ck("ledger: only an UPWARD tier move opens a record, once per crossing (copy_tier_seen), and a fall re-arms it; observation never changes sizing", /if \(!\(ta > tb\)\) \{ if \(Number\(mine\?\.copy_tier_seen\) > ta\)/.test(src) && /if \(Number\(mine\?\.copy_tier_seen\) >= ta\) return;/.test(src) && /const observeCrossing = \(tr, mine, sig, srcId, whale, positions\) => \{/.test(src) && /if \(!LADDER_V2\(\)\) return;\r?\n\s+const ta = v2Pct\(sig\), tb = tierForCost\(sig, mine\?\.copy_his_cost\);/.test(src));
// 8. SELL unchanged: no exit-side line references any of this work
const sellLines = src.split("\n").filter((l) => /\bsell\(|mirrorSell|copyExit|exitStep|sell_seq|SELL/.test(l) && /sourceId|rememberSource|seenSource|positionCeilPct|addFloorUsd|tr\.source\(/.test(l));
ck("8 no SELL/exit line references the ladder, the ceiling, the floor or the source identity", sellLines.length === 0);
// 9. the withdrawn semantics cannot be switched on
ck("9 distinct-ADD is gone from the bot: no DISTINCT_ADD, no distinctAdd setting, no distinct-add module", count(/DISTINCT_ADD/g) === 0 && !/distinctAdd|distinct_add/.test(bot) && !fs.existsSync(new URL("../src/distinct-add.mjs", import.meta.url)));
ck("staged: the switch is hosted-only and server-delivered (settings.tier_ladder_v2), default off", /qtState\.tierLadderV2 = HOSTED && settings\.tier_ladder_v2 === true;/.test(bot));
ck("9 the only source-identity consumers are the two legacy top-up sites (no new opportunity path)", count(/tr\.source\(/g) === 1 && count(/observeCrossing\(tr, mine, sig, srcId, /g) === 2 && count(/newestFillIdOnRow\(sig\)/g) === 1 && count(/sourceId\(\{ path: "fast"/g) === 1);
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
