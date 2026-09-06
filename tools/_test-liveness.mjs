// LIVENESS CONTRACT (owner 2026-09-06). Part 1 first PROVES THE DEFECT against the old semantics -
// a test whose old-model reference passes would be hollow - then proves the replacement. Part 2 is
// the runner's backstop: restart only the stale child, boot grace, cooldown, per-pass cap, and the
// mass-stale refusal that stops it from ever becoming a fleet-wide restart.
import assert from "node:assert";
import { cycleLiveness, wedgeDecisions, WEDGE_EXIT_CODE } from "../src/liveness.mjs";
let pass = 0, fail = 0;
const ck = (n, c) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}`); } };
const MIN = 60_000, WEDGE_MS = 600_000;

// ---- Part 1: the child ---------------------------------------------------------------------------
// OLD semantics (bot.mjs before this fix): stamp after the catch, so a throwing cycle counts as done.
function oldModel(t0) { let lastDone = t0; return { iterate: (at) => { lastDone = at; }, staleMs: (at) => at - lastDone }; }
{
  // the measured shape: the loop iterates every 30 s, cycle() throws every time, for 98 minutes
  const t0 = 1_000_000; const old = oldModel(t0); const live = cycleLiveness(t0);
  let at = t0;
  for (let i = 0; i < 196; i++) { at += 30_000; old.iterate(at); live.fail(new Error("GET /api/v1/account -> 500")); }
  ck("DEFECT: old model reports the throw-loop as fresh (0 s stale after 98 min of failures; 30 s a moment later)", old.staleMs(at) === 0 && old.staleMs(at + 30_000) === 30_000);
  ck("old model would never have crossed the 10-min watchdog", old.staleMs(at) < WEDGE_MS);
  ck("new model: 98 min stale", live.staleMs(at) === 196 * 30_000);
  ck("new model crosses the 10-min watchdog", live.staleMs(at) > WEDGE_MS);
  ck(`new model carries the streak (${live.streak}) and the last error for the exit line`, live.streak === 196 && /account -> 500/.test(live.lastErr));
}
{
  const t0 = 0; const live = cycleLiveness(t0); let at = t0;
  for (let i = 0; i < 30; i++) { at += 30_000; live.ok(at); }
  ck("healthy loop never goes stale", live.staleMs(at) === 0 && live.streak === 0);
  at += 30_000; live.fail("boom"); at += 30_000; live.fail("boom");
  ck("two failures: stale measured from the last SUCCESS, not the last iteration", live.staleMs(at) === 60_000 && live.streak === 2);
  at += 30_000; live.ok(at);
  ck("one success clears the streak and the error", live.streak === 0 && live.lastErr === null && live.staleMs(at) === 0);
  live.fail(undefined);
  ck("a failure with no message still records something", typeof live.lastErr === "string" && live.lastErr.length > 0);
}
ck("wedge exit code is distinct from crash(1) and self-update(0)", WEDGE_EXIT_CODE !== 0 && WEDGE_EXIT_CODE !== 1);

// ---- Part 2: the runner backstop ------------------------------------------------------------------
const now = 10_000_000;
const child = (o) => ({ alive: true, startedAt: now - 3 * 3600_000, lastCycleOkAt: now - 2 * MIN, cycleStreak: 0, lastCycleErr: null, lastWedgeRestartAt: 0, ...o });
const fleet = (n, over = {}) => { const m = new Map(); for (let i = 0; i < n; i++) m.set(`u${i}`, child()); for (const [k, v] of Object.entries(over)) m.set(k, child(v)); return m; };
{
  const d = wedgeDecisions(fleet(130, { wedged: { lastCycleOkAt: now - 16 * MIN, cycleStreak: 31, lastCycleErr: "GET /api/v1/account -> 500" } }), now);
  ck("one child 16 min without a completed cycle -> exactly that child is restarted", d.restart.length === 1 && d.restart[0].userId === "wedged");
  ck("  the reason names the streak and the error", /31 consecutive/.test(d.restart[0].reason) && /account -> 500/.test(d.restart[0].reason));
  ck("  fresh children untouched (running 131, stale 1)", d.running === 131 && d.stale === 1 && d.refused === null);
}
{
  const d = wedgeDecisions(fleet(130, { edge: { lastCycleOkAt: now - 14 * MIN } }), now);
  ck("14 min is inside the 15-min threshold: not stale (the child's own 10-min exit gets first chance)", d.restart.length === 0 && d.stale === 0);
}
{
  const d = wedgeDecisions(fleet(130, { backoff: { alive: false, lastCycleOkAt: now - 60 * MIN } }), now);
  ck("a child with no process (crash backoff) is ignored - the exit path owns it", d.restart.length === 0 && d.stale === 0);
}
{
  const a = wedgeDecisions(fleet(130, { booting: { startedAt: now - 20 * MIN, lastCycleOkAt: 0 } }), now);
  const b = wedgeDecisions(fleet(130, { booting: { startedAt: now - 31 * MIN, lastCycleOkAt: 0 } }), now);
  ck("never-completed child at 20 min: boot grace holds", a.restart.length === 0);
  ck("never-completed child at 31 min: restarted, reason says 'since start'", b.restart.length === 1 && /since start/.test(b.restart[0].reason));
}
{
  const d = wedgeDecisions(fleet(130, { again: { lastCycleOkAt: now - 40 * MIN, lastWedgeRestartAt: now - 10 * MIN } }), now);
  ck("a child wedge-restarted 10 min ago is NOT restarted again inside the 30-min cooldown", d.restart.length === 0 && d.stale === 1);
  const e = wedgeDecisions(fleet(130, { again: { lastCycleOkAt: now - 40 * MIN, lastWedgeRestartAt: now - 31 * MIN } }), now);
  ck("  ...and is after the cooldown", e.restart.length === 1);
}
{
  const over = {}; for (let i = 0; i < 5; i++) over[`w${i}`] = { lastCycleOkAt: now - (20 + i) * MIN };
  const d = wedgeDecisions(fleet(125, over), now);
  ck("5 stale of 130: capped at 3 per pass, most stale first", d.restart.length === 3 && d.restart.map((x) => x.userId).join() === "w4,w3,w2");
}
{
  const over = {}; for (let i = 0; i < 20; i++) over[`w${i}`] = { lastCycleOkAt: now - 30 * MIN };
  const d = wedgeDecisions(fleet(110, over), now);
  ck("20 stale of 130 (>10%): REFUSED - zero restarts, reason for the alarm", d.restart.length === 0 && /platform-wide/.test(d.refused) && d.stale === 20);
  const over2 = {}; for (let i = 0; i < 13; i++) over2[`w${i}`] = { lastCycleOkAt: now - 30 * MIN };
  const e = wedgeDecisions(fleet(117, over2), now);
  ck("13 stale of 130 (= the 10% limit): allowed, 3 restarted", e.refused === null && e.restart.length === 3);
}
{
  const d = wedgeDecisions(fleet(1, { a: { lastCycleOkAt: now - 30 * MIN }, b: { lastCycleOkAt: now - 30 * MIN }, c: { lastCycleOkAt: now - 30 * MIN }, e: { lastCycleOkAt: now - 30 * MIN } }), now);
  ck("small fleet: 4 stale of 5 exceeds max(3, 10%) -> refused", d.restart.length === 0 && d.refused !== null);
  const e = wedgeDecisions(fleet(2, { a: { lastCycleOkAt: now - 30 * MIN }, b: { lastCycleOkAt: now - 30 * MIN }, c: { lastCycleOkAt: now - 30 * MIN } }), now);
  ck("small fleet: 3 stale of 5 is within the mass limit -> restarted", e.restart.length === 3);
}
{
  const d = wedgeDecisions(new Map(), now);
  ck("empty fleet: nothing to do, nothing refused", d.restart.length === 0 && d.refused === null && d.running === 0);
}
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
