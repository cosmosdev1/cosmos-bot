// QTABLE - the empirical-table crypto engine (owner spec 2026-07-09).
//
// Probability source: qtable-data.json - P(finish ABOVE strike | spot distance d, elapsed % of
// frame), fitted per (coin x frame) on Binance klines, the feed Polymarket's strike markets
// resolve on (verified: 200/200 agreement with actual Polymarket resolutions; rules quoted from
// the market text). Frames: 15m / 1h / 4h / 1d.
//
// Trading spec: tick every 5s (QTABLE_TICK_MS) -> one Binance spot fetch -> per tracked market
// compute d + elapsed -> table P -> trade a side only when P >= 50% (QTABLE_MIN_P) AND the
// EXECUTABLE ask leaves >= 12pp (QTABLE_EDGE) of edge. Orders are placed IMMEDIATELY from this
// loop (marketable FAK via the same CLOB client + builder code) - no server round-trip.
//
// Source caveat, measured not assumed: the 15m/5m candle family resolves on CHAINLINK BTC/USD,
// not Binance. Divergence measured on 75 resolved candles: 98.7% agreement, the one miss was a
// 0.3bps dead-tie. Candle frames therefore get a probability HAIRCUT (QTABLE_CANDLE_HAIRCUT,
// 1.5pp) on top of the edge. Strike frames (1h/1d) are exactly resolution-true.
import { readFileSync } from "node:fs";
import { log, warn } from "./log.mjs";

const TABLE = JSON.parse(readFileSync(new URL("./qtable-data.json", import.meta.url), "utf8"));
const N = (k, f) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : f; };
const TICK_MS = N("QTABLE_TICK_MS", 3000); // owner: order speed is critical - faster trigger detection
const DISCOVER_MS = N("QTABLE_DISCOVER_MS", 120000);
const EDGE = N("QTABLE_EDGE", 0.12); // hardened 8->12pp (owner 2026-07-09): day-one calibration showed ~11pp claim-vs-realized deficit
const MIN_P = N("QTABLE_MIN_P", 0.50);
const MIN_REMAIN_S = N("QTABLE_MIN_REMAIN_S", 90);   // knife-edge guard: no entries in the last 90s
const MAX_OPEN = N("QTABLE_MAX_OPEN", 8);            // concurrent qtable positions
const MIN_VOL = N("QTABLE_MIN_VOL", 100);            // $ traded floor per market
const MAX_SPREAD_C = N("QTABLE_MAX_SPREAD_C", 10);   // book sanity
const CANDLE_HAIRCUT = N("QTABLE_CANDLE_HAIRCUT", 0.05); // Chainlink buffer + candle miscalibration margin (day-one: 15m realized 54% WR vs 57% breakeven at 8pp) -> candles need 17pp total
const SPOT_STALE_MS = N("QTABLE_SPOT_STALE_MS", 15000);
// Fill-reconstruction audit (92 real fills, 2026-07-09): entries with |d| < 5bps realized 49% WR
// (coin-flips - spot hugging the strike, table P hypersensitive to spot jitter between tick and
// fill), while 5-15bps realized 82%. Tiny-|d| "edges" are model noise, not signal - floor them.
const MIN_ABS_D = N("QTABLE_MIN_ABS_D", 0.0005);
// PNL-by-decile audit: entries in the first 10% of the window bled -13.6% on 35% of all volume
// (candle barely off its open -> P is noise). Owner rule: never trade the first 10%.
const MIN_ELAPSED_PCT = N("QTABLE_MIN_ELAPSED_PCT", 10);
const DRY = process.env.QTABLE_DRY === "1";

const FRAME_MS = { "15m": 900e3, "1h": 3600e3, "4h": 14400e3, "1d": 86400e3 };
// Polymarket families per frame. type "strike": "above $K" (Binance-resolved, verified).
// type "candle": Up/Down vs range start (Chainlink-resolved -> haircut applies).
const SERIES = [
  { frame: "15m", sym: "BTCUSDT", type: "candle", slug: "btc-up-or-down-15m" },
  { frame: "15m", sym: "ETHUSDT", type: "candle", slug: "eth-up-or-down-15m" },
  { frame: "15m", sym: "ETHUSDT", type: "candle", slug: "ethereum-up-or-down-15m" },
  { frame: "1h",  sym: "BTCUSDT", type: "strike", slug: "bitcoin-multi-strikes-hourly" },
  { frame: "1h",  sym: "ETHUSDT", type: "strike", slug: "ethereum-multi-strikes-hourly" },
  { frame: "4h",  sym: "BTCUSDT", type: "strike", slug: "bitcoin-multi-strikes-4h" },   // no such family today; auto-activates if listed
  { frame: "4h",  sym: "BTCUSDT", type: "candle", slug: "btc-up-or-down-4h" },
  { frame: "1d",  sym: "BTCUSDT", type: "strike", slug: "btc-multi-strikes-weekly" },   // daily "above K on <date>", 12PM ET close
  { frame: "1d",  sym: "ETHUSDT", type: "strike", slug: "ethereum-multi-strikes-weekly" },
];

async function j(url, timeoutMs = 6000) {
  try { const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) }); return r.ok ? await r.json() : null; } catch { return null; }
}
const parseArr = (s) => { if (Array.isArray(s)) return s; try { return JSON.parse(String(s ?? "[]")); } catch { return []; } };

// ---- pure, exported for tests ----
// Table lookup: nearest elapsed point, d clamped to the grid. Returns P(finish above).
export function lookupP(sym, frame, elapsedPct, d) {
  const fr = TABLE.coins[sym]?.frames?.[frame];
  if (!fr?.pts?.length) return null;
  let best = fr.pts[0];
  for (const p of fr.pts) if (Math.abs(p.pct - elapsedPct) < Math.abs(best.pct - elapsedPct)) best = p;
  const gmax = TABLE.meta.gmax;
  const gi = Math.max(0, Math.min(2 * gmax, Math.round(d / TABLE.meta.step) + gmax));
  return { p: best.surv[gi], pct: best.pct, n: best.n };
}
// Owner spec: min prob 50% on the side AND executable ask <= (P - edge). Haircut shaves P for
// candle frames. Returns the better side or null. Side A = YES/UP, side B = NO/DOWN.
export function decide(pAbove, askAC, askBC, haircut = 0) {
  const cands = [];
  const pA = pAbove - haircut, pB = (1 - pAbove) - haircut;
  if (pA >= MIN_P && askAC != null && askAC <= Math.floor((pA - EDGE) * 100)) cands.push({ side: "A", p: pA, price: askAC });
  if (pB >= MIN_P && askBC != null && askBC <= Math.floor((pB - EDGE) * 100)) cands.push({ side: "B", p: pB, price: askBC });
  return cands.sort((x, y) => (y.p - y.price / 100) - (x.p - x.price / 100))[0] ?? null;
}

// executable best ask (cents) with a two-sided-book spread sanity guard
async function bestAskC(tokenId) {
  const d = await j(`https://clob.polymarket.com/book?token_id=${tokenId}`, 4000);
  const asks = Array.isArray(d?.asks) ? d.asks : [], bids = Array.isArray(d?.bids) ? d.bids : [];
  let ba = null, bb = null;
  for (const a of asks) { const p = +a.price; if (p > 0 && +a.size > 0 && (ba == null || p < ba)) ba = p; }
  for (const b of bids) { const p = +b.price; if (p > 0 && +b.size > 0 && (bb == null || p > bb)) bb = p; }
  if (ba == null || bb == null) return null; // one-sided book - not tradable
  const askC = Math.round(ba * 100);
  if (askC - Math.round(bb * 100) > MAX_SPREAD_C) return null;
  return askC;
}

export function startQTable(deps) {
  const { pm, cosmos, store, placeWithRetry, sharesFor, sizeForSignal, state } = deps;
  const tracked = new Map();   // cid -> market descriptor
  const done = new Set();      // cids bought / permanently skipped
  const fails = new Map();     // cid -> failed order attempts
  const kCache = new Map();    // candle range-start price (the strike)
  let spot = { at: 0, px: {} };
  let lastDiscover = 0;
  let alive = true;

  async function discover() {
    let added = 0;
    for (const s of SERIES) {
      // soonest-first is CRITICAL: these series list events weeks ahead; an unordered page can
      // miss the in-window markets entirely (caught in the pre-ship dry-run).
      const evs = await j(`https://gamma-api.polymarket.com/events?series_slug=${s.slug}&closed=false&limit=25&order=endDate&ascending=true&end_date_min=${new Date().toISOString()}`);
      if (!Array.isArray(evs)) continue;
      for (const e of evs) {
        for (const m of e.markets ?? []) {
          const cid = String(m.conditionId ?? "");
          if (!cid || tracked.has(cid) || done.has(cid)) continue;
          const endMs = Date.parse(m.endDate ?? e.endDate ?? 0);
          if (!Number.isFinite(endMs) || endMs <= Date.now()) continue;
          if ((Number(m.volume) || 0) < MIN_VOL && s.type === "strike") continue;
          const toks = parseArr(m.clobTokenIds).map(String);
          const outs = parseArr(m.outcomes).map(String);
          let K = null, ai, bi;
          if (s.type === "strike") {
            const mm = String(m.question ?? "").match(/above\s+\$?([\d,]+(?:\.\d+)?)/i);
            if (!mm) continue;
            K = Number(mm[1].replace(/,/g, ""));
            ai = outs.findIndex((o) => /^yes$/i.test(o)); bi = outs.findIndex((o) => /^no$/i.test(o));
          } else {
            ai = outs.findIndex((o) => /^up$/i.test(o)); bi = outs.findIndex((o) => /^down$/i.test(o));
          }
          if (ai < 0 || bi < 0 || !toks[ai] || !toks[bi]) continue;
          tracked.set(cid, { cid, sym: s.sym, frame: s.frame, type: s.type, K, endMs, q: String(m.question ?? ""), tokenA: toks[ai], tokenB: toks[bi], outA: outs[ai], outB: outs[bi] });
          added++;
        }
      }
    }
    if (added) log(`qtable: tracking ${tracked.size} markets (+${added})`);
  }

  // candle strike = the range-start price (Binance 1m open at window start; ~Chainlink within bps)
  async function candleK(sym, windowStartMs) {
    const key = `${sym}|${windowStartMs}`;
    if (kCache.has(key)) return kCache.get(key);
    const k = await j(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=1m&startTime=${windowStartMs}&limit=1`);
    const open = Array.isArray(k) && k[0] && k[0][0] === windowStartMs ? +k[0][1] : null;
    if (open) kCache.set(key, open);
    return open;
  }

  let tickN = 0;
  async function tick() {
    const now = Date.now();
    // one spot fetch for both coins
    const t = await j(`https://data-api.binance.vision/api/v3/ticker/price?symbols=%5B%22BTCUSDT%22,%22ETHUSDT%22%5D`, 4000);
    if (Array.isArray(t)) { const px = {}; for (const r of t) px[r.symbol] = +r.price; spot = { at: now, px }; }
    if (now - spot.at > SPOT_STALE_MS) return;                 // stale spot -> never trade blind
    if (!state.sizing || state.cash == null) return;           // no cycle data yet (first 30s after boot)

    // fresh positions view every tick (cheap local JSON) - dedupe vs everything the bot holds
    const positions = store.load();
    let openQt = 0;
    for (const p of Object.values(positions)) if (p.source === "qtable") openQt++;

    let dbg = { inWin: 0, evald: 0, booked: 0 };
    for (const [cid, m] of tracked) {
      const remaining = m.endMs - now;
      if (remaining <= 0) { tracked.delete(cid); continue; }
      if (positions[cid]) { done.add(cid); tracked.delete(cid); continue; }
      const frameMs = FRAME_MS[m.frame];
      if (remaining > frameMs) continue;                        // window not started (tracked, waiting)
      if (remaining < MIN_REMAIN_S * 1000) continue;            // knife-edge guard
      dbg.inWin++;
      if (openQt >= MAX_OPEN) return;

      let K = m.K;
      if (K == null) {                                          // candle: strike = range-start price
        K = await candleK(m.sym, m.endMs - frameMs);
        if (K == null) continue;
        m.K = K;
      }
      const S = spot.px[m.sym];
      if (!S) continue;
      const d = (S - K) / K;
      if (Math.abs(d) < MIN_ABS_D) continue;                    // knife's-edge spot: P is noise there
      const elapsedPct = 100 * (1 - remaining / frameMs);
      if (elapsedPct < MIN_ELAPSED_PCT) continue;              // owner: never trade the first 10%
      const look = lookupP(m.sym, m.frame, elapsedPct, d);
      if (!look) continue;
      dbg.evald++;
      const haircut = m.type === "candle" ? CANDLE_HAIRCUT : 0;
      // cheap pre-trigger: only touch the book when an order is even possible
      const pMax = Math.max(look.p, 1 - look.p) - haircut;
      if (pMax < MIN_P || pMax - EDGE < 0.02) continue;
      const tTrig = Date.now(); // trigger hit: measure book+order latency (owner budget: <=1s)
      const [askA, askB] = await Promise.all([
        look.p - haircut >= MIN_P ? bestAskC(m.tokenA) : null,
        (1 - look.p) - haircut >= MIN_P ? bestAskC(m.tokenB) : null,
      ]);
      dbg.booked++;
      const dec = decide(look.p, askA, askB, haircut);
      if (!dec) continue;

      const token = dec.side === "A" ? m.tokenA : m.tokenB;
      const outcome = dec.side === "A" ? m.outA : m.outB;
      const sizeUsd = Math.max(2, sizeForSignal(state.sizing, { source: "qtable", outcome }, state.portfolio, state.deployed));
      const priceCents = Math.min(98, dec.price + 1);           // marketable: cross the ask
      const shares = Math.max(Math.ceil(100 / priceCents), sharesFor(sizeUsd, priceCents));
      const orderUsd = (shares * priceCents) / 100;
      if (orderUsd > state.cash) continue;                      // no room - re-checked next tick

      if (DRY) { log(`qtable DRY: would BUY ${outcome} @ ${priceCents}c $${orderUsd.toFixed(2)} · P=${(dec.p * 100).toFixed(1)}% d=${(d * 100).toFixed(3)}% t=${elapsedPct.toFixed(0)}% · ${m.q.slice(0, 44)}`); done.add(cid); continue; }

      const r = await placeWithRetry(pm, { tokenId: token, side: "BUY", sizeShares: shares, priceCents, orderType: "FAK" }, 2, 80);
      if (!r.ok) {
        const f = (fails.get(cid) ?? 0) + 1; fails.set(cid, f);
        if (f >= 5 || (typeof r.status === "number" && r.status >= 400 && r.status < 500 && f >= 3)) { done.add(cid); tracked.delete(cid); }
        continue;
      }
      try { await cosmos.meter({ ...r.meta, source: "qtable" }); } catch { /* best-effort */ }
      positions[cid] = {
        condition_id: cid, token_id: token, outcome, source: "qtable",
        entry_cents: priceCents, size_usd: orderUsd, size_shares: shares, entry_whales: [],
        market_question: m.q, opened_at: new Date().toISOString(),
      };
      store.save(positions);
      state.cash -= orderUsd; state.deployed += orderUsd; openQt++;
      done.add(cid); tracked.delete(cid);
      log(`BUY  [qtable] ${outcome} @ ~${priceCents}c · $${orderUsd.toFixed(2)} · P=${(dec.p * 100).toFixed(1)}% d=${(d * 100).toFixed(3)}% t=${elapsedPct.toFixed(0)}% ${m.frame} · lat=${Date.now() - tTrig}ms · ${m.q.slice(0, 44)}`);
    }
    if (process.env.QTABLE_DEBUG === "1" && ++tickN % 6 === 0) log(`qtable: tracked ${tracked.size} · in-window ${dbg.inWin} · evaluated ${dbg.evald} · book-checked ${dbg.booked}`);
  }

  (async function run() {
    log(`qtable: engine ON · tick ${TICK_MS / 1000}s · edge ${EDGE * 100}pp · minP ${MIN_P * 100}% · frames ${Object.keys(FRAME_MS).join("/")}${DRY ? " · DRY RUN" : ""}`);
    while (alive) {
      const t0 = Date.now();
      try {
        if (t0 - lastDiscover > DISCOVER_MS) { lastDiscover = t0; await discover(); }
        await tick();
      } catch (e) { warn("qtable:", e.message); }
      const dt = Date.now() - t0;
      await new Promise((res) => setTimeout(res, Math.max(400, TICK_MS - dt)));
    }
  })();
  return () => { alive = false; };
}
