// HIGH-CAPTURE V1 - the post-tier/window gate profile (owner 2026-09-06).
//
// THE RULE: AUTHORIZED + TIER-POSITIVE + INSIDE THE CONFIGURED ENTRY WINDOW = ATTEMPT THE COPY. After
// tier and window, only a genuine hard constraint may stop an order attempt: cash below the smallest
// legal order, a position/condition/portfolio risk cap, invalid authority, a user or safety halt, a
// market the venue no longer accepts, duplicate/re-entry protection for a position we hold, or a
// mechanically impossible order. Everything else that used to sit between window and attempt was
// an OLD STRATEGY FILTER, and this profile switches those - exactly those - off for a user the server
// marks high_capture. It is per user and server-delivered; the global path is unchanged.
//
// Measured before this (tools/cloud/_post-tier-gates.mjs, traced cohort, 3 days): 611 tier-positive
// in-window opportunities, 349 attempted = 57%. Of the misses that were not cash: the hub shortcut,
// the 92c legacy cap leaking into v2 through Math.min(97, 92), the ±20% gate vs his average entry,
// and the 10c floor.
//
// WHAT IS NOT HERE, ON PURPOSE. The profile has no key for the entry floor, the cash check, the $2
// sizing floor, the per-position ceiling, cooldown / in-flight / already-holding / buy-once, the
// no-rebuy rule, the server risk gate or any exit. They cannot be switched by this profile, and
// tools/_test-high-capture.mjs asserts that the source never guards them with it.

/**
 * @param {boolean} hc            settings.high_capture === true for this user
 * @param {number}  v2MaxCents    the owner's v2 entry ceiling (COPY_V2_MAX_ENTRY_CENTS, 97)
 * @returns {{ priceBand: boolean, priceGate: boolean, rateLimit: boolean, driverMatch: boolean, venueBackoff: boolean, entryCap: number, entryFloor: number }}
 */
export function gateProfile(hc, v2MaxCents = 97) {
  const cap = Number.isFinite(Number(v2MaxCents)) && Number(v2MaxCents) > 0 ? Math.min(99, Number(v2MaxCents)) : 97;
  if (hc === true) {
    return Object.freeze({
      priceBand: false,      // 92c legacy cap / in-play ±20c band / per-signal server cap: strategy
      priceGate: false,      // ±20% vs his average entry: strategy
      rateLimit: false,      // 30 buys/h: strategy (the server's hourly budget is the hard cap)
      driverMatch: false,    // top-up must be driven by the whale we entered with: strategy (7% market cap bounds it)
      venueBackoff: false,   // 5-min entry pause after 3 unfilled FAKs: strategy
      entryCap: cap,         // the owner's v2 ceiling; at 99c the hard take-profit sells it straight back
      entryFloor: 1,         // the venue's 1c tick - below it no order exists
    });
  }
  return Object.freeze({ priceBand: true, priceGate: true, rateLimit: true, driverMatch: true, venueBackoff: true, entryCap: cap, entryFloor: 1 });
}
