// The 97c entry ceiling and the 5c slip floor. Both are money rules, so pin them.
let pass=0, fail=0;
const ck=(n,got,want)=>{const ok=got===want;console.log(`${ok?"PASS":"FAIL"}  ${n}${ok?"":`  (got ${got}, want ${want})`}`);ok?pass++:fail++;};

// --- entry ceiling: mirrors the capMax expression in src/copytrade.mjs ---
const MAX_ENTRY_CENTS = 92, V2_MAX = 97;
const capFor = (v2, category) => Math.min(v2 ? V2_MAX : 99, String(category).toUpperCase() === "SPORTS" ? 99 : MAX_ENTRY_CENTS);
ck("v2 sports capped at 97c (not 99)", capFor(true, "SPORTS"), 97);
ck("v2 non-sports still capped at 92c", capFor(true, "ALL"), 92);
ck("v1 sports unchanged at 99c", capFor(false, "SPORTS"), 99);
ck("v1 non-sports unchanged at 92c", capFor(false, "ALL"), 92);
ck("a 98c market is refused under v2", 98 <= capFor(true, "SPORTS"), false);
ck("a 97c market is still allowed", 97 <= capFor(true, "SPORTS"), true);

// --- slip floor: mirrors the ceiling expression in lib/cloud/risk.ts ---
const SLIP_PCT = 15, FLOOR = 5;
const ceiling = (ask) => ask + Math.max(ask * (SLIP_PCT / 100), FLOOR);
ck("cheap book: 15c ask allows 20c", ceiling(15), 20);
ck("cheap book: 18c into a 15c ask now passes", 18 <= ceiling(15), true);
ck("mid book: 30c ask allows 35c", ceiling(30), 35);
ck("floor stops mattering once 15% exceeds 5c", ceiling(80), 92);
ck("high book unchanged by the floor", ceiling(80) === 80 + 80 * 0.15, true);
ck("the guard still bites: 30c into a 15c ask is refused", 30 <= ceiling(15), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
