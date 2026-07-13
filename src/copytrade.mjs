// copytrade.mjs — whale COPY engine, integrated into the fleet bot (owner spec 2026-07-13).
//
// Follows a fixed, hand-picked set of whales (server-side lib/copytrade), each LOCKED to one category.
// The server does the whale-side work (detect new post-activation positions, track his money-in + peak
// shares, conflict rules) and serves /api/v1/copy-signals. THIS loop does the per-user RATIO sizing off
// the bot's own live portfolio:
//
//   unit    = portfolio x pct           (the user's normal per-trade $, via sizeForSignal)
//   ceiling = unit + portfolio x 1%     (one percentage-point above their setting — the hard cap)
//   target  = Σ_whale ( his_money_in x unit / his_avg_trade_$ )      (capped at ceiling)
//
// We BUY the first tranche once target clears Polymarket's ~$1 min ("the first beat"), and SCALE IN as
// his money-in grows (each ratio step adds to our position, up to the ceiling). EXITS are the whale's
// peak-share cuts, handled in the main 30s cycle (copyExitStep) — this fast loop only opens/adds.
//
// Spawned from main() ONLY when COPYTRADE_ENABLED=1 (per-deployment gate). DRY: COPYTRADE_DRY=1 logs
// would-be fills and places nothing. Positions are tagged source:"copytrade".
import { appendFileSync } from "node:fs";
import { log, warn } from "./log.mjs";

const N = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };
const DRY = process.env.COPYTRADE_DRY === "1";
const POLL_MS = N("COPY_POLL_MS", 20_000);
const MAX_OPEN = N("COPY_MAX_OPEN", 25);
const MIN_ORDER_USD = N("COPY_MIN_USD", 1);       // Polymarket ~$1 min order = "the first beat"
const MIN_ADD_USD = N("COPY_MIN_ADD_USD", 1);     // smallest scale-in increment worth an order
const COOLDOWN_MS = N("COPY_COOLDOWN_MS", 60_000); // per-market: don't re-buy within the on-chain settle window
// Owner 2026-07-13: never OPEN a new copy above 92c (95c risks 95c to win 5c). But once we're IN, if the
// whale keeps adding we follow him up — scale-ins are capped only by the sanity ceiling.
const MAX_ENTRY_CENTS = N("COPY_MAX_ENTRY_CENTS", 92); // new positions
const MAX_ADD_CENTS = N("COPY_MAX_ADD_CENTS", 97);     // scaling into a position we already hold

const DATA_DIR = (process.env.COSMOS_DATA_DIR || ".").replace(/\/$/, "");
const LEDGER = `${DATA_DIR}/copytrade-trades.ndjson`;
function appendLedger(rec) { try { appendFileSync(LEDGER, JSON.stringify(rec) + "\n"); } catch (e) { warn("copytrade ledger:", e?.message); } }

// our target $ for a signal, given this user's unit + portfolio. Sums each driving whale's own ratio;
// 2 same-side whales stack. Capped at the ceiling. 0 => can't size (no valid whale avg) or first-beat unmet.
function targetUsd(sig, unit, portfolio) {
  const ceiling = unit + portfolio * 0.01;
  let t = 0;
  for (const w of sig.wallets ?? []) {
    const avg = Number(w.avg_trade_usd) || 0, cost = Number(w.cost_usd) || 0;
    if (avg > 0 && cost > 0) t += (cost * unit) / avg;
  }
  return { target: Math.min(t, ceiling), ceiling };
}

export function startCopyTrade(deps) {
  const { pm, cosmos, store, placeWithRetry, sharesFor, sizeForSignal, state } = deps;
  const recentBuy = new Map(); // cid -> ts (settle-window cooldown; also throttles scale-in cadence)
  const stats = { signals: 0, opens: 0, adds: 0, fills: 0 };
  let alive = true;

  async function priceFor(tokenId, capCents) {
    const mid = await pm.getPriceCents(tokenId);
    if (mid == null) return null;
    if (mid > capCents) return null;                    // market is above our cap -> don't chase it
    const px = Math.min(capCents, Math.round(mid) + 1); // cross toward the ask, capped
    return px >= 1 ? px : null;
  }

  async function buy(sig, orderUsd, priceCents, kind, positions, existing, key = sig.condition_id) {
    const shares = Math.max(Math.ceil(100 / priceCents), sharesFor(orderUsd, priceCents));
    const realUsd = (shares * priceCents) / 100;
    if (realUsd > (state.cash ?? 0)) return false;
    const who = (sig.wallets?.[0]?.username) || (sig.wallets?.[0]?.wallet || "").slice(0, 8);
    const tag = `${sig.category} ${sig.outcome} @${priceCents}c · ${kind} $${realUsd.toFixed(2)} · via ${who} ($${Math.round(Number(sig.his_cost_usd) || 0).toLocaleString()} in)`;
    if (DRY) { log(`copytrade DRY would ${kind === "open" ? "OPEN" : "ADD"} ${tag} · ${String(sig.market_question || "").slice(0, 40)}`); recentBuy.set(sig.condition_id, Date.now()); return true; }

    const r = await placeWithRetry(pm, { tokenId: sig.token_id, side: "BUY", sizeShares: shares, priceCents, orderType: "FAK" }, 2, 100);
    recentBuy.set(sig.condition_id, Date.now());
    if (!r.ok) { warn(`copytrade ${kind} failed: ${String(r.error ?? r.err ?? r.status ?? "").slice(0, 120)}`); return false; }
    stats.fills++;
    try { await cosmos.meter({ ...r.meta, source: "copytrade" }); } catch { /* best-effort */ }

    const nowIso = new Date().toISOString();
    if (kind === "open") {
      positions[key] = {
        condition_id: sig.condition_id, token_id: sig.token_id, outcome: sig.outcome, source: "copytrade",
        entry_cents: priceCents, size_usd: realUsd, size_shares: shares, entry_whales: [],
        market_question: sig.market_question || "", opened_at: nowIso, end_date: sig.end_date || undefined,
        copy_wallet: (sig.wallets?.[0]?.wallet || "").toLowerCase(), copy_category: sig.category,
        copy_orig_shares: shares, copy_seq: 0, copy_his_cost: Number(sig.his_cost_usd) || 0, copy_target_usd: Number(orderUsd.toFixed(2)),
      };
      stats.opens++;
    } else {
      existing.size_usd = Number((existing.size_usd + realUsd).toFixed(2));
      existing.size_shares += shares;
      existing.copy_orig_shares = Math.max(existing.copy_orig_shares || 0, existing.size_shares);
      existing.copy_his_cost = Number(sig.his_cost_usd) || existing.copy_his_cost;
      existing.copy_target_usd = Number((existing.copy_target_usd || 0) + realUsd).toFixed?.(2) ?? existing.copy_target_usd;
      stats.adds++;
    }
    store.save(positions);
    state.cash -= realUsd; state.deployed += realUsd;
    const rec = { ts: nowIso, cid: sig.condition_id, cat: sig.category, outcome: sig.outcome, kind, wallet: (sig.wallets?.[0]?.wallet || "").toLowerCase(), price_cents: priceCents, shares, size_usd: Number(realUsd.toFixed(2)), his_cost_usd: Number(sig.his_cost_usd) || 0 };
    appendLedger(rec);
    // per-user admin ledger (only trades opened after activation ever reach here)
    cosmos.copyReport({ wallet: rec.wallet, condition_id: sig.condition_id, outcome: sig.outcome, category: sig.category, action: "BUY", shares, price_cents: priceCents, size_usd: rec.size_usd, his_cost_usd: rec.his_cost_usd, market_question: sig.market_question }).catch(() => {});
    log(`copytrade ${kind === "open" ? "OPEN" : "ADD "} ${tag} ✓ · ${String(sig.market_question || "").slice(0, 36)}`);
    return true;
  }

  async function tick() {
    if (state.copytrade === false) return;                       // server turned the engine off -> stop trading
    if (state.cash == null || state.sizing == null) return;      // no cycle data yet
    let feed;
    try { feed = await cosmos.copySignals(); } catch (e) { warn("copytrade feed:", e.message); return; }
    const signals = feed?.signals ?? [];
    if (!signals.length) return;
    const positions = store.load();
    let openCopy = 0; for (const p of Object.values(positions)) if (p.source === "copytrade") openCopy++;
    const unitBasis = sizeForSignal(state.sizing, { source: "copytrade", outcome: "Yes" }, state.portfolio, state.deployed);
    if (!(unitBasis > 0)) return;

    for (const sig of signals) {
      if (!sig.condition_id || !sig.token_id) continue;
      if ((recentBuy.get(sig.condition_id) ?? 0) > Date.now() - COOLDOWN_MS) continue; // settle-window cooldown
      const { target } = targetUsd(sig, unitBasis, state.portfolio);
      if (!(target > 0)) continue;
      stats.signals++;

      // our copy position on THIS exact (market, side): the primary cid slot, or the composite key we
      // use for the opposite side when two whales split a market (owner: buy the opposite too).
      const primary = positions[sig.condition_id];
      const compKey = `${sig.condition_id}#${sig.token_id}`;
      const sameSide = (p) => p && String(p.outcome).toLowerCase() === String(sig.outcome).toLowerCase();
      let mine = null;
      if (primary?.source === "copytrade" && sameSide(primary)) mine = primary;
      else if (positions[compKey]?.source === "copytrade") mine = positions[compKey];

      if (mine) {
        const add = target - (Number(mine.size_usd) || 0);
        if (add < MIN_ADD_USD) continue;                                // no ratio transition worth an order
        // ALREADY IN: he's reinforcing, so we follow him up — the 92c entry cap does NOT apply here.
        const px = await priceFor(sig.token_id, MAX_ADD_CENTS);
        if (px == null) continue;
        await buy(sig, Math.min(add, state.cash ?? 0), px, "add", positions, mine);
      } else {
        if (target < MIN_ORDER_USD) continue;                           // first beat not reached
        if (openCopy >= MAX_OPEN) continue;
        // pick the store key: free primary slot -> cid; primary holds the OPPOSITE side -> composite key
        // (hold both). Primary holds the SAME side already (any engine) -> don't stack, skip.
        const key = primary ? (sameSide(primary) ? null : compKey) : sig.condition_id;
        if (!key || positions[key]) continue;
        // NEW ENTRY: hard 92c cap (owner). priceFor returns null if the market is already above it.
        const px = await priceFor(sig.token_id, Math.min(MAX_ENTRY_CENTS, Number(sig.max_entry_cents) || MAX_ENTRY_CENTS));
        if (px == null) continue;
        const ok = await buy(sig, Math.min(target, state.cash ?? 0), px, "open", positions, null, key);
        if (ok) openCopy++;
      }
    }
  }

  (async function run() {
    log(`copytrade: engine ON · ratio sizing (portfolio x pct, ceiling +1pt) · max ${MAX_OPEN} open · poll ${POLL_MS}ms${DRY ? " · DRY RUN" : ""}`);
    const si = setInterval(() => log(`copytrade … signals ${stats.signals} · opens ${stats.opens} · adds ${stats.adds} · fills ${stats.fills}`), 120_000);
    while (alive) {
      const t0 = Date.now();
      try { await tick(); } catch (e) { warn("copytrade:", e?.message); }
      await new Promise((res) => setTimeout(res, Math.max(2000, POLL_MS - (Date.now() - t0))));
    }
    clearInterval(si);
  })();
  return () => { alive = false; };
}
