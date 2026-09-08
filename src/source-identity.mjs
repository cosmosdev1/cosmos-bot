// WHALE FILL SOURCE IDENTITY (owner 2026-09-08). Pure helpers, no I/O.
//
// The whale fill that causes a tier crossing is the source event, keyed (whale, asset, tx): one whale ORDER can match
// several makers (several logs, one tx) - that is one decision, one id. The fast path carries the tx in chainwatch's
// fill id (txHash#logIndex#item); the poll path reads the fills the server sweep stamps on the row (wallets[0].fills).
// A top-up is executed AT MOST ONCE per source id across both paths: the position remembers the ids it acted on.
// A row without stamped fills yields no true identity; the caller records that as an aggregated ("agg") event for the
// ledger only - it is never a canonical tier-crossing proof.
export function sourceId({ path, whale, token, fillId, hisShares }) {
  const w = String(whale || "").toLowerCase(), t = String(token || "");
  if (!w || !t) return null;
  if (path === "fast" && fillId) return `f:${w}:${t}:${String(fillId).split("#")[0].toLowerCase()}`;
  const s = Number(hisShares);
  if (!Number.isFinite(s) || s <= 0) return null;
  return `p:${w}:${t}:${s.toFixed(2)}`;
}

/** Ids of the fills stamped on the row, oldest first; null when the row carries none. */
export function fillIdsOnRow(sig) {
  const w = String(sig?.wallets?.[0]?.wallet || "").toLowerCase(), t = String(sig?.token_id || "");
  const fills = Array.isArray(sig?.wallets?.[0]?.fills) ? sig.wallets[0].fills : null;
  if (!w || !t || !fills) return null;
  return fills.map((f) => String(f?.tx || "").toLowerCase()).filter(Boolean).reverse().map((tx) => `f:${w}:${t}:${tx}`);
}

/** The newest stamped fill id on the row (the fill that most recently changed his position), or null. */
export function newestFillIdOnRow(sig) { const ids = fillIdsOnRow(sig); return ids && ids.length ? ids[ids.length - 1] : null; }

export function rememberSource(pos, id, max = 50) {
  if (!pos || !id) return;
  pos.src = pos.src || {};
  pos.src[String(id)] = Date.now();
  const keys = Object.keys(pos.src);
  if (keys.length > max) for (const k of keys.slice(0, keys.length - max)) delete pos.src[k];
}

export function seenSource(pos, id) { return Boolean(id && pos && pos.src && pos.src[String(id)]); }
