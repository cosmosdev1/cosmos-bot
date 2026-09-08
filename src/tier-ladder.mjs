// TIER LADDER + TOP-UP ARITHMETIC (owner ruling 2026-09-08). Pure, no I/O.
//
// Hosted production semantics:
//   tier ladder 6% / 5% / 4% (non-crypto), candles 3% / 2%   - the whale's OWN thresholds decide the band
//   bot per-position ceiling 6.5%                              - local clip; a full tier-1 6% executes under it
//   server per-condition hard cap 7%                           - the final backstop, untouched here
//   top-up = new tier target - current Cosmos-held position; under the $2 minimum there is no order
//   a whale ADD inside the same tier moves nothing; only an UPWARD tier crossing creates a top-up
// Legacy (self-hosted) bots keep their old numbers byte-for-byte: 5/4/3 and the 5% ceiling.
export const NC_PCTS_HOSTED = Object.freeze([6, 5, 4]);
export const NC_PCTS_LEGACY = Object.freeze([5, 4, 3]);
export const CANDLE_PCTS = Object.freeze([3, 2]);
export const POSITION_CEIL_PCT_HOSTED = 6.5;
export const POSITION_CEIL_PCT_LEGACY = 5;
export const SERVER_CONDITION_CAP_PCT = 7;   // documented here only; enforced in lib/cloud/risk.ts, never by the bot

/** The tier percent for a cumulative money-in against the whale's thresholds {t1_usd,t2_usd,t3_usd}; 0 below the lowest; null without thresholds. */
export function pctFromBands(cost, t, pcts) {
  if (!t) return null;
  const ladder = [t.t1_usd, t.t2_usd, t.t3_usd];
  for (let i = 0; i < pcts.length; i++) {
    const th = Number(ladder[i]);
    if (Number.isFinite(th) && Number(cost) >= th) return pcts[i];
  }
  return 0;
}

/**
 * The top-up for a position: target = pct% of the portfolio, clipped to the ceiling; add = target - held.
 * Returns { target, cap, add, order } where order = add >= floorUsd. Never lets held + add exceed the ceiling.
 */
export function topUp({ pct, portfolioUsd, heldUsd, ceilPct, floorUsd }) {
  const port = Number(portfolioUsd) || 0, held = Math.max(0, Number(heldUsd) || 0);
  const target = Math.max(0, (Number(pct) || 0) / 100 * port);
  const cap = (Number(ceilPct) || 0) / 100 * port;
  const add = Math.max(0, Math.min(target, cap) - held);
  return { target, cap, add, order: add >= (Number(floorUsd) || 0) && add > 0 };
}
