// Cosmos API client: settings + signal feed + the exit brain + the metering relay.
export function makeCosmos(config) {
  const base = config.cosmosApi.replace(/\/$/, "");
  // DUAL-RUN GUARD (platform lib/cloud/dual-run.ts). Once an account moves to Cosmos Cloud, the
  // signal feeds refuse any caller that does NOT declare itself the hosted bot — otherwise a
  // forgotten legacy bot keeps trading the SAME wallet alongside it: doubled entries, exits
  // fighting each other, and twice the intended exposure. Declaring the mode here is what lets the
  // server tell the two apart; a legacy deployment predates this header and is correctly refused.
  const headers = {
    Authorization: `Bearer ${config.cosmosToken}`,
    "Content-Type": "application/json",
    ...((process.env.COSMOS_SIGNER || "local").toLowerCase() === "remote"
      ? { "x-cosmos-signer": "remote" }
      : {}),
  };

  async function getJSON(path) {
    // HARD TIMEOUT (2026-07-22). Node fetch has NO default timeout: a half-open connection makes the
    // await hang FOREVER - it neither resolves nor rejects, so try/catch cannot save the caller. This
    // froze qtable2's tick() fleet-wide for 12.5h (meter() hung right after a fill; every restart
    // "fixed" it for one burst). Every network call in this file now carries an abort signal.
    const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `GET ${path} -> ${res.status}`);
    return d;
  }

  return {
    // Your plan + bot settings (filters + execution rules).
    account: () => getJSON("/api/v1/account"),
    // The pre-filtered feed (already limited to your plan + settings).
    signals: () => getJSON("/api/v1/signals"),

    // Every CLOB token id this user's bot has ever BOUGHT (from Cosmos's order records) - used to
    // re-adopt wallet holdings the bot lost track of. Never includes manual (non-bot) buys.
    botMarkets: () => getJSON("/api/v1/bot-markets"), // { tokens: string[] }

    // The Cosmos AI exit verdict for one open position.
    async advice(pos) {
      const res = await fetch(`${base}/api/v1/positions/advice`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(15_000), // exits protect open money - a hung advice call must fail into the HOLD fallback, not freeze the loop
        body: JSON.stringify({
          condition_id: pos.condition_id,
          outcome: pos.outcome,
          entry_cents: pos.entry_cents,
          whales: pos.entry_whales || [],
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `advice -> ${res.status}`);
      return d; // { action, reason, current_cents, pnl_pct, whale_exit_pct }
    },

    // BATCH exit verdicts: ALL open positions in ONE POST -> Map(condition_id -> verdict). Replaces the
    // per-position fan-out that 429'd the shared per-token rate limiter (and a 429 force-sold at -50%).
    async adviceBatch(positions) {
      if (!positions || !positions.length) return new Map();
      const res = await fetch(`${base}/api/v1/positions/advice`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(20_000), // batch exit advice: same rule - time out into fail-safe HOLD
        body: JSON.stringify({
          positions: positions.map((p) => ({
            condition_id: p.condition_id, outcome: p.outcome, entry_cents: p.entry_cents, whales: p.entry_whales || [],
          })),
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `advice-batch -> ${res.status}`);
      const map = new Map();
      for (const v of d.verdicts || []) if (v && v.condition_id) map.set(v.condition_id, v);
      return map;
    },

    // The strategy-owned exit verdict for an in-play SPORTS position (source "sports"). The user's
    // TP/SL settings don't apply to these - the server runs the fixed strategy exit: sell 60% once
    // the live price reaches 85c (SELL_PARTIAL), hold the remaining 40% to resolution. `partial`
    // tells the server the 60% chunk has already been banked so it isn't fired twice.
    async sportsExit(pos, curCents) {
      const q = new URLSearchParams({
        cid: pos.condition_id,
        cur: String(curCents ?? 0),
        entry: String(pos.entry_cents ?? 0),
        partial: pos.partial_sold ? "1" : "0",
      });
      return getJSON(`/api/v1/sports-exit?${q}`); // { action, fraction?, reason }
    },

    // Mirror-exit verdict for a TOP5 copy: when the copied wallet sold >10% of his shares, the
    // server returns SELL_PARTIAL with the same fraction (+ a seq so each step executes once).
    async top5Exit(pos) {
      const q = new URLSearchParams({
        cid: pos.condition_id,
        outcome: String(pos.outcome ?? ""),
        seq: String(pos.top5_seq ?? 0),
      });
      return getJSON(`/api/v1/top5-exit?${q}`); // { action, fraction?, seq?, reason }
    },

    // Model re-price for a HELD quant (crypto) position (source "quant"). The server reprices the
    // position with the SAME model that drove entry and returns { ok, modelP, tauMin }. The
    // model-stop RULE (thresholds, shadow/live) lives in the bot; this just fetches the fresh modelP.
    // Returns null on any error so the caller simply holds (never force-sells on a server hiccup).
    async quantExit(pos) {
      try {
        const s = new URLSearchParams({
          q: pos.market_question ?? "",
          end: pos.end_date ?? "",
          side: pos.outcome ?? "",
        });
        const res = await fetch(`${base}/api/v1/quant-exit?${s}`, { headers, signal: AbortSignal.timeout(10_000) });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) return null;
        return d; // { ok, modelP, tauMin, asset, strike, family }
      } catch {
        return null;
      }
    },

    // The active whale-copy signals (source "copytrade"). Whale-side numbers only — the bot applies the
    // per-user ratio locally. Separate from the main feed because copy sizing isn't the standard % sizing.
    copySignals: () => getJSON("/api/v1/copy-signals"), // { count, signals: [{ condition_id, token_id, outcome, category, wallets:[{wallet,cost_usd,avg_trade_usd}], his_cost_usd, entry_cents, max_entry_cents, sell_seq, end_date }] }

    // THE FAST PATH (chainwatch). The whale roster to subscribe to on-chain, and the per-fill verdict.
    // copyCheck is called the instant a whale's ERC-1155 balance grows — the server applies EVERY rule
    // (new-only, category lock, runway, pair cost, entry band) and upserts the signal. ~200ms.
    copyWallets: () => getJSON("/api/v1/copy-wallets"), // { wallets: [{ wallet, username, category }] }
    async copyCheck({ wallet, token_id, shares }) {
      const r = await fetch(`${base}/api/v1/copy-check`, { method: "POST", headers, signal: AbortSignal.timeout(8_000), body: JSON.stringify({ wallet, token_id, shares }) });
      return r.json(); // { ok: true, signal } | { ok: false, reason }
    },

    // Mirror-exit verdict for a COPYTRADE position: when the driving whale cut >=10% below his peak
    // shares, the server returns SELL_PARTIAL with that fraction (of our original) + a seq (once per step).
    async copyExit(pos) {
      const q = new URLSearchParams({ cid: pos.condition_id, outcome: String(pos.outcome ?? ""), seq: String(pos.copy_seq ?? 0) });
      // ONE-SHOT (hosted): ask for the two-step exit (half out at -50% from his peak, the rest when he
      // is gone) instead of the 10-step ladder, which costs ~10 signatures per position. Self-hosted
      // bots leave COSMOS_ONESHOT unset and never send this, so their behaviour is unchanged.
      if (/^(1|true|yes|on)$/i.test(process.env.COSMOS_ONESHOT || "")) q.set("mode", "oneshot");
      return getJSON(`/api/v1/copy-exit?${q}`); // { action, fraction?, of?, seq?, reason }
    },

    // Report a copy fill (BUY on entry/scale-in, SELL on a mirror step) to the per-user admin ledger.
    // RETRIES x3 (ledger audit 2026-08-05): fire-and-forget with a swallowed catch silently lost
    // ~28 positions' rows (~$467) through the OOM/outage windows - the ledger, the PnL backfill and
    // the admin report all under-counted, and a dropped row is invisible forever. Still async at
    // every call site so the trading loop never blocks on it; a final drop is now LOGGED, not silent.
    async copyReport(trade) {
      for (let i = 0; i < 3; i++) {
        try {
          const r = await fetch(`${base}/api/v1/copy-trade`, { method: "POST", headers, signal: AbortSignal.timeout(8_000), body: JSON.stringify({ trade }) });
          if (r.ok) return;
        } catch { /* retry below */ }
        if (i < 2) await new Promise((res) => setTimeout(res, 1_500 * (i + 1)));
      }
      console.error(`[copy-report] DROPPED after 3 tries: ${trade.action} ${trade.outcome} $${trade.size_usd} · ${String(trade.market_question || "").slice(0, 40)}`);
    },

    // Report a placed order to Cosmos: records the $0.09 fee and returns whether the daily
    // spend limit has been reached (paused). The order itself is posted directly to Polymarket
    // by the bot — Cosmos never touches keys or funds.
    async meter(meta) {
      try {
        const res = await fetch(`${base}/api/v1/orders`, { method: "POST", headers, signal: AbortSignal.timeout(8_000), body: JSON.stringify({ meta }) });
        const d = await res.json().catch(() => ({}));
        return { ok: res.ok, paused: Boolean(d.paused), spent_today: d.spent_today, daily_limit: d.daily_limit };
      } catch {
        return { ok: false, paused: false };
      }
    },

    // Report the bot's live sizing basis (cash/deployed/portfolio + config) so the admin can SEE why
    // orders are sized as they are. Fire-and-forget: never blocks or breaks a cycle.
    async reportHealth(health) {
      try {
        await fetch(`${base}/api/v1/bot-health`, { method: "POST", headers, signal: AbortSignal.timeout(8_000), body: JSON.stringify(health) });
      } catch { /* observability only - ignore */ }
    },
  };
}
