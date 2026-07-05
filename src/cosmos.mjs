// Cosmos API client: settings + signal feed + the exit brain + the metering relay.
export function makeCosmos(config) {
  const base = config.cosmosApi.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${config.cosmosToken}`, "Content-Type": "application/json" };

  async function getJSON(path) {
    const res = await fetch(`${base}${path}`, { headers });
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

    // The strategy-owned exit verdict for an in-play SPORTS position (source "sports"). The user's
    // TP/SL settings don't apply to these - the server runs the fixed strategy exits (50% at
    // entry*1.6, full salvage at minute 85+ when not winning, rest to resolution).
    async sportsExit(pos, curCents) {
      const q = new URLSearchParams({
        cid: pos.condition_id,
        cur: String(curCents ?? 0),
        entry: String(pos.entry_cents ?? 0),
        half: pos.half_sold ? "1" : "0",
      });
      return getJSON(`/api/v1/sports-exit?${q}`); // { action, reason }
    },

    // Report a placed order to Cosmos: records the $0.09 fee and returns whether the daily
    // spend limit has been reached (paused). The order itself is posted directly to Polymarket
    // by the bot — Cosmos never touches keys or funds.
    async meter(meta) {
      try {
        const res = await fetch(`${base}/api/v1/orders`, { method: "POST", headers, body: JSON.stringify({ meta }) });
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
        await fetch(`${base}/api/v1/bot-health`, { method: "POST", headers, body: JSON.stringify(health) });
      } catch { /* observability only - ignore */ }
    },
  };
}
