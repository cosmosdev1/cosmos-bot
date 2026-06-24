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

    // Route a locally-signed Polymarket order through the relay (it meters $0.09 + enforces the
    // daily limit, then forwards to Polymarket). status 402 = daily limit reached.
    async relayOrder({ clob, meta }) {
      const res = await fetch(`${base}/api/v1/orders`, { method: "POST", headers, body: JSON.stringify({ clob, meta }) });
      const d = await res.json().catch(() => ({}));
      return { ok: res.ok && d.ok !== false, status: res.status, body: d };
    },
  };
}
