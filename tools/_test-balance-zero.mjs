// BALANCE-ZERO CONTRACT, v2 (2026-08-21 afternoon - replaces the morning version, which pinned a
// REGRESSION as correct). For proxy/1271 wallets the CLOB ledger is the only source that can see
// tradeable cash: the funder legitimately reads $0 on-chain forever. So "on-chain answered zero
// while the CLOB read failed" proves NOTHING - believing it zeroed funded accounts on any CLOB
// blip. A zero is believable only when the source that could hold the cash actually answered.
// Mirrors the tail of getBalanceUsd in src/polymarket.mjs.
function resolve({ onchain, clob, lastGood, clobProvisioned = true }) {
  const best = Math.max(onchain ?? 0, clob ?? 0);
  if (best >= 0.01) return { value: best, lastGood: best };
  const zeroIsReal = clob != null || (!clobProvisioned && onchain != null);
  if (zeroIsReal) return { value: 0, lastGood: 0 };
  return { value: lastGood ?? 0, lastGood };
}
let pass = 0, fail = 0;
const ck = (n, got, want) => { const ok = got === want; console.log(`${ok?"PASS":"FAIL"}  ${n}${ok?"":`  (got ${got}, want ${want})`}`); ok?pass++:fail++; };

// money is money
ck("pUSD on the funder -> use it", resolve({ onchain: 109.6, clob: 0, lastGood: null }).value, 109.6);
ck("cash in the CLOB ledger -> use it", resolve({ onchain: 0, clob: 88, lastGood: null }).value, 88);
ck("both -> the larger", resolve({ onchain: 40, clob: 90, lastGood: null }).value, 90);

// THE REGRESSION THE MORNING VERSION PINNED AS CORRECT:
ck("CLOB blip on a funded proxy wallet -> KEEP the last-known-good, never zero",
   resolve({ onchain: 0, clob: null, lastGood: 109 }).value, 109);
ck("...and last-known-good survives for the next cycle",
   resolve({ onchain: 0, clob: null, lastGood: 109 }).lastGood, 109);

// zeros that ARE believable
ck("CLOB answers 0 and chain answers 0 -> genuinely empty, believe it",
   resolve({ onchain: 0, clob: 0, lastGood: 109 }).value, 0);
ck("a real empty answer CLEARS last-known-good",
   resolve({ onchain: 0, clob: 0, lastGood: 109 }).lastGood, 0);
ck("CLOB answers 0, chain read failed -> the cash source answered: believe 0",
   resolve({ onchain: null, clob: 0, lastGood: 50 }).value, 0);
ck("no CLOB creds ever provisioned -> on-chain is the only source, believe its 0",
   resolve({ onchain: 0, clob: null, lastGood: 80, clobProvisioned: false }).value, 0);

// nothing answered
ck("total blackout -> keep last-known-good", resolve({ onchain: null, clob: null, lastGood: 109 }).value, 109);
ck("total blackout, nothing known -> 0", resolve({ onchain: null, clob: null, lastGood: null }).value, 0);

// dust
ck("sub-cent dust with an answered CLOB is not money", resolve({ onchain: 0.004, clob: 0, lastGood: 50 }).value, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
