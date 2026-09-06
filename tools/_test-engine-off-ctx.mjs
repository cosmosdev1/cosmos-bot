// Proves the engine_off context change is OBSERVATION-ONLY and cannot change emission volume.
//
// The risk of attaching ctx to a block is that it makes the record dirty more often and multiplies
// telemetry rows. opp-trace's digest deliberately excludes ctx, and ctx is stored only when the
// block NAME changes - so a repeated engine_off must still emit exactly one row. This asserts that
// rather than trusting the reading.
import assert from "node:assert";
import { createTracer, STAGE } from "../src/opp-trace.mjs";

let pass = 0, fail = 0;
const ck = (n, c) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}`); } };
// sampleN:1 disables the 1-in-8 sub-sample so every record ships. Production DOES sample below
// WINDOW_OPEN (COPY_TRACE_SAMPLE, default 8) - discovered by this test failing - so any funnel built
// on poll_trace must scale sub-WINDOW_OPEN buckets by that factor.
const mk = () => createTracer({ userId: "u1", enabled: () => true, sampleN: 1 });

// 1. repeated identical engine_off with ctx -> ONE emission
{
  const t = mk();
  const open = () => t.open({ tokenId: "t1", gen: 0, path: "fast", conditionId: "c1", outcome: "Yes" });
  for (let i = 0; i < 50; i++) open().stage(STAGE.SEEN).block("engine_off", { ct: 0, cf: 1, why: "server_flag_off", sAge: 3 });
  const rows = t.drain(100);
  ck("50 identical engine_off blocks emit exactly 1 row", rows.length === 1);
  const r = rows[0];
  ck("the row carries the classification ctx", r && r.x && r.x.why === "server_flag_off" && r.x.ct === 0);
}

// 2. a CHANGED blocker still emits (the funnel must still see transitions)
{
  const t = mk();
  const open = () => t.open({ tokenId: "t2", gen: 0, path: "fast", conditionId: "c2", outcome: "No" });
  open().stage(STAGE.SEEN).block("engine_off", { ct: 0, cf: 1, why: "user_stop", sAge: 1 });
  t.drain(10);
  open().stage(STAGE.SEEN).block("tier_zero", { his_usd: 5 });
  const rows = t.drain(10);
  ck("a different blocker on the same opportunity still emits", rows.length === 1 && rows[0].b === "tier_zero");
}

// 3. ctx with junk / missing fields must never throw
{
  const t = mk();
  const open = () => t.open({ tokenId: "t3", gen: 0, path: "poll", conditionId: "c3", outcome: "Yes" });
  let threw = false;
  try {
    open().block("engine_off", { ct: undefined, cf: null, why: null, sAge: NaN });
    open().block("engine_off", undefined);
    open().block("engine_off", { deep: { nested: { x: 1 } } });
  } catch { threw = true; }
  ck("malformed or absent ctx never throws", !threw);
}

// 4. an opportunity that recovers past engine_off still reports its later stage
{
  const t = mk();
  const open = () => t.open({ tokenId: "t4", gen: 0, path: "fast", conditionId: "c4", outcome: "Yes" });
  open().stage(STAGE.SEEN).block("engine_off", { ct: 0, cf: 1, why: "server_flag_off", sAge: 2 });
  t.drain(10);
  open().stage(STAGE.ENGINE_READY).stage(STAGE.TIER_RESOLVED).stage(STAGE.FILLED);
  const rows = t.drain(10);
  ck("recovery after engine_off is still observed", rows.length === 1 && rows[0].s >= STAGE.FILLED);
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
