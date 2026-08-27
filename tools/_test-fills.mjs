// The Stage 4 denominator depends entirely on this parse. A wrong itemIndex, a merged fill or a
// dropped entry silently corrupts the architectural proof, so the properties are asserted directly -
// especially TransferBatch, which is the case the identity was redesigned for.
import { qualifyingFillIds, tokensFromLog, T_SINGLE, T_BATCH } from "../src/fills.mjs";
let pass=0, fail=0;
const ok=(n,c)=>{ if(c){pass++;console.log(`  ok   ${n}`);} else {fail++;console.log(`  FAIL ${n}`);} };
const W="0x7c63520c2ca9b336af0c205b9ccf68217bb393d4";
const OTHER="0x1111111111111111111111111111111111111111";
const topic=a=>"0x"+a.replace(/^0x/,"").padStart(64,"0");
const h64=n=>BigInt(n).toString(16).padStart(64,"0");
const watched=a=>a.toLowerCase()===W.toLowerCase();

console.log("TransferSingle");
const single={transactionHash:"0xaa",logIndex:"0x5",topics:[T_SINGLE,topic(OTHER),topic(OTHER),topic(W)],
  data:"0x"+h64(12345)+h64(2_000000)};
const s=qualifyingFillIds(single,watched);
ok(`one entry -> one identity (${s.length})`, s.length===1);
ok(`identity is txHash#logIndex#itemIndex ("${s[0]}")`, s[0]==="0xaa#0x5#0");

console.log("\nTransferBatch - the case the identity was redesigned for");
// data: idsOffset, valsOffset, len, id0,id1,id2, len, v0,v1,v2
const batchData="0x"+h64(64)+h64(64+32*4)+h64(3)+h64(111)+h64(222)+h64(333)+h64(3)+h64(1_000000)+h64(2_000000)+h64(3_000000);
const batch={transactionHash:"0xbb",logIndex:"0x7",topics:[T_BATCH,topic(OTHER),topic(OTHER),topic(W)],data:batchData};
const b=qualifyingFillIds(batch,watched);
ok(`three token entries -> THREE identities (${b.length}) - txHash#logIndex alone would give 1`, b.length===3);
ok(`all distinct`, new Set(b).size===3);
ok(`indices are 0,1,2 (${b.join(", ")})`, b[0].endsWith("#0")&&b[1].endsWith("#1")&&b[2].endsWith("#2"));

console.log("\nduplicate token id inside one batch (ERC-1155 permits it)");
const dupData="0x"+h64(64)+h64(64+32*3)+h64(2)+h64(999)+h64(999)+h64(2)+h64(1_000000)+h64(5_000000);
const dup=qualifyingFillIds({transactionHash:"0xcc",logIndex:"0x1",topics:[T_BATCH,topic(OTHER),topic(OTHER),topic(W)],data:dupData},watched);
ok(`same token twice -> still two distinct identities (${dup.length})`, dup.length===2 && new Set(dup).size===2);

console.log("\nfilters must mirror chainwatch");
ok("recipient not watched -> no identities",
   qualifyingFillIds({...single,topics:[T_SINGLE,topic(OTHER),topic(OTHER),topic(OTHER)]},watched).length===0);
ok("whale-to-whale shuffle -> no identities",
   qualifyingFillIds({...single,topics:[T_SINGLE,topic(W),topic(W),topic(W)]},watched).length===0);
const zero={...single,data:"0x"+h64(12345)+h64(0)};
ok("zero-share entry -> no identity (fires no onFill)", qualifyingFillIds(zero,watched).length===0);

console.log("\nstability and safety");
ok("same log parsed twice yields the same identities",
   JSON.stringify(qualifyingFillIds(single,watched))===JSON.stringify(qualifyingFillIds(single,watched)));
for(const bad of [null,undefined,{},{topics:[]},{topics:[T_BATCH],data:"0xzz"},{transactionHash:"0xa",logIndex:"",topics:[T_SINGLE,0,0,topic(W)],data:"0x"}])
  ok(`malformed input -> [] not a throw (${JSON.stringify(bad)?.slice(0,26)})`, Array.isArray(qualifyingFillIds(bad,watched)));
const huge={transactionHash:"0xdd",logIndex:"0x1",topics:[T_BATCH,topic(OTHER),topic(OTHER),topic(W)],
  data:"0x"+h64(64)+h64(96)+h64(99999)};
ok("absurd batch length is bounded, not allocated", qualifyingFillIds(huge,watched).length===0);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
