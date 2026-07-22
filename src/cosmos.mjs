// Cosmos API client: settings + signal feed + the exit brain + the metering relay.
export function makeCosmos(config) {
  const base = config.cosmosApi.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${config.cosmosToken}`, "Content-Type": "application/json" };

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
      return getJSON(`/api/v1/copy-exit?${q}`); // { action, fraction?, seq?, reason }
    },

    // Report a copy fill (BUY on entry/scale-in, SELL on a mirror step) to the per-user admin ledger.
    // Fire-and-forget: never blocks or breaks the copy loop.
    async copyReport(trade) {
      try { await fetch(`${base}/api/v1/copy-trade`, { method: "POST", headers, signal: AbortSignal.timeout(8_000), body: JSON.stringify({ trade }) }); } catch { /* observability only */ }
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
