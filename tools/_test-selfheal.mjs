// SELF-HEAL CONTRACT: the two failure shapes from 2026-08-21/22 must trigger a runner exit, and
// healthy operation must never. Mirrors the counters in src/runner.mjs.
function mkDetector(die) {
  let quickDeaths = 0, resetAt = 0, now = 0;
  return {
    tick: (ms) => { now += ms; },
    exit: (uptimeS) => {
      if (now > resetAt) { quickDeaths = 0; resetAt = now + 120_000; }
      if (uptimeS < 10) { quickDeaths++; if (quickDeaths >= 6) die(`storm:${quickDeaths}`); }
      else if (uptimeS > 60) quickDeaths = 0;
    },
  };
}
function mkWedge(die) {
  let lastOk = 0, now = 0;
  return { tick: (ms) => { now += ms; if (now - lastOk > 600_000) die("wedge"); }, ok: () => { lastOk = now; } };
}
let pass=0, fail=0;
const ck=(n,got,want)=>{const ok=got===want;console.log(`${ok?"PASS":"FAIL"}  ${n}`);ok?pass++:fail++;};

{ let died=null; const d=mkDetector((r)=>died=r);
  for(let i=0;i<6;i++){ d.tick(5_000); d.exit(1); }
  ck("6 infant deaths in 30s -> runner exits (broken tree)", died!=null, true); }
{ let died=null; const d=mkDetector((r)=>died=r);
  for(let i=0;i<5;i++){ d.tick(5_000); d.exit(1); }
  d.tick(5_000); d.exit(300);   // one healthy long-lived exit resets nothing (only >60s uptime resets)
  ck("healthy child exit resets the storm counter", died==null, true);
  for(let i=0;i<5;i++){ d.tick(5_000); d.exit(1); }
  ck("...so 5 more infant deaths alone do not trip it", died==null, true); }
{ let died=null; const d=mkDetector((r)=>died=r);
  for(let i=0;i<6;i++){ d.tick(60_000); d.exit(1); }   // spread over 6 minutes - window resets
  ck("slow trickle of crashes does NOT trip the storm", died==null, true); }
{ let died=null; const w=mkWedge((r)=>died=r);
  for(let i=0;i<9;i++){ w.tick(60_000); w.ok(); }
  ck("regular network success never trips the wedge", died==null, true); }
{ let died=null; const w=mkWedge((r)=>died=r);
  w.ok();
  for(let i=0;i<11;i++) w.tick(60_000);
  ck("11 minutes of network silence trips the wedge", died!=null, true); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
