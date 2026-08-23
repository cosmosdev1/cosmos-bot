// DEDICATED TP LOOP CONTRACT (owner 2026-08-23): sell every copy position at >=98c, check every
// 60s, and stay cheap. "Cheap" is part of the contract, not a nicety - this runs forever on a
// CPU-starved box, so the loop must price only sellable positions and never stampede.
// Mirrors the block in src/bot.mjs.
const TP_AT = 98;
function tick({ positions, prices, copytradeOn = true, busy = false }) {
  const priced = [];      // which tokens we actually asked the CLOB about
  const sold = [];
  if (busy || copytradeOn === false) return { priced, sold, skipped: "busy-or-off" };
  const mine = Object.values(positions).filter((p) =>
    p && p.source === "copytrade" && Number(p.size_shares) > 0 && (Number(p.entry_cents) || 0) + 1 <= 99);
  for (const pos of mine) {
    priced.push(pos.token_id);
    const cur = prices[pos.token_id];
    if (cur == null || cur < TP_AT) continue;
    sold.push(pos.token_id);
    break;                 // one per tick
  }
  return { priced, sold };
}
let pass = 0, fail = 0;
const ck = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok?"PASS":"FAIL"}  ${n}${ok?"":`  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`); ok?pass++:fail++; };

const P = {
  a: { token_id: "a", source: "copytrade", size_shares: 10, entry_cents: 40, outcome: "Yes" },
  b: { token_id: "b", source: "copytrade", size_shares: 10, entry_cents: 60, outcome: "No" },
  c: { token_id: "c", source: "quant",     size_shares: 10, entry_cents: 40, outcome: "Yes" },  // not ours
  d: { token_id: "d", source: "copytrade", size_shares: 0,  entry_cents: 40, outcome: "Yes" },  // no shares
  e: { token_id: "e", source: "copytrade", size_shares: 10, entry_cents: 99, outcome: "Yes" },  // entry+1 > 99
};

ck("sells a position at 98c", tick({ positions: { a: P.a }, prices: { a: 98 } }).sold, ["a"]);
ck("sells at 99c too", tick({ positions: { a: P.a }, prices: { a: 99 } }).sold, ["a"]);
ck("holds at 97c", tick({ positions: { a: P.a }, prices: { a: 97 } }).sold, []);
ck("holds when the price is unreadable", tick({ positions: { a: P.a }, prices: {} }).sold, []);
// cheapness: never price what cannot be sold
ck("never prices a non-copytrade position", tick({ positions: { c: P.c }, prices: { c: 99 } }).priced, []);
ck("never prices a zero-share position", tick({ positions: { d: P.d }, prices: { d: 99 } }).priced, []);
ck("never prices a 99c entry (unreachable exit)", tick({ positions: { e: P.e }, prices: { e: 99 } }).priced, []);
// one per tick, so a burst cannot stampede the gate
ck("two ripe positions -> only one sells this tick", tick({ positions: { a: P.a, b: P.b }, prices: { a: 99, b: 99 } }).sold, ["a"]);
// safety
ck("does nothing while the previous tick is still running", tick({ positions: { a: P.a }, prices: { a: 99 }, busy: true }).sold, []);
ck("does nothing when copytrade is switched off server-side", tick({ positions: { a: P.a }, prices: { a: 99 }, copytradeOn: false }).sold, []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
