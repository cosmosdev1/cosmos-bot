// The dust guard must skip ONLY orders the exchange cannot accept, and never a sellable position.
// Mirrors the exact expression in bot.mjs marketableSell.
const guard = (shares, markC) => shares > 0 && markC > 0 && (shares * markC) / 100 < 1;

const cases = [
  // [shares, cents, shouldSkip, why]
  [50, 1, true,  "50 shares at 1c = $0.50 - unfillable"],
  [10, 2, true,  "10 shares at 2c = $0.20 - the 90-retry case"],
  [100, 1, false, "100 shares at 1c = $1.00 - exactly the minimum, allowed"],
  [200, 1, false, "200 shares at 1c = $2.00 - a real salvage, must NOT be skipped"],
  [20, 99, false, "20 shares at 99c = $19.80 - a take-profit, must NOT be skipped"],
  [1, 99, true,  "1 share at 99c = $0.99 - genuinely under the minimum"],
  [0, 50, false, "no shares recorded - do not guess, let the normal path handle it"],
  [50, 0, false, "no readable price - do not guess, let the normal path handle it"],
  [5000, 3, false, "5000 shares at 3c = $150 salvage - must NOT be skipped"],
];
let pass = 0, fail = 0;
for (const [sh, c, want, why] of cases) {
  const got = guard(sh, c);
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  skip=${String(got).padEnd(5)} ${why}`);
  ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
