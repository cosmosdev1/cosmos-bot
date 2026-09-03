// v3 (2026-09-03, after the first live sample): the venue's TRADES resolve a delayed order, and an
// HTTP error body from the client is never mistaken for an order record.
// Reproduction of the live sample first: record reads answer `{ error, status: 404 }` (the client
// does not throw), trades show our fill 5 s later. v2 classified that ambiguous; v3 books it.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { settlePlacement, delayedLockFor, _resetDelayedLocks } from "../src/polymarket.mjs";

function clock(start = 1_000_000) { let t = start; return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } }; }
const delayedResp = (orderID = "0xabc") => ({ success: true, status: "delayed", orderID, makingAmount: "", takingAmount: "" });
const TOK = "111222333";
const fast = (c, extra = {}) => ({ now: c.now, sleep: c.sleep, pollMs: 12_000, everyMs: 500, callMs: 50, holdMs: 300_000, ...extra });
const notFound = { error: "order not found", status: 404 };
const trade = (o) => ({ id: "t1", taker_order_id: "0xabc", asset_id: TOK, side: "SELL", size: "4.22", price: "1.0", status: "MATCHED", maker_orders: [], ...o });

// A venue whose trades appear only after `tradesAfterPolls` reads, like a real delay window.
function venue({ record = notFound, tradesAfterPolls = 0, trades = [] } = {}) {
  const calls = { getOrder: 0, getTrades: 0 };
  return {
    calls,
    getOrder: async () => { calls.getOrder++; return typeof record === "function" ? record(calls.getOrder) : record; },
    getTrades: async ({ asset_id }) => { calls.getTrades++; assert.equal(asset_id, TOK, "trades are read for our token"); return calls.getTrades > tradesAfterPolls ? trades : []; },
  };
}

beforeEach(() => _resetDelayedLocks());

test("live sample 11:30:25Z: record 404 body + our trade appears after the delay -> booked from the trade, not ambiguous", async () => {
  const c = clock();
  const v = venue({ tradesAfterPolls: 10, trades: [trade()] });
  const r = await settlePlacement({ resp: delayedResp(), side: "SELL", size: 4.22, priceCents: 98, client: v, tokenId: TOK, opts: fast(c) });
  assert.equal(r.kind, "filled");
  assert.deepEqual(r.fill, { shares: 4.22, priceCents: 100 });
  assert.equal(r.meta.delayed_price_source, "own_trades");
  assert.match(r.meta.delayed_state, /^terminal:trades/);
  assert.equal(r.meta.fill_unknown, undefined);
  assert.equal(delayedLockFor(TOK, "SELL", c.now()), null, "lock released on the terminal verdict");
});

test("an HTTP error body is not a record: 404 forever + no trades -> ambiguous with state record_missing, never a zero-fill", async () => {
  const c = clock();
  const v = venue({ record: notFound });
  const r = await settlePlacement({ resp: delayedResp(), side: "BUY", size: 10, priceCents: 80, client: v, tokenId: TOK, opts: fast(c) });
  assert.equal(r.kind, "ambiguous");
  assert.equal(r.meta.delayed_state, "record_missing");
  assert.equal(r.fill, null);
  assert.ok(delayedLockFor(TOK, "BUY", c.now()), "BUY lock held");
});

test("a 5xx error body is a transport error, not a record and not a kill", async () => {
  const c = clock();
  const v = venue({ record: { error: "upstream", status: 502 } });
  const r = await settlePlacement({ resp: delayedResp(), side: "BUY", size: 10, priceCents: 80, client: v, tokenId: TOK, opts: fast(c) });
  assert.equal(r.kind, "ambiguous");
  assert.equal(r.meta.delayed_state, "unreachable");
});

test("trades that belong to OTHER orders are ignored; only taker_order_id or a maker_orders entry naming our order counts", async () => {
  const c = clock();
  const v = venue({ trades: [trade({ taker_order_id: "0xother" }), trade({ id: "t2", taker_order_id: "0xother2", maker_orders: [{ order_id: "0xabc", matched_amount: "3", price: "0.74" }] })] });
  const r = await settlePlacement({ resp: delayedResp(), side: "BUY", size: 10, priceCents: 80, client: v, tokenId: TOK, opts: fast(c) });
  assert.equal(r.kind, "filled");
  assert.deepEqual(r.fill, { shares: 3, priceCents: 74 }, "only our maker leg of the second trade");
});

test("failed/retrying trades are not fills", async () => {
  const c = clock();
  const v = venue({ trades: [trade({ status: "FAILED" })] });
  const r = await settlePlacement({ resp: delayedResp(), side: "SELL", size: 4.22, priceCents: 98, client: v, tokenId: TOK, opts: fast(c) });
  assert.equal(r.kind, "ambiguous");
});

test("partial through trades: two trades sum to the fill with a weighted price", async () => {
  const c = clock();
  const v = venue({ trades: [trade({ id: "t1", side: "BUY", size: "3", price: "0.70" }), trade({ id: "t2", side: "BUY", size: "1", price: "0.74" })] });
  const r = await settlePlacement({ resp: delayedResp(), side: "BUY", size: 10, priceCents: 80, client: v, tokenId: TOK, opts: fast(c) });
  assert.equal(r.kind, "filled");
  assert.deepEqual(r.fill, { shares: 4, priceCents: 71 });
});

test("a real record still works when the venue keeps one (MATCHED with size_matched), trades unavailable", async () => {
  const c = clock();
  const v = venue({ record: { id: "0xabc", status: "MATCHED", original_size: "10", size_matched: "10", price: "0.80", associate_trades: [] } });
  const r = await settlePlacement({ resp: delayedResp(), side: "BUY", size: 10, priceCents: 80, client: v, tokenId: TOK, opts: fast(c) });
  assert.equal(r.kind, "filled");
  assert.deepEqual(r.fill, { shares: 10, priceCents: 80 });
  assert.equal(r.meta.delayed_price_source, "limit");
});

test("verified kill through the record still yields a zero-fill, and only then", async () => {
  const c = clock();
  const v = venue({ record: { id: "0xabc", status: "CANCELED", original_size: "10", size_matched: "0", price: "0.80" } });
  const r = await settlePlacement({ resp: delayedResp(), side: "BUY", size: 10, priceCents: 80, client: v, tokenId: TOK, opts: fast(c) });
  assert.equal(r.kind, "killed");
  assert.deepEqual(r.fill, { shares: 0 });
});

test("SELL after an ambiguous verdict is refused for the short sell hold, then flows again (the 11:30:38 duplicate)", async () => {
  const c = clock();
  const v = venue({ record: notFound });
  const r = await settlePlacement({ resp: delayedResp(), side: "SELL", size: 4.22, priceCents: 98, client: v, tokenId: TOK, opts: fast(c, { sellHoldMs: 90_000 }) });
  assert.equal(r.kind, "ambiguous");
  assert.ok(delayedLockFor(TOK, "SELL", c.now()), "sell lock held right after ambiguous");
  c.advance(89_000);
  assert.ok(delayedLockFor(TOK, "SELL", c.now()), "still held inside the sell hold");
  c.advance(2_000);
  assert.equal(delayedLockFor(TOK, "SELL", c.now()), null, "released after the sell hold; exits flow again");
  assert.equal(delayedLockFor(TOK, "BUY", c.now()), null, "the buy side was never locked by a sell");
});

test("BUY ambiguous still holds the full window (unchanged from v2)", async () => {
  const c = clock();
  const v = venue({ record: notFound });
  await settlePlacement({ resp: delayedResp(), side: "BUY", size: 10, priceCents: 80, client: v, tokenId: TOK, opts: fast(c, { sellHoldMs: 90_000 }) });
  c.advance(200_000);
  assert.ok(delayedLockFor(TOK, "BUY", c.now()), "buy lock outlives the sell hold");
});
