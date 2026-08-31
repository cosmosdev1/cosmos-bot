// STAGE 4 SHADOW - THE SEAL WORKER: block-close-by-reconciliation (owner-approved 2026-08-30).
//
// A block N becomes SEALABLE when the contiguous gap-aware cursor says every header through N + lag is
// present and no unproven range lies at or below it. The worker then RECONCILES N against the node
// before sealing it - the seal no longer waits for another whale's fill to commit:
//   1. the node must have reached N + 1 (eth_blockNumber on the reconciliation endpoint)
//   2. the block's identity must match what the stream showed (eth_getBlockByNumber(N).hash vs the
//      header we observed; if we never saw N's header - a backfilled block - the node's hash is recorded
//      as the pin and marked 'unpinned-stream')
//   3. logs of N are fetched PINNED to that hash (eth_getLogs { blockHash }) with the hub's exact filter;
//      every returned log must carry the same blockHash
//   4. logs expand into logical fills with the hub's own fillsFromLog (same itemIndex rules); fills the
//      hub has not evaluated are evaluated NOW through the normal path (idempotent by fill id) and awaited;
//      fills already evaluated are counted as duplicates
//   5. only then POST /api/v1/fill-reconcile { block, hash, stats } -> the DB records the block, advances
//      the persisted cursor and seals every driver with block <= N
// A timeout / error / identity mismatch keeps N pending and is retried with backoff; nothing above N
// seals while N is pending (SEALED(N) => no known missing relevant event <= N). One worker, one block
// at a time, driven by cursor advancement; duplicate head notifications are harmless; on restart the
// worker resumes from the persisted cursor (re-reconciling anything the previous process had in flight).
import { fillsFromLog } from "./fills.mjs";

export function startSealWorker({ api, secret, hub, s4, log, inc, isWatched, poll = 500 }) {
  let lastSealed = 0, pendingBlock = null, pendingSince = 0, attempts = 0, running = false, stopped = false, started = false, throughCount = 0;
  // SELF-HEALING (third wedge, 2026-08-31): the worker stopped twice with every await individually
  // deadlined and no counter moving at all - the `running` mutex was held by something that never
  // settled. Chasing the await is the wrong shape of fix: the mutex itself now has a deadline, and the
  // STAGE is recorded so the next stall names its own cause instead of needing an archaeology session.
  let tickAt = 0, stage = "idle", stalls = 0;
  // ABANDONING BLOCKS IS THE LAST RESORT, NOT THE FIRST (measured 2026-08-31 09:03Z). A transient
  // slowdown let the backlog grow 18 -> 72 blocks over eighty seconds; the flat MAX_BEHIND clamp fired
  // and permanently abandoned 24 blocks, so no driver in them can ever be sealed. The worker reconciles
  // ~2 blocks/s against a chain that produces ~0.5/s, so it had every chance to catch up. A range is
  // now skipped only when the worker is LOSING GROUND - the backlog has stayed above the threshold and
  // has not improved across several consecutive ticks - which is the condition the clamp was for.
  const behindHistory = [];
  const losingGround = (behind) => {
    behindHistory.push(behind); if (behindHistory.length > 12) behindHistory.shift();
    if (behindHistory.length < 12) return false;                       // not enough evidence yet
    const first = behindHistory[0], last = behindHistory[behindHistory.length - 1];
    return last >= first && behindHistory.every((b) => b > MAX_BEHIND); // never dipped, never improved
  };
  const RPC_TIMEOUT = Number(process.env.COSMOS_S4_RECON_TIMEOUT_MS) || 8_000;
  const MAX_BEHIND = Number(process.env.COSMOS_S4_RECON_MAX_BEHIND) || 50;   // on boot, never try to reconcile more than this many blocks back
  const EVAL_DEADLINE_MS = Number(process.env.COSMOS_S4_RECON_EVAL_MS) || 20_000;   // a recovered fill that never settles must not stop the worker
  const BLOCK_ATTEMPTS = Number(process.env.COSMOS_S4_BLOCK_ATTEMPTS) || 4;   // per-block budget before it is recorded unreconciled
  // ONE BAD BLOCK MUST NOT COST A RANGE (2026-08-31, canary epoch 2). A recovered fill that could not
  // be evaluated held the cursor on block 92984954 while the chain ran on; four attempts with
  // exponential backoff took longer than the lag took to reach 61 blocks, so the range guard fired and
  // abandoned FIVE blocks - and the server guard correctly reverted the canary for an abandoned range.
  // A wall-clock ceiling bounds the damage of one unevaluable block to that block. The invariant is
  // untouched: the block is RECORDED UNRECONCILED, never sealed.
  const BLOCK_MS = Number(process.env.COSMOS_S4_BLOCK_MS) || 20_000;
  const STUCK_INFLIGHT_MS = Number(process.env.COSMOS_S4_RECON_STUCK_MS) || 30_000;   // a backfill still running this long is treated as stuck
  const STUCK_IDLE_MS = 5_000;                                                        // a head gap the stream may still close by itself
  // While a specific block is stuck, the doubling backoff is what makes the wall-clock ceiling slow to
  // arrive: 2+4+8+16 s of waiting before the fifth attempt can retire it, and the lag grows the whole
  // time. Cap it at 5 s for a pending block; the long backoff is for transient node errors, not for a
  // block that is never going to reconcile.
  const backoff = () => {
    const base = Math.min(pendingBlock ? 5_000 : 30_000, 1_000 * 2 ** Math.min(attempts, 5));
    // NEVER SLEEP PAST THE CEILING. The per-block wall-clock budget only takes effect on the next
    // attempt, so a backoff longer than the time remaining to it silently postpones the retirement it
    // exists to force - which is how a doubling backoff turns a 20 s budget into a minute.
    if (!pendingSince) return base;
    return Math.min(base, Math.max(200, BLOCK_MS - (Date.now() - pendingSince)));
  };

  async function post(path, body, method = "POST") {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15_000);
    try {
      const r = await fetch(`${api}${path}`, { method, headers: { "content-type": "application/json", "x-runner-secret": secret }, body: method === "POST" ? JSON.stringify(body) : undefined, signal: ctl.signal });
      const j = await r.json().catch(() => null);
      return { ok: r.ok, status: r.status, j };
    } finally { clearTimeout(t); }
  }

  /** resume point: the persisted DB cursor, but never further back than MAX_BEHIND blocks from what is sealable now */
  async function boot() {
    // BOOT BUG (2026-08-30 13:xxZ, first deployment): the cursor was not yet anchored when boot ran,
    // sealable() was 0, the MAX_BEHIND clamp never applied and the worker reconciled from block 1 -
    // 4,232 ancient blocks in 53 minutes, sealing nothing current. Boot now WAITS for a live cursor,
    // and every tick re-clamps: the worker never works more than MAX_BEHIND blocks behind sealable().
    const sealable = hub.sealable();
    if (!(sealable > 0)) return;                                   // not anchored yet: try again next tick
    let cur = 0;
    try { const r = await post("/api/v1/fill-reconcile", null, "GET"); cur = Number(r?.j?.cursor) || 0; } catch (e) { log(`s4 seal: boot read failed (${e?.message || e}) - resuming from the live cursor`); }
    lastSealed = cur > 0 ? cur : 0;
    if (sealable - lastSealed > MAX_BEHIND) { log(`s4 seal: DB cursor ${lastSealed} is ${sealable - lastSealed} blocks behind - resuming at ${sealable - MAX_BEHIND} (the gap is recorded, not sealed)`); lastSealed = sealable - MAX_BEHIND; }
    log(`s4 seal: worker up · resume after block ${lastSealed} (sealable ${sealable})`);
    started = true;
  }

  /** reconcile ONE block against the node; returns { ok, stats } */
  // THROUGHPUT IS A SAFETY PROPERTY HERE (measured 2026-08-31, canary epoch 3). The worker reconciles
  // sequentially, so its rate is 1/latency: 40 blocks/min healthy against a chain producing ~30 is only
  // 1.33x of headroom, and when the public RPC slowed 7x at p50 the rate fell to 16.5/min and the
  // cursor fell behind without bound until the range guard abandoned 123 blocks. Two fixes: stop
  // paying for the node height on every block (it is the same answer for all of them), and reconcile a
  // small batch concurrently while still SEALING STRICTLY IN ORDER.
  let heightVal = 0, heightAt = 0;
  const HEIGHT_TTL_MS = Number(process.env.COSMOS_S4_HEIGHT_TTL_MS) || 1_000;
  // Only trust the cached height when it already PROVES the block exists. A cache that can be a block
  // stale otherwise answers "node-behind" for a block the node actually has, and buys a retry cycle
  // instead of saving one (measured: 21 needless node-behind in 8 minutes).
  async function nodeHeight(need) {
    if (heightVal >= need && Date.now() - heightAt < HEIGHT_TTL_MS) return heightVal;
    const h = await hub.rpcBlockNumber(RPC_TIMEOUT);
    if (Number.isFinite(h)) { heightVal = h; heightAt = Date.now(); }
    return h;
  }
  const BATCH = Math.max(1, Number(process.env.COSMOS_S4_RECON_BATCH) || 4);

  async function reconcile(N) {
    const t0 = Date.now(); stage = "height"; const stats = { status: "ok", head_seen_at: hub.headSeenAt?.(N + 1) ? new Date(hub.headSeenAt(N + 1)).toISOString() : null, recon_start_at: new Date(t0).toISOString() };
    // 1. node height
    const height = await nodeHeight(N + 1);
    if (!Number.isFinite(height) || height < N + 1) { heightAt = 0; return { ok: false, stats: { ...stats, status: "node-behind", error: `node at ${height}` } }; }
    // 2. identity
    stage = "header";
    const header = await hub.rpcBlockHeader(N, RPC_TIMEOUT);
    if (!header?.hash) return { ok: false, stats: { ...stats, status: "no-header", error: "eth_getBlockByNumber returned nothing" } };
    const seenHash = hub.headHash?.(N) || null;
    if (seenHash && seenHash !== String(header.hash).toLowerCase()) return { ok: false, stats: { ...stats, status: "hash-mismatch", error: `stream ${seenHash.slice(0, 12)} vs node ${String(header.hash).slice(0, 12)}` } };
    const pin = String(header.hash).toLowerCase();
    // 3. logs pinned to the hash, the hub's exact filter
    stage = "logs";
    const rpcStart = Date.now();
    const logs = await hub.rpcLogsPinned(pin, RPC_TIMEOUT);
    const rpcMs = Date.now() - rpcStart;
    if (!Array.isArray(logs)) return { ok: false, stats: { ...stats, status: "logs-refused", rpc_ms: rpcMs, error: "eth_getLogs refused" } };
    if (logs.some((l) => String(l.blockHash || "").toLowerCase() !== pin)) return { ok: false, stats: { ...stats, status: "logs-hash-mismatch", rpc_ms: rpcMs, error: "a returned log carries another block hash" } };
    // 4. expand and diff against what the hub evaluated
    const fills = logs.flatMap((l) => fillsFromLog(l, isWatched));
    const missing = fills.filter((f) => !s4.hasEvaluated(f.fillId));
    const dup = fills.length - missing.length;
    if (missing.length) {
      inc("s4ReconMissing", missing.length);
      log(`s4 seal: block ${N} - ${missing.length} fill(s) the stream never delivered: ${missing.map((f) => f.fillId.slice(0, 18)).join(" ")} - evaluating before the seal`);
      // NO AWAIT WITHOUT A DEADLINE (the owner's standing rule): even with the hub settling its hung
      // waiters, this await must never be able to stop reconciliation for the whole fleet.
      stage = "evaluate";
      const results = await Promise.race([
        s4.evaluateNow(missing, { origin: "reconcile" }),
        new Promise((res) => setTimeout(() => res(null), EVAL_DEADLINE_MS)),
      ]);
      if (!results) return { ok: false, stats: { ...stats, status: "missing-eval-timeout", rpc_ms: rpcMs, logs: logs.length, fills: fills.length, missing: missing.length, duplicates: dup, error: `recovered fills did not settle in ${EVAL_DEADLINE_MS}ms` } };
      if (results.some((r) => !r.ok)) return { ok: false, stats: { ...stats, status: "missing-eval-failed", rpc_ms: rpcMs, logs: logs.length, fills: fills.length, missing: missing.length, duplicates: dup, error: "a recovered fill failed to evaluate" } };
    }
    if (dup) inc("s4ReconDup", dup);
    return { ok: true, pin, stats: { ...stats, logs: logs.length, fills: fills.length, missing: missing.length, duplicates: dup, rpc_ms: rpcMs, recon_done_at: new Date().toISOString(), unpinned: !seenHash || undefined } };
  }

  async function tick() {
    if (running || stopped) return;
    running = true; tickAt = Date.now(); stage = "start";
    try {
      if (!started) { await boot(); if (!started) return; }
      const sealable = hub.sealable();
      // LIVENESS (owner 2026-08-30): a pending range nothing else can close - a refused backfill chunk, the part of
      // a gap beyond COPY_BACKFILL_BLOCKS, a hung backfill - froze sealable() for good at 15:03Z: no code path
      // resolved it. The worker's pinned per-block eth_getLogs IS a complete recovery of a block, so it reconciles
      // THROUGH such a range block by block and resolves each one in the cursor; a backfill still running is left
      // to finish first, and a fresh head gap gets a few seconds for the stream to close it.
      let through = false, throughBlock = null;
      if (!(sealable > lastSealed) || (pendingBlock ?? lastSealed + 1) > sealable) {
        const N0 = pendingBlock ?? lastSealed + 1;
        // the block that holds the cursor is the range start; N0 itself may sit just below it, held only by the
        // head lag - it is reconciled on the way (node height >= N0 + 1 proves the chain moved past it)
        let p = null; for (let k = N0; k <= N0 + 2 && !p; k++) p = hub.pendingAt?.(k);
        const stuckFor = (r) => Date.now() - (Number(r?.at) || 0) >= (r?.inFlight ? STUCK_INFLIGHT_MS : STUCK_IDLE_MS);
        if (p && stuckFor(p)) { through = true; throughBlock = N0; }
        else {
          // THE CURSOR CAN SIT AHEAD OF SEALABLE (measured 2026-08-31, 57 minutes dead). After a restart the
          // hub's view starts fresh, so `sealable` is whatever ITS heads prove - and a pending range left by
          // the reconnect backfill can pin that hundreds of blocks BELOW the persisted DB cursor. The old
          // logic only looked for a pending range next to the block it wanted, found none, and returned for
          // ever while the chain moved on. What unblocks the fleet is resolving the LOWEST stuck range,
          // wherever it is: those blocks are below the cursor and reconciling them is idempotent, but it is
          // the only thing that lets sealable climb past them again.
          const pend = (hub.cursor?.() || {}).pending || [];
          const lowest = pend.filter((r) => Number.isFinite(Number(r.from))).sort((a, b) => Number(a.from) - Number(b.from))[0];
          if (!lowest || !stuckFor(lowest)) return;                                             // nothing stuck: simply not sealable yet (head lag)
          through = true; throughBlock = Number(lowest.from);
          if (throughCount === 0 || throughCount % 25 === 0) log(`s4 seal: sealable ${sealable} sits below the cursor ${lastSealed}; resolving the stuck range at ${throughBlock} (${lowest.why})`);
        }
      }
      // never fall further behind than MAX_BEHIND (a long stall, a stuck block after many retries): the
      // skipped range is a KNOWN unreconciled gap, logged and counted, never silently sealed
      if (!through && losingGround(sealable - lastSealed) && !(pendingBlock && attempts < 20)) { const from = lastSealed + 1, to = sealable - MAX_BEHIND; log(`s4 seal: ${to - from + 1} blocks (${from}-${to}) left unreconciled - too far behind; resuming at ${to + 1}`); inc("s4ReconSkipped", to - from + 1); await post("/api/v1/fill-reconcile", { block: to, hash: null, stats: { status: "skipped-range", from, to, error: `behind by ${sealable - lastSealed}` } }).catch(() => {}); lastSealed = to; pendingBlock = null; pendingSince = 0; attempts = 0; }
      const N = through ? throughBlock : (pendingBlock ?? lastSealed + 1);
      if (!through && N > sealable) return;
      // BATCH THE ORDINARY CASE. Only the plain "walk forward from the cursor" path batches; a pending
      // block being retried and a through-block resolving a stuck range keep the single-block path, so
      // their existing budgets and semantics are untouched. Blocks are reconciled CONCURRENTLY but
      // sealed STRICTLY IN ORDER, stopping at the first failure - so the invariant is unchanged: a
      // block is only ever sealed behind its own ok reconciliation, and nothing after a failure is
      // sealed in this pass.
      if (!through && !pendingBlock && sealable - lastSealed >= 2 && BATCH > 1) {
        stage = "batch";
        const last = Math.min(sealable, lastSealed + BATCH);
        const blocks = []; for (let b = lastSealed + 1; b <= last; b++) blocks.push(b);
        const results = await Promise.all(blocks.map((b) => reconcile(b).then((x) => ({ b, r: x }), (e) => ({ b, r: { ok: false, stats: { status: "threw", error: String(e?.message || e) } } }))));
        let advanced = 0;
        for (const { b, r: rr } of results) {
          if (!rr.ok) { pendingBlock = b; pendingSince = Date.now(); attempts = 1; inc("s4ReconErr");
            await post("/api/v1/fill-reconcile", { block: b, hash: null, stats: rr.stats }).catch(() => {});
            log(`s4 seal: batch stopped at block ${b} (${rr.stats?.status}) - the rest of the batch is left for the next pass`);
            break; }
          stage = "seal-post";
          const pp = await post("/api/v1/fill-reconcile", { block: b, hash: rr.pin, stats: rr.stats });
          if (!pp.ok) { pendingBlock = b; pendingSince = Date.now(); attempts = 1; inc("s4SealErr");
            log(`s4 seal: block ${b} reconciled but the seal call failed (${pp.status}) - retry`); break; }
          inc("s4ReconOk"); inc("s4SealOk"); if (b > lastSealed) lastSealed = b; advanced++;
        }
        if (advanced) { attempts = 0; if (!pendingBlock) pendingSince = 0; }
        return;
      }
      const r = await reconcile(N);
      if (!r.ok) {
        attempts++; if (pendingBlock !== N) { pendingBlock = N; pendingSince = Date.now(); } inc("s4ReconErr");
        // ONE BAD BLOCK MUST NOT COST HUNDREDS (measured 2026-08-31 10:46Z). A block whose recovered
        // fills cannot be evaluated used to be retried up to twenty times with backoff - ten minutes
        // with the cursor frozen, after which the clamp abandoned FOUR HUNDRED blocks. The block itself
        // is what is unreconcilable, so after a small budget it is recorded as unreconciled ON ITS OWN
        // and the cursor moves past it: the invariant is untouched (no driver in it can ever be sealed,
        // 0094 enforces that at the database) and the cost is one block instead of a whole range.
        const heldMs = pendingSince ? Date.now() - pendingSince : 0;
        if ((attempts >= BLOCK_ATTEMPTS || heldMs >= BLOCK_MS) && !/node-behind/.test(String(r.stats?.status || ""))) {
          log(`s4 seal: block ${N} could not be reconciled in ${attempts} attempts / ${Math.round(heldMs / 1000)}s (${r.stats?.status}) - recording it as unreconciled and moving on`);
          inc("s4ReconSkipped"); await post("/api/v1/fill-reconcile", { block: N, hash: null, stats: { status: "skipped-range", from: N, to: N, error: `block ${N} unreconcilable after ${attempts} attempts / ${Math.round(heldMs / 1000)}s: ${r.stats?.status}` } });
          attempts = 0; pendingBlock = null; pendingSince = 0; if (N > lastSealed) lastSealed = N;
          return;
        } if (attempts === 1 || attempts % 10 === 0) log(`s4 seal: block ${N} not reconciled (${r.stats.status}${r.stats.error ? ": " + r.stats.error : ""}) - attempt ${attempts}, retry in ${backoff()} ms`); await post("/api/v1/fill-reconcile", { block: N, hash: null, stats: r.stats }).catch(() => {}); await new Promise((res) => setTimeout(res, backoff())); return; }
      stage = "seal-post";
      const p = await post("/api/v1/fill-reconcile", { block: N, hash: r.pin, stats: r.stats });
      if (!p.ok) { attempts++; if (pendingBlock !== N) { pendingBlock = N; pendingSince = Date.now(); } inc("s4SealErr"); log(`s4 seal: block ${N} reconciled but the seal call failed (${p.status}) - retry`); await new Promise((res) => setTimeout(res, backoff())); return; }
      inc("s4ReconOk"); inc("s4SealOk"); attempts = 0; pendingBlock = null; pendingSince = 0;
      if (N > lastSealed) lastSealed = N;                                   // a through-block below the cursor must never walk it backwards
      if (through) { hub.resolveBlock?.(N); throughCount++; if (throughCount === 1 || throughCount % 25 === 0) log(`s4 seal: block ${N} reconciled THROUGH a pending range the stream could not close (${throughCount} so far) - resolved in the cursor`); }
    } catch (e) { attempts++; inc("s4ReconErr"); log(`s4 seal: tick error ${e?.message || e}`); await new Promise((res) => setTimeout(res, backoff())); }
    finally { running = false; stage = "idle"; }
  }
  const timer = setInterval(() => { tick(); }, poll); timer.unref?.();
  // THE MUTEX HAS A DEADLINE TOO. A tick that has held `running` for longer than TICK_HARD_MS is
  // abandoned: the flag is released so the next tick proceeds, the stage it died in is logged and
  // counted, and the block it was on is retried. Whatever hangs next, reconciliation continues.
  const TICK_HARD_MS = Number(process.env.COSMOS_S4_SEAL_TICK_MS) || 90_000;
  const supervisor = setInterval(() => {
    if (!running || stopped) return;
    const held = Date.now() - tickAt;
    if (held < TICK_HARD_MS) return;
    stalls++; inc("s4SealStuck");
    log(`s4 seal: tick held the worker for ${Math.round(held / 1000)}s at stage "${stage}" (block ${pendingBlock ?? lastSealed + 1}) - abandoning it so reconciliation continues (${stalls} so far)`);
    running = false; stage = "idle"; attempts++;
  }, 15_000); supervisor.unref?.();
  return { stop: () => { stopped = true; clearInterval(timer); clearInterval(supervisor); }, stats: () => ({ lastSealed, pendingBlock, pendingSince, attempts, through: throughCount, stalls, stage, behind: Math.max(0, hub.sealable() - lastSealed) }) };
}
