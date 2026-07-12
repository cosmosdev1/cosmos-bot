// qtable2.mjs — QTABLE candle engine, CORRECTED, integrated into the fleet bot.
//
// This is the fixed successor to qtable.mjs (which used the pre-refit table + Binance spot — the fit
// bug that ran −18.6% in 24h). It mirrors the validated standalone tester (qtable-live.mjs) EXACTLY:
//   • Chainlink RTDS reference + spot (wss://ws-live-data.polymarket.com) — the price Polymarket
//     resolves these candles on (exact, not Binance-approximated).
//   • the REFIT tow-aware table (qtable-live-data.json): conditional fit, 50 time-of-week buckets.
//   • STRICT guards: |d|≥5bps, elapsed 10–95%, ≥90s left, P≥50%, price floor 5–97c, multiplicative
//     edge (P/ask) in [EDGE, MAX_EDGE], Chainlink-spot staleness cutoff. CANDLES ONLY.
//   • $2 marketable FAK placed through the bot's OWN pm/placeWithRetry (builder code already applied).
//
// Spawned from main() ONLY when QTABLE2_ENABLED=1 (per-deployment gate — set as a Fly secret on ONE
// user's app; every other bot leaves the flag unset and never even imports this file). Runs as a fast
// ~250ms side-loop next to the 30s cycle. DRY: QTABLE2_DRY=1 logs would-be fills, places nothing.
import { readFileSync, appendFileSync } from "node:fs";
import { log, warn } from "./log.mjs";

// The bot runs on node:20-slim, which has NO global WebSocket. Without this the Chainlink RTDS feed
// silently retries forever (the reconnect catch swallows the ReferenceError) and the engine never gets
// spot -> never signals. Fall back to the `ws` package (already a transitive dep, pinned in package.json).
const WSImpl = globalThis.WebSocket ?? (await import("ws")).WebSocket;
const WS_OPTS = globalThis.WebSocket ? undefined : { headers: { Origin: "https://polymarket.com" } };

const N = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };
const STAKE = N("QTABLE2_STAKE_USD", 0);        // fixed $/trade override; 0 (default) = account's dashboard % sizing (e.g. 3%)
const EDGE = N("QTABLE2_EDGE", 1.08);           // multiplicative: P / best-ask
const COINS = (process.env.QTABLE2_COINS || "BTCUSDT").split(",").map((s) => s.trim());
const MAX_OPEN = N("QTABLE2_MAX_OPEN", 8);
const TICK_MS = N("QTABLE2_TICK_MS", 250);
const DRY = process.env.QTABLE2_DRY === "1";
// guards — identical to the validated qtable-live engine
const MIN_D = 0.0005, MIN_ELAPSED = 10, MAX_ELAPSED = 95, MIN_REMAIN_S = 90;
// Tiered entry (owner 2026-07-12): floor at 35% model prob; the lower prob band needs a bigger edge.
const MIN_P = N("QTABLE2_MIN_P", 0.35);         // absolute floor — never trade a side below 35% model prob
const HIGH_P = N("QTABLE2_HIGH_P", 0.55);       // p >= HIGH_P uses EDGE; MIN_P..HIGH_P uses the stricter EDGE_MID
const EDGE_MID = N("QTABLE2_EDGE_MID", 1.15);   // required edge (P/ask) on the 35%-54% band
const edgeReqFor = (p) => (p >= HIGH_P ? EDGE : EDGE_MID); // (only called when p >= MIN_P)
const MIN_PRICE = 0.05, MAX_PRICE = 0.97;
const STALE_MS = N("QTABLE2_MAX_SPOT_AGE_MS", 8000);
const MAX_EDGE = N("QTABLE2_MAX_EDGE", 3.0);    // >3x P/ask almost always = wrong reference, not edge

const FRAME_MS = { "5m": 300_000, "15m": 900_000 };
const TABLE_FRAME = { "5m": "5m", "15m": "15m" };
const WS_SYM = { "btc/usd": "BTCUSDT", "eth/usd": "ETHUSDT" };
const API_SYM = { BTCUSDT: "BTC", ETHUSDT: "ETH" };
const VARIANT = { "5m": "fiveminute", "15m": "fifteenminute" };
const TABLE = JSON.parse(readFileSync(new URL("./qtable-live-data.json", import.meta.url), "utf8"));

// Durable per-trade ledger on the persistent volume (survives restarts) — read by src/qtable2-report.mjs.
const DATA_DIR = (process.env.COSMOS_DATA_DIR || ".").replace(/\/$/, "");
const LEDGER = `${DATA_DIR}/qtable2-trades.ndjson`;
function appendLedger(rec) { try { appendFileSync(LEDGER, JSON.stringify(rec) + "\n"); } catch (e) { warn("qtable2 ledger:", e?.message); } }

// ---- table lookup (tow-aware; ported from lib/qtable.ts) ----
function towBucket(ms, buckets) {
  const d = new Date(ms);
  const sow = d.getUTCDay() * 86400 + d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  return Math.min(buckets - 1, Math.max(0, Math.floor(sow / (604800 / buckets))));
}
function lookupP(sym, tblFrame, elapsedPct, d, towB) {
  const fr = TABLE.coins[sym]?.frames?.[tblFrame];
  if (!fr?.pts?.length) return null;
  const gmax = TABLE.meta.gmax;
  const gi = Math.max(0, Math.min(2 * gmax, Math.round(d / TABLE.meta.step) + gmax));
  if (towB != null && fr.tow && fr.tow[towB]?.length) {
    let best = null;
    for (const r of fr.tow[towB]) if (best == null || Math.abs(r.pct - elapsedPct) < Math.abs(best.pct - elapsedPct)) best = r;
    if (best) { const j = gi - best.g0; if (j >= 0 && j < best.p.length) return best.p[j] / 1000; }
  }
  let base = fr.pts[0];
  for (const p of fr.pts) if (Math.abs(p.pct - elapsedPct) < Math.abs(base.pct - elapsedPct)) base = p;
  return base.surv[gi] ?? null;
}

// ---- Chainlink RTDS: reference buffer + live spot (same source Polymarket resolves on) ----
const hist = {}; // sym -> [{t,v}] last ~35min
const spot = {}; // sym -> latest value
const refFor = (sym, windowStartMs) => {
  const h = hist[sym]; if (!h || !h.length || h[0].t > windowStartMs) return null;
  for (let i = 0; i < h.length; i++) if (h[i].t >= windowStartMs) return h[i].v;
  return null;
};
function connectChainlink() {
  let ws, stopped = false;
  const go = () => {
    try { ws = new WSImpl("wss://ws-live-data.polymarket.com", WS_OPTS); } catch { return setTimeout(go, 1500); }
    ws.onopen = () => { ws.send(JSON.stringify({ action: "subscribe", subscriptions: [
      { topic: "crypto_prices_chainlink", type: "*", filters: JSON.stringify({ symbol: "btc/usd" }) },
      { topic: "crypto_prices_chainlink", type: "*", filters: JSON.stringify({ symbol: "eth/usd" }) },
    ] })); log("qtable2 chainlink: connected"); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      const p = m?.payload ?? m; const sym = WS_SYM[String(p?.symbol ?? "").toLowerCase()];
      if (!sym) return;
      const h = hist[sym] ?? (hist[sym] = []); let last = 0;
      if (Array.isArray(p.data)) { for (const d of p.data) { const t = Number(d?.timestamp), v = Number(d?.value); if (v > 0 && t > 0) { h.push({ t, v }); last = v; } }
        const mp = new Map(); for (const x of h) mp.set(x.t, x.v); hist[sym] = [...mp.entries()].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
      } else { const t = Number(p.timestamp) || Date.now(), v = Number(p.value); if (v > 0) { h.push({ t, v }); last = v; } }
      const buf = hist[sym]; const cut = (buf.length ? buf[buf.length - 1].t : Date.now()) - 35 * 60_000;
      while (buf.length > 1 && buf[0].t < cut) buf.shift();
      if (last > 0) spot[sym] = last;
    };
    ws.onclose = () => { if (!stopped) setTimeout(go, 1500); };
    ws.onerror = () => { try { ws.close(); } catch { /* */ } };
  };
  go();
  return () => { stopped = true; try { ws?.close(); } catch { /* */ } };
}

const j = async (u, ms = 4000) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; } };
const parseArr = (s) => { try { return JSON.parse(String(s ?? "[]")); } catch { return []; } };

const SERIES = [
  { frame: "5m", sym: "BTCUSDT", slug: "btc-up-or-down-5m" },
  { frame: "5m", sym: "ETHUSDT", slug: "eth-up-or-down-5m" },
  { frame: "15m", sym: "BTCUSDT", slug: "btc-up-or-down-15m" },
  { frame: "15m", sym: "ETHUSDT", slug: "eth-up-or-down-15m" },
  { frame: "15m", sym: "ETHUSDT", slug: "ethereum-up-or-down-15m" },
].filter((s) => COINS.includes(s.sym));

// best ASK (what a marketable BUY actually pays), in [0,1], with a two-sided-book spread sanity guard
async function bestAsk(tokenId) {
  const d = await j(`https://clob.polymarket.com/book?token_id=${tokenId}`, 3000);
  const asks = d?.asks || [], bids = d?.bids || [];
  let ba = null, bb = null;
  for (const a of asks) { const p = Number(a?.price); const sz = Number(a?.size); if (p > 0 && sz > 0 && (ba == null || p < ba)) ba = p; }
  for (const b of bids) { const p = Number(b?.price); const sz = Number(b?.size); if (p > 0 && sz > 0 && (bb == null || p > bb)) bb = p; }
  if (ba == null || bb == null) return null;             // one-sided book -> not tradable
  if (ba - bb > 0.10) return null;                       // spread too wide -> skip
  return ba;
}

export function startQTable2(deps) {
  const { pm, cosmos, store, placeWithRetry, sharesFor, sizeForSignal, state } = deps;
  const markets = new Map();  // cid -> descriptor
  const apiRef = {};          // cid -> backfilled window-open reference
  const done = new Set();     // cid -> already ordered / permanently skipped this run
  const fails = new Map();    // cid -> failed order attempts
  const stats = { signals: 0, orders: 0, fills: 0 };
  let alive = true;

  async function discover() {
    const now = Date.now();
    for (const s of SERIES) {
      const evs = await j(`https://gamma-api.polymarket.com/events?series_slug=${s.slug}&closed=false&limit=8&order=endDate&ascending=true&end_date_min=${new Date(now).toISOString()}`);
      if (!Array.isArray(evs)) continue;
      const frameMs = FRAME_MS[s.frame];
      for (const e of evs) for (const m of (e.markets ?? [])) {
        const cid = String(m.conditionId ?? ""); if (!cid) continue;
        const endMs = Date.parse(m.endDate ?? e.endDate ?? ""); if (!Number.isFinite(endMs) || endMs <= now) continue;
        if (endMs - now > 2 * frameMs) continue;
        const toks = parseArr(m.clobTokenIds), outs = parseArr(m.outcomes);
        const ai = outs.findIndex((o) => /^up$/i.test(o)), bi = outs.findIndex((o) => /^down$/i.test(o));
        if (ai < 0 || bi < 0 || !toks[ai] || !toks[bi]) continue;
        if (!markets.has(cid)) markets.set(cid, { cid, sym: s.sym, frame: s.frame, frameMs, endMs, windowStartMs: endMs - frameMs, question: String(m.question ?? ""), tokenUp: String(toks[ai]), tokenDn: String(toks[bi]), outUp: String(outs[ai]), outDn: String(outs[bi]) });
      }
    }
    for (const [cid, m] of markets) if (m.endMs <= now - 30_000) markets.delete(cid);
  }

  // backfill the window-open reference for in-window candles we missed live (Polymarket price-history)
  async function backfillRefs() {
    const now = Date.now();
    for (const m of markets.values()) {
      if (apiRef[m.cid] != null || refFor(m.sym, m.windowStartMs) != null) continue;
      const rem = m.endMs - now; if (rem <= 0 || rem > m.frameMs) continue;
      if ((m.frameMs - rem) / 1000 <= 130) continue;
      const startISO = new Date(m.windowStartMs).toISOString(), endISO = new Date(m.windowStartMs + m.frameMs).toISOString();
      const arr = await j(`https://polymarket.com/api/crypto/price-history?symbol=${API_SYM[m.sym]}&variant=${VARIANT[m.frame]}&eventStartTime=${encodeURIComponent(startISO)}&endDate=${encodeURIComponent(endISO)}`);
      const v = Array.isArray(arr) && arr[0] ? Number(arr[0].value) : NaN;
      if (Number.isFinite(v) && v > 0) apiRef[m.cid] = v;
    }
  }
  const strikeFor = (m) => refFor(m.sym, m.windowStartMs) ?? apiRef[m.cid] ?? null;

  // one pass over every in-window market. Sequential + single positions load per tick (mirrors
  // qtable.mjs): the in-window candle set is tiny (1–2 markets), and it avoids the store clobber a
  // concurrent load/save would cause.
  async function tick() {
    if (state.cash == null || state.sizing == null) return;  // no cycle data yet (first 30s after boot)
    const now = Date.now();
    const positions = store.load();
    let openQt = 0; for (const p of Object.values(positions)) if (p.source === "qtable") openQt++;

    for (const m of [...markets.values()]) {
      const remaining = m.endMs - now;
      if (remaining <= 0) { markets.delete(m.cid); continue; }
      if (remaining > m.frameMs) continue;                    // window not started
      if (done.has(m.cid)) continue;
      if (positions[m.cid]) { done.add(m.cid); markets.delete(m.cid); continue; }
      if (openQt >= MAX_OPEN) return;
      const strike = strikeFor(m); if (strike == null) continue;
      const S = spot[m.sym]; if (!S) continue;
      const h = hist[m.sym]; const spotAge = h?.length ? now - h[h.length - 1].t : Infinity;
      if (spotAge > STALE_MS) continue;                       // stale Chainlink spot -> d meaningless
      const d = (S - strike) / strike;
      const elapsed = 100 * (1 - remaining / m.frameMs);
      if (Math.abs(d) < MIN_D) continue;
      if (elapsed < MIN_ELAPSED || elapsed > MAX_ELAPSED) continue;
      if (remaining < MIN_REMAIN_S * 1000) continue;
      const towB = TABLE.meta.towBuckets ? towBucket(m.windowStartMs, TABLE.meta.towBuckets) : undefined;
      const pAbove = lookupP(m.sym, TABLE_FRAME[m.frame], elapsed, d, towB);
      if (pAbove == null) continue;
      const pUp = pAbove, pDn = 1 - pAbove;
      const tBook = Date.now();                                        // start of book-fetch + order latency
      const cands = [];
      if (pUp >= MIN_P) { const ask = await bestAsk(m.tokenUp); const e = ask ? pUp / ask : 0; if (ask != null && ask >= MIN_PRICE && ask <= MAX_PRICE && e >= edgeReqFor(pUp) && e <= MAX_EDGE) cands.push({ side: "Up", token: m.tokenUp, outcome: m.outUp, p: pUp, ask, edge: e }); }
      if (pDn >= MIN_P) { const ask = await bestAsk(m.tokenDn); const e = ask ? pDn / ask : 0; if (ask != null && ask >= MIN_PRICE && ask <= MAX_PRICE && e >= edgeReqFor(pDn) && e <= MAX_EDGE) cands.push({ side: "Down", token: m.tokenDn, outcome: m.outDn, p: pDn, ask, edge: e }); }
      const pick = cands.sort((a, b) => b.edge - a.edge)[0];
      if (!pick) continue;

      stats.signals++;
      const bookMs = Date.now() - tBook;                               // book-fetch + decision latency
      // sizing: fixed $ if QTABLE2_STAKE_USD>0, else the account's dashboard % (e.g. 3% flat), floored at $2
      const sizeUsd = STAKE > 0 ? STAKE : Math.max(2, sizeForSignal(state.sizing, { source: "qtable", outcome: pick.outcome }, state.portfolio, state.deployed));
      const priceCents = Math.min(97, Math.round(pick.ask * 100) + 1); // cross the ask
      const shares = Math.max(Math.ceil(100 / priceCents), sharesFor(sizeUsd, priceCents));
      const orderUsd = (shares * priceCents) / 100;
      const tag = `${pick.side} ${m.frame} ${m.sym} @ ${priceCents}c P=${(pick.p * 100).toFixed(0)}% edge=${pick.edge.toFixed(3)} d=${(d * 100).toFixed(3)}% t=${elapsed.toFixed(0)}%`;
      if (orderUsd > state.cash) { done.add(m.cid); continue; }        // no room; re-armed next discover
      if (DRY) { log(`qtable2 DRY would BUY ${tag} · spotAge=${spotAge}ms book=${bookMs}ms · ${m.question.slice(0, 36)}`); done.add(m.cid); continue; }

      done.add(m.cid); // one shot per market
      const t0 = Date.now();
      const r = await placeWithRetry(pm, { tokenId: pick.token, side: "BUY", sizeShares: shares, priceCents, orderType: "FAK" }, 2, 80);
      const orderMs = Date.now() - t0, totalMs = bookMs + orderMs;     // fresh-spot -> order landed
      stats.orders++;
      const rec = { ts: new Date().toISOString(), cid: m.cid, q: m.question, sym: m.sym, frame: m.frame, side: pick.side, outcome: pick.outcome, entry_cents: priceCents, edge: Number(pick.edge.toFixed(4)), p: Number(pick.p.toFixed(4)), d_pct: Number((d * 100).toFixed(4)), elapsed_pct: Number(elapsed.toFixed(1)), size_usd: Number(orderUsd.toFixed(2)), shares: Number(shares.toFixed(2)), token_id: pick.token, end_ms: m.endMs, spot_age_ms: spotAge, book_ms: bookMs, order_ms: orderMs, total_ms: totalMs };
      if (!r.ok) {
        const f = (fails.get(m.cid) ?? 0) + 1; fails.set(m.cid, f);
        if (!(f >= 5 || (typeof r.status === "number" && r.status >= 400 && r.status < 500 && f >= 3))) done.delete(m.cid); // let it retry next tick
        else markets.delete(m.cid);
        appendLedger({ ...rec, ok: false, err: String(r.error ?? r.err ?? r.status ?? "").slice(0, 140) });
        log(`FAIL [qtable2] ${tag} · order=${orderMs}ms · ${String(r.error ?? r.err ?? r.status ?? "").slice(0, 110)}`);
        continue;
      }
      stats.fills++;
      try { await cosmos.meter({ ...r.meta, source: "qtable" }); } catch { /* best-effort */ }
      positions[m.cid] = {
        condition_id: m.cid, token_id: pick.token, outcome: pick.outcome, source: "qtable",
        entry_cents: priceCents, size_usd: orderUsd, size_shares: shares, entry_whales: [],
        market_question: m.question, opened_at: rec.ts,
      };
      store.save(positions);
      appendLedger({ ...rec, ok: true });
      state.cash -= orderUsd; state.deployed += orderUsd; openQt++;
      markets.delete(m.cid);
      log(`BUY  [qtable2] ${tag} · $${orderUsd.toFixed(2)} · spotAge=${spotAge}ms book=${bookMs}ms order=${orderMs}ms total=${totalMs}ms${totalMs > 1000 ? " ⚠SLOW" : ""} · ${m.question.slice(0, 36)} ✓`);
    }
  }

  (async function run() {
    log(`qtable2: engine ON · ${STAKE > 0 ? "$" + STAKE + "/trade" : "dashboard % sizing"} · edge ${EDGE}@p≥${(HIGH_P * 100).toFixed(0)}% / ${EDGE_MID}@p${(MIN_P * 100).toFixed(0)}-${(HIGH_P * 100).toFixed(0)}% · ${COINS.join(",")} · tick ${TICK_MS}ms${DRY ? " · DRY RUN" : ""}`);
    const stopWs = connectChainlink();
    await discover().catch(() => {});
    const di = setInterval(() => discover().catch(() => {}), 15_000);
    const bi = setInterval(() => backfillRefs().catch(() => {}), 4_000);
    const si = setInterval(() => {
      const bh = hist["BTCUSDT"]; const age = bh?.length ? Date.now() - bh[bh.length - 1].t : Infinity;
      const feed = age === Infinity ? "NO FEED ⚠" : `$${(spot["BTCUSDT"] ?? 0).toFixed(0)} ${age}ms`;
      log(`qtable2 … tracking ${markets.size} · btc ${feed} · signals ${stats.signals} · orders ${stats.orders} · fills ${stats.fills}`);
    }, 30_000);
    while (alive) {
      const t0 = Date.now();
      try { await tick(); } catch (e) { warn("qtable2:", e?.message); }
      await new Promise((res) => setTimeout(res, Math.max(120, TICK_MS - (Date.now() - t0))));
    }
    clearInterval(di); clearInterval(bi); clearInterval(si); stopWs();
  })();
  return () => { alive = false; };
}
