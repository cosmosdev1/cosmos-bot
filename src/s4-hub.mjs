// STAGE 4 SHADOW - the hub side. Lives in the runner (one per box). For every qualifying fill the
// chainhub receives it calls /api/v1/fill-eval ONCE under service auth, broadcasts the NEUTRAL
// result to every child tagged with a monotonic sequence, and keeps a bounded ring so a child that
// detects a gap can ask for the missing results over the same in-process IPC - no network acks.
//
// IN SHADOW MODE THIS CANNOT TRADE. Children receive {t:"s4"} messages and only COMPARE them with
// their own /v1/copy-check answer (src/s4-child.mjs). The raw {t:"log"} broadcast that drives
// today's path is untouched and still sent first. Mode comes from the roster (s4_mode) each
// minute; "off" stops the calls without a restart.
//
// Queue: FIFO by hubSeq, depth 200, concurrency 8, max age 5 s. A fill the queue cannot take is
// COUNTED (s4Overflow) - in shadow nothing is lost because the old path ran anyway; live, this is
// where the immediate raw-log fallback would go (docs/stage4-design-addendum.md §9).
import { randomBytes } from "node:crypto";
import * as diag from "./rpc-diag.mjs";

export function startS4Hub({ api, secret, broadcast, log, inc, mode, sealable = () => 0, gapOpen = () => false, followers = () => 0 }) {
  const BOOT = randomBytes(4).toString("hex");
  const DEPTH = Number(process.env.COSMOS_S4_QUEUE_DEPTH) || 200;
  const CONC = Number(process.env.COSMOS_S4_CONCURRENCY) || 8;
  const MAX_AGE_MS = Number(process.env.COSMOS_S4_MAX_AGE_MS) || 5_000;
  const RING = Number(process.env.COSMOS_S4_RING) || 2_000;
  const TIMEOUT_MS = Number(process.env.COSMOS_S4_TIMEOUT_MS) || 6_000;
  const queue = [];           // {fill, at}  arrival order; evaluations of any token run concurrently
  // SERIALIZE AUTHORITY, NOT COMPUTATION (owner 2026-08-30): the per-token FIFO is gone. The ledger
  // state is a pure function of the contribution SET folded in chain order (0093) and the driver's
  // final state is order-independent (confluence proven); only the SEAL is ordered, and block
  // reconciliation owns it. Measured before: a 147-fill minute produced 50 overflows from same-token
  // fills aging behind each other.
  let maxBlockSeen = 0;               // highest block delivered on the stream (diagnostic)
  const evaluated = new Map();        // fillId -> block, bounded: what the hub has committed (the reconciliation diff)
  const waiters = new Map();          // fillId -> [resolve] for evaluateNow()
  const queued = new Set();           // fillIds queued or in flight: an inclusive backfill replay must not evaluate twice (owner 2026-08-30)
  const remember = (fillId, block) => { evaluated.set(fillId, block); if (evaluated.size > 20000) { const cut = maxBlockSeen - 400; for (const [k, b] of evaluated) if (b < cut) evaluated.delete(k); } };
  const ring = [];            // {seq, boot, neutral} newest last
  const samples = [];         // forwarded child samples, drained by flushMetrics
  let seq = 0, inflight = 0, consecutiveFails = 0, breakerUntil = 0, replayLoggedAt = 0, hung = 0;
  const HARD_MS = 2 * TIMEOUT_MS + 2_000;   // two attempts + the retry pause, then the slot is freed regardless

  const enabled = () => { const m = mode(); return m === "shadow" || m === "canary" || m === "on"; };
  setInterval(() => { try { if (enabled() && gapOpen()) inc("s4GapSec10"); } catch { /* counters only */ } }, 10_000).unref?.();   // known-gap duration of the seal cursor, 10 s units

  function onFills(list) {
    if (!enabled() || !list?.length) return;
    for (const f of list) {
      if (Number.isFinite(Number(f.block)) && Number(f.block) > maxBlockSeen) maxBlockSeen = Number(f.block);
      // RECEIPT DEDUPE (owner 2026-08-30): the reconnect backfill now replays the last observed block inclusively,
      // so a fill the hub already committed - or is evaluating right now - arrives again; it is dropped here
      // (counted as a duplicate), never re-posted. The ledger PK stays the last line of defence.
      if (evaluated.has(f.fillId) || queued.has(f.fillId)) { inc("s4EvalDup"); continue; }
      if (queue.length >= DEPTH) { inc("s4Overflow"); continue; }
      queued.add(f.fillId);
      queue.push({ fill: f, at: Date.now() });
    }
    pump();
  }

  function pump() {
    while (inflight < CONC && queue.length) {
      const item = queue.shift();
      if (Date.now() - item.at > MAX_AGE_MS) { inc("s4Overflow"); inc("s4OverflowCc", followers(item.fill.wallet)); settle(item.fill.fillId, false); continue; }   // too old: live would fall back; the legacy copy-checks that fallback would cost
      inflight++;
      // WEDGE GUARD (2026-08-30): the slot is released by a hard deadline, never only by the promise.
      // AND THE WAITER IS SETTLED WITH IT (2026-08-30, second incident): freeing the slot without
      // settling left `evaluateNow` waiting for ever, which wedged the SEAL WORKER's tick - one hung
      // evaluation stopped reconciliation and sealing for 28 minutes with no error anywhere.
      // Measured: all 8 slots hung at 00:14Z and every fill for six hours was counted as overflow
      // with zero attempts. The hung-await rule: no await without a deadline that frees the resource.
      let released = false;
      const stage = { at: "queued" };
      const release = () => { if (released) return; released = true; inflight--; pump(); };
      const timer = setTimeout(() => { if (!released) { hung++; inc("s4Hung"); inc("s4EvalFail"); inc(stage.at === "fetch" ? "s4HungFetch" : stage.at === "json" ? "s4HungJson" : "s4HungBcast");
        // WHICH TRANSPORT PHASE (owner 2026-09-03). Our stage says which await we were sitting in;
        // this says what the socket had actually completed underneath it.
        const dr = diag.byLabel(`s4eval:${item.fill.fillId}`);
        inc(!dr ? "s4HungPhaseUnknown" : dr.classification === "headers_arrived_body_incomplete" ? "s4HungAtBody" : dr.classification === "body_complete_parse_stalled" ? "s4HungAtParse" : dr.classification === "request_sent_no_response_headers" ? "s4HungAtSend" : "s4HungAtConnect");
        log(`s4: evaluation of ${item.fill.fillId.slice(0, 18)} hung past ${HARD_MS} ms at stage ${stage.at} · transport ${dr ? `${dr.classification} (last ${dr.lastPhase}, age ${Math.round(dr.ageMs)}ms)` : "no record"} - slot released`); settle(item.fill.fillId, false); settle(item.fill.fillId, false); release(); } }, HARD_MS);
      evalOne(item.fill, Date.now() - item.at, item.at, stage).then((ok) => settle(item.fill.fillId, ok !== false)).catch((e) => { log(`s4: evalOne threw ${e?.message || e}`); settle(item.fill.fillId, false); }).finally(() => { clearTimeout(timer); release(); });
    }
  }

  function settle(fillId, ok) { queued.delete(fillId); const w = waiters.get(fillId); if (w) { waiters.delete(fillId); for (const r of w) r({ fillId, ok }); } }
  /** evaluate fills the stream never delivered (found by block reconciliation) through the normal path; resolves when committed */
  function evaluateNow(list, { origin = "reconcile" } = {}) {
    return Promise.all(list.map((f) => new Promise((resolve) => {
      if (evaluated.has(f.fillId)) return resolve({ fillId: f.fillId, ok: true, existed: true });
      if (!waiters.has(f.fillId)) waiters.set(f.fillId, []); waiters.get(f.fillId).push(resolve);
      if (queued.has(f.fillId)) return;                                   // already queued / in flight: its settle answers this waiter too
      queued.add(f.fillId);
      queue.push({ fill: { ...f, origin }, at: Date.now() }); pump();
    })));
  }
  async function evalOne(f, queuedMs = 0, seenAt = Date.now(), stage = { at: "queued" }) {
    if (Date.now() < breakerUntil) { inc("s4Overflow"); return; }   // skipped by the breaker: not an eval failure
    // The sequence is assigned at BROADCAST time, not at attempt time: a seq minted here for an
    // evaluation that then fails would never be sent, and every child would see a phantom gap and
    // ask for a replay the ring cannot answer (measured: 12,199 gaps in ten minutes on 432 sends).
    let res = null;
    for (let a = 0; a < 2; a++) {
      inc("s4EvalAttempt");
      try {
        stage.at = "fetch";
        // Labelled so the watchdog above can ask the socket diagnostics WHERE this stopped. Observation
        // only: the fetch, its timeout and its error propagation are unchanged.
        const r = await diag.label(`s4eval:${f.fillId}`, () => fetch(`${api}/api/v1/fill-eval`, {
          method: "POST", headers: { "content-type": "application/json", "x-runner-secret": secret }, signal: AbortSignal.timeout(TIMEOUT_MS),
          body: JSON.stringify({ fillId: f.fillId, hubSeq: seq + 1, bootId: BOOT, block: f.block, wallet: f.wallet, tokenId: f.tokenId, shares: f.shares, queuedMs, seenAt, contiguousBlock: sealable() > 0 ? sealable() : null }),
        }));
        if (r.status === 503 || r.status >= 500) throw new Error(`fill-eval ${r.status}`);
        if (!r.ok) { log(`s4: fill-eval refused ${r.status} for ${f.fillId.slice(0, 18)}`); inc("s4EvalFail"); return false; }   // 4xx: not retryable
        stage.at = "json";
        res = await r.json(); break;
      } catch (e) {
        if (a === 1) { inc("s4EvalFail"); if (++consecutiveFails >= 3) { breakerUntil = Date.now() + 60_000; log("s4: 3 consecutive eval failures - shadow paused 60s"); } return false; }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    consecutiveFails = 0;
    inc("s4EvalOk"); inc(res.existed ? "s4EvalDup" : "s4EvalFull");
    remember(f.fillId, Number(f.block) || 0);
    stage.at = "broadcast";
    const mySeq = ++seq;                                   // contiguous by construction: only broadcasts consume a number
    const msg = { t: "s4", seq: mySeq, boot: BOOT, at: Date.now(), evalMs: res.evalMs, neutral: res.neutral };
    ring.push(msg); if (ring.length > RING) ring.splice(0, ring.length - RING);
    inc("s4Sent");
    broadcast(msg);
    return true;
  }

  /** A child saw a gap: send it the ring entries in [from, to] (bounded, in process). */
  function replay(child, from, to) {
    const out = ring.filter((m) => m.seq >= from && m.seq <= to).slice(0, 500);
    if (Date.now() - replayLoggedAt > 120_000) { replayLoggedAt = Date.now(); log(`s4 replay: asked ${from}..${to} · ring ${ring.length ? `${ring[0].seq}..${ring[ring.length - 1].seq}` : "empty"} · returned ${out.length} · seq now ${seq}`); }
    try { child.send({ t: "s4replay", boot: BOOT, items: out }); } catch { /* child gone */ }
    return out.length;
  }

  /**
   * A child forwards a bounded discrepancy sample; kept for the next metrics flush. PER-CLASS FAIR
   * (2026-08-30): the first epoch reading showed 1,376 UNKNOWN with zero samples behind them - the
   * buffer filled with OLD_PATH_BUG, the most common class, before anything rarer arrived. Each
   * class now keeps its own bounded slot and the drain takes round-robin, so the rare classes that
   * decide the gate are always represented.
   */
  const PER_CLASS = Number(process.env.COSMOS_S4_SAMPLES_PER_CLASS) || 25;
  const byClass = new Map();
  function sample(s) { const k = String(s?.class || "?"); const arr = byClass.get(k) || []; if (arr.length < PER_CLASS) { arr.push(s); byClass.set(k, arr); } }
  function drainSamples(n = 20) {
    const out = [];
    while (out.length < n) {
      let took = false;
      for (const arr of byClass.values()) { if (arr.length && out.length < n) { out.push(arr.shift()); took = true; } }
      if (!took) break;
    }
    return out;
  }

  function stats() { return { boot: BOOT, seq, queued: queue.length, inflight, evaluated: evaluated.size, maxBlockSeen, sealable: sealable(), hung, ring: ring.length, breaker: Date.now() < breakerUntil, mode: mode(), samples: [...byClass.entries()].map(([k, v]) => `${k}:${v.length}`).join(",") }; }

  return { onFills, evaluateNow, hasEvaluated: (id) => evaluated.has(id), replay, sample, drainSamples, stats, boot: BOOT };
}
