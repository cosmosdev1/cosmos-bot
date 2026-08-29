// STAGE 4 SHADOW - the discrepancy classifier. PURE: no I/O, no state, importable by the platform's
// tests. A child calls classify() once per fill it saw on BOTH paths (or timed out waiting), with
// its OWN per-user context, and reports a class. Nothing here can act - the caller only counts.
//
// The three things kept apart, by name, throughout:
//   OLD PATH RESULT          what /v1/copy-check answered THIS child (authoritative today)
//   NEW SHADOW RESULT        what the neutral result + this child's own context would have given
//   INTENDED BUSINESS RULE   the ledger semantics (contribute once, cap once) - compared separately
//
// CLASSES. MATCH; EXPECTED (only from the fixed allow-list below, each with its evidence test);
// OLD_PATH_BUG (fixed allow-list, each with a recomputation that must hold); NEW_PATH_BUG;
// TIMING_SAME (different market snapshot, same decision); TIMING_FLIPPED (different snapshot,
// different decision - investigated, never excused); OLD_MISSING / NEW_MISSING (one side never
// arrived); UNKNOWN (everything else - must be zero to advance).
//
// REVISIONS FROM THE FIRST SHADOW HOUR (2026-08-29), each backed by production samples:
//   - the old route prints "conflict: opposite side bigger" for the another-whale-drives case as
//     well (route.ts: both paths states.delete the track and fall through to the same message), so
//     that pair is a labelling difference, not a decision difference -> EXPECTED with evidence;
//   - the price gate is worded "<n>c outside <a>-<b>c" and the two paths can sit on different sides
//     of it from different book snapshots -> TIMING (SAME when both skipped, FLIPPED otherwise);
//   - the accumulate divergence appears in BOTH directions: the child (an early follower) may read
//     the row before others wrote it while the shared evaluation reads it already inflated and
//     clamped to the chain. The evidence rule is therefore symmetric.

/** EXPECTED discrepancies: per-user server reasons the shadow does not model, and old-path labels. */
export const EXPECTED_ALLOW = Object.freeze({
  // the old route answered a per-user reason; the child's own context agrees it would not enter
  "old:copytrade is off for this account":       (ctx) => ctx.copytrade !== true,
  "old:wallet not in your copy list":            (ctx) => !ctx.followsWallet,
  "old:diamond access expired":                  (ctx) => ctx.diamondBlocked === true,
  "old:only 15-minute and hourly candles are copied": (ctx, o, n) => n?.candle?.isCandle === true && !n?.candle?.classV2,
  "old:wallet not in your track":                (ctx, o, n) => Array.isArray(n?.WHALE_TRACK_MEMBERSHIPS) && !n.WHALE_TRACK_MEMBERSHIPS.includes(ctx.group),
  // the old path exhausted its retries (the measured 8.17%); the shared path answered. Counted, never folded into MATCH.
  "old:copy-check failed":                       () => true,
  // the child was in its 60 s stand-down after three failures and never asked; the shared path answered
  "old:stand-down":                              () => true,
  // OLD-PATH LABEL: the route says "conflict" when another whale drives the track (same states.delete
  // path, same message). Evidence: the neutral result's track for this child is dropped for drivers.
  "old:conflict: opposite side bigger":          (ctx, o, n, t) => t?.old?.dropped === "drivers",
});

/** OLD PATH BUGS: each entry is a recomputation that must hold for the class to be assigned. */
export const OLD_BUG_ALLOW = Object.freeze({
  // The per-track accumulate re-adds this fill for every follower that reads a row an earlier
  // follower already rewrote (docs/stage4-design-addendum.md §1). Evidence, SYMMETRIC: the two
  // sides differ by an integer multiple of THIS fill's shares (either direction), or one side sits
  // at the on-chain clamp while the other does not. Identity (cid/outcome/group) must already agree.
  ACCUMULATE_DIVERGENCE: (o, n, t) => {
    const oldRow = t?.old?.row, led = t?.ledger?.row; if (!oldRow || !led || !o?.signal) return false;
    const fillSh = Number(n?.sharesUsed) || 0; if (!(fillSh > 0)) return false;
    const childSh = Number(o.signal.his_shares) || 0, sharedSh = Number(oldRow.his_shares) || 0;
    const dSh = Math.abs(childSh - sharedSh);
    const k = dSh / fillSh;
    const multiple = dSh > 0.5 && Math.abs(k - Math.round(k)) < 0.05 && Math.round(k) >= 1;
    const chain = n?.onchainShares != null ? Number(n.onchainShares) : null;
    const atClamp = chain != null && (Math.abs(childSh - chain) < 0.5 || Math.abs(sharedSh - chain) < 0.5) && dSh > 0.5;
    if (multiple || atClamp || (t?.ledger?.clampedByChain === true && dSh > 0.5)) return true;
    // COST-SCALING VARIANT (production, 2026-08-29 19:30Z+): both sides hold the SAME share count -
    // the chain clamp - but different costs (child $109, shared $141, ledger $179 for 209.2 sh),
    // because each follower's clamp rescaled a cost that earlier followers had already inflated.
    // Evidence: shares equal, at the chain holding, cost differs.
    const sameSh = dSh <= 0.5, costDiff = Math.abs((Number(o.signal.his_cost_usd) || 0) - (Number(oldRow.his_cost_usd) || 0)) > 0.5;
    const atChain = chain != null ? Math.abs(childSh - chain) < 0.5 : t?.ledger?.clampedByChain === true;
    return sameSh && costDiff && atChain;
  },
});

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const PRICE_GATE = /^\d+c outside \d+-\d+c$/;
const MARKET_STATE = /no live book|no asks|market closed|market not found|runway|whale holds none/;

/** Digest of the fields fastOpen consumes, so two rows compare on what matters. */
export function signalDigest(sig) {
  if (!sig) return null;
  return {
    cid: String(sig.condition_id ?? ""), outcome: String(sig.outcome ?? ""), group: num(sig.group_id),
    cost: num(sig.his_cost_usd), shares: num(sig.his_shares), peak: num(sig.his_peak_shares),
    cents: num(sig.entry_cents), maxc: num(sig.max_entry_cents), tier: num(sig.tier_pct_resolved),
    pair: Boolean(sig.is_pair), end: sig.end_date ?? null,
  };
}

/**
 * Apply THIS child's per-user context to the neutral result: which track row would it use, and
 * would its own per-user gates (copytrade armed, follows wallet, hosted/self horizon variant,
 * v2 candle class) let it through. Returns { ok, reason, signal, track }.
 */
export function newPathForChild(neutral, ctx) {
  if (!neutral) return { ok: false, reason: "no neutral" };
  if (ctx.copytrade !== true) return { ok: false, reason: "copytrade is off for this account" };
  if (!ctx.followsWallet) return { ok: false, reason: "wallet not in your copy list" };
  if (ctx.diamondBlocked) return { ok: false, reason: "diamond access expired" };
  if (neutral.verdict !== "ROWS") return { ok: false, reason: neutral.skipReason || "skip" };
  if (ctx.v2 && neutral.candle?.isCandle && !neutral.candle?.classV2) return { ok: false, reason: "only 15-minute and hourly candles are copied" };
  const t = (neutral.tracks || []).find((x) => Number(x.group_id) === Number(ctx.group));
  if (!t) return { ok: false, reason: "wallet not in your track" };
  const eligible = ctx.hosted ? t.eligibleHosted : t.eligibleSelf;
  if (!eligible) return { ok: false, reason: "resolves beyond your track's horizon", track: t };
  if (t.old.exited) return { ok: false, reason: "already exited: no rebuy after an exit", track: t };
  if (t.old.dropped) return { ok: false, reason: t.old.dropped === "drivers" ? "another whale drives this track" : "conflict: opposite side bigger", track: t };
  return { ok: true, signal: t.old.row, track: t };
}

/**
 * classify(old, neutral, ctx) -> { cls, sub, detail }
 *   old     { ok, reason?, signal? }  the child's own /v1/copy-check answer, or null if it never arrived
 *   neutral the shared result, or null if it never arrived
 *   ctx     { copytrade, followsWallet, diamondBlocked, hosted, v2, group }
 */
export function classify(old, neutral, ctx) {
  if (!old && !neutral) return { cls: "UNKNOWN", sub: "both missing" };
  if (!old) return { cls: "OLD_MISSING", sub: null };
  if (!neutral) return { cls: "NEW_MISSING", sub: null };
  const nw = newPathForChild(neutral, ctx);
  const t = nw.track;
  if (old.ok && nw.ok) {
    const a = signalDigest(old.signal), b = signalDigest(nw.signal);
    const same = a && b && a.cid === b.cid && a.outcome === b.outcome && a.group === b.group && a.cost === b.cost && a.shares === b.shares && a.peak === b.peak && a.cents === b.cents && a.tier === b.tier;
    if (same) return { cls: "MATCH", sub: null };
    if (a.cid !== b.cid || a.outcome !== b.outcome || a.group !== b.group) return { cls: "NEW_PATH_BUG", sub: "identity", detail: { a, b } };
    if (OLD_BUG_ALLOW.ACCUMULATE_DIVERGENCE(old, neutral, t)) return { cls: "OLD_PATH_BUG", sub: "ACCUMULATE_DIVERGENCE", detail: { a, b, ledger: signalDigest(t?.ledger?.row) } };
    // same decision, price moved between the two book snapshots: only the price-derived fields differ
    const priceOnly = a.shares === b.shares && a.peak === b.peak && a.cents !== b.cents;
    if (priceOnly) return { cls: "TIMING_SAME", sub: "book", detail: { a, b } };
    return { cls: "UNKNOWN", sub: "field mismatch", detail: { a, b, ledger: signalDigest(t?.ledger?.row) } };
  }
  if (!old.ok && !nw.ok) {
    const r = String(old.reason || ""), s = String(nw.reason || "");
    const key = "old:" + r;
    if (EXPECTED_ALLOW[key] && EXPECTED_ALLOW[key](ctx, old, neutral, t)) return { cls: "EXPECTED", sub: key };
    if (r === s) return { cls: "MATCH", sub: "skip:" + r };
    if (PRICE_GATE.test(r) && PRICE_GATE.test(s)) return { cls: "TIMING_SAME", sub: "price-gate", detail: { old: r, nw: s } };
    if ((MARKET_STATE.test(r) || PRICE_GATE.test(r)) && (MARKET_STATE.test(s) || PRICE_GATE.test(s))) return { cls: "TIMING_SAME", sub: "skip-reason", detail: { old: r, nw: s } };
    return { cls: "UNKNOWN", sub: "skip-reason", detail: { old: r, nw: s } };
  }
  // one entered, one did not
  const r = String((old.ok ? nw.reason : old.reason) || "");
  const key = "old:" + r;
  if (!old.ok && EXPECTED_ALLOW[key] && EXPECTED_ALLOW[key](ctx, old, neutral, t)) return { cls: "EXPECTED", sub: key };
  if (PRICE_GATE.test(r) || MARKET_STATE.test(r)) return { cls: "TIMING_FLIPPED", sub: r, detail: { oldOk: old.ok, nwOk: nw.ok } };
  return { cls: "UNKNOWN", sub: "decision flipped: " + r, detail: { oldOk: old.ok, nwOk: nw.ok } };
}

/** The ledger-vs-intended check, independent of the old path: what the shadow state says the row IS. */
export function ledgerCheck(t, neutral) {
  if (!t?.ledger?.state || !neutral) return null;
  const c = t.ledger.contrib, s = t.ledger.state;
  return { contribOnce: c && c.fill_id === neutral.fillId, cappedOnce: t.ledger.clampedByChain, shares: s.sh, cost: s.cost, peak: s.peak };
}
