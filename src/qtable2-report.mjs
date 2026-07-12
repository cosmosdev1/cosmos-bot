// qtable2-report.mjs — human-readable report of the qtable2 LIVE trades. Reads the durable ledger
// (qtable2-trades.ndjson), resolves each candle's win/loss from Polymarket's OFFICIAL market resolution,
// and prints a table + summary: edge, timestamp, entry, result, P&L, and latency (trigger->order landed).
// Read-only; safe to run anytime.
//
//   On the bot:  fly ssh console -a cosmos-bot-hi1jf5 -C "node /app/repo/src/qtable2-report.mjs"
//   Locally:     COSMOS_DATA_DIR=<dir-with-ledger> node src/qtable2-report.mjs
import { readFileSync, existsSync } from "node:fs";

const DATA_DIR = (process.env.COSMOS_DATA_DIR || ".").replace(/\/$/, "");
const LEDGER = `${DATA_DIR}/qtable2-trades.ndjson`;
if (!existsSync(LEDGER)) { console.log(`No qtable2 trades yet (${LEDGER}).`); process.exit(0); }

const rows = readFileSync(LEDGER, "utf8").trim().split("\n").filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && r.ok !== false); // fills only; failed attempts (ok:false) are kept in the ledger but not scored

const j = async (u) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(8000) }); return r.ok ? await r.json() : null; } catch { return null; } };

// win/loss from Polymarket's official resolution (outcomePrices: winning outcome -> "1", losing -> "0")
async function resolve(row) {
  if (Date.now() < (row.end_ms || 0) + 15000) return { status: "PENDING" };  // window not closed yet
  const arr = await j(`https://gamma-api.polymarket.com/markets?condition_ids=${row.cid}`);
  const m = (Array.isArray(arr) ? arr : arr?.markets ?? [])[0];
  if (!m) return { status: "PENDING" };
  let prices, outs;
  try { prices = JSON.parse(m.outcomePrices); outs = JSON.parse(m.outcomes); } catch { return { status: "PENDING" }; }
  if (!Array.isArray(prices) || !prices.some((p) => Number(p) >= 0.99)) return { status: "PENDING" }; // not settled yet
  const idx = outs.findIndex((o) => String(o).toLowerCase() === String(row.outcome).toLowerCase());
  if (idx < 0) return { status: "UNKNOWN" };
  const won = Number(prices[idx]) >= 0.99;
  const pnl = won ? (row.shares - row.size_usd) : -row.size_usd; // win: shares*$1 payout - cost; loss: -cost (gross of builder fee)
  return { status: won ? "WIN" : "LOSS", pnl };
}

const results = [];
for (const r of rows) results.push({ ...r, ...(await resolve(r)) });

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const padl = (s, n) => String(s).padStart(n);
console.log(`\nQTABLE2 live trades — ${results.length} fills   (ledger: ${LEDGER})`);
console.log("-".repeat(112));
console.log([pad("time (UTC)", 19), pad("mkt", 4), pad("side", 5), padl("entry", 6), padl("edge", 6), padl("P", 4), padl("d%", 7), padl("t%", 4), padl("lat(ms)", 8), pad("result", 7), padl("pnl$", 8)].join(" "));
console.log("-".repeat(112));
let wins = 0, losses = 0, pending = 0, pnl = 0; const lats = [];
for (const r of results) {
  const time = String(r.ts).replace("T", " ").slice(0, 19);
  const pnlStr = r.pnl != null ? (r.pnl >= 0 ? "+" : "") + r.pnl.toFixed(2) : "";
  console.log([pad(time, 19), pad(r.frame, 4), pad(r.side, 5), padl(r.entry_cents + "c", 6), padl(Number(r.edge).toFixed(3), 6), padl(Math.round(r.p * 100) + "%", 4), padl(Number(r.d_pct).toFixed(3), 7), padl(Math.round(r.elapsed_pct), 4), padl(r.total_ms ?? "", 8), pad(r.status, 7), padl(pnlStr, 8)].join(" "));
  if (r.status === "WIN") { wins++; pnl += r.pnl; } else if (r.status === "LOSS") { losses++; pnl += r.pnl; } else pending++;
  if (typeof r.total_ms === "number") lats.push(r.total_ms);
}
console.log("-".repeat(112));
const settled = wins + losses;
const wr = settled ? ((wins / settled) * 100).toFixed(1) + "%" : "—";
const avgEdge = results.length ? (results.reduce((a, r) => a + (Number(r.edge) || 0), 0) / results.length).toFixed(3) : "—";
lats.sort((a, b) => a - b);
const avg = lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : "—";
const p95 = lats.length ? lats[Math.min(lats.length - 1, Math.floor(lats.length * 0.95))] : "—";
const max = lats.length ? lats[lats.length - 1] : "—";
console.log(`settled ${settled} (W ${wins} / L ${losses}) · win rate ${wr} · pending ${pending} · P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} · avg edge ${avgEdge}`);
console.log(`latency trigger→order-landed:  avg ${avg}ms · p95 ${p95}ms · max ${max}ms   (target <1000ms; ⚠ if higher)\n`);
