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
  let gapSince = 0;                 // when the current run of pending ranges began (known-gap duration)
  const norm = () => { pending = pending.filter((r) => r.to >= r.from).sort((a, b) => a.from - b.from); if (!pending.length) gapSince = 0; else if (!gapSince) gapSince = Date.now(); };

  /** a block header arrived on the live stream */
  function onHead(n) {
    n = Number(n); if (!Number.isFinite(n) || n <= 0) return;
    if (lastHead > 0 && n > lastHead + 1) pending.push({ from: lastHead + 1, to: n - 1, why: "head gap", inFlight: false });   // headers we never saw
    if (n > lastHead) lastHead = n;
    norm();
  }
  /** a log for `block` was delivered live: a block number ahead of the heads reveals headers we missed */
  function onLog(block) {
    block = Number(block); if (!Number.isFinite(block) || block <= 0) return;
    if (lastHead > 0 && block > lastHead + 1) pending.push({ from: lastHead + 1, to: block - 1, why: "log ahead of heads", inFlight: false });
    if (block > lastHead) lastHead = block;
    norm();
  }
  function onDisconnect() { connected = false; }
  /** reconnected: everything after the last head is unproven until a backfill through the new head completes */
  function onReconnect() { connected = true; if (lastHead > 0 && !pending.some((r) => r.why === "reconnect")) pending.push({ from: lastHead + 1, to: Number.MAX_SAFE_INTEGER, why: "reconnect", inFlight: true }); norm(); }
  /** a backfill chunk [from, to] is starting (it replaces the open-ended reconnect range) */
  function onBackfillStart(from, to) { pending = pending.filter((r) => r.why !== "reconnect"); pending.push({ from, to, why: "backfill", inFlight: true }); norm(); }
  /** a backfill chunk finished: ok proves its range (and any head gap inside it); a refusal leaves it pending for retry */
  function onBackfillDone(from, to, ok) {
    pending = pending.filter((r) => !(r.why === "backfill" && r.from === from && r.to === to));
    if (!ok) pending.push({ from, to, why: "backfill refused", inFlight: false });
    else { pending = pending.filter((r) => !(r.from >= from && r.to <= to)); if (to > lastHead) lastHead = to; }
    norm();
  }
  /** a range a later reconciliation proved processed */
  function resolve(from, to) { pending = pending.filter((r) => !(r.from >= from && r.to <= to)); norm(); }

  /** highest block that may be sealed now, or 0 */
  function sealable() {
    if (!connected || lastHead === 0) return 0;
    let n = lastHead;
    for (const r of pending) n = Math.min(n, r.from - 1);
    n -= headLag;
    return n > 0 ? n : 0;
  }
  function state() { return { connected, lastHead, sealable: sealable(), gapOpen: pending.length > 0, gapSince: gapSince || null, pending: pending.map((r) => ({ ...r, to: r.to === Number.MAX_SAFE_INTEGER ? "head" : r.to })) }; }
  return { onHead, onLog, onDisconnect, onReconnect, onBackfillStart, onBackfillDone, resolve, sealable, state };
}
