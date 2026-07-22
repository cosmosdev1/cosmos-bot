// PER-ACCOUNT DRAWDOWN BREAKER (2026-07-22) — server-independent. Complements the fleet-level breaker
// (a server cron enforcing "20% of accounts down >30% in 12h -> halt all"). This one needs no server
// at all: each bot tracks its OWN portfolio high-water mark over a rolling 12h window (persisted to
// /data so a 10-min code-update restart never resets the baseline), and halts its OWN entries while
// the portfolio sits more than DD_TRIP below that high. It is the individual case of the owner's rule,
// and it keeps protecting a user even if the server (and its fleet breaker) is compromised or down.
// Entries only — exits/TP/SL always run, so a tripped bot still manages open money.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WINDOW_MS = (Number(process.env.COSMOS_DD_WINDOW_H) || 12) * 3600e3;
const DD_TRIP = Math.min(Number(process.env.COSMOS_DD_TRIP_PCT) || 30, 90) / 100;   // halt while down > this fraction of the 12h high
const DD_CLEAR = 0.85;                                                              // resume once recovered above 85% of the high
const MIN_PORT = Number(process.env.COSMOS_DD_MIN_USD) || 50;                       // ignore dust accounts (noise, not a real drawdown)

const DIR = process.env.COSMOS_DATA_DIR ? process.env.COSMOS_DATA_DIR.replace(/\/$/, "") : join(homedir(), ".cosmos");
try { mkdirSync(DIR, { recursive: true }); } catch { /* best-effort */ }
const FILE = join(DIR, "drawdown.json");
let samples = []; try { samples = (JSON.parse(readFileSync(FILE, "utf8")).s || []).filter((x) => x && Number.isFinite(x.t)); } catch { /* fresh */ }
let tripped = false;

// Call once per cycle with the freshly-read portfolio value. Returns { halt, high, dd } and latches
// the trip so a brief bounce mid-crash doesn't flap entries back on until a real recovery (85%).
export function drawdownCheck(portfolio) {
  const now = Date.now();
  if (Number.isFinite(portfolio) && portfolio > 0) { samples.push({ t: now, v: portfolio }); }
  samples = samples.filter((x) => x.t >= now - WINDOW_MS);
  try { writeFileSync(FILE, JSON.stringify({ s: samples.slice(-800) })); } catch { /* best-effort */ }
  const high = samples.reduce((m, x) => Math.max(m, x.v), 0);
  if (!(high >= MIN_PORT) || !Number.isFinite(portfolio) || portfolio <= 0) return { halt: tripped, high, dd: 0 };
  const dd = 1 - portfolio / high;                       // fraction below the 12h high-water mark
  if (!tripped && dd > DD_TRIP) tripped = true;          // trip
  else if (tripped && portfolio >= high * DD_CLEAR) tripped = false; // clear only on real recovery
  return { halt: tripped, high, dd };
}
