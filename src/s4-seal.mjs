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
  let lastSealed = 0, pendingBlock = null, attempts = 0, running = false, stopped = false, started = false;
  const RPC_TIMEOUT = Number(process.env.COSMOS_S4_RECON_TIMEOUT_MS) || 8_000;
  const MAX_BEHIND = Number(process.env.COSMOS_S4_RECON_MAX_BEHIND) || 50;   // on boot, never try to reconcile more than this many blocks back
  const backoff = () => Math.min(30_000, 1_000 * 2 ** Math.min(attempts, 5));

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
  async function reconcile(N) {
    const t0 = Date.now(); const stats = { status: "ok", head_seen_at: hub.headSeenAt?.(N + 1) ? new Date(hub.headSeenAt(N + 1)).toISOString() : null, recon_start_at: new Date(t0).toISOString() };
    // 1. node height
    const height = await hub.rpcBlockNumber(RPC_TIMEOUT);
    if (!Number.isFinite(height) || height < N + 1) return { ok: false, stats: { ...stats, status: "node-behind", error: `node at ${height}` } };
    // 2. identity
    const header = await hub.rpcBlockHeader(N, RPC_TIMEOUT);
    if (!header?.hash) return { ok: false, stats: { ...stats, status: "no-header", error: "eth_getBlockByNumber returned nothing" } };
    const seenHash = hub.headHash?.(N) || null;
    if (seenHash && seenHash !== String(header.hash).toLowerCase()) return { ok: false, stats: { ...stats, status: "hash-mismatch", error: `stream ${seenHash.slice(0, 12)} vs node ${String(header.hash).slice(0, 12)}` } };
    const pin = String(header.hash).toLowerCase();
    // 3. logs pinned to the hash, the hub's exact filter
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
      const results = await s4.evaluateNow(missing, { origin: "reconcile" });
      if (results.some((r) => !r.ok)) return { ok: false, stats: { ...stats, status: "missing-eval-failed", rpc_ms: rpcMs, logs: logs.length, fills: fills.length, missing: missing.length, duplicates: dup, error: "a recovered fill failed to evaluate" } };
    }
    if (dup) inc("s4ReconDup", dup);
    return { ok: true, pin, stats: { ...stats, logs: logs.length, fills: fills.length, missing: missing.length, duplicates: dup, rpc_ms: rpcMs, recon_done_at: new Date().toISOString(), unpinned: !seenHash || undefined } };
  }

  async function tick() {
    if (running || stopped) return; running = true;
    try {
      if (!started) { await boot(); if (!started) return; }
      const sealable = hub.sealable();
      if (!(sealable > lastSealed)) return;
      // never fall further behind than MAX_BEHIND (a long stall, a stuck block after many retries): the
      // skipped range is a KNOWN unreconciled gap, logged and counted, never silently sealed
      if (sealable - lastSealed > MAX_BEHIND && !(pendingBlock && attempts < 20)) { const from = lastSealed + 1, to = sealable - MAX_BEHIND; log(`s4 seal: ${to - from + 1} blocks (${from}-${to}) left unreconciled - too far behind; resuming at ${to + 1}`); inc("s4ReconSkipped", to - from + 1); await post("/api/v1/fill-reconcile", { block: to, hash: null, stats: { status: "skipped-range", from, to, error: `behind by ${sealable - lastSealed}` } }).catch(() => {}); lastSealed = to; pendingBlock = null; attempts = 0; }
      const N = pendingBlock ?? lastSealed + 1;
      if (N > sealable) return;
      const r = await reconcile(N);
      if (!r.ok) { attempts++; pendingBlock = N; inc("s4ReconErr"); if (attempts === 1 || attempts % 10 === 0) log(`s4 seal: block ${N} not reconciled (${r.stats.status}${r.stats.error ? ": " + r.stats.error : ""}) - attempt ${attempts}, retry in ${backoff()} ms`); await post("/api/v1/fill-reconcile", { block: N, hash: null, stats: r.stats }).catch(() => {}); await new Promise((res) => setTimeout(res, backoff())); return; }
      const p = await post("/api/v1/fill-reconcile", { block: N, hash: r.pin, stats: r.stats });
      if (!p.ok) { attempts++; pendingBlock = N; inc("s4SealErr"); log(`s4 seal: block ${N} reconciled but the seal call failed (${p.status}) - retry`); await new Promise((res) => setTimeout(res, backoff())); return; }
      inc("s4ReconOk"); inc("s4SealOk"); attempts = 0; pendingBlock = null; lastSealed = N;
    } catch (e) { attempts++; inc("s4ReconErr"); log(`s4 seal: tick error ${e?.message || e}`); await new Promise((res) => setTimeout(res, backoff())); }
    finally { running = false; }
  }
  const timer = setInterval(() => { tick(); }, poll); timer.unref?.();
  return { stop: () => { stopped = true; clearInterval(timer); }, stats: () => ({ lastSealed, pendingBlock, attempts, behind: Math.max(0, hub.sealable() - lastSealed) }) };
}
