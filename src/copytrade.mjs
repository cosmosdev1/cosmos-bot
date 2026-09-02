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
import * as s4authority from "./s4-authority.mjs";
import { floorGuardVerdict } from "./floor-guard.mjs";
import { targetPctForHolding } from "./candle-sizing.mjs";
// FIX (2026-08-03, first live fleet): oneShotTarget called pctFromAutoTiers and read TIER_MAX_PCT
// with NEITHER in scope - a ReferenceError on every non-candle one-shot copy, so the hosted fleet
// could only ever copy candle signals. Proven by executing the committed function in isolation.
import { pctFromAutoTiers, ONESHOT_CAP_PCT } from "./tier-sizing.mjs";
import { createTracer, STAGE, PROBE_TIMEOUT_MS } from "./opp-trace.mjs";
import { log, warn } from "./log.mjs";

const N = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };
const DRY = process.env.COPYTRADE_DRY === "1";
import { inc as mInc } from "./metrics.mjs";
import { withS4Attribution } from "./remote-signer.mjs";
const POLL_MS = N("COPY_POLL_MS", 20_000);
// How often the POLLED feed may actually be re-fetched (the cycle itself still runs every POLL_MS
// so cash/sizing stay fresh for chainwatch). Matches the server's 45s feed cache.
const FEED_MIN_MS = N("COPY_FEED_MIN_MS", 45_000);
let lastFeed = null, lastFeedAt = 0;
const MAX_OPEN = N("COPY_MAX_OPEN", Infinity);    // owner 2026-07-15: NO position-count cap at all. The 20%% exposure cap (dust-free) is the only guard now. Set COPY_MAX_OPEN to re-impose a count limit.
const MIN_ORDER_USD = N("COPY_MIN_USD", 1);       // Polymarket ~$1 min order = "the first beat"
const MIN_ADD_USD = N("COPY_MIN_ADD_USD", 1);     // smallest scale-in increment worth an order
const COOLDOWN_MS = N("COPY_COOLDOWN_MS", 60_000); // per-market: don't re-buy within the on-chain settle window
// Owner 2026-07-13: never OPEN a new copy above 92c (95c risks 95c to win 5c). But once we're IN, if the
// whale keeps adding we follow him up — scale-ins are capped only by the sanity ceiling.
const MAX_ENTRY_CENTS = N("COPY_MAX_ENTRY_CENTS", 92); // new positions
const MAX_ADD_CENTS = N("COPY_MAX_ADD_CENTS", 97);     // scaling into a position we already hold
// v2 entry ceiling: 99c TP minus 0.9%/leg fees leaves no room above this (owner 2026-08-20).
const V2_MAX_ENTRY_CENTS = N("COPY_V2_MAX_ENTRY_CENTS", 97);
// How long to wait before re-asking a question the gate already answered deterministically.
const DENY_COOLDOWN_MS = N("COPY_DENY_COOLDOWN_MS", 120_000);   // wait before re-asking a deterministic denial
// VENUE-LEVEL BACKOFF. Tracks which distinct markets have answered "not matching" recently; enough
// of them at once means the exchange, not the markets.
const venueRefusals = new Map();                                   // cid -> when it refused
let venueBackoffUntil = 0;
const VENUE_WINDOW_MS = N("COPY_VENUE_WINDOW_MS", 5 * 60_000);
const VENUE_MIN_MARKETS = N("COPY_VENUE_MIN_MARKETS", 3);
const VENUE_BACKOFF_MS = N("COPY_VENUE_BACKOFF_MS", 5 * 60_000);

// A venue that will not match is a different kind of "no" than a book that moved - it stays no for
// minutes at least. Ten, not twenty: the cooldown is also what delays our RECOVERY, and during the
// 2026-08-26 outage a twenty-minute wait would have kept us out of markets for a third of an hour
// after Polymarket came back. Ten still cuts the wasted signature attempts by more than half while
// putting us back in the book within one bot cycle of the venue returning.
const PREOPEN_COOLDOWN_MS = N("COPY_PREOPEN_COOLDOWN_MS", 10 * 60_000);
// Crypto cash reserve, in percent. 0 disables it (owner 2026-08-26).
const RESERVE_PCT = N("COPY_V2_RESERVE_PCT", 0);
const RESERVE_AFTER_PCT = N("COPY_V2_RESERVE_AFTER_PCT", 0);
// ADD CEILING for scan-adopted signals (owner model 2026-07-22): an add must respect the same
// ±20c-of-his-entry band as the open. Tier restamps arrive with no price check server-side, so
// without this a whale growing his position while the price ran to 90c would have every bot
// topping up at up to the flat 97c add cap - precisely the chase the band exists to prevent.
const addCapFor = (sig) => {
  const hisC = Number(sig.his_entry_cents);
  return sig.kind === "adopt" && Number.isFinite(hisC) && hisC > 0 ? Math.min(MAX_ADD_CENTS, hisC + 20) : MAX_ADD_CENTS;
};
// ---- POST-BLOWUP GUARDS (2026-07-13 forensics; each one maps to a proven loss channel) ----
const MIN_ENTRY_CENTS = N("COPY_MIN_ENTRY_CENTS", 10); // no penny legs: 1c spread at 3c = 33%/round-trip
const MIN_ADD_CENTS = N("COPY_MIN_ADD_CENTS_FLOOR", 5);
// copytrade may hold at most this % of the portfolio in cost basis — the blowup deployed 100% (cash $0.54)
const MAX_EXPOSURE_PCT = N("COPY_MAX_EXPOSURE_PCT", 20);
// PER-POSITION CEILING (2026-07-22, owner incident). The total-exposure cap alone let ONE market
// balloon to 25x its tier target and ~32% of a portfolio when the scale-in kept adding (owner held
// $13.76 + $11.04 in two esports handicaps = 46% of a $54 account against a 1% tier). No single copy
// market may exceed this % of the portfolio, full stop — a hard ceiling above the tier bands (max 4%)
// that catches beats over-sizing, a stale high tier restamp, and any accumulation bug at once.
const MAX_POSITION_PCT = N("COPY_MAX_POSITION_PCT", 5);
// fleet churned 4.4 buys/min for 3h; a real directional copy has no business firing faster than this
const MAX_BUYS_PER_HOUR = N("COPY_MAX_BUYS_PER_HOUR", 30);  // 12 saturated in minutes on a 10-wallet candle roster (deep-check #9); 30 is still ~9x under the blowup churn
// owner: "smaller amount per trade" — the copy unit is this fraction of the dashboard per-trade size,
// and the ceiling premium (+1pt) shrinks with it
const UNIT_FRACTION = N("COPY_UNIT_FRACTION", 0.5);
// ADOPT sizing (owner 2026-07-14): a position he opened weeks ago is sized FLAT at 1% of the portfolio,
// not by the beats. The beats measure how far into a NEW position he is; that says nothing about one he
// has been sitting in — there is no "20% of his average" to read off it.
const ADOPT_PCT = N("COPY_ADOPT_PCT", 1);
// RETRY BOUND (owner 2026-07-19, "retry on failure — never miss an event"). A failed sports buy
// retries on every pass (the failed-FAK 5s breather + the 20s poll re-serving the signal), which is
// the never-miss half; THIS is the bound: only while the pre-game window is still open. Polymarket
// sets a game market's endDate to KICKOFF, so "minutes to end_date" IS "minutes to kickoff" for
// timed games (futures carry a resolution date days out and pass trivially). Under the bound the
// entry is abandoned — the shopping window is 10-30min pre-kickoff, and a fill chased inside the
// last 10 minutes buys a live-game line, not the pre-game book. Applies to sports opens AND adds.
const SPORTS_MIN_LEFT_MIN = N("COPY_SPORTS_MIN_LEFT_MIN", 10);
function sportsWindowClosed(sig) {
  if (String(sig.category).toUpperCase() !== "SPORTS" || !sig.end_date) return false;
  const leftMin = (Date.parse(sig.end_date) - Date.now()) / 60_000;
  return Number.isFinite(leftMin) && leftMin < SPORTS_MIN_LEFT_MIN;
}
// IN-PLAY GAP BAND — hosted one-shot only (deep audit 2026-08-04). Sports markets carry endDate =
// KICKOFF, so a signal past its end_date is a LIVE game, not a corpse (the server refuses true
// corpses, and candles never reach here - the candle engine owns them). The old model refused all
// of it, which hid the whales' in-play conviction - the exact volume the median trigger exists to
// catch. One-shot buys in-play, but only within GAP cents of HIS average entry: past that, the
// line ran away from his book and we would be buying our price, not his edge.
const ONESHOT_GAP_C = N("COPY_ONESHOT_GAP_CENTS", 20);
function inPlayBand(sig, cap, floor) {
  if (!ONESHOT || isCandleSig(sig)) return { cap, floor };
  const end = Date.parse(String(sig.end_date ?? ""));
  if (!Number.isFinite(end) || end > Date.now()) return { cap, floor };   // pre-game: normal band
  const c = Number(sig.his_cost_usd), sh = Number(sig.his_shares);
  const hisAvgC = c > 0 && sh > 0 ? Math.round((c / sh) * 100) : Number(sig.his_entry_cents) || Number(sig.entry_cents) || 0;
  if (!(hisAvgC > 0)) return { cap, floor };
  return { cap: Math.min(cap, hisAvgC + ONESHOT_GAP_C), floor: Math.max(floor, hisAvgC - ONESHOT_GAP_C) };
}
// SPORTS adopt TIERS (owner 2026-07-15, swisstony): size by HIS money in the position, and SCALE IN as
// it grows — if he starts at $80k we hold 1%, when he grows to $125k we top up to 2%, etc.
//   < $30k: skip · $30-70k: 1% · $70-120k: 2% · $120-180k: 3% · $180k+: 4%   (percent OF the portfolio)
function sportsAdoptPct(hisUsd, who) {
  // hot2trot runs BIGGER positions (avg ~$82k), so his bands are wider (owner 2026-07-15):
  if (String(who || "").toLowerCase() === "hot2trot") {
    if (hisUsd >= 250000) return 4;
    if (hisUsd >= 160000) return 3;
    if (hisUsd >= 80000) return 2;
    if (hisUsd >= 30000) return 1;
    return 0;
  }
  if (hisUsd >= 180000) return 4;
  if (hisUsd >= 120000) return 3;
  if (hisUsd >= 70000) return 2;
  if (hisUsd >= 30000) return 1;
  return 0;                                    // below the floor -> not his conviction, don't copy
}

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

// ---------------------------------------------------------------------------------------------
// ONE-SHOT MODE (hosted/Turnkey accounts only — owner 2026-07-29).
//
// Hosted execution pays Turnkey PER SIGNATURE, so the 5-beat ladder in + 10-step ladder out (~8-15
// signatures per position) costs several times the 0.9% builder fee it earns. One-shot collapses a
// position to ONE buy and at most two sells.
//
// Because we can no longer follow him up, tier-based sizing cannot work: he typically opens in a low
// tier and stacks, so we would systematically under-size the best positions. Instead we wait until he
// reaches the 2% tier — a real commitment — and then take OUR standard risk, a flat % of OUR
// portfolio. His later stacking is deliberately ignored: we are already at our intended size.
//
// OFF by default: self-hosted bots keep the beat ladder byte-for-byte. Flip COSMOS_ONESHOT=1 (and
// flip it back once Turnkey Enterprise pricing makes per-signature cost negligible).
// ---------------------------------------------------------------------------------------------
const ONESHOT = /^(1|true|yes|on)$/i.test(process.env.COSMOS_ONESHOT || "");
// RELATIVE ENTRY GAP (owner 2026-08-06): never buy when our fill price sits more than 20% (relative)
// away from the whale's own average entry - "if we want to buy at 90c but the whale bought at 65c,
// it's too late". Applies to every one-shot entry, both directions; pair legs exempt (hedge mirror).
const COPY_GAP_REL = (() => { const v = Number(process.env.COPY_GAP_REL); return Number.isFinite(v) && v > 0 ? v : 0.20; })();
const hisAvgCents = (sig) => {
  const cost = Number(sig.his_cost_usd), sh = Number(sig.his_shares);
  if (!(cost > 0) || !(sh > 0)) return null;
  const c = (cost / sh) * 100;
  return Number.isFinite(c) && c >= 1 && c <= 99 ? c : null;
};
// QA 2026-08-06: this used to be handed priceFor()'s return value - the FAK CEILING (current+5c),
// not the price we pay - so the +5c inflation alone blew the 20% test on every cheap market: 27% of
// live signals were refused, and 15% were refused at the whale's OWN price (his avg 19c, market 20c
// -> "32% away"). Compare the executable mid, and floor the tolerance at 5c so spread/rounding on a
// single-digit-cent market can never trip a percentage rule.
// PAIR FIRST-LEG GATE (owner 2026-08-23, with the candle-whale wiring): a pair used to be FULLY
// exempt from the 20% band - but the exemption exists to protect the SECOND leg (refusing it
// leaves half a hedge naked), not to let the FIRST leg chase a market that already ran. Now the
// first leg of a pair is banded exactly like a non-crypto entry, and only a leg whose sibling we
// ALREADY HOLD stays exempt - completing the hedge is mandatory at any price.
const tooFarFromHisEntry = (sig, execCents, holdsSibling = false) => {
  if (sig.is_pair && holdsSibling) return false;
  const avg = hisAvgCents(sig);
  if (avg == null || !(execCents > 0)) return false;
  const tol = Math.max(avg * COPY_GAP_REL, 5);
  return Math.abs(execCents - avg) > tol;
};
// Do we hold the OTHER side of this signal's market? primary slot with a different outcome, or a
// complementary-key slot under the same condition with a different token.
const holdsPairSibling = (positions, sig) => {
  const prim = positions[sig.condition_id];
  if (prim && String(prim.outcome).toLowerCase() !== String(sig.outcome).toLowerCase()) return true;
  const ownComp = `${sig.condition_id}#${sig.token_id}`;
  return Object.keys(positions).some((k) => k.startsWith(sig.condition_id + "#") && k !== ownComp);
};

// ---- v2 ENTRY WINDOW (owner 2026-08-18) ----
// A NEW position may only open when the market resolves within V2_WINDOW_H hours.
//
// THE WINDOW IS ENFORCED HERE, IN THE BOT, ON PURPOSE. The server used to suppress the SIGNAL for
// far-off markets, but the sweep that would later release it re-scans a given whale only about
// every 2.5 hours (measured: ~18 of 153 wallets per pass, passes ~6 min apart) - so with a 4-hour
// window a market could cross the line and sit unnoticed for most of it. The bot re-reads the whole
// feed every ~20s, so checking here IS the owner's "scan the market all the time": a market at 5h
// is not rejected, it is simply not eligible YET, and the very next cycle after it crosses 4h it is
// re-tested against every other condition (price gate, tier, reserve, cash) and entered if they
// still hold. A skip never marks the signal consumed - `seen` is only written after a real buy.
//
// TOP-UPS ARE EXEMPT: we can only be holding because we entered INSIDE the window, and the market
// only moves closer to resolution from there.
const V2_WINDOW_MS = (() => { const v = Number(process.env.COPY_V2_MAX_RESOLUTION_H); return (Number.isFinite(v) && v > 0 ? v : 3) * 3600_000; })();   // owner 2026-08-26: 5h -> 3h (8h on 08-25, 4h on 08-20)
// FLOOR (owner 2026-08-19, tightened 1h -> 30min): never open with under half an hour left. The 4h gate deliberately pushes
// entries late, and the first dry run opened positions with SIX MINUTES to go - by then the price
// encodes the outcome, the thesis has no room to play out, and a 99c fill pays fees both ways for
// ~1c of upside. 30min still leaves the thesis room to play out while admitting the late-building
// positions a 1h floor was cutting off. Below the floor the signal is DEAD for entry, not waiting:
// it can only get later. The 20% price gate applies to these entries exactly as to any other.
// ENTRY WINDOW FLOOR 30min -> 15min (owner 2026-08-24). Must match the platform's
// V2_MIN_RESOLUTION_MS - the bot enforces the window, so a mismatch here silently reinstates the
// old floor for the whole fleet. The 8h ceiling and the 20% price gate are unchanged.
const BOOK_PROBE = !/^(0|false|no|off)$/i.test(String(process.env.COPY_TRACE_BOOK ?? "1"));
const V2_MIN_MS = (() => { const v = Number(process.env.COPY_V2_MIN_RESOLUTION_H); return (Number.isFinite(v) && v >= 0 ? v : 0.25) * 3600_000; })();
// `v2` is passed IN, never read from an outer scope: V2() is defined inside the tick (it depends on
// per-cycle server state), so referencing it from here threw "V2 is not defined" and aborted the
// whole copytrade pass - caught live in the fleet logs minutes after deploy. A module-level helper
// must not reach into function scope.
// THE WINDOW CLOCK (2026-08-19): wallets[0].event_at is the REAL event time, stamped by the server
// (gameStartTime when earlier than endDate). end_date lies for tennis - a tournament/session stamp
// shared by dozens of matches - so a window computed from it was fiction: 288 of 310 apparent
// pass-throughs in one 24h audit were phantom. event_at when present, end_date as the fallback;
// missing both -> other gates decide, never guess.
// SPORTS / ESPORTS CLOCK EXTENSION (2026-09-02). Live-flagged: the server delivers clock_v2 every
// cycle (bot.mjs -> state.clockV2), so it switches fleet-wide within a cycle with no restart. Env is
// the dev override. Measured before building it: 152 window_dead opportunities per healthy account-day,
// all fresh whale fills, median 1.4-1.6h after kickoff. The extension moves only the CLOCK; every
// other gate - the 20% price gate above all - still applies to the in-play price.
const CLOCK_SPORTS_H = (() => { const v = Number(process.env.COPY_CLOCK_SPORTS_H); return Number.isFinite(v) && v >= 0 ? v : 2; })();
const CLOCK_ESPORTS_H = (() => { const v = Number(process.env.COPY_CLOCK_ESPORTS_H); return Number.isFinite(v) && v >= 0 ? v : 4; })();
const ESPORTS_RE = /counter-strike|league of legends|\bcs2\b|\bcs:?go\b|dota|valorant|esports?|\bmap \d|overwatch|rocket league|\blol\b|\bbo[35]\b/i;
const SPORTS_RE = /\bvs\.?\b|o\/u|over\/under|spread:|moneyline|handicap|1st half|2nd half|clean sheet|exact score|to win|\bwin on \d{4}-\d{2}-\d{2}\b|\bFC\b/i;
/** which extension applies: "esports" | "sports" | null. Feed category first, question text second. */
const clockClass = (sig) => {
  const q = String(sig?.market_question ?? "");
  if (ESPORTS_RE.test(q)) return "esports";
  if (String(sig?.category ?? "").toUpperCase() === "SPORTS" || SPORTS_RE.test(q)) return "sports";
  return null;
};
let clockV2On = () => false;   // rebound by startCopyTrade to the live server flag
const clockExtMs = (sig) => {
  if (!clockV2On()) return 0;
  const c = clockClass(sig);
  return c === "esports" ? CLOCK_ESPORTS_H * 3600_000 : c === "sports" ? CLOCK_SPORTS_H * 3600_000 : 0;
};
const v2ClockMs = (sig) => {
  const ev = Date.parse(String(sig?.wallets?.[0]?.event_at ?? ""));
  if (Number.isFinite(ev)) return ev + clockExtMs(sig);
  const end = Date.parse(String(sig?.end_date ?? ""));
  return Number.isFinite(end) ? end + clockExtMs(sig) : NaN;
};
const outsideV2Window = (sig, v2) => {
  if (!v2) return false;
  // CRYPTO HAS NO TIME FRAME (owner ruling 2026-08-23): candles are exempt from the 30min-8h
  // window entirely - both ends. This also resolves the long-pending 15m question: the 30-min
  // floor structurally banned every 15m candle (0 of 350 measured); with the exemption they trade.
  // A candle rides the chainwatch fast path and lives minutes-to-an-hour - the window was designed
  // for event markets and never fit them.
  if (isCandleSig(sig)) return false;
  const end = v2ClockMs(sig);
  if (!Number.isFinite(end)) return false;          // unknown event time -> other gates decide, never guess
  const left = end - Date.now();
  return left > V2_WINDOW_MS || left < V2_MIN_MS;   // too early to enter, or too late to bother
};
/** Distinguishes the two for logging: "not yet" retries, "too late" never will. */
const tooLateV2 = (sig, v2) => {
  if (!v2 || isCandleSig(sig)) return false;
  const end = v2ClockMs(sig);
  return Number.isFinite(end) && (end - Date.now()) < V2_MIN_MS;
};
const hoursLeft = (sig) => ((v2ClockMs(sig) - Date.now()) / 3600_000);

// ---- SIGNAL HUB (scale build 2026-08-20) ----
// The runner evaluates the objectively-enterable set ONCE for the whole box and broadcasts it here,
// instead of every child fetching and re-deriving the same thing (measured: 1,551 duplicate
// evaluations per real order). What arrives is only the objective half - window, tier, price band.
// Everything user-specific is still decided below, in THIS process: whether we follow the whale,
// our cash and budgets, buy-once, concentration, and the signature itself.
//
// SILENCE MEANS FALL BACK, NEVER "NOTHING TO TRADE". If the hub stops speaking we resume our own
// /copy-signals fetch. An empty broadcast is a real answer and keeps the clock fresh; no broadcast
// at all is a failure and must not read as an empty market.
const HUB_SIGNALS_SILENCE_MS = Number(process.env.COSMOS_SIGNALHUB_SILENCE_MS) || 90_000;
// TWO CLOCKS, DELIBERATELY (QA 2026-08-20). `hubAt` tracks when we last received DATA. A liveness
// beat proves the runner is alive; it does NOT make a stale set fresh. Refreshing the data clock on
// a beat meant that after ONE successful pull ever, a permanently 503-ing endpoint left every child
// filtering against a frozen set for the life of the process - entries draining to zero as markets
// left the window, while the logs printed a healthy "hub N cycles, M skipped". The stale-fallback
// could never fire. Only real data moves `hubAt`.
let hubSignals = null, hubAt = 0, hubBeatAt = 0;
process.on("message", (m) => {
  if (!m || typeof m !== "object") return;
  if (m.t === "enterable" && Array.isArray(m.signals)) { hubSignals = m.signals; hubAt = Date.now(); hubBeatAt = hubAt; return; }
  if (m.t === "s4canary") { s4authority.setCanary(m.list); return; }   // the polled tick needs the same list as the fast path
  if (m.t === "enterable-beat") { hubBeatAt = Date.now(); }
});
const hubFresh = () => hubSignals !== null && (Date.now() - hubAt) < HUB_SIGNALS_SILENCE_MS;
const ONESHOT_PCT = N("COPY_ONESHOT_PCT", 3);          // flat % of OUR portfolio per position (owner 2026-08-04: enter at 3%, that is it)
// PRODUCTION FLOOR $5 (restored 2026-07-30 after the hosted prove-out, which ran at $2 to trade
// small on a ~$24 test account). The economics set this number, not caution: a hosted signature
// costs real money and a $5 position round-trips ~$10 of volume, which is roughly where the 0.9%
// builder fee covers it. At $2 every trade loses money on net.
//
// The per-position ceiling still WINS over this floor (see oneShotTarget): a small portfolio trades
// under $5 rather than breach the 5% cap, which the hosted gate would reject as `order_too_large`.
const ONESHOT_MIN_USD = N("COPY_ONESHOT_MIN_USD", 5);
// $4 floor for GRADED one-shot entries (owner 2026-08-03: "add a floor of $4... only one-shot").
// The graded curve had no floor at all - a whale's small probe on a $100 portfolio sized to cents,
// which is dust nobody wants to hold. The cap still WINS on a conflict: a portfolio too small for
// $4 inside the 7% cap trades smaller rather than breaching it (a floored order above the cap
// would just be refused by the platform gate as order_too_large and trade NOTHING).
const ONESHOT_FLOOR_USD = N("COPY_ONESHOT_FLOOR_USD", 4);
const ONESHOT_TIER = N("COPY_ONESHOT_TIER", 2);        // enter only once he reaches this tier

// The graded ceiling = the one-shot cap. ONESHOT is set only by the hosted runner, so everything
// inside this function is hosted-only: the legacy beat-ladder (and its MAX_POSITION_PCT=5 ceiling)
// stays byte-for-byte, per the standing self-hosted rule.
const TIER_MAX_PCT = ONESHOT_CAP_PCT;

function oneShotTarget(sig, portfolio) {
  const none = { target: 0, ceiling: 0, beats: 0, beatUsd: 0 };
  if (!(portfolio > 0)) return none;

  // MEDIAN-TRIGGER ONE-SHOT (owner 2026-08-04: monitor the whale's median amount per trade over
  // his last 200 trades - once he passes this amount in a trade, enter at 3%. That is it).
  //
  // The server embeds median_usd (his median cost over his last 200 trades, fewer if he has fewer)
  // in wallets[0].auto_tiers. A trade AT or below his median is routine and copies nothing; a trade
  // ABOVE it is conviction above his own baseline and copies a flat 3% of OUR portfolio - the $4
  // floor lifts dust, and the 7% ceiling still wins over the floor on a small portfolio (a floored
  // order above the gate's cap would only be refused and trade nothing).
  //
  // This REPLACED the proportional curve (pct linear in his size, cap 7%): entry selectivity now
  // comes from the median gate, not from scaling the size.
  const bands = sig.wallets?.[0]?.auto_tiers;
  const median = Number(bands?.median_usd);
  if (Number.isFinite(median) && median > 0) {
    // OPEN-POSITION BASIS (owner 2026-08-04: "the open position size - one position - should be
    // above that median, not one entry"). his_cost_usd is his cumulative money-in; scaling it by
    // shares-held / peak-shares nets out what he has already sold, so a whale who bought $500 and
    // exited down to a $100 stub does not read as a $500 conviction. Checked on every fill
    // (chainwatch, ~1s) and every poll (20s) - the position crosses the median, we enter once.
    const hisUsd = Number(sig.his_cost_usd) || 0;
    const sh = Number(sig.his_shares), peak = Number(sig.his_peak_shares);
    const openFrac = peak > 0 && sh >= 0 ? Math.min(1, sh / peak) : 1;
    const openUsd = hisUsd * openFrac;
    if (!(openUsd > median)) return none;                // open position still routine-sized -> not a signal
    const capUsd = (portfolio * TIER_MAX_PCT) / 100;
    const target = Math.min(Math.max((portfolio * ONESHOT_PCT) / 100, ONESHOT_FLOOR_USD), capUsd);
    if (target < MIN_ORDER_USD) return none;
    return { target, ceiling: target, beats: 1, beatUsd: target };
  }
  // Signal predates the median rollout (no median_usd embedded yet): the old proportional curve,
  // so an in-flight signal can never crash sizing mid-deploy. Dies out as signals refresh.
  const gradedPct = pctFromAutoTiers(bands, Number(sig.his_cost_usd) || 0);
  if (gradedPct != null) {
    if (!(gradedPct > 0)) return none;
    const capUsd7 = (portfolio * TIER_MAX_PCT) / 100;
    const target = Math.min(Math.max((portfolio * gradedPct) / 100, ONESHOT_FLOOR_USD), capUsd7);
    if (target < MIN_ORDER_USD) return none;
    return { target, ceiling: target, beats: 1, beatUsd: target };
  }

  // FALLBACK — signal predates the auto-tiers migration/backfill (no bands embedded). The exact
  // legacy behaviour, byte-for-byte: single >=2% gate, flat 3%, $5 floor, 5% cap.
  const tier = Number(sig.tier_pct_resolved) || 0;
  if (!(tier >= ONESHOT_TIER)) return none;
  // ONESHOT_CAP_PCT, not MAX_POSITION_PCT: this fallback is hosted-only (see above), and the
  // legacy 5% constant must not silently truncate the hosted raise.
  const capUsd = (portfolio * ONESHOT_CAP_PCT) / 100;
  const target = Math.min(Math.max((portfolio * ONESHOT_PCT) / 100, ONESHOT_MIN_USD), capUsd);
  if (target < MIN_ORDER_USD) return none;             // below Polymarket's minimum -> no trade
  return { target, ceiling: target, beats: 1, beatUsd: target };
}

// ONE-SHOT STAYS ONE-SHOT (owner 2026-08-01). The graded ladder below is explicitly NOT wired in
// here: one-shot exists to hold each position to a single signature, and a per-conviction ladder
// would reintroduce exactly the signature cost it was built to remove. The ladder is for the
// future non-one-shot mode, so it lives on the beat path behind COPY_TIER_LADDER.

// CANDLE ENGINES (owner 2026-07-31). On crypto candles the sizing is his-holding-relative, not
// beat-relative: the server already gives us both numbers the spec needs — his money-in for THIS
// market (his_cost_usd) and his average per market (avg_trade_usd, already averaged per condition
// id, not per fill). See src/candle-sizing.mjs for the tiers and the cumulative rule.
//
// Scoped to candles ONLY. Sports and everything else keep the beat ladder untouched, because the
// tiers were specified against a whale's behaviour in a 15m market and mean nothing on a 3-week
// political position.
// HOSTED ONLY (owner 2026-07-31: "right now we're doing changes for hosted only"). Cosmos Cloud is
// the new method and everything in this spec targets it; the self-hosted fleet keeps the 5-beat
// ladder untouched.
//
// That is not just scope discipline, it is the right economics: one-shot exists BECAUSE a hosted
// signature costs real money, and a self-hosted bot signs locally for free — so collapsing its
// ladder to a single clip would take away upside it pays nothing for. Gating on the signer means a
// bot cannot end up on the wrong engine by forgetting an env var.
//
// COPY_CANDLE_ENGINE=0 disables it even when hosted; =1 forces it on for local testing.
const HOSTED = (process.env.COSMOS_SIGNER || "local").toLowerCase() === "remote";
const CANDLE_ENGINE_ENV = process.env.COPY_CANDLE_ENGINE || "";
const CANDLE_ENGINE = /^(1|true|yes|on)$/i.test(CANDLE_ENGINE_ENV)
  ? true
  : /^(0|false|no|off)$/i.test(CANDLE_ENGINE_ENV) ? false : HOSTED;

// ONE-SHOT ONLY for now (owner 2026-07-31): "once we update to enterprise in turnkey we will change
// it". The tiered 30/60/90 ladder is built and tested but costs three signatures per position
// instead of one, which does not pay at current per-signature pricing. Forced here rather than
// inherited from COSMOS_ONESHOT so a bot that happens not to set that env cannot silently run the
// expensive ladder. Flip with COPY_CANDLE_TIERS=1 when the pricing changes.
const CANDLE_TIERS = /^(1|true|yes|on)$/i.test(process.env.COPY_CANDLE_TIERS || "");
// The graded sports ladder. OFF unless explicitly enabled — see targetUsd for why.
const TIER_LADDER_ON = /^(1|true|yes|on)$/i.test(process.env.COPY_TIER_LADDER || "");

// WHAT COUNTS AS A CANDLE. Keyed off the TRADE, never the wallet — a sports whale who takes one
// crypto candle gets candle sizing for that position, which is the owner's point: "even if it's a
// regular wallet that places a crypto trade".
//
// copy_signals carries no event_slug, so market_question is the only identifier available; every
// candle market Polymarket lists is titled "<Asset> Up or Down - <date>, <time>-<time> ET". Covers
// 5m/15m/hourly alike, per the earlier spec ("all crypto 5m/15m/hourly trades").
// READ EVERY TITLE FIELD, not just one (2026-08-24). The fast path builds its signal from the
// copy-check response and the polled path from copy_signals; if either ever names the title
// differently, a one-field check silently reclassifies every candle as an event market and the
// 30min-8h window bans it. That is exactly the failure this line just had for a day - a stray
// backspace character sat where the a \b word boundary belonged, so the regex never matched and
// NO candle was ever exempt. Fail OPEN across field names now.
const candleTitle = (sig) => String(sig?.market_question ?? sig?.title ?? sig?.question ?? sig?.q ?? "");
const isCandleSig = (sig) => /\bup or down\b/i.test(candleTitle(sig));
// Mirrors the server (lib/copytrade/strategy-v2.ts candleDurationFromTitle) so the two can never
// disagree about what counts as a 15m or hourly candle: no time range in the title means hourly.
function candleMinutesFromTitle(q) {
  const r = /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*-\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*ET/i.exec(q);
  if (!r) return 60;
  const toMin = (h, m, ap) => { let hh = Number(h) % 12; if (/pm/i.test(ap)) hh += 12; return hh * 60 + Number(m ?? 0); };
  const d = (toMin(r[4], r[5], r[6]) - toMin(r[1], r[2], r[3]) + 1440) % 1440;
  return d > 0 ? d : 60;
}

function candleTarget(sig, portfolio) {
  const w = (sig.wallets ?? [])[0] ?? {};
  const baseline = Number(w.avg_trade_usd) || 0;
  const his = Number(w.cost_usd) || Number(sig.his_cost_usd) || 0;
  // Return the TOTAL we should hold, not the top-up. The caller already computes
  // `add = min(target, posCeil) - held`, so returning a delta here would double-count: at the 60%
  // tier it would buy 3% on top of the 1.5% already held instead of topping up to 3%. Returning the
  // target makes the cumulative rule fall out of the existing arithmetic for free.
  const pct = targetPctForHolding(his, baseline, { oneShot: !CANDLE_TIERS });
  return { target: (portfolio * pct) / 100, ceiling: (portfolio * 4.5) / 100, beats: pct ? 1 : 0, beatUsd: 0, candle: true, pct };
}

const ONESHOT_MIN_PORTFOLIO_USD = N("COPY_MIN_PORTFOLIO_USD", 55); // owner 2026-08-11: was \$75

function targetUsd(sig, unit, portfolio) {
  // HOSTED FLOOR (owner 2026-08-04, lowered to \$55 on 2026-08-11): a portfolio under the floor
  // places NO entries - candle or whale. `portfolio` is cash + open-positions value (bot.mjs),
  // so the floor is measured on the WHOLE account, not just idle cash.
  //
  // NOT a latch: this runs on every entry decision, so an account that dips under the floor simply
  // stops opening new positions and resumes the moment its total climbs back above it. Exits are
  // unaffected (this sizes entries only), so a bot below the floor can still close what it holds -
  // which is what lets the balance recover on its own.
  //
  // Bot-side so the fleet does not burn sign-gate calls on orders the gate would refuse anyway;
  // the app warns on the same line (MIN_PORTFOLIO_USD in lib/portfolio-floor.ts - keep them equal).
  // Legacy self-hosted bots (ONESHOT off) are untouched.
  if (ONESHOT && !(portfolio >= ONESHOT_MIN_PORTFOLIO_USD)) return { target: 0, ceiling: 0, beats: 0, beatUsd: 0 };
  if (CANDLE_ENGINE && isCandleSig(sig)) return candleTarget(sig, portfolio);
  if (ONESHOT) return oneShotTarget(sig, portfolio);
  // THE 20-TIER LADDER (owner 2026-08-02) — the future non-one-shot sizing, BUILT AND OFF
  // (COPY_TIER_LADDER=1 to enable, when one-shot is retired). His top-10% average bet maps to the
  // 5% per-trade cap; twenty 0.25% tiers keep ONE user-to-whale ratio across the whole ladder,
  // recomputed against the CURRENT portfolio every pass (so daily, in practice). Candles never
  // come through here (checked above) and the whale side refreshes with the server sweep.
  if (TIER_LADDER_ON && !isCandleSig(sig)) {
    const top10 = Number(sig.wallets?.[0]?.auto_tiers?.top10_avg_usd) || 0;
    const hisUsd = Number(sig.his_cost_usd) || Number(sig.wallets?.[0]?.cost_usd) || 0;
    if (top10 > 0) {
      const { target, pct } = twentyTierTarget({ hisUsd, top10AvgUsd: top10, portfolio });
      if (target > 0) return { target, ceiling: target, beats: 1, beatUsd: target, pct };
      return { target: 0, ceiling: 0, beats: 0, beatUsd: 0 };
    }
    // No top-10% anchor for this whale (thin history) -> fall through to the beat ladder rather
    // than skip a vetted wallet.
  }
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
  // WHY-NO-ORDER TELEMETRY (gate-funnel audit 2026-08-05): 3,036 server-APPROVED signals died
  // silently inside the fleet's bots in 48h - every refusal logged only to Fly, invisible from the
  // DB. Count each refusal reason here (numbers normalised to # so "target $3.20" and "target
  // $4.10" share a bucket); bot.mjs flushes the map through the heartbeat every ~15 min and the
  // server lands it in scan_runs as source='bot-skips'.
  const skipCounts = new Map();
  state.copySkips = skipCounts;
  // PHASE 3A OPPORTUNITY TRACE. A pure in-memory recorder: it never awaits, never branches trading,
  // and every call is total (see src/opp-trace.mjs). bot.mjs drains it onto the heartbeat that
  // already runs each cycle, so it costs no extra request.
  //
  // The switch is LIVE STATE, exactly like V2() below: the server delivers copy_trace on /v1/account
  // every cycle, so tracing turns on and off fleet-wide within one cycle - no restart, no redeploy,
  // no Fly secret. Env stays as a dev override.
  const trace = createTracer({
    userId: String(process.env.COSMOS_USER_ID || process.env.COSMOS_BOT_TAG || ""),
    enabled: () => state.copyTraceOn === true || /^(1|true|yes|on)$/i.test(process.env.COPY_TRACE || ""),
  });
  state.copyTrace = trace;
  /** one handle per (signal, path); all downstream calls are chainable and total */
  const T = (sig, path) => trace.open({
    tokenId: sig?.token_id, gen: Number(sig?.sell_seq) || 0, path,
    conditionId: sig?.condition_id, outcome: sig?.outcome, category: sig?.category,
    whale: sig?.wallets?.[0]?.wallet, question: sig?.market_question,
  });
  const lastMid = new Map();
  const lastMidAt = new Map();   // Phase 3A telemetry only - never read by a trading decision   // token -> last mid read by priceFor (see the gap guard below)
  // BUDGET CIRCUIT-BREAKER (incident 2026-08-06): with the exposure cap gone, bots reach the cloud
  // gate's rolling-24h ceiling (100% of portfolio in gross buys - the drain-defense hard floor) and
  // then every NEW signal fired a fresh sign request: 999 denials/90min hammered /api/cloud/sign
  // into 5xx and starved the DB. A day/hour-budget denial now pauses ALL copy entries for
  // COPY_BUDGET_PAUSE_MIN (default 30) - the window is rolling, so capacity frees continuously and
  // one probe per pause window is enough. Exits are never paused.
  let budgetPausedUntil = 0;
  let brokenStreak = 0;        // consecutive "this ACCOUNT cannot trade" refusals (see the breaker below)
  const BUDGET_PAUSE_MS = (Number(process.env.COPY_BUDGET_PAUSE_MIN) > 0 ? Number(process.env.COPY_BUDGET_PAUSE_MIN) : 30) * 60_000;
  const bumpSkip = (why) => {
    const key = String(why).replace(/[0-9$.]+/g, "#").slice(0, 40);
    skipCounts.set(key, (skipCounts.get(key) ?? 0) + 1);
  };
  const recentBuy = new Map(); // cid -> ts (settle-window cooldown; also throttles scale-in cadence)
  const seen = loadSeen();     // (cid#token) -> ts of first OPEN — never re-open (persisted)
  const buyTimes = [];         // sliding-window rate limit
  // `waiting` = signals held back ONLY by the v2 entry window. It is the number that proves the
// wait-then-enter loop is alive: it should be large and should convert into opens as markets cross.
  const stats = { signals: 0, opens: 0, adds: 0, fills: 0, waiting: 0 };
  let alive = true;

  async function priceFor(tokenId, capCents, floorCents) {
    const mid = await pm.getPriceCents(tokenId, { fresh: true });   // ENTRY: never a cached price
    if (mid == null) return null;
    lastMid.set(tokenId, mid);
    lastMidAt.set(tokenId, Date.now());   // Phase 3A: age of the price the order was built on   // the executable price; priceFor RETURNS the FAK ceiling, not this

    if (mid > capCents) return null;                    // market is above our cap -> don't chase it
    if (mid < floorCents) return null;                  // penny leg -> spread eats any edge; skip
    // FAK limit = the vetted CAP, not mid+1 (deep-check #5). A FAK's limit price is a CEILING — the fill
    // happens at the book's actual ask. mid+1 silently died on wide candle books (mid 50c, ask 53c ->
    // a 51c FAK crosses nothing and the entry is missed even though the server vetted the ask in-band).
    // Slippage stays bounded: the server set capCents from the ask it verified (+3..5c).
    return capCents >= 1 ? capCents : null;
  }
  const rateLimited = () => {
    const cut = Date.now() - 3600e3;
    while (buyTimes.length && buyTimes[0] < cut) buyTimes.shift();
    return buyTimes.length >= MAX_BUYS_PER_HOUR;
  };
  // A copytrade position counts against the caps only while it is LIVE. Resolved candle dust (shares
  // worth $0 that never left the wallet) lingers in the store forever; counting it clogged BOTH the
  // MAX_OPEN slot count AND the exposure sum, so the copier stopped buying with its caps "full" of
  // nothing — the same failure that froze qtable. end_date is recorded on every copy; if it is ever
  // missing, fall back to opened_at + 10d (longer than any market we copy) so a real multi-day
  // sports/weather leg still counts, but ancient dust does not.
  const copyLive = (p) => {
    if (p.source !== "copytrade") return false;
    const endMs = p.end_date && p.end_date !== "none" ? Date.parse(p.end_date)
      : p.opened_at ? Date.parse(p.opened_at) + 10 * 24 * 3600e3
      : Date.now();
    return !(Number.isFinite(endMs) && endMs < Date.now() - 15 * 60_000);
  };
  const copyExposure = (positions) => {
    let s = 0; for (const p of Object.values(positions)) if (copyLive(p)) s += Number(p.size_usd) || 0;
    return s;
  };

  // IN-FLIGHT LOCK (2026-08-19, second double-buy of the pilot). recentBuy is check-then-set across
  // an await gap: fastOpen fires once per chainwatch event, so a whale stacking three adds in 3s
  // spawned three concurrent fastOpens that ALL passed the cooldown check before the first buy()
  // set it - sebastian bought the same token three times ($8.40 into a ~$3 intent). The retry fix
  // could not catch this: these are three legitimate calls, not re-posts. The Set is checked and
  // claimed SYNCHRONOUSLY at the top of buy() - no await between test and set, so only one caller
  // per token can be in flight; the losers simply skip, and the next polled cycle re-sizes against
  // the real position (target - held), so a genuine multi-add whale still gets his top-up.
  const inFlightBuys = new Set();
  async function buy(sig, orderUsd, priceCents, kind, positions, existing, key = sig.condition_id, tr = null) {
    // THE VENUE BACKOFF LIVES HERE, at the one chokepoint every entry passes through. It was first
    // placed on a single call site and covered one of FOUR - the fast path's open, but not its add,
    // nor either of the polled path's. The refusals carried on at 87 per ten minutes with the pause
    // supposedly armed, which is what showed the gate was in the wrong place rather than wrong.
    // Every one of those is a paid enclave signature and a step toward wedging that market for 24h.
    if (Date.now() < venueBackoffUntil) {
      tr?.block("venue_backoff");
      bumpSkip("venue not matching - entries paused " + Math.ceil((venueBackoffUntil - Date.now()) / 60000) + "min");
      return false;
    }
    const tok = String(sig.token_id);
    if (inFlightBuys.has(tok)) { tr?.block("inflight"); bumpSkip("buy-in-flight"); return false; }
    inFlightBuys.add(tok);
    try {
      return await buyLocked(sig, orderUsd, priceCents, kind, positions, existing, key, tr);
    } finally { inFlightBuys.delete(tok); }
  }
  // STAGE 2G - ENTRY FLOOR GUARD (2026-08-28). Sits at the one chokepoint both entry paths share,
  // so it covers the chainwatch fast path that the Stage 2C guard (polled path only) never saw.
  // Rebuilds the sign gate's own portfolio composition from the bot's cash and raw /value - NOT the
  // bot's `portfolio`, which values positions at cost and is why one account asked the gate 723
  // times in 2.5h believing $64 while the gate read $28. Refuses locally only when clearly under
  // the gate's real line ($50 - margin); the band above is the server's; anything uncertain fails
  // OPEN. The verdict is computed on every attempt; it ACTS only when the server has switched
  // enforcement on (settings.entry_floor_guard, no restart) and is logged either way so the
  // LOCAL x SERVER matrix can be read off real attempts. BUY only - this function is BUY only.
  let shadow2gN = 0;
  const SHADOW_2G_MAX = Number(process.env.COPY_2G_SHADOW_MAX ?? 60);
  const floorGuard = () => floorGuardVerdict({ cash: state.cash, pmValue: state.pmValue, portfolioAt: state.portfolioAt, env: process.env });
  const shadow2g = (fg, r) => {
    if (shadow2gN >= SHADOW_2G_MAX) return;
    shadow2gN++;
    const why = r ? String(r.body?.polymarket?.error ?? r.error ?? "") : "";
    const m = why.match(/portfolio \$([0-9.]+) is under/);
    const server = r == null ? "suppressed" : r.ok ? "allow" : (r.cloudCode === "portfolio_too_small" || m) ? "deny-floor" : `other:${r.cloudCode || r.status || "?"}`;
    log(`[2g] ${JSON.stringify({ local: fg.verdict, gateLike: fg.gateLike == null ? null : Number(fg.gateLike.toFixed(2)), line: fg.line,
      portMax: Number((state.portfolio || 0).toFixed(2)), cash: state.cash, pm: state.pmValue,
      ageS: state.portfolioAt ? Math.round((Date.now() - state.portfolioAt) / 1000) : null,
      server, serverUsd: m ? Number(m[1]) : null, delta: m && fg.gateLike != null ? Number((fg.gateLike - Number(m[1])).toFixed(2)) : null,
      enforced: state.entryFloorGuard === true })}${shadow2gN === SHADOW_2G_MAX ? " (2g cap reached)" : ""}`);
  };
  let floorSkipLoggedAt = 0;
  async function buyLocked(sig, orderUsd, priceCents, kind, positions, existing, key = sig.condition_id, tr = null) {
    const fg = floorGuard();
    if (fg.verdict === "deny" && state.entryFloorGuard === true) {
      tr?.block("local_floor", { gate_like: fg.gateLike, line: fg.line });
      bumpSkip("under-floor (local guard)");
      if (Date.now() - floorSkipLoggedAt > 300_000) { floorSkipLoggedAt = Date.now(); log(`copytrade skip entries: ${fg.reason} - the gate would refuse this; not asking`); }
      shadow2g(fg, null);
      return false;
    }
    const shares = Math.max(Math.ceil(100 / priceCents), sharesFor(orderUsd, priceCents));
    const realUsd = (shares * priceCents) / 100;
    // THE SILENT REFUSAL, NAMED AT LAST (Phase 3A). This branch had no counter and no log line, and
    // it is exactly the one that fires when a portfolio is fully deployed - the condition an
    // occupancy investigation most needs to see. Behaviour is unchanged; only the record is new.
    if (realUsd > (state.cash ?? 0)) { tr?.block("cash_insufficient", { need: Number(realUsd.toFixed(2)), cash: Number((state.cash ?? 0).toFixed(2)) }); bumpSkip("cash short for the sized order"); return false; }
    tr?.stage(STAGE.LOCAL_GUARDS_PASS);
    const who = (sig.wallets?.[0]?.username) || (sig.wallets?.[0]?.wallet || "").slice(0, 8);
    const tag = `${sig.category} ${sig.outcome} @${priceCents}c · ${kind} $${realUsd.toFixed(2)} · via ${who} ($${Math.round(Number(sig.his_cost_usd) || 0).toLocaleString()} in)`;
    if (DRY) { log(`copytrade DRY would ${kind === "open" ? "OPEN" : "ADD"} ${tag} · ${String(sig.market_question || "").slice(0, 40)}`); recentBuy.set(sig.condition_id, Date.now()); return true; } // DRY returns true so seen/rate-limit apply like a real fill

    // Lock the market BEFORE placing (deep-check #10): fastOpen and the polled tick each load their own
    // positions snapshot, so without this a sub-second race could double-buy the same signal.
    recentBuy.set(sig.condition_id, Date.now());
    // ATTEMPT RECORD (Phase 3A). Everything here is EXACT, pre-order, and already paid for: the mid
    // is the one production's priceFor() just fetched, the cap comes off the signal row, the limit
    // and size are what the engine computed. Pure allocation - no I/O, so it cannot delay the order.
    //
    // The book probe below is started and DELIBERATELY NOT AWAITED. An earlier draft awaited a fresh
    // getOrderBook here, between the market lock and the order; that added a network round-trip to
    // the money path, let the book move under the order, and could change the very FAK outcome this
    // phase exists to measure. Whatever the probe returns is attached afterwards and labelled
    // near-contemporaneous, with snap_before_send recording whether it actually beat the order out.
    if (tr) {
      const rowAgeH = sig.updated_at ? (Date.now() - Date.parse(sig.updated_at)) / 3600_000 : null;
      const mAt = lastMidAt.get(sig.token_id);
      tr.attempt({ kind, mid: lastMid.get(sig.token_id) ?? null, midAt: mAt ? Math.round(mAt / 1000) : null,
        cap: Number(sig.max_entry_cents) || null, limit: priceCents, usd: Number(realUsd.toFixed(2)), shares,
        rowAgeH: rowAgeH == null ? null : Number(rowAgeH.toFixed(2)), whaleAvgC: Math.round(hisAvgCents(sig) ?? 0) || null });
      if (BOOK_PROBE && pm.bookSnapshot) tr.bookProbe(() => pm.bookSnapshot(sig.token_id, priceCents, PROBE_TIMEOUT_MS));
      tr.orderSent();
    }
    const r = await placeWithRetry(pm, { tokenId: sig.token_id, side: "BUY", sizeShares: shares, priceCents, orderType: "FAK" }, 2, 100);
    shadow2g(fg, r);   // stage 2G: local verdict beside the server's, one bounded line per attempt
    if (!r.ok) {
      // Failed FAK must NOT burn the full 60s cooldown (deep-check #6): on a 5-min candle that lockout
      // IS the missed entry. Leave a 5s breather, then either path may retry while the market lives.
      recentBuy.set(sig.condition_id, Date.now() - COOLDOWN_MS + 5_000);
      // Log the REASON, not just the status: "open failed: 400" hid that the local risk governor
      // (not Polymarket) was refusing every buy for two days (2026-07-26 incident).
      const why = String(r.body?.polymarket?.error ?? r.error ?? r.err ?? r.status ?? "");
      tr?.sign(r.cloudCode || "venue", !r.cloudCode).venue(why.slice(0, 60) || "zero-fill", 0);
      if (r.cloudCode === "day_budget" || r.cloudCode === "hour_budget" || /exceed the (daily|hourly) budget/i.test(why)) {
        budgetPausedUntil = Date.now() + BUDGET_PAUSE_MS;
        bumpSkip("budget-paused");
        warn(`copytrade BUDGET reached (${r.cloudCode || "budget"}) - pausing ALL entries ${Math.round(BUDGET_PAUSE_MS / 60000)}min (rolling window frees capacity; exits unaffected)`);
      }
      // ACCOUNT-BROKEN BREAKER (2026-08-18). Some refusals are not about this trade at all - they
      // say the ACCOUNT cannot trade until a human fixes it (an unreadable portfolio, usually a
      // funder that does not match the enclave key). Retrying those is pure waste, and unbounded:
      // measured live, ONE such account produced 15,622 denials in 30 hours - 6,158 in a single
      // hour, ~1.7 per second - because every whale fill triggered another doomed attempt. It cost
      // real serverless invocations, buried the real denial signal in the stats, and filled
      // cloud_orders with garbage.
      // Same 30-minute pause as the budget breaker, and for the same reason: the condition cannot
      // clear within seconds, so asking again within seconds is never useful. EXITS ARE UNAFFECTED
      // (this only gates entries) - a broken account must still be able to get its money out.
      if (r.cloudCode === "no_risk_state" || r.cloudCode === "no_portfolio") {
        if (++brokenStreak >= 3) {
          budgetPausedUntil = Date.now() + BUDGET_PAUSE_MS;
          bumpSkip("account-unreadable");
          warn(`copytrade ACCOUNT UNREADABLE (${r.cloudCode}) x${brokenStreak} - pausing entries ${Math.round(BUDGET_PAUSE_MS / 60000)}min. This usually means the funder address does not match the account key; exits still run.`);
          brokenStreak = 0;
        }
      } else if (r.cloudCode) { brokenStreak = 0; }   // any other verdict proves the account is readable

      // DETERMINISTIC DENIALS GET A COOLDOWN (QA 2026-08-20). A verdict that is a pure function of
      // (our price, the book) or (our exposure, the cap) cannot change on the next 20s tick, yet the
      // loop re-asked every cycle: measured in one day, 998 of 1008 denials were futile repeats -
      // 519 attempts over 3.5 HOURS on a single $2.75 order whose 55c limit sat against a 40c ask.
      // Each one is a Turnkey signature attempt and a cloud_orders row.
      // A COOLDOWN, NOT A BAN: books move and exposure frees, so the market is retried after it -
      // just not 2.5 times a minute. Sized well under the shortest useful entry window.
      if (r.cloudCode === "buy_above_book" || r.cloudCode === "market_concentration") {
        recentBuy.set(sig.condition_id, Date.now() - COOLDOWN_MS + DENY_COOLDOWN_MS);
        bumpSkip(`deny-cooldown:${r.cloudCode}`);
      }
      // THE EXCHANGE SAYING "trading is disabled" IS ALSO DETERMINISTIC, and for far longer than a
      // book moving. Seen on 2026-08-26 at 39% of every order placed - and the cause was not ours:
      // Polymarket stopped matching around 04:00 UTC. Measured across 39 unrelated tracked wallets,
      // ZERO fills in the following two hours against a wall of them in the hour before - a cliff,
      // not a quiet night. Books stayed full and the markets still reported accepting_orders=true.
      // The first diagnosis blamed pre-buys of future candles, which was wrong; the error only
      // looked new because the fleet had been halted through the outage and started placing the
      // moment it was released.
      // The cooldown is right regardless of which of the two it is: an exchange that will not match
      // is not going to change its mind inside a 20-second tick, and every re-ask costs a paid
      // signature. Longer than a price denial because what is being waited on is the venue coming
      // back rather than a book ticking. Still a cooldown and not a ban.
      const exErr = String(r.body?.polymarket?.error ?? r.error ?? "");
      if (/trading is disabled|not accepting orders|market is closed/i.test(exErr)) {
        recentBuy.set(sig.condition_id, Date.now() - COOLDOWN_MS + PREOPEN_COOLDOWN_MS);
        bumpSkip("deny-cooldown:market-not-open-yet");
        // ONE MARKET IS A MARKET. SEVERAL AT ONCE IS THE VENUE.
        // Per-market cooldowns all start together during an outage and therefore all EXPIRE
        // together - measured 2026-08-26, that produced a herd of 70 refused orders in ten minutes,
        // every one a paid signature against an exchange known to be down, and each one eating a
        // per-trade signature cap that then locks the market out for 24 HOURS even after the venue
        // returns. Distinct markets refusing inside one window is evidence about the venue, not
        // about any market, so back the whole engine off briefly.
        // Deliberately NOT a halt: it is short, it self-clears, nobody has to press anything, and
        // exits are untouched throughout - a venue that cannot match cannot fill a sell either, but
        // the moment it can, the exit path must already be live.
        venueRefusals.set(sig.condition_id, Date.now());
        for (const [cid, at] of venueRefusals) if (Date.now() - at > VENUE_WINDOW_MS) venueRefusals.delete(cid);
        if (venueRefusals.size >= VENUE_MIN_MARKETS && Date.now() > venueBackoffUntil) {
          venueBackoffUntil = Date.now() + VENUE_BACKOFF_MS;
          warn(`[venue] ${venueRefusals.size} markets refused as not-matching inside ${Math.round(VENUE_WINDOW_MS / 60000)}min - pausing ENTRIES ${Math.round(VENUE_BACKOFF_MS / 60000)}min. Exits keep running.`);
        }
      }
      warn(`copytrade ${kind} failed: ${why.slice(0, 120)}`); return false;
    }
    stats.fills++;
    tr?.sign("ok", true);
    cosmos.meter({ ...r.meta, source: "copytrade" }).catch(() => {}); // fire-and-forget: the trading loop must NEVER block on the metering relay (a hung await here froze tick() for 12.5h on 07-21)

    // ACTUAL FILL (2026-07-19): placeOrder now reports what MATCHED — a FAK cap routinely fills fewer
    // shares at a better price than the cap (a "97c" order really filled 3.96 sh @ 49c). Track and
    // ledger the FILL; fall back to the request only when the response carried no fill info.
    const fillShares = Number(r.meta?.size) > 0 ? Number(r.meta.size) : shares;
    const fillCents = Number(r.meta?.price) > 0 ? Number(r.meta.price) : priceCents;
    const fillUsd = Number(((fillShares * fillCents) / 100).toFixed(2));
    tr?.venue("filled", fillUsd);

    const nowIso = new Date().toISOString();
    if (kind === "open") {
      positions[key] = {
        condition_id: sig.condition_id, token_id: sig.token_id, outcome: sig.outcome, source: "copytrade",
        entry_cents: fillCents, size_usd: fillUsd, size_shares: fillShares, entry_whales: [],
        market_question: sig.market_question || "", opened_at: nowIso, end_date: sig.end_date || undefined,
        copy_wallet: (sig.wallets?.[0]?.wallet || "").toLowerCase(), copy_category: sig.category,
        copy_orig_shares: fillShares, copy_seq: 0, copy_his_cost: Number(sig.his_cost_usd) || 0, copy_target_usd: fillUsd,
      };
      stats.opens++;
    } else {
      existing.size_usd = Number((existing.size_usd + fillUsd).toFixed(2));
      existing.size_shares += fillShares;
      existing.copy_orig_shares = Math.max(existing.copy_orig_shares || 0, existing.size_shares);
      existing.copy_his_cost = Number(sig.his_cost_usd) || existing.copy_his_cost;
      existing.copy_target_usd = Number((Number(existing.copy_target_usd || 0) + fillUsd).toFixed(2));   // deep-check #12: precedence bug made this a STRING after the first add
      stats.adds++;
    }
    store.save(positions);
    state.cash -= fillUsd; state.deployed += fillUsd;
    const rec = { ts: nowIso, cid: sig.condition_id, cat: sig.category, outcome: sig.outcome, kind, wallet: (sig.wallets?.[0]?.wallet || "").toLowerCase(), price_cents: fillCents, shares: fillShares, size_usd: fillUsd, his_cost_usd: Number(sig.his_cost_usd) || 0 };
    appendLedger(rec);
    // per-user admin ledger (only trades opened after activation ever reach here)
    cosmos.copyReport({ wallet: rec.wallet, condition_id: sig.condition_id, outcome: sig.outcome, category: sig.category, action: "BUY", shares: fillShares, price_cents: fillCents, size_usd: rec.size_usd, his_cost_usd: rec.his_cost_usd, market_question: sig.market_question }).catch(() => {});
    log(`copytrade ${kind === "open" ? "OPEN" : "ADD "} ${tag} ✓ · ${String(sig.market_question || "").slice(0, 36)}`);
    return true;
  }

  // THE FAST PATH (chainwatch). The whale's fill is seen on-chain in ~2s instead of ~360s via the
  // activity indexer, and the server has ALREADY applied every rule (new-only, category, runway, pair
  // cost, entry band) in /api/v1/copy-check. What's left is exactly the local half — the caps that
  // protect THIS account — so it runs the same guards the polled loop does, on a signal that is just
  // minutes fresher. Buy-once-ever means the slow feed re-delivering it later is a no-op.
  // What do we put into THIS signal? Beats for a new position he just opened; a flat 1% for one we are
  // adopting (he is already in it, at roughly this price).
  // ---- STRATEGY v2 (COPY_STRATEGY_V2, owner 2026-08-13) ------------------------------------------
  // The server stamps tier_pct_resolved from the whale's OWN percentile tiers (non-crypto 5/3/2 off
  // his top 10/20/30% closed positions; 15m+hourly candles 4/3/2 off his top 25/50/75%). Under v2
  // the bot sizes EVERY signal at that pct of the TOTAL portfolio (cash + positions), floor $2 -
  // no median one-shot, no beats, no candle engine. pct null/0 = the server said no entry.
  // Live state, not a boot-time constant: the server delivers strategy_v2 every cycle (bot.mjs),
  // so the fleet switches without restarts. Env stays as a dev override.
  const V2 = () => state.strategyV2 === true || /^(1|true|yes|on)$/i.test(process.env.COPY_STRATEGY_V2 || "");
  clockV2On = () => state.clockV2 === true || /^(1|true|yes|on)$/i.test(process.env.COPY_CLOCK_V2 || "");
  const V2_FLOOR_USD = Number(process.env.COPY_V2_FLOOR_USD) || 2;
  // Crypto cash reserve: the LAST 10% of the portfolio is crypto-only. A NON-candle buy needs cash
  // >= 10% of portfolio before it and may not take cash under 6% after. Candles spend freely.
  function v2ReserveBlocked(sig, amountUsd) {
    if (!V2() || isCandleSig(sig)) return false;
    const port = state.portfolio || 0, cash = state.cash ?? 0;
    if (!(port > 0)) return false;
    // RESERVE REMOVED (owner 2026-08-26), and no longer hardcoded. It kept 10% back so a candle
    // signal would always find cash; the owner's call is that it cost more than it bought - nine of
    // nineteen reporting bots were sitting under the line, declining entries while the whales ran
    // at 210 fills per ten minutes. Both numbers are env-tunable now, so putting it back is a
    // config change rather than a deploy.
    const pctBefore = RESERVE_PCT, pctAfter = RESERVE_AFTER_PCT;
    if (pctBefore > 0 && cash < port * (pctBefore / 100)) return `cash under the ${pctBefore}% crypto reserve`;
    if (pctAfter > 0 && cash - amountUsd < port * (pctAfter / 100)) return `buy would breach the ${pctAfter}% reserve floor`;
    return false;
  }
  // THE TIER IS COMPUTED HERE, NOT READ FROM THE SIGNAL (2026-08-19). tier_pct_resolved is stamped
  // on a signal row SHARED by v1 and v2 users, so it can only ever carry ONE ladder - and it carries
  // the legacy one (measured on the pilot's live feed: values of 0% and 1.5%, neither of which is a
  // v2 tier). Sizing off it meant the pilot silently ran v1 percentages, and a 0% stamp meant "no
  // entry" on 86 of 93 of its signals - the shift would have looked live while trading almost
  // nothing. The whale's own percentile thresholds already ride on the signal in
  // wallets[0].auto_tiers.v2, so a v2 bot resolves its own number and needs no schema change.
  // 5/3/2 -> 4/3/2 with the widened ranks (owner 2026-08-19). The RANKS live server-side (they decide
  // the dollar thresholds stamped on the signal); the bot only needs the matching percentages.
  const V2_NC_PCTS = [5, 4, 3], V2_CANDLE_PCTS = [3, 2];
  const pctFromBands = (cost, t, pcts) => {
    if (!t) return null;
    const ladder = [t.t1_usd, t.t2_usd, t.t3_usd];
    for (let i = 0; i < pcts.length; i++) {
      const th = Number(ladder[i]);
      if (Number.isFinite(th) && cost >= th) return pcts[i];
    }
    return 0;                                   // below his lowest tier: no entry
  };
  function v2Pct(sig) {
    const v2t = sig?.wallets?.[0]?.auto_tiers?.v2;
    if (!v2t) return null;                      // thresholds not computed yet -> caller falls back
    const cost = Number(sig.his_cost_usd) || 0;
    if (isCandleSig(sig)) {
      // Duration parsed exactly as the server does (strategy-v2.ts candleDurationFromTitle): a
      // title with no time range is hourly. 5m and 4h are out of spec under v2 - sizing them off
      // the candle ladder would trade markets the strategy explicitly excludes.
      const dur = candleMinutesFromTitle(String(sig.market_question ?? ""));
      if (dur !== 15 && dur !== 60) return 0;
      return pctFromBands(cost, v2t.candle, V2_CANDLE_PCTS);
    }
    return pctFromBands(cost, v2t.nc, V2_NC_PCTS);
  }
  function sizeFor(sig, unitBasis, portfolio) {
    if (V2()) {
      // MINIMUM PORTFOLIO APPLIES TO v2 TOO (2026-08-21). The v2 branch returns before the ONESHOT
      // guard below, so an account under the floor still sized to V2_FLOOR_USD and attempted - the
      // gate then refused it "portfolio_too_small" every cycle. Latent while v2 was five hand-picked
      // accounts, all comfortably above the line; the moment it went fleet-wide (median portfolio
      // $32) it became 730 of 743 denials in six minutes, each one a database write and a serverless
      // invocation for an account that CANNOT trade. Same line the app warns on.
      if (ONESHOT && !(portfolio >= ONESHOT_MIN_PORTFOLIO_USD)) return { target: 0, beats: null };
      const own = v2Pct(sig);
      const pct = own == null ? Number(sig.tier_pct_resolved) : own;
      if (!Number.isFinite(pct) || pct <= 0) return { target: 0, beats: null };
      return { target: Math.max(V2_FLOOR_USD, (portfolio || 0) * (pct / 100)), beats: null };
    }
    // ONE-SHOT SIZES EVERYTHING (deep audit 2026-08-04, the fleet's root cause). The SPORTS branch
    // below intercepted every sports signal BEFORE targetUsd, so the median one-shot never ran for
    // the fleet's dominant category - sports sized off tier_pct_resolved with a hardcoded fallback
    // that skips anything under $30k, which is why whales with $1k-$13k conviction positions never
    // produced a single entry. Hosted bots route every signal through targetUsd: the $75 portfolio
    // floor, then the candle engine for candles, then the median-trigger one-shot for the rest
    // (sports, adopt, ALL-category alike - the owner's spec has ONE entry rule). Legacy bots
    // (ONESHOT off) keep the branches below byte-for-byte.
    if (ONESHOT) return targetUsd(sig, unitBasis, portfolio);
    // ADOPT: flat 1% of the portfolio - but FLOORED at Polymarket's $1 minimum, exactly like a beat.
    // Without the floor a $76 portfolio sizes an adopt at $0.76, which is below the minimum order, so
    // `if (target < MIN_ORDER_USD) continue` silently drops it. That is not "small", it is NEVER: no
    // account under $100 could ever take an adopt signal, and 13 of them sat unbought while we watched.
    const port = portfolio || 0;
    // SPORTS = THE TIERS ONLY (owner 2026-07-15): swisstony's settings apply to his EXISTING positions
    // (adopt) AND his live/future entries alike — never the beats. Size purely by his money in the
    // position: <$30k skip · 30-70k 1% · 70-120k 2% · 120-180k 3% · 180k+ 4% of the portfolio, and the
    // fast-path top-up escalates us tier by tier as his (now cumulative) money-in grows.
    if (String(sig.category).toUpperCase() === "SPORTS") {
      // TRACKS (owner 2026-07-16): the server now resolves each wallet's tier % from copy_wallets.tier_rules
    // and stamps it on the signal — per-wallet sizing is DATA, not code. The hardcoded bands below remain
    // only as a fallback for signals emitted by a pre-tracks server.
    const srvPct = Number(sig.tier_pct_resolved);
    const pct = Number.isFinite(srvPct) && sig.tier_pct_resolved != null ? srvPct : sportsAdoptPct(Number(sig.his_cost_usd) || 0, sig.wallets?.[0]?.username);
      if (pct <= 0) return { target: 0, beats: null };
      return { target: Math.max(MIN_ORDER_USD, port * (pct / 100)), beats: null };
    }
    if (sig.kind === "adopt") return { target: Math.max(MIN_ORDER_USD, port * (ADOPT_PCT / 100)), beats: null };  // weather/other adopt: flat 1%
    return targetUsd(sig, unitBasis, portfolio);   // crypto: the beats, or the candle tiers
  }

  // The canary gate counts REAL STAGE 4 INTENTS. An order on a canary whale's token is not evidence of
  // that: the same token is bought by the polled sweep, by non-canary children and by the old-path
  // fallback. Only this call site knows which answer decided, so it is counted here (owner 2026-08-31,
  // after a report claimed 71 intents that were all old-path orders placed while the canary was OFF).
  // ATTRIBUTION WRAPPER (owner 2026-08-31). The placement mints its triggerId deep in bot.mjs and knows
  // nothing about Stage 4, so the fill identity is bound on an OUTER async context that every sign
  // request under this decision inherits. Only the Stage 4 path sets it: an old-path order carries
  // nothing, which is exactly what makes "a Stage 4 order without attribution" detectable.
  async function fastOpen(sig, meta = {}) {
    if (meta?.s4 && meta?.fillId) return withS4Attribution({ fillId: meta.fillId, group: sig?.group_id }, () => fastOpenInner(sig, meta));
    return fastOpenInner(sig, meta);
  }
  async function fastOpenInner(sig, meta = {}) {
    const tr = T(sig, "fast");
    tr.stage(STAGE.SEEN).stage(STAGE.HUB_ENTERABLE).stage(STAGE.DRIVER_PICKED);
    if (state.copytrade === false) { tr.block("engine_off"); return; }
    if (Date.now() < budgetPausedUntil) { tr.block("budget_paused"); return; }   // budget breaker: no entries until the window frees
    // The fast path IS the whale-fill path. A bot that only has the adopt flag must never take one.
    if (state.copyFills === false) { tr.block("engine_off"); return; }
    if (state.cash == null || state.sizing == null) { tr.block("no_cycle_state"); return; }      // no cycle data yet -> can't size
    tr.stage(STAGE.ENGINE_READY);
    const positions = store.load();
    let openCopy = 0; for (const p of Object.values(positions)) if (copyLive(p)) openCopy++;   // dead dust does not fill a slot
    const unitBasis = sizeForSignal(state.sizing, { source: "copytrade", outcome: "Yes" }, state.portfolio, state.deployed) * UNIT_FRACTION;
    if (!(unitBasis > 0)) { tr.block("no_cycle_state"); return; }
    const exposureCap = ((state.portfolio || 0) * MAX_EXPOSURE_PCT) / 100;
    // RATIO SIZING (owner's spec, "the beats"): our_$ = his_$ x (our_unit / his_avg_trade_$), capped at
    // the ceiling. The chain gives his exact share count, so copy-check prices his money-in and this
    // path sizes IDENTICALLY to the polled one — a flat unit would buy the same off a $50 dab as off a
    // $50,000 conviction. Below the $1 Polymarket minimum ("the first beat") we simply don't buy.
    let { target } = sizeFor(sig, unitBasis, state.portfolio);
    // TRACE EVERY REFUSAL (deep-check forensics): the server logs every verdict, but the bot refused
    // silently — 38 approved markets got no order in 24h and NOTHING said why. One line per skip.
    const skip = (why) => { bumpSkip(why); log(`copytrade fast-skip ${sig.category} ${sig.outcome}: ${why} · ${String(sig.market_question || "").slice(0, 32)}`); };
    // SAY WHICH GATE REFUSED. This printed "beats=0" for every zero target, including under v2 where
    // there are no beats at all - sizeFor returns { beats: null } long before the beat ladder - and
    // it printed avg_trade_usd, a v1 concept, next to it. "beats=0" is 82% of all fleet skips, so
    // the single most common thing the fleet says about itself was named after a retired strategy.
    // The same mislabelling on the server ("conflict: opposite side bigger" covering the retired
    // one-whale lock) sent a whole day's investigation to the wrong place.
    if (!(target > 0)) {
      if (V2()) {
        const pct = v2Pct(sig) ?? Number(sig.tier_pct_resolved);
        tr.block(!(state.portfolio >= ONESHOT_MIN_PORTFOLIO_USD) ? "portfolio_floor" : "tier_zero",
          { port: Math.round(state.portfolio || 0), his_usd: Math.round(Number(sig.his_cost_usd) || 0), pct: Number.isFinite(pct) ? pct : null });
        return skip(!(state.portfolio >= ONESHOT_MIN_PORTFOLIO_USD)
          ? "portfolio $" + Math.round(state.portfolio || 0) + " under the $" + ONESHOT_MIN_PORTFOLIO_USD + " floor"
          : "below his tier ladder (his $" + Math.round(Number(sig.his_cost_usd) || 0) + " -> " + (Number.isFinite(pct) ? pct + "%" : "no tiers computed") + ")");
      }
      tr.block("tier_zero", { his_usd: Math.round(Number(sig.his_cost_usd) || 0), port: Math.round(state.portfolio || 0) });
      return skip("beats=0 (his $" + Math.round(Number(sig.his_cost_usd) || 0) + " vs avg $" + Math.round(Number(sig.wallets?.[0]?.avg_trade_usd) || 0) + ")");
    }
    tr.stage(STAGE.TIER_RESOLVED).stage(STAGE.TARGET_SIZED).note("target", Number(target.toFixed(2)));
    // pre-kickoff window is the LEGACY model; one-shot buys in-play behind the gap band instead
    if (!ONESHOT && sportsWindowClosed(sig)) { tr.block("pre_game_closed"); return skip(`pre-game window closed (<${SPORTS_MIN_LEFT_MIN}m to kickoff)`); }

    if ((recentBuy.get(sig.condition_id) ?? 0) > Date.now() - COOLDOWN_MS) { tr.block("cooldown"); return skip("cooldown"); }
    if (target < MIN_ORDER_USD) { tr.block("target_below_min"); return skip("target $" + target.toFixed(2) + " < $1 min"); }
    // NO POSITION-COUNT / EXPOSURE LIMITS in one-shot (owner 2026-08-06: "delete this rule - we just
    // look at 3% of the total portfolio"). Sizing (3%, $4 floor, 7% per-position cap), buy-once-ever,
    // cash itself and the 30/h rate brake are the remaining guards. Legacy keeps both caps.
    if (!ONESHOT && openCopy >= MAX_OPEN) { tr.block("max_open"); return skip("MAX_OPEN " + openCopy); }
    if (rateLimited()) { tr.block("rate_limited"); return skip("rate limit " + MAX_BUYS_PER_HOUR + "/h"); }
    const primary = positions[sig.condition_id];
    const sameSide = (p) => p && String(p.outcome).toLowerCase() === String(sig.outcome).toLowerCase();
    const compKey = `${sig.condition_id}#${sig.token_id}`;
    // FAST-PATH TOP-UP (deep-check #4): if we already hold this side and the whale's growing money-in
    // raised our target above what we hold, ADD the difference NOW. Waiting for the 20s polled loop
    // meant the 2nd..5th beats of a 5-minute candle never fired — the beat ladder collapsed to
    // whatever the first clip bought.
    // FLOORED at the $1 Polymarket minimum (2026-07-25): a bare 5% ceiling made every portfolio
    // under $20 skip EVERY signal ("per-position cap below $1 min") — fleet copy-trading stopped for
    // all but one account the hour the 5% cap shipped. $1 on a $10 account is still a sane cap.
    const posCeil = Math.max(MIN_ORDER_USD, ((state.portfolio || 0) * MAX_POSITION_PCT) / 100);   // hard ceiling for THIS market
    const mine = primary && sameSide(primary) ? primary : (positions[compKey]?.source === "copytrade" ? positions[compKey] : null);
    if (mine) {
      if (ONESHOT && !V2()) { tr.block("already_holding"); return; }  // one-shot never follows him up; v2 DOES - tier escalation IS the top-up
      // NEVER REBUY AFTER AN EXIT (owner 2026-08-13): once ANY mirror-sell fired on this signal,
      // adds are dead for good - a top-up after our own exit would buy back what we just sold.
      if (V2() && (Number(sig.sell_seq) || 0) > 0) { tr.block("no_rebuy"); return skip("no adds after an exit (v2)"); }
      // ONLY THE WHALE WE ENTERED WITH MAY GROW THIS POSITION (owner 2026-08-25). One signal row per
      // (market, outcome, track) is shared by every whale in the track, and its driver can change
      // hands once the previous one is out. Sizing a top-up off a DIFFERENT whale's money-in means
      // adding to our position on someone else's conviction - and the exit ratchet would then be
      // riding a whale we never chose. The other side of the market is unaffected: it is a separate
      // row and may be entered on its own tier by anyone.
      const driver = String(sig.wallets?.[0]?.wallet || "").toLowerCase();
      const boundTo = String(mine.copy_wallet || "").toLowerCase();
      if (boundTo && driver && driver !== boundTo) { tr.block("add_driver_mismatch"); return skip("add: signal driver " + driver.slice(0, 10) + " is not the whale we entered with"); }
      const held = Number(mine.size_usd) || 0;
      // Never let one position grow past the per-position ceiling, whatever the target says.
      let add = Math.min(target, posCeil) - held;
      if (add < MIN_ADD_USD) { tr.block("add_below_min"); return; }                              // at/over the ceiling or fully sized (steady-state)
      if (!ONESHOT && copyExposure(positions) + add > exposureCap) { tr.block("exposure_cap"); return skip("exposure cap (add $" + add.toFixed(2) + ")"); }
      const px = await priceFor(sig.token_id, addCapFor(sig), MIN_ADD_CENTS);
      if (px == null) { tr.block("price_out_of_band"); return skip("add price out of band"); }
      { const rb = v2ReserveBlocked(sig, add); if (rb) { tr.block("reserve_blocked"); return skip(rb); } }
      const ok = await buy(sig, Math.min(add, state.cash ?? 0), px, "add", positions, mine, sig.condition_id, tr);
      if (meta?.s4) { mInc("s4CanaryIntent"); if (ok) mInc("s4CanaryFilled"); }
      if (ok) buyTimes.push(Date.now());
      return;
    }
    const key = primary ? compKey : sig.condition_id;             // opposite side held -> composite key
    if (positions[key]) { tr.block("already_holding"); return skip("already hold this side"); }
    const seenKey = compKey;
    if (seen[seenKey]) { tr.block("buy_once"); return skip("buy-once-ever"); }
    // NOT YET, not never: the polled loop re-tests this signal every cycle and opens it the moment
    // it is inside the window and still clears everything else.
    tr.stage(STAGE.HOLDING_RESOLVED);
    if (outsideV2Window(sig, V2())) { tr.block(tooLateV2(sig, V2()) ? "window_dead" : "window_wait", { h_left: Number(hoursLeft(sig).toFixed(2)) }); return skip(tooLateV2(sig, V2())
      ? `v2 window: only ${hoursLeft(sig).toFixed(2)}h left (<${V2_MIN_MS / 3600_000}h floor)`
      : `v2 window: resolves in ${hoursLeft(sig).toFixed(1)}h (>${V2_WINDOW_MS / 3600_000}h)`); }
    tr.stage(STAGE.WINDOW_OPEN);
    target = Math.min(target, posCeil);                          // per-position ceiling on the opening clip too
    if (target < MIN_ORDER_USD) { tr.block("target_below_min"); return skip("per-position cap below $1 min"); }
    if (!ONESHOT && copyExposure(positions) + target > exposureCap) { tr.block("exposure_cap"); return skip("exposure cap ($" + copyExposure(positions).toFixed(2) + "+$" + target.toFixed(2) + ">$" + exposureCap.toFixed(2) + ")"); }
    // ENTRY CEILING (owner 2026-08-20). Never OPEN above 97c: the take-profit is 99c and the builder
    // fee is 0.9% PER LEG, so a 98c entry round-trips at a loss no matter which way the market goes.
    // Measured before this cap: 12 such buys in a week (~$45 that could not win), and the 90-99c band
    // was a THIRD of all Turnkey signatures while converting to a real fill only 15% of the time -
    // the most expensive and least productive slice of the book. Top-ups are NOT exempt: a top-up at
    // 98c loses exactly as much as an open at 98c.
    const capMax = Math.min(
      V2() ? V2_MAX_ENTRY_CENTS : 99,
      String(sig.category).toUpperCase() === "SPORTS" ? 99 : MAX_ENTRY_CENTS,
    );
    const cap = sig.is_pair
      ? Math.min(99, Number(sig.max_entry_cents) || 99)
      : Math.min(capMax, Number(sig.max_entry_cents) || capMax);
    const floor = sig.is_pair ? 1 : (String(sig.category).toUpperCase() === "SPORTS" ? 3 : MIN_ENTRY_CENTS);
    const band = inPlayBand(sig, cap, floor);            // in-play (hosted): within ±20c of HIS avg entry
    const px = await priceFor(sig.token_id, band.cap, band.floor);
    if (px == null) { tr.block("price_out_of_band", { cap: band.cap, floor: band.floor }); return skip("price out of band (cap " + band.cap + "c)"); }
    tr.stage(STAGE.PRICED);
    const execC = lastMid.get(sig.token_id) ?? px;
    // FIRST LEG ONLY (owner 2026-08-18). A NEW position is refused when the market has moved more
    // than 20% either way from the whale's average entry - we are too late, and buying his idea at
    // a materially different price is not copying it. TOP-UPS ARE DELIBERATELY EXEMPT: we are
    // already in at his price, and the add is sized off his growing conviction, so the add path
    // above uses addCapFor() and never reaches this test. Under v2 the gate is unconditional
    // (previously ONESHOT-only), because v2 IS the strategy - the flag no longer selects behaviour.
    if ((ONESHOT || V2()) && tooFarFromHisEntry(sig, execC, holdsPairSibling(positions, sig))) { tr.block("price_gate", { mid: execC, his_avg: Math.round(hisAvgCents(sig) ?? 0) }); return skip("price " + execC + "c vs his avg " + Math.round(hisAvgCents(sig)) + "c (>" + Math.round(COPY_GAP_REL * 100) + "%)"); }
    tr.stage(STAGE.PRICE_GATE_PASS);
    { const rb = v2ReserveBlocked(sig, target); if (rb) { tr.block("reserve_blocked"); return skip(rb); } }
    const ok = await buy(sig, Math.min(target, state.cash ?? 0), px, "open", positions, null, key, tr);
    if (meta?.s4) { mInc("s4CanaryIntent"); if (ok) mInc("s4CanaryFilled"); }
    if (ok) { buyTimes.push(Date.now()); seen[seenKey] = Date.now(); saveSeen(seen); }
  }

  // MY PICKS ONLY — hosted one-shot (deep audit 2026-08-04). The polled feed serves the whole
  // track's signals with no per-user filter, so a hosted bot could buy off whales its user never
  // picked. Filter against the same roster chainwatch subscribes to (/api/v1/copy-wallets: the
  // user's picks, or the full track for pick-less legacy accounts - where this is a no-op by
  // construction). Fail-closed: no roster yet -> no polled entries this pass (the fast path is
  // unaffected; copy-check enforces picks server-side either way).
  let myWallets = null, myWalletsAt = 0;
  async function refreshMyWallets() {
    if (myWallets && Date.now() - myWalletsAt < 5 * 60_000) return;
    try {
      const r = await cosmos.copyWallets();
      const list = (r?.wallets ?? []).map((x) => String(x.wallet).toLowerCase()).filter((x) => /^0x[a-f0-9]{40}$/.test(x));
      if (list.length) { myWallets = new Set(list); myWalletsAt = Date.now(); }
    } catch (e) { warn("copytrade picks roster:", e.message); }   // keep the last known roster
  }

  async function tick() {
    if (state.copytrade === false) return;                       // server turned the engine off -> stop trading
    if (Date.now() < budgetPausedUntil) return;                  // budget breaker: no entries until the window frees
    if (state.cash == null || state.sizing == null) return;      // no cycle data yet
    // FEED FETCH IS DECOUPLED FROM THE CYCLE (owner 2026-08-23: "crypto must be very fast").
    // The obvious saving - slow the whole cycle from 20s to 60s - would have cut invocations 3x but
    // ALSO aged state.cash/state.sizing, which the chainwatch fast path reads to size a candle
    // entry; crypto would have been sizing off up-to-60s-old cash. So the CYCLE stays at 20s (fast
    // path keeps fresh money data) and only the FEED fetch is throttled to FEED_MIN_MS. The server
    // caches that feed for 45s anyway, so two of every three fetches were returning a byte-identical
    // answer - this drops them without losing a single signal. Exits ride the feed and are
    // minute-scale, so a <=45s refresh is well inside their tolerance.
    let feed;
    const feedAge = Date.now() - lastFeedAt;
    if (feedAge >= FEED_MIN_MS || !lastFeed) {
      try { feed = await cosmos.copySignals(); lastFeed = feed; lastFeedAt = Date.now(); }
      catch (e) { warn("copytrade feed:", e.message); return; }
    } else {
      feed = lastFeed;   // inside the server's own cache window - identical bytes, no request
    }
    const signals = feed?.signals ?? [];
    // THE HUB IS A FILTER, NOT A REPLACEMENT (deliberate). The personal feed stays the source of
    // truth because the EXIT ladder rides on it: sell_seq for a position whose market is already
    // past its event never appears in the enterable set, and swapping the feed out would push every
    // one of those back onto per-position /copy-exit calls - re-opening the heaviest load on the
    // platform (~3,840 queries/min fleet-wide) to save a cheaper one. So exits read the full feed
    // exactly as before, and only the ENTRY scan is narrowed to what the hub vouched for.
    // V2 CALLERS ONLY (QA 2026-08-20, found independently by two reviewers). /copy-enterable is a
    // purely v2 verdict - the 30min-8h window and the v2 percentile ladder. v1 has no entry window
    // at all and a different ladder, so applying this filter to a v1 bot would silently suppress
    // almost everything it should buy: 88 of the 93 live bots, reading as a quiet market.
    const hubOk = V2() && hubFresh();
    const enterableKeys = hubOk
      ? new Set(hubSignals.map((s) => `${s.condition_id}|${String(s.outcome).toLowerCase()}`))
      : null;
    if (hubOk) stats.viaHub = (stats.viaHub ?? 0) + 1;
    // PUBLISH THE EXIT LADDER FROM THE FEED (DB-load fix 2026-08-06). Every signal row already
    // carries sell_seq, and the bot polls this feed every 20s - so bot.mjs can skip its per-position
    // /copy-exit call whenever the feed proves the ladder has not advanced past what the position
    // already executed. That call was the single heaviest load on the platform: 6 queries x every
    // open position x every cycle x every bot (~3,840 q/min fleet-wide, 9,600 at 25 positions).
    // Absent/stale keys are NOT skipped - the exit route stays authoritative for anything the feed
    // does not cover (inactive signals after a full exit, filtered rows).
    {
      const m = state.copySeq instanceof Map ? state.copySeq : new Map();
      for (const s2 of signals) {
        if (!s2?.condition_id) continue;
        m.set(`${s2.condition_id}|${String(s2.outcome ?? "").toLowerCase()}`, { seq: Number(s2.sell_seq) || 0, at: Date.now() });
      }
      if (m.size > 4000) m.clear();
      state.copySeq = m;
    }
    if (!signals.length) return;
    if (ONESHOT) { await refreshMyWallets(); if (!myWallets) return; }
    const positions = store.load();
    let openCopy = 0; for (const p of Object.values(positions)) if (copyLive(p)) openCopy++;   // dead dust does not fill a slot
    // "smaller amount per trade" (owner): the copy unit is a FRACTION of the dashboard per-trade size
    const unitBasis = sizeForSignal(state.sizing, { source: "copytrade", outcome: "Yes" }, state.portfolio, state.deployed) * UNIT_FRACTION;
    if (!(unitBasis > 0)) return;
    const exposureCap = ((state.portfolio || 0) * MAX_EXPOSURE_PCT) / 100;

    for (const sig of signals) {
      if (!sig.condition_id || !sig.token_id) continue;
      // STAGE 4 CANARY (owner 2026-08-30): for a canary whale the shared evaluation is the execution
      // authority. If the fast path already decided this market, this tick is observational for it -
      // it must not mint the same business intent off the row the old /copy-check wrote. A market the
      // fast path never saw is NOT suppressed: that is a missed fill and the sweep is its only
      // recovery, so it is counted instead (s4CanaryPolled).
      const tr = T(sig, "poll");
      tr.stage(STAGE.SEEN);
      const s4Verdict = s4authority.polledVerdict(sig);
      if (s4Verdict === "suppress" && !positions[sig.condition_id]) { tr.block("s4_marker_suppressed"); stats.s4Suppressed = (stats.s4Suppressed ?? 0) + 1; mInc("s4CanarySuppressed"); continue; }
      if (s4Verdict === "fallback") mInc("s4CanaryPolled");
      // HUB SHORTCUT: when the box-wide evaluation is fresh, anything it did not vouch for cannot
      // be entered by anyone, so skip the whole per-signal entry scan for it. Costs one Set lookup
      // and removes the duplicated window/tier/price arithmetic this loop used to redo per child.
      // ONLY applied to ENTRY candidates we do not already hold - a held position must still walk
      // the loop below for top-ups and for the exit bookkeeping the feed drives.
      if (enterableKeys && !positions[sig.condition_id]
          && !enterableKeys.has(`${sig.condition_id}|${String(sig.outcome).toLowerCase()}`)) { tr.block("hub_not_enterable", { hub_age_s: Math.round((Date.now() - hubAt) / 1000) }); stats.hubSkipped = (stats.hubSkipped ?? 0) + 1; mInc("skip"); continue; }
      tr.stage(STAGE.HUB_ENTERABLE);
      // ADOPT-ONLY users see ONLY adopt signals. The whale-fill copies (kind "new") are aviv's alone.
      if (state.copyFills === false && sig.kind !== "adopt") continue;
      // hosted: only signals driven by one of THIS user's picked wallets (see refreshMyWallets)
      if (ONESHOT && !(sig.wallets ?? []).some((x) => myWallets.has(String(x.wallet).toLowerCase()))) { tr.block("driver_not_picked"); continue; }
      tr.stage(STAGE.DRIVER_PICKED).stage(STAGE.ENGINE_READY);
      if ((recentBuy.get(sig.condition_id) ?? 0) > Date.now() - COOLDOWN_MS) { tr.block("cooldown"); continue; } // settle-window cooldown
      // pre-kickoff window is the LEGACY model; one-shot buys in-play behind the gap band instead
      if (!ONESHOT && sportsWindowClosed(sig)) { tr.block("pre_game_closed"); continue; }  // retry bound: never buy inside the last 10min pre-kickoff
      let { target } = sizeFor(sig, unitBasis, state.portfolio);
      if (!(target > 0)) { tr.block("tier_zero", { his_usd: Math.round(Number(sig.his_cost_usd) || 0), port: Math.round(state.portfolio || 0) }); continue; }
      tr.stage(STAGE.TIER_RESOLVED).stage(STAGE.TARGET_SIZED).note("target", Number(target.toFixed(2)));
      stats.signals++;

      // our copy position on THIS exact (market, side): the primary cid slot, or the composite key we
      // use for the opposite side when two whales split a market (owner: buy the opposite too).
      const primary = positions[sig.condition_id];
      const compKey = `${sig.condition_id}#${sig.token_id}`;
      const sameSide = (p) => p && String(p.outcome).toLowerCase() === String(sig.outcome).toLowerCase();
      let mine = null;
      if (primary?.source === "copytrade" && sameSide(primary)) mine = primary;
      else if (positions[compKey]?.source === "copytrade") mine = positions[compKey];

      // Same $1 floor as the fast path: 5% of a sub-$20 portfolio is below the exchange minimum.
      const posCeil = Math.max(MIN_ORDER_USD, ((state.portfolio || 0) * MAX_POSITION_PCT) / 100);   // per-position ceiling (owner incident 2026-07-22)
      if (mine) {
        if (ONESHOT && !V2()) { tr.block("already_holding"); continue; }   // v2 tops up to the escalated tier target
        if (V2() && (Number(sig.sell_seq) || 0) > 0) { tr.block("no_rebuy"); continue; }   // never rebuy after an exit (v2)
        // the same authority rule applies to a TOP-UP: for a canary whale's decided market the fast
        // path owns the size, and this tick must not add on top of it from the old row
        if (s4Verdict === "suppress") { tr.block("s4_marker_suppressed"); stats.s4Suppressed = (stats.s4Suppressed ?? 0) + 1; mInc("s4CanarySuppressed"); continue; }
        const add = Math.min(target, posCeil) - (Number(mine.size_usd) || 0);
        if (add < MIN_ADD_USD) { tr.block("add_below_min"); continue; }                                // at the ceiling or no transition worth an order
        if (rateLimited()) { tr.block("rate_limited"); continue; }
        if (copyExposure(positions) + add > exposureCap) { tr.block("exposure_cap"); continue; }      // copytrade never exceeds its slice
        // ALREADY IN: he's reinforcing, so we follow him up — but an adopt add stays inside the
        // ±20c-of-his-entry band (addCapFor); only non-adopt whale-fill adds ride to the flat cap.
        const px = await priceFor(sig.token_id, addCapFor(sig), MIN_ADD_CENTS);
        if (px == null) { tr.block("price_out_of_band"); continue; }
        if (v2ReserveBlocked(sig, add)) { tr.block("reserve_blocked"); continue; }
        const ok = await buy(sig, Math.min(add, state.cash ?? 0), px, "add", positions, mine, sig.condition_id, tr);
        if (ok) buyTimes.push(Date.now());
      } else {
        // v2 entry window - the "scan all the time" path. Skipping here costs nothing: this loop
        // runs every ~20s, so the position opens on the first cycle after the market crosses inside.
        tr.stage(STAGE.HOLDING_RESOLVED);
        if (outsideV2Window(sig, V2())) { const late = tooLateV2(sig, V2()); tr.block(late ? "window_dead" : "window_wait", { h_left: Number(hoursLeft(sig).toFixed(2)) }); if (!late) stats.waiting++; continue; }
        tr.stage(STAGE.WINDOW_OPEN);
        target = Math.min(target, posCeil);                             // per-position ceiling on the opening clip
        if (target < MIN_ORDER_USD) { tr.block("target_below_min"); continue; }   // first beat not reached (or capped below $1)
        if (!ONESHOT && openCopy >= MAX_OPEN) { tr.block("max_open"); continue; }
        if (rateLimited()) { tr.block("rate_limited"); continue; }
        // pick the store key: free primary slot -> cid; primary holds the OPPOSITE side -> composite key
        // (hold both). Primary holds the SAME side already (any engine) -> don't stack, skip.
        const key = primary ? (sameSide(primary) ? null : compKey) : sig.condition_id;
        if (!key || positions[key]) { tr.block("already_holding"); continue; }
        // BUY-ONCE-EVER: a (market, side) we already opened once is never re-opened — kills the
        // salvage->cooldown->re-buy loop that shoveled $148 into one dying candle side.
        const seenKey = `${sig.condition_id}#${sig.token_id}`;
        if (seen[seenKey]) { tr.block("buy_once"); continue; }
        if (!ONESHOT && copyExposure(positions) + target > exposureCap) { tr.block("exposure_cap"); continue; }   // legacy only - one-shot has no exposure cap (owner 2026-08-06)
        // NEW ENTRY: hard 92c cap + 10c floor (owner + blowup forensics).
        // PAIR LEG (is_pair): the whale holds BOTH sides — we mirror both, so this leg is half of a
        // hedge, not a directional bet. The 92c cap and 10c floor DON'T apply: a 96c/3c pair is a good
        // arb, and refusing the 96c half would leave us naked on the 3c half. The server has already
        // verified both legs together cost less than the $1 redemption; its max_entry_cents is the cap.
        const capMax2 = Math.min(
          V2() ? V2_MAX_ENTRY_CENTS : 99,
          String(sig.category).toUpperCase() === "SPORTS" ? 99 : MAX_ENTRY_CENTS,
        );
        const cap = sig.is_pair
          ? Math.min(99, Number(sig.max_entry_cents) || 99)
          : Math.min(capMax2, Number(sig.max_entry_cents) || capMax2);
        const floor = sig.is_pair ? 1 : (String(sig.category).toUpperCase() === "SPORTS" ? 3 : MIN_ENTRY_CENTS);
        const band = inPlayBand(sig, cap, floor);          // in-play (hosted): within ±20c of HIS avg entry
        const px = await priceFor(sig.token_id, band.cap, band.floor);
        if (px == null) { tr.block("price_out_of_band", { cap: band.cap, floor: band.floor, mid: lastMid.get(sig.token_id) ?? null }); continue; }
        tr.stage(STAGE.PRICED);
        // Same first-leg gate as the fast path (owner 2026-08-18): unconditional under v2, and the
        // polled ADD path above is likewise exempt because it is already in the position.
        if ((ONESHOT || V2()) && tooFarFromHisEntry(sig, lastMid.get(sig.token_id) ?? px, holdsPairSibling(positions, sig))) { tr.block("price_gate", { mid: lastMid.get(sig.token_id) ?? px, his_avg: Math.round(hisAvgCents(sig) ?? 0) }); continue; }   // >20% (rel) from his avg entry - too late (owner 2026-08-06)
        tr.stage(STAGE.PRICE_GATE_PASS);
        if (v2ReserveBlocked(sig, target)) { tr.block("reserve_blocked"); continue; }
        const ok = await buy(sig, Math.min(target, state.cash ?? 0), px, "open", positions, null, key, tr);
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
        onSignal: (sig, meta) => fastOpen(sig, meta),
        s4Ctx: () => ({ hosted: HOSTED, v2: V2(), copytrade: state.copyFills === true }),   // stage 4 shadow: this child's own variant, compare only
      }))
      .catch((e) => warn("chainwatch failed to start:", e?.message));
  }

  (async function run() {
    log(`copytrade: engine ON · unit=${UNIT_FRACTION}x dashboard size · exposure≤${MAX_EXPOSURE_PCT}% · ${MIN_ENTRY_CENTS}-${MAX_ENTRY_CENTS}c entries · ≤${MAX_BUYS_PER_HOUR} buys/h · max ${MAX_OPEN} open · buy-once · poll ${POLL_MS}ms${DRY ? " · DRY RUN" : ""}`);
    const si = setInterval(() => log(`copytrade … signals ${stats.signals} · opens ${stats.opens} · adds ${stats.adds} · fills ${stats.fills}${stats.viaHub ? ` · hub ${stats.viaHub} cycles, ${stats.hubSkipped ?? 0} skipped` : ""}${stats.waiting ? ` · waiting-for-window ${stats.waiting}` : ""}`), 120_000);
    while (alive) {
      const t0 = Date.now();
      try { await tick(); } catch (e) { warn("copytrade:", e?.message); }
      await new Promise((res) => setTimeout(res, Math.max(2000, POLL_MS - (Date.now() - t0))));
    }
    clearInterval(si);
  })();
  return () => { alive = false; };
}
