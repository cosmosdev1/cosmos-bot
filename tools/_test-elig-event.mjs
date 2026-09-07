// ELIGIBILITY EVENTS (owner 2026-09-07): the trace stamps the TIME an opportunity becomes eligible, per event -
// a window transition or a later ADD after a non-eligible state is a NEW event; a post-window block (cash,
// price, dedup) is not. Each event re-ships the row (digest), so the server sees the newest event time.
import assert from "node:assert";
import { createTracer, STAGE } from "../src/opp-trace.mjs";
let pass = 0, fail = 0;
const ck = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const mk = () => createTracer({ userId: "u1", enabled: () => true, sampleN: 1 });
const open = (t, tok) => t.open({ tokenId: tok, gen: 0, path: "poll", conditionId: "c", outcome: "Yes" });

{ // 1. reaching the window stamps one event
  const t = mk(); open(t, "a").stage(STAGE.TIER_RESOLVED).stage(STAGE.TARGET_SIZED).stage(STAGE.WINDOW_OPEN);
  const [row] = t.drain(10);
  ck("first WINDOW_OPEN: e stamped (unix s), en = 1", row && row.e > 1_700_000_000 && row.en === 1);
  open(t, "a").stage(STAGE.WINDOW_OPEN).stage(STAGE.PRICED);
  const again = t.drain(10);
  ck("staying eligible across evaluations does NOT create a second event", again.every((r) => r.en === 1));
}
{ // 2. window closes (window_dead) then re-opens -> a second event, re-shipped
  const t = mk(); open(t, "b").stage(STAGE.WINDOW_OPEN); const [r1] = t.drain(10);
  open(t, "b").block("window_dead", { h_left: -0.1 }); t.drain(10);
  open(t, "b").stage(STAGE.WINDOW_OPEN); const rows = t.drain(10);
  ck("window transition after a non-eligible block: en = 2 and the row ships again", rows.length === 1 && rows[0].en === 2 && rows[0].e >= r1.e);
}
{ // 3. tier falls (tier_zero) then a later ADD crosses the tier -> new event
  const t = mk(); open(t, "c").stage(STAGE.WINDOW_OPEN); t.drain(10);
  open(t, "c").block("tier_zero", { his_usd: 3 }); t.drain(10);
  open(t, "c").stage(STAGE.TIER_RESOLVED).stage(STAGE.WINDOW_OPEN); const rows = t.drain(10);
  ck("tier_zero then re-tiered (a later ADD): en = 2", rows.length === 1 && rows[0].en === 2);
}
{ // 4. post-window blocks keep the event open
  const t = mk(); open(t, "d").stage(STAGE.WINDOW_OPEN); t.drain(10);
  for (const b of ["cash_insufficient", "price_out_of_band", "cooldown", "inflight", "already_holding", "venue_no_book"]) { open(t, "d").block(b); open(t, "d").stage(STAGE.WINDOW_OPEN); }
  const rows = t.drain(10);
  ck("cash/price/dedup/venue blocks after the window do not start new events (en stays 1)", rows.every((r) => r.en === 1));
}
{ // 5. hub / engine / floor blocks (pre-window) end the event
  const t = mk(); open(t, "f").stage(STAGE.WINDOW_OPEN); t.drain(10);
  for (const b of ["hub_not_enterable", "engine_off", "portfolio_floor", "window_wait"]) { open(t, "f").block(b); open(t, "f").stage(STAGE.WINDOW_OPEN); }
  const rows = t.drain(10);
  ck("each pre-window block followed by WINDOW_OPEN is a new event (en = 5)", rows.length === 1 && rows[0].en === 5);
}
{ // 6. never eligible: no e
  const t = mk(); open(t, "g").stage(STAGE.TIER_RESOLVED).block("window_wait", { h_left: 5 });
  const rows = t.drain(10);
  ck("a row that never reached the window carries e = null, en = 0", rows.length === 1 && rows[0].e === null && rows[0].en === 0);
}
console.log("\n" + (fail === 0 ? "ALL PASS" : "FAILURES") + ": " + pass + " passed, " + fail + " failed");
assert.equal(fail, 0);
