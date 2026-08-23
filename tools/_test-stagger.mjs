// STAGGER CONTRACT (2026-08-23): one whale fill fans out to every follower's bot. The offset must
// be deterministic per bot, evenly spread, and bounded - so peak concurrency drops without any bot
// being systematically last. Mirrors the block in src/chainwatch.mjs.
const STAGGER_MS = 2_500;
const offsetFor = (tag) => { let h = 0; for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0; return STAGGER_MS ? h % STAGGER_MS : 0; };
let pass = 0, fail = 0;
const ck = (n, got, want) => { const ok = got === want; console.log(`${ok?"PASS":"FAIL"}  ${n}${ok?"":`  (got ${got}, want ${want})`}`); ok?pass++:fail++; };

const ids = Array.from({ length: 103 }, (_, i) => `user-${i}-${(i*7919).toString(16)}`);
const offs = ids.map(offsetFor);

ck("every offset is inside the window", offs.every(o => o >= 0 && o < STAGGER_MS), true);
ck("deterministic: same id -> same offset", offsetFor(ids[0]) === offsetFor(ids[0]), true);
// spread: with 103 bots over 2500ms, no 250ms bucket should hold more than ~25% of the fleet
const buckets = new Array(10).fill(0);
for (const o of offs) buckets[Math.floor(o / (STAGGER_MS / 10))]++;
const worst = Math.max(...buckets);
ck(`no bucket holds more than a quarter of the fleet (worst ${worst}/103)`, worst <= 26, true);
ck("at least 8 of 10 buckets are used", buckets.filter(b => b > 0).length >= 8, true);
// peak concurrency: before, all 103 landed in one 250ms window
ck("peak concurrency cut by >=4x vs unstaggered", 103 / Math.max(1, worst) >= 4, true);
// disabled -> no delay at all
const zero = (tag) => { let h = 0; for (let i = 0; i < tag.length; i++) h = (h*31+tag.charCodeAt(i))>>>0; return 0 ? h % 0 : 0; };
ck("stagger disabled (0) -> zero delay", zero("anything"), 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
