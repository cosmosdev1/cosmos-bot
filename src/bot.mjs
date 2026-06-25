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

if (!existsSync("./config.json")) {
  console.error("No config.json — run `npm run setup` first.");
  process.exit(1);
}
const config = JSON.parse(readFileSync("./config.json", "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sharesFor = (usd, cents) => Math.floor((usd * 100) / Math.max(1, cents));

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
  // "Cosmos AI" mode -> ask the server brain. If it's unreachable (e.g. rate-limited), still apply
  // a local hard stop so a crashing position exits rather than riding down.
  if (settings.tp_mode === "ai" || settings.sl_mode === "ai") {
    try {
      return await cosmos.advice(pos);
    } catch (e) {
      warn("advice:", e.message);
      const cur = await pm.getPriceCents(pos.token_id);
      if (cur && cur <= pos.entry_cents * HARD_STOP_FRAC) return { action: "STOP_LOSS", reason: "local hard stop (advice unavailable)" };
      return { action: "HOLD" };
    }
  }
  const cur = (await pm.getPriceCents(pos.token_id)) ?? pos.entry_cents;
  return localExit(settings, pos.entry_cents, cur);
}

// Place a marketable Fill-And-Kill SELL for the shares we actually hold.
async function marketableSell(cosmos, pm, pos) {
  const mid = (await pm.getPriceCents(pos.token_id)) ?? pos.entry_cents;
  const sellPrice = Math.max(1, mid - SELL_BUFFER);
  const order = await pm.buildSignedOrder({ tokenId: pos.token_id, side: "SELL", sizeShares: pos.size_shares, priceCents: sellPrice, orderType: "FAK" });
  return { mid, ...(await cosmos.relayOrder(order)) };
}

async function holdingsMap(pm) {
  const m = new Map();
  for (const p of await pm.getMyPositions()) m.set(p.condition_id, p);
  return m;
}

async function cycle(cosmos, pm) {
  const account = await cosmos.account();
  const settings = account.settings;

  // --- RECONCILE: make positions.json match the real wallet (handles unfilled/partial/sold). ---
  const positions = store.load();
  const held = await holdingsMap(pm);
  for (const cid of Object.keys(positions)) {
    const h = held.get(cid);
    if (!h || h.size_shares < 1) { delete positions[cid]; continue; } // never filled or already sold
    positions[cid].size_shares = h.size_shares; // sync to actual holding
    if (!positions[cid].token_id) positions[cid].token_id = h.token_id;
  }
  store.save(positions);

  const balance = await pm.getBalanceUsd();
  const feed = await cosmos.signals().catch(() => ({ count: 0, signals: [] }));
  log(`cycle · ${feed.count} signals · ${Object.keys(positions).length} open · $${balance.toFixed(2)}`);

  // --- EXITS FIRST (so stops fire before we spend on entries or hit the rate limit). ---
  for (const cid of Object.keys(positions)) {
    const pos = positions[cid];
    const v = await decideExit(cosmos, pm, settings, pos);
    if (!v || v.action === "HOLD") continue;
    const r = await marketableSell(cosmos, pm, pos);
    if (r.ok) log(`${v.action} ${pos.outcome} @ ~${r.mid}c · ${v.reason || ""}`);
    else warn("exit failed:", r.body?.error || r.status);
    // Don't delete here — next cycle's reconcile removes it once the holding is actually gone.
    // FAK never rests, so re-attempting next cycle can't stack duplicate orders.
  }

  // --- ENTRIES (respect remaining balance; skip markets already held). ---
  // Sizing comes from the dashboard; fall back to legacy per_trade_pct if absent.
  const sizing = settings.sizing || { mode: "pct", pct: settings.per_trade_pct ?? config.perTradePct ?? 5, tierPct: {}, conviction: false, maxPerTradeUsd: null, maxExposurePct: null };
  let remaining = balance;
  let deployed = Object.values(positions).reduce((a, p) => a + (Number(p.size_usd) || 0), 0);
  for (const s of feed.signals) {
    if (!s.condition_id || positions[s.condition_id] || held.has(s.condition_id)) continue;
    if (Object.keys(positions).length >= (config.maxConcurrent ?? 10)) break;

    const sizeUsd = sizeForSignal(sizing, s, balance, deployed);
    if (sizeUsd < 1 || sizeUsd > remaining) continue; // below Polymarket's ~$1 min, or out of balance

    const tokenId = await pm.resolveToken(s.condition_id, s.outcome);
    if (!tokenId) { warn("no token:", (s.market_question || "").slice(0, 50)); continue; }

    const mid = (await pm.getPriceCents(tokenId)) ?? s.price_cents;
    if (mid > s.max_entry_price) continue; // already ran past the insider entry (checked live)

    const buyPrice = Math.min(98, s.max_entry_price, mid + BUY_BUFFER); // marketable, capped
    const shares = sharesFor(sizeUsd, buyPrice);
    const order = await pm.buildSignedOrder({ tokenId, side: "BUY", sizeShares: shares, priceCents: buyPrice, orderType: "FAK" });
    const r = await cosmos.relayOrder(order);
    if (r.status === 402) { warn("daily spend limit reached — pausing entries."); break; }
    if (!r.ok) { warn("entry failed:", r.body?.error || r.status); continue; }

    remaining -= sizeUsd;
    deployed += sizeUsd;
    positions[s.condition_id] = {
      condition_id: s.condition_id, token_id: tokenId, outcome: s.outcome, source: s.source,
      entry_cents: mid, size_usd: sizeUsd, size_shares: shares, entry_whales: s.entry_whales || [],
      market_question: s.market_question, opened_at: new Date().toISOString(),
    };
    store.save(positions);
    log(`BUY  ${s.outcome} @ ~${mid}c · $${sizeUsd.toFixed(2)} · ${(s.market_question || "").slice(0, 48)}`);
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
  log(`connected · plan ${acct.tier} · wallet ${pm.address.slice(0, 6)}… · funder ${pm.funder.slice(0, 6)}…`);

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
