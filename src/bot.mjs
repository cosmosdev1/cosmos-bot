#!/usr/bin/env node
// Cosmos API trading bot — main loop. Reads your filtered feed from Cosmos, sizes positions,
// signs orders locally, places them through the metering relay, and runs the exit logic
// (Cosmos AI / fixed / percent). Open positions persist to positions.json.
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
  // "Cosmos AI" mode -> ask the server brain (whale-exit + price). Otherwise evaluate locally.
  if (settings.tp_mode === "ai" || settings.sl_mode === "ai") {
    try {
      return await cosmos.advice(pos);
    } catch (e) {
      warn("advice:", e.message);
      return { action: "HOLD" };
    }
  }
  const cur = (await pm.getPriceCents(pos.token_id)) ?? pos.entry_cents;
  return localExit(settings, pos.entry_cents, cur);
}

async function sell(cosmos, pm, pos) {
  const cur = (await pm.getPriceCents(pos.token_id)) ?? pos.entry_cents;
  const shares = pos.size_shares ?? sharesFor(pos.size_usd ?? 0, cur);
  const order = await pm.buildSignedOrder({ tokenId: pos.token_id, side: "SELL", sizeShares: shares, priceCents: cur });
  return cosmos.relayOrder(order);
}

async function cycle(cosmos, pm) {
  const positions = store.load();
  const account = await cosmos.account();
  const settings = account.settings;
  const feed = await cosmos.signals();
  const balance = await pm.getBalanceUsd();
  log(`cycle · ${feed.count} signals · ${Object.keys(positions).length} open · $${balance.toFixed(2)}`);

  // --- ENTRIES ---
  for (const s of feed.signals) {
    if (!s.condition_id || positions[s.condition_id]) continue; // dedupe by market (across sources)
    if (Object.keys(positions).length >= (config.maxConcurrent ?? 10)) break;
    if (s.price_cents > s.max_entry_price) continue; // already ran past the insider entry

    const sizeUsd = Math.max(1, (balance * (settings.per_trade_pct ?? config.perTradePct ?? 5)) / 100);
    if (sizeUsd > balance) continue;

    const tokenId = await pm.resolveToken(s.condition_id, s.outcome);
    if (!tokenId) { warn("no token:", (s.market_question || "").slice(0, 50)); continue; }

    const shares = sharesFor(sizeUsd, s.price_cents);
    const order = await pm.buildSignedOrder({ tokenId, side: "BUY", sizeShares: shares, priceCents: s.price_cents });
    const r = await cosmos.relayOrder(order);
    if (r.status === 402) { warn("daily spend limit reached — pausing entries."); break; }
    if (!r.ok) { warn("entry failed:", r.body?.error || r.status); continue; }

    positions[s.condition_id] = {
      condition_id: s.condition_id, token_id: tokenId, outcome: s.outcome, source: s.source,
      entry_cents: s.price_cents, size_usd: sizeUsd, size_shares: shares, entry_whales: s.entry_whales || [],
      market_question: s.market_question, opened_at: new Date().toISOString(),
    };
    store.save(positions);
    log(`BUY  ${s.outcome} @ ${s.price_cents}c · $${sizeUsd.toFixed(2)} · ${(s.market_question || "").slice(0, 48)}`);
  }

  // --- EXITS (bot positions) ---
  for (const cid of Object.keys(positions)) {
    const pos = positions[cid];
    const v = await decideExit(cosmos, pm, settings, pos);
    if (!v || v.action === "HOLD") continue;
    const r = await sell(cosmos, pm, pos);
    if (r.ok) {
      log(`${v.action} ${pos.outcome} · ${v.reason || ""}`);
      delete positions[cid];
      store.save(positions);
    } else {
      warn("exit failed:", r.body?.error || r.status);
    }
  }

  // --- MANUAL TRADES (apply the same exits to your own positions, if enabled) ---
  if (config.applyToManualTrades && (settings.tp_manual || settings.sl_manual)) {
    const mine = await pm.getMyPositions();
    for (const m of mine) {
      if (positions[m.condition_id]) continue; // a bot position — handled above
      const pos = { condition_id: m.condition_id, token_id: m.token_id, outcome: m.outcome, entry_cents: m.entry_cents, size_shares: m.size_shares, entry_whales: [] };
      const v = await decideExit(cosmos, pm, settings, pos);
      if (!v || v.action === "HOLD") continue;
      const r = await sell(cosmos, pm, pos);
      if (r.ok) log(`(manual) ${v.action} ${m.outcome} · ${v.reason || ""}`);
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
