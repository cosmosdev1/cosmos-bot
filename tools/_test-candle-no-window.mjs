// CANDLES HAVE NO TIME FRAME (owner ruling 2026-08-23). The 30min-8h window applies to event
// markets only; candles are exempt at both ends. Mirrors outsideV2Window in src/copytrade.mjs.
const V2_WINDOW_MS = 8 * 3600e3, V2_MIN_MS = 30 * 60e3;
const isCandleSig = (sig) => /up or down/i.test(String(sig?.market_question ?? ""));
const outsideV2Window = (sig, v2, clockMs) => {
  if (!v2) return false;
  if (isCandleSig(sig)) return false;
  if (!Number.isFinite(clockMs)) return false;
  const left = clockMs - Date.now();
  return left > V2_WINDOW_MS || left < V2_MIN_MS;
};
let pass = 0, fail = 0;
const ck = (n, got, want) => { const ok = got === want; console.log(`${ok?"PASS":"FAIL"}  ${n}`); ok?pass++:fail++; };
const now = Date.now();

const candle15 = { market_question: "Bitcoin Up or Down - August 23, 6:45AM-7:00AM ET" };
const candle1h = { market_question: "Solana Up or Down - August 23, 10AM ET" };
const sports = { market_question: "Will Arsenal FC win on 2026-08-23?" };

ck("15m candle with 6 MINUTES left -> tradeable (was banned by the 30m floor)", outsideV2Window(candle15, true, now + 6*60e3), false);
ck("hourly candle with 12 minutes left -> tradeable", outsideV2Window(candle1h, true, now + 12*60e3), false);
ck("hourly candle 30 HOURS out (pre-buy) -> tradeable", outsideV2Window(candle1h, true, now + 30*3600e3), false);
ck("sports 6 minutes to kickoff -> still blocked (floor unchanged)", outsideV2Window(sports, true, now + 6*60e3), true);
ck("sports 30 hours out -> still blocked (ceiling unchanged)", outsideV2Window(sports, true, now + 30*3600e3), true);
ck("sports inside 30m-8h -> allowed as before", outsideV2Window(sports, true, now + 3*3600e3), false);
ck("v1 caller never window-checked", outsideV2Window(sports, false, now + 30*3600e3), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
