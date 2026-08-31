// DELIVERY SEMANTICS, pinned by test rather than argued. Metrics used for architectural proof must
// have known failure behaviour: if a restart can silently double-count, every Stage 4 conclusion is
// unsound. These assertions describe what the system ACTUALLY does, including where it loses data.
import { inc, snapshot, merge, emptyAggregate } from "../src/metrics.mjs";
let pass=0, fail=0;
const ok=(n,c)=>{ if(c){pass++;console.log(`  ok   ${n}`);} else {fail++;console.log(`  FAIL ${n}`);} };

console.log("AT-MOST-ONCE: snapshot() resets before delivery, so a failed send LOSES an interval");
inc("cc",100);
const taken=snapshot();                       // this is what the child hands to process.send
ok("the interval was removed from the child on read", snapshot().cc===0);
ok(`  the taken payload holds it (${taken.cc})`, taken.cc===100);
console.log("     -> if process.send throws here, those 100 are gone. LOSS, never duplication.");

console.log("\nNO DOUBLE-COUNT: re-reading cannot resurrect a delivered interval");
inc("cc",7); const a=snapshot(); const b=snapshot(); const c=snapshot();
ok("second and third reads are empty", a.cc===7 && b.cc===0 && c.cc===0);
console.log("     -> a retried or duplicated IPC message would carry the SAME object, and the");
console.log("        runner merges whatever arrives, so a genuine duplicate WOULD double-count.");
let agg=emptyAggregate();
merge(agg,a); merge(agg,a);                   // simulate the same message delivered twice
ok(`duplicate delivery of one message DOES double-count (${agg.cc} from 7)`, agg.cc===14);
console.log("     -> node IPC does not retry, and the runner does not retry its POST, so no path");
console.log("        currently produces a duplicate. This is a property of the transport, not a guard.");

console.log("\nCHILD RESTART: in-memory counters vanish with the process");
inc("cc",42);
// a restart is indistinguishable from never having counted
const fresh=emptyAggregate();
ok("a fresh process starts at zero, so nothing is carried forward", fresh.cc===0);
console.log("     -> up to one interval lost per restart. No double-count: nothing was persisted.");
snapshot();

console.log("\nRUNNER RESTART: the aggregate is in memory too");
let agg2=emptyAggregate(); merge(agg2,{cc:5,hubEv:1});
agg2=emptyAggregate();                        // restart
ok("the un-flushed aggregate is lost, not replayed", agg2.cc===0);

console.log("\nZERO-ACTIVITY MINUTE: no row is written at all");
console.log("     -> a quiet interval and a LOST interval are indistinguishable in the row series.");
ok("an empty snapshot has no activity keys set", (()=>{const s=snapshot(); return !s.cc && !s.ev;})());

console.log("\nTHE ASYMMETRY THAT BIASES THE STAGE 4 NUMBER");
console.log("     cc  comes from CHILDREN over lossy IPC.");
console.log("     hubEv comes from the RUNNER itself and cannot be lost the same way.");
let biased=emptyAggregate();
merge(biased,{hubEv:10});                     // runner counted 10 distinct fills
merge(biased,{cc:50});                        // only some children reported
const trueRatio=100/10, seenRatio=biased.cc/biased.hubEv;
ok(`a lost child flush UNDERSTATES the multiplier (${seenRatio}x seen vs ${trueRatio}x true)`, seenRatio<trueRatio);
console.log("     -> understating is the DANGEROUS direction: it would make Stage 4 look successful");
console.log("        when it is not. Mitigation: count reporting children per interval and treat any");
console.log("        interval with reporters < kids as incomplete. Not yet implemented - see ledger.");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
