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
{ // 7. EVENT RECORDS: two events on one row, each with its own blockers, attempt and end
  const t = mk();
  open(t, "h").stage(STAGE.WINDOW_OPEN).block("cash_insufficient", { need: 5, cash: 1 });   // event 1: eligible, hard-blocked
  open(t, "h").block("window_dead", { h_left: -0.2 });                                          // event 1 ends
  t.drain(10);
  open(t, "h").stage(STAGE.TIER_RESOLVED).stage(STAGE.WINDOW_OPEN);                            // event 2 (window re-opened)
  open(t, "h").block("cooldown"); open(t, "h").stage(STAGE.WINDOW_OPEN).attempt({ kind: "open", usd: 2 });   // event 2: transient then attempted
  const [row] = t.drain(10);
  const ev = row && row.ev;
  ck("row ships two event records", Array.isArray(ev) && ev.length === 2 && ev[0].n === 1 && ev[1].n === 2);
  ck("event 1 carries its own blockers and its ender", ev[0].bl.join() === "cash_insufficient,window_dead" && ev[0].by === "window_dead" && ev[0].end >= ev[0].at && ev[0].an === null);
  ck("event 2 carries only its blockers and its first attempt", ev[1].bl.join() === "cooldown" && ev[1].an === 1 && ev[1].aa >= ev[1].at && ev[1].end === null);
  ck("the digest re-ships on a new blocker within the event", (() => { open(t, "h").block("price_gate"); return t.drain(10).length === 1; })());
  ck("re-delivering the same state does not ship again (idempotent at the source)", t.drain(10).length === 0);
}
{ // 8. bounded: never more than 6 event records, oldest dropped
  const t = mk();
  for (let i = 0; i < 9; i++) { open(t, "z").stage(STAGE.WINDOW_OPEN); open(t, "z").block("window_dead"); }
  const [row] = t.drain(10);
  ck("event list capped at 6, latest kept", row.ev.length === 6 && row.ev[5].n === 9 && row.en === 9);
}
console.log("\n" + (fail === 0 ? "ALL PASS" : "FAILURES") + ": " + pass + " passed, " + fail + " failed");
assert.equal(fail, 0);
