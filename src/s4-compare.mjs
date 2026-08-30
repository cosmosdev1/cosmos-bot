// STAGE 4 SHADOW - the discrepancy classifier. PURE: no I/O, no state, importable by the platform's
// tests. A child calls classify() once per fill it saw on BOTH paths (or timed out waiting), with
// its OWN per-user context, and reports a class. Nothing here can act - the caller only counts.
//
// The three things kept apart, by name, throughout:
//   OLD PATH RESULT          what /v1/copy-check answered THIS child (authoritative today)
//   NEW SHADOW RESULT        what the neutral result + this child's own context would have given
//   INTENDED BUSINESS RULE   the ledger semantics (contribute once, cap once) - compared separately
//
// CLASSES (owner rulings 2026-08-30):
//   MATCH; EXPECTED (fixed allow-list, each with an evidence test); EXPECTED_GATE_ORDER (both SKIP,
//   identical execution outcome, only WHICH valid rejection gate spoke first differs - explicitly
//   allow-listed reason pairs, never a generic skip/skip rule); OLD_PATH_BUG (the FROZEN three-rule
//   taxonomy); NEW_PATH_BUG; TIMING_SAME / TIMING_FLIPPED (different market snapshot);
//   TIMING_ROWSTATE_SAME / _FLIPPED (identical logic on different snapshots of the churning row,
//   differences confined to the row-derived fields; FLIPPED whenever the tier changes);
//   TIMING_COMPOUND_SAME / _FLIPPED (row-derived state AND the market snapshot both demonstrably
//   differ; SAME only when the COMPLETE execution-relevant decision is unchanged - eligibility, price
//   gate, track, tier, direction, order existence, pair rule, event - otherwise FLIPPED);
//   TIMING_DRIVER_RACE_FLIPPED (another whale became the market's driver between the two reads: the
//   old path saw the committed driver and skipped, the shadow saw no driver and built a row);
//   STALE_USER_CONTEXT (the child's watch list disagrees with the server's authoritative picks - a
//   production state-synchronisation defect, kept separately visible, never EXPECTED);
//   OLD_MISSING / NEW_MISSING; UNKNOWN (must be zero to advance).
//
// PRECISION (owner 2026-08-30): no generic epsilon. Each field compares at the precision of its
// source: share quantities are ERC-1155 amounts / 1e6 -> 6 decimals; cost is the route's integer
// dollars; cents, tier, group, pair, end and reasons are exact.

export const EXPECTED_ALLOW = Object.freeze({
  "old:copytrade is off for this account":       (ctx) => ctx.copytrade !== true,
  "old:wallet not in your copy list":            (ctx) => !ctx.followsWallet,
  "old:diamond access expired":                  (ctx) => ctx.diamondBlocked === true,
  // the old route applies the per-user v2 candle-class check BEFORE its price gate; the shared path
  // gates price first, so its SKIP carries the candle facts established before the gate (522b337)
  "old:only 15-minute and hourly candles are copied": (ctx, o, n) => n?.candle?.isCandle === true && !n?.candle?.classV2,
  "old:wallet not in your track":                (ctx, o, n) => Array.isArray(n?.WHALE_TRACK_MEMBERSHIPS) && !n.WHALE_TRACK_MEMBERSHIPS.includes(ctx.group),
  "old:copy-check failed":                       () => true,
  "old:stand-down":                              () => true,
  "old:conflict: opposite side bigger":          (ctx, o, n, t) => t?.old?.dropped === "drivers",
});

/**
 * OLD PATH BUGS - THE FROZEN TAXONOMY (owner 2026-08-30). Exactly three proven production defects,
 * all faces of the fan-out accumulate in /v1/copy-check. A mismatch matching none is UNKNOWN,
 * never a new bug name. Adding an entry requires a documented production replay first.
 */
export const OLD_BUG_ALLOW = Object.freeze({
  ACCUMULATE_SHARE_MULTIPLE: (o, n, t) => {
    const oldRow = t?.old?.row; if (!oldRow || !o?.signal) return false;
    const fillSh = Number(n?.sharesUsed) || 0; if (!(fillSh > 0)) return false;
    const childSh = q6(o.signal.his_shares), sharedSh = q6(oldRow.his_shares);
    const dSh = Math.abs(childSh - sharedSh); if (!(dSh > 0.5)) return false;
    const k = dSh / fillSh;
    const multiple = Math.abs(k - Math.round(k)) < 0.05 && Math.round(k) >= 1;
    const chain = n?.onchainShares != null ? Number(n.onchainShares) : null;
    const atClamp = chain != null && (Math.abs(childSh - chain) < 0.5 || Math.abs(sharedSh - chain) < 0.5);
    return multiple || atClamp || t?.ledger?.clampedByChain === true;
  },
  ACCUMULATE_COST_RESCALE: (o, n, t) => {
    const oldRow = t?.old?.row; if (!oldRow || !o?.signal) return false;
    const childSh = q6(o.signal.his_shares), sharedSh = q6(oldRow.his_shares);
    if (Math.abs(childSh - sharedSh) > 0.5) return false;
    const costDiff = Math.abs((Number(o.signal.his_cost_usd) || 0) - (Number(oldRow.his_cost_usd) || 0)) > 0.5;
    const chain = n?.onchainShares != null ? Number(n.onchainShares) : null;
    const atChain = chain != null ? Math.abs(childSh - chain) < 0.5 : t?.ledger?.clampedByChain === true;
    return costDiff && atChain;
  },
  ACCUMULATE_PEAK_LASTWRITER: (o, n, t) => {
    const oldRow = t?.old?.row; if (!oldRow || !o?.signal) return false;
    const fillSh = Number(n?.sharesUsed) || 0; if (!(fillSh > 0)) return false;
    if (Math.abs(q6(o.signal.his_shares) - q6(oldRow.his_shares)) > 0.5) return false;
    const dPeak = Math.abs(q6(o.signal.his_peak_shares) - q6(oldRow.his_peak_shares));
    const kp = dPeak / fillSh;
    return dPeak > 0.5 && Math.abs(kp - Math.round(kp)) < 0.05 && Math.round(kp) >= 1;
  },
});
export function oldBugRule(o, n, t) {
  for (const name of Object.keys(OLD_BUG_ALLOW)) { if (OLD_BUG_ALLOW[name](o, n, t)) return name; }
  return null;
}

/** share quantities: ERC-1155 amounts / 1e6 - canonical at 6 decimals, the precision of the source */
export const q6 = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : null; };
const int = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; };
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const PRICE_GATE = /^\d+c outside \d+-\d+c$/;
const MARKET_STATE = /no live book|no asks|market closed|market not found|runway|whale holds none/;
const CONFLICT_LABEL = "conflict: opposite side bigger";      // the old route's label for the drivers lock
const NOT_IN_LIST = "wallet not in your copy list";

/** Which already-valid rejection gate a SKIP reason came from (for EXPECTED_GATE_ORDER only). */
export function gateKind(reason) {
  const r = String(reason || "");
  if (PRICE_GATE.test(r)) return "price";
  if (/no live book|no asks|market closed|market not found/.test(r)) return "book";
  if (r === CONFLICT_LABEL || r === "another whale drives this track") return "drivers";
  if (/runway/.test(r)) return "runway";
  if (/resolves beyond/.test(r)) return "horizon";
  if (/whale holds none/.test(r)) return "holds-none";
  return null;
}
/**
 * EXPECTED_GATE_ORDER - the explicitly allow-listed (old gate -> new gate) pairs, each observed in
 * production and each a pair of VALID rejection gates that both refuse the same fill. Both paths
 * SKIP; the execution outcome (no order) is identical; only the first gate to speak differs.
 * Not a generic skip/skip rule: a pair absent here is UNKNOWN.
 */
export const GATE_ORDER_ALLOW = Object.freeze(new Set([
  "drivers->book", "drivers->price", "price->drivers", "holds-none->drivers", "runway->horizon", "runway->drivers",
]));

/** Digest of the fields fastOpen consumes, each at its business precision. */
export function signalDigest(sig) {
  if (!sig) return null;
  return {
    cid: String(sig.condition_id ?? ""), outcome: String(sig.outcome ?? ""), group: int(sig.group_id),
    cost: int(sig.his_cost_usd), shares: q6(sig.his_shares), peak: q6(sig.his_peak_shares),
    cents: int(sig.entry_cents), maxc: int(sig.max_entry_cents), tier: num(sig.tier_pct_resolved),
    pair: Boolean(sig.is_pair), end: sig.end_date ?? null,
  };
}
const ROW_FIELDS = ["cost", "shares", "peak"];                         // derived from the copy_signals row read
const MARKET_FIELDS = ["cents", "maxc", "pair", "end"];                  // derived from the book / market
const DECISION_FIELDS = ["tier"];                                        // what sizing consumes

export function newPathForChild(neutral, ctx) {
  if (!neutral) return { ok: false, reason: "no neutral" };
  if (ctx.copytrade !== true) return { ok: false, reason: "copytrade is off for this account" };
  if (!ctx.followsWallet) return { ok: false, reason: NOT_IN_LIST };
  if (ctx.diamondBlocked) return { ok: false, reason: "diamond access expired" };
  if (neutral.verdict !== "ROWS") return { ok: false, reason: neutral.skipReason || "skip" };
  if (ctx.v2 && neutral.candle?.isCandle && !neutral.candle?.classV2) return { ok: false, reason: "only 15-minute and hourly candles are copied" };
  const t = (neutral.tracks || []).find((x) => Number(x.group_id) === Number(ctx.group));
  if (!t) return { ok: false, reason: "wallet not in your track" };
  const eligible = ctx.hosted ? t.eligibleHosted : t.eligibleSelf;
  if (!eligible) return { ok: false, reason: "resolves beyond your track's horizon", track: t };
  if (t.old.exited) return { ok: false, reason: "already exited: no rebuy after an exit", track: t };
  if (t.old.dropped) return { ok: false, reason: t.old.dropped === "drivers" ? "another whale drives this track" : CONFLICT_LABEL, track: t };
  return { ok: true, signal: t.old.row, track: t };
}

/** Which digest fields differ (after canonicalisation). */
export function digestDiff(a, b) {
  return [...ROW_FIELDS, ...MARKET_FIELDS, ...DECISION_FIELDS].filter((k) => a[k] !== b[k]);
}

/**
 * The COMPLETE execution-relevant decision of an approved signal, for the COMPOUND split. Both
 * sides are approved (eligibility, price gate, order existence equal by construction; track and
 * direction equal by the identity check); what can still differ is the tier (sizing), the pair rule
 * (a different price cap formula) and the event (a different resolution clock).
 */
export function decisionSame(a, b) {
  return a.tier === b.tier && a.pair === b.pair && a.end === b.end;
}

/**
 * classify(old, neutral, ctx) -> { cls, sub, detail }
 */
export function classify(old, neutral, ctx) {
  if (!old && !neutral) return { cls: "UNKNOWN", sub: "both missing" };
  if (!old) return { cls: "OLD_MISSING", sub: null };
  if (!neutral) return { cls: "NEW_MISSING", sub: null };
  const nw = newPathForChild(neutral, ctx);
  const t = nw.track;
  if (old.ok && nw.ok) {
    const a = signalDigest(old.signal), b = signalDigest(nw.signal);
    if (a.cid !== b.cid || a.outcome !== b.outcome || a.group !== b.group) return { cls: "NEW_PATH_BUG", sub: "identity", detail: { a, b } };
    const diff = digestDiff(a, b);
    if (!diff.length) return { cls: "MATCH", sub: null };
    const detail = { a, b, diff, ledger: signalDigest(t?.ledger?.row), fill: neutral.sharesUsed ?? null, chain: neutral.onchainShares ?? null };
    const rule = oldBugRule(old, neutral, t);
    if (rule) return { cls: "OLD_PATH_BUG", sub: rule, detail };
    const rowDiff = diff.some((k) => ROW_FIELDS.includes(k)), mktDiff = diff.some((k) => MARKET_FIELDS.includes(k));
    const marketSame = !mktDiff;
    const onlyRow = diff.every((k) => ROW_FIELDS.includes(k) || DECISION_FIELDS.includes(k));
    // ROW-STATE: same fill, same market facts, differences confined to the row-derived fields (and
    // the tier they feed). Same decision -> SAME; a changed tier is a changed sizing decision -> FLIPPED.
    if (marketSame && onlyRow) return { cls: a.tier === b.tier ? "TIMING_ROWSTATE_SAME" : "TIMING_ROWSTATE_FLIPPED", sub: diff.join("+"), detail };
    // different book snapshot, same decision: only market-derived fields differ (the cost of THIS fill moves with the price)
    const onlyMarket = diff.every((k) => MARKET_FIELDS.includes(k) || k === "cost");
    if (onlyMarket && a.tier === b.tier && a.shares === b.shares && a.peak === b.peak) return { cls: "TIMING_SAME", sub: "book", detail };
    // COMPOUND: the row-derived state AND the market snapshot both differ (a fill storm on a moving
    // book). SAME only if the complete execution-relevant decision is unchanged.
    if (rowDiff && mktDiff) return { cls: decisionSame(a, b) ? "TIMING_COMPOUND_SAME" : "TIMING_COMPOUND_FLIPPED", sub: diff.join("+"), detail };
    return { cls: "UNKNOWN", sub: "field mismatch", detail };
  }
  if (!old.ok && !nw.ok) {
    const r = String(old.reason || ""), s = String(nw.reason || "");
    const key = "old:" + r;
    if (EXPECTED_ALLOW[key] && EXPECTED_ALLOW[key](ctx, old, neutral, t)) return { cls: "EXPECTED", sub: key };
    if (r === s) return { cls: "MATCH", sub: "skip:" + r };
    // the child follows the whale, the server's authoritative picks do not: stale per-user context
    if (r === NOT_IN_LIST && ctx.followsWallet) return { cls: "STALE_USER_CONTEXT", sub: "child follows, server refuses", detail: { nw: s } };
    if (PRICE_GATE.test(r) && PRICE_GATE.test(s)) return { cls: "TIMING_SAME", sub: "price-gate", detail: { old: r, nw: s } };
    if ((MARKET_STATE.test(r) || PRICE_GATE.test(r)) && (MARKET_STATE.test(s) || PRICE_GATE.test(s))) return { cls: "TIMING_SAME", sub: "skip-reason", detail: { old: r, nw: s } };
    const pair = `${gateKind(r)}->${gateKind(s)}`;
    if (gateKind(r) && gateKind(s) && GATE_ORDER_ALLOW.has(pair)) return { cls: "EXPECTED_GATE_ORDER", sub: pair, detail: { old: r, nw: s } };
    return { cls: "UNKNOWN", sub: "skip-reason", detail: { old: r, nw: s } };
  }
  const r = String((old.ok ? nw.reason : old.reason) || "");
  const key = "old:" + r;
  if (!old.ok && EXPECTED_ALLOW[key] && EXPECTED_ALLOW[key](ctx, old, neutral, t)) return { cls: "EXPECTED", sub: key };
  // stale per-user context, decision flipped: the server refused ownership the child believes it has
  if (!old.ok && r === NOT_IN_LIST && ctx.followsWallet) return { cls: "STALE_USER_CONTEXT", sub: "child follows, server refuses; new path approved", detail: { nwOk: true } };
  // DRIVER RACE: the old route hit the drivers lock (its conflict label) while the shadow, reading
  // milliseconds earlier, saw no driver for the track (or only this whale) and built a row.
  if (!old.ok && r === CONFLICT_LABEL && nw.ok && t && !t.old?.dropped && Array.isArray(t.drivers)) {
    const w = String(neutral.wallet || "").toLowerCase();
    if (t.drivers.length === 0 || t.drivers.every((d) => d === w)) return { cls: "TIMING_DRIVER_RACE_FLIPPED", sub: "another whale committed first", detail: { driversSeen: t.drivers } };
  }
  if (PRICE_GATE.test(r) || MARKET_STATE.test(r)) return { cls: "TIMING_FLIPPED", sub: r, detail: { oldOk: old.ok, nwOk: nw.ok } };
  return { cls: "UNKNOWN", sub: "decision flipped: " + r, detail: { oldOk: old.ok, nwOk: nw.ok } };
}

export function ledgerCheck(t, neutral) {
  if (!t?.ledger?.state || !neutral) return null;
  const c = t.ledger.contrib, s = t.ledger.state;
  return { contribOnce: c && c.fill_id === neutral.fillId, cappedOnce: t.ledger.clampedByChain, shares: s.sh, cost: s.cost, peak: s.peak };
}
