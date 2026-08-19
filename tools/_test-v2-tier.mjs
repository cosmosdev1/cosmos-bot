// The bot must resolve v2 tiers from the whale's OWN thresholds carried on the signal, and must NOT
// size off tier_pct_resolved (which is the shared, legacy-ladder value - measured 0% and 1.5% on the
// pilot's live feed, neither of them a v2 tier).
const V2_NC_PCTS=[5,3,2], V2_CANDLE_PCTS=[3,2];
const pctFromBands=(cost,t,pcts)=>{ if(!t) return null;
  const ladder=[t.t1_usd,t.t2_usd,t.t3_usd];
  for(let i=0;i<pcts.length;i++){ const th=Number(ladder[i]); if(Number.isFinite(th)&&cost>=th) return pcts[i]; }
  return 0; };
function candleMinutesFromTitle(q){
  const r=/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*ET/i.exec(q);
  if(!r) return 60;
  const toMin=(h,m,ap)=>{let hh=Number(h)%12; if(/pm/i.test(ap))hh+=12; return hh*60+Number(m??0);};
  const d=(toMin(r[4],r[5],r[6])-toMin(r[1],r[2],r[3])+1440)%1440; return d>0?d:60; }
const isCandle=(s)=>/up or down/i.test(String(s.market_question??""));
function v2Pct(sig){
  const v2t=sig?.wallets?.[0]?.auto_tiers?.v2; if(!v2t) return null;
  const cost=Number(sig.his_cost_usd)||0;
  if(isCandle(sig)){ const d=candleMinutesFromTitle(String(sig.market_question??"")); if(d!==15&&d!==60) return 0;
    return pctFromBands(cost,v2t.candle,V2_CANDLE_PCTS); }
  return pctFromBands(cost,v2t.nc,V2_NC_PCTS); }

const nc={t1_usd:15824,t2_usd:8144,t3_usd:4692,n:500};
const candle={t1_usd:62,t2_usd:30,n:500};
const sig=(o)=>({market_question:"Team A vs Team B",his_cost_usd:1000,tier_pct_resolved:1.5,wallets:[{auto_tiers:{v2:{nc,candle}}}],...o});
let p=0,f=0; const ck=(n,g,w)=>{const ok=g===w;console.log(`${ok?"PASS":"FAIL"}  ${n}${ok?"":`  got ${g}, want ${w}`}`);ok?p++:f++;};

ck("non-crypto above his top-10% -> 5%", v2Pct(sig({his_cost_usd:20000})), 5);
ck("non-crypto in his top-20% -> 3%",    v2Pct(sig({his_cost_usd:9000})), 3);
ck("non-crypto in his top-30% -> 2%",    v2Pct(sig({his_cost_usd:5000})), 2);
ck("non-crypto below his top-30% -> 0 (no entry)", v2Pct(sig({his_cost_usd:1000})), 0);
ck("15m candle in his top-25% -> 3%",  v2Pct(sig({market_question:"Ethereum Up or Down - Aug 19, 2:00PM-2:15PM ET",his_cost_usd:100})), 3);
ck("hourly candle in his top-50% -> 2%", v2Pct(sig({market_question:"Bitcoin Up or Down - Aug 19, 2:00PM-3:00PM ET",his_cost_usd:40})), 2);
ck("candle below his top-50% -> 0 (third tier REMOVED)", v2Pct(sig({market_question:"Bitcoin Up or Down - Aug 19, 2:00PM-3:00PM ET",his_cost_usd:10})), 0);
ck("4h candle -> 0 (out of spec)", v2Pct(sig({market_question:"Bitcoin Up or Down - Aug 19, 12:00PM-4:00PM ET",his_cost_usd:5000})), 0);
ck("5m candle -> 0 (banned)", v2Pct(sig({market_question:"Bitcoin Up or Down - Aug 19, 2:00PM-2:05PM ET",his_cost_usd:5000})), 0);
ck("NO thresholds yet -> null, so the caller falls back rather than guessing",
   v2Pct({market_question:"Team A vs B",his_cost_usd:9999,wallets:[{auto_tiers:{}}]}), null);
console.log(`\n${p} passed, ${f} failed`);
process.exitCode=f?1:0;
