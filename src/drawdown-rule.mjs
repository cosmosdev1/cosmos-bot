// PER-ACCOUNT DRAWDOWN BREAKER - THE DECISION, pure (owner 2026-08-30 bounded correctness item).
// drawdown.mjs keeps the I/O (samples + latch on disk); this file decides. Not wired in until the
// replay evidence is approved.
//
// INTENDED TRUTH TABLE (the breaker protects capital that actually fell; it never latches an
// account that has no capital basis, and a latch lives exactly as long as its basis):
//   current $0, high $0                          -> no basis: halt = false
//   current < $50, every high in the window < $50 -> no basis (dust rule MIN_PORT): halt = false
//   newly funded $0 -> < $50                     -> no basis: halt = false (was: an old latch stuck forever)
//   newly funded $0 -> >= $50                    -> a fresh high; dd = 0: halt = false
//   high >= $50 and current > 30 % below it       -> TRIP: halt = true, latched with (trippedHigh, trippedAt)
//   latched, current >= 85 % of trippedHigh       -> real recovery: clear
//   latched, withdrawal to near zero              -> the latch stays while its basis is inside the
//                                                    window (a withdrawal is not a recovery)
//   latched, the tripping high aged out (> 12 h)  -> the basis is gone: clear (the rolling-window rule
//                                                    that the latch was only meant to stop from flapping)
//   restart while latched                         -> the same decision (trippedHigh/trippedAt persisted)
//   legacy latch without trippedAt/trippedHigh    -> basis = the max sample >= $50 in the window, if any;
//                                                    none -> no basis: clear
// What this deliberately does NOT do: treat "current < $50" as "clear" by itself - an account that
// fell from $500 to $30 stays halted until its basis ages out or it recovers.

export const DEFAULTS = Object.freeze({ WINDOW_MS: 12 * 3600e3, DD_TRIP: 0.30, DD_CLEAR: 0.85, MIN_PORT: 50 });

/**
 * decide(state, portfolio, now, cfg) -> { halt, high, dd, state', reason }
 * state = { samples: [{t, v}], tripped, trippedHigh?, trippedAt? }   (samples already include this cycle's value if > 0)
 */
export function decide(state, portfolio, now, cfg = DEFAULTS) {
  const samples = (state.samples || []).filter((x) => x && Number.isFinite(x.t) && x.t >= now - cfg.WINDOW_MS);
  const high = samples.reduce((m, x) => Math.max(m, x.v), 0);
  let tripped = state.tripped === true, trippedHigh = Number(state.trippedHigh) || 0, trippedAt = Number(state.trippedAt) || 0;
  // legacy latch: recover its basis from the window, or drop it
  if (tripped && !(trippedHigh >= cfg.MIN_PORT && trippedAt > 0)) {
    const basis = samples.filter((x) => x.v >= cfg.MIN_PORT).sort((a, b) => b.v - a.v)[0];
    if (basis) { trippedHigh = basis.v; trippedAt = basis.t; }
    else return { halt: false, high, dd: 0, reason: "legacy latch without a >= MIN_PORT basis in the window: cleared", state: { samples, tripped: false, trippedHigh: 0, trippedAt: 0 } };
  }
  const out = (halt, dd, reason) => ({ halt, high, dd, reason, state: { samples, tripped: halt, trippedHigh: halt ? trippedHigh : 0, trippedAt: halt ? trippedAt : 0 } });
  if (tripped) {
    if (now - trippedAt > cfg.WINDOW_MS) return out(false, 0, "tripping high aged out of the window: cleared");
    if (Number.isFinite(portfolio) && portfolio >= trippedHigh * cfg.DD_CLEAR) return out(false, 1 - portfolio / trippedHigh, "recovered to >= 85 % of the tripping high: cleared");
    return out(true, Number.isFinite(portfolio) && portfolio > 0 ? 1 - portfolio / trippedHigh : 1, "latched: below 85 % of the tripping high, basis inside the window");
  }
  if (!(high >= cfg.MIN_PORT) || !Number.isFinite(portfolio) || portfolio <= 0) return out(false, 0, "no basis (high under MIN_PORT or no portfolio)");
  const dd = 1 - portfolio / high;
  if (dd > cfg.DD_TRIP) { trippedHigh = high; trippedAt = now; return out(true, dd, "TRIP: > 30 % below the 12h high"); }
  return out(false, dd, "within the band");
}
