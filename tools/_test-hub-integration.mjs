// END-TO-END: the REAL signalhub against the REAL endpoint, with the child's ACTUAL parsing logic
// on the other end of the broadcast. Unit tests prove each half; this proves they fit together -
// which is where a payload-shape mismatch would otherwise hide until it silently stopped trading.
import { startSignalHub } from "../src/signalhub.mjs";

const API = process.env.COSMOS_API || "https://try-cosmos.com";
const TOKEN = process.env.COSMOS_TOKEN;
if (!TOKEN) { console.log("SKIP: no COSMOS_TOKEN in env"); process.exit(0); }

// --- the child side, copied verbatim from src/copytrade.mjs ---
const HUB_SILENCE_MS = 90_000;
let hubSignals = null, hubAt = 0;
const onMessage = (m) => {
  if (!m || typeof m !== "object") return;
  if (m.t === "enterable" && Array.isArray(m.signals)) { hubSignals = m.signals; hubAt = Date.now(); return; }
  if (m.t === "enterable-beat") { hubAt = Date.now(); }
};
const hubFresh = () => hubSignals !== null && (Date.now() - hubAt) < HUB_SILENCE_MS;

let pass = 0, fail = 0;
const ck = (n, got, want) => { const ok = got === want; console.log(`${ok?"PASS":"FAIL"}  ${n}${ok?"":`  (got ${got}, want ${want})`}`); ok?pass++:fail++; };

const hub = startSignalHub({
  fetchEnterable: async () => {
    const r = await fetch(`${API}/api/v1/copy-enterable`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  },
  broadcast: onMessage,          // wire the hub straight into the child's handler
  log: (m) => console.log("   " + m), warn: (m) => console.log("   WARN " + m),
});

await new Promise((r) => setTimeout(r, 6000));
hub.stop();

ck("hub reached the endpoint", hub.stats().consecutiveFails, 0);
ck("child received a set", hubSignals !== null, true);
ck("child considers it fresh", hubFresh(), true);

// the key shape contract: the child builds its filter key from condition_id + outcome
const keys = new Set((hubSignals ?? []).map((s) => `${s.condition_id}|${String(s.outcome).toLowerCase()}`));
ck("every row yields a usable filter key", keys.size, (hubSignals ?? []).length);
ck("no row has an undefined key", [...keys].some((k) => k.includes("undefined")), false);

// and the fields the bot needs downstream must survive the trip
const missing = (hubSignals ?? []).filter((s) => !s.condition_id || !s.token_id || !s.outcome).length;
ck("rows carry condition_id/token_id/outcome", missing, 0);
const badPct = (hubSignals ?? []).filter((s) => ![5,4,3,2].includes(Number(s.v2_pct))).length;
ck("rows carry a valid tier %", badPct, 0);

console.log(`\n   (${(hubSignals ?? []).length} enterable rows round-tripped)`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
