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
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { log, warn } from "./log.mjs";

const N = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };
const DRY = process.env.COPYTRADE_DRY === "1";
const POLL_MS = N("COPY_POLL_MS", 20_000);
const MAX_OPEN = N("COPY_MAX_OPEN", 10);          // blowup fix: 25 -> 10
const MIN_ORDER_USD = N("COPY_MIN_USD", 1);       // Polymarket ~$1 min order = "the first beat"
const MIN_ADD_USD = N("COPY_MIN_ADD_USD", 1);     // smallest scale-in increment worth an order
const COOLDOWN_MS = N("COPY_COOLDOWN_MS", 60_000); // per-market: don't re-buy within the on-chain settle window
// Owner 2026-07-13: never OPEN a new copy above 92c (95c risks 95c to win 5c). But once we're IN, if the
// whale keeps adding we follow him up — scale-ins are capped only by the sanity ceiling.
const MAX_ENTRY_CENTS = N("COPY_MAX_ENTRY_CENTS", 92); // new positions
const MAX_ADD_CENTS = N("COPY_MAX_ADD_CENTS", 97);     // scaling into a position we already hold
// ---- POST-BLOWUP GUARDS (2026-07-13 forensics; each one maps to a proven loss channel) ----
const MIN_ENTRY_CENTS = N("COPY_MIN_ENTRY_CENTS", 10); // no penny legs: 1c spread at 3c = 33%/round-trip
const MIN_ADD_CENTS = N("COPY_MIN_ADD_CENTS_FLOOR", 5);
// copytrade may hold at most this % of the portfolio in cost basis — the blowup deployed 100% (cash $0.54)
const MAX_EXPOSURE_PCT = N("COPY_MAX_EXPOSURE_PCT", 20);
// fleet churned 4.4 buys/min for 3h; a real directional copy has no business firing faster than this
const MAX_BUYS_PER_HOUR = N("COPY_MAX_BUYS_PER_HOUR", 12);
// owner: "smaller amount per trade" — the copy unit is this fraction of the dashboard per-trade size,
// and the ceiling premium (+1pt) shrinks with it
const UNIT_FRACTION = N("COPY_UNIT_FRACTION", 0.5);

const DATA_DIR = (process.env.COSMOS_DATA_DIR || ".").replace(/\/$/, "");
const LEDGER = `${DATA_DIR}/copytrade-trades.ndjson`;
function appendLedger(rec) { try { appendFileSync(LEDGER, JSON.stringify(rec) + "\n"); } catch (e) { warn("copytrade ledger:", e?.message); } }

// BUY-ONCE-EVER memory (persisted): a (market, side) we have already OPENED is never opened again —
// the blowup's worst channel was salvage-sell -> 60s cooldown expires -> re-open the dying side -> loop
// (one market ate $148 in 8 re-buys). Adds to a still-open position remain allowed; re-OPENS never.
const SEEN_FILE = `${DATA_DIR}/copytrade-seen.json`;
function loadSeen() { try { return JSON.parse(readFileSync(SEEN_FILE, "utf8")); } catch { return {}; } }
function saveSeen(s) { try { writeFileSync(SEEN_FILE, JSON.stringify(s)); } catch (e) { warn("copytrade seen:", e?.message); } }

// THE BEATS (owner 2026-07-14, exact spec). We do NOT track his money-in continuously. His AVERAGE
// position is the yardstick, and we enter in FIVE BEATS of 20%:
//
//   his position reaches 20% of HIS average  ->  we hold 20% of OUR max copy size
//                        40%                 ->  40%
//                        ...                     ...
//                        100% (a full, average-sized position for him)  ->  100% of our size
//
// So on a $2,500 average, every $500 he commits moves us one beat. The beat is relative to HIM: a whale
// whose average is $30 moves a beat every $6. Our max size for an average position is `unit`; if he goes
// beyond his own average we keep following up to the ceiling (unit + 1pt).
// Two same-side whales stack (each contributes its own beats). 0 => cannot size / first beat not reached.
const BEATS = N("COPY_BEATS", 5);                 // 5 beats -> 20% each
function targetUsd(sig, unit, portfolio) {
  const step = 1 / BEATS;                          // 0.20 of his average = 0.20 of our size
  // THE $1 BEAT FLOOR (owner 2026-07-14). Polymarket will not accept an order under ~$1, so a beat
  // worth $0.30 is not a small trade — it is NO trade. The ratio alone made the big whales uncopyable:
  // against a $44,843 average, one beat sized $0.09 and nothing could ever be placed. So each beat is
  // AT LEAST the minimum order, which makes a full 5-beat entry (him at 100% of his average) $5.
  // Our max copy size is therefore max(unit, 5 x $1) and the ceiling rises with it.
  const beatUsd = Math.max(MIN_ORDER_USD, (unit * step));
  const maxPos = BEATS * beatUsd;                  // what we hold once he is at 100% of his average
  const ceiling = Math.max(maxPos, unit + portfolio * 0.01 * UNIT_FRACTION);
  let t = 0, beats = 0;
  for (const w of sig.wallets ?? []) {
    const avg = Number(w.avg_trade_usd) || 0, cost = Number(w.cost_usd) || 0;
    if (!(avg > 0 && cost > 0)) continue;
    const frac = cost / avg;                       // how far into a normal-sized position he is
    // +1e-9: 0.6/0.2 is 2.9999999999999996 in floating point, so an exact 60% would floor to 2 beats
    // and silently under-buy every third beat.
    const n = Math.floor(frac / step + 1e-9);      // completed beats (0..5, and beyond if he oversizes)
    if (n <= 0) continue;                          // hasn't reached his first 20% -> we do nothing yet
    beats += n;
    t += n * beatUsd;                              // each beat buys one full, placeable beat
  }
  return { target: Math.min(t, ceiling), ceiling, beats, beatUsd };
}

export function startCopyTrade(deps) {
  const { pm, cosmos, store, placeWithRetry, sharesFor, sizeForSignal, state } = deps;
  const recentBuy = new Map(); // cid -> ts (settle-window cooldown; also throttles scale-in cadence)
  const seen = loadSeen();     // (cid#token) -> ts of first OPEN — never re-open (persisted)
  const buyTimes = [];         // sliding-window rate limit
  const stats = { signals: 0, opens: 0, adds: 0, fills: 0 };
  let alive = true;

  async function priceFor(tokenId, capCents, floorCents) {
    const mid = await pm.getPriceCents(tokenId);
    if (mid == null) return null;
    if (mid > capCents) return null;                    // market is above our cap -> don't chase it
    if (mid < floorCents) return null;                  // penny leg -> spread eats any edge; skip
    const px = Math.min(capCents, Math.round(mid) + 1); // cross toward the ask, capped
    return px >= 1 ? px : null;
  }
  const rateLimited = () => {
    const cut = Date.now() - 3600e3;
    while (buyTimes.length && buyTimes[0] < cut) buyTimes.shift();
    return buyTimes.length >= MAX_BUYS_PER_HOUR;
  };
  const copyExposure = (positions) => {
    let s = 0; for (const p of Object.values(positions)) if (p.source === "copytrade") s += Number(p.size_usd) || 0;
    return s;
  };

  async function buy(sig, orderUsd, priceCents, kind, positions, existing, key = sig.condition_id) {
    const shares = Math.max(Math.ceil(100 / priceCents), sharesFor(orderUsd, priceCents));
    const realUsd = (shares * priceCents) / 100;
    if (realUsd > (state.cash ?? 0)) return false;
    const who = (sig.wallets?.[0]?.username) || (sig.wallets?.[0]?.wallet || "").slice(0, 8);
    const tag = `${sig.category} ${sig.outcome} @${priceCents}c · ${kind} $${realUsd.toFixed(2)} · via ${who} ($${Math.round(Number(sig.his_cost_usd) || 0).toLocaleString()} in)`;
    if (DRY) { log(`copytrade DRY would ${kind === "open" ? "OPEN" : "ADD"} ${tag} · ${String(sig.market_question || "").slice(0, 40)}`); recentBuy.set(sig.condition_id, Date.now()); return true; } // DRY returns true so seen/rate-limit apply like a real fill

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

  // THE FAST PATH (chainwatch). The whale's fill is seen on-chain in ~2s instead of ~360s via the
  // activity indexer, and the server has ALREADY applied every rule (new-only, category, runway, pair
  // cost, entry band) in /api/v1/copy-check. What's left is exactly the local half — the caps that
  // protect THIS account — so it runs the same guards the polled loop does, on a signal that is just
  // minutes fresher. Buy-once-ever means the slow feed re-delivering it later is a no-op.
  async function fastOpen(sig) {
    if (state.copytrade === false) return;
    if (state.cash == null || state.sizing == null) return;      // no cycle data yet -> can't size
    const positions = store.load();
    let openCopy = 0; for (const p of Object.values(positions)) if (p.source === "copytrade") openCopy++;
    const unitBasis = sizeForSignal(state.sizing, { source: "copytrade", outcome: "Yes" }, state.portfolio, state.deployed) * UNIT_FRACTION;
    if (!(unitBasis > 0)) return;
    const exposureCap = ((state.portfolio || 0) * MAX_EXPOSURE_PCT) / 100;
    // RATIO SIZING (owner's spec, "the beats"): our_$ = his_$ x (our_unit / his_avg_trade_$), capped at
    // the ceiling. The chain gives his exact share count, so copy-check prices his money-in and this
    // path sizes IDENTICALLY to the polled one — a flat unit would buy the same off a $50 dab as off a
    // $50,000 conviction. Below the $1 Polymarket minimum ("the first beat") we simply don't buy.
    const { target } = targetUsd(sig, unitBasis, state.portfolio);
    if (!(target > 0)) return;

    if ((recentBuy.get(sig.condition_id) ?? 0) > Date.now() - COOLDOWN_MS) return;
    if (target < MIN_ORDER_USD) return;
    if (openCopy >= MAX_OPEN) return;
    if (rateLimited()) return;
    const primary = positions[sig.condition_id];
    const sameSide = (p) => p && String(p.outcome).toLowerCase() === String(sig.outcome).toLowerCase();
    const compKey = `${sig.condition_id}#${sig.token_id}`;
    const key = primary ? (sameSide(primary) ? null : compKey) : sig.condition_id;
    if (!key || positions[key]) return;                           // already in this side
    const seenKey = compKey;
    if (seen[seenKey]) return;                                    // BUY-ONCE-EVER
    if (copyExposure(positions) + target > exposureCap) return;
    const cap = sig.is_pair
      ? Math.min(99, Number(sig.max_entry_cents) || 99)
      : Math.min(MAX_ENTRY_CENTS, Number(sig.max_entry_cents) || MAX_ENTRY_CENTS);
    const floor = sig.is_pair ? 1 : MIN_ENTRY_CENTS;
    const px = await priceFor(sig.token_id, cap, floor);
    if (px == null) return;
    const ok = await buy(sig, Math.min(target, state.cash ?? 0), px, "open", positions, null, key);
    if (ok) { buyTimes.push(Date.now()); seen[seenKey] = Date.now(); saveSeen(seen); }
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
    // "smaller amount per trade" (owner): the copy unit is a FRACTION of the dashboard per-trade size
    const unitBasis = sizeForSignal(state.sizing, { source: "copytrade", outcome: "Yes" }, state.portfolio, state.deployed) * UNIT_FRACTION;
    if (!(unitBasis > 0)) return;
    const exposureCap = ((state.portfolio || 0) * MAX_EXPOSURE_PCT) / 100;

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
        if (rateLimited()) continue;
        if (copyExposure(positions) + add > exposureCap) continue;      // copytrade never exceeds its slice
        // ALREADY IN: he's reinforcing, so we follow him up — the 92c entry cap does NOT apply here.
        const px = await priceFor(sig.token_id, MAX_ADD_CENTS, MIN_ADD_CENTS);
        if (px == null) continue;
        const ok = await buy(sig, Math.min(add, state.cash ?? 0), px, "add", positions, mine);
        if (ok) buyTimes.push(Date.now());
      } else {
        if (target < MIN_ORDER_USD) continue;                           // first beat not reached
        if (openCopy >= MAX_OPEN) continue;
        if (rateLimited()) continue;
        // pick the store key: free primary slot -> cid; primary holds the OPPOSITE side -> composite key
        // (hold both). Primary holds the SAME side already (any engine) -> don't stack, skip.
        const key = primary ? (sameSide(primary) ? null : compKey) : sig.condition_id;
        if (!key || positions[key]) continue;
        // BUY-ONCE-EVER: a (market, side) we already opened once is never re-opened — kills the
        // salvage->cooldown->re-buy loop that shoveled $148 into one dying candle side.
        const seenKey = `${sig.condition_id}#${sig.token_id}`;
        if (seen[seenKey]) continue;
        if (copyExposure(positions) + target > exposureCap) continue;   // copytrade never exceeds its slice
        // NEW ENTRY: hard 92c cap + 10c floor (owner + blowup forensics).
        // PAIR LEG (is_pair): the whale holds BOTH sides — we mirror both, so this leg is half of a
        // hedge, not a directional bet. The 92c cap and 10c floor DON'T apply: a 96c/3c pair is a good
        // arb, and refusing the 96c half would leave us naked on the 3c half. The server has already
        // verified both legs together cost less than the $1 redemption; its max_entry_cents is the cap.
        const cap = sig.is_pair
          ? Math.min(99, Number(sig.max_entry_cents) || 99)
          : Math.min(MAX_ENTRY_CENTS, Number(sig.max_entry_cents) || MAX_ENTRY_CENTS);
        const floor = sig.is_pair ? 1 : MIN_ENTRY_CENTS;
        const px = await priceFor(sig.token_id, cap, floor);
        if (px == null) continue;
        const ok = await buy(sig, Math.min(target, state.cash ?? 0), px, "open", positions, null, key);
        if (ok) { openCopy++; buyTimes.push(Date.now()); seen[seenKey] = Date.now(); saveSeen(seen); }
      }
    }
  }

  // REAL-TIME TRIGGER. Watches the whales' ERC-1155 balances on Polygon and opens within ~1s of their
  // fill, instead of ~6 minutes later via Polymarket's activity indexer. Off with COPY_CHAINWATCH=0.
  if (process.env.COPY_CHAINWATCH !== "0") {
    import("./chainwatch.mjs")
      .then(({ startChainWatch }) => startChainWatch({
        cosmos,
        isArmed: () => alive && state.copytrade !== false,
        onSignal: (sig) => fastOpen(sig),
      }))
      .catch((e) => warn("chainwatch failed to start:", e?.message));
  }

  (async function run() {
    log(`copytrade: engine ON · unit=${UNIT_FRACTION}x dashboard size · exposure≤${MAX_EXPOSURE_PCT}% · ${MIN_ENTRY_CENTS}-${MAX_ENTRY_CENTS}c entries · ≤${MAX_BUYS_PER_HOUR} buys/h · max ${MAX_OPEN} open · buy-once · poll ${POLL_MS}ms${DRY ? " · DRY RUN" : ""}`);
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
