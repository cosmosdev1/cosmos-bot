// COPY SIZING — pure functions, no I/O. Tests: tools/dry-tier-sizing.mjs.
//
// TWO REGIMES, both anchored to the whale's own trade-size distribution (server-computed in
// engine.ts autoTiersFromCosts, stored on copy_wallets.auto_tiers, embedded per-signal in
// wallets[0].auto_tiers):
//
//   * ONE-SHOT (live, hosted): continuous linear on anchor_usd = his p95.
//     pct = min(6, 6 * his_usd / anchor). One entry, one signature. UNTOUCHED by the 20-tier spec.
//   * 20-TIER LADDER (the non-one-shot strategy, owner 2026-08-02): anchor = the AVERAGE OF HIS
//     TOP-10% trades -> that amount maps to the 5% per-trade cap. Twenty equal tiers of 0.25%
//     keep ONE ratio the whole way (the owner's mirroring rule: user-to-whale ratio identical
//     across all tiers): tier k = k * 0.25% of OUR portfolio <-> k * (top10avg/20) of HIS money.
//     The $1 exchange floor truncates from below ($100 portfolio -> first tier 1%; $300 -> 0.5%;
//     $400+ -> 0.25%). Ratio recomputed daily as the portfolio moves (the caller passes today's
//     portfolio; the whale side refreshes with the sweep).
//
// Crypto candles are NEITHER — candle-sizing.mjs, deliberately untouched (owner: "for crypto it
// stays the same").

// Polymarket rejects an order under ~$1. The exchange's floor, not a preference.
export const MIN_ORDER_USD = 1;

// ---- one-shot (live) ----
export const ONESHOT_CAP_PCT = 6;

/**
 * One-shot resolver. { anchor_usd } -> continuous linear pct (cap 6). Legacy [{min_usd, pct}]
 * band arrays still resolve step-wise so an in-flight signal can never crash sizing.
 * null = no usable data -> caller falls back to the flat legacy path.
 */
export function pctFromAutoTiers(bands, hisUsd, cap = ONESHOT_CAP_PCT) {
  if (!(hisUsd > 0)) return null;
  const anchor = Number(bands?.anchor_usd);
  if (Number.isFinite(anchor) && anchor >= 1) return Math.min(cap, (cap * hisUsd) / anchor);
  if (!Array.isArray(bands) || !bands.length) return null;
  let pct = 0, parsed = false;
  for (const b of bands) {
    const min = Number(b?.min_usd), p = Number(b?.pct);
    if (!Number.isFinite(min) || !Number.isFinite(p)) continue;
    parsed = true;
    if (hisUsd >= min && p > pct) pct = p;
  }
  return parsed ? pct : null;
}

// ---- the 20-tier ladder (non-one-shot) ----
export const LADDER_CAP_PCT = 5;         // his top-10% average bet = 5% of our portfolio
export const LADDER_TIERS = 20;          // equal steps of 0.25%
export const LADDER_STEP_PCT = LADDER_CAP_PCT / LADDER_TIERS;

/**
 * The TOTAL to hold (never a top-up — the caller diffs against what we already own).
 *
 * @param {object} a
 * @param {number} a.hisUsd       his money-in on THIS market
 * @param {number} a.top10AvgUsd  average of his top-10% trade sizes (server, refreshed daily)
 * @param {number} a.portfolio    the user's CURRENT portfolio (so the ratio tracks it daily)
 * @returns {{target:number, pct:number, tier:number, ratio:number}} target 0 = no trade.
 *          ratio = whale dollars per 1 user dollar at the cap (constant across all tiers).
 */
export function twentyTierTarget({ hisUsd, top10AvgUsd, portfolio }) {
  const none = { target: 0, pct: 0, tier: 0, ratio: 0 };
  if (!(portfolio > 0) || !(hisUsd > 0) || !(top10AvgUsd > 0)) return none;

  // The single mirroring ratio: at his top-10% average we stand at the 5% cap, and every tier
  // below scales with the SAME constant (owner: "stay in the same ratio during all the tiers").
  const capUsd = (portfolio * LADDER_CAP_PCT) / 100;
  const ratio = top10AvgUsd / capUsd;                     // his $ per our $1

  const rawPct = Math.min(LADDER_CAP_PCT, (LADDER_CAP_PCT * hisUsd) / top10AvgUsd);
  // Quantize to the 20 tiers, NEAREST step: max deviation from the exact ratio is half a step
  // (0.125pp) — the "really small deviation" the owner allowed. Round-half-up.
  const tier = Math.min(LADDER_TIERS, Math.round(rawPct / LADDER_STEP_PCT + 1e-9));
  if (tier <= 0) return { ...none, ratio };
  const pct = tier * LADDER_STEP_PCT;
  const target = (portfolio * pct) / 100;
  // The $1 exchange floor. NOT bumped up to $1 — that would break the ratio on exactly the
  // smallest copies. Skipping keeps every placed order on the constant ratio.
  if (target < MIN_ORDER_USD) return { target: 0, pct, tier, ratio };
  return { target, pct, tier, ratio };
}

/** First expressible tier for a portfolio (drives the dashboard "$150+" hint; derived, not asserted). */
export function firstTier(portfolio) {
  if (!(portfolio > 0)) return 0;
  for (let k = 1; k <= LADDER_TIERS; k++) {
    if ((portfolio * k * LADDER_STEP_PCT) / 100 >= MIN_ORDER_USD) return k;
  }
  return 0;
}
