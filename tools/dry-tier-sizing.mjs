// DRY RUN — copy sizing (one-shot linear + the 20-tier ladder). No network, no keys, no orders.
//   node tools/dry-tier-sizing.mjs
import {
  MIN_ORDER_USD, ONESHOT_CAP_PCT, LADDER_CAP_PCT, LADDER_TIERS, LADDER_STEP_PCT,
  pctFromAutoTiers, twentyTierTarget, firstTier,
} from "../src/tier-sizing.mjs";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = Math.abs(Number(got) - Number(want)) < 1e-9;
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}   got ${got}  want ${want}`);
};
const ok = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? "  ok  " : "FAIL  "}${name}`); };

console.log("--- constants ---");
eq("20 tiers", LADDER_TIERS, 20);
eq("5% cap", LADDER_CAP_PCT, 5);
eq("0.25% step", LADDER_STEP_PCT, 0.25);
eq("one-shot cap 6%", ONESHOT_CAP_PCT, 6);

console.log("\n--- one-shot linear (UNCHANGED, owner: one-shot stays) ---");
const A = { anchor_usd: 2000 };
eq("half anchor -> 3%", pctFromAutoTiers(A, 1000), 3);
eq("at anchor -> 6%", pctFromAutoTiers(A, 2000), 6);
eq("above stays capped", pctFromAutoTiers(A, 9e9), 6);
eq("$50k->5% implies $25k->2.5%", pctFromAutoTiers({ anchor_usd: 60000 }, 25000), 2.5);
ok("absent -> null", pctFromAutoTiers(null, 500) === null);
ok("legacy band array still resolves", pctFromAutoTiers([{ min_usd: 100, pct: 2 }], 150) === 2);
ok("one-shot IGNORES top10 field", pctFromAutoTiers({ anchor_usd: 2000, top10_avg_usd: 500 }, 1000) === 3);

console.log("\n--- 20-tier ladder: THE OWNER'S EXAMPLE ---");
// whale top-10% avg $20,000, user $100: cap $5 (5%), ratio 1:4000
const ex = twentyTierTarget({ hisUsd: 20000, top10AvgUsd: 20000, portfolio: 100 });
eq("at his top-10% avg -> the 5% cap", ex.pct, 5);
eq("cap in dollars on $100", ex.target, 5);
eq("ratio = his $ per our $1", ex.ratio, 4000);
// $1 floor: $100 portfolio -> first tier is 1% (owner: "1% if $100"), $300 -> 0.5%, $400 -> 0.25%
eq("$100 first tier = 1%", firstTier(100) * LADDER_STEP_PCT, 1);
eq("$300 first tier = 0.5%", firstTier(300) * LADDER_STEP_PCT, 0.5);
eq("$400 first tier = 0.25%", firstTier(400) * LADDER_STEP_PCT, 0.25);

console.log("\n--- one ratio across ALL tiers ---");
// tier k must correspond to k/20 of his top-10% avg — the same constant everywhere
const T10 = 20000, PF = 1000;
let sameRatio = true;
for (let k = 1; k <= 20; k++) {
  const hisAtTier = (T10 * k) / 20;                       // exactly tier k on his side
  const r = twentyTierTarget({ hisUsd: hisAtTier, top10AvgUsd: T10, portfolio: PF });
  if (r.tier !== k || Math.abs(r.target - (PF * k * 0.25) / 100) > 1e-9) { sameRatio = false; break; }
}
ok("all 20 tiers sit on the identical ratio", sameRatio);
// half his bet -> half our size (whole-ladder sweep, quantization <= half a step)
let devOk = true;
for (let u = 100; u <= 20000; u += 137) {
  const r = twentyTierTarget({ hisUsd: u, top10AvgUsd: T10, portfolio: PF });
  if (!r.target) continue;
  const exact = (PF * Math.min(5, (5 * u) / T10)) / 100;
  if (Math.abs(r.target - exact) > (PF * (LADDER_STEP_PCT / 2)) / 100 + 1e-9) { devOk = false; break; }
}
ok("deviation from the exact ratio never exceeds half a tier (0.125pp)", devOk);

console.log("\n--- caps, floors, guards ---");
eq("monster bet capped at 5%", twentyTierTarget({ hisUsd: 9e9, top10AvgUsd: T10, portfolio: PF }).pct, 5);
eq("$100 pf: his tiny bet -> $0 (sub-$1)", twentyTierTarget({ hisUsd: 500, top10AvgUsd: 20000, portfolio: 100 }).target, 0);
eq("$100 pf: 1% tier is placeable", twentyTierTarget({ hisUsd: 4000, top10AvgUsd: 20000, portfolio: 100 }).target, 1);
ok("order is always 0 or >= $1", [10, 50, 150, 300, 1000, 5000].every((pf) =>
  [1, 10, 100, 1000, 10000, 100000].every((u) => {
    const t = twentyTierTarget({ hisUsd: u, top10AvgUsd: T10, portfolio: pf }).target;
    return t === 0 || t >= MIN_ORDER_USD;
  })));
eq("no portfolio -> 0", twentyTierTarget({ hisUsd: 500, top10AvgUsd: T10, portfolio: 0 }).target, 0);
eq("no anchor -> 0", twentyTierTarget({ hisUsd: 500, top10AvgUsd: 0, portfolio: PF }).target, 0);
eq("no cost -> 0", twentyTierTarget({ hisUsd: 0, top10AvgUsd: T10, portfolio: PF }).target, 0);
// monotonic: more of his money never sizes us smaller
let prev = -1, mono = true;
for (let u = 10; u <= 40000; u += 61) {
  const t = twentyTierTarget({ hisUsd: u, top10AvgUsd: T10, portfolio: PF }).target;
  if (t < prev - 1e-9) { mono = false; break; }
  prev = t;
}
ok("target is non-decreasing in his bet", mono);
// idempotent total (never a delta)
const a1 = twentyTierTarget({ hisUsd: 5000, top10AvgUsd: T10, portfolio: PF }).target;
const a2 = twentyTierTarget({ hisUsd: 5000, top10AvgUsd: T10, portfolio: PF }).target;
eq("idempotent (total, not a top-up)", a1, a2);

console.log("\n--- daily ratio: the portfolio moves, the ratio moves with it ---");
const d1 = twentyTierTarget({ hisUsd: 10000, top10AvgUsd: T10, portfolio: 1000 });
const d2 = twentyTierTarget({ hisUsd: 10000, top10AvgUsd: T10, portfolio: 1200 });
eq("same tier either day", d1.tier, d2.tier);
eq("but 20% more portfolio = 20% bigger order", d2.target / d1.target, 1.2);

console.log(`\n${fail ? "FAILED" : "ALL PASS"}  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
