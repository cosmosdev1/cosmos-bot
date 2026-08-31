// COMPLETENESS SEMANTICS. Stage 4's acceptance must exclude intervals it cannot trust, so the row
// itself has to say whether it is complete. Simulate the runner's flush bookkeeping across the five
// situations that matter. Synthetic on purpose: manufacturing these in production would mean
// deliberately breaking a trading fleet to test a counter.
import { merge, emptyAggregate } from "../src/metrics.mjs";
let pass=0, fail=0;
const ok=(n,c)=>{ if(c){pass++;console.log(`  ok   ${n}`);} else {fail++;console.log(`  FAIL ${n}`);} };

// mirrors flushMetrics() in runner.mjs
function makeRunner(bootId){
  let agg=emptyAggregate(), reporters=new Set(), seq=0, kids=0, fills=new Set();
  return {
    setKids:n=>{kids=n;},
    fill:id=>fills.add(id),
    fromChild:(userId,delta)=>{ merge(agg,delta); reporters.add(userId); },
    flush(){ const m=agg; agg=emptyAggregate();
      m.kids=kids; m.fills=fills.size; m.reporters=reporters.size; m.seq=++seq; m.boot=bootId;
      m.complete = kids>0 && reporters.size>=kids ? 1 : 0;
      fills=new Set(); reporters=new Set();
      return m; },
  };
}
console.log("NORMAL MINUTE - every child reports");
let R=makeRunner("boot1"); R.setKids(3);
R.fill("0xa#1#0"); R.fill("0xa#1#1"); R.fill("0xb#2#0");
for(const u of ["u1","u2","u3"]) R.fromChild(u,{cc:10});
let m=R.flush();
ok(`complete=1 (reporters ${m.reporters}/${m.kids})`, m.complete===1);
ok(`fills counted distinctly (${m.fills})`, m.fills===3);
ok(`fan-out computable: cc ${m.cc} / fills ${m.fills} = ${(m.cc/m.fills).toFixed(1)}x`, m.cc===30);

console.log("\nONE CHILD MISSING - the interval must NOT be trusted");
R.setKids(3); R.fill("0xc#1#0");
R.fromChild("u1",{cc:10}); R.fromChild("u2",{cc:10});   // u3 silent
m=R.flush();
ok(`complete=0 (reporters ${m.reporters}/${m.kids})`, m.complete===0);
console.log(`     -> cc/fills would read ${(m.cc/m.fills).toFixed(0)}x, UNDERSTATED because u3 was lost.`);
console.log(`        Stage 4 must exclude this row, which complete=0 now makes possible.`);

console.log("\nCHILD RESTART - a restarted child simply reports again next interval");
R.setKids(3); R.fill("0xd#1#0");
for(const u of ["u1","u2","u3"]) R.fromChild(u,{cc:5});
m=R.flush();
ok("the interval after a child restart is complete again", m.complete===1);

console.log("\nLOST INTERVAL - a gap in seq under the SAME boot");
R.setKids(1); R.fill("0xe#1#0"); R.fromChild("u1",{cc:1});
const a=R.flush();
R.setKids(1); R.fill("0xf#1#0"); R.fromChild("u1",{cc:1});
const b=R.flush();
ok(`seq is monotonic (${a.seq} -> ${b.seq})`, b.seq===a.seq+1);
ok("same boot id across intervals", a.boot===b.boot);
console.log(`     -> a consumer seeing seq 7 then 9 under one boot knows interval 8 was LOST,`);
console.log(`        rather than silently averaging over a hole.`);

console.log("\nRUNNER RESTART - must NOT look like a lost interval");
const R2=makeRunner("boot2"); R2.setKids(1); R2.fill("0xg#1#0"); R2.fromChild("u1",{cc:1});
const c=R2.flush();
ok(`seq restarts at 1 under a NEW boot id (${c.seq}, boot ${c.boot})`, c.seq===1 && c.boot!=="boot1");
ok("so a restart is distinguishable from a gap", c.boot!==b.boot);

console.log("\nDUPLICATE FILL IDENTITY - the same fill seen twice must not inflate the denominator");
R.setKids(1); R.fill("0xh#1#0"); R.fill("0xh#1#0"); R.fill("0xh#1#0"); R.fromChild("u1",{cc:3});
m=R.flush();
ok(`three deliveries of one identity -> fills=1 (got ${m.fills})`, m.fills===1);
console.log(`     -> this is why the denominator is a Set of identities, not a counter.`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
