#!/usr/bin/env node
// Cosmos API trading bot — main loop. Reads your filtered feed from Cosmos, sizes positions,
// signs orders locally, places them through the metering relay (marketable Fill-And-Kill), and
// runs the exit logic (Cosmos AI / fixed / percent). State is RECONCILED against your real
// Polymarket holdings each cycle, so positions.json never drifts from reality.
import { existsSync, readFileSync } from "node:fs";
import { makeCosmos } from "./cosmos.mjs";
import { makePolymarket } from "./polymarket.mjs";
import * as store from "./store.mjs";
import { log, warn, err } from "./log.mjs";

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
    maxConcurrent: Number(e.MAX_CONCURRENT) || f.maxConcurrent || 10,
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

// Hard floor per trade: Polymarket's ~$1 minimum order. Any computed size below this is bumped up
// to $1 (e.g. 3% of a $10 balance = $0.30 still trades at $1), as long as there's room.
const MIN_TRADE_USD = 1;

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
//   pct -> % of balance · fixed -> $ · tiered -> % by the signal's tier.
// Optional: scale by score, a $ cap per trade, and a total-exposure ceiling.
function sizeForSignal(z, s, balance, deployed) {
  let usd;
  if (z.mode === "fixed") usd = Number(z.fixedUsd) || 0;
  else if (z.mode === "tiered") {
    const tp = z.tierPct || {};
    usd = (balance * (Number(tp[s.lock_tier] ?? tp.free ?? 0) || 0)) / 100;
  } else {
    usd = (balance * (Number(z.pct) || 0)) / 100;
  }
  if (z.conviction && s.score) usd *= 0.5 + Number(s.score) / 10; // score 0..10 -> 0.5x..1.5x
  if (z.maxPerTradeUsd) usd = Math.min(usd, Number(z.maxPerTradeUsd));
  if (z.maxExposurePct) usd = Math.min(usd, Math.max(0, (balance * Number(z.maxExposurePct)) / 100 - deployed));
  return usd;
}

// Human-readable active size, logged each cycle so you can SEE in the Render logs that a dashboard
// save reached THIS token (the bot re-reads /api/v1/account every cycle, no caching).
function sizeLabel(z) {
  if (!z || !z.mode) return "size: default";
  if (z.mode === "fixed") return `size: $${Number(z.fixedUsd) || 0}/trade`;
  if (z.mode === "tiered") { const t = z.tierPct || {}; return `size: tiered g${t.gold ?? 0}/p${t.platinum ?? 0}/b${t.bronze ?? 0}/f${t.free ?? 0}%`; }
  return `size: ${Number(z.pct) || 0}% of balance`;
}

const BUY_BUFFER = 3; //  marketable buy: bid a few cents above mid (capped at max_entry)
const SELL_BUFFER = 5; // marketable sell: offer a few cents below mid so stops actually fill
const HARD_STOP_FRAC = 0.5; // advice unreachable -> still exit if price has halved

// Local TP/SL evaluation (fixed price / percent) against the live price.
function localExit(settings, entryCents, curCents) {
  if (!curCents) return { action: "HOLD" };
  const gainPct = ((curCents - entryCents) / entryCents) * 100;
  if (settings.tp_mode === "fixed" && settings.tp_value && curCents >= settings.tp_value) return { action: "TAKE_PROFIT", reason: `>= ${settings.tp_value}c` };
  if (settings.tp_mode === "percent" && settings.tp_value && gainPct >= settings.tp_value) return { action: "TAKE_PROFIT", reason: `+${gainPct.toFixed(0)}%` };
  if (settings.sl_mode === "fixed" && settings.sl_value && curCents <= settings.sl_value) return { action: "STOP_LOSS", reason: `<= ${settings.sl_value}c` };
  if (settings.sl_mode === "percent" && settings.sl_value && gainPct <= -settings.sl_value) return { action: "STOP_LOSS", reason: `${gainPct.toFixed(0)}%` };
  return { action: "HOLD" };
}

async function decideExit(cosmos, pm, settings, pos) {
  const cur = await pm.getPriceCents(pos.token_id);

  // HARD RULE (always on — overrides TP/SL/AI): once a position reaches the edge of the book it has
  // essentially resolved, so SELL it. 99c+ = resolved YES, lock the win before resolution/illiquidity;
  // 1c- = resolved NO, salvage what's left instead of riding it to zero.
  if (cur != null && cur >= 99) return { action: "TAKE_PROFIT", reason: "reached 99c - locking the win" };
  if (cur != null && cur <= 1) return { action: "STOP_LOSS", reason: "reached 1c - salvaging" };

  // "Cosmos AI" mode -> ask the server brain. If it's unreachable (e.g. rate-limited), still apply
  // a local hard stop so a crashing position exits rather than riding down.
  if (settings.tp_mode === "ai" || settings.sl_mode === "ai") {
    try {
      return await cosmos.advice(pos);
    } catch (e) {
      warn("advice:", e.message);
      if (cur != null && cur <= pos.entry_cents * HARD_STOP_FRAC) return { action: "STOP_LOSS", reason: "local hard stop (advice unavailable)" };
      return { action: "HOLD" };
    }
  }
  return localExit(settings, pos.entry_cents, cur ?? pos.entry_cents);
}

// Place a marketable Fill-And-Kill SELL for the shares we actually hold.
async function marketableSell(cosmos, pm, pos) {
  const mid = (await pm.getPriceCents(pos.token_id)) ?? pos.entry_cents;
  const sellPrice = Math.max(1, mid - SELL_BUFFER);
  const r = await placeWithRetry(pm, { tokenId: pos.token_id, side: "SELL", sizeShares: pos.size_shares, priceCents: sellPrice, orderType: "FAK" });
  if (r.ok) { try { await cosmos.meter(r.meta); } catch { /* order placed; meter best-effort */ } }
  return { mid, ...r };
}

async function holdingsMap(pm) {
  const m = new Map();
  for (const p of await pm.getMyPositions()) m.set(p.condition_id, p);
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
  const held = await holdingsMap(pm);
  for (const cid of Object.keys(positions)) {
    const h = held.get(cid);
    if (!h || h.size_shares < 1) { delete positions[cid]; continue; } // never filled or already sold
    positions[cid].size_shares = h.size_shares; // sync to actual holding
    if (h.entry_cents > 0) positions[cid].entry_cents = h.entry_cents; // sync the REAL avg fill price
    if (!positions[cid].token_id) positions[cid].token_id = h.token_id;
  }
  store.save(positions);

  const balance = await pm.getBalanceUsd();
  const feed = await cosmos.signals().catch(() => ({ count: 0, signals: [] }));
  log(`cycle · ${feed.count} signals · ${Object.keys(positions).length} open · $${balance.toFixed(2)} · ${sizeLabel(settings.sizing)}`);

  // --- EXITS FIRST (so stops fire before we spend on entries or hit the rate limit). ---
  for (const cid of Object.keys(positions)) {
    const pos = positions[cid];
    const v = await decideExit(cosmos, pm, settings, pos);
    if (!v || v.action === "HOLD") continue;
    const r = await marketableSell(cosmos, pm, pos);
    if (r.ok) log(`${v.action} ${pos.outcome} @ ~${r.mid}c · ${v.reason || ""}`);
    else warn("exit failed:", r.status, JSON.stringify(r.body?.polymarket ?? r.body?.error ?? r.body ?? "").slice(0, 400));
    // Don't delete here — next cycle's reconcile removes it once the holding is actually gone.
    // FAK never rests, so re-attempting next cycle can't stack duplicate orders.
  }

  // --- ENTRIES: buy a market at most ONCE, only when it is newly added to the feed. ---
  const seen = store.loadSeen();
  const cutoff = Date.now() - 30 * 86400000; // prune evaluated markets older than 30 days
  for (const [cid, t] of Object.entries(seen)) if (new Date(t).getTime() < cutoff) delete seen[cid];
  const nowIso = new Date().toISOString();

  if (Object.keys(seen).length === 0 && !BUY_BACKLOG) {
    // First run: record the current markets but do NOT buy the backlog — only act on
    // markets added from now on. (Use COSMOS_BUY_BACKLOG=1 to buy the current feed.)
    for (const s of feed.signals) if (s.condition_id) seen[s.condition_id] = nowIso;
    store.saveSeen(seen);
    log(`watching ${Object.keys(seen).length} markets · will buy only newly-added ones`);
  } else {
    // Sizing comes from the dashboard; fall back to legacy per_trade_pct if absent.
    const sizing = settings.sizing || { mode: "pct", pct: settings.per_trade_pct ?? config.perTradePct ?? 5, tierPct: {}, conviction: false, maxPerTradeUsd: null, maxExposurePct: null };
    let remaining = balance;
    let deployed = Object.values(positions).reduce((a, p) => a + (Number(p.size_usd) || 0), 0);
    // Mark a market "evaluated" so it's never reconsidered. Called only after a real decision
    // (sized-out, price ran past entry, or an order was attempted) — NOT on transient failures
    // (token unresolved, no live price, out of balance), so a blip doesn't lose a good signal.
    const markSeen = (cid) => { seen[cid] = nowIso; store.saveSeen(seen); };

    for (const s of feed.signals) {
      if (!s.condition_id) continue;
      if (seen[s.condition_id] || positions[s.condition_id] || held.has(s.condition_id)) continue; // already evaluated / held
      if (Object.keys(positions).length >= (config.maxConcurrent ?? 10)) break; // full — leave for when a slot frees

      let sizeUsd = sizeForSignal(sizing, s, balance, deployed);
      // Floor to Polymarket's ~$1 minimum order so SMALL balances still trade instead of being
      // skipped (the share math below already guarantees >= ~$1 of shares). Do NOT floor — and do
      // NOT burn the market via markSeen — when there's simply no room right now (out of balance, or
      // the exposure cap is maxed): those are TRANSIENT, so a later size/balance change retries it.
      const exposureRoom = sizing.maxExposurePct
        ? Math.max(0, (balance * Number(sizing.maxExposurePct)) / 100 - deployed)
        : Infinity;
      if (sizeUsd < MIN_TRADE_USD && exposureRoom >= MIN_TRADE_USD) sizeUsd = MIN_TRADE_USD; // hard $1 floor
      if (sizeUsd < MIN_TRADE_USD || sizeUsd > remaining) continue; // no room right now — transient, retry (no burn)

      const tokenId = await pm.resolveToken(s.condition_id, s.outcome);
      if (!tokenId) { warn("no token:", (s.market_question || "").slice(0, 50)); continue; } // transient — retry

      const mid = await pm.getPriceCents(tokenId);
      if (mid == null) { warn("no live price:", (s.market_question || "").slice(0, 50)); continue; } // don't enter at a stale price — retry
      if (mid > s.max_entry_price) { markSeen(s.condition_id); continue; } // ran past the insider entry — a decision

      const buyPrice = Math.min(98, s.max_entry_price, mid + BUY_BUFFER); // marketable, capped
      // Shares must clear Polymarket's ~$1 minimum order value: a single share at a high price
      // (90c+) is under $1, so floor(sizeUsd/price) can produce an invalid sub-$1 order.
      const shares = Math.max(Math.ceil(100 / buyPrice), sharesFor(sizeUsd, buyPrice));
      const orderUsd = (shares * buyPrice) / 100; // actual cost (>= ~$1)
      if (orderUsd > remaining) continue; // the $1-min bump exceeds balance — retry when funds free
      const r = await placeWithRetry(pm, { tokenId, side: "BUY", sizeShares: shares, priceCents: buyPrice, orderType: "FAK" });
      if (!r.ok) { warn("entry failed after retries:", r.status, JSON.stringify(r.body?.polymarket ?? r.body?.error ?? r.body ?? "").slice(0, 400)); continue; } // leave UNSEEN -> retry next cycle (don't burn on a transient kill)
      markSeen(s.condition_id); // filled/placed — one shot per market (buy once)

      // Order placed at Polymarket — meter the $0.09 + record the position (entry = the price we bid;
      // the next reconcile syncs the real avg fill from holdings).
      let paused = false;
      try { const m = await cosmos.meter(r.meta); paused = Boolean(m?.paused); } catch { /* meter best-effort */ }
      remaining -= orderUsd;
      deployed += orderUsd;
      positions[s.condition_id] = {
        condition_id: s.condition_id, token_id: tokenId, outcome: s.outcome, source: s.source,
        entry_cents: buyPrice, size_usd: orderUsd, size_shares: shares, entry_whales: s.entry_whales || [],
        market_question: s.market_question, opened_at: new Date().toISOString(),
      };
      store.save(positions);
      log(`BUY  ${s.outcome} @ ~${buyPrice}c · $${sizeUsd.toFixed(2)} · ${(s.market_question || "").slice(0, 48)}`);
      if (paused) { warn("daily spend limit reached — pausing entries."); break; }
    }
  }

  // --- MANUAL TRADES (apply the same exits to your existing positions, if enabled). ---
  if (config.applyToManualTrades && (settings.tp_manual || settings.sl_manual)) {
    for (const m of held.values()) {
      if (positions[m.condition_id]) continue; // a bot position — already handled
      const pos = { condition_id: m.condition_id, token_id: m.token_id, outcome: m.outcome, entry_cents: m.entry_cents, size_shares: m.size_shares, entry_whales: [] };
      const v = await decideExit(cosmos, pm, settings, pos);
      if (!v || v.action === "HOLD") continue;
      const r = await marketableSell(cosmos, pm, pos);
      if (r.ok) log(`(manual) ${v.action} ${m.outcome} @ ~${r.mid}c · ${v.reason || ""}`);
    }
  }
}

async function main() {
  log("Cosmos bot starting…");
  const cosmos = makeCosmos(config);
  const acct = await cosmos.account();
  if (!acct.bot_access) { console.error("This plan does not include bot/API trading. Upgrade in the dashboard."); process.exit(1); }
  const pm = await makePolymarket(config);
  log(`connected · plan ${acct.tier} · wallet ${pm.address.slice(0, 6)}… · funder ${pm.funder.slice(0, 6)}…${pm.builderFee ? " · builder fee ON" : ""}`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await cycle(cosmos, pm);
    } catch (e) {
      err("cycle:", e.message);
    }
    await sleep((config.pollSeconds ?? 30) * 1000);
  }
}
main();
