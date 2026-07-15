// Throwaway: exercise the REAL model-stop logic from bot.mjs with mocked cosmos + pm.
// Run: node tmp/quant-stop-test.mjs
// Dummy creds so bot.mjs's top-level config guard passes on import (main() is guarded, so importing
// does NOT boot the trading loop).
process.env.COSMOS_TOKEN = "test";
process.env.POLYMARKET_PRIVATE_KEY = "0x00";

const { quantModelStop, quantStopFires } = await import("../src/bot.mjs");

const cfg = { stopP: 0.30, edgePp: 8, minTau: 15 }; // the conservative defaults
const basePos = {
  source: "quant", token_id: "t", outcome: "Yes",
  market_question: "Bitcoin above $62000 at 3PM ET?", entry_cents: 40, size_shares: 100, condition_id: "c",
};
const mkCosmos = (modelP, tauMin = 30) => ({ quantExit: async () => ({ ok: true, modelP, tauMin }) });
const mkPm = (bid) => ({ getBestBidCents: async () => bid });

const cases = [
  { label: "(a) modelP=0.20 bid=35c", modelP: 0.20, bid: 35, expectFire: true },  // 35 >= 20+8=28 -> FIRES
  { label: "(b) modelP=0.20 bid=25c", modelP: 0.20, bid: 25, expectFire: false }, // 25 <  28       -> no
  { label: "(c) modelP=0.45 bid=60c", modelP: 0.45, bid: 60, expectFire: false }, // modelP !< 0.30 -> no
];

let pass = true;
console.log(`default QUANT_STOP_MODE = "${process.env.QUANT_STOP_MODE || "shadow"}"\n`);

for (const c of cases) {
  const cosmos = mkCosmos(c.modelP);
  const pm = mkPm(c.bid);

  // 1) pure rule
  const fires = quantStopFires({ modelP: c.modelP, tauMin: 30, bidCents: c.bid }, cfg);

  // 2) SHADOW mode (default) -> must NEVER sell (returns null), only logs for a firing case
  delete process.env.QUANT_STOP_MODE; // default = shadow
  const shadow = await quantModelStop(cosmos, pm, basePos);

  // 3) LIVE mode -> returns a STOP_LOSS verdict only when the rule fires
  process.env.QUANT_STOP_MODE = "live";
  const live = await quantModelStop(cosmos, pm, basePos);
  delete process.env.QUANT_STOP_MODE;

  const ok =
    fires === c.expectFire &&
    shadow === null && // shadow NEVER sells
    (c.expectFire ? (live && live.action === "STOP_LOSS") : live === null);
  pass = pass && ok;
  console.log(`${c.label.padEnd(26)} fires=${fires} shadow=${shadow === null ? "null(no-sell)" : "SOLD!"} live=${live ? live.action : "null"}  ${ok ? "PASS" : "FAIL"}`);
}

console.log(`\nonly case (a) triggers: ${quantStopFires({ modelP: 0.20, tauMin: 30, bidCents: 35 }, cfg) && !quantStopFires({ modelP: 0.20, tauMin: 30, bidCents: 25 }, cfg) && !quantStopFires({ modelP: 0.45, tauMin: 30, bidCents: 60 }, cfg)}`);
// near-expiry guard: same firing inputs but tauMin=10 (< 15) must NOT fire
console.log(`near-expiry guard (tau=10) blocks: ${quantStopFires({ modelP: 0.20, tauMin: 10, bidCents: 35 }, cfg) === false}`);
console.log(`\n${pass ? "ALL PASS" : "SOME FAILED"}`);
process.exit(pass ? 0 : 1);
