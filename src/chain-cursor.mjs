// CONTIGUOUS, GAP-AWARE CHAIN CURSOR (owner 2026-08-30) - pure, no I/O.
//
// The canonical driver may be SEALED for block N only when the ingestion model can prove it has
// processed every relevant event <= N. "A later block arrived" proves nothing by itself: the log
// subscription is wallet-filtered (an empty block and a dropped log look the same), a reconnect
// loses everything between the last delivered block and the new head until the backfill lands,
// and a backfill chunk can be refused by the RPC. So the cursor tracks:
//   lastHead     the highest block header seen (newHeads) or proven by a completed backfill
//   pending      block ranges whose logs are NOT proven processed: a head gap (a header number was
//                skipped), a disconnect window, a backfill chunk that failed or is still running
//   sealable()   min(lastHead, lowest pending range start - 1) - HEAD_LAG: heads must be present
//                and contiguous through N + HEAD_LAG (the chain moved past N and we saw it move),
//                and no unproven range may start at or below N + HEAD_LAG
//
// INVARIANT: SEALED(N) => no KNOWN missing relevant event <= N. Unknown unknowns (a provider that
// silently drops a log inside an otherwise contiguous stream) are what `driver_corrected_sealed`
// measures; a nonzero rate there raises HEAD_LAG or adds a periodic eth_getLogs reconciliation.

export function createChainCursor({ headLag = 1 } = {}) {
  let lastHead = 0;                 // highest head seen or proven
  let connected = false;
  let pending = [];                 // [{from, to, why, inFlight}] block ranges not proven processed
  const seenHeads = new Set();      // headers we DID see (bounded), to resolve head-derived ranges when heads catch up
  // Heads and logs are two streams: a log for block N+2 can arrive before the header of N+1. That
  // opens a "log ahead of heads" range for N+1 which must close the moment head N+1 arrives -
  // measured before this fix: the cursor showed a known gap 43 % of the time and seal latency
  // inflated to 13 s p95, purely from heads trailing logs by a block or two.
  const resolveHeadRanges = () => { pending = pending.filter((r) => { if (r.why !== "head gap" && r.why !== "log ahead of heads") return true; if (r.to - r.from > 5000) return true; for (let k = r.from; k <= r.to; k++) if (!seenHeads.has(k)) return true; return false; }); };
  let gapSince = 0;                 // when the current run of pending ranges began (known-gap duration)
  const norm = () => { pending = pending.filter((r) => r.to >= r.from).sort((a, b) => a.from - b.from); if (!pending.length) gapSince = 0; else if (!gapSince) gapSince = Date.now(); };

  /** a block header arrived on the live stream */
  function onHead(n) {
    n = Number(n); if (!Number.isFinite(n) || n <= 0) return;
    if (lastHead > 0 && n > lastHead + 1) pending.push({ from: lastHead + 1, to: n - 1, why: "head gap", inFlight: false, at: Date.now() });   // headers we never saw
    seenHeads.add(n); if (seenHeads.size > 4096) { for (const k of seenHeads) { if (k < n - 3000) seenHeads.delete(k); } }
    if (n > lastHead) lastHead = n;
    resolveHeadRanges();
    norm();
  }
  /** a log for `block` was delivered live: a block number ahead of the heads reveals headers we missed */
  function onLog(block) {
    block = Number(block); if (!Number.isFinite(block) || block <= 0) return;
    if (lastHead > 0 && block > lastHead + 1) pending.push({ from: lastHead + 1, to: block - 1, why: "log ahead of heads", inFlight: false, at: Date.now() });
    if (block > lastHead) lastHead = block;
    norm();
  }
  function onDisconnect() { connected = false; }
  /** reconnected: everything after the last head is unproven until a backfill through the new head completes.
   *  `inclusiveFrom` (owner 2026-08-30): the hub passes the LAST BLOCK IT OBSERVED A LOG FROM when that block is
   *  not proven closed - a socket that died after the first of several logs of block N leaves N partially
   *  delivered, and "lastHead + 1" would silently treat it as complete (measured: block 92929478, 14:14Z). */
  function onReconnect(inclusiveFrom) {
    connected = true;
    const from = Number.isFinite(Number(inclusiveFrom)) && Number(inclusiveFrom) > 0 ? Math.min(Number(inclusiveFrom), lastHead + 1) : lastHead + 1;
    if (lastHead > 0 && !pending.some((r) => r.why === "reconnect")) pending.push({ from, to: Number.MAX_SAFE_INTEGER, why: "reconnect", inFlight: true, at: Date.now() });
    norm();
  }
  /** a backfill chunk [from, to] is starting (it replaces the open-ended reconnect range) */
  function onBackfillStart(from, to) { pending = pending.filter((r) => r.why !== "reconnect"); pending.push({ from, to, why: "backfill", inFlight: true, at: Date.now() }); norm(); }
  /** a backfill chunk finished: ok proves its range (and any head gap inside it); a refusal leaves it pending for retry */
  function onBackfillDone(from, to, ok) {
    pending = pending.filter((r) => !(r.why === "backfill" && r.from === from && r.to === to));
    if (!ok) pending.push({ from, to, why: "backfill refused", inFlight: false, at: Date.now() });
    else { pending = pending.filter((r) => !(r.from >= from && r.to <= to)); if (to > lastHead) lastHead = to; for (let k = from; k <= to && k - from < 5000; k++) seenHeads.add(k); }
    norm();
  }
  /** a range a later reconciliation proved processed: ranges inside it disappear, ranges overlapping it are TRIMMED or
   *  SPLIT (owner 2026-08-30: the seal worker resolves one block at a time through a range nothing else can close) */
  function resolve(from, to) {
    const next = [];
    for (const r of pending) {
      if (r.to < from || r.from > to) { next.push(r); continue; }
      if (r.from < from) next.push({ ...r, to: from - 1 });
      if (r.to > to) next.push({ ...r, from: to + 1 });
    }
    pending = next; norm();
  }
  /** the pending range containing block n, or null */
  function pendingAt(n) { n = Number(n); for (const r of pending) if (r.from <= n && n <= r.to) return { ...r }; return null; }

  /** highest block that may be sealed now, or 0 */
  function sealable() {
    if (!connected || lastHead === 0) return 0;
    let n = lastHead;
    for (const r of pending) n = Math.min(n, r.from - 1);
    n -= headLag;
    return n > 0 ? n : 0;
  }
  function state() { return { connected, lastHead, sealable: sealable(), gapOpen: pending.length > 0, gapSince: gapSince || null, pending: pending.map((r) => ({ ...r, to: r.to === Number.MAX_SAFE_INTEGER ? "head" : r.to })) }; }
  return { onHead, onLog, onDisconnect, onReconnect, onBackfillStart, onBackfillDone, resolve, pendingAt, sealable, state };
}
