// OPPORTUNITY TRACE (Phase 3A) — why does the polled path not produce an order?
//
// THE UNIT IS AN OPPORTUNITY, NEVER A TICK. One (user, token, generation) is evaluated by the
// 20-second loop up to ~500 times inside a single 2.75-hour entry window. Writing a row per
// evaluation is exactly what turned scan_runs into a 3.7M-row problem, so this module keeps the
// state in memory and emits ONLY when the summary tuple actually changes. An opportunity that is
// blocked for the same reason 500 times in a row emits exactly one row.
//
// ATTEMPTS ARE THE EXCEPTION. An opportunity can be attempted several times with a different book,
// cap and limit each time, and "attempt 1 zero-filled, attempt 2 filled" is precisely the evidence
// this phase exists to collect. So attempts are kept as a bounded ARRAY on the opportunity, never
// collapsed to the last one and never expanded into tick-level rows.
//
// SAFETY CONTRACT — this file may never affect trading:
//   * every exported entry point is total: it catches its own errors and returns a no-op handle;
//   * it holds no locks and NEVER AWAITS — see the book probe below, which is fire-and-forget;
//   * the buffer is bounded and drops oldest-first, so a stalled flush cannot grow memory;
//   * nothing it records is a secret: no keys, no signatures, no funder/signer addresses, no tokens.
//
// THE BOOK PROBE IS NOT ON THE MONEY PATH. An earlier draft awaited a fresh order-book read between
// the market lock and placeWithRetry. That was wrong: it inserted a network round-trip after a
// trading-state mutation and before the order, so it added order-send latency, let the book move
// under the order, and could change the very FAK outcome being measured. The probe is now started
// and immediately abandoned; whatever it returns is attached afterwards and labelled
// NEAR-contemporaneous, with the timing recorded so the analysis can tell how near.

/** Furthest point an opportunity reached. Ordinal so `max` is meaningful; gaps left for insertions. */
export const STAGE = Object.freeze({
  SEEN: 5,               // the row was iterated by the engine at all
  HUB_ENTERABLE: 10,     // survived the shared enterable filter (or the hub was not fresh)
  DRIVER_PICKED: 15,     // driven by a whale this user follows
  ENGINE_READY: 20,      // engine armed, cycle state present, not budget-paused
  TIER_RESOLVED: 25,     // a tier percentage was resolved for this whale + market
  TARGET_SIZED: 30,      // target USD computed and above the exchange minimum
  HOLDING_RESOLVED: 35,  // decided new-position vs top-up, buy-once / no-rebuy cleared
  WINDOW_OPEN: 40,       // inside the live entry window (candles: exempt)
  PRICED: 45,            // a fresh mid was obtained and sat inside the entry band
  PRICE_GATE_PASS: 50,   // within 20% (floor 5c) of the whale's average entry
  LOCAL_GUARDS_PASS: 55, // cooldown, in-flight, floor guard, cash, risk clamp all cleared
  SIGN_REQUESTED: 60,    // an order was actually handed to the sign path
  SIGNED: 65,            // the enclave signed it
  FILLED: 70,            // the venue matched something
});
const STAGE_NAME = Object.fromEntries(Object.entries(STAGE).map(([k, v]) => [v, k.toLowerCase()]));

/**
 * Blocker classes. `true` = the opportunity can never progress again (TERMINAL);
 * `false` = it may progress on a later evaluation (transient).
 *
 * TERMINAL IS A STRONG CLAIM and is audited against the engine, not assumed from the name: it holds
 * only when no state transition reachable while this opportunity is still alive can make it
 * eligible again. Two classes that read terminal are NOT, and are marked accordingly:
 *
 *   driver_not_picked  the roster is re-read from the server every 5 minutes (refreshMyWallets),
 *                      and an entry window runs up to 2.75 hours. A user adding a whale mid-window
 *                      revives the opportunity. Independently, sig.wallets GROWS as more whales
 *                      enter, so a whale this user already follows joining later flips the same
 *                      test. Two separate revival routes; not terminal.
 *
 *   window_dead        derived from wallets[0].event_at with end_date as fallback. Both are feed
 *                      values that can MOVE — a postponed fixture pushes the event later, and the
 *                      identity of wallets[0] can change outright. Time only moves one way, but
 *                      this clock does not. Not terminal.
 *
 * Genuinely terminal, verified in the engine:
 *   buy_once           `seen` is written and persisted (saveSeen) and never deleted or reset.
 *   no_rebuy           sell_seq only increases within one generation; a reset means a new gen,
 *                      which is by definition a different opportunity.
 *
 * Anything not listed is recorded verbatim and treated as transient, so an unknown reason is
 * visible rather than swallowed into a generic bucket.
 */
export const BLOCKERS = Object.freeze({
  hub_not_enterable: false,
  enterable_set_stale: false,
  driver_not_picked: false,   // roster refreshes every 5 min, and sig.wallets grows — see above
  engine_off: false,
  budget_paused: false,
  no_cycle_state: false,
  tier_zero: false,           // his money-in can still cross a threshold
  target_below_min: false,
  already_holding: false,     // the top-up branch takes over
  buy_once: true,             // `seen` is persisted and never cleared
  no_rebuy: true,             // sell_seq is monotone within a generation
  window_wait: false,         // too early - the whole point of the waiting design
  window_dead: false,         // the event clock can move later — see above
  s4_marker_suppressed: false,
  cash_insufficient: false,
  price_out_of_band: false,   // the fresh mid was outside cap/floor
  price_gate: false,          // outside 20% of his average
  cooldown: false,
  inflight: false,
  rate_limited: false,
  exposure_cap: false,
  venue_backoff: false,
  local_floor: false,         // the 2G entry-floor guard
  risk_clamp_zero: false,
  reserve_blocked: false,
  add_below_min: false,
  add_driver_mismatch: false,
  max_open: false,
  pre_game_closed: false,
  portfolio_floor: false,
  sign_not_called: false,
  venue_zero_fill: false,
  unexplained: false,
});
export const isTerminal = (b) => BLOCKERS[String(b).split(":")[0]] === true;

const DEF_MAX_TRACKED = Number(process.env.COPY_TRACE_MAX ?? 4000);
const DEF_MAX_BUFFER = Number(process.env.COPY_TRACE_BUFFER ?? 400);
const DEF_SUB_SAMPLE = Number(process.env.COPY_TRACE_SAMPLE ?? 8);   // 1-in-N below WINDOW_OPEN

// Attempt history bound. Attempts are naturally bounded by the engine, not by this constant: a new
// position is one attempt, and top-ups are gated by a 60s cooldown, MIN_ADD_USD and the per-position
// ceiling, so a 2.75h window admits a handful. 12 is chosen as several times the observed maximum;
// on overflow the FIRST 6 and LAST 6 are kept (the two ends are what a zero-fill analysis compares)
// and attempt_count still reports the true total.
export const MAX_ATTEMPTS = Number(process.env.COPY_TRACE_ATTEMPTS ?? 12);

// BOOK-PROBE BOUNDS. Not awaiting a promise removes the LATENCY, not the RESOURCE: a request that
// never settles still pins a socket, a closure, the attempt object and this tracer for the life of
// the process. Both bounds below exist so an unreachable CLOB degrades into missing telemetry
// rather than a slow leak.
//   TIMEOUT   the probe is abandoned after this, and the fetch itself is aborted (bookSnapshot
//             carries its own AbortSignal). 2.5s, well inside the file's 10s house default -
//             a book read slower than that is not "near-contemporaneous" in any useful sense.
//   IN_FLIGHT how many observational probes one child may have outstanding at once. Overflow is
//             recorded on the attempt as skipped:"book_probe_skipped_capacity"; the ORDER IS UNAFFECTED.
//             24 is sized off MEASURED production bursts: the worst 2.5s window any single
//             child saw in the pinned 24h held 5 attempts, so this is ~5x the pathological
//             peak (every probe timing out) and ~50x the realistic one (~250ms reads).
export const PROBE_TIMEOUT_MS = Number(process.env.COPY_TRACE_BOOK_MS ?? 2500);
export const MAX_INFLIGHT_PROBES = Number(process.env.COPY_TRACE_BOOK_INFLIGHT ?? 24);

/** deterministic, stable across restarts and processes - never Math.random() */
export function hash32(s) {
  let h = 2166136261 >>> 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
/** the immutable opportunity identity: user + token + episode generation */
export function oppId(userId, tokenId, gen) {
  return `${String(userId)}|${String(tokenId)}|${Number(gen) || 0}`;
}

/** keep the first half and the last half when attempts overflow the bound */
export function clampAttempts(list, max = MAX_ATTEMPTS) {
  const a = Array.isArray(list) ? list : [];
  if (a.length <= max) return a;
  const head = Math.ceil(max / 2);
  return a.slice(0, head).concat(a.slice(a.length - (max - head)));
}

const NOOP = Object.freeze({
  id: null, sampled: false,
  stage() { return this; }, block() { return this; }, attempt() { return this; },
  bookProbe() { return this; }, orderSent() { return this; },
  sign() { return this; }, venue() { return this; }, note() { return this; },
});

/**
 * @param {object} o
 * @param {string} o.userId
 * @param {() => number} [o.now]
 * @param {boolean} [o.enabled]
 */
export function createTracer({ userId, now = Date.now, enabled = true, sampleN, maxTracked, maxBuffer, maxAttempts } = {}) {
  // `enabled` may be a PREDICATE, not just a boolean, and it is re-read on every call. That is what
  // makes the switch genuinely hot: the bot passes a thunk reading the per-cycle server settings, so
  // turning tracing on or off takes one cycle with no restart, no redeploy and no Fly secret change.
  const isOn = () => {
    let on;
    try { on = typeof enabled === "function" ? enabled() === true : enabled !== false; } catch { return false; }
    // A hot switch-off starts a new era, so probes still in flight cannot write into the tracer
    // when they land. Also drop the records, so a re-enable does not resume a stale conversation.
    if (lastOn === true && on === false) { era++; live.clear(); dirty.clear(); }
    lastOn = on;
    return on;
  };
  const SUB_ELIGIBLE_SAMPLE = Number.isFinite(Number(sampleN)) && Number(sampleN) > 0 ? Number(sampleN) : DEF_SUB_SAMPLE;
  const MAX_TRACKED = Number.isFinite(Number(maxTracked)) && Number(maxTracked) > 0 ? Number(maxTracked) : DEF_MAX_TRACKED;
  const MAX_BUFFER = Number.isFinite(Number(maxBuffer)) && Number(maxBuffer) > 0 ? Number(maxBuffer) : DEF_MAX_BUFFER;
  const MAX_ATT = Number.isFinite(Number(maxAttempts)) && Number(maxAttempts) > 0 ? Number(maxAttempts) : MAX_ATTEMPTS;
  const live = new Map();      // oppId -> record
  const dirty = new Set();     // oppIds whose emitted digest is stale
  let dropped = 0, emitted = 0, evaluated = 0, probes = 0, probesLate = 0;
  let inFlight = 0, probesTimedOut = 0, probesSkipped = 0, probesAfterOff = 0;
  // Bumped whenever tracing is switched off. A probe that lands afterwards belongs to a previous
  // era and is discarded rather than written into whatever record now occupies that slot.
  let era = 0;
  let lastOn = null;

  // The digest includes the attempt count, so a second attempt always ships even when it ends at the
  // same stage with the same blocker as the first.
  const digestOf = (r) =>
    `${r.stageMax}|${r.blockAtMax ?? ""}|${r.attemptCount}|${r.terminal ? 1 : 0}|${r.signCode ?? ""}|${r.venueResult ?? ""}|${r.bookRev}`;

  function evict() {
    if (live.size <= MAX_TRACKED) return;
    // drop the oldest untouched, terminal-first: a terminal record has nothing left to learn
    const rows = [...live.entries()].sort((a, b) => (Number(b[1].terminal) - Number(a[1].terminal)) || (a[1].lastAt - b[1].lastAt));
    const cut = Math.ceil(live.size - MAX_TRACKED * 0.9);
    for (let i = 0; i < cut && i < rows.length; i++) { live.delete(rows[i][0]); dirty.delete(rows[i][0]); }
  }

  /**
   * Begin (or resume) tracing one opportunity.
   * @returns a handle; a no-op handle when tracing is off or the opportunity is not sampled.
   */
  function open(o) {
    if (!isOn()) return NOOP;
    try {
      const tokenId = String(o?.tokenId ?? "");
      if (!tokenId) return NOOP;
      const gen = Number(o?.gen) || 0;
      const id = oppId(userId, tokenId, gen);
      const path = o?.path === "fast" ? "fast" : "poll";
      let r = live.get(id);
      if (!r) {
        r = {
          id, tokenId, gen,
          // PATH IS HISTORY, NOT A LAST-WRITE-WINS LABEL. An opportunity can be seen by the sweep
          // first and later driven by a fresh whale fill; collapsing that to one column would move
          // it between the treatment and control arms retroactively and corrupt both.
          firstPath: path, lastPath: path,
          sawPoll: path === "poll", sawFast: path === "fast",
          pathAtFirstAttempt: null, pathAtFirstFill: null,
          cid: String(o?.conditionId ?? "").slice(0, 66),
          outcome: String(o?.outcome ?? "").slice(0, 40),
          cat: String(o?.category ?? "").slice(0, 24),
          whale: String(o?.whale ?? "").toLowerCase().slice(0, 42),
          q: String(o?.question ?? "").slice(0, 90),
          firstAt: now(), lastAt: now(), evals: 0,
          stageMax: 0, blockAtMax: null, blockFirst: null, blockLast: null,
          terminal: false, attempted: false,
          attempts: [], attemptCount: 0, bookRev: 0,
          signCode: null, venueResult: null, filledUsd: null, ctx: null,
          sig: null, emitted: null,
        };
        // sampling: everything that reaches the window is kept; below it, a deterministic 1-in-N
        r.sampled = true;
        r.subSample = (hash32(id) % SUB_ELIGIBLE_SAMPLE) === 0;
        live.set(id, r);
        evict();
      }
      r.lastAt = now();
      r.evals++;
      evaluated++;
      r.lastPath = path;
      if (path === "poll") r.sawPoll = true; else r.sawFast = true;
      // late-arriving context (the fast path learns the category only after copy-check answers)
      if (!r.cat && o?.category) r.cat = String(o.category).slice(0, 24);
      if (!r.whale && o?.whale) r.whale = String(o.whale).toLowerCase().slice(0, 42);
      if (!r.q && o?.question) r.q = String(o.question).slice(0, 90);
      return handle(r);
    } catch { return NOOP; }
  }

  function markDirty(r) {
    const d = digestOf(r);
    if (r.emitted === d) return;
    r.sig = d;
    // only keep what will actually be shipped: rows below WINDOW_OPEN ride the deterministic sample
    if (r.stageMax >= STAGE.WINDOW_OPEN || r.subSample || r.attempted) dirty.add(r.id);
  }

  const cur = (r) => (r.attempts.length ? r.attempts[r.attempts.length - 1] : null);

  function handle(r) {
    return {
      id: r.id,
      sampled: true,
      /** record that the opportunity reached this stage; monotonic */
      stage(s) {
        try {
          const v = Number(s) || 0;
          if (v > r.stageMax) { r.stageMax = v; r.blockAtMax = null; markDirty(r); }
        } catch { /* never throw into trading */ }
        return this;
      },
      /**
       * record why it stopped here. The blocker recorded AT the furthest stage is the answer to
       * "where does it stop progressing"; the first blocker ever seen is kept separately.
       */
      block(b, ctx) {
        try {
          const name = String(b).slice(0, 48);
          if (!r.blockFirst) r.blockFirst = name;
          r.blockLast = name;
          if (r.blockAtMax !== name) { r.blockAtMax = name; if (ctx) r.ctx = compact(ctx); markDirty(r); }
          if (isTerminal(name) && !r.terminal) { r.terminal = true; markDirty(r); }
        } catch { /* never throw into trading */ }
        return this;
      },
      /**
       * Open a NEW attempt with the EXACT, already-paid state of the order being built.
       * Synchronous and allocation-only: every field here is already in memory at the call site
       * (the mid the production priceFor() just fetched, the cap from the signal row, the limit and
       * size the engine computed). No I/O, so nothing here can delay the order.
       */
      attempt(a) {
        try {
          r.attempted = true;
          r.attemptCount++;
          r.attempts.push(compact({
            n: r.attemptCount, kind: a?.kind ?? null, at: now(),
            // exact, pre-order, zero-cost
            mid: a?.mid ?? null, mid_at: a?.midAt ?? null,
            cap: a?.cap ?? null, limit: a?.limit ?? null,
            usd: a?.usd ?? null, shares: a?.shares ?? null,
            row_age_h: a?.rowAgeH ?? null, whale_avg_c: a?.whaleAvgC ?? null,
            path: r.lastPath,
          }));
          // slice keeps object identity, so a probe still in flight for a kept attempt lands
          // correctly; one whose attempt was clamped away mutates an orphan and is discarded.
          r.attempts = clampAttempts(r.attempts, MAX_ATT);
          if (!r.pathAtFirstAttempt) r.pathAtFirstAttempt = r.lastPath;
          if (r.stageMax < STAGE.SIGN_REQUESTED) { r.stageMax = STAGE.SIGN_REQUESTED; r.blockAtMax = null; }
          markDirty(r);
        } catch { /* never throw into trading */ }
        return this;
      },
      /**
       * Start an observational book read for the CURRENT attempt and return immediately.
       *
       * `mk` is a thunk so the tracer owns every part of the timing, and so a tracer that is off
       * never even builds the request. The returned promise is deliberately NOT returned to the
       * caller and never awaited by it: the order is sent while this is in flight. If it resolves
       * after the order was sent — which is the expected case — the row says so.
       */
      bookProbe(mk) {
        try {
          const at = cur(r);
          if (!at || typeof mk !== "function") return this;
          // CAPACITY FIRST. Refusing to start a probe is always preferable to starting one we
          // cannot account for; the order does not care either way.
          if (inFlight >= MAX_INFLIGHT_PROBES) {
            probesSkipped++;
            at.skipped = "book_probe_skipped_capacity";
            r.bookRev++;
            markDirty(r);
            return this;
          }
          const reqAt = now();
          const myEra = era;
          at.snap_req_at = Math.round(reqAt / 1000);
          probes++;
          const p = mk();
          if (!p || typeof p.then !== "function") return this;
          inFlight++;
          let done = false;
          // Hard deadline INSIDE the observation. bookSnapshot aborts its own fetch, so the socket
          // is released too; this timer is the backstop that frees the accounting even if the
          // promise never settles at all.
          const timer = setTimeout(() => {
            if (done) return;
            done = true;
            inFlight--;
            probesTimedOut++;
            try { at.snap_ms = -2; at.skipped = "book_probe_timeout"; r.bookRev++; markDirty(r); } catch { /* telemetry only */ }
          }, PROBE_TIMEOUT_MS);
          if (typeof timer?.unref === "function") timer.unref();   // never hold the event loop open
          const settle = (fn) => (v) => {
            if (done) return;                       // the deadline already accounted for it
            done = true;
            inFlight--;
            clearTimeout(timer);
            if (myEra !== era) { probesAfterOff++; return; }   // tracing was switched off underneath us
            try { fn(v); } catch { /* telemetry only */ }
          };
          p.then(settle((snap) => {
            const rec = now();
            at.bid = snap?.bid ?? null;
            at.ask = snap?.ask ?? null;
            at.depth_usd = snap?.depthUsd ?? null;
            at.ask_levels = snap?.askLevels ?? null;
            at.snap_ms = Math.round(rec - reqAt);
            at.snap_recv_at = Math.round(rec / 1000);
            // The honest label: was the book read back before or after the order went out?
            at.snap_before_send = at.order_send_at_ms != null ? rec <= at.order_send_at_ms : null;
            if (at.snap_before_send === false) probesLate++;
            r.bookRev++;
            markDirty(r);
          }), settle(() => { at.snap_ms = -1; r.bookRev++; markDirty(r); }));
        } catch { /* never throw into trading */ }
        return this;
      },
      /** stamp the instant the order is handed to the venue - the reference point for the probe */
      orderSent(t) {
        try {
          const at = cur(r);
          if (!at) return this;
          const ms = Number.isFinite(Number(t)) ? Number(t) : now();
          at.order_send_at_ms = ms;
          at.order_send_at = Math.round(ms / 1000);
        } catch { /* never throw into trading */ }
        return this;
      },
      sign(code, ok) {
        try {
          r.signCode = String(code ?? "").slice(0, 40) || null;
          const at = cur(r);
          if (at) at.sign = r.signCode;
          if (ok && r.stageMax < STAGE.SIGNED) r.stageMax = STAGE.SIGNED;
          markDirty(r);
        } catch { /* never throw into trading */ }
        return this;
      },
      venue(result, filledUsd) {
        try {
          r.venueResult = String(result ?? "").slice(0, 60) || null;
          const at = cur(r);
          if (at) { at.venue = r.venueResult; if (Number.isFinite(Number(filledUsd))) at.filled_usd = Number(filledUsd); }
          if (Number.isFinite(Number(filledUsd))) r.filledUsd = Number(filledUsd);
          if (Number(filledUsd) > 0) {
            if (!r.pathAtFirstFill) r.pathAtFirstFill = r.lastPath;
            if (r.stageMax < STAGE.FILLED) { r.stageMax = STAGE.FILLED; r.blockAtMax = null; }
          }
          markDirty(r);
        } catch { /* never throw into trading */ }
        return this;
      },
      note(k, v) { try { r.ctx = compact({ ...(r.ctx || {}), [String(k).slice(0, 24)]: v }); markDirty(r); } catch { /* ignore */ } return this; },
    };
  }

  /** drop undefined/null and clamp strings so the payload cannot grow unbounded */
  function compact(o) {
    const out = {};
    for (const [k, v] of Object.entries(o || {})) {
      if (v === undefined || v === null) continue;
      out[String(k).slice(0, 24)] = typeof v === "string" ? v.slice(0, 60)
        : typeof v === "number" ? (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null)
        : typeof v === "boolean" ? v
        : Array.isArray(v) ? v.slice(0, 6)
        : String(v).slice(0, 60);
    }
    return Object.keys(out).length ? out : null;
  }

  /** strip the internal ms stamp the wire format does not need */
  const wireAttempt = (a) => { const { order_send_at_ms, ...rest } = a || {}; return rest; };

  /** rows to ship, newest-blocking-first; clears the dirty flags it hands out */
  function drain(limit = 40) {
    if (!isOn()) return [];
    try {
      const ids = [...dirty];
      if (ids.length > MAX_BUFFER) { dropped += ids.length - MAX_BUFFER; ids.length = MAX_BUFFER; }
      const take = ids.slice(0, Math.max(0, limit));
      const rows = [];
      for (const id of take) {
        const r = live.get(id);
        dirty.delete(id);
        if (!r) continue;
        r.emitted = r.sig;
        emitted++;
        rows.push({
          t: r.tokenId, g: r.gen, c: r.cid, o: r.outcome, k: r.cat, w: r.whale, q: r.q,
          // path history, not a single mutable label
          p: r.lastPath, p1: r.firstPath, sp: r.sawPoll, sf: r.sawFast,
          pa: r.pathAtFirstAttempt, pf: r.pathAtFirstFill,
          f: Math.round(r.firstAt / 1000), l: Math.round(r.lastAt / 1000), n: r.evals,
          s: r.stageMax, sn: STAGE_NAME[r.stageMax] ?? null,
          b: r.blockAtMax, b1: r.blockFirst, term: r.terminal,
          a: r.attempted, at: r.attempts.map(wireAttempt), an: r.attemptCount,
          sc: r.signCode, vr: r.venueResult, fu: r.filledUsd, x: r.ctx,
        });
        // A TERMINAL RECORD IS KEPT, NEVER FREED HERE. Deleting it looked like a memory win, but the
        // engine goes on iterating that row for the rest of its life: the next evaluation would
        // recreate the record with an empty `emitted` digest and ship it again, once per drain, for
        // hours. Keeping it is what makes "emit once" actually hold. Memory stays bounded because
        // evict() drops terminal records first - they have nothing left to learn.
      }
      return rows;
    } catch { return []; }
  }

  const stats = () => ({ tracked: live.size, dirty: dirty.size, dropped, emitted, evaluated,
    probes, probesLate, probesTimedOut, probesSkipped, probesAfterOff, inFlight, era });

  return { open, drain, stats, isOn };
}
