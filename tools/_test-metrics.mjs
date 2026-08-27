// The instrumentation must be incapable of becoming the problem it measures. The properties that
// matter are: fixed cardinality (an unknown key cannot create a series), delta semantics (a lost
// flush loses one interval and never double-counts), and no unbounded memory.
import { inc, observe, snapshot, merge, emptyAggregate, KEYS } from "../src/metrics.mjs";
let pass=0, fail=0;
const ok=(n,c)=>{ if(c){pass++;console.log(`  ok   ${n}`);} else {fail++;console.log(`  FAIL ${n}`);} };

console.log("cardinality");
ok("a known key increments", inc("cc",3)===true);
ok("an UNKNOWN key is refused (no new series can be created)", inc("per_wallet_0xdeadbeef",1)===false);
ok("a non-finite value is refused", inc("cc",NaN)===false && inc("cc",Infinity)===false);
let s=snapshot();
ok("snapshot exposes only the frozen key set", Object.keys(s).filter(k=>k!=="lat").every(k=>KEYS.includes(k)));
ok("  and every frozen key is present", KEYS.every(k=>k in s));
ok("cc carried the 3 increments", s.cc===3);

console.log("\ndelta semantics");
inc("cc",5); const a=snapshot(); const b=snapshot();
ok("first snapshot returns 5", a.cc===5);
ok("second snapshot returns 0 - counters RESET, so sums cannot double-count", b.cc===0);

console.log("\nlatency histogram");
for(const v of [10,60,120,300,700,1500,4000,20000]) observe(v);
ok("a negative observation is refused", observe(-5)===false);
ok("a non-numeric observation is refused", observe("slow")===false);
const h=snapshot();
ok(`n counted (${h.lat?.n})`, h.lat?.n===8);
ok(`p50 within bucket range (${h.lat?.p50})`, h.lat.p50>=250 && h.lat.p50<=1000);
ok(`p99 is at the high end (${h.lat?.p99})`, h.lat.p99>=10000);
ok("an empty window reports no lat block at all", snapshot().lat===undefined);

console.log("\nmerge across children");
let agg=emptyAggregate();
merge(agg,{cc:10,sig:4,lat:{n:2,avg:100,p50:100,p95:250,p99:500}});
merge(agg,{cc:7, sig:1,lat:{n:3,avg:200,p50:250,p95:1000,p99:2500}});
ok("counters sum across children", agg.cc===17 && agg.sig===5);
ok("latency n sums", agg.lat.n===5);
ok("percentiles take the WORST child (pessimistic, never hides a regression)", agg.lat.p95===1000 && agg.lat.p99===2500);
merge(agg,{cc:"garbage", evil_key:99, lat:{n:0}});
ok("a malformed child delta cannot corrupt the aggregate", agg.cc===17 && !("evil_key" in agg));
ok("a child sending nothing is harmless", (merge(agg,null),agg.cc===17));

console.log("\nbounded memory");
for(let i=0;i<50000;i++){ inc("cc"); observe(i%30000); }
const big=snapshot();
ok("50k observations produce a fixed-size payload", JSON.stringify(big).length < 400);
ok("  and the counter is exact", big.cc===50000);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
