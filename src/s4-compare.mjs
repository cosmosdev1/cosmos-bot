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

/** EXPECTED discrepancies: per-user server reasons the shadow does not model, and dead rules. */
export const EXPECTED_ALLOW = Object.freeze({
  // the old route answered a per-user reason; the child's own context agrees it would not enter
  "old:copytrade is off for this account":       (ctx) => ctx.copytrade !== true,
  "old:wallet not in your copy list":            (ctx) => !ctx.followsWallet,
  "old:diamond access expired":                  (ctx) => ctx.diamondBlocked === true,
  "old:only 15-minute and hourly candles are copied": (ctx, o, n) => n?.candle?.isCandle === true && !n?.candle?.classV2,
  "old:wallet not in your track":                (ctx, o, n) => Array.isArray(n?.WHALE_TRACK_MEMBERSHIPS) && !n.WHALE_TRACK_MEMBERSHIPS.includes(ctx.group),
  // the old path exhausted its retries (the measured 8.17%); the shared path answered. Counted, never folded into MATCH.
  "old:copy-check failed":                       () => true,
});

/** OLD PATH BUGS: each entry is a recomputation that must hold for the class to be assigned. */
export const OLD_BUG_ALLOW = Object.freeze({
  // The per-track accumulate re-adds this fill for every follower that reads a row an earlier
  // follower already rewrote (docs/stage4-design-addendum.md §1). Evidence: the old cost/shares
  // exceed the shared old-semantics row by a multiple of THIS fill's contribution, or sit at the
  // on-chain clamp; and the ledger value is what the intended rule gives.
  ACCUMULATE_DIVERGENCE: (o, n, t) => {
    const oldRow = t?.old?.row, led = t?.ledger?.row; if (!oldRow || !led || !o?.signal) return false;
    const fillSh = Number(n?.sharesUsed) || 0; if (!(fillSh > 0)) return false;
    const dSh = (Number(o.signal.his_shares) || 0) - (Number(oldRow.his_shares) || 0);
    const k = dSh / fillSh;
    const extraAdds = dSh > 0.5 && Math.abs(k - Math.round(k)) < 0.05 && Math.round(k) >= 1;
    const clamped = t?.ledger?.clampedByChain === true || (n?.onchainShares != null && Math.abs((Number(o.signal.his_shares) || 0) - Number(n.onchainShares)) < 0.5);
    return extraAdds || clamped;
  },
});

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

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
 * v2 candle class) let it through. Returns { ok, reason, signal }.
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
  if (!eligible) return { ok: false, reason: "resolves beyond your track's horizon" };
  if (t.old.exited) return { ok: false, reason: "already exited: no rebuy after an exit" };
  if (t.old.dropped) return { ok: false, reason: t.old.dropped === "drivers" ? "another whale drives this track" : "conflict: opposite side bigger" };
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
  // decisions
  if (old.ok && nw.ok) {
    const a = signalDigest(old.signal), b = signalDigest(nw.signal);
    const same = a && b && a.cid === b.cid && a.outcome === b.outcome && a.group === b.group && a.cost === b.cost && a.shares === b.shares && a.peak === b.peak && a.cents === b.cents && a.tier === b.tier;
    if (same) return { cls: "MATCH", sub: null };
    // structural mismatch (different market/outcome/track) is never timing
    if (a.cid !== b.cid || a.outcome !== b.outcome || a.group !== b.group) return { cls: "NEW_PATH_BUG", sub: "identity", detail: { a, b } };
    if (OLD_BUG_ALLOW.ACCUMULATE_DIVERGENCE(old, neutral, t)) return { cls: "OLD_PATH_BUG", sub: "ACCUMULATE_DIVERGENCE", detail: { a, b, ledger: signalDigest(t?.ledger?.row) } };
    // same decision, price moved between the two book snapshots -> TIMING_SAME only if the ONLY
    // differing fields are the price-derived ones (cents/maxc/cost by exactly this fill's price)
    const priceOnly = a.shares === b.shares && a.peak === b.peak && a.cents !== b.cents;
    if (priceOnly) return { cls: "TIMING_SAME", sub: "book", detail: { a, b } };
    return { cls: "UNKNOWN", sub: "field mismatch", detail: { a, b } };
  }
  if (!old.ok && !nw.ok) {
    const r = String(old.reason || "");
    const key = "old:" + r;
    if (EXPECTED_ALLOW[key] && EXPECTED_ALLOW[key](ctx, old, neutral)) return { cls: "EXPECTED", sub: key };
    if (r === String(nw.reason || "")) return { cls: "MATCH", sub: "skip:" + r };
    // both skipped for different reasons: a shared-level reason on one side and a per-user on the other
    if (/no live book|no asks|market closed|market not found|runway|outside .* c$/.test(r) && /no live book|no asks|market closed|market not found|runway|outside/.test(String(nw.reason || ""))) return { cls: "TIMING_SAME", sub: "skip-reason", detail: { old: r, nw: nw.reason } };
    return { cls: "UNKNOWN", sub: "skip-reason", detail: { old: r, nw: nw.reason } };
  }
  // one entered, one did not
  const r = String((old.ok ? nw.reason : old.reason) || "");
  const key = "old:" + r;
  if (!old.ok && EXPECTED_ALLOW[key] && EXPECTED_ALLOW[key](ctx, old, neutral)) return { cls: "EXPECTED", sub: key };
  if (/no live book|no asks|outside \d+-\d+c|runway|market closed/.test(r)) return { cls: "TIMING_FLIPPED", sub: r, detail: { oldOk: old.ok, nwOk: nw.ok } };
  return { cls: "UNKNOWN", sub: "decision flipped: " + r, detail: { oldOk: old.ok, nwOk: nw.ok } };
}

/** The ledger-vs-intended check, independent of the old path: what the shadow state says the row IS. */
export function ledgerCheck(t, neutral) {
  if (!t?.ledger?.state || !neutral) return null;
  const c = t.ledger.contrib, s = t.ledger.state;
  return { contribOnce: c && c.fill_id === neutral.fillId, cappedOnce: t.ledger.clampedByChain, shares: s.sh, cost: s.cost, peak: s.peak };
}
