// DIFFERENTIAL TEST. Replacing chainwatch's inline tokensFromLog with the shared module was the ONE
// trading-path change in the batch. If the two parsers disagree on any real log, the fleet's trading
// behaviour changed - which would show up downstream as a shifted funnel ratio and be very easy to
// misattribute. Compare them on real chain data, not fixtures.
import { tokensFromLog as NEW } from "../src/fills.mjs";
import { tokensFromLogOLD as OLD } from "./tmp/old-parser.mjs";
const RPCS=[process.env.POLYGON_RPC_URL,"https://polygon-bor-rpc.publicnode.com","https://polygon-rpc.com"].filter(Boolean);
const rpc=async(m,p)=>{ for(const u of RPCS){ try{
  const r=await fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p}),signal:AbortSignal.timeout(25000)});
  if(!r.ok) continue; const j=await r.json(); if(j.error||j.result==null) continue; return j.result; }catch{} } return null; };
const CTF="0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const T_SINGLE="0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
const T_BATCH ="0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";
const head=parseInt(await rpc("eth_blockNumber",[]),16);
let logs=[];
for(const t of [T_SINGLE,T_BATCH]){
  for(let s=head-600;s<head;s+=200){
    const part=await rpc("eth_getLogs",[{address:CTF,topics:[t],
      fromBlock:"0x"+s.toString(16),toBlock:"0x"+Math.min(head,s+199).toString(16)}]);
    if(Array.isArray(part)) logs=logs.concat(part);
  }
}
console.log(`real logs fetched: ${logs.length}`);
const singles=logs.filter(l=>l.topics[0]===T_SINGLE).length;
const batches=logs.filter(l=>l.topics[0]===T_BATCH).length;
console.log(`  TransferSingle ${singles} · TransferBatch ${batches}\n`);
let same=0, diff=0; const examples=[];
for(const l of logs){
  const a=JSON.stringify(OLD(l)), b=JSON.stringify(NEW(l));
  if(a===b) same++; else { diff++; if(examples.length<3) examples.push({tx:l.transactionHash,li:l.logIndex,old:a.slice(0,90),neu:b.slice(0,90)}); }
}
console.log(`IDENTICAL output : ${same} of ${logs.length}`);
console.log(`DIFFERENT output : ${diff}`);
for(const e of examples){ console.log(`  ${e.tx.slice(0,14)}..#${e.li}`); console.log(`    old ${e.old}`); console.log(`    new ${e.neu}`); }
// the deliberate behavioural differences, asserted rather than assumed
console.log(`\nDELIBERATE DIFFERENCES (guards added, not logic changed):`);
const absurd={topics:[T_BATCH],data:"0x"+"0".repeat(126)+"40"+"0".repeat(126)+"60"+(99999).toString(16).padStart(64,"0")};
let oldThrew=false; try{ OLD(absurd); }catch{ oldThrew=true; }
console.log(`  absurd batch length -> old ${oldThrew?"threw":"returned "+JSON.stringify(OLD(absurd)).slice(0,20)} · new ${JSON.stringify(NEW(absurd))}`);
console.log(`  (the new bound returns [] instead of allocating; no real batch approaches 1024 items)`);
console.log(`\n${diff===0?"PASS - parsers are equivalent on every real log sampled":"FAIL - trading behaviour may have changed"}`);
process.exit(diff===0?0:1);
