// inc() and observe() are called INSIDE the try that wraps copyCheck in the trading path. If either
// ever threw, the catch would misread it as a failed copy-check and retry a trade decision. So they
// must be total functions: no input may produce an exception. This is the only property that could
// turn instrumentation into a trading bug.
import { inc, observe, snapshot, merge } from "../src/metrics.mjs";
let pass=0, fail=0;
const noThrow=(label,fn)=>{ try{ fn(); pass++; console.log(`  ok   ${label}`); }
  catch(e){ fail++; console.log(`  FAIL ${label} -> THREW ${e.message}`); } };

const nasty=[undefined,null,NaN,Infinity,-Infinity,0,-1,1e308,"",{},[],Symbol.iterator,
  ()=>{}, new Date(), Object.create(null), true, false, 0n];
// describing the input must not itself throw - String() on a null-prototype object does
const d=v=>{ try{ return typeof v==="symbol"?"Symbol()":JSON.stringify(v)??Object.prototype.toString.call(v); }
  catch{ return Object.prototype.toString.call(v); } };
console.log("inc() must never throw");
for(const v of nasty) noThrow(`inc(${d(v)})`, ()=>inc(v));
for(const v of nasty) noThrow(`inc("cc", ${d(v)})`, ()=>inc("cc",v));
noThrow('inc("__proto__")', ()=>inc("__proto__"));
noThrow('inc("constructor")', ()=>inc("constructor"));

console.log("\nobserve() must never throw");
for(const v of nasty) noThrow(`observe(${d(v)})`, ()=>observe(v));

console.log("\nsnapshot/merge must never throw");
noThrow("snapshot()", ()=>snapshot());
for(const v of [null,undefined,{},{lat:null},{lat:"x"},{lat:{n:"x"}},[],"str",0])
  noThrow(`merge(agg, ${d(v)})`, ()=>merge({},v));

console.log("\nprototype pollution");
inc("__proto__",1); inc("constructor",1);
const ok_proto = ({}).__proto__ === Object.prototype && typeof ({}).cc === "undefined";
if(ok_proto){ pass++; console.log("  ok   counters cannot pollute Object.prototype"); }
else { fail++; console.log("  FAIL prototype was polluted"); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
