// The minimum-portfolio floor must bind on EVERY sizing path. It did not bind on v2, which is how a
// fleet of small accounts started hammering the gate with orders it would always refuse.
const MIN = 55, V2_FLOOR = 2;
// mirrors sizeFor() in src/copytrade.mjs
function sizeFor({ v2, oneshot, portfolio, pct }) {
  if (v2) {
    if (oneshot && !(portfolio >= MIN)) return 0;
    if (!Number.isFinite(pct) || pct <= 0) return 0;
    return Math.max(V2_FLOOR, (portfolio || 0) * (pct / 100));
  }
  if (oneshot && !(portfolio >= MIN)) return 0;
  return (portfolio * pct) / 100;
}
let pass = 0, fail = 0;
const ck = (n, got, want) => { const ok = got === want; console.log(`${ok?"PASS":"FAIL"}  ${n}${ok?"":`  (got ${got}, want ${want})`}`); ok?pass++:fail++; };

ck("v2, $20 account -> no trade (was $2 before the fix)", sizeFor({v2:true,oneshot:true,portfolio:20,pct:3}), 0);
ck("v2, $32 median account -> no trade", sizeFor({v2:true,oneshot:true,portfolio:32,pct:3}), 0);
ck("v2, exactly at the floor -> trades", sizeFor({v2:true,oneshot:true,portfolio:55,pct:3}), 2);
ck("v2, $164 account -> full tier size", sizeFor({v2:true,oneshot:true,portfolio:164,pct:3}), 4.92);
ck("v2, tier says no entry -> no trade regardless of size", sizeFor({v2:true,oneshot:true,portfolio:500,pct:0}), 0);
ck("v1 path unchanged: $20 -> no trade", sizeFor({v2:false,oneshot:true,portfolio:20,pct:3}), 0);
ck("self-hosted (oneshot off) is untouched by the floor", sizeFor({v2:true,oneshot:false,portfolio:20,pct:3}), 2);
ck("the $2 floor still lifts a small-but-eligible account", sizeFor({v2:true,oneshot:true,portfolio:60,pct:3}), 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
