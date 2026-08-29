// STAGE 1 INSTRUMENTATION CORE.
//
// The explicit design constraint is "must not become another scan_runs". scan_runs reached 3.5M rows
// by writing one row per event; this module never writes anything per event. It holds a FIXED set of
// integer counters in memory, and the process that owns it flushes ONE aggregate per minute.
//
// CARDINALITY IS CONSTANT BY CONSTRUCTION. Keys come from the frozen KEYS list below - inc() on an
// unknown key is ignored rather than creating a series. That is the property that stops a metrics
// system growing without bound, and it is why there is no label/tag support here: a per-wallet or
// per-market label would reintroduce exactly the unbounded cardinality this exists to avoid.
//
// Histograms use FIXED BUCKETS, not reservoirs: bounded memory, no allocation per observation, and
// percentiles that are approximate but stable. Latency here is used to detect a regression of tens
// of percent, not to bill anyone, so bucket precision is ample.

export const KEYS = Object.freeze([
  "ev",        // chain events this CHILD was handed (summed across children = delivery fan-out)
  "hubEv",     // DISTINCT chain events the hub received - runner only, the multiplier's denominator
  "cc",        // /v1/copy-check calls actually issued        <- fan-out numerator
  "ccFail",    // copy-check calls that threw after retries
  "sig",       // signals seen in the copy feed
  "skip",      // signals skipped by the hub shortcut (not enterable)
  "open",      // entry attempts made
  "add",       // top-up attempts made
  "fill",      // fills observed
  "deny",      // order attempts refused by the platform gate
  "reap",      // orphan processes reaped (runner only)
  // STAGE 4 SHADOW (2026-08-29) - fixed cardinality like everything above. Hub side:
  "s4EvalAttempt", // /fill-eval HTTP attempts, retries included
  "s4EvalOk",      // successful responses
  "s4EvalFull",    // responses where the server computed fresh (existed=false) - the <=1.05x counter
  "s4EvalDup",     // responses where the server already had it (existed=true)
  "s4EvalFail",    // attempts exhausted
  "s4Overflow",    // fills the shadow queue refused (full / too old) - would be raw-log fallback live
  "s4Sent",        // neutral results broadcast (per child delivery = s4Sent x children)
  // child side:
  "s4Recv", "s4Gap", "s4Replay", "s4Late",
  "s4Match", "s4Expected", "s4OldBug", "s4NewBug", "s4TimingSame", "s4TimingFlip", "s4OldMissing", "s4NewMissing", "s4Unknown",
  "s4OldBugShare", "s4OldBugCost", "s4OldBugPeak",   // the frozen OLD_PATH_BUG taxonomy, one counter each
]);

// signal -> order latency, milliseconds. Upper bound of each bucket.
const BUCKETS = Object.freeze([50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, Infinity]);

function blank() {
  const c = Object.create(null);
  for (const k of KEYS) c[k] = 0;
  return c;
}

let counters = blank();
let hist = new Array(BUCKETS.length).fill(0);
let histSum = 0, histN = 0;

/** Add to a counter. An unknown key is IGNORED - that is what keeps cardinality fixed. */
export function inc(key, n = 1) {
  // TOTAL BY CONSTRUCTION. These calls sit inside the try that wraps copyCheck in the trading path,
  // so a throw here would be caught and misread as a failed copy-check - instrumentation turning
  // itself into a trade decision. Number(Symbol) and Number(null-prototype object) both throw during
  // conversion, and `key in obj` throws for a key that cannot become a primitive, so both are guarded
  // rather than assumed. Unreachable from today's call sites; guarded so a future one cannot regress it.
  if (typeof key !== "string") return false;
  if (!(key in counters)) return false;
  let v;
  try { v = Number(n); } catch { return false; }
  if (!Number.isFinite(v)) return false;
  counters[key] += v;
  return true;
}

/** Record a latency observation in milliseconds. */
export function observe(ms) {
  let v;
  try { v = Number(ms); } catch { return false; }        // Symbol / null-prototype object
  if (!Number.isFinite(v) || v < 0) return false;
  for (let i = 0; i < BUCKETS.length; i++) {
    if (v <= BUCKETS[i]) { hist[i]++; break; }
  }
  histSum += v; histN++;
  return true;
}

/** Approximate percentile from the fixed buckets. Returns null when nothing was observed. */
function pct(p) {
  if (histN === 0) return null;
  const target = Math.ceil(histN * p);
  let seen = 0;
  for (let i = 0; i < BUCKETS.length; i++) {
    seen += hist[i];
    if (seen >= target) return BUCKETS[i] === Infinity ? BUCKETS[i - 1] : BUCKETS[i];
  }
  return BUCKETS[BUCKETS.length - 2];
}

/**
 * Read counters and RESET. Delta semantics on purpose: the consumer sums deltas across children, so
 * a lost flush costs one interval of data and never double-counts. Cumulative values would double
 * count on every retry and drift permanently after a restart.
 */
export function snapshot() {
  const out = { ...counters };
  if (histN > 0) out.lat = { n: histN, avg: Math.round(histSum / histN), p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) };
  counters = blank();
  hist = new Array(BUCKETS.length).fill(0);
  histSum = 0; histN = 0;
  return out;
}

/** Merge a child's delta into an aggregate. Unknown keys are dropped, so a bad child cannot inflate cardinality. */
export function merge(into, delta) {
  for (const k of KEYS) {
    let v;
    try { v = Number(delta?.[k]); } catch { continue; }   // a child could send anything
    if (Number.isFinite(v)) into[k] = (into[k] || 0) + v;
  }
  const l = delta?.lat;
  if (l && Number.isFinite(Number(l.n)) && Number(l.n) > 0) {
    const n = Number(l.n);
    into.lat = into.lat || { n: 0, sum: 0, p50: 0, p95: 0, p99: 0 };
    into.lat.n += n;
    into.lat.sum += (Number(l.avg) || 0) * n;
    // percentiles across children are approximated by the worst child seen - deliberately
    // pessimistic, because an optimistic latency number would hide the regression we watch for
    for (const q of ["p50", "p95", "p99"]) into.lat[q] = Math.max(into.lat[q] || 0, Number(l[q]) || 0);
  }
  return into;
}

export function emptyAggregate() { return blank(); }
