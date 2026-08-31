// STAGE 4 SHADOW - the child side. Pairs this bot's own /v1/copy-check answer (OLD PATH RESULT)
// with the hub's neutral result (NEW SHADOW RESULT) for the same fillId, classifies the pair with
// the pure classifier, and COUNTS. It never calls fastOpen, never sizes, never signs: the only
// outputs are metric increments and a bounded forensic sample sent to the runner.
//
// Delivery accounting: hub sequence numbers under a boot id let the child see a gap and ask the
// runner to replay it over IPC; results older than LATE_MS on arrival are counted late. That is
// how PRIMARY-PATH DELIVERY LOSS is measured without 106 network acks per fill.
import { classify, newPathForChild, authoritativeForChild } from "./s4-compare.mjs";
import * as authority from "./s4-authority.mjs";

export function startS4Child({ inc, send, log, ctx, warn }) {
  // The old path can take up to ~32 s to answer (8 s timeout x3 with 1.5 s and 6 s backoffs), so a
  // 30 s pairing window manufactured OLD_MISSING; 60 s covers the worst case with margin.
  const PAIR_TTL_MS = Number(process.env.COSMOS_S4_PAIR_TTL_MS) || 60_000;
  const LATE_MS = Number(process.env.COSMOS_S4_LATE_MS) || 30_000;
  const SAMPLE_PER_MIN = Number(process.env.COSMOS_S4_SAMPLES_PER_MIN) || 5;
  const pairs = new Map();          // fillId -> { old, neu, t0 }
  // CANARY (owner 2026-08-30): the wallets for which Stage 4 is AUTHORITATIVE for this child's
  // execution. Served by the roster every minute, so removing a wallet reverts that whale to the old
  // path within one cycle with no deploy. Empty = pure shadow, which is what every other whale stays.
  const canary = new Set();
  const answers = new Map();        // fillId -> neutral, bounded: neutrals that arrived before the ask
  const askers = new Map();         // fillId -> [fn] waiting for the neutral
  let lastSeq = 0, lastBoot = null, sampledAt = [], mine = new Set(), gapLoggedAt = 0, oldBugN = 0, rowSameN = 0;

  const CLS = { MATCH: "s4Match", EXPECTED: "s4Expected", OLD_PATH_BUG: "s4OldBug", NEW_PATH_BUG: "s4NewBug", TIMING_SAME: "s4TimingSame", TIMING_FLIPPED: "s4TimingFlip", TIMING_ROWSTATE_SAME: "s4RowSame", TIMING_ROWSTATE_FLIPPED: "s4RowFlip", TIMING_COMPOUND_SAME: "s4CompSame", TIMING_COMPOUND_FLIPPED: "s4CompFlip", TIMING_DRIVER_RACE_FLIPPED: "s4DriverRace", EXPECTED_GATE_ORDER: "s4GateOrder", STALE_USER_CONTEXT: "s4Stale", OLD_MISSING: "s4OldMissing", NEW_MISSING: "s4NewMissing", UNKNOWN: "s4Unknown" };

  function settle(fillId, p) {
    pairs.delete(fillId);
    const c = ctx(p.neu?.wallet ?? p.old?.wallet, p.neu ?? null);
    // A comparison needs to know which horizon applies. Without an authoritative execution mode the
    // two paths are not answering the same question, and classifying anyway manufactures a
    // hosted/horizon contradiction out of a rollout gap.
    if (c.modeKnown === false) { inc("s4ModeUnknown"); return; }
    const r = classify(p.old ?? null, p.neu ?? null, c);
    inc(CLS[r.cls] || "s4Unknown");
    if (r.cls === "OLD_PATH_BUG") inc(r.sub === "BALANCE_LATEST_STALE_ZERO" ? "s4OldBugBalance" : r.sub === "ACCUMULATE_SHARE_MULTIPLE" ? "s4OldBugShare" : r.sub === "ACCUMULATE_COST_RESCALE" ? "s4OldBugCost" : "s4OldBugPeak");
    // OLD_PATH_BUG is proven and abundant; sample it at 1 in 10 so the rare classes get the channel
    oldBugN = r.cls === "OLD_PATH_BUG" ? oldBugN + 1 : oldBugN;
    rowSameN = r.cls === "TIMING_ROWSTATE_SAME" ? rowSameN + 1 : rowSameN;
    if (r.cls !== "MATCH" && r.cls !== "EXPECTED" && r.cls !== "EXPECTED_GATE_ORDER" && (r.cls !== "OLD_PATH_BUG" || oldBugN % 10 === 0) && (r.cls !== "TIMING_ROWSTATE_SAME" || rowSameN % 10 === 0)) {
      const now = Date.now(); sampledAt = sampledAt.filter((t) => now - t < 60_000);
      if (sampledAt.length < SAMPLE_PER_MIN) {
        sampledAt.push(now);
        const nw = p.neu ? newPathForChild(p.neu, c) : null;
        send({ t: "s4sample", s: { fillId, class: r.cls, sub: r.sub, old: p.old ? { ok: p.old.ok, reason: p.old.reason, signal: p.old.signal } : null,
          new: p.neu ? { ok: nw?.ok, reason: nw?.reason, signal: nw?.signal, ledger: nw?.track?.ledger?.row ?? null, detail: r.detail ?? null, evalMs: p.neu.evalMs } : null } });
      }
    }
  }

  function setCanary(list) {
    const next = new Set((Array.isArray(list) ? list : []).map((w) => String(w || "").toLowerCase()).filter((w) => /^0x[a-f0-9]{40}$/.test(w)));
    let changed = next.size !== canary.size; if (!changed) for (const w of next) if (!canary.has(w)) { changed = true; break; }
    if (!changed) return false;
    canary.clear(); for (const w of next) canary.add(w);
    authority.setCanary([...canary]);                 // the polled tick reads the same list
    log(`s4 canary: ${canary.size ? [...canary].map((w) => w.slice(0, 10)).join(" ") : "(none - pure shadow)"}`);
    return true;
  }
  const isCanary = (wallet) => canary.has(String(wallet || "").toLowerCase());
  /** the authoritative answer for one fill, in the shape the old copy-check returns */
  function answerFrom(neutral, wallet) {
    const c = ctx(wallet ?? neutral.wallet, neutral);
    const a = authoritativeForChild(neutral, c);
    return { ok: Boolean(a.ok), reason: a.ok ? null : (a.reason ?? "skip"), signal: a.ok ? a.signal : null, source: "s4", group: c.group };
  }
  /**
   * Wait up to `ms` for the shared evaluation of `fillId`. Resolves with the authoritative answer, or
   * NULL if it did not arrive - the caller then falls back to the old path, so a hub problem can never
   * cost a fill. Only ever called for a canary whale.
   */
  function awaitAnswer(fillId, wallet, ms) {
    const have = answers.get(fillId);
    if (have) return Promise.resolve(answerFrom(have, wallet));
    return new Promise((resolve) => {
      let done = false;
      const fn = (neutral) => { if (done) return; done = true; clearTimeout(timer); resolve(answerFrom(neutral, wallet)); };
      const timer = setTimeout(() => {
        if (done) return; done = true;
        const arr = askers.get(fillId) || []; const ix = arr.indexOf(fn); if (ix >= 0) arr.splice(ix, 1);
        resolve(null);
      }, ms);
      // NOT unref'd: this timer is the fallback that hands the fill back to the old path, so it must
      // fire even if nothing else keeps the loop alive.
      if (!askers.has(fillId)) askers.set(fillId, []);
      askers.get(fillId).push(fn);
    });
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
    if (m?.t === "s4canary") { setCanary(m.list); return true; }
    if (m?.t === "s4replay" && Array.isArray(m.items)) { inc("s4Replay"); for (const it of m.items) accept(it, true); return true; }
    if (m?.t !== "s4" || !m.neutral) return false;
    accept(m, false); return true;
  }
  function accept(m, fromReplay) {
    if (lastBoot !== m.boot) { lastBoot = m.boot; lastSeq = m.seq - 1; }
    if (!fromReplay && m.seq > lastSeq + 1) {
      inc("s4Gap"); send({ t: "s4gap", from: lastSeq + 1, to: m.seq - 1 });
      // DIAGNOSTIC (rate-limited): the first shadow hours counted ~11k gaps per 10 min against ~500
      // sends, and replays returned almost nothing - the numbers do not add up. Log the raw facts.
      if (Date.now() - gapLoggedAt > 120_000) { gapLoggedAt = Date.now(); log(`s4 gap: lastSeq ${lastSeq} got ${m.seq} boot ${m.boot} lastBoot ${lastBoot} replay=${fromReplay}`); }
    }
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
    // canary: hand the neutral to whoever is waiting to EXECUTE on it, and remember it briefly for a
    // fill whose ask has not happened yet (the hub is usually faster than the old path)
    if (canary.size && canary.has(String(n.wallet || "").toLowerCase())) {
      answers.set(fillId, p.neu);
      if (answers.size > 2000) { const cut = Date.now() - 120_000; for (const [k, v] of answers) if ((v?.evaluatedAt ?? 0) < cut) answers.delete(k); if (answers.size > 4000) answers.clear(); }
      const arr = askers.get(fillId); if (arr && arr.length) { askers.delete(fillId); for (const fn of arr) { try { fn(p.neu); } catch { /* one waiter must not break the rest */ } } }
    }
    if (p.old) settle(fillId, p);
  }

  // expire unpaired entries: one side never arrived
  setInterval(() => { const now = Date.now(); for (const [id, p] of pairs) if (now - p.t0 > PAIR_TTL_MS) settle(id, p); }, 5_000).unref?.();

  const lastNeutral = (fillId) => answers.get(fillId) || pairs.get(fillId)?.neu || null;
  return { recordOld, onMessage, isCanary, setCanary, awaitAnswer, lastNeutral, stats: () => ({ pending: pairs.size, lastSeq, lastBoot, canary: canary.size }) };
}
