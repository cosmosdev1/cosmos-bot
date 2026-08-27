// The reaper SIGKILLs real production trading processes. The parse it relies on is the part that can
// silently pick the wrong number: /proc stat's comm field is attacker-shaped by accident - a process
// named "node (bot" or ") ) )" shifts every field after it. Getting ppid wrong in the unsafe
// direction means killing a supervised, actively-trading bot.
import { parseProcStat } from "../src/proc.mjs";
let pass=0, fail=0;
const ok=(n,c)=>{ if(c){pass++;console.log(`  ok   ${n}`);} else {fail++;console.log(`  FAIL ${n}`);} };

// a real line from the production box (pid 15032, the orphan): ppid 1
const real="15032 (node) S 1 15032 15032 0 -1 4194304 918273 0 91 0 1409281 233 0 0 20 0 11 0 2325872 1234567890 45678 18446744073709551615 4194304 4194304 0 0 0 0 0 0 0 0 0 0 17 1 0 0 0 0 0";
const r=parseProcStat(real);
ok("real orphan line parses", !!r);
ok(`  ppid === 1 (got ${r?.ppid})`, r?.ppid===1);
ok(`  starttime seconds (got ${r?.startTimeS})`, r?.startTimeS===23258.72);

// a healthy child: ppid is the runner
const healthy="11946 (node) S 11706 11946 11946 0 -1 4194304 1000 0 5 0 240 12 0 0 20 0 11 0 23700000 999 1 0 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0";
ok("healthy child reports the runner as parent, not 1", parseProcStat(healthy)?.ppid===11706);

// THE DANGEROUS CASES - a comm containing spaces or parens must not shift the fields
const spaced="777 (node bot mjs) S 11706 777 777 0 -1 0 0 0 0 0 5 1 0 0 20 0 11 0 500 0 0";
ok("comm with SPACES still yields ppid 11706 (not misread as 1)", parseProcStat(spaced)?.ppid===11706);
const paren="778 (weird)name) S 1 778 778 0 -1 0 0 0 0 0 5 1 0 0 20 0 11 0 500 0 0";
ok("comm containing ')' parses from the LAST paren", parseProcStat(paren)?.ppid===1);
const both="779 (my (odd) proc) S 11706 779 779 0 -1 0 0 0 0 0 5 1 0 0 20 0 11 0 500 0 0";
ok("comm with both spaces and parens -> ppid 11706, NOT reaped", parseProcStat(both)?.ppid===11706);

// malformed input must return null, never a wrong number
for(const bad of ["", "garbage with no paren", "123 (node", null, undefined, "123 (n) S notanumber"]){
  const v=parseProcStat(bad??"");
  ok(`malformed ${JSON.stringify(String(bad).slice(0,22))} -> null or non-1 ppid`, v===null||v.ppid!==1);
}
// a line whose ppid is 1 but starttime is unparseable must not produce a reapable verdict
ok("missing starttime -> null (cannot age-check, so cannot reap)", parseProcStat("1 (n) S 1 1 1")===null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
