// STAGE 4 SHADOW - the child side. Pairs this bot's own /v1/copy-check answer (OLD PATH RESULT)
// with the hub's neutral result (NEW SHADOW RESULT) for the same fillId, classifies the pair with
// the pure classifier, and COUNTS. It never calls fastOpen, never sizes, never signs: the only
// outputs are metric increments and a bounded forensic sample sent to the runner.
//
// Delivery accounting: hub sequence numbers under a boot id let the child see a gap and ask the
// runner to replay it over IPC; results older than LATE_MS on arrival are counted late. That is
// how PRIMARY-PATH DELIVERY LOSS is measured without 106 network acks per fill.
import { classify, newPathForChild } from "./s4-compare.mjs";

export function startS4Child({ inc, send, log, ctx, warn }) {
  const PAIR_TTL_MS = Number(process.env.COSMOS_S4_PAIR_TTL_MS) || 30_000;
  const LATE_MS = Number(process.env.COSMOS_S4_LATE_MS) || 30_000;
  const SAMPLE_PER_MIN = Number(process.env.COSMOS_S4_SAMPLES_PER_MIN) || 5;
  const pairs = new Map();          // fillId -> { old, neu, t0 }
  let lastSeq = 0, lastBoot = null, sampledAt = [], mine = new Set();

  const CLS = { MATCH: "s4Match", EXPECTED: "s4Expected", OLD_PATH_BUG: "s4OldBug", NEW_PATH_BUG: "s4NewBug", TIMING_SAME: "s4TimingSame", TIMING_FLIPPED: "s4TimingFlip", OLD_MISSING: "s4OldMissing", NEW_MISSING: "s4NewMissing", UNKNOWN: "s4Unknown" };

  function settle(fillId, p) {
    pairs.delete(fillId);
    const c = ctx(p.neu?.wallet ?? p.old?.wallet, p.neu ?? null);
    const r = classify(p.old ?? null, p.neu ?? null, c);
    inc(CLS[r.cls] || "s4Unknown");
    if (r.cls !== "MATCH" && r.cls !== "EXPECTED") {
      const now = Date.now(); sampledAt = sampledAt.filter((t) => now - t < 60_000);
      if (sampledAt.length < SAMPLE_PER_MIN) {
        sampledAt.push(now);
        const nw = p.neu ? newPathForChild(p.neu, c) : null;
        send({ t: "s4sample", s: { fillId, class: r.cls, sub: r.sub, old: p.old ? { ok: p.old.ok, reason: p.old.reason, signal: p.old.signal } : null,
          new: p.neu ? { ok: nw?.ok, reason: nw?.reason, signal: nw?.signal, ledger: nw?.track?.ledger?.row ?? null, detail: r.detail ?? null, evalMs: p.neu.evalMs } : null } });
      }
    }
  }

  /** The child's own copy-check answer for a fill it handled (this is the OLD PATH RESULT). */
  function recordOld(fillId, old) {
    mine.add(fillId); if (mine.size > 5000) mine.clear();
    const p = pairs.get(fillId) ?? { t0: Date.now() };
    p.old = old; pairs.set(fillId, p);
    if (p.neu) settle(fillId, p);
  }

  /** A neutral result from the hub (NEW SHADOW RESULT). Only fills THIS child handled are paired. */
  function onMessage(m) {
    if (m?.t === "s4replay" && Array.isArray(m.items)) { inc("s4Replay"); for (const it of m.items) accept(it, true); return true; }
    if (m?.t !== "s4" || !m.neutral) return false;
    accept(m, false); return true;
  }
  function accept(m, fromReplay) {
    if (lastBoot !== m.boot) { lastBoot = m.boot; lastSeq = m.seq - 1; }
    if (!fromReplay && m.seq > lastSeq + 1) { inc("s4Gap"); send({ t: "s4gap", from: lastSeq + 1, to: m.seq - 1 }); }
    if (m.seq > lastSeq) lastSeq = m.seq;
    inc("s4Recv");
    if (Date.now() - (m.at || Date.now()) > LATE_MS) inc("s4Late");
    const n = m.neutral, fillId = n.fillId;
    if (!mine.has(fillId)) {                       // a fill this child did not handle (not its whale): no pair
      // but if the neutral says our roster follows it, the old path should have run - remember briefly
      const c = ctx(n.wallet, n); if (!c.followsWallet) return;
    }
    const p = pairs.get(fillId) ?? { t0: Date.now() };
    p.neu = { ...n, evalMs: m.evalMs }; pairs.set(fillId, p);
    if (p.old) settle(fillId, p);
  }

  // expire unpaired entries: one side never arrived
  setInterval(() => { const now = Date.now(); for (const [id, p] of pairs) if (now - p.t0 > PAIR_TTL_MS) settle(id, p); }, 5_000).unref?.();

  return { recordOld, onMessage, stats: () => ({ pending: pairs.size, lastSeq, lastBoot }) };
}
