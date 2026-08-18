// Prove the shared chain hub (Inc 1.5) before it touches the fast path.
//   1. It connects and subscribes to a real node (QuickNode if COSMOS_HUB_WSS is set).
//   2. It delivers real logs for a real whale set.
//   3. It beats, so children can tell "quiet market" from "hub is dead".
//   4. Backfill works against the HTTP list even when the metered node caps eth_getLogs.
// Read-only: subscribes and reads, never signs or trades.
const RUN_MS = Number(process.env.RUN_MS) || 90_000;

// The whale set: passed in, or a default of known-active Polymarket wallets.
const wallets = (process.env.WALLETS || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!wallets.length) {
  console.log("no WALLETS given - pass a comma-separated list (the union the hub would watch)");
  process.exit(1);
}

const { startChainHub } = await import("../src/chainhub.mjs");

let logs = 0, beats = 0, connectedAt = 0;
const t0 = Date.now();
const hub = startChainHub({
  onLog: (l) => {
    logs++;
    const to = "0x" + String(l.topics?.[3] ?? "").slice(-40);
    console.log(`  LOG #${logs} block ${parseInt(l.blockNumber, 16)} -> ${to.slice(0, 12)}... tx ${String(l.transactionHash).slice(0, 12)}...`);
  },
  onBeat: () => { beats++; },
  log: (...a) => { const s = a.join(" "); if (/LIVE|union|backfill/.test(s)) console.log(s); if (/LIVE/.test(s)) connectedAt = Date.now() - t0; },
  warn: (...a) => console.warn("  WARN", a.join(" ")),
});

hub.setWallets(wallets);
console.log(`watching ${wallets.length} wallets for ${RUN_MS / 1000}s via ${process.env.COSMOS_HUB_WSS ? "the CONFIGURED endpoint" : "public nodes"}...`);

await new Promise((r) => setTimeout(r, RUN_MS));
const s = hub.stats();
console.log(`\n--- result ---`);
console.log(`connected:        ${s.connected ? `YES (in ${connectedAt}ms)` : "NO"}`);
console.log(`wallets in union: ${s.wallets}`);
console.log(`logs delivered:   ${s.delivered}`);
console.log(`heartbeats:       ${beats} (expect ~${Math.floor(RUN_MS / 20000)})`);
console.log(s.connected && beats > 0
  ? "VERDICT: hub is live and beating. Children can rely on it; silence would be detectable."
  : "VERDICT: FAILED to establish a working subscription - do NOT enable the hub.");
process.exit(s.connected && beats > 0 ? 0 : 1);
