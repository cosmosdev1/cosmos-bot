// COPY EXIT AUTHORITY (owner 2026-08-23). Under v2 a copy position has exactly two exits: the
// whale's peak-shares ratchet and the hard take-profit. It must never reach the generic exit
// paths - the horizon stop or decideExit's TP/SL-or-AI verdict - which sell at any price and
// booked real losses at 17c and 36c while the whale still held his full position.
// Mirrors the guard in src/bot.mjs.
function reachesGenericExits({ source, v2, envOverride = "" }) {
  const copyOwnsExit = source === "copytrade" && v2 &&
    !/^(1|true|yes|on)$/i.test(envOverride);
  return !copyOwnsExit;      // true = the position CAN be sold by horizon/advice
}
let pass = 0, fail = 0;
const ck = (n, got, want) => { const ok = got === want; console.log(`${ok?"PASS":"FAIL"}  ${n}`); ok?pass++:fail++; };

ck("v2 copy position is NEVER touched by horizon/advice", reachesGenericExits({ source: "copytrade", v2: true }), false);
ck("v1 copy position keeps the old behaviour (untouched fleet)", reachesGenericExits({ source: "copytrade", v2: false }), true);
ck("quant position still uses the generic exits", reachesGenericExits({ source: "quant", v2: true }), true);
ck("sports position still uses its own server exits", reachesGenericExits({ source: "sports", v2: true }), true);
ck("cert15 position unaffected", reachesGenericExits({ source: "cert15", v2: true }), true);
ck("kill switch COPY_GENERIC_EXITS=1 restores the fall-through", reachesGenericExits({ source: "copytrade", v2: true, envOverride: "1" }), true);
ck("kill switch accepts 'true'", reachesGenericExits({ source: "copytrade", v2: true, envOverride: "true" }), true);
ck("an unset kill switch keeps the protection on", reachesGenericExits({ source: "copytrade", v2: true, envOverride: "" }), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
