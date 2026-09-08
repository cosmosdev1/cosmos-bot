// DISTINCT-ADD SEMANTICS (owner 2026-09-07). Pure helpers, no I/O, no state of their own.
//
// THE RULE: every distinct, authorized whale BUY/ADD that happens while the trade is Tier-positive and
// inside Window is a SEPARATE copy opportunity. Tier is a selection/sizing state, not a gate that the
// whale must cross again before his next ADD becomes copyable. Each source event terminates on its own
// as a HARD refusal or an ORDER ATTEMPT. A re-observed copy of the SAME whale fill is not a new event.
//
// SOURCE-EVENT IDENTITY
//   fast path : the whale's on-chain fill, txHash#logIndex#item (chainwatch mints it; unique per fill)
//   poll path : the whale's cumulative share count on the signal row after the server sweep refreshed
//               it. A distinct ADD raises that count; polling the unchanged row repeats the same id.
//               Fills that land between two sweeps merge into one poll id - that is the poll path's
//               resolution, and the fast path already saw them one by one.
//
// DEDUP LIVES ON THE POSITION (persisted store): `src` = ids already evaluated (bounded), `src_hi` =
// the highest whale share count already accounted for. A position opened before this rule has no
// watermark: it is initialised to the CURRENT count and no retroactive add is produced.

/** Build the source-event id, or null when the inputs cannot identify one. */
export function sourceId({ path, whale, token, fillId, hisShares }) {
  const w = String(whale || "").toLowerCase(), t = String(token || "");
  if (!w || !t) return null;
  if (path === "fast" && fillId) return `f:${w}:${t}:${String(fillId)}`;
  const s = Number(hisShares);
  if (!Number.isFinite(s) || s <= 0) return null;
  return `p:${w}:${t}:${s.toFixed(2)}`;
}

/** The server sweep's own "same shares" tolerance: below it the row is not considered changed. */
export const POLL_SHARES_TOL = 0.5;

/** true when the row's cumulative whale shares exceed what the position already accounted for. */
export function isNewPollAdd(hisShares, watermark) {
  if (watermark == null) return false;                       // no watermark yet: seed it first, never a retroactive add
  const s = Number(hisShares), w = Number(watermark);
  if (!Number.isFinite(s) || s <= 0 || !Number.isFinite(w)) return false;
  return s > w + POLL_SHARES_TOL;
}

/**
 * Size ONE distinct add: the tier size for this trade, clipped to the room left under the per-position
 * ceiling, never below the $2 sizing floor. No room for a floor-sized order = position_ceiling (HARD_RISK).
 */
export function addSize({ tierUsd, held, posCeil, floorUsd }) {
  const room = Math.max(0, (Number(posCeil) || 0) - (Number(held) || 0));
  const floor = Number(floorUsd) || 0;
  if (room < floor || !(room > 0)) return { add: 0, why: "position_ceiling", room };
  const add = Math.max(floor, Math.min(Number(tierUsd) || 0, room));
  return { add, why: null, room };
}

/** Record a source id on the position and raise the whale-share watermark (bounded, in place). */
export function rememberSource(pos, id, hisShares, max = 50) {
  if (!pos) return;
  if (id) {
    pos.src = pos.src || {};
    pos.src[String(id)] = Date.now();
    const keys = Object.keys(pos.src);
    if (keys.length > max) for (const k of keys.slice(0, keys.length - max)) delete pos.src[k];
  }
  const s = Number(hisShares);
  if (Number.isFinite(s) && s >= 0) pos.src_hi = Math.max(Number(pos.src_hi) || 0, s);
}

export function seenSource(pos, id) {
  return Boolean(id && pos && pos.src && pos.src[String(id)]);
}
