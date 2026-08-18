// Verify Inc 1.12: does getMidpoints() return what primeMidpoints expects, and does the batch
// agree with the per-token reads it replaces? Read-only, no keys, no orders.
import { ClobClient, Chain } from "@polymarket/clob-client-v2";

const HOST = process.env.CLOB_HOST || "https://clob.polymarket.com";
const client = new ClobClient({ host: HOST, chain: Chain.POLYGON });

// A few live tokens straight from the public gamma feed (no auth needed).
const mkts = await fetch("https://gamma-api.polymarket.com/markets?closed=false&limit=6&order=volume24hr&ascending=false")
  .then((r) => r.json());
const ids = [];
for (const m of mkts ?? []) {
  try {
    const toks = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
    if (Array.isArray(toks) && toks[0]) ids.push(String(toks[0]));
  } catch { /* skip */ }
}
console.log(`testing ${ids.length} live tokens`);
if (ids.length < 2) { console.log("not enough live tokens - inconclusive"); process.exit(0); }

// 1. batch shape
const t0 = Date.now();
let batch = null, shape = "none";
try {
  batch = await client.getMidpoints(ids.map((token_id) => ({ token_id })));
  shape = Array.isArray(batch) ? "array" : typeof batch;
} catch (e) {
  console.log("getMidpoints threw:", e?.message ?? e);
}
const batchMs = Date.now() - t0;
console.log(`batch: shape=${shape} in ${batchMs}ms`);
if (batch && shape === "object") console.log(`  sample: ${JSON.stringify(Object.entries(batch).slice(0, 2))}`);
if (Array.isArray(batch)) console.log(`  sample: ${JSON.stringify(batch.slice(0, 2))}`);

// 2. parse exactly as primeMidpoints does
const parsed = new Map();
if (batch && !Array.isArray(batch) && typeof batch === "object") {
  for (const [k, v] of Object.entries(batch)) { const p = Number(v?.mid ?? v); if (p > 0) parsed.set(String(k), Math.round(p * 100)); }
} else if (Array.isArray(batch)) {
  for (const r of batch) { const p = Number(r?.mid ?? r?.price ?? 0); const id = String(r?.token_id ?? r?.asset_id ?? ""); if (id && p > 0) parsed.set(id, Math.round(p * 100)); }
}
console.log(`parsed ${parsed.size}/${ids.length} midpoints from the batch`);

// 3. agreement with the per-token call it replaces + latency comparison
const t1 = Date.now();
let agree = 0, checked = 0, diffs = [];
for (const id of ids) {
  try {
    const one = await client.getMidpoint(id);
    const cents = Math.round((Number(one?.mid ?? 0)) * 100);
    if (!cents) continue;
    checked++;
    const b = parsed.get(id);
    if (b == null) { diffs.push(`${id.slice(0, 10)}: missing from batch`); continue; }
    if (Math.abs(b - cents) <= 1) agree++; else diffs.push(`${id.slice(0, 10)}: batch ${b}c vs single ${cents}c`);
  } catch { /* skip */ }
}
const singlesMs = Date.now() - t1;
console.log(`agreement: ${agree}/${checked} within 1c ${agree === checked && checked > 0 ? "PASS" : "CHECK"}`);
for (const d of diffs.slice(0, 5)) console.log(`   ${d}`);
console.log(`latency: 1 batch call ${batchMs}ms vs ${checked} single calls ${singlesMs}ms (${(singlesMs / Math.max(batchMs, 1)).toFixed(1)}x)`);
console.log(parsed.size >= ids.length - 1 ? "VERDICT: batch usable - prime will populate the cache" : "VERDICT: batch incomplete - callers fall back to per-token reads (safe)");
