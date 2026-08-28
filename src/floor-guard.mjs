// STAGE 2G - ENTRY FLOOR GUARD, the pure verdict. Side-effect free so the platform's test can
// import it without starting a bot.
//
// WHY THE BOT'S OWN PORTFOLIO NUMBER CANNOT BE USED HERE. The bot values its positions at
// max(Polymarket /value, cost basis) - deliberately, so a flaky /value read never sizes a funded
// account off nothing. The sign gate values them at /value alone: max(onchain, clob) + /value.
// When positions have lost money the two diverge, and in the 2E window ONE account carried that
// divergence to 723 refusals in 2.5h: its bot believed $64.19 (cash 13.24 + cost 50.95) while the
// gate read $28.80 (cash 13.24 + marked 15.89). The bot's own $55 floor check passed every time,
// so it asked every ~20s and was refused every ~20s. This guard therefore recomputes the GATE's
// composition from parts the bot already holds - cash and the raw /value - and never touches the
// number sizing uses.
//
// THE INVARIANT: local deny must imply server deny (LOCAL DENY / SERVER ALLOW = 0). Three things
// protect it. The threshold is the gate's ACTUAL rule, `portfolio < MIN_PORTFOLIO_USD - 5` = $50,
// not the $55 product copy - Stage 2C measured a $55 local floor killing 31 server-allowed buys in
// a day. A margin is subtracted below that, so the bot only refuses what the gate would refuse by
// a clear distance, and the tolerance band stays the server's to judge. And every uncertain input
// FAILS OPEN: no cash, no /value, a stale cycle, or anything non-finite means "unknown", and an
// unknown never suppresses a buy that might be legitimate.
export const DEFAULTS = Object.freeze({
  GATE_FLOOR_USD: 50,     // MIN_PORTFOLIO_USD (55) - 5, the line the gate actually refuses at
  MARGIN_USD: 2,          // local refuses only below floor - margin; the band above is the server's
  MAX_AGE_MS: 180_000,    // a portfolio older than this is unknown, not a verdict
});

function num(v, fallback) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : fallback; }

/**
 * @param {object} s  { cash, pmValue, portfolioAt, now, env }
 *   cash        the bot's cash read (max of on-chain and CLOB, same rule as the gate), or null
 *   pmValue     the raw Polymarket /value for the funder (open positions marked to market), or null
 *   portfolioAt ms timestamp of the cycle that produced them, or null before the first cycle
 * @returns {{ verdict: "deny"|"allow"|"unknown", gateLike: number|null, line: number, reason: string }}
 */
export function floorGuardVerdict({ cash, pmValue, portfolioAt, now = Date.now(), env = {} }) {
  const floor = num(env.COPY_2G_GATE_FLOOR_USD, DEFAULTS.GATE_FLOOR_USD);
  const margin = num(env.COPY_2G_MARGIN_USD, DEFAULTS.MARGIN_USD);
  const maxAge = num(env.COPY_2G_MAX_AGE_MS, DEFAULTS.MAX_AGE_MS);
  const line = floor - margin;
  const c = Number(cash), v = Number(pmValue);
  if (cash == null || !Number.isFinite(c) || c < 0) return { verdict: "unknown", gateLike: null, line, reason: "no cash read" };
  if (pmValue == null || !Number.isFinite(v) || v < 0) return { verdict: "unknown", gateLike: null, line, reason: "no /value read" };
  if (!Number.isFinite(Number(portfolioAt)) || now - Number(portfolioAt) > maxAge) return { verdict: "unknown", gateLike: null, line, reason: "portfolio stale" };
  const gateLike = c + v;
  if (!Number.isFinite(gateLike)) return { verdict: "unknown", gateLike: null, line, reason: "non-finite" };
  return gateLike < line
    ? { verdict: "deny", gateLike, line, reason: `gate-like $${gateLike.toFixed(2)} under $${line}` }
    : { verdict: "allow", gateLike, line, reason: gateLike < floor ? "tolerance band - server decides" : "above floor" };
}
