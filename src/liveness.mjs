// CHILD LIVENESS - the pure rules behind the child's cycle watchdog and the runner's wedge backstop
// (owner 2026-09-06: "a live child process that has not completed a cycle is NOT healthy").
//
// THE DEFECT THIS REPLACES. bot.mjs stamped "cycle done" AFTER its catch block, so a cycle that threw on
// its first await counted as completed. Measured on four children, 2026-09-06 13:20-14:59Z: their
// minutely metrics kept arriving over IPC and chainwatch kept refreshing their rosters (process and
// network fine), yet no heartbeat reached the server for 98 minutes and the 10-minute watchdog never
// fired, because the loop was iterating. COSMOS_LAUNCHER=1 was present the whole time; the exit was
// never requested. The runner, for its part, had no notion of a completed cycle at all.
//
// TWO LAYERS, deliberately. The child exits itself first: it holds the error message and the runner
// respawns it after the normal crash backoff. The runner is the backstop for the case the child CANNOT
// act - a starved timer, a synchronous block, an older build - and it is more conservative by
// construction: its threshold is longer than the child's so a healthy self-exit always wins the race,
// it restarts only the stale child, never more than a few per pass, never the same child twice inside
// the cooldown, and never anything at all when the stale set is large (that shape is a platform or
// network fault, which the self-heal exits already cover - restarting a fleet into a wall is the
// failure mode this must not add).

export const WEDGE_EXIT_CODE = 3;   // distinct from crash (1), self-update (0) and boot wedge (1)

/** The child's accounting. A cycle counts only when it RETURNED NORMALLY; a thrown cycle advances the
 *  failure streak and keeps the last message so the exit line (and the runner) can name the cause. */
export function cycleLiveness(now = Date.now()) {
  let lastOk = now, streak = 0, lastErr = null;
  return {
    ok(at = Date.now()) { lastOk = at; streak = 0; lastErr = null; },
    fail(err) { streak++; lastErr = String(err?.message ?? err ?? "").slice(0, 160) || "(no message)"; },
    /** ms since the last cycle that returned normally - iterations that threw do not count */
    staleMs(at = Date.now()) { return at - lastOk; },
    get streak() { return streak; },
    get lastErr() { return lastErr; },
  };
}

// Runner thresholds. Env-tunable, none require a deploy to change.
export const RUNNER_STALE_MS = Number(process.env.COSMOS_RUNNER_STALE_MS) || 15 * 60_000;             // > the child's own 10 min: the child gets first chance
export const RUNNER_BOOT_GRACE_MS = Number(process.env.COSMOS_RUNNER_BOOT_GRACE_MS) || 30 * 60_000;   // boot stages carry 90 s + 180 s deadlines; a child that has never completed a cycle gets 30 min
export const RUNNER_WEDGE_COOLDOWN_MS = Number(process.env.COSMOS_RUNNER_WEDGE_COOLDOWN_MS) || 30 * 60_000;
export const RUNNER_WEDGE_MAX_PER_PASS = Number(process.env.COSMOS_RUNNER_WEDGE_MAX_PER_PASS) || 3;
export const RUNNER_WEDGE_MAX_FRACTION = Number(process.env.COSMOS_RUNNER_WEDGE_MAX_FRACTION) || 0.10;

/**
 * wedgeDecisions(children, now, opts) -> { restart: [{ userId, staleS, reason }], stale, running, refused }
 *   children: iterable of [userId, { alive, startedAt, lastCycleOkAt, lastCycleErr, cycleStreak, lastWedgeRestartAt }]
 * A child is STALE when it is alive and its last normally-completed cycle - or, if it has never completed
 * one, its start - is older than the threshold. Stale children are restarted most-stale first, at most
 * maxPerPass per pass, skipping any restarted inside the cooldown. If more than max(minMass, fraction of
 * running) are stale at once, NOTHING is restarted and the reason is returned for the alarm.
 */
export function wedgeDecisions(children, now = Date.now(), o = {}) {
  const staleMs = o.staleMs ?? RUNNER_STALE_MS, bootGraceMs = o.bootGraceMs ?? RUNNER_BOOT_GRACE_MS;
  const cooldownMs = o.cooldownMs ?? RUNNER_WEDGE_COOLDOWN_MS, maxPerPass = o.maxPerPass ?? RUNNER_WEDGE_MAX_PER_PASS;
  const maxFraction = o.maxFraction ?? RUNNER_WEDGE_MAX_FRACTION, minMass = o.minMass ?? 3;
  const stale = []; let running = 0;
  for (const [userId, c] of children) {
    if (!c || !c.alive) continue;                       // in crash backoff or already gone: the exit path owns it
    running++;
    const basis = Number(c.lastCycleOkAt) || 0;
    const ageMs = basis > 0 ? now - basis : now - (Number(c.startedAt) || now);
    if (ageMs > (basis > 0 ? staleMs : bootGraceMs)) stale.push({ userId, staleS: Math.round(ageMs / 1000), never: !(basis > 0), c });
  }
  const massLimit = Math.max(minMass, Math.ceil(running * maxFraction));
  if (stale.length > massLimit) {
    return { restart: [], stale: stale.length, running, refused: `${stale.length} of ${running} children stale at once (limit ${massLimit}) - platform-wide cause, refusing a mass restart` };
  }
  const restart = [];
  for (const s of stale.sort((a, b) => b.staleS - a.staleS)) {
    if (restart.length >= maxPerPass) break;
    if (now - (Number(s.c.lastWedgeRestartAt) || 0) < cooldownMs) continue;
    const streak = Number(s.c.cycleStreak) || 0;
    restart.push({ userId: s.userId, staleS: s.staleS, reason: s.never
      ? `no completed cycle since start (${s.staleS}s)`
      : `no completed cycle for ${s.staleS}s${streak ? ` · ${streak} consecutive cycle failures, last: ${s.c.lastCycleErr || "?"}` : ""}` });
  }
  return { restart, stale: stale.length, running, refused: null };
}
