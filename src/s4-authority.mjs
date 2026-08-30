// STAGE 4 EXECUTION AUTHORITY (owner 2026-08-30, canary assertion 1). One process, two paths that can
// reach a buy: the chainwatch fast path (which during the canary executes on the shared Stage 4
// evaluation) and the polled/adopt tick (which executes off the production copy_signals rows the old
// /copy-check writes). For a canary whale the Stage 4 result is THE execution authority, so the polled
// tick must not independently mint the same business intent.
//
// This module is the seam between them, and it is deliberately tiny and pure:
//   * `setCanary(list)` - the whales for which Stage 4 decides (from the roster, one cycle to change)
//   * `markDecided(cid, outcome, wallet)` - the fast path HAS decided this market for this whale, buy
//     or no buy; called for the Stage 4 answer AND for its bounded-wait fallback, because in both
//     cases exactly one path (this one) reached execution
//   * `decidedRecently(cid, outcome)` - the polled tick asks before entering or topping up
//
// A market the fast path never decided is NOT suppressed: that is the case where the log never
// reached this child (a stream hole) and the polled sweep is the only recovery there has ever been.
// Suppressing it there would trade a proven safety net for a property nobody asked for.

const canary = new Set();
const decided = new Map();              // `${cid}|${outcome}` -> { at, wallet }
const TTL_MS = Number(process.env.COSMOS_S4_AUTHORITY_TTL_MS) || 10 * 60_000;
let suppressed = 0, polledFallback = 0;

const key = (cid, outcome) => `${String(cid || "").toLowerCase()}|${String(outcome || "").toLowerCase()}`;

export function setCanary(list) {
  const next = new Set((Array.isArray(list) ? list : []).map((w) => String(w || "").toLowerCase()).filter((w) => /^0x[a-f0-9]{40}$/.test(w)));
  let changed = next.size !== canary.size;
  if (!changed) for (const w of next) if (!canary.has(w)) { changed = true; break; }
  canary.clear(); for (const w of next) canary.add(w);
  return changed;
}
export const isCanary = (wallet) => canary.has(String(wallet || "").toLowerCase());
export const canaryCount = () => canary.size;

/** the fast path decided this (market, side) for this whale - buy or no buy - so it owns the intent */
export function markDecided(cid, outcome, wallet) {
  if (!cid || !outcome) return;
  decided.set(key(cid, outcome), { at: Date.now(), wallet: String(wallet || "").toLowerCase() });
  if (decided.size > 4000) { const cut = Date.now() - TTL_MS; for (const [k, v] of decided) if (v.at < cut) decided.delete(k); }
}
/** has the fast path decided this (market, side) recently? */
export function decidedRecently(cid, outcome) {
  const v = decided.get(key(cid, outcome));
  return Boolean(v && Date.now() - v.at < TTL_MS);
}
/**
 * The polled tick's question: may I act on this signal row?
 *   "suppress"  - a canary whale drives it and the fast path already decided: Stage 4 owns it
 *   "fallback"  - a canary whale drives it and the fast path never saw it: the polled sweep is the
 *                 only path, exactly as before the canary (counted, because it means a missed fill)
 *   "free"      - not a canary whale: unchanged behaviour
 */
export function polledVerdict(sig) {
  const driver = String(sig?.wallets?.[0]?.wallet || "").toLowerCase();
  if (!driver || !isCanary(driver)) return "free";
  if (decidedRecently(sig.condition_id, sig.outcome)) { suppressed++; return "suppress"; }
  polledFallback++; return "fallback";
}
export const authorityStats = () => ({ canary: canary.size, decided: decided.size, suppressed, polledFallback });
export function _resetForTests() { canary.clear(); decided.clear(); suppressed = 0; polledFallback = 0; }
