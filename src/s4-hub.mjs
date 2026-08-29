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

export function startS4Hub({ api, secret, broadcast, log, inc, mode }) {
  const BOOT = randomBytes(4).toString("hex");
  const DEPTH = Number(process.env.COSMOS_S4_QUEUE_DEPTH) || 200;
  const CONC = Number(process.env.COSMOS_S4_CONCURRENCY) || 8;
  const MAX_AGE_MS = Number(process.env.COSMOS_S4_MAX_AGE_MS) || 5_000;
  const RING = Number(process.env.COSMOS_S4_RING) || 2_000;
  const TIMEOUT_MS = Number(process.env.COSMOS_S4_TIMEOUT_MS) || 6_000;
  const queue = [];           // {fill, at}
  const ring = [];            // {seq, boot, neutral} newest last
  const samples = [];         // forwarded child samples, drained by flushMetrics
  let seq = 0, inflight = 0, consecutiveFails = 0, breakerUntil = 0;

  const enabled = () => { const m = mode(); return m === "shadow" || m === "canary" || m === "on"; };

  function onFills(list) {
    if (!enabled() || !list?.length) return;
    for (const f of list) {
      if (queue.length >= DEPTH) { inc("s4Overflow"); continue; }
      queue.push({ fill: f, at: Date.now() });
    }
    pump();
  }

  function pump() {
    while (inflight < CONC && queue.length) {
      const item = queue.shift();
      if (Date.now() - item.at > MAX_AGE_MS) { inc("s4Overflow"); continue; }   // too old: live would fall back
      inflight++;
      evalOne(item.fill).finally(() => { inflight--; pump(); });
    }
  }

  async function evalOne(f) {
    if (Date.now() < breakerUntil) { inc("s4Overflow"); return; }   // skipped by the breaker: not an eval failure
    // The sequence is assigned at BROADCAST time, not at attempt time: a seq minted here for an
    // evaluation that then fails would never be sent, and every child would see a phantom gap and
    // ask for a replay the ring cannot answer (measured: 12,199 gaps in ten minutes on 432 sends).
    let res = null;
    for (let a = 0; a < 2; a++) {
      inc("s4EvalAttempt");
      try {
        const r = await fetch(`${api}/api/v1/fill-eval`, {
          method: "POST", headers: { "content-type": "application/json", "x-runner-secret": secret }, signal: AbortSignal.timeout(TIMEOUT_MS),
          body: JSON.stringify({ fillId: f.fillId, hubSeq: seq + 1, bootId: BOOT, block: f.block, wallet: f.wallet, tokenId: f.tokenId, shares: f.shares }),
        });
        if (r.status === 503 || r.status >= 500) throw new Error(`fill-eval ${r.status}`);
        if (!r.ok) { log(`s4: fill-eval refused ${r.status} for ${f.fillId.slice(0, 18)}`); inc("s4EvalFail"); return; }   // 4xx: not retryable
        res = await r.json(); break;
      } catch (e) {
        if (a === 1) { inc("s4EvalFail"); if (++consecutiveFails >= 3) { breakerUntil = Date.now() + 60_000; log("s4: 3 consecutive eval failures - shadow paused 60s"); } return; }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    consecutiveFails = 0;
    inc("s4EvalOk"); inc(res.existed ? "s4EvalDup" : "s4EvalFull");
    const mySeq = ++seq;                                   // contiguous by construction: only broadcasts consume a number
    const msg = { t: "s4", seq: mySeq, boot: BOOT, at: Date.now(), evalMs: res.evalMs, neutral: res.neutral };
    ring.push(msg); if (ring.length > RING) ring.splice(0, ring.length - RING);
    inc("s4Sent");
    broadcast(msg);
  }

  /** A child saw a gap: send it the ring entries in [from, to] (bounded, in process). */
  function replay(child, from, to) {
    const out = ring.filter((m) => m.seq >= from && m.seq <= to).slice(0, 500);
    try { child.send({ t: "s4replay", boot: BOOT, items: out }); } catch { /* child gone */ }
    return out.length;
  }

  /** A child forwards a bounded discrepancy sample; kept for the next metrics flush. */
  function sample(s) { if (samples.length < 100) samples.push(s); }
  function drainSamples(n = 20) { return samples.splice(0, n); }

  function stats() { return { boot: BOOT, seq, queued: queue.length, inflight, ring: ring.length, breaker: Date.now() < breakerUntil, mode: mode() }; }

  return { onFills, replay, sample, drainSamples, stats, boot: BOOT };
}
