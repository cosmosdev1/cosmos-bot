#!/usr/bin/env node
// Cosmos API trading bot — main loop. Reads your filtered feed from Cosmos, sizes positions,
// signs orders locally, places them through the metering relay (marketable Fill-And-Kill), and
// runs the exit logic (Cosmos AI / fixed / percent). State is RECONCILED against your real
// Polymarket holdings each cycle, so positions.json never drifts from reality.
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
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

// Hard floor per trade: Polymarket's ~$1 minimum order. Any computed size below this is bumped up
// to $1 (e.g. 3% of a $10 balance = $0.30 still trades at $1), as long as there's room.
const MIN_TRADE_USD = 2;

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
const DEFAULT_PCT = 3; // never size at 0% - fall back to 3% of portfolio if a config value is missing/0

function sizeForSignal(z, s, portfolio, deployed) {
  // Size off an explicit account-size override when the user set one, else the TRUE portfolio VALUE
  // passed in (Polymarket's authoritative total = cash + open positions). The override makes
  // "3% of $200 = $6" hold no matter what the live reads do.
  const basis = Number(z.accountSizeUsd) > 0 ? Number(z.accountSizeUsd) : portfolio;
  let usd;
  if (z.mode === "fixed") usd = Number(z.fixedUsd) || 0;
  else if (z.mode === "tiered") {
    const tp = z.tierPct || {};
    // `||` (not `??`) so a 0/undefined tier falls through: tier -> free -> the flat pct -> DEFAULT_PCT.
    // NEVER resolve to 0% (which the $1 floor would turn into a tiny 2-3 share minimum order).
    const pct = Number(tp[s.lock_tier]) || Number(tp.free) || Number(z.pct) || DEFAULT_PCT;
    usd = (basis * pct) / 100;
  } else {
    usd = (basis * (Number(z.pct) || DEFAULT_PCT)) / 100;
  }
  if (z.conviction && s.score) usd *= 0.5 + Number(s.score) / 10; // score 0..10 -> 0.5x..1.5x
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
  if (z.mode === "tiered") { const t = z.tierPct || {}; return `size: tiered g${t.gold ?? 0}/p${t.platinum ?? 0}/b${t.bronze ?? 0}/f${t.free ?? 0}%${basis}`; }
  return `size: ${Number(z.pct) || DEFAULT_PCT}%${basis}`;
}

const BUY_BUFFER = 3; //  marketable buy: bid a few cents above mid (capped at max_entry)
const SELL_BUFFER = 5; // marketable sell: offer a few cents below mid so stops actually fill
const HARD_STOP_FRAC = 0.5; // advice unreachable -> still exit if price has halved

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

async function decideExit(cosmos, pm, settings, pos) {
  const cur = await pm.getPriceCents(pos.token_id);

  // HARD RULE (always on): once a position reaches the edge of the book it has essentially resolved.
  if (cur != null && cur >= 99) return { action: "TAKE_PROFIT", reason: "reached 99c - locking the win" };
  if (cur != null && cur <= 1) return { action: "STOP_LOSS", reason: "reached 1c - salvaging" };

  // Evaluate the TAKE-PROFIT side and the STOP-LOSS side SEPARATELY. Each side is either "ai" (server
  // brain) or "fixed"/"percent" (local). The old code routed BOTH sides to the AI brain whenever
  // EITHER was "ai", so a user's manual TP/SL on the other side was silently ignored — the core bug.
  let ai = null;
  if (settings.tp_mode === "ai" || settings.sl_mode === "ai") {
    try { ai = await cosmos.advice(pos); }
    catch (e) {
      warn("advice:", e.message);
      if (cur != null && cur <= pos.entry_cents * HARD_STOP_FRAC) return { action: "STOP_LOSS", reason: "local hard stop (advice unavailable)" };
    }
  }

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
  const floor = salvage ? 1 : Math.max(1, mid - 10);
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
    if (r.ok) { try { await cosmos.meter(r.meta); } catch { /* order placed; meter best-effort */ } return { mid, sellPrice, ...r }; }
    last = r;
    if (attempt < 4) await sleep(200);
  }
  return { mid, ...last };
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
  const feed = await cosmos.signals().catch(() => ({ count: 0, signals: [] }));
  const basisNote = pmValue != null && Number(pmValue) >= deployed ? " (cash + polymarket positions)" : !holdingsOk ? " (est: holdings fetch failed)" : storeDeployed > liveDeployed ? " (store basis)" : "";
  log(`cycle · ${feed.count} signals · ${Object.keys(positions).length} open · cash $${balance.toFixed(2)} · portfolio $${portfolioValue.toFixed(2)}${basisNote} · ${sizeLabel(settings.sizing)}`);

  // Telemetry: report the live sizing basis + config so the admin can SEE why orders are sized as they
  // are (cash vs portfolio vs override, and any funder misconfig). Fire-and-forget.
  {
    const z = settings.sizing || {};
    const sampleSizeUsd = sizeForSignal(z, { lock_tier: "free", score: 5 }, portfolioValue, deployed);
    const bd = pm.balanceBreakdown ? pm.balanceBreakdown() : { onchain: null, clob: null };
    cosmos.reportHealth({
      build: "pm-value-1",
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
  for (const cid of Object.keys(positions)) {
    const pos = positions[cid];
    const v = await decideExit(cosmos, pm, settings, pos);
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
    const sizing = settings.sizing || { mode: "pct", pct: settings.per_trade_pct ?? config.perTradePct ?? DEFAULT_PCT, tierPct: { gold: 4, platinum: 4, bronze: 3, free: 3 }, conviction: false, maxPerTradeUsd: null, maxExposurePct: null, accountSizeUsd: null };
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
      if (!r.ok) {
        warn("entry failed after retries:", r.status, JSON.stringify(r.body?.polymarket ?? r.body?.error ?? r.body ?? "").slice(0, 400));
        // A 4xx means the ORDER itself was rejected (illiquid / "no match" FAK kill / bad params) -
        // it won't fill on a retry, so give up on this market instead of hammering it every cycle.
        // A 5xx / network blip is transient -> leave UNSEEN so it retries once the API clears.
        if (typeof r.status === "number" && r.status >= 400 && r.status < 500) markSeen(s.condition_id);
        continue;
      }
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
      log(`BUY  [${s.source}] ${s.outcome} @ ~${buyPrice}c · $${sizeUsd.toFixed(2)} · ${(s.market_question || "").slice(0, 48)}`);
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
      log(`self-update ${local.slice(0, 7)} -> ${remote.slice(0, 7)}; pulling + restarting`);
      execSync("git reset --hard FETCH_HEAD", { stdio: "ignore", timeout: 20000 });
      process.exit(0); // the launcher relaunches the bot on the freshly-pulled code
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
main();
