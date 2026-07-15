// Local DRY harness for qtable2 — mock deps, QTABLE2_DRY=1, places nothing. Verifies the engine
// connects Chainlink, discovers BTC candle markets, loads the refit tow table, and produces sane
// signals. Not committed. Run: node dry-qtable2.mjs
if (process.env.FORCE_WS === "1") { delete globalThis.WebSocket; console.log("(forced ws fallback — simulating Node 20: global WebSocket removed)"); }
process.env.QTABLE2_DRY = "1";
process.env.QTABLE2_COINS = process.env.QTABLE2_COINS || "BTCUSDT";
const RUN_MS = Number(process.env.DRY_RUN_MS) || 75000;

const { startQTable2 } = await import("./src/qtable2.mjs");
const positions = {};
const deps = {
  pm: { placeOrder: async () => ({ ok: false, status: 0, err: "DRY (should never be called)" }) },
  cosmos: { meter: async () => {} },
  store: { load: () => positions, save: (p) => { for (const k of Object.keys(p)) positions[k] = p[k]; } },
  placeWithRetry: async () => ({ ok: false, status: 0, err: "DRY (should never be called)" }),
  sharesFor: (usd, cents) => Math.floor((usd * 100) / Math.max(1, cents)),
  sizeForSignal: () => 2,
  state: { cash: 1000, portfolio: 1000, deployed: 0, sizing: { mode: "fixed", fixedUsd: 2 } },
};
const stop = startQTable2(deps);
setTimeout(() => { stop(); console.log(`=== DRY harness done (${RUN_MS / 1000}s) · positions written: ${Object.keys(positions).length} (should be 0 in DRY) ===`); process.exit(0); }, RUN_MS);
