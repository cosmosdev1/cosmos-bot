// PAIR FIRST-LEG GATE CONTRACT (owner 2026-08-23): the first leg of a pair is banded at 20% like
// any entry; a leg whose sibling is already held is NEVER blocked (half a hedge is worse than a
// bad price). Mirrors tooFarFromHisEntry + holdsPairSibling in src/copytrade.mjs.
const GAP=0.20;
const hisAvg=(sig)=>sig.avg;
const tooFar=(sig,exec,holdsSibling=false)=>{
  if(sig.is_pair&&holdsSibling) return false;
  const avg=hisAvg(sig); if(avg==null||!(exec>0)) return false;
  const tol=Math.max(avg*GAP,5);
  return Math.abs(exec-avg)>tol;
};
const holdsSib=(positions,sig)=>{
  const prim=positions[sig.condition_id];
  if(prim&&String(prim.outcome).toLowerCase()!==String(sig.outcome).toLowerCase()) return true;
  const own=`${sig.condition_id}#${sig.token_id}`;
  return Object.keys(positions).some(k=>k.startsWith(sig.condition_id+"#")&&k!==own);
};
let pass=0,fail=0;
const ck=(n,got,want)=>{const ok=got===want;console.log(`${ok?"PASS":"FAIL"}  ${n}`);ok?pass++:fail++;};

const up={condition_id:"0xc",token_id:"t1",outcome:"Up",is_pair:true,avg:50};
const down={condition_id:"0xc",token_id:"t2",outcome:"Down",is_pair:true,avg:50};

// first leg: banded like everyone
ck("pair FIRST leg within 20% -> allowed", tooFar(up,58,holdsSib({},up)), false);
ck("pair FIRST leg moved 24% -> BLOCKED (the new rule)", tooFar(up,62,holdsSib({},up)), true);
ck("pair FIRST leg crashed 30% -> BLOCKED", tooFar(up,35,holdsSib({},up)), true);
// second leg: sibling held -> never blocked
const holdingUp={ "0xc":{outcome:"Up"} };
ck("SECOND leg with sibling held (primary slot) -> exempt at any price", tooFar(down,80,holdsSib(holdingUp,down)), false);
const holdingComp={ "0xc#t1":{outcome:"Up",source:"copytrade"} };
ck("SECOND leg with sibling held (comp slot) -> exempt", tooFar(down,80,holdsSib(holdingComp,down)), false);
// holding the SAME side is not a sibling
ck("holding the SAME side is not a sibling (add path handles it)", holdsSib({ "0xc":{outcome:"Up"} },up), false);
ck("own comp slot is not a sibling", holdsSib({ "0xc#t1":{outcome:"Up"} },up), false);
// non-pair unchanged
const solo={condition_id:"0xd",token_id:"t9",outcome:"Yes",is_pair:false,avg:40};
ck("non-pair within band -> allowed", tooFar(solo,45,false), false);
ck("non-pair beyond band -> blocked (unchanged)", tooFar(solo,55,false), true);
// the 5c absolute floor survives
const cheap={condition_id:"0xe",token_id:"t8",outcome:"Yes",is_pair:true,avg:8};
ck("cheap pair first leg: 5c floor still applies (8->12c ok)", tooFar(cheap,12,false), false);
ck("cheap pair first leg: 8->14c blocked", tooFar(cheap,14,false), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
