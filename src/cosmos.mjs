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

    // Post the locally-signed order DIRECTLY to Polymarket (uses YOUR IP/region, so it is not
    // geoblocked the way a server relay would be), then meter $0.09 through Cosmos. The order
    // fully succeeds or fails at Polymarket; metering only records orders that were placed.
    // Returns status 402 once the daily spend limit is reached (so the bot pauses entries).
    async relayOrder({ clob, meta }) {
      let pmRes, pmBody;
      try {
        pmRes = await fetch(`https://clob.polymarket.com${clob.path}`, {
          method: clob.method || "POST",
          headers: { "Content-Type": "application/json", ...(clob.headers || {}) },
          body: clob.body != null ? JSON.stringify(clob.body) : undefined,
        });
        pmBody = await pmRes.json().catch(() => ({}));
      } catch (e) {
        return { ok: false, status: 502, body: { error: `Could not reach Polymarket: ${e.message}` } };
      }
      if (!pmRes.ok) return { ok: false, status: pmRes.status, body: { polymarket: pmBody } };

      // Placed — record the fee + read the daily-limit status (best-effort; the order stands).
      let meter = {};
      try {
        const m = await fetch(`${base}/api/v1/orders`, { method: "POST", headers, body: JSON.stringify({ meta }) });
        meter = await m.json().catch(() => ({}));
      } catch {
        /* order already placed; metering catches up on the next order */
      }
      return { ok: true, status: meter.paused ? 402 : 200, body: { polymarket: pmBody, ...meter } };
    },
  };
}
