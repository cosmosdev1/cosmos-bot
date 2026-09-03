// Matcher invariants (owner, 2026-09-03, before the v3 push). A venue trade counts toward our
// delayed order ONLY when: same token, same side, our exact order id is linked as taker or maker,
// its timestamp is after placement and inside the reconciliation window, trade ids are deduplicated,
// and partial trades for one order are summed exactly once. Anything else -> ambiguous, never a
// fill inferred from token/time proximity.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { settlePlacement, _resetDelayedLocks } from "../src/polymarket.mjs";

// Realistic virtual clock: placement at epoch 1,700,000,000 s so the seconds/milliseconds
// discrimination in the trade-time parser behaves as it does in production.
const T0S = 1_700_000_000;
function clock(start = T0S * 1000) { let t = start; return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } }; }
const delayedResp = (orderID = "0xabc") => ({ success: true, status: "delayed", orderID, makingAmount: "", takingAmount: "" });
const TOK = "111222333";
const fast = (c) => ({ now: c.now, sleep: c.sleep, pollMs: 12_000, everyMs: 500, callMs: 50, holdMs: 300_000 });
const notFound = { error: "order not found", status: 404 };
// A well-formed taker trade for our BUY, matched 2 s after placement.
const good = (o) => ({ id: "t1", taker_order_id: "0xabc", asset_id: TOK, side: "BUY", size: "4", price: "0.70", status: "MATCHED", match_time: String(T0S + 2), maker_orders: [], ...o });
function venue(pages) { // pages: one trade array per getTrades call (last repeats)
  const calls = { getTrades: 0 };
  return { calls, getOrder: async () => notFound, getTrades: async () => pages[Math.min(calls.getTrades++, pages.length - 1)] };
}
const settle = (v, side = "BUY") => settlePlacement({ resp: delayedResp(), side, size: 10, priceCents: 80, client: v, tokenId: TOK, opts: fast(clock()) });

beforeEach(() => _resetDelayedLocks());

test("baseline: a provable taker trade books (exact id, same token, same side, in window)", async () => {
  const r = await settle(venue([[good()]]));
  assert.equal(r.kind, "filled");
  assert.deepEqual(r.fill, { shares: 4, priceCents: 70 });
  assert.match(r.meta.delayed_state, /^terminal:trades\(1\)/);
});

test("exact link only: a trade on our token, our side, in window, but with ANOTHER order id is never ours", async () => {
  const r = await settle(venue([[good({ taker_order_id: "0xnotours" })]]));
  assert.equal(r.kind, "ambiguous", "proximity alone never attributes");
  assert.equal(r.fill, null);
});

test("same token: a linked trade whose asset_id differs from our token is rejected", async () => {
  const r = await settle(venue([[good({ asset_id: "999" })]]));
  assert.equal(r.kind, "ambiguous");
  assert.equal(r.meta.delayed_rejected_trades?.asset, 1);
});

test("same side: a taker-linked trade on the opposite side is rejected; a missing side is not provable", async () => {
  assert.equal((await settle(venue([[good({ side: "SELL" })]]))).kind, "ambiguous");
  const r = await settle(venue([[good({ side: "" })]]));
  assert.equal(r.kind, "ambiguous");
  assert.equal(r.meta.delayed_rejected_trades?.side, 1);
});

test("maker link: the trade's side is the taker's, so our maker leg must be on the OPPOSITE side, and only the leg counts", async () => {
  const t = good({ taker_order_id: "0xtaker", side: "SELL", size: "50", price: "0.60", maker_orders: [{ order_id: "0xabc", matched_amount: "3", price: "0.74" }] });
  const r = await settle(venue([[t]]), "BUY");
  assert.equal(r.kind, "filled");
  assert.deepEqual(r.fill, { shares: 3, priceCents: 74 });
  // same trade but the taker side equals ours: then we cannot have been the maker -> rejected
  const bad = good({ taker_order_id: "0xtaker", side: "BUY", maker_orders: [{ order_id: "0xabc", matched_amount: "3", price: "0.74" }] });
  assert.equal((await settle(venue([[bad]]), "BUY")).kind, "ambiguous");
});

test("timestamp window: before placement (beyond skew), after the window, or unreadable -> rejected", async () => {
  assert.equal((await settle(venue([[good({ match_time: String(T0S - 100) })]]))).kind, "ambiguous", "100 s before placement");
  assert.equal((await settle(venue([[good({ match_time: String(T0S + 200) })]]))).kind, "ambiguous", "after window (12 s poll + 60 s skew)");
  const r = await settle(venue([[good({ match_time: "not-a-time" })]]));
  assert.equal(r.kind, "ambiguous");
  assert.equal(r.meta.delayed_rejected_trades?.time, 1);
  const r2 = await settle(venue([[good({ match_time: null })]]));
  assert.equal(r2.kind, "ambiguous", "missing time is not provable");
  // accepted forms: unix seconds, unix milliseconds, ISO; and a trade inside the skew before placement
  assert.equal((await settle(venue([[good({ match_time: String((T0S + 2) * 1000) })]]))).kind, "filled", "milliseconds");
  assert.equal((await settle(venue([[good({ match_time: new Date((T0S + 2) * 1000).toISOString() })]]))).kind, "filled", "ISO");
  assert.equal((await settle(venue([[good({ match_time: String(T0S - 30) })]]))).kind, "filled", "30 s clock skew tolerated");
});

test("dedup: the same trade id listed twice is counted once; a trade without an id is not attributable", async () => {
  const r = await settle(venue([[good(), good()]]));
  assert.equal(r.kind, "filled");
  assert.deepEqual(r.fill, { shares: 4, priceCents: 70 }, "not 8");
  const r2 = await settle(venue([[good({ id: "" })]]));
  assert.equal(r2.kind, "ambiguous");
  assert.equal(r2.meta.delayed_rejected_trades?.noid, 1);
});

test("summed exactly once: partials surfacing over two reads are unioned by id, never double-counted", async () => {
  const a = good({ id: "t1", size: "3", price: "0.70" }), b = good({ id: "t2", size: "1", price: "0.74" });
  // first read shows only t1; the confirmation read shows both (t1 repeated) -> 4 shares, weighted 71c
  const v = venue([[a], [a, b], [a, b]]);
  const r = await settle(v);
  assert.equal(r.kind, "filled");
  assert.deepEqual(r.fill, { shares: 4, priceCents: 71 });
  assert.equal(r.meta.delayed_state, "terminal:trades(2)");
  assert.equal(v.calls.getTrades, 2, "exactly one confirmation re-read");
});

test("a failed/retrying trade is not a fill even when perfectly linked", async () => {
  const r = await settle(venue([[good({ status: "FAILED" })]]));
  assert.equal(r.kind, "ambiguous");
  assert.equal(r.meta.delayed_rejected_trades?.failed, 1);
});
