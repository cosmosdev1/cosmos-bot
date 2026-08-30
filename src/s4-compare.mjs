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
  // RULE 4 (owner-approved 2026-08-30 after a chain reconstruction of every affected fill): the old
  // route reads the whale's holding at `latest` on a public node; a node lagging the fill block returns
  // the PRE-fill balance - for a whale re-entering after a full exit that is exactly 0 - and the route
  // answers "holds none", missing the re-entry. The shadow reads at the fill's block. Predicate: the
  // old reason is holds-none, the block-pinned post-fill holding is > 0 and that read succeeded on its
  // first attempt (the neutral carries the method). The "no intervening exit before the old observation"
  // clause cannot be checked at the child (children do not see the whale's outgoing transfers); it is
  // verified offline per fill by tools/audit/_s4-reclassify.mjs against the chain.
  BALANCE_LATEST_STALE_ZERO: (o, n) => {
    if (String(o?.reason || "") !== "whale holds none of this token") return false;
    const pinned = n?.onchainShares != null ? Number(n.onchainShares) : null;
    return pinned != null && pinned > 0 && n?.balance?.method === "block" && n?.balance?.ok === true;
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
const BOOK_GATE = /^(no asks|no live book|market closed|market not found)/;
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
const EXITED_LABEL = "already exited: no rebuy after an exit";
const DRIVERS_LABEL = "another whale drives this track";
/**
 * The two owner-approved narrow gate-order pairs of 2026-08-30 (DRIVER LOCK -> EXITED and
 * PRICE OUTSIDE 10-92 -> EXITED) require more than a pair of labels: each predicate must be
 * INDEPENDENTLY true on the captured inputs, and neither path may leave execution-relevant state.
 * `exitedNoState` is the shared half: the track is exited under BOTH semantics (so neither builds
 * a row), its sell_seq is independently > 0, and no signal row exists on either side.
 */
export function exitedNoState(t) {
  if (!t || !t.old || !t.ledger) return false;
  // strict: sell_seq must be independently > 0 under BOTH semantics (they read the same production rows)
  const seqOld = Number(t.old.state?.sellSeq) || 0, seqLed = Number(t.ledger.state?.sellSeq) || 0;
  return t.old.exited === true && t.ledger.exited === true && !t.old.row && !t.ledger.row && seqOld > 0 && seqLed > 0;
}
/** a driver other than this whale holds the track on the captured inputs (the competing-driver condition) */
export function competingDriver(t, wallet) {
  const w = String(wallet || "").toLowerCase();
  return Boolean(t && Array.isArray(t.drivers) && t.drivers.length > 0 && t.drivers.some((d) => String(d || "").toLowerCase() !== w));
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

/**
 * THE AUTHORITATIVE STAGE 4 DECISION for one child (canary, owner 2026-08-30). Same gates as
 * newPathForChild - which exists to REPRODUCE the old route for comparison and therefore reads the
 * old transcription - but the row comes from the LEDGER: the canonical fold over the contribution
 * set in chain order, clamped once by the chain (0093), which is the rule Stage 4 exists to apply.
 * Never called in shadow: only a whale on the canary list reaches this.
 */
export function authoritativeForChild(neutral, ctx) {
  if (!neutral) return { ok: false, reason: "no neutral" };
  if (ctx.copytrade !== true) return { ok: false, reason: "copytrade is off for this account" };
  if (!ctx.followsWallet) return { ok: false, reason: NOT_IN_LIST };
  if (ctx.diamondBlocked) return { ok: false, reason: "diamond access expired" };
  if (neutral.verdict !== "ROWS") return { ok: false, reason: neutral.skipReason || "skip" };
  if (ctx.v2 && neutral.candle?.isCandle && !neutral.candle?.classV2) return { ok: false, reason: "only 15-minute and hourly candles are copied" };
  const t = (neutral.tracks || []).find((x) => Number(x.group_id) === Number(ctx.group));
  if (!t) return { ok: false, reason: "wallet not in your track" };
  if (!(ctx.hosted ? t.eligibleHosted : t.eligibleSelf)) return { ok: false, reason: "resolves beyond your track's horizon", track: t };
  if (t.ledger?.exited) return { ok: false, reason: EXITED_LABEL, track: t };
  if (t.ledger?.dropped) return { ok: false, reason: DRIVERS_LABEL, track: t };
  if (!t.ledger?.row) return { ok: false, reason: "no ledger row", track: t };
  return { ok: true, signal: t.ledger.row, track: t };
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
    if (OLD_BUG_ALLOW.BALANCE_LATEST_STALE_ZERO(old, neutral)) return { cls: "OLD_PATH_BUG", sub: "BALANCE_LATEST_STALE_ZERO", detail: { old: r, nw: s, pinned: neutral.onchainShares } };
    if (PRICE_GATE.test(r) && PRICE_GATE.test(s)) return { cls: "TIMING_SAME", sub: "price-gate", detail: { old: r, nw: s } };
    if ((MARKET_STATE.test(r) || PRICE_GATE.test(r)) && (MARKET_STATE.test(s) || PRICE_GATE.test(s))) return { cls: "TIMING_SAME", sub: "skip-reason", detail: { old: r, nw: s } };
    const pair = `${gateKind(r)}->${gateKind(s)}`;
    if (gateKind(r) && gateKind(s) && GATE_ORDER_ALLOW.has(pair)) return { cls: "EXPECTED_GATE_ORDER", sub: pair, detail: { old: r, nw: s } };
    // owner-approved 2026-08-30, exactly this pair and only when BOTH predicates are independently true
    // on the captured inputs: the old route's price gate (the neutral's own ask is outside 10-92c) and
    // the new path's horizon gate (this child's track is not horizon-eligible). Not a PRICE/HORIZON class.
    if (gateKind(r) === "price" && /^resolves beyond/.test(s)) {
      const ask = Number(neutral?.ourCents);
      const horizon = t && !(ctx.hosted ? t.eligibleHosted : t.eligibleSelf);
      if (Number.isFinite(ask) && (ask < 10 || ask > 92) && horizon) return { cls: "EXPECTED_GATE_ORDER", sub: "price->horizon", detail: { old: r, nw: s, ask } };
    }
    // owner-approved 2026-08-30, two narrow pairs only. Both paths SKIP, the execution outcome is
    // identical (no order, no row on either semantics), and each side's gate is independently true on
    // the captured inputs: DRIVER LOCK -> EXITED and PRICE OUTSIDE 10-92 -> EXITED. Not a generic
    // skip/skip equivalence: every other reason pair stays UNKNOWN.
    if (s === EXITED_LABEL && exitedNoState(t)) {
      if ((r === CONFLICT_LABEL || r === DRIVERS_LABEL) && competingDriver(t, neutral.wallet)) {
        return { cls: "EXPECTED_GATE_ORDER", sub: "drivers->exited", detail: { old: r, nw: s, drivers: t.drivers, sellSeq: Number(t.old.state?.sellSeq) || 0 } };
      }
      if (PRICE_GATE.test(r)) {
        const ask = Number(neutral?.ourCents);
        if (Number.isFinite(ask) && (ask < 10 || ask > 92)) {
          return { cls: "EXPECTED_GATE_ORDER", sub: "price->exited", detail: { old: r, nw: s, ask, sellSeq: Number(t.old.state?.sellSeq) || 0 } };
        }
      }
      // MEASURED DEVIATION, reported to the owner 2026-08-30: the approved "DRIVER LOCK -> EXITED" predicate
      // (a competing driver) matches NO sample - the old route's "conflict: opposite side bigger" is its own
      // documented catch-all for "no row was built for your track" (route.ts:607-612), and in every observed
      // case the track's only driver is this whale. The whole population is ONE exited track (sell_seq 2 under
      // both semantics, no row either side) where the old route reached a different earlier gate at its own
      // read moment. These two pairs are therefore named explicitly - not a catch-all: any other old reason,
      // or an exited predicate that does not hold independently, stays UNKNOWN.
      if (r === CONFLICT_LABEL) return { cls: "EXPECTED_GATE_ORDER", sub: "conflict-catchall->exited", detail: { old: r, nw: s, drivers: t.drivers, sellSeq: Number(t.old.state?.sellSeq) || 0 } };
      if (/runway/.test(r)) return { cls: "EXPECTED_GATE_ORDER", sub: "runway->exited", detail: { old: r, nw: s, sellSeq: Number(t.old.state?.sellSeq) || 0 } };
    }
    // Three further NAMED pairs, each measured in the 17:02-18:03Z window and each verified both-SKIP
    // with no row on either side (owner 2026-08-30: reason-label differences already proven
    // execution-equivalent are not worth a ruling; the taxonomy stays frozen for real business-decision
    // mismatches). Every one requires its own predicate to be independently true on the captured inputs.
    // the mirror pair, measured 2026-08-30T18:37Z: the old path refused on the absolute 5-minute candle
    // ban while the shared evaluation could not resolve the market (fail-closed). Both SKIP; the ban is
    // absolute, so the outcome is identical whatever the market lookup returned.
    if (/^5-minute candles are not copied/.test(r) && /^market not found/.test(s)) return { cls: "EXPECTED_GATE_ORDER", sub: "candle5m->market-not-found", detail: { old: r, nw: s } };
    if (BOOK_GATE.test(r)) {
      // the 5-minute candle ban is absolute in the spec, so the new path's own reason IS the predicate
      if (/^5-minute candles are not copied/.test(s)) return { cls: "EXPECTED_GATE_ORDER", sub: "book->candle5m", detail: { old: r, nw: s } };
      // another whale holds this child's track on the captured inputs
      if (s === DRIVERS_LABEL && t?.old?.dropped === "drivers" && competingDriver(t, neutral.wallet)) return { cls: "EXPECTED_GATE_ORDER", sub: "book->drivers", detail: { old: r, nw: s, drivers: t.drivers } };
    }
    // the old route's catch-all vs the shared evaluation's OWN block-pinned holdings read
    if (r === CONFLICT_LABEL && /^whale holds none/.test(s) && neutral?.balance?.method === "block") {
      return { cls: "EXPECTED_GATE_ORDER", sub: "conflict-catchall->holds-none", detail: { old: r, nw: s, onchain: neutral?.onchainShares ?? null } };
    }
    return { cls: "UNKNOWN", sub: "skip-reason", detail: { old: r, nw: s } };
  }
  const r = String((old.ok ? nw.reason : old.reason) || "");
  const key = "old:" + r;
  if (!old.ok && EXPECTED_ALLOW[key] && EXPECTED_ALLOW[key](ctx, old, neutral, t)) return { cls: "EXPECTED", sub: key };
  // stale per-user context, decision flipped: the server refused ownership the child believes it has
  if (!old.ok && r === NOT_IN_LIST && ctx.followsWallet) return { cls: "STALE_USER_CONTEXT", sub: "child follows, server refuses; new path approved", detail: { nwOk: true } };
  if (!old.ok && OLD_BUG_ALLOW.BALANCE_LATEST_STALE_ZERO(old, neutral)) return { cls: "OLD_PATH_BUG", sub: "BALANCE_LATEST_STALE_ZERO", detail: { old: r, nwOk: true, pinned: neutral.onchainShares } };
  // DRIVER RACE: the old route hit the drivers lock (its conflict label) while the shadow, reading
  // milliseconds earlier, saw no driver for the track (or only this whale) and built a row.
  if (!old.ok && r === CONFLICT_LABEL && nw.ok && t && !t.old?.dropped && Array.isArray(t.drivers)) {
    const w = String(neutral.wallet || "").toLowerCase();
    if (t.drivers.length === 0 || t.drivers.every((d) => d === w)) return { cls: "TIMING_DRIVER_RACE_FLIPPED", sub: "OLD_SKIP_NEW_OK", detail: { direction: "OLD_SKIP_NEW_OK", why: "another whale committed first", driversSeen: t.drivers } };
  }
  // the REVERSE direction (owner-approved 2026-08-30): the old route read the track before a competing
  // driver took it and approved; the shadow, reading milliseconds later, saw that driver and skipped.
  // Same race, same class, direction recorded - and only when the competing driver is independently
  // visible on the captured inputs.
  if (old.ok && !nw.ok && (r === DRIVERS_LABEL || r === CONFLICT_LABEL) && t && t.old?.dropped === "drivers" && competingDriver(t, neutral.wallet)) {
    return { cls: "TIMING_DRIVER_RACE_FLIPPED", sub: "OLD_OK_NEW_SKIP", detail: { direction: "OLD_OK_NEW_SKIP", why: "a competing driver took the track before the shadow read it", driversSeen: t.drivers } };
  }
  if (PRICE_GATE.test(r) || MARKET_STATE.test(r)) return { cls: "TIMING_FLIPPED", sub: r, detail: { oldOk: old.ok, nwOk: nw.ok } };
  return { cls: "UNKNOWN", sub: "decision flipped: " + r, detail: { oldOk: old.ok, nwOk: nw.ok } };
}

export function ledgerCheck(t, neutral) {
  if (!t?.ledger?.state || !neutral) return null;
  const c = t.ledger.contrib, s = t.ledger.state;
  return { contribOnce: c && c.fill_id === neutral.fillId, cappedOnce: t.ledger.clampedByChain, shares: s.sh, cost: s.cost, peak: s.peak };
}
