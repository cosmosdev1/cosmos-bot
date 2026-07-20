// cert15.mjs — "cert15" late-candle CERTAINTY engine, 15-minute crypto candles, fleet-wide.
//
// Strategy (owner spec 2026-07-15, hardened beyond the validated backtest envelope): in the last
// 45-240s of a Polymarket 15m "Up or Down" crypto candle, buy the side that has ALREADY won —
// but only when BOTH independent gates say the re-cross probability is <= 0.3%:
//   GATE 1 (ATR/vol):  z = |ln(spot/strike)| / (realizedVol_1s * sqrt(remainingSec)) >= 2.97
//                      (one-sided P <= 0.15%, Brownian terminal approx) from the trailing 300s of
//                      Chainlink RTDS 1s returns — the SAME feed Polymarket resolves on.
//   GATE 2 (RECORD):   the empirical hold-rate table (z-bucket x elapsed-bucket, exported from the
//                      FULL 90d Binance 1s record by cosmos-new/tools/copytrade/_cert_export.mjs
//                      into ./qtable-data/cert15.json) must show >= 99.7% held with cell n >= 300.
//
// Backtest (tools/copytrade/_cert_backtest.mjs, OOS 30d, 15m): ETH 0/1866 fails, SOL 0.14%,
// ALL 0.24%; BTC 0.55% FAILS the bar — EXCLUDED (every failure clustered at entry gaps < 11bps).
// Hardening vs that envelope: p 99.5%->99.7%, z 2.5758->2.97, entry gap >= 15bps (above the <11bps
// failure cluster), plus the hairline guard: skip |gap| < 20bps when < 60s remain (Chainlink-vs-
// Binance resolution tie risk — the ~1% feed-mismatch rate lives exactly there).
//
// Execution: FAK BUY, limit 97c (fills at the ask; ask must sit in 90..97c — an ask BELOW 90c on a
// "certainty" means the book disagrees, walk away). One trade per candle per bot. HOLD TO
// REDEMPTION — no sell path (bot.mjs exits skip source "cert15"; resolution pays 100c automatically).
// Sizing: the account's dashboard % (sizeForSignal, source "cert15"), floored at $1.
//
// Spawned by maybeStartEngines() (bot.mjs) when CERT15_ENABLED=1 locally OR the server setting
// cert15=true (fleet flag CERT15_FLEET, default ON). state.cert15 === false is the live kill switch.
// DRY: CERT15_DRY=1 logs would-be fills, places nothing.
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { log, warn } from "./log.mjs";

// node:20-slim has NO global WebSocket — fall back to the `ws` package (see qtable2.mjs).
const WSImpl = globalThis.WebSocket ?? (await import("ws")).WebSocket;
const WS_OPTS = globalThis.WebSocket ? undefined : { headers: { Origin: "https://polymarket.com" } };

const N = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };
const DRY = process.env.CERT15_DRY === "1";
const STAKE = N("CERT15_STAKE_USD", 0);            // fixed $/trade override; 0 = dashboard % sizing
const TICK_MS = N("CERT15_TICK_MS", 250);
const MAX_OPEN = N("CERT15_MAX_OPEN", 6);          // candles resolve in <=4 min; 2 coins ≈ 2 concurrent

// ---- HARDENED GATES (each env-overridable; defaults per owner spec 2026-07-15) ----
const MIN_P = N("CERT15_MIN_P", 0.997);            // gate 2: table hold-rate floor
const MIN_Z = N("CERT15_MIN_Z", 2.97);             // gate 1: vol z floor (one-sided P <= 0.15%)
const MIN_CELL_N = N("CERT15_MIN_CELL_N", 300);    // gate 2: cell population floor
const MIN_GAP_BPS = N("CERT15_MIN_GAP_BPS", 15);   // |ln(spot/strike)| floor — every backtest failure was < 11bps
const MIN_REMAIN_S = N("CERT15_MIN_REMAIN_S", 45); // too late = can't verify the fill beats a repricing
const MAX_REMAIN_S = N("CERT15_MAX_REMAIN_S", 240);// late-window only: the certainty regime the record covers
const MAX_CENTS = N("CERT15_MAX_CENTS", 97);       // FAK limit AND max ask (integer cap under the 97.9c backtest ask)
const MIN_CENTS = N("CERT15_MIN_CENTS", 90);       // ask floor: a "certainty" offered under 90c = the book knows something
const HAIR_GAP_BPS = N("CERT15_HAIRLINE_GAP_BPS", 20);   // Chainlink-vs-Binance tie guard:
const HAIR_REMAIN_S = N("CERT15_HAIRLINE_REMAIN_S", 60); //   skip |gap| < 20bps when < 60s remain
const VOL_WIN_S = N("CERT15_VOL_WIN_S", 300);      // trailing realized-vol window (backtest volWin)
const MIN_COVERAGE = N("CERT15_MIN_COVERAGE", 0.6);// backtest minReal: sparse feed -> vol (and z) unreliable
const STALE_MS = N("CERT15_MAX_SPOT_AGE_MS", 3000);// tighter than qtable2's 8s: hairline timing, 97c risk
const REF_TRUST_MS = N("CERT15_REF_TRUST_MS", 15000); // late-first-tick strike distrust (see qtable2)

const FRAME_MS = 900_000; // 15m candles ONLY
const WS_SYM = { "btc/usd": "BTCUSDT", "eth/usd": "ETHUSDT", "sol/usd": "SOLUSDT" };
const SYM_WS = Object.fromEntries(Object.entries(WS_SYM).map(([k, v]) => [v, k]));
const API_SYM = { BTCUSDT: "BTC", ETHUSDT: "ETH", SOLUSDT: "SOL" };

// ---- gate-2 record table (exported from the FULL 90d record; ETH+SOL pooled, like the backtest) ----
const TDIR = new URL("./qtable-data/", import.meta.url);
let TABLE = null;
try { TABLE = JSON.parse(readFileSync(new URL("cert15.json", TDIR), "utf8")); }
catch { /* handled in startCert15 — engine refuses to run without its record */ }
const NE = TABLE?.meta?.ne ?? 6;
function zIdx(z) {
  const E = TABLE.meta.zEdges;
  if (z < E[0]) return -1;
  for (let i = E.length - 1; i >= 0; i--) if (z >= E[i]) return i;
  return -1;
}
function eIdx(f) {
  const E = TABLE.meta.eEdges;
  let i = -1;
  for (let k = 0; k < E.length; k++) if (f >= E[k]) i = k;
  return i;
}

// A coin the engine may trade must be IN the exported record: the pooled table is ETH+SOL — feeding
// BTC through it would gate BTC on someone else's record (and BTC failed the backtest anyway).
// Adding BTC later = re-export with BTC + a validated min-gap filter, not an env flip alone.
const WANT = (process.env.CERT15_COINS || "ETHUSDT,SOLUSDT").split(",").map((s) => s.trim()).filter(Boolean);
const COINS = WANT.filter((c) => {
  if (!SYM_WS[c]) { warn(`cert15: unknown coin ${c} — skipping`); return false; }
  if (TABLE && !TABLE.meta.coins.includes(c)) { warn(`cert15: ${c} is NOT in the exported record (${TABLE.meta.coins.join(",")}) — refusing to trade it; re-export first`); return false; }
  return true;
});

// Durable per-trade ledger on the persistent volume (survives restarts).
const DATA_DIR = (process.env.COSMOS_DATA_DIR || ".").replace(/\/$/, "");
const LEDGER = `${DATA_DIR}/cert15-trades.ndjson`;
function appendLedger(rec) { try { appendFileSync(LEDGER, JSON.stringify(rec) + "\n"); } catch (e) { warn("cert15 ledger:", e?.message); } }

// HOURLY TRADE CAP (owner 2026-07-19, the 10-track rollout: cert15 runs on EVERY track, so every
// user carries it — capped at 4 trades per rolling 60min). Fill timestamps persist to the volume
// (like the builder-rotation counter) so a restart cannot reset the window and double the budget.
// Only REAL entries consume a slot (fills, and DRY would-buys so a dry run shows the cap working);
// failed FAKs do not — a retry is the same trade, not a new one.
const MAX_PER_HOUR = N("CERT15_MAX_PER_HOUR", 4);
const HOURLY_FILE = `${DATA_DIR}/cert15-hourly.json`;
let hourly = [];
try { hourly = (JSON.parse(readFileSync(HOURLY_FILE, "utf8")).ts || []).filter((t) => Number.isFinite(t) && t > Date.now() - 3600e3); } catch { /* fresh */ }
function hourlyCapped() {
  const cut = Date.now() - 3600e3;
  while (hourly.length && hourly[0] < cut) hourly.shift();
  return hourly.length >= MAX_PER_HOUR;
}
function hourlyMark() {
  hourly.push(Date.now());
  try { writeFileSync(HOURLY_FILE, JSON.stringify({ ts: hourly })); } catch (e) { warn("cert15 hourly:", e?.message); }
}

// ---- Chainlink RTDS: reference buffer + live spot (the feed Polymarket resolves on) ----
const hist = {}; // sym -> [{t,v}] last ~35min (covers strike ref + the 300s vol window at any elapsed)
const spot = {}; // sym -> latest value
// Trust a buffered tick as the window-open strike ONLY if it landed near the boundary (a dormant
// event feed wakes AFTER a move — late ref = wrong strike = fake gap; see qtable2's audit).
const refFor = (sym, windowStartMs) => {
  const h = hist[sym]; if (!h || !h.length || h[0].t > windowStartMs) return null;
  for (let i = 0; i < h.length; i++) if (h[i].t >= windowStartMs) return h[i].t - windowStartMs <= REF_TRUST_MS ? h[i].v : null;
  return null;
};
function connectChainlink() {
  let ws, stopped = false;
  const go = () => {
    try { ws = new WSImpl("wss://ws-live-data.polymarket.com", WS_OPTS); } catch { return setTimeout(go, 1500); }
    ws.onopen = () => { ws.send(JSON.stringify({ action: "subscribe", subscriptions:
      COINS.map((c) => ({ topic: "crypto_prices_chainlink", type: "*", filters: JSON.stringify({ symbol: SYM_WS[c] }) })),
    })); log(`cert15 chainlink: connected (${COINS.map((c) => SYM_WS[c]).join(", ")})`); };
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
  return {
    stop: () => { stopped = true; try { ws?.close(); } catch { /* */ } },
    // RTDS subscriptions can HALF-DIE (socket open, one coin's stream gone) — kick() forces a clean
    // reconnect+resubscribe; the watchdog below calls it (same failure qtable2 hit 2026-07-14).
    kick: () => { try { ws?.close(); } catch { /* */ } },
  };
}

// GATE 1 vol: trailing per-1s realized vol from the RTDS buffer, built EXACTLY like the backtest's
// 1s series — a forward-filled 1s close grid, population variance of the 1-unit log returns, and a
// minimum real-tick coverage (MIN_COVERAGE = the backtest's minReal): sparse ticks forward-fill into
// zero returns, which DEFLATES vol and INFLATES z — fake certainty. Not enough real data = no signal.
function volFor(sym, nowMs) {
  const h = hist[sym]; if (!h?.length) return null;
  const endSec = Math.floor(nowMs / 1000);
  const startSec = endSec - VOL_WIN_S;
  const grid = new Float64Array(VOL_WIN_S + 1).fill(NaN);
  const real = new Uint8Array(VOL_WIN_S + 1);
  let base = NaN; // last tick BEFORE the grid: the fill basis for leading gaps
  for (const x of h) {
    const s = Math.floor(x.t / 1000) - startSec;
    if (s < 0) { base = x.v; continue; }
    if (s > VOL_WIN_S) break;
    grid[s] = x.v; real[s] = 1; // ticks are time-sorted: the last tick in each second wins (its close)
  }
  let covered = 0;
  for (let i = 0; i <= VOL_WIN_S; i++) if (real[i]) covered++;
  if (covered / (VOL_WIN_S + 1) < MIN_COVERAGE) return null;
  let lastv = base, prev = NaN, n = 0, s1 = 0, s2 = 0;
  for (let i = 0; i <= VOL_WIN_S; i++) {
    if (!Number.isNaN(grid[i])) lastv = grid[i];
    if (i > 0 && Number.isFinite(lastv) && Number.isFinite(prev) && prev > 0) {
      const r = Math.log(lastv / prev); s1 += r; s2 += r * r; n++;
    }
    prev = lastv;
  }
  if (n < VOL_WIN_S * MIN_COVERAGE) return null;
  const mean = s1 / n;
  let v = s2 / n - mean * mean; if (v < 0) v = 0;
  const sig = Math.sqrt(v);
  return sig > 0 ? sig : null; // dead tape: zero vol is "no info", not certainty (backtest rule)
}

const j = async (u, ms = 4000) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; } };
const parseArr = (s) => { try { return JSON.parse(String(s ?? "[]")); } catch { return []; } };

// 15-minute up-or-down families ONLY (slugs verified live in qtable2, 2026-07-13). A slug that stops
// existing just returns nothing from gamma; a coin outside COINS is filtered out.
const SERIES = [
  { sym: "BTCUSDT", slug: "btc-up-or-down-15m" },
  { sym: "ETHUSDT", slug: "eth-up-or-down-15m" },
  { sym: "ETHUSDT", slug: "ethereum-up-or-down-15m" },
  { sym: "SOLUSDT", slug: "sol-up-or-down-15m" },
].filter((s) => COINS.includes(s.sym));

// best ASK (what a marketable BUY actually pays), with a two-sided-book spread sanity guard
async function bestAsk(tokenId) {
  const d = await j(`https://clob.polymarket.com/book?token_id=${tokenId}`, 3000);
  const asks = d?.asks || [], bids = d?.bids || [];
  let ba = null, bb = null;
  for (const a of asks) { const p = Number(a?.price); const sz = Number(a?.size); if (p > 0 && sz > 0 && (ba == null || p < ba)) ba = p; }
  for (const b of bids) { const p = Number(b?.price); const sz = Number(b?.size); if (p > 0 && sz > 0 && (bb == null || p > bb)) bb = p; }
  if (ba == null || bb == null) return null; // one-sided book -> not tradable
  if (ba - bb > 0.10) return null;           // spread too wide -> skip
  return ba;
}

export function startCert15(deps) {
  const { pm, cosmos, store, placeWithRetry, sharesFor, sizeForSignal, state } = deps;
  if (!TABLE?.pooled?.n?.length) { warn("cert15: no record table (src/qtable-data/cert15.json missing/empty) — engine NOT started; run cosmos-new/tools/copytrade/_cert_export.mjs"); return () => {}; }
  if (!COINS.length) { warn("cert15: no tradable coins after filtering — engine NOT started"); return () => {}; }
  const markets = new Map();  // cid -> descriptor
  const apiRef = {};          // cid -> backfilled window-open strike
  const done = new Set();     // cid -> already ordered / permanently skipped (one trade per candle)
  const fails = new Map();    // cid -> failed order attempts
  const stats = { signals: 0, orders: 0, fills: 0, capSkips: 0 };
  let alive = true, lastCapLog = 0;

  async function discover() {
    const now = Date.now();
    for (const s of SERIES) {
      const evs = await j(`https://gamma-api.polymarket.com/events?series_slug=${s.slug}&closed=false&limit=8&order=endDate&ascending=true&end_date_min=${new Date(now).toISOString()}`);
      if (!Array.isArray(evs)) continue;
      for (const e of evs) for (const m of (e.markets ?? [])) {
        const cid = String(m.conditionId ?? ""); if (!cid) continue;
        const endMs = Date.parse(m.endDate ?? e.endDate ?? ""); if (!Number.isFinite(endMs) || endMs <= now) continue;
        if (endMs - now > 2 * FRAME_MS) continue;
        const toks = parseArr(m.clobTokenIds), outs = parseArr(m.outcomes);
        const ai = outs.findIndex((o) => /^up$/i.test(o)), bi = outs.findIndex((o) => /^down$/i.test(o));
        if (ai < 0 || bi < 0 || !toks[ai] || !toks[bi]) continue;
        if (!markets.has(cid)) markets.set(cid, { cid, sym: s.sym, endMs, windowStartMs: endMs - FRAME_MS, question: String(m.question ?? ""), tokenUp: String(toks[ai]), tokenDn: String(toks[bi]), outUp: String(outs[ai]), outDn: String(outs[bi]) });
      }
    }
    for (const [cid, m] of markets) if (m.endMs <= now - 30_000) markets.delete(cid);
  }

  // backfill the window-open strike for candles whose boundary tick we missed (Polymarket price-history)
  async function backfillRefs() {
    const now = Date.now();
    for (const m of markets.values()) {
      if (apiRef[m.cid] != null || refFor(m.sym, m.windowStartMs) != null) continue;
      const rem = m.endMs - now; if (rem <= 0 || rem > FRAME_MS) continue;
      if ((FRAME_MS - rem) / 1000 <= 130) continue; // price-history needs the window to have aged a bit
      const startISO = new Date(m.windowStartMs).toISOString(), endISO = new Date(m.windowStartMs + FRAME_MS).toISOString();
      const arr = await j(`https://polymarket.com/api/crypto/price-history?symbol=${API_SYM[m.sym]}&variant=fifteenminute&eventStartTime=${encodeURIComponent(startISO)}&endDate=${encodeURIComponent(endISO)}`);
      const v = Array.isArray(arr) && arr[0] ? Number(arr[0].value) : NaN;
      if (Number.isFinite(v) && v > 0) apiRef[m.cid] = v;
    }
  }
  const strikeFor = (m) => refFor(m.sym, m.windowStartMs) ?? apiRef[m.cid] ?? null;

  async function tick() {
    if (state.cert15 === false) return;                      // server kill switch -> stop trading
    if (state.cash == null || state.sizing == null) return;  // no cycle data yet (first 30s after boot)
    const now = Date.now();
    const positions = store.load();
    // openC counts only LIVE cert15 positions (dust-aware, like qtable2's MAX_OPEN fix): a resolved
    // loser's shares linger in the wallet until reconcile's 30-min dust-guard clears them.
    let openC = 0;
    for (const p of Object.values(positions)) {
      if (p.source !== "cert15") continue;
      const endMs = p.end_ms ? Number(p.end_ms)
        : p.end_date && p.end_date !== "none" ? Date.parse(p.end_date)
        : p.opened_at ? Date.parse(p.opened_at) + 20 * 60_000
        : now;
      if (Number.isFinite(endMs) && endMs >= now - 15 * 60_000) openC++;
    }

    for (const m of [...markets.values()]) {
      const remaining = m.endMs - now;
      if (remaining <= 0) { markets.delete(m.cid); continue; }
      if (done.has(m.cid)) continue;
      if (positions[m.cid]) { done.add(m.cid); markets.delete(m.cid); continue; }
      const remS = remaining / 1000;
      if (remS > MAX_REMAIN_S) continue;                     // not late enough yet — keep watching
      if (remS < MIN_REMAIN_S) { done.add(m.cid); continue; }// too late — this candle is over for us
      if (openC >= MAX_OPEN) return;

      // ---- signal inputs (all verified-fresh or NO TRADE) ----
      const strike = strikeFor(m); if (strike == null) continue;
      const S = spot[m.sym]; if (!S) continue;
      const h = hist[m.sym]; const spotAge = h?.length ? now - h[h.length - 1].t : Infinity;
      if (spotAge > STALE_MS) continue;                      // stale Chainlink spot -> gap meaningless
      const g = Math.log(S / strike);
      const gapBps = Math.abs(g) * 1e4;
      if (gapBps < MIN_GAP_BPS) continue;                    // every backtest failure lived under 11bps
      if (gapBps < HAIR_GAP_BPS && remS < HAIR_REMAIN_S) continue; // Chainlink-vs-Binance tie hairline

      // ---- GATE 1: vol z ----
      const sig = volFor(m.sym, now);
      if (sig == null) continue;                             // sparse/dead feed -> no certainty claims
      const z = Math.abs(g) / (sig * Math.sqrt(remS));
      if (z < MIN_Z) continue;

      // ---- GATE 2: the empirical record ----
      const elapsedFrac = 1 - remaining / FRAME_MS;
      const zi = zIdx(z), ei = eIdx(elapsedFrac);
      if (zi < 0 || ei < 0) continue;
      const k = zi * NE + ei;
      const cellN = Number(TABLE.pooled.n[k]) || 0;
      if (cellN < MIN_CELL_N) continue;                      // not enough record -> no trade
      const p2 = TABLE.pooled.h[k] / cellN;
      if (p2 < MIN_P) continue;

      // ---- HOURLY CAP (owner 2026-07-19): max 4 entries per rolling hour, persisted ----
      // Skip WITHOUT done-ing the candle: a slot can free up while this window is still open.
      if (hourlyCapped()) {
        stats.capSkips++;
        if (Date.now() - lastCapLog > 60_000) { lastCapLog = Date.now(); log(`cert15: hourly cap ${hourly.length}/${MAX_PER_HOUR} — signal skipped (${m.question.slice(0, 40)})`); }
        continue;
      }

      // ---- execution: buy the side that already won, at the ask, capped at 97c ----
      const up = S > strike;
      const pick = up ? { side: "Up", token: m.tokenUp, outcome: m.outUp } : { side: "Down", token: m.tokenDn, outcome: m.outDn };
      const tBook = Date.now();
      const ask = await bestAsk(pick.token);
      if (ask == null) continue;
      const askC = Math.round(ask * 100);
      if (askC > MAX_CENTS) continue;                        // priced past our cap — resolution is 100c but so is the risk
      if (askC < MIN_CENTS) continue;                        // a "certainty" under 90c: the book disagrees — walk away
      stats.signals++;
      const bookMs = Date.now() - tBook;

      // sizing: fixed $ if CERT15_STAKE_USD>0, else the account's dashboard % (source "cert15"), min $1
      const sizeUsd = STAKE > 0 ? STAKE : Math.max(1, sizeForSignal(state.sizing, { source: "cert15", outcome: pick.outcome }, state.portfolio, state.deployed));
      const priceCents = MAX_CENTS;                          // FAK limit: crosses any ask <= 97c, fills AT the ask
      const shares = Math.max(Math.ceil(100 / priceCents), sharesFor(sizeUsd, priceCents));
      const orderUsd = (shares * priceCents) / 100;          // worst-case (fills at ask <= limit)
      const tag = `${pick.side} 15m ${m.sym} ask ${askC}c z=${z.toFixed(2)} gap=${gapBps.toFixed(1)}bps p2=${(p2 * 100).toFixed(2)}%(n=${cellN}) rem=${remS.toFixed(0)}s`;
      if (orderUsd > state.cash) { done.add(m.cid); continue; } // no room; re-armed on next discover
      if (DRY) { hourlyMark(); log(`cert15 DRY would BUY ${tag} · hourly ${hourly.length}/${MAX_PER_HOUR} · spotAge=${spotAge}ms book=${bookMs}ms · ${m.question.slice(0, 40)}`); done.add(m.cid); continue; }

      done.add(m.cid); // ONE trade per candle per bot
      const t0 = Date.now();
      const r = await placeWithRetry(pm, { tokenId: pick.token, side: "BUY", sizeShares: shares, priceCents, orderType: "FAK" }, 2, 80);
      const orderMs = Date.now() - t0, totalMs = bookMs + orderMs;
      stats.orders++;
      const rec = { ts: new Date().toISOString(), cid: m.cid, q: m.question, sym: m.sym, side: pick.side, outcome: pick.outcome, ask_cents: askC, limit_cents: priceCents, z: Number(z.toFixed(3)), gap_bps: Number(gapBps.toFixed(2)), sig_1s: Number(sig.toExponential(4)), p2: Number(p2.toFixed(5)), cell_n: cellN, remain_s: Number(remS.toFixed(1)), elapsed_pct: Number((elapsedFrac * 100).toFixed(1)), size_usd: Number(orderUsd.toFixed(2)), shares, token_id: pick.token, end_ms: m.endMs, spot_age_ms: spotAge, book_ms: bookMs, order_ms: orderMs, total_ms: totalMs };
      if (!r.ok) {
        const f = (fails.get(m.cid) ?? 0) + 1; fails.set(m.cid, f);
        if (!(f >= 5 || (typeof r.status === "number" && r.status >= 400 && r.status < 500 && f >= 3))) done.delete(m.cid); // retry next tick
        else markets.delete(m.cid);
        appendLedger({ ...rec, ok: false, err: String(r.error ?? r.err ?? r.status ?? "").slice(0, 140) });
        log(`FAIL [cert15] ${tag} · order=${orderMs}ms · ${String(r.error ?? r.err ?? r.status ?? "").slice(0, 110)}`);
        continue;
      }
      stats.fills++;
      hourlyMark();                                          // a filled entry consumes an hourly slot
      try { await cosmos.meter({ ...r.meta, source: "cert15" }); } catch { /* best-effort */ }
      positions[m.cid] = {
        condition_id: m.cid, token_id: pick.token, outcome: pick.outcome, source: "cert15",
        entry_cents: askC, size_usd: orderUsd, size_shares: shares, entry_whales: [],
        market_question: m.question, opened_at: rec.ts,
        end_ms: m.endMs, end_date: new Date(m.endMs).toISOString(), // so reconcile's dust-guard can date it
      };
      store.save(positions);
      appendLedger({ ...rec, ok: true });
      state.cash -= orderUsd; state.deployed += orderUsd; openC++;
      markets.delete(m.cid);
      log(`BUY  [cert15] ${tag} · $${orderUsd.toFixed(2)} · spotAge=${spotAge}ms book=${bookMs}ms order=${orderMs}ms total=${totalMs}ms${totalMs > 1000 ? " ⚠SLOW" : ""} · ${m.question.slice(0, 40)} ✓ (hold to redemption)`);
    }
  }

  (async function run() {
    log(`cert15: engine ON · ${STAKE > 0 ? "$" + STAKE + "/trade" : "dashboard % sizing (min $1)"} · gates z>=${MIN_Z} AND record>=${(MIN_P * 100).toFixed(1)}%(n>=${MIN_CELL_N}) · gap>=${MIN_GAP_BPS}bps · window ${MIN_REMAIN_S}-${MAX_REMAIN_S}s left · ask ${MIN_CENTS}-${MAX_CENTS}c · ${COINS.map((c) => API_SYM[c]).join("+")} 15m only · max ${MAX_PER_HOUR}/h (rolling, persisted) · hold to redemption · tick ${TICK_MS}ms${DRY ? " · DRY RUN" : ""}`);
    const wsCtl = connectChainlink();
    await discover().catch(() => {});
    const di = setInterval(() => discover().catch(() => {}), 15_000);
    const bi = setInterval(() => backfillRefs().catch(() => {}), 4_000);
    // FEED WATCHDOG (same half-dead-subscription failure qtable2 hit): a coin that HAS ticked but has
    // been silent > WATCHDOG_MS on an open socket gets a forced reconnect, rate-limited.
    const WATCHDOG_MS = N("CERT15_FEED_WATCHDOG_MS", 300_000);
    let lastKick = 0;
    const si = setInterval(() => {
      const feeds = COINS.map((c) => {
        const h = hist[c]; const age = h?.length ? Date.now() - h[h.length - 1].t : Infinity;
        return `${API_SYM[c].toLowerCase()} ${age === Infinity ? "NO FEED ⚠" : (age / 1000).toFixed(1) + "s"}`;
      }).join(" · ");
      log(`cert15 … tracking ${markets.size} · ${feeds} · signals ${stats.signals} · orders ${stats.orders} · fills ${stats.fills} · hourly ${hourly.filter((t) => t > Date.now() - 3600e3).length}/${MAX_PER_HOUR}${stats.capSkips ? ` (cap-skipped ${stats.capSkips})` : ""}`);
      const staleCoin = COINS.find((c) => { const h = hist[c]; return h?.length && Date.now() - h[h.length - 1].t > WATCHDOG_MS; });
      if (staleCoin && Date.now() - lastKick > WATCHDOG_MS) {
        lastKick = Date.now();
        warn(`cert15 watchdog: ${API_SYM[staleCoin]} silent ${Math.round((Date.now() - hist[staleCoin][hist[staleCoin].length - 1].t) / 1000)}s on an open socket — forcing reconnect`);
        wsCtl.kick();
      }
    }, 30_000);
    while (alive) {
      const t0 = Date.now();
      try { await tick(); } catch (e) { warn("cert15:", e?.message); }
      await new Promise((res) => setTimeout(res, Math.max(120, TICK_MS - (Date.now() - t0))));
    }
    clearInterval(di); clearInterval(bi); clearInterval(si); wsCtl.stop();
  })();
  return () => { alive = false; };
}
