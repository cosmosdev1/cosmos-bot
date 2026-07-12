#!/usr/bin/env node
// Cosmos API trading bot — main loop. Reads your filtered feed from Cosmos, sizes positions,
// signs orders locally, places them through the metering relay (marketable Fill-And-Kill), and
// runs the exit logic (Cosmos AI / fixed / percent). State is RECONCILED against your real
// Polymarket holdings each cycle, so positions.json never drifts from reality.
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { makeCosmos } from "./cosmos.mjs";
import { makePolymarket } from "./polymarket.mjs";
import * as store from "./store.mjs";
import { log, warn, err } from "./log.mjs";
import { startQTable } from "./qtable.mjs";

// Config comes from config.json (local install via `npm run setup`) OR env vars (cloud/24-7
// deploy — Render/Railway/Docker, where there's no interactive terminal). Env vars win so a
// hosted box boots headlessly; the private key is whatever the host stores (never sent to Cosmos).
function loadConfig() {
  const f = existsSync("./config.json") ? JSON.parse(readFileSync("./config.json", "utf8")) : {};
  const e = process.env;
  return {
    cosmosApi: (e.COSMOS_API || f.cosmosApi || "https://try-cosmos.com").replace(/\/$/, ""),
    cosmosToken: e.COSMOS_TOKEN || f.cosmosToken,
    polymarket: {
      privateKey: e.POLYMARKET_PRIVATE_KEY || f.polymarket?.privateKey,
      funderAddress: e.POLYMARKET_FUNDER || f.polymarket?.funderAddress || "",
    },
    pollSeconds: Number(e.POLL_SECONDS) || f.pollSeconds || 30,
    maxConcurrent: Number(e.MAX_CONCURRENT) || f.maxConcurrent || 30, // hold up to 30 so the bot keeps buying new signals instead of stalling at 10 (env MAX_CONCURRENT to raise)
    applyToManualTrades: f.applyToManualTrades ?? e.APPLY_TO_MANUAL === "1",
    buyBacklogOnStart: f.buyBacklogOnStart === true || e.COSMOS_BUY_BACKLOG === "1",
  };
}
const config = loadConfig();
if (!config.cosmosToken || !config.polymarket.privateKey) {
  console.error("Missing config. Either run `npm run setup` (local) or set the env vars COSMOS_TOKEN + POLYMARKET_PRIVATE_KEY (+ POLYMARKET_FUNDER) for a 24/7 host.");
  process.exit(1);
}
// One-time switch: evaluate + buy the markets ALREADY in the feed on this start
// (instead of only newly-added ones). Set COSMOS_BUY_BACKLOG=1 or config.buyBacklogOnStart.
const BUY_BACKLOG = config.buyBacklogOnStart === true || process.env.COSMOS_BUY_BACKLOG === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sharesFor = (usd, cents) => Math.floor((usd * 100) / Math.max(1, cents));
// Live cycle state shared with the qtable fast loop (updated every 30s cycle; the 5s loop reads it).
const qtState = { cash: null, portfolio: 0, deployed: 0, sizing: null };

// Hard floor per trade: Polymarket's ~$1 minimum order. Any computed size below this is bumped up
// to $1 (e.g. 3% of a $10 balance = $0.30 still trades at $1), as long as there's room.
const MIN_TRADE_USD = 2;

// Cosmos-RUN engine sources (server-curated, time-sensitive strategy entries - quant strikes,
// weather ladders, in-play sports). These are never "stale backlog": their caps and expiries
// self-limit, and the server retires a signal the moment its edge is gone. They are therefore
// exempt from the first-run baseline and from the permanent burn rules below.
const ENGINE_SOURCES = new Set((process.env.COSMOS_ENGINE_SOURCES || "quant,weather,sports,top5").split(",").map((s) => s.trim()).filter(Boolean));
// top5 added 2026-07-09: it IS a server-curated engine (orca-gated, server retires stale/misaligned
// signals), but as a "raw" source every self-update restart baselined its live book away (the
// July-6 "never buys engines" bug again), over-cap burned permanently, and one FAK 4xx on a thin
// book (obscure soccer/esports) burned the signal for good.
// A real-but-thin engine market can FAK-kill with a 4xx a few times before filling; give it a
// bounded number of attempts (across cycles) before burning it. Non-engine sources burn on first 4xx.
const ENTRY_4XX_LIMIT = Number(process.env.ENTRY_4XX_LIMIT) || 3;
const entryFails = new Map(); // condition_id -> 4xx count (in-memory; a restart re-arms, caps/expiry bound the risk)

// Retry a marketable FAK order on a transient kill. A Fill-And-Kill that finds no liquidity is
// REJECTED (ok:false) with nothing filled - and the book usually refreshes within a few hundred ms,
// so a single kill must never become a missed entry or a missed stop (mirrors the crypto_bot rule).
// We retry ONLY while ok:false (a complete kill, nothing filled), so a partial/full fill never
// re-fires and can't over-trade.
async function placeWithRetry(pm, args, attempts = 5, cooldownMs = 150) {
  let r;
  for (let i = 0; i < attempts; i++) {
    r = await pm.placeOrder(args);
    if (r.ok) return r;
    if (i < attempts - 1) await sleep(cooldownMs);
  }
  return r; // last failure
}

// Per-trade USD from the dashboard sizing config (synced from /api/v1/account each cycle).
//   pct -> % of portfolio · fixed -> $ · tiered -> % by the signal's tier.
// Percentages are taken off the whole PORTFOLIO (free cash + the cost basis of open positions), not
// just free cash, so position sizes stay stable as money gets deployed.
// Optional: scale by score, a $ cap per trade, and a total-exposure ceiling.
const DEFAULT_PCT = 5; // fallback per-trade size when no % is configured (product policy 2026-07)
// Weather YES (rule B) is the risky side (88.6% WR vs 100% for the NO certainties): size it smaller.
const WEATHER_YES_FRACTION = Number(process.env.WEATHER_YES_FRACTION) || 0.75;

function sizeForSignal(z, s, portfolio, deployed) {
  // Size off an explicit account-size override when the user set one, else the TRUE portfolio VALUE
  // passed in (Polymarket's authoritative total = cash + open positions). The override makes
  // "3% of $200 = $6" hold no matter what the live reads do.
  const basis = Number(z.accountSizeUsd) > 0 ? Number(z.accountSizeUsd) : portfolio;
  let usd;
  if (z.mode === "fixed") {
    usd = Number(z.fixedUsd) || 0;
  } else {
    // FLAT percentage of the WHOLE portfolio: the SAME size for every trade, independent of the
    // signal's tier or score (product policy 2026-07 - NO conviction scaling, NO per-signal-tier
    // variance). The percentage is the platinum/gold value the user set (tiered mode) or their
    // single pct (pct mode); fall back to DEFAULT_PCT (5%) if none set. `||` (not `??`) so a
    // 0/undefined value falls through - NEVER resolve to 0% (the $1 floor would emit a dust order).
    const tp = z.tierPct || {};
    const pct = z.mode === "tiered"
      ? (Number(tp.platinum) || Number(tp.gold) || Number(z.pct) || DEFAULT_PCT)
      : (Number(z.pct) || Number(tp.platinum) || Number(tp.gold) || DEFAULT_PCT);
    usd = (basis * pct) / 100;
  }
  // Weather YES (rule B) trades ride at 3/4 of the normal budget - smaller stake on the side that
  // can actually lose (the NO certainties keep full size). Applies to both pct and fixed modes.
  if (s && s.source === "weather" && /^yes$/i.test(String(s.outcome || ""))) usd *= WEATHER_YES_FRACTION;
  if (z.maxPerTradeUsd) usd = Math.min(usd, Number(z.maxPerTradeUsd));
  if (z.maxExposurePct) usd = Math.min(usd, Math.max(0, (basis * Number(z.maxExposurePct)) / 100 - deployed));
  return usd;
}

// Human-readable active size, logged each cycle so you can SEE in the Render logs that a dashboard
// save reached THIS token (the bot re-reads /api/v1/account every cycle, no caching).
function sizeLabel(z) {
  if (!z || !z.mode) return "size: default";
  const basis = Number(z.accountSizeUsd) > 0 ? ` of $${Number(z.accountSizeUsd)} (set)` : " of portfolio";
  if (z.mode === "fixed") return `size: $${Number(z.fixedUsd) || 0}/trade`;
  const tp = z.tierPct || {};
  const pct = z.mode === "tiered"
    ? (Number(tp.platinum) || Number(tp.gold) || Number(z.pct) || DEFAULT_PCT)
    : (Number(z.pct) || Number(tp.platinum) || Number(tp.gold) || DEFAULT_PCT);
  return `size: ${pct}% flat${basis}`;
}

// ---- HORIZON STOP: liquidate dead-money positions so capital stays liquid. ----
// Fleet audit (2026-07-05): ~50% of deployed capital sat in positions resolving 30-930 days out,
// most slightly under water - earning nothing. Three rules (each env-tunable, HORIZON_STOP=0
// disables all). Applies ONLY to bot-opened positions, never the user's own manual holdings.
//   A. NO on a deadline market ("will X happen by <date>?") pays only AT the deadline - no early
//      resolution exists. Locked > HORIZON_NO_DAYS (14) -> sell.
//   B. Fixed scheduled events (FDV-after-launch, Fed meetings, Nobel, next-PM, season markets)
//      can't resolve early on EITHER side. Locked > HORIZON_SCHEDULED_DAYS (30) -> sell.
//   C. Anything > HORIZON_FAR_DAYS (90) out that is NOT currently winning (cur <= entry + 2c) ->
//      sell; a far YES that's actually moving up keeps its event-option value and is held.
const HZ = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const isDeadlineQ = (q) => {
  const s = String(q || "").toLowerCase();
  if (/(remain|stay|through|survive|maintain)/.test(s)) return false; // persistence phrasing flips the sides
  return /\b(by|before|until)\b.{0,40}(20\d\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\bin (20\d\d|q[1-4])\b/.test(s);
};
const isScheduledQ = (q) =>
  /(fdv above|one day after launch|nobel|next prime minister|fed (decision|meeting)|after the .{0,20}meeting|20\d\d-\d\d season|rate (cut|hike)s? .{0,20}in 20\d\d|week of)/i.test(String(q || ""));
function horizonVerdict(pos, curCents) {
  if (process.env.HORIZON_STOP === "0") return null;
  if (!pos.end_date || pos.end_date === "none") return null;
  const days = (new Date(pos.end_date).getTime() - Date.now()) / 86400000;
  if (!Number.isFinite(days)) return null;
  const q = pos.market_question;
  if (String(pos.outcome).trim().toLowerCase() === "no" && isDeadlineQ(q) && days > HZ("HORIZON_NO_DAYS", 14))
    return `far NO pays only at the deadline (${Math.round(days)}d away) - freeing the capital`;
  if (isScheduledQ(q) && days > HZ("HORIZON_SCHEDULED_DAYS", 30))
    return `scheduled event ${Math.round(days)}d away - nothing can resolve it sooner`;
  if (days > HZ("HORIZON_FAR_DAYS", 90) && (curCents == null || curCents <= (pos.entry_cents ?? 0) + 2))
    return `${Math.round(days)}d to resolution and not winning - dead money`;
  return null;
}

// Log a skipped-entry reason ONCE per market per reason (these checks re-run every cycle while
// the signal waits un-burned; without the dedupe they'd flood the log every 30s).
const skipLogged = new Set();
function logSkipOnce(cid, kind, msg) {
  const k = cid + "|" + kind;
  if (skipLogged.has(k)) return;
  skipLogged.add(k);
  log(msg);
}

// Fill-time crypto spot for the quant sanity check (Binance 5m close, ~20s cache so a burst of quant
// signals in one cycle shares one fetch). Closes the cron-interval staleness race: a signal emitted
// when spot was below the strike must NOT fill after spot crossed above (that bought NO at a loss).
const _spotCache = new Map();
async function freshSpot(pair) {
  const c = _spotCache.get(pair);
  if (c && Date.now() - c.at < 20_000) return c.S;
  try {
    const r = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=5m&limit=1`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const k = await r.json();
    const S = Array.isArray(k) && k[0] ? Number(k[0][4]) : null;
    if (S) _spotCache.set(pair, { S, at: Date.now() });
    return S;
  } catch { return null; }
}
// Quant "above $K" ladder signals only: verify FRESH spot is still on the thesis side of the strike.
// NO thesis = finish BELOW K (need spot < K-buf); YES = above (need spot > K+buf). Returns true
// (allow) when it can't tell (non-crypto, unparseable, or spot unavailable) so other guards govern.
async function quantSpotOk(s) {
  const q = String(s.market_question || "");
  if (!/\babove\b/i.test(q)) return true; // touch/hit markets use different (already-hit) logic
  const pair = /bitcoin|\bbtc\b/i.test(q) ? "BTCUSDT" : /ethereum|\beth\b/i.test(q) ? "ETHUSDT" : null;
  if (!pair) return true;
  const mk = q.match(/above\s+\$?([\d,]+(?:\.\d+)?)/i);
  if (!mk) return true;
  const K = Number(mk[1].replace(/,/g, ""));
  if (!Number.isFinite(K) || K <= 0) return true;
  const S = await freshSpot(pair);
  if (!S) return true;
  const buf = K * (Number(process.env.QUANT_SPOT_BUFFER_BPS || 10) / 10000); // default 0.10% flip-zone buffer
  return /^no$/i.test(String(s.outcome)) ? S <= K - buf : S >= K + buf;
}

const BUY_BUFFER = 3; //  marketable buy: bid a few cents above mid (capped at max_entry)
const SELL_BUFFER = 5; // marketable sell: offer a few cents below mid so stops actually fill

// Local TP and SL, evaluated INDEPENDENTLY (a manual SL must still work when TP is on "ai", and vice
// versa). Each returns a verdict or null.
function localTp(settings, entryCents, curCents) {
  if (!curCents) return null;
  const gainPct = ((curCents - entryCents) / entryCents) * 100;
  if (settings.tp_mode === "fixed" && settings.tp_value && curCents >= settings.tp_value) return { action: "TAKE_PROFIT", reason: `>= ${settings.tp_value}c` };
  if (settings.tp_mode === "percent" && settings.tp_value && gainPct >= settings.tp_value) return { action: "TAKE_PROFIT", reason: `+${gainPct.toFixed(0)}%` };
  return null;
}
function localSl(settings, entryCents, curCents) {
  if (!curCents) return null;
  const gainPct = ((curCents - entryCents) / entryCents) * 100;
  if (settings.sl_mode === "fixed" && settings.sl_value && curCents <= settings.sl_value) return { action: "STOP_LOSS", reason: `<= ${settings.sl_value}c` };
  if (settings.sl_mode === "percent" && settings.sl_value && gainPct <= -settings.sl_value) return { action: "STOP_LOSS", reason: `${gainPct.toFixed(0)}%` };
  return null;
}

// EDGE EXIT (the always-on fallback) - ONE function, evaluated FIRST for EVERY position type
// (regular, SPORTS, manual): sports previously bypassed these entirely (server strategy only), so
// a 98c sports winner or a 2c sports loser was never sold when the server said HOLD or errored.
// Zones per the admin spec: TAKE_PROFIT at >=97c, salvage STOP at <=3c - judged on BOTH the
// midpoint AND the best bid (the price a sell actually fills at), because at the edges a thin/wide
// book makes the two diverge (bid 97/ask 100 -> mid 98.5; bid 3/ask 15 -> mid 9). The bid is read
// whenever the mid is null or anywhere NEAR an edge (<=12c / >=90c) - the old <=8c gate let
// wide-book losers dodge the salvage read. Returns a verdict + the mid (so callers don't re-fetch),
// or verdict:null when no edge rule applies. Re-evaluated every cycle until reconcile confirms the
// holding is gone, so a killed FAK retries forever by construction.
async function edgeExit(pm, pos) {
  const cur = await pm.getPriceCents(pos.token_id);
  let bid = null;
  if (cur == null || cur >= 90 || cur <= 12) bid = await pm.getBestBidCents(pos.token_id).catch(() => null);
  // QUANT (crypto/stocks math engine) positions hold out for 99c - each extra cent on a
  // near-certain bet is real yield, and an unfilled 99c costs nothing (resolution pays 100).
  // Everything else locks from 97c. Env: QUANT_TP_CENTS.
  const tpC = pos.source === "quant" || pos.source === "qtable" ? HZ("QUANT_TP_CENTS", 99) : pos.source === "weather" ? HZ("WEATHER_TP_CENTS", 98) : 97;
  // A take-profit must actually PROFIT: the trigger is the mid, but the fill is the BID. A 97c-entry
  // whose mid hits 98 with a 95c bid used to "lock the win" at -2c (audited: repeated tiny losses).
  // Require the executable bid (or mid when no bid was read) to clear entry+1; otherwise hold -
  // near-certain positions resolve at 100c anyway, so an unfilled TP costs nothing.
  const minExec = (Number(pos.entry_cents) || 0) + 1; // executable price must clear entry
  const exec = bid ?? cur;
  if (cur != null && cur >= tpC && exec != null && exec >= minExec) return { cur, action: "TAKE_PROFIT", reason: `reached ${cur}c (exec ${exec}c) - locking the win` };
  if (bid != null && bid >= tpC && bid >= minExec) return { cur, action: "TAKE_PROFIT", reason: `best bid ${bid}c - locking the win` };
  if (cur != null && cur <= 3) return { cur, action: "STOP_LOSS", reason: `reached ${cur}c - salvaging before zero` };
  if (bid != null && bid <= 3 && (cur == null || cur <= 10)) return { cur, action: "STOP_LOSS", reason: `best bid ${bid}c - salvaging before zero` };
  if (cur == null && bid == null) return { cur, action: "HOLD", reason: "book gone - resolution pays out automatically" };
  return { cur, action: null };
}

// --- MODEL-BASED STOP for quant (crypto) positions. -------------------------------------------
// Re-price a HELD quant position with the SAME model that drove entry (server /api/v1/quant-exit ->
// fresh modelP) and SELL only if ALL of: the model win-prob for the held side is broken (< 0.30), the
// book still OVERPAYS vs the updated fair value (best bid >= round(modelP*100) + 8pp), and we're not in
// the unreliable near-expiry region (>= 15 min to expiry). All three thresholds are env-tunable and
// conservative. Defaults to SHADOW mode (log-only, NEVER sells) until a human sets QUANT_STOP_MODE=live.
const quantStopMode = () => (process.env.QUANT_STOP_MODE || "shadow").toLowerCase(); // "shadow" | "live" | "off"
const QSTOP_P = () => HZ("QUANT_STOP_P", 0.30);              // model win-prob below this = thesis broken
const QSTOP_EDGE_PP = () => HZ("QUANT_STOP_EDGE_PP", 8);     // book bid must overpay fair value by >= this (pp)
const QSTOP_MIN_TAU = () => HZ("QUANT_STOP_MIN_TAU_MIN", 15); // don't act inside this many minutes to expiry

// Pure, testable decision: given the fresh reprice (modelP, tauMin), the live best bid (cents) and the
// thresholds, does the model-stop FIRE? All three conditions must hold.
export function quantStopFires({ modelP, tauMin, bidCents }, { stopP, edgePp, minTau }) {
  if (!(tauMin >= minTau)) return false;          // near-expiry: modelP unreliable -> never act
  if (!(modelP < stopP)) return false;            // thesis still intact -> hold
  if (bidCents == null) return false;             // no readable bid -> can't confirm the book overpays
  return bidCents >= Math.round(modelP * 100) + edgePp; // book still overpays vs updated fair value
}

// Model-stop for ONE held quant position. Returns a STOP_LOSS verdict only in "live" mode when the rule
// fires (so the existing sell path executes); in "shadow" it logs the would-sell line and returns null
// (no sell); "off" is a no-op. Returns null for anything not a quant position or the server can't reprice.
export async function quantModelStop(cosmos, pm, pos) {
  const mode = quantStopMode();
  if (mode === "off") return null;
  if (pos.source !== "quant") return null;

  const r = await cosmos.quantExit(pos);
  if (!r?.ok) return null;

  const bidCents = await pm.getBestBidCents(pos.token_id).catch(() => null);
  const cfg = { stopP: QSTOP_P(), edgePp: QSTOP_EDGE_PP(), minTau: QSTOP_MIN_TAU() };
  if (!quantStopFires({ modelP: r.modelP, tauMin: r.tauMin, bidCents }, cfg)) return null;

  if (mode === "live") {
    return { action: "STOP_LOSS", reason: `model ${(r.modelP * 100) | 0}% < ${Math.round(cfg.stopP * 100)}, bid ${bidCents}c` };
  }
  // SHADOW (default): observe-only. Log a clear line and DO NOT sell.
  const mkt = (pos.market_question || pos.condition_id || "").slice(0, 48);
  const recover = ((Number(pos.size_shares) || 0) * bidCents) / 100;
  log(`[quant-stop SHADOW] would sell ${mkt} · modelP=${r.modelP.toFixed(2)} bid=${bidCents}c entry=${pos.entry_cents}c recover≈$${recover.toFixed(2)}`);
  return null;
}

// One BATCH advice call for a set of positions -> Map(condition_id -> verdict), replacing the old
// per-position fan-out (which 429'd the shared limiter). Only when a TP/SL side is "Cosmos AI".
// Fail-safe: any error -> empty map, so every side HOLDs (a rate-limit never forces a sell).
async function batchAdvice(cosmos, settings, posArr) {
  if (!(settings.tp_mode === "ai" || settings.sl_mode === "ai")) return new Map();
  const arr = (posArr || []).filter((p) => p && p.condition_id && p.entry_cents);
  if (!arr.length) return new Map();
  try { return await cosmos.adviceBatch(arr); }
  catch (e) { warn("advice-batch unreachable (holding):", e.message); return new Map(); }
}

async function decideExit(cosmos, pm, settings, pos, curFromEdge, aiVerdict) {
  const cur = curFromEdge !== undefined ? curFromEdge : await pm.getPriceCents(pos.token_id);

  // Evaluate the TAKE-PROFIT side and the STOP-LOSS side SEPARATELY. Each side is either "ai" (server
  // brain) or "fixed"/"percent" (local). The "Cosmos AI" verdict is PRECOMPUTED once per cycle by a
  // single batch call (aiVerdict) - we never make a per-position advice call here anymore (that fan-out
  // 429'd the shared limiter, and a 429 used to force a -50% sell). Missing verdict -> that side HOLDs.
  const ai = aiVerdict ?? null;

  // Take-profit side
  if (settings.tp_mode === "ai") { if (ai?.action === "TAKE_PROFIT") return ai; }
  else { const tp = localTp(settings, pos.entry_cents, cur); if (tp) return tp; }

  // Stop-loss side
  if (settings.sl_mode === "ai") { if (ai?.action === "STOP_LOSS") return ai; }
  else { const sl = localSl(settings, pos.entry_cents, cur); if (sl) return sl; }

  return { action: "HOLD" };
}

// Place a marketable Fill-And-Kill SELL that is GUARANTEED to cross the book whenever a bid exists.
// The old code sold at a fixed mid - 5c and RE-TRIED at that same stale price, so a thin/wide book
// near the 1c/99c edges (exactly where the fallback stop/take-profit fires) could kill every attempt
// and the position never sold - the "missed" bug. Now we price against the LIVE best bid, re-read on
// every attempt (the book moves), and sell 1c UNDER it so the order still crosses if the top bid is
// pulled between read and post. A STOP_LOSS / salvage will dump all the way to 1c (accept ANY bid) so
// a losing/worthless position always exits; a TAKE_PROFIT keeps a floor (~10c under mid) so we never
// hand a near-resolved winner to a lowball bid - if nothing clears the floor we HOLD and it resolves
// in our favour anyway. The caller re-runs this every cycle until reconcile confirms the holding is
// actually gone, so a momentary empty book is retried until it fills.
async function marketableSell(cosmos, pm, pos, action = "STOP_LOSS") {
  const mid = (await pm.getPriceCents(pos.token_id)) ?? pos.entry_cents;
  const salvage = action !== "TAKE_PROFIT"; // stop-loss / edge-salvage may dump; take-profit may not
  // Quant take-profits never sell under 99c (per admin spec: the 98.5-99 band; integer ticks make
  // that a fixed 99c ask). A killed FAK just retries - every cycle, forever - and if 99c never
  // fills, resolution redeems at 100c, so holding out costs nothing.
  const floor = salvage ? 1 : pos.source === "quant" ? HZ("QUANT_TP_CENTS", 99) : Math.max(1, mid - 10);
  let last = { ok: false, status: 0, body: {} };
  for (let attempt = 0; attempt < 5; attempt++) {
    const bid = await pm.getBestBidCents(pos.token_id);
    let sellPrice;
    if (bid != null && bid >= floor) {
      sellPrice = Math.max(floor, bid - 1); // cross the resting best bid -> guaranteed fill
    } else if (bid == null) {
      sellPrice = Math.max(floor, mid - SELL_BUFFER - attempt * 3); // no readable book -> escalate down
    } else {
      // There IS a bid but it's below our take-profit floor: don't dump a winner. Hold; it resolves.
      return { mid, held: true, ok: false, status: 0, body: { skipped: "bid below TP floor" } };
    }
    sellPrice = Math.max(1, Math.min(99, Math.round(sellPrice)));
    const r = await pm.placeOrder({ tokenId: pos.token_id, side: "SELL", sizeShares: pos.size_shares, priceCents: sellPrice, orderType: "FAK" });
    if (r.ok) { try { await cosmos.meter({ ...r.meta, source: pos.source ?? null }); } catch { /* order placed; meter best-effort */ } return { mid, sellPrice, ...r }; }
    last = r;
    if (attempt < 4) await sleep(200);
  }
  return { mid, ...last };
}

// Strategy exit for one in-play SPORTS position. Asks the server (which tracks the live game) and
// executes: SELL_PARTIAL = the one-time 60% take-profit at 85c (rest held to resolution);
// SELL_HALF/SELL_ALL kept for backward compatibility with any legacy verdict.
// TOP5 mirror exits: the copied wallet sold >10% of his shares -> sell the SAME fraction (owner
// spec). Exactly-once per step via the server seq. Returns true if it acted this cycle (caller
// then skips the generic exits for this position until next cycle).
async function top5ExitStep(cosmos, pm, positions, pos) {
  let d = null;
  try { d = await cosmos.top5Exit(pos); }
  catch (e) { warn("top5-exit:", e.message); return false; }
  if (!d || d.action !== "SELL_PARTIAL") return false;
  const fraction = Math.min(1, Number(d.fraction) || 0);
  if (fraction <= 0) return false;
  // v2 (owner): fractions are 10%-of-peak STEPS measured against our ORIGINAL position size -
  // record it the first time a mirror instruction arrives (before anything was sold).
  if (pos.top5_orig_shares == null) { pos.top5_orig_shares = pos.size_shares; store.save(positions); }
  const cur = await pm.getPriceCents(pos.token_id);
  const base = d.of === "original" ? pos.top5_orig_shares : pos.size_shares;
  const chunk = fraction >= 0.99 ? pos.size_shares : Math.min(pos.size_shares, Math.floor(base * fraction));
  // Polymarket's ~$1 minimum: if the chunk can't clear it, mirror the intent with a full exit.
  const full = chunk >= pos.size_shares || chunk < 1 || (cur != null && chunk * cur < 110);
  const r = await marketableSell(cosmos, pm, full ? pos : { ...pos, size_shares: chunk }, "TAKE_PROFIT");
  if (r.ok) {
    pos.top5_seq = Number(d.seq) || (pos.top5_seq ?? 0) + 1;
    if (!full) pos.size_shares -= chunk;
    store.save(positions);
    log(`TOP5 mirror-sell ${full ? "ALL" : chunk + " shares (" + Math.round(fraction * 100) + "%)"} ${pos.outcome} @ ~${r.sellPrice ?? r.mid}c · ${d.reason || ""}`);
  } else if (!r.held) {
    warn("top5 mirror-sell failed (will retry next cycle):", r.status);
  }
  return r.ok;
}

async function sportsExitStep(cosmos, pm, positions, pos) {
  const cur = await pm.getPriceCents(pos.token_id);
  let d = null;
  try { d = await cosmos.sportsExit(pos, cur ?? 0); }
  catch (e) { warn("sports-exit:", e.message); return; }
  if (!d || d.action === "HOLD") return;

  if (d.action === "SELL_PARTIAL") {
    const fraction = Number(d.fraction) > 0 && Number(d.fraction) < 1 ? Number(d.fraction) : 0.6;
    const chunk = Math.floor(pos.size_shares * fraction);
    // Polymarket's ~$1 order minimum: if the chunk can't clear it, bank the whole position instead.
    if (chunk < 1 || (cur != null && chunk * cur < 110)) {
      const r = await marketableSell(cosmos, pm, pos, "TAKE_PROFIT");
      if (r.ok) { pos.partial_sold = true; log(`SPORTS TP (full - too small to split) ${pos.outcome} @ ~${r.sellPrice ?? r.mid}c · ${d.reason || ""}`); }
      return; // reconcile removes it once the holding is gone
    }
    const r = await marketableSell(cosmos, pm, { ...pos, size_shares: chunk }, "TAKE_PROFIT");
    if (r.ok) {
      pos.partial_sold = true; // one-time flag: never fire the 60% chunk again
      pos.size_shares -= chunk; // reconcile re-syncs to the true holding next cycle anyway
      store.save(positions);
      log(`SPORTS TP sold ${chunk} shares (${Math.round(fraction * 100)}%) @ ~${r.sellPrice ?? r.mid}c, holding ${pos.size_shares} to resolution · ${d.reason || ""}`);
    } else if (!r.held) {
      warn("sports partial-sell failed (will retry next cycle):", r.status);
    }
    return;
  }

  if (d.action === "SELL_HALF") {
    const half = Math.floor(pos.size_shares / 2);
    // Polymarket's ~$1 order minimum: if half the shares can't clear it, bank the whole win instead.
    if (half < 1 || (cur != null && half * cur < 110)) {
      const r = await marketableSell(cosmos, pm, pos, "TAKE_PROFIT");
      if (r.ok) { log(`SPORTS TP (full - too small to split) ${pos.outcome} @ ~${r.sellPrice ?? r.mid}c · ${d.reason || ""}`); }
      return; // reconcile removes it once the holding is gone
    }
    const r = await marketableSell(cosmos, pm, { ...pos, size_shares: half }, "TAKE_PROFIT");
    if (r.ok) {
      pos.half_sold = true;
      pos.size_shares -= half; // reconcile re-syncs to the true holding next cycle anyway
      store.save(positions);
      log(`SPORTS TP sold ${half} shares @ ~${r.sellPrice ?? r.mid}c, holding ${pos.size_shares} to resolution · ${d.reason || ""}`);
    } else if (!r.held) {
      warn("sports half-sell failed (will retry next cycle):", r.status);
    }
    return;
  }

  if (d.action === "SELL_ALL") {
    const r = await marketableSell(cosmos, pm, pos, "STOP_LOSS"); // salvage: accept any bid
    if (r.ok) log(`SPORTS SALVAGE ${pos.outcome} @ ~${r.sellPrice ?? r.mid}c · ${d.reason || ""}`);
    else warn("sports salvage failed (will retry next cycle):", r.status);
  }
}

async function holdingsMap(pm) {
  const arr = await pm.getMyPositions();
  if (arr == null) return null; // the /positions fetch failed - signal "unknown", NOT "no positions"
  const m = new Map();
  for (const p of arr) m.set(p.condition_id, p);
  return m;
}

async function cycle(cosmos, pm) {
  const account = await cosmos.account();
  const settings = account.settings;

  // --- MASTER STOP: the dashboard Start/Stop switch. When stopped, the bot trades nothing
  // (no entries, no exits) but stays connected and re-checks every cycle, so Start resumes it. ---
  if (settings.bot_enabled === false) {
    const open = Object.keys(store.load()).length;
    log(`paused · start the bot from your Cosmos dashboard${open ? ` · ${open} open position(s) NOT being managed` : ""}`);
    return;
  }

  // --- RECONCILE: make positions.json match the real wallet (handles unfilled/partial/sold). ---
  const positions = store.load();
  const heldRaw = await holdingsMap(pm); // null = the /positions fetch FAILED (not "no positions")
  const holdingsOk = heldRaw != null;
  const held = heldRaw ?? new Map();
  // Only reconcile-delete when we actually got the wallet holdings. If the fetch failed, KEEP the
  // tracked positions - deleting them would drop their exits AND collapse `deployed` to 0 (cash sizing).
  if (holdingsOk) {
    for (const cid of Object.keys(positions)) {
      const h = held.get(cid);
      if (!h || h.size_shares < 1) { delete positions[cid]; continue; } // never filled or already sold
      positions[cid].size_shares = h.size_shares; // sync to actual holding
      if (h.entry_cents > 0) positions[cid].entry_cents = h.entry_cents; // sync the REAL avg fill price
      if (!positions[cid].token_id) positions[cid].token_id = h.token_id;
      if (!positions[cid].end_date && h.end_date) positions[cid].end_date = h.end_date; // holdings now carry it
    }

    // RE-ADOPTION: wallet holdings the bot BOUGHT but lost track of (the old single-page holdings
    // read hid live positions behind 100+ resolved rows, and reconcile then deleted them). Cosmos
    // knows every token this bot ever bought (bot_orders) - a held bot-bought token not in
    // positions.json is re-adopted so exits (TP/SL, edge rules, horizon stop) manage it again.
    // Manual holdings are never in that set, so they are never touched. Refreshed every ~10 min.
    if (!global.__botTokens || Date.now() - global.__botTokensAt > 600_000) {
      try {
        const bm = await cosmos.botMarkets();
        global.__botTokens = new Set(bm.tokens || []);
        global.__botTokensAt = Date.now();
      } catch { /* endpoint not deployed yet or transient - retry next window */ }
    }
    if (global.__botTokens) {
      let adopted = 0;
      for (const h of held.values()) {
        if (positions[h.condition_id]) continue;
        if (!h.token_id || !global.__botTokens.has(String(h.token_id))) continue;
        // A holding under 1 share is worth under $1 (a share pays at most $1), which is below
        // Polymarket's ~$1 minimum order, so it can NEVER be sold. Don't re-adopt un-exitable dust -
        // it just creates an exit that fails every cycle. It settles automatically at resolution.
        if (!(h.size_shares >= 1)) continue;
        positions[h.condition_id] = {
          condition_id: h.condition_id, token_id: h.token_id, outcome: h.outcome, source: "adopted",
          entry_cents: h.entry_cents || h.cur_cents || 50, size_usd: Math.round(h.cur_value * 100) / 100,
          size_shares: h.size_shares, entry_whales: [], market_question: h.title || "",
          end_date: h.end_date ?? undefined, opened_at: new Date().toISOString(),
        };
        adopted++;
      }
      if (adopted) log(`re-adopted ${adopted} bot-bought position(s) that had fallen out of tracking`);
    }
    store.save(positions);
  }

  const balance = await pm.getBalanceUsd();
  // `deployed` = the REAL current $ value of open holdings, so the % is taken off the TRUE portfolio
  // (cash + positions), NOT just leftover cash. Take the MAX of the LIVE /positions value and the
  // local store's cost basis, so neither an empty/failed /positions read NOR a stale store can
  // collapse the portfolio to leftover cash (the "% from cash not balance" death spiral). Uses the
  // live currentValue when available.
  const liveDeployed = holdingsOk
    ? [...held.values()].reduce((a, h) => a + (Number(h.cur_value) || (Number(h.size_shares) || 0) * (Number(h.cur_cents) || 0) / 100), 0)
    : 0;
  const storeDeployed = Object.values(positions).reduce((a, p) => a + (Number(p.size_usd) || 0), 0);
  let deployed = Math.max(liveDeployed, storeDeployed); // `let`: it's incremented per buy below (line ~318)
  // Portfolio = cash + open-positions value. Polymarket's /value is the authoritative total value of
  // the user's OPEN POSITIONS only (per their docs "total value of a user's positions" - it does NOT
  // include the USDC cash balance), and is far more reliable than summing /positions ourselves (a
  // funder can have thousands of old resolved $0 positions across many pages). So: positions value =
  // the larger of Polymarket's /value and our own counted holdings; portfolio = cash + that.
  // Spending is still capped by `remaining` (cash) below.
  const pmValue = await pm.getPortfolioValue();
  const positionsValue = Math.max(Number(pmValue) || 0, deployed);
  const portfolioValue = balance + positionsValue;
  qtState.cash = balance; qtState.portfolio = portfolioValue; qtState.deployed = deployed;
  const feed = await cosmos.signals().catch((e) => {
    // Surface WHY the feed failed - especially the builder-guard 403, which tells the user
    // exactly what happened and how to fix it. Silence here looked like "0 signals" for no reason.
    warn("signal feed unavailable:", e.message);
    return { count: 0, signals: [] };
  });
  const basisNote = pmValue != null && Number(pmValue) >= deployed ? " (cash + polymarket positions)" : !holdingsOk ? " (est: holdings fetch failed)" : storeDeployed > liveDeployed ? " (store basis)" : "";
  // Per-source feed breakdown, so the log SHOWS what the server is serving (e.g. "wallets 55 ·
  // quant 3") - the one line that answers "why is it buying X and not Y".
  const bySrc = {};
  for (const s of feed.signals ?? []) bySrc[s.source ?? "?"] = (bySrc[s.source ?? "?"] ?? 0) + 1;
  const srcNote = Object.entries(bySrc).map(([k, v]) => `${k} ${v}`).join(" · ") || "empty";
  log(`cycle · ${feed.count} signals [${srcNote}] · ${Object.keys(positions).length} open · cash $${balance.toFixed(2)} · portfolio $${portfolioValue.toFixed(2)}${basisNote} · ${sizeLabel(settings.sizing)}`);
  // Self-diagnosis: cash ~$0 means NO buys are possible - say WHY in the log the user actually reads.
  if (balance < 1) {
    const bd = pm.balanceBreakdown ? pm.balanceBreakdown() : { onchain: null, clob: null };
    warn(`cash under $1 - the bot cannot place buys. Balance reads: on-chain $${bd.onchain == null ? "?" : bd.onchain.toFixed(2)} · Polymarket $${bd.clob == null ? "?" : bd.clob.toFixed(2)} (wallet ${pm.funder}, account type ${pm.sigTypeName ?? "?"}). If your Polymarket account DOES show cash, your funder address may be wrong - it must be your Polymarket deposit/profile address.`);
  }

  // Telemetry: report the live sizing basis + config so the admin can SEE why orders are sized as they
  // are (cash vs portfolio vs override, and any funder misconfig). Fire-and-forget.
  {
    const z = settings.sizing || {};
    const sampleSizeUsd = sizeForSignal(z, { lock_tier: "free", score: 5 }, portfolioValue, deployed);
    const bd = pm.balanceBreakdown ? pm.balanceBreakdown() : { onchain: null, clob: null };
    cosmos.reportHealth({
      build: "engine-arm-1", // bump on behavior changes so the admin can SEE who runs which code
      sig_type: pm.sigTypeName ?? null,
      wallet_kind: pm.walletKind ?? null,
      onchain_usd: bd.onchain == null ? null : Number(bd.onchain.toFixed(2)),
      clob_usd: bd.clob == null ? null : Number(bd.clob.toFixed(2)),
      pm_value: pmValue == null ? null : Number(Number(pmValue).toFixed(2)),
      cash: Number(balance.toFixed(2)),
      deployed: Number(deployed.toFixed(2)),
      portfolio: Number(portfolioValue.toFixed(2)),
      holdings_ok: holdingsOk,
      positions_count: holdingsOk ? held.size : Object.keys(positions).length,
      funder: pm.funder,
      signer_eoa: pm.address,
      funder_is_proxy: String(pm.funder).toLowerCase() !== String(pm.address).toLowerCase(),
      sizing_mode: z.mode ?? null,
      sizing_pct: z.pct ?? null,
      tier_pct: z.tierPct ?? null,
      account_size_usd: z.accountSizeUsd ?? null,
      sample_size_usd: Number((sampleSizeUsd || 0).toFixed(2)),
      open_count: Object.keys(positions).length,
      feed_count: feed.count,
    });
  }

  // --- EXITS FIRST (so stops fire before we spend on entries or hit the rate limit). ---
  // Precompute the "Cosmos AI" exit verdicts for ALL positions in ONE batch call (was one POST per
  // position -> a per-token 429 storm that force-sold held positions at -50%).
  const adviceMap = await batchAdvice(cosmos, settings, Object.values(positions));
  let endDateLookups = 0; // cap the per-cycle gamma lookups for the horizon stop
  for (const cid of Object.keys(positions)) {
    const pos = positions[cid];
    // Lazy end-date lookup (max a few per cycle) so the horizon stop knows each position's
    // capital-lock. Cached forever in positions.json; "none" = gamma had no date (skip rules).
    if (pos.end_date === undefined && endDateLookups < 5) {
      endDateLookups++;
      pos.end_date = (await pm.getMarketEndDate(pos.condition_id).catch(() => null)) ?? "none";
      store.save(positions);
    }
    // MODEL-BASED STOP (quant positions only): reprice with the SAME model that drove entry. A FIRED
    // live stop takes precedence over the generic edge salvage below. In shadow mode (the default) this
    // only logs and returns null, so the flow falls through UNCHANGED. QUANT_STOP_MODE=off skips it.
    if (pos.source === "quant") {
      const qstop = await quantModelStop(cosmos, pm, pos);
      if (qstop) {
        const r = await marketableSell(cosmos, pm, pos, qstop.action);
        if (r.ok) log(`${qstop.action} ${pos.outcome} @ ~${r.sellPrice ?? r.mid}c · ${qstop.reason || ""}`);
        else if (r.held) log(`${qstop.action} ${pos.outcome} held - no bid above floor · ${qstop.reason || ""}`);
        else warn("quant-stop exit failed (will retry next cycle):", r.status);
        continue; // next cycle's reconcile removes it once the holding is gone
      }
    }
    // TOP5 mirror exits run FIRST for copies: if the whale is selling, we follow immediately;
    // otherwise the position falls through to the normal exits below.
    if (pos.source === "top5") {
      const acted = await top5ExitStep(cosmos, pm, positions, pos);
      if (acted) continue;
    }
    // EDGE RULES FIRST, for EVERY position type - sports included. Sports used to skip straight
    // to the server strategy, so the 97c+ lock-in and <=3c salvage never fired on them.
    const edge = await edgeExit(pm, pos);
    if (edge.action === "HOLD") continue; // book gone - resolution auto-redeems
    let v = edge.action ? edge : null;
    // WEATHER: edge rules ONLY - the 98c take-profit or the <=3c salvage. NEVER AI advice, the
    // -50% fallback, a manual SL, or the horizon stop. A near-certain bracket bet just holds to
    // its same-day resolution unless it hits one of those two edges.
    if (pos.source === "weather" && !v) continue;
    // QTABLE: edge rules only (99c lock-in or the <=3c salvage) - these resolve within minutes to
    // hours and the table priced the entry; no advice brain, no user TP/SL, no horizon stop.
    if (pos.source === "qtable" && !v) continue;
    // HORIZON STOP: dead-money positions get sold no matter what the TP/SL settings say.
    if (!v) {
      const hz = horizonVerdict(pos, edge.cur);
      if (hz) v = { action: "STOP_LOSS", reason: `HORIZON: ${hz}` };
    }
    if (!v) {
      // In-play SPORTS positions follow the server-run strategy exits (50% at entry*1.6, full
      // salvage at minute 85+ when the favorite isn't winning, rest to resolution) - NOT the
      // user's TP/SL settings.
      if (pos.source === "sports") { await sportsExitStep(cosmos, pm, positions, pos); continue; }
      v = await decideExit(cosmos, pm, settings, pos, edge.cur, adviceMap.get(cid));
    }
    if (!v || v.action === "HOLD") continue;
    const r = await marketableSell(cosmos, pm, pos, v.action);
    if (r.ok) log(`${v.action} ${pos.outcome} @ ~${r.sellPrice ?? r.mid}c · ${v.reason || ""}`);
    else if (r.held) log(`${v.action} ${pos.outcome} held - no bid above floor, will resolve · ${v.reason || ""}`);
    else warn("exit failed (will retry next cycle):", r.status, JSON.stringify(r.body?.polymarket ?? r.body?.error ?? r.body ?? "").slice(0, 400));
    // Don't delete here — next cycle's reconcile removes it once the holding is actually gone.
    // FAK never rests, so re-attempting next cycle can't stack duplicate orders.
  }

  // --- ENTRIES: buy a market at most ONCE, only when it is newly added to the feed. ---
  const seen = store.loadSeen();
  const cutoff = Date.now() - 30 * 86400000; // prune evaluated markets older than 30 days
  for (const [cid, t] of Object.entries(seen)) { if (cid === "__init") continue; if (new Date(t).getTime() < cutoff) delete seen[cid]; }
  const nowIso = new Date().toISOString();

  if (Object.keys(seen).length === 0 && !BUY_BACKLOG) {
    // First run: record the current NON-ENGINE markets but do NOT buy the backlog — only act on
    // markets added from now on. (Use COSMOS_BUY_BACKLOG=1 to buy the current feed.)
    // ENGINE items (quant/weather/sports) are NOT baselined: they are live server-curated strategy
    // entries, not a stale backlog — baselining them meant every fresh boot/redeploy silently burned
    // every live engine signal (the "bot never buys the engines" bug). They stay buyable next cycle.
    // `__init` marks that the baseline ran, so an engines-only feed can't re-trigger it forever.
    seen.__init = nowIso;
    for (const s of feed.signals) if (s.condition_id && !ENGINE_SOURCES.has(s.source)) seen[s.condition_id] = nowIso;
    store.saveSeen(seen);
    log(`watching ${Object.keys(seen).length - 1} markets · will buy only newly-added ones (engine signals stay live)`);
  } else if (!holdingsOk) {
    // The wallet holdings fetch FAILED this cycle: we cannot know what we already hold, so a buy
    // here could double an existing position (a fresh boot has an empty positions.json too - the
    // reconcile's `held` set is the only real guard). Exits already ran; entries wait a cycle.
    warn("holdings fetch failed - skipping entries this cycle (cannot verify what we already hold)");
  } else {
    // Sizing comes from the dashboard; fall back to legacy per_trade_pct if absent.
    const sizing = settings.sizing || { mode: "pct", pct: settings.per_trade_pct ?? config.perTradePct ?? DEFAULT_PCT, tierPct: { gold: 6, platinum: 6, bronze: 6, free: 6 }, conviction: false, maxPerTradeUsd: null, maxExposurePct: null, accountSizeUsd: null };
    qtState.sizing = sizing;
    let remaining = balance; // `deployed` (true portfolio basis) is computed above from real holdings
    // Mark a market "evaluated" so it's never reconsidered. Called only after a real decision
    // (sized-out, price ran past entry, or an order was attempted) — NOT on transient failures
    // (token unresolved, no live price, out of balance), so a blip doesn't lose a good signal.
    const markSeen = (cid) => { seen[cid] = nowIso; store.saveSeen(seen); };

    for (const s of feed.signals) {
      if (!s.condition_id) continue;
      if (seen[s.condition_id] || positions[s.condition_id] || held.has(s.condition_id)) continue; // already evaluated / held
      if (Object.keys(positions).length >= (config.maxConcurrent ?? 10)) break; // full — leave for when a slot frees

      let sizeUsd = sizeForSignal(sizing, s, portfolioValue, deployed);
      // Floor to Polymarket's ~$1 minimum order so SMALL balances still trade instead of being
      // skipped (the share math below already guarantees >= ~$1 of shares). Do NOT floor — and do
      // NOT burn the market via markSeen — when there's simply no room right now (out of balance, or
      // the exposure cap is maxed): those are TRANSIENT, so a later size/balance change retries it.
      const exposureRoom = sizing.maxExposurePct
        ? Math.max(0, (portfolioValue * Number(sizing.maxExposurePct)) / 100 - deployed)
        : Infinity;
      if (sizeUsd < MIN_TRADE_USD && exposureRoom >= MIN_TRADE_USD) sizeUsd = MIN_TRADE_USD; // hard $2 floor
      if (sizeUsd < MIN_TRADE_USD || sizeUsd > remaining) continue; // no room right now — transient, retry (no burn)

      // FILL-TIME SPOT CHECK (quant ladders): the server refreshes signals every cron tick, but spot
      // can cross the strike in the gap before the next refresh retires a now-stale ticket. Re-check
      // fresh spot here so we never fill a directional bet whose thesis already broke. Transient - no
      // burn: if spot comes back to the thesis side and the signal is still live, it re-arms.
      if (s.source === "quant" && !(await quantSpotOk(s))) {
        logSkipOnce(s.condition_id, "spot", `skip quant: fresh spot on wrong side of strike · ${(s.market_question || "").slice(0, 48)}`);
        continue;
      }

      const tokenId = await pm.resolveToken(s.condition_id, s.outcome);
      if (!tokenId) { warn("no token:", (s.market_question || "").slice(0, 50)); continue; } // transient — retry

      const mid = await pm.getPriceCents(tokenId);
      if (mid == null) { warn("no live price:", (s.market_question || "").slice(0, 50)); continue; } // don't enter at a stale price — retry
      if (mid > s.max_entry_price) {
        // Ran past the entry cap. For ENGINE sources this is NOT a permanent decision: their markets
        // move fast (hourly strikes, in-play bands) and the price often comes BACK inside the cap -
        // burning on first sight was why engine signals never got bought. The server retires the
        // signal when the edge is truly gone, so re-arming each cycle is safe. Raw sources keep the
        // permanent burn (a missed insider entry stays missed).
        if (ENGINE_SOURCES.has(s.source)) { logSkipOnce(s.condition_id, "cap", `skip (price ${mid}c over the ${s.max_entry_price}c cap) ${(s.market_question || "").slice(0, 48)}`); continue; }
        markSeen(s.condition_id); continue;
      }

      // GLOBAL 5c EXECUTION FLOOR — never place a buy when the live price is under 5c, for ANY
      // source. Sub-5c means the market has all but decided against this side; copying it is
      // catching a falling knife no matter what the signal said. Not markSeen: if it recovers
      // above 5c (and passes the gap rule below) it's buyable again. buyPrice >= mid here (mid
      // <= max_entry was checked above), so gating mid gates the execution price itself.
      if (mid < 5) { logSkipOnce(s.condition_id, "floor", `skip (price ${mid}c under the 5c floor) ${(s.market_question || "").slice(0, 48)}`); continue; }

      // SIGNAL-PRICE GAP RULE — a deferred buy (e.g. cash freed up long after the alert) must not
      // chase a signal whose price has SLID since the alert: alerted at 20c, now 12c means the
      // market is voting AGAINST the thesis - buying the dip is how bad signals get doubled into.
      // Only buy within 10% below the alert price (>= 90% of price_cents; above it the max_entry
      // cap already governs). Not markSeen: a recovery back into the band re-arms the buy.
      // ALL engine sources are exempt - those strategies price their own entries server-side
      // (sports buys the in-play discount band; quant/weather refresh entry_cents every cron tick,
      // so "slid below the alert" just means the server will re-quote it - the max_entry cap and
      // the 5c floor still guard execution).
      const sigPrice = Number(s.price_cents) || 0;
      if (!ENGINE_SOURCES.has(s.source) && sigPrice > 0 && mid < sigPrice * 0.9) {
        logSkipOnce(s.condition_id, "gap", `skip (price ${mid}c is >10% under the ${sigPrice}c alert) ${(s.market_question || "").slice(0, 48)}`);
        continue;
      }

      const buyPrice = Math.min(98, s.max_entry_price, mid + BUY_BUFFER); // marketable, capped
      // Shares must clear Polymarket's ~$1 minimum order value: a single share at a high price
      // (90c+) is under $1, so floor(sizeUsd/price) can produce an invalid sub-$1 order.
      const shares = Math.max(Math.ceil(100 / buyPrice), sharesFor(sizeUsd, buyPrice));
      const orderUsd = (shares * buyPrice) / 100; // actual cost (>= ~$1)
      if (orderUsd > remaining) continue; // the $1-min bump exceeds balance — retry when funds free
      const r = await placeWithRetry(pm, { tokenId, side: "BUY", sizeShares: shares, priceCents: buyPrice, orderType: "FAK" });
      if (!r.ok) {
        warn("entry failed after retries:", r.status, JSON.stringify(r.body?.polymarket ?? r.body?.error ?? r.body ?? "").slice(0, 400));
        // A 4xx means the ORDER itself was rejected (illiquid / "no match" FAK kill / bad params).
        // Raw sources give up immediately (won't fill on a retry). ENGINE markets are often real but
        // momentarily thin (fresh hourly strikes) - allow ENTRY_4XX_LIMIT attempts across cycles
        // before burning. A 5xx / network blip is transient -> leave UNSEEN so it retries.
        if (typeof r.status === "number" && r.status >= 400 && r.status < 500) {
          const fails = (entryFails.get(s.condition_id) ?? 0) + 1;
          entryFails.set(s.condition_id, fails);
          if (!ENGINE_SOURCES.has(s.source) || fails >= ENTRY_4XX_LIMIT) markSeen(s.condition_id);
        }
        continue;
      }
      markSeen(s.condition_id); // filled/placed — one shot per market (buy once)

      // Order placed at Polymarket — meter the $0.09 + record the position (entry = the price we bid;
      // the next reconcile syncs the real avg fill from holdings).
      let paused = false;
      try { const m = await cosmos.meter({ ...r.meta, source: s.source ?? null }); paused = Boolean(m?.paused); } catch { /* meter best-effort */ }
      remaining -= orderUsd;
      deployed += orderUsd;
      positions[s.condition_id] = {
        condition_id: s.condition_id, token_id: tokenId, outcome: s.outcome, source: s.source,
        entry_cents: buyPrice, size_usd: orderUsd, size_shares: shares, entry_whales: s.entry_whales || [],
        market_question: s.market_question, opened_at: new Date().toISOString(),
      };
      store.save(positions);
      log(`BUY  [${s.source}] ${s.outcome} @ ~${buyPrice}c · $${sizeUsd.toFixed(2)} · ${(s.market_question || "").slice(0, 48)}`);
      if (paused) { warn("daily spend limit reached — pausing entries."); break; }
    }
  }

  // --- MANUAL TRADES (apply the same exits to your existing positions, if enabled). ---
  if (config.applyToManualTrades && (settings.tp_manual || settings.sl_manual)) {
    const manualAdviceMap = await batchAdvice(cosmos, settings, [...held.values()].map((m) => ({ condition_id: m.condition_id, outcome: m.outcome, entry_cents: m.entry_cents, entry_whales: [] })));
    for (const m of held.values()) {
      if (positions[m.condition_id]) continue; // a bot position — already handled
      const pos = { condition_id: m.condition_id, token_id: m.token_id, outcome: m.outcome, entry_cents: m.entry_cents, size_shares: m.size_shares, entry_whales: [] };
      // Same order as bot positions: the always-on edge rules first, then the user's TP/SL.
      const edge = await edgeExit(pm, pos);
      if (edge.action === "HOLD") continue;
      const v = edge.action ? edge : await decideExit(cosmos, pm, settings, pos, edge.cur, manualAdviceMap.get(m.condition_id));
      if (!v || v.action === "HOLD") continue;
      const r = await marketableSell(cosmos, pm, pos, v.action);
      if (r.ok) log(`(manual) ${v.action} ${m.outcome} @ ~${r.sellPrice ?? r.mid}c · ${v.reason || ""}`);
    }
  }
}

// Self-update watchdog: INDEPENDENTLY of the launcher, every ~10 min check the repo for a newer
// commit; if found, pull it and exit so the launcher relaunches the bot on the new code. This makes a
// repo push reach EVERY bot with zero user action, even where the launcher's own git timer is flaky
// (the bug that stranded bots on old code) - the bot pulls the code itself, then any restart runs it.
const SELF_UPDATE_MS = (Number(process.env.COSMOS_SELFUPDATE_SECONDS) || 600) * 1000;
let lastUpdateCheck = Date.now();
function maybeSelfUpdate() {
  if (Date.now() - lastUpdateCheck < SELF_UPDATE_MS) return;
  lastUpdateCheck = Date.now();
  try {
    execSync("git fetch --depth 1 origin main", { stdio: "ignore", timeout: 20000 });
    const local = execSync("git rev-parse HEAD", { timeout: 5000 }).toString().trim();
    const remote = execSync("git rev-parse FETCH_HEAD", { timeout: 5000 }).toString().trim();
    if (local && remote && local !== remote) {
      execSync("git reset --hard FETCH_HEAD", { stdio: "ignore", timeout: 20000 });
      // Exit ONLY when a launcher is there to restart us (entrypoint.sh / the install loops set
      // COSMOS_LAUNCHER=1). A bare `node src/bot.mjs` (old local installs) has no restarter -
      // exiting killed the bot until someone noticed. There we keep RUNNING on the old code
      // (the new code is on disk and applies on the next manual restart).
      if (process.env.COSMOS_LAUNCHER === "1") {
        log(`self-update ${local.slice(0, 7)} -> ${remote.slice(0, 7)}; restarting via launcher`);
        process.exit(0);
      }
      log(`self-update pulled ${local.slice(0, 7)} -> ${remote.slice(0, 7)}; no launcher detected - restart the bot to apply`);
    }
  } catch { /* git unavailable (local dev) or a transient failure - ignore, retry next window */ }
}

async function main() {
  log("Cosmos bot starting…");
  const cosmos = makeCosmos(config);
  const acct = await cosmos.account();
  if (!acct.bot_access) { console.error("This plan does not include bot/API trading. Upgrade in the dashboard."); process.exit(1); }
  const pm = await makePolymarket(config);
  log(`connected · plan ${acct.tier} · wallet ${pm.address.slice(0, 6)}… · funder ${pm.funder.slice(0, 6)}…${pm.builderFee ? " · builder fee ON" : ""}`);

  // Geoblock check (Polymarket docs): if this server's IP is blocked, every order is rejected with
  // a 403. Surface it loudly up front so it's not a silent wall of failed entries.
  const geo = await pm.geoblock();
  if (geo.ok && geo.blocked) {
    warn(`GEOBLOCKED: Polymarket is blocking this server's IP (${geo.ip} · ${geo.country}${geo.region ? "/" + geo.region : ""}). Orders WILL be rejected (403). This datacenter/region is on Polymarket's blocklist - run from a sanctioned location (Polymarket KYC/KYB co-location in eu-west-2).`);
  } else if (geo.ok) {
    log(`geoblock: clear (${geo.country ?? "?"}${geo.region ? "/" + geo.region : ""})`);
  } else {
    warn("geoblock check failed:", geo.status ?? geo.error);
  }

  // QTABLE fast engine - PAUSED by owner 2026-07-09: the table's fit had a structural bug
  // (unconditional-threshold shortcut + off-by-one elapsed labels) that inflated P with |d|,
  // so "edge" selected model error (fleet -18.6% in 24h; the corrected model showed the real
  // edge was <4pp on 78% of fills). Re-enable ONLY with a conditionally-refit table via
  // QTABLE_ENABLED=1. Open qtable positions still exit normally (TP/salvage/resolution).
  if (process.env.QTABLE_ENABLED === "1") {
    startQTable({ pm, cosmos, store, placeWithRetry, sharesFor, sizeForSignal, state: qtState });
  }

  // QTABLE2 - the CORRECTED candle engine (refit tow-aware table + Chainlink RTDS spot/reference +
  // strict guards; the fixed successor to qtable.mjs, which used the buggy pre-refit table + Binance
  // spot). ON BY DEFAULT for ALL users (owner rollout 2026-07-12): runs unless QTABLE2_ENABLED=0.
  // Each bot sizes from its own dashboard % (QTABLE2_STAKE_USD>0 overrides to a fixed $/trade).
  // DRY preview: QTABLE2_DRY=1 logs would-be fills, places nothing. See src/qtable2.mjs.
  if (process.env.QTABLE2_ENABLED !== "0") {
    const { startQTable2 } = await import("./qtable2.mjs");
    startQTable2({ pm, cosmos, store, placeWithRetry, sharesFor, sizeForSignal, state: qtState });
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    maybeSelfUpdate(); // pull + relaunch on a new commit (throttled to every SELF_UPDATE_MS)
    try {
      await cycle(cosmos, pm);
    } catch (e) {
      err("cycle:", e.message);
    }
    await sleep((config.pollSeconds ?? 30) * 1000);
  }
}
// Run the loop only when executed directly (node src/bot.mjs) - NOT when imported (e.g. a unit test
// importing the pure exit rule), so importing this module never boots the trading loop.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
