// A failed balance read and a genuinely empty wallet must NOT behave the same. Getting this wrong
// made bots size, sign and burn Turnkey signatures against money that was not there.
// Mirrors the tail of getBalanceUsd in src/polymarket.mjs.
function resolve({ onchain, clob, lastGood }) {
  const best = Math.max(onchain ?? 0, clob ?? 0);
  if (best >= 0.01) return { value: best, lastGood: best };
  const answered = onchain != null || clob != null;
  if (answered) return { value: 0, lastGood: 0 };
  return { value: lastGood ?? 0, lastGood };
}
let pass = 0, fail = 0;
const ck = (n, got, want) => { const ok = got === want; console.log(`${ok?"PASS":"FAIL"}  ${n}${ok?"":`  (got ${got}, want ${want})`}`); ok?pass++:fail++; };

ck("money on chain -> use it", resolve({ onchain: 109, clob: 0, lastGood: null }).value, 109);
ck("money in the CLOB -> use it", resolve({ onchain: 0, clob: 88, lastGood: null }).value, 88);
ck("both hold money -> use the larger", resolve({ onchain: 40, clob: 90, lastGood: null }).value, 90);

// THE BUG: wallet genuinely empty, but we once saw money
ck("genuinely empty (both answered 0) -> 0, NOT the stale balance", resolve({ onchain: 0, clob: 0, lastGood: 109 }).value, 0);
ck("one source answered 0, other failed -> 0", resolve({ onchain: 0, clob: null, lastGood: 109 }).value, 0);
ck("empty read also CLEARS last-known-good", resolve({ onchain: 0, clob: 0, lastGood: 109 }).lastGood, 0);

// blip protection must survive
ck("both sources failed -> keep last-known-good", resolve({ onchain: null, clob: null, lastGood: 109 }).value, 109);
ck("both failed and nothing known -> 0", resolve({ onchain: null, clob: null, lastGood: null }).value, 0);

// dust must not read as funded
ck("sub-cent dust is not money", resolve({ onchain: 0.004, clob: 0, lastGood: 50 }).value, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
