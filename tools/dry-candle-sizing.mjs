// DRY TEST for the candle sizing engines. No market, no signature, no wallet.
//
// The expensive mistake this exists to catch is the tiers being treated as ADDITIVE: a whale
// climbing 30% -> 60% -> 90% must cost us 4.5% of portfolio in total, not 9%. Every ladder case
// below asserts the running total, not just the individual order.
//
// Run: node tools/dry-candle-sizing.mjs
import { avgCandleSize, topUpUsd, targetPctForHolding, crossedNewTier, TIERS, ONESHOT_PCT } from "../src/candle-sizing.mjs";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? " :: " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " :: " + detail : ""}`); }
};
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

console.log("\n=== baseline: average $ per DISTINCT candle market ===");
{
  // Two markets: one he scaled into over three buys ($60 total), one single $40 buy. Mean = $50.
  const trades = [
    { side: "BUY", conditionId: "A", usdcSize: 20 },
    { side: "BUY", conditionId: "A", usdcSize: 20 },
    { side: "BUY", conditionId: "A", usdcSize: 20 },
    { side: "BUY", conditionId: "B", usdcSize: 40 },
    { side: "SELL", conditionId: "B", usdcSize: 500 },  // sells must not count
  ];
  check("scaling into one market counts once, at its total", close(avgCandleSize(trades), 50), `$${avgCandleSize(trades)}`);
}
{
  const many = Array.from({ length: 400 }, (_, i) => ({ side: "BUY", conditionId: "m" + i, usdcSize: i < 300 ? 100 : 9999 }));
  check("only the most recent 300 are used", close(avgCandleSize(many), 100), `$${avgCandleSize(many)}`);
}
check("no trades -> no baseline (never divide by zero)", avgCandleSize([]) === 0);

console.log("\n=== original engine: tier targets ===");
{
  const base = 100;
  const cases = [[10, 0], [29, 0], [30, 1.5], [45, 1.5], [60, 3], [89, 3], [90, 4.5], [500, 4.5]];
  for (const [his, want] of cases) {
    check(`he holds $${his} of a $${base} baseline -> ${want}%`, targetPctForHolding(his, base) === want, `${targetPctForHolding(his, base)}%`);
  }
}

console.log("\n=== THE LADDER IS CUMULATIVE, NOT ADDITIVE ===");
{
  const portfolio = 1000, base = 100;
  let ourUsd = 0, spent = 0;
  for (const [frac] of TIERS) {
    const his = base * frac;
    const r = topUpUsd({ hisUsd: his, baselineUsd: base, portfolioUsd: portfolio, ourUsd });
    ourUsd += r.buyUsd; spent += r.buyUsd;
    check(`at ${frac * 100}% he triggers a top-up of $${r.buyUsd.toFixed(2)}`, r.buyUsd > 0, r.reason);
  }
  check("total spend is 4.5% of portfolio, NOT 9%", close(spent, 45), `$${spent.toFixed(2)}`);
  check("holding equals the top tier", close(ourUsd, 45), `$${ourUsd.toFixed(2)}`);
}
{
  // Jumping straight past every tier must land on the top target in ONE order.
  const r = topUpUsd({ hisUsd: 95, baselineUsd: 100, portfolioUsd: 1000, ourUsd: 0 });
  check("a straight jump to 95% buys the full 4.5% at once", close(r.buyUsd, 45), `$${r.buyUsd.toFixed(2)}`);
}
{
  const r = topUpUsd({ hisUsd: 60, baselineUsd: 100, portfolioUsd: 1000, ourUsd: 30 });
  check("already at target -> no order", r.buyUsd === 0, r.reason);
}
{
  const r = topUpUsd({ hisUsd: 30, baselineUsd: 100, portfolioUsd: 40, ourUsd: 0 });
  check("gap under the $1 minimum is refused, not attempted", r.buyUsd === 0, r.reason);
}

console.log("\n=== one-shot engine ===");
{
  const base = 100;
  check("below 50% -> nothing", targetPctForHolding(49, base, { oneShot: true }) === 0);
  check("at 50% -> 2%", targetPctForHolding(50, base, { oneShot: true }) === ONESHOT_PCT);
  check("at 300% -> still 2% (never scales)", targetPctForHolding(300, base, { oneShot: true }) === ONESHOT_PCT);
  const first = topUpUsd({ hisUsd: 50, baselineUsd: base, portfolioUsd: 1000, ourUsd: 0, oneShot: true });
  check("first crossing buys 2% of portfolio", close(first.buyUsd, 20), `$${first.buyUsd.toFixed(2)}`);
  const second = topUpUsd({ hisUsd: 200, baselineUsd: base, portfolioUsd: 1000, ourUsd: 20, oneShot: true });
  check("he keeps stacking -> we do NOT (one signature per position)", second.buyUsd === 0, second.reason);
}

console.log("\n=== trigger check (runs constantly, must be cheap and correct) ===");
{
  check("no trigger below the first tier", !crossedNewTier({ hisUsd: 20, baselineUsd: 100 }));
  check("triggers on the first crossing", crossedNewTier({ hisUsd: 30, baselineUsd: 100, ourPctHeld: 0 }));
  check("does NOT retrigger at the same tier", !crossedNewTier({ hisUsd: 45, baselineUsd: 100, ourPctHeld: 1.5 }));
  check("triggers again at the next tier", crossedNewTier({ hisUsd: 60, baselineUsd: 100, ourPctHeld: 1.5 }));
  check("no baseline -> never triggers (a new whale cannot fire blind)", !crossedNewTier({ hisUsd: 999, baselineUsd: 0 }));
}

console.log(`\n${fail === 0 ? "ALL SIZING TESTS PASSED" : `${fail} FAILED`} (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
