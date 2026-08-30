// STAGE 4 EXECUTION AUTHORITY (owner 2026-08-30, canary assertions 1 and the follow-up scoping check).
//
// One process, two paths can reach a buy: the chainwatch fast path (which for a canary whale executes
// on the shared Stage 4 evaluation) and the polled/adopt tick (which executes off the production
// copy_signals rows the old /copy-check writes). For a canary whale the Stage 4 result is THE execution
// authority, so the polled tick must not independently mint the same business intent.
//
// THE MARKER IS SCOPED TO THE DECIDED STATE, NOT TO THE MARKET. It means "the polled path must not act
// on THIS already-decided business event", never "this market is closed to the polled path". A marker
// therefore carries the whale's cumulative money-in as the production row will show it after the
// decision (cost, shares) plus the exit sequence, and the polled tick is suppressed only while the row
// it is looking at is NOT NEWER than what was decided:
//
//   * fill A decided -> the row A produced is suppressed (the duplicate this exists to prevent)
//   * fill B arrives and the fast path decides it -> the marker advances to B's state; B's row is
//     suppressed, and A's is irrelevant (the row only ever grows)
//   * fill B MISSED by the fast path -> the row now carries B's larger money-in, which is newer than
//     the marker, so the polled sweep is NOT suppressed and recovers B - the whole point of the sweep
//   * a mirror-sell (sell_seq advances) is newer too, so nothing about exits is ever suppressed
//   * a restart empties the map: nothing is suppressed, i.e. exactly today's behaviour (fail-open)
//   * a TTL bounds a stale marker even if no newer row ever appears
//
// Under-suppression is the safe direction (at worst the pre-canary behaviour); over-suppression would
// silently cost a legitimate entry, so every ambiguous case resolves to "not suppressed".

const canary = new Set();
const decided = new Map();              // `${cid}|${outcome}` -> { at, wallet, cost, shares, sellSeq }
const TTL_MS = Number(process.env.COSMOS_S4_AUTHORITY_TTL_MS) || 10 * 60_000;
// shares are quantised to 1e-6, so the epsilon must sit BELOW the smallest real increment: at 1e-6 a
// one-unit growth would have read as "not newer" and the sweep would have stayed suppressed on it.
const EPS = 1e-9;
let suppressed = 0, polledFallback = 0, advanced = 0;

const key = (cid, outcome) => `${String(cid || "").toLowerCase()}|${String(outcome || "").toLowerCase()}`;
const numOf = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export function setCanary(list) {
  const next = new Set((Array.isArray(list) ? list : []).map((w) => String(w || "").toLowerCase()).filter((w) => /^0x[a-f0-9]{40}$/.test(w)));
  let changed = next.size !== canary.size;
  if (!changed) for (const w of next) if (!canary.has(w)) { changed = true; break; }
  canary.clear(); for (const w of next) canary.add(w);
  return changed;
}
export const isCanary = (wallet) => canary.has(String(wallet || "").toLowerCase());
export const canaryCount = () => canary.size;

/**
 * The fast path decided this (market, side) for this whale - buy or no buy - at this state.
 * `state` is what the PRODUCTION ROW will carry after the decision (the old path's own answer is the
 * best source; the shared evaluation's ledger row is the fallback). Fields only ever ratchet up, so a
 * late, smaller report can never shrink the marker and re-open a suppression window.
 */
export function markDecided(cid, outcome, wallet, state = {}) {
  if (!cid || !outcome) return;
  const k = key(cid, outcome);
  const prev = decided.get(k);
  const next = {
    at: Date.now(), wallet: String(wallet || "").toLowerCase(),
    cost: Math.max(numOf(state.cost), prev?.cost ?? 0),
    shares: Math.max(numOf(state.shares), prev?.shares ?? 0),
    sellSeq: Math.max(numOf(state.sellSeq), prev?.sellSeq ?? 0),
  };
  if (prev && (next.cost > (prev.cost ?? 0) + EPS || next.shares > (prev.shares ?? 0) + EPS || next.sellSeq > (prev.sellSeq ?? 0))) advanced++;
  decided.set(k, next);
  if (decided.size > 4000) { const cut = Date.now() - TTL_MS; for (const [kk, v] of decided) if (v.at < cut) decided.delete(kk); }
}
/** the state a signal row (or a Stage 4 ledger row) represents */
export const stateOf = (row) => (row ? { cost: numOf(row.his_cost_usd), shares: numOf(row.his_shares), sellSeq: numOf(row.sell_seq) } : null);

/** is this exact decided state still owned by the fast path? (diagnostic / tests) */
export function decidedRecently(cid, outcome, state = null) {
  const d = decided.get(key(cid, outcome));
  if (!d || Date.now() - d.at >= TTL_MS) return false;
  if (!state) return true;
  return !(numOf(state.cost) > d.cost + EPS || numOf(state.shares) > d.shares + EPS || numOf(state.sellSeq) > d.sellSeq);
}

/**
 * The polled tick's question: may I act on this signal row?
 *   "suppress"  - a canary whale drives it AND the fast path decided exactly this state: Stage 4 owns it
 *   "fallback"  - a canary whale drives it but this state is NEWER than anything the fast path decided
 *                 (or nothing was ever decided, or the marker aged out): the sweep is the only recovery
 *                 there has ever been, so it proceeds - counted, because it means a missed fill
 *   "free"      - not a canary whale: unchanged behaviour
 */
export function polledVerdict(sig) {
  const driver = String(sig?.wallets?.[0]?.wallet || "").toLowerCase();
  if (!driver || !isCanary(driver)) return "free";
  if (decidedRecently(sig?.condition_id, sig?.outcome, stateOf(sig))) { suppressed++; return "suppress"; }
  polledFallback++; return "fallback";
}
export const authorityStats = () => ({ canary: canary.size, decided: decided.size, suppressed, polledFallback, advanced });
export function _resetForTests() { canary.clear(); decided.clear(); suppressed = 0; polledFallback = 0; advanced = 0; }
