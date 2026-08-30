// PER-ACCOUNT DRAWDOWN BREAKER (2026-07-22) — server-independent. Complements the fleet-level breaker
// (a server cron enforcing "20% of accounts down >30% in 12h -> halt all"). This one needs no server
// at all: each bot tracks its OWN portfolio high-water mark over a rolling 12h window (persisted to
// /data so a 10-min code-update restart never resets the baseline), and halts its OWN entries while
// the portfolio sits more than DD_TRIP below that high. It is the individual case of the owner's rule,
// and it keeps protecting a user even if the server (and its fleet breaker) is compromised or down.
// Entries only — exits/TP/SL always run, so a tripped bot still manages open money.
//
// CORRECTNESS FIX (owner-approved 2026-08-30): the decision moved to drawdown-rule.mjs (pure, tested
// against the truth table). A latch now exists only while its qualifying basis is valid: it carries
// (trippedHigh, trippedAt); it clears on >= 85 % recovery of THAT high or when that high ages out of
// the 12 h window; a high under MIN_PORT can neither create nor retain a latch. Before: a persisted
// latch was returned unchanged whenever the high was under $50 or the portfolio was 0, so 18 funded
// sub-$50 accounts and 7 empty ones stayed halted with no path to clear (replay of 173 files).
// LEGACY FILES are migrated explicitly, once, and the decision is recorded in the file.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decide, DEFAULTS } from "./drawdown-rule.mjs";

const CFG = Object.freeze({
  WINDOW_MS: (Number(process.env.COSMOS_DD_WINDOW_H) || 12) * 3600e3,
  DD_TRIP: Math.min(Number(process.env.COSMOS_DD_TRIP_PCT) || 30, 90) / 100,   // halt while down > this fraction of the 12h high
  DD_CLEAR: DEFAULTS.DD_CLEAR,                                                   // resume once recovered above 85% of the tripping high
  MIN_PORT: Number(process.env.COSMOS_DD_MIN_USD) || 50,                         // ignore dust accounts (noise, not a real drawdown)
});

const DIR = process.env.COSMOS_DATA_DIR ? process.env.COSMOS_DATA_DIR.replace(/\/$/, "") : join(homedir(), ".cosmos");
try { mkdirSync(DIR, { recursive: true }); } catch { /* best-effort */ }
const FILE = join(DIR, "drawdown.json");
let samples = []; let tripped = false; let trippedHigh = 0, trippedAt = 0; let migration = null; let lastReason = "";
try {
  const j = JSON.parse(readFileSync(FILE, "utf8"));
  samples = (j.s || []).filter((x) => x && Number.isFinite(x.t));
  tripped = j.tripped === true; trippedHigh = Number(j.trippedHigh) || 0; trippedAt = Number(j.trippedAt) || 0; migration = j.migration || null;
} catch { /* fresh */ }
const save = () => { try { writeFileSync(FILE, JSON.stringify({ s: samples.slice(-800), tripped, trippedHigh, trippedAt, migration })); } catch { /* best-effort */ } };

// LEGACY LATCH MIGRATION, once: a latch without (trippedHigh, trippedAt) has its basis reconstructed
// from the window's max >= MIN_PORT sample; none -> cleared. Recorded so the rollout can be audited.
if (tripped && !(trippedHigh >= CFG.MIN_PORT && trippedAt > 0) && !migration) {
  const now = Date.now();
  const r = decide({ samples, tripped, trippedHigh, trippedAt }, samples.length ? samples[samples.length - 1].v : 0, now, CFG);
  migration = { at: now, from: { tripped: true, samples: samples.length }, to: { halt: r.halt, trippedHigh: r.state.trippedHigh, trippedAt: r.state.trippedAt }, reason: r.reason, kind: r.halt ? "reconstructed" : "cleared-no-basis" };
  tripped = r.halt; trippedHigh = r.state.trippedHigh; trippedAt = r.state.trippedAt; lastReason = r.reason;
  save();
}

// Call once per cycle with the freshly-read portfolio value. Returns { halt, high, dd, reason } and
// latches the trip so a brief bounce mid-crash doesn't flap entries back on until a real recovery.
export function drawdownCheck(portfolio) {
  const now = Date.now();
  if (Number.isFinite(portfolio) && portfolio > 0) { samples.push({ t: now, v: portfolio }); }
  samples = samples.filter((x) => x.t >= now - CFG.WINDOW_MS);
  const r = decide({ samples, tripped, trippedHigh, trippedAt }, portfolio, now, CFG);
  tripped = r.halt; trippedHigh = r.state.trippedHigh; trippedAt = r.state.trippedAt; lastReason = r.reason;
  save();                                                // samples AND the latch (with its basis) survive restarts
  return { halt: r.halt, high: r.high, dd: r.dd, reason: r.reason };
}

/** For telemetry: the latch, its basis and the migration decision (if any). */
export function drawdownState() {
  return { halt: tripped, trippedHigh, trippedAt, reason: lastReason, migration };
}
