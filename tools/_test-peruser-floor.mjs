// The per-user entry floor must FAIL SAFE: anything missing, junk or non-positive falls back to $55.
// A floor that silently became 0 would admit every account, so this is the assertion that matters.
import assert from "node:assert";
const D = 55;
const mk = (ref) => () => { try { const v = Number(ref?.minPortfolioUsd); return Number.isFinite(v) && v > 0 ? v : D; } catch { return D; } };
let pass = 0, fail = 0;
const ck = (n, c) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}`); } };
ck("no state -> $55", mk(null)() === D);
ck("empty state -> $55", mk({})() === D);
ck("undefined -> $55", mk({ minPortfolioUsd: undefined })() === D);
ck("null -> $55", mk({ minPortfolioUsd: null })() === D);
ck("zero -> $55 (never admits everyone)", mk({ minPortfolioUsd: 0 })() === D);
ck("negative -> $55", mk({ minPortfolioUsd: -10 })() === D);
ck("junk string -> $55", mk({ minPortfolioUsd: "abc" })() === D);
ck("NaN -> $55", mk({ minPortfolioUsd: NaN })() === D);
ck("throwing getter -> $55", mk(new Proxy({}, { get() { throw new Error("boom"); } }))() === D);
ck("valid 50 -> 50", mk({ minPortfolioUsd: 50 })() === 50);
ck("numeric string 50 -> 50", mk({ minPortfolioUsd: "50" })() === 50);
ck("a HIGHER override still applies (75)", mk({ minPortfolioUsd: 75 })() === 75);
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
