// VERSIONED ROSTER - the child's pre-filter guard, pure (owner 2026-08-30). Used only when
// COSMOS_ROSTER_MODE=versioned (after the ROSTER-CLEAN proof). The local roster is a cheap
// pre-filter with proven freshness; it is never the authorization boundary (the reservation is).
export const ROSTER_MAX_STALE_MS = Number(process.env.COSMOS_ROSTER_MAX_STALE_MS) || 15 * 60_000;

/**
 * rosterGuard(versioned, now) -> { armed, reason, follows(wallet) }
 *   versioned = { list, version, epoch, at, receivedAt } pushed by the runner, or null
 *   armed=false disarms BUY entries only (exits are never gated here); it is always a visible metric.
 */
export function rosterGuard(versioned, now = Date.now(), maxStaleMs = ROSTER_MAX_STALE_MS) {
  if (!versioned || !Array.isArray(versioned.list)) return { armed: false, reason: "no versioned roster", follows: () => false };
  const age = now - (Number(versioned.receivedAt) || Number(versioned.at) || 0);
  if (!(age >= 0) || age > maxStaleMs) return { armed: false, reason: `roster stale ${Math.round(age / 1000)} s (version ${versioned.version})`, follows: () => false };
  const set = new Set(versioned.list.map((w) => String(w).toLowerCase()));
  return { armed: true, reason: `version ${versioned.version}`, follows: (w) => set.has(String(w || "").toLowerCase()) };
}
