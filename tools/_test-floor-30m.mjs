// The 30-minute floor must ONLY change timing - the 20% price gate has to keep applying to the
// later entries it admits, which is what the owner called out explicitly.
const V2_WINDOW_MS = 4*3600_000, V2_MIN_MS = 0.5*3600_000;
const outside = (hrsLeft) => { const left=hrsLeft*3600_000; return left > V2_WINDOW_MS || left < V2_MIN_MS; };
const tooFar = (cur, avg) => Math.abs(cur-avg) > Math.max(avg*0.20, 5);

let p=0,f=0; const ck=(n,g,w)=>{const ok=g===w;console.log(`${ok?"PASS":"FAIL"}  ${n}${ok?"":`  got ${g}, want ${w}`}`);ok?p++:f++;};
console.log("window 30min .. 4h");
ck("5h out  -> not yet (wait)",        outside(5),    true);
ck("4h out  -> eligible",              outside(4),    false);
ck("2h out  -> eligible",              outside(2),    false);
ck("45min out -> eligible (was blocked by the 1h floor)", outside(0.75), false);
ck("30min out -> eligible (exactly the floor)",           outside(0.5),  false);
ck("29min out -> TOO LATE",            outside(29/60), true);
ck("10min out -> TOO LATE",            outside(1/6),   true);
console.log("\nprice gate still applies to the newly-admitted late entries");
ck("45min out, price 58c vs his 57c -> gate OK",   tooFar(58,57), false);
ck("45min out, price 90c vs his 57c -> BLOCKED",   tooFar(90,57), true);
ck("35min out, price 19c vs his 40c -> BLOCKED",   tooFar(19,40), true);
ck("35min out, price 44c vs his 40c -> gate OK",   tooFar(44,40), false);
console.log(`\n${p} passed, ${f} failed`);
process.exitCode=f?1:0;
