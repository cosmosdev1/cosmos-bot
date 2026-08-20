// SIGNAL HUB (scale build, owner 2026-08-20) — the second half of the chainhub idea.
//
// THE PROBLEM, MEASURED. Every child fetched /copy-signals on its own 20s tick and then ran the
// SAME window / tier / price arithmetic over the SAME markets as every other child. Across the
// fleet that was 401,760 evaluation cycles a day against 259 actual orders — 1,551 evaluations per
// order, ~99% of them byte-identical between users. Adding machines multiplies that waste, which is
// why "more machines" was the wrong axis: the duplicated work scales with the machines.
//
// WHAT MOVES AND WHAT DOES NOT. The server now answers ONE question for everybody at
// /api/v1/copy-enterable: which markets are objectively enterable right now (inside the 30min-8h
// window, whale clears his own tier, price inside his band). This hub fetches that once per box and
// broadcasts it to the children.
//
// Everything user-specific STAYS in the child, on purpose:
//   - does this user even follow that whale
//   - his portfolio, cash, per-trade %, reserves and budgets
//   - buy-once-ever, no-adds-after-exit, per-market concentration
//   - the signature itself, which needs his key and must never be centralised
// Folding those in here would mean this process holding every user's state — exactly the fan-out
// being removed. The enterable set is tens of rows, so a child filters it to its own wallets in
// microseconds.
//
// FAILURE POSTURE. A hub that goes quiet must never look like "nothing to trade": children fall
// back to their own /copy-signals fetch after HUB_SILENCE_MS, the same contract chainwatch uses.
// Falling back costs a little duplicated work; staying deaf costs trades.

const POLL_MS = Number(process.env.COSMOS_SIGNALHUB_MS) || 10_000;
const BEAT_MS = Number(process.env.COSMOS_SIGNALHUB_BEAT_MS) || 20_000;

/**
 * @param {object} o
 * @param {() => Promise<{count:number,signals:any[]}>} o.fetchEnterable  API call, already authed
 * @param {(msg:object) => void} o.broadcast   send to every connected child
 * @param {(m:string)=>void} [o.log]
 * @param {(m:string)=>void} [o.warn]
 */
export function startSignalHub({ fetchEnterable, broadcast, log = console.log, warn = console.warn }) {
  let timer = null, beat = null, stopped = false;
  let lastOk = 0, lastCount = 0, consecutiveFails = 0;

  async function pull() {
    if (stopped) return;
    try {
      const res = await fetchEnterable();
      const signals = Array.isArray(res?.signals) ? res.signals : [];
      lastOk = Date.now();
      lastCount = signals.length;
      consecutiveFails = 0;
      // Always broadcast, including an empty set: "nothing is enterable" is a real, useful answer
      // and it keeps the children's freshness clock ticking so they do not fall back needlessly.
      broadcast({ t: "enterable", at: lastOk, signals });
    } catch (e) {
      consecutiveFails++;
      // Do NOT broadcast on failure. Silence is the signal — children fall back on their own timer
      // rather than acting on a stale or empty list we cannot vouch for.
      if (consecutiveFails <= 3 || consecutiveFails % 10 === 0) {
        warn(`signalhub: fetch failed (${consecutiveFails}x): ${e?.message ?? e}`);
      }
    }
  }

  pull();
  timer = setInterval(pull, POLL_MS);
  // A heartbeat independent of the payload: children use it to tell "hub alive, nothing enterable"
  // apart from "hub dead".
  beat = setInterval(() => { if (!stopped) broadcast({ t: "enterable-beat", at: Date.now() }); }, BEAT_MS);
  log(`signalhub: LIVE - one shared evaluation every ${POLL_MS / 1000}s for this whole box`);

  return {
    stop() { stopped = true; if (timer) clearInterval(timer); if (beat) clearInterval(beat); },
    stats: () => ({ lastOk, lastCount, consecutiveFails, ageMs: lastOk ? Date.now() - lastOk : null }),
  };
}
