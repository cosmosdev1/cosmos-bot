// Delayed-placement settle logic (2026-09-03 incident). These run the REAL exported functions from
// src/polymarket.mjs against a scripted venue client and a virtual clock. Each case is one of the
// adversarial cases the owner listed; the hard invariant (a delayed order is unresolved execution
// state: never a zero-fill, never a second order on the same token/side until terminal or
// ambiguous) is asserted directly.
//
// Proof these are not hollow: run this file against origin/main (no settlePlacement export) and
// every test fails at import; see test/PROOF.md.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { settlePlacement, awaitDelayedFill, isDelayedPlacement, delayedLockFor, _resetDelayedLocks } from "../src/polymarket.mjs";

// ---- virtual clock: sleep() advances time without waiting ---------------------------------------
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}
// ---- scripted venue client ------------------------------------------------------------------------
// getOrder answers the scripted sequence in order (last answer repeats); a step may be a record, an
// Error to throw, "hang" (never resolves), or null (venue says: no such record).
function venue({ orders = [], trades = {} } = {}) {
  const calls = { getOrder: 0, getTrades: 0 };
  return {
    calls,
    getOrder: async (id) => {
      const step = orders[Math.min(calls.getOrder++, orders.length - 1)];
      if (step === "hang") return new Promise(() => {});
      if (step instanceof Error) throw step;
      return step ?? null;
    },
    getTrades: async ({ id }) => { calls.getTrades++; return trades[id] ?? []; },
  };
}
const delayedResp = (orderID = "0xabc") => ({ success: true, status: "delayed", orderID, makingAmount: "", takingAmount: "", tradeIDs: [], transactionsHashes: [] });
const rec = (o) => ({ id: "0xabc", status: "LIVE", original_size: "10", size_matched: "0", price: "0.80", associate_trades: [], ...o });
const TOK = "111222333";
const fast = (c) => ({ now: c.now, sleep: c.sleep, pollMs: 12_000, everyMs: 500, callMs: 50, holdMs: 300_000 });

beforeEach(() => _resetDelayedLocks());

test("classification: delayed status is delayed; matched-with-zero is a genuine kill; empty amounts + orderID is delayed", () => {
  assert.equal(isDelayedPlacement(delayedResp(), { shares: 0 }), true);
  assert.equal(isDelayedPlacement({ status: "matched", orderID: "0x1", makingAmount: "0", takingAmount: "0" }, { shares: 0 }), false);
  assert.equal(isDelayedPlacement({ orderID: "0x1", makingAmount: "", takingAmount: "" }, null), true);
  assert.equal(isDelayedPlacement({ orderID: "0x1", makingAmount: "8000000", takingAmount: "10000000" }, { shares: 10, priceCents: 80 }), false);
  assert.equal(isDelayedPlacement(null, null), false);
});

test("case 1: delayed -> full fill is booked from the venue's trades (9.6 sh @ 75c), not the request (10 @ 80c)", async () => {
  const c = clock();
  const v = venue({ orders: [rec(), rec({ status: "MATCHED", size_matched: "9.6", associate_trades: ["t1"] })], trades: { t1: [{ id: "t1", size: "9.6", price: "0.75" }] } });
  const r = await settlePlacement({ resp: delayedResp(), side: "BUY", size: 10, priceCents: 80, client: v, tokenId: TOK, opts: fast(c) });
  assert.equal(r.kind, "filled");
  assert.deepEqual(r.fill, { shares: 9.6, priceCents: 75 });
  assert.equal(r.meta.delayed, true);
  assert.equal(r.meta.delayed_price_source, "trades");
  assert.equal(r.meta.fill_unknown, undefined);
  assert.equal(delayedLockFor(TOK, "BUY", c.now()), null, "lock released on a terminal verdict");
});

test("case 2: delayed -> partial fill books the matched part only, average price over the partial's trades", async () => {
  const c = clock();
  const v = venue({ orders: [rec(), rec({ status: "MATCHED", size_matched: "4", associate_trades: ["t1", "t2"] })],
                    trades: { t1: [{ size: "3", price: "0.70" }], t2: [{ size: "1", price: "0.74" }] } });
  const r = await settlePlacement({ resp: delayedResp(), side: "BUY", size: 10, priceCents: 80, client: v, tokenId: TOK, opts: fast(c) });
  assert.equal(r.kind, "filled");
  assert.equal(r.fill.shares, 4);
  assert.equal(r.fill.priceCents, 71);
});

test("case 2b: partial seen at the deadline with no terminal status is booked as final (a FAK matches once)", async () => {
  const c = clock();
  const v = venue({ orders: [rec({ size_matched: "2.5", associate_trades: ["t1"] })], trades: { t1: [{ size: "2.5", price: "0.60" }] } });
  const r = await settlePlacement({ resp: delayedResp(), side: "BUY", size: 10, priceCents: 80, client: v, tokenId: TOK, opts: fast(c) });
  assert.equal(r.kind, "filled");
  assert.deepEqual(r.fill, { shares: 2.5, priceCents: 60 });
  assert.equal(r.meta.delayed_state, "partial_at_deadline");
});

test("case 3: delayed -> venue-verified kill (CANCELED, 0 matched) is the only way to a zero-fill", async () => {
  const c = clock();
  const v = venue({ orders: [rec(), rec(), rec({ status: "CANCELED", size_matched: "0" })] });
  const r = await settlePlacement({ resp: delayedResp(), side: "BUY", size: 10, priceCents: 80, client: v, tokenId: TOK, opts: fast(c) });
  assert.equal(r.kind, "killed");
  assert.deepEqual(r.fill, { shares: 0 });
  assert.equal(r.meta.fill_unknown, undefined);
  assert.equal(delayedLockFor(TOK, "BUY", c.now()), null, "a verified kill releases the lock");
});

test("case 4: delayed -> record disappears: NEVER a zero-fill; ambiguous, fill_unknown, BUY lock held for the hold window", async () => {
  const c = clock();
  const v = venue({ orders: [new Error("404 not found")] });
  const r = await settlePlacement({ resp: delayedResp(), side: "BUY", size: 10, priceCents: 80, client: v, tokenId: TOK, opts: fast(c) });
  assert.equal(r.kind, "ambiguous");
  assert.equal(r.fill, null);
  assert.equal(r.meta.fill_unknown, true);
  assert.equal(r.meta.delayed_state, "record_missing");
  assert.ok(r.meta.delayed_polls >= 20, `polled through the whole window (${r.meta.delayed_polls})`);
  const l = delayedLockFor(TOK, "BUY", c.now());
  assert.ok(l && l.state === "record_missing", "lock held after ambiguous");
  c.advance(300_000 - 1);
  assert.ok(delayedLockFor(TOK, "BUY", c.now()), "still locked just before the hold ends");
  c.advance(2);
  assert.equal(delayedLockFor(TOK, "BUY", c.now()), null, "lock expires after the hold window");
});

test("case 5: delayed -> order-record API hangs: each read is bounded, the loop ends at its deadline, verdict ambiguous", async () => {
  // Real timers here on purpose: the per-call deadline is what stops a hung read from holding the loop.
  const v = venue({ orders: ["hang"] });
  const t0 = Date.now();
  const r = await settlePlacement({ resp: delayedResp(), side: "BUY", size: 10, priceCents: 80, client: v, tokenId: TOK,
                                    opts: { pollMs: 300, everyMs: 20, callMs: 40, holdMs: 300_000 } });
  const took = Date.now() - t0;
  assert.equal(r.kind, "ambiguous");
  assert.equal(r.meta.delayed_state, "unreachable");
  assert.ok(took < 1500, `bounded (${took}ms)`);
  assert.ok(delayedLockFor(TOK, "BUY"), "BUY lock held after an unreachable verdict");
});

test("case 5b: transient errors then a verdict: errors are skipped, the terminal record still books", async () => {
  const c = clock();
  const v = venue({ orders: [new Error("ECONNRESET"), new Error("ETIMEDOUT"), rec({ status: "MATCHED", size_matched: "10", associate_trades: ["t1"] })], trades: { t1: [{ size: "10", price: "0.78" }] } });
  const r = await settlePlacement({ resp: delayedResp(), side: "BUY", size: 10, priceCents: 80, client: v, tokenId: TOK, opts: fast(c) });
  assert.equal(r.kind, "filled");
  assert.deepEqual(r.fill, { shares: 10, priceCents: 78 });
});

test("case 7: repeated polling cannot double-book: one verdict, one fill object, trades fetched once per trade id", async () => {
  const c = clock();
  const matched = rec({ status: "MATCHED", size_matched: "10", associate_trades: ["t1"] });
  const v = venue({ orders: [matched, matched, matched, matched], trades: { t1: [{ size: "10", price: "0.79" }] } });
  const r = await settlePlacement({ resp: delayedResp(), side: "BUY", size: 10, priceCents: 80, client: v, tokenId: TOK, opts: fast(c) });
  assert.equal(r.kind, "filled");
  assert.equal(v.calls.getOrder, 1, "stops at the first terminal record");
  // v3: one own-trades read per poll (empty here) + one read per associate trade id; never more.
  assert.ok(v.calls.getTrades <= 2, `trades read at most twice (${v.calls.getTrades})`);
  assert.deepEqual(r.fill, { shares: 10, priceCents: 79 });
});

test("case 8: the same token/side cannot re-fire while its delayed order is pending, and BUY stays refused after ambiguous", async () => {
  const c = clock();
  let release;
  const gate = new Promise((res) => { release = res; });
  const v = { getOrder: async () => { await gate; return rec({ status: "MATCHED", size_matched: "10", associate_trades: [] }); }, getTrades: async () => [] };
  const pending = settlePlacement({ resp: delayedResp("0xfirst"), side: "BUY", size: 10, priceCents: 80, client: v, tokenId: TOK, opts: { ...fast(c), callMs: 10_000 } });
  await new Promise((r) => setTimeout(r, 5));
  const l = delayedLockFor(TOK, "BUY", c.now());
  assert.ok(l && l.state === "pending" && l.orderID === "0xfirst", "pending lock present while the first order is unresolved");
  assert.equal(delayedLockFor(TOK, "SELL", c.now()), null, "the opposite side is not locked");
  assert.equal(delayedLockFor("other-token", "BUY", c.now()), null, "other tokens are not locked");
  release();
  const r = await pending;
  assert.equal(r.kind, "filled");
  assert.equal(r.meta.delayed_price_source, "limit", "no trades exposed -> size_matched at the record price");
  assert.deepEqual(r.fill, { shares: 10, priceCents: 80 });
  assert.equal(delayedLockFor(TOK, "BUY", c.now()), null, "released on the terminal verdict");
});

test("case 9: booked shares/USD come from venue truth even when the record price differs from our cap", async () => {
  const c = clock();
  const v = venue({ orders: [rec({ status: "MATCHED", size_matched: "12.3", price: "0.42", associate_trades: ["t1"] })], trades: { t1: [{ size: "12.3", price: "0.38" }] } });
  const r = await settlePlacement({ resp: delayedResp(), side: "BUY", size: 12, priceCents: 42, client: v, tokenId: TOK, opts: fast(c) });
  assert.deepEqual(r.fill, { shares: 12.3, priceCents: 38 });
  // trades that do not reconcile with size_matched are NOT trusted: fall back to the record
  const v2 = venue({ orders: [rec({ status: "MATCHED", size_matched: "12.3", price: "0.42", associate_trades: ["t1"] })], trades: { t1: [{ size: "50", price: "0.38" }] } });
  const r2 = await settlePlacement({ resp: delayedResp(), side: "BUY", size: 12, priceCents: 42, client: v2, tokenId: "t2", opts: fast(c) });
  assert.deepEqual(r2.fill, { shares: 12.3, priceCents: 42 });
  assert.equal(r2.meta.delayed_price_source, "limit");
});

test("case 10: SELL - a delayed sell books from the record like a buy; an immediate sell answer is unchanged (extractFill semantics)", async () => {
  const c = clock();
  const v = venue({ orders: [rec({ side: "SELL", status: "MATCHED", size_matched: "7", associate_trades: ["t1"] })], trades: { t1: [{ size: "7", price: "0.55" }] } });
  const r = await settlePlacement({ resp: delayedResp(), side: "SELL", size: 7, priceCents: 50, client: v, tokenId: TOK, opts: fast(c) });
  assert.equal(r.kind, "filled");
  assert.deepEqual(r.fill, { shares: 7, priceCents: 55 });
  assert.equal(delayedLockFor(TOK, "SELL", c.now()), null);
  // immediate (not delayed) SELL: makingAmount = shares (1e6 units), takingAmount = USDC
  const imm = await settlePlacement({ resp: { status: "matched", orderID: "0x9", makingAmount: "7000000", takingAmount: "3850000" }, side: "SELL", size: 7, priceCents: 50, client: v, tokenId: TOK, opts: fast(c) });
  assert.equal(imm.kind, "immediate");
  assert.deepEqual(imm.fill, { shares: 7, priceCents: 55 });
  assert.equal(v.calls.getOrder, 1, "an immediate answer never touches the order record");
});

test("hard invariant: no path turns a delayed placement into a zero-fill without a venue-verified kill", async () => {
  const c = clock();
  const scripts = [
    { name: "record never appears", orders: [null] },
    { name: "404 forever", orders: [new Error("404")] },
    { name: "transport errors forever", orders: [new Error("ECONNRESET")] },
    { name: "LIVE forever, 0 matched", orders: [rec()] },
  ];
  for (const s of scripts) {
    _resetDelayedLocks();
    const r = await settlePlacement({ resp: delayedResp(), side: "BUY", size: 10, priceCents: 80, client: venue({ orders: s.orders }), tokenId: TOK, opts: fast(c) });
    assert.equal(r.kind, "ambiguous", s.name);
    assert.equal(r.fill, null, s.name);
    assert.equal(r.meta.fill_unknown, true, s.name);
    assert.ok(delayedLockFor(TOK, "BUY", c.now()), `${s.name}: BUY lock held`);
  }
  // and a delayed response with no orderID cannot be followed: ambiguous, never zero
  const r = await settlePlacement({ resp: { status: "delayed" }, side: "BUY", size: 10, priceCents: 80, client: venue(), tokenId: TOK, opts: fast(c) });
  assert.equal(r.kind, "ambiguous");
  assert.equal(r.meta.delayed_state, "no_orderid");
});

test("awaitDelayedFill: original_size reached without a status string counts as terminal", async () => {
  const c = clock();
  const v = venue({ orders: [rec({ status: "", size_matched: "10", associate_trades: [] })] });
  const r = await awaitDelayedFill(v, "0xabc", "BUY", 10, 80, fast(c));
  assert.equal(r.state, "terminal:full");
  assert.equal(r.fill.shares, 10);
});
