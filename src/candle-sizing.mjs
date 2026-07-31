// CRYPTO-CANDLE COPY SIZING — the two engines (owner spec 2026-07-31).
//
// Both answer one question: given how much of HIS usual size a whale now holds in a candle market,
// how much of OUR portfolio should we be holding?
//
//   ORIGINAL (tiered, cumulative)
//     baseline = his average $ per 15m crypto candle market over his last <=300 such trades.
//     He crosses 30% of that baseline -> we should hold 1.5% of our portfolio
//                60%                  -> 3.0%
//                90%                  -> 4.5%
//     TOP-UP, NOT ADDITIVE. Crossing 60% after already buying at 30% means buying the DIFFERENCE
//     (3.0 - 1.5 = 1.5), not another 3.0. This is the part that is easy to get wrong and expensive:
//     treating the tiers as additive would put 9% into a market the spec caps at 4.5%.
//
//   ONE-SHOT (current hosted behaviour)
//     He crosses 50% of baseline -> buy 2% of portfolio, once. Nothing further.
//     Exists because hosted signing costs real money per signature, so a 3-step ladder can cost
//     more than the 0.9% builder fee earns on a small position.
//
// Pure functions, no I/O, no clock — so the whole thing is testable without a live market, a
// signature, or a wallet. tools/dry-candle-sizing.mjs exercises them.

/** Tier table for the original engine: [fraction of his baseline, our % of portfolio]. */
export const TIERS = [
  [0.30, 1.5],
  [0.60, 3.0],
  [0.90, 4.5],
];

export const ONESHOT_TRIGGER = 0.50;   // he must cross 50% of baseline
export const ONESHOT_PCT = 2.0;        // and we take 2% of portfolio, once

/**
 * His typical size in a candle market: the mean $ per DISTINCT market across his most recent
 * candle trades (<=300, fewer if that is all he has).
 *
 * Per market, not per fill: he may scale into one candle over several buys, and averaging fills
 * would understate his real commitment and trigger us far too early. Sells are ignored — the
 * baseline is about how much he COMMITS, not net flow.
 */
export function avgCandleSize(trades, maxTrades = 300) {
  const recent = trades.slice(0, maxTrades);
  const byMarket = new Map();
  for (const t of recent) {
    if (String(t.side ?? "").toUpperCase() !== "BUY") continue;
    const k = String(t.conditionId ?? t.condition_id ?? "");
    if (!k) continue;
    byMarket.set(k, (byMarket.get(k) ?? 0) + Number(t.usdcSize ?? t.usdSize ?? 0));
  }
  if (!byMarket.size) return 0;
  let sum = 0;
  for (const v of byMarket.values()) sum += v;
  return sum / byMarket.size;
}

/**
 * What we should HOLD (as a % of our portfolio) given his current holding in this market.
 * Returns the tier target, or 0 below the first tier.
 */
export function targetPctForHolding(hisUsd, baselineUsd, { oneShot = false } = {}) {
  if (!(baselineUsd > 0) || !(hisUsd > 0)) return 0;
  const ratio = hisUsd / baselineUsd;
  if (oneShot) return ratio >= ONESHOT_TRIGGER ? ONESHOT_PCT : 0;
  let pct = 0;
  for (const [frac, target] of TIERS) if (ratio >= frac) pct = target;
  return pct;
}

/**
 * The actual order: how much MORE to buy, in dollars.
 *
 * `ourUsd` is what we already hold in this market. The top-up is the gap to the tier target, so a
 * whale climbing 30% -> 60% -> 90% produces 1.5% -> +1.5% -> +1.5% of portfolio, never 1.5 + 3 + 4.5.
 *
 * One-shot never tops up: once we hold anything, later crossings are ignored. That is the whole
 * point of it — one signature per position.
 */
export function topUpUsd({ hisUsd, baselineUsd, portfolioUsd, ourUsd = 0, oneShot = false, minOrderUsd = 1 }) {
  const targetPct = targetPctForHolding(hisUsd, baselineUsd, { oneShot });
  if (!targetPct) return { buyUsd: 0, targetPct: 0, reason: "below trigger" };
  if (oneShot && ourUsd > 0) return { buyUsd: 0, targetPct, reason: "one-shot already filled" };

  const targetUsd = (portfolioUsd * targetPct) / 100;
  const gap = targetUsd - ourUsd;
  if (gap <= 0) return { buyUsd: 0, targetPct, reason: "already at target" };
  // Below the exchange minimum an order is not a small trade, it is NO trade — and attempting it
  // burns a signature for a guaranteed rejection.
  if (gap < minOrderUsd) return { buyUsd: 0, targetPct, reason: `gap ${gap.toFixed(2)} under the $${minOrderUsd} minimum` };
  return { buyUsd: gap, targetPct, reason: `top up to ${targetPct}%` };
}

/**
 * Has his holding crossed a tier we have not acted on yet? The watcher calls this on every position
 * update; it is the trigger, and it must be cheap because it runs constantly.
 */
export function crossedNewTier({ hisUsd, baselineUsd, ourPctHeld = 0, oneShot = false }) {
  const target = targetPctForHolding(hisUsd, baselineUsd, { oneShot });
  return target > 0 && target > ourPctHeld + 1e-9;
}
