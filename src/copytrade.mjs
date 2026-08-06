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
import { targetPctForHolding } from "./candle-sizing.mjs";
// FIX (2026-08-03, first live fleet): oneShotTarget called pctFromAutoTiers and read TIER_MAX_PCT
// with NEITHER in scope - a ReferenceError on every non-candle one-shot copy, so the hosted fleet
// could only ever copy candle signals. Proven by executing the committed function in isolation.
import { pctFromAutoTiers, ONESHOT_CAP_PCT } from "./tier-sizing.mjs";
import { log, warn } from "./log.mjs";

const N = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };
const DRY = process.env.COPYTRADE_DRY === "1";
const POLL_MS = N("COPY_POLL_MS", 20_000);
const MAX_OPEN = N("COPY_MAX_OPEN", Infinity);    // owner 2026-07-15: NO position-count cap at all. The 20%% exposure cap (dust-free) is the only guard now. Set COPY_MAX_OPEN to re-impose a count limit.
const MIN_ORDER_USD = N("COPY_MIN_USD", 1);       // Polymarket ~$1 min order = "the first beat"
const MIN_ADD_USD = N("COPY_MIN_ADD_USD", 1);     // smallest scale-in increment worth an order
const COOLDOWN_MS = N("COPY_COOLDOWN_MS", 60_000); // per-market: don't re-buy within the on-chain settle window
// Owner 2026-07-13: never OPEN a new copy above 92c (95c risks 95c to win 5c). But once we're IN, if the
// whale keeps adding we follow him up — scale-ins are capped only by the sanity ceiling.
const MAX_ENTRY_CENTS = N("COPY_MAX_ENTRY_CENTS", 92); // new positions
const MAX_ADD_CENTS = N("COPY_MAX_ADD_CENTS", 97);     // scaling into a position we already hold
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
const tooFarFromHisEntry = (sig, execCents) => {
  if (sig.is_pair) return false;
  const avg = hisAvgCents(sig);
  if (avg == null || !(execCents > 0)) return false;
  const tol = Math.max(avg * COPY_GAP_REL, 5);
  return Math.abs(execCents - avg) > tol;
};
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
const isCandleSig = (sig) => /up or down/i.test(String(sig?.market_question ?? ""));

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

const ONESHOT_MIN_PORTFOLIO_USD = N("COPY_MIN_PORTFOLIO_USD", 75); // owner 2026-08-04: under \$75, no entries at all

function targetUsd(sig, unit, portfolio) {
  // HOSTED FLOOR (owner 2026-08-04): a portfolio under \$75 places NO entries - candle or whale.
  // Bot-side so the fleet does not burn sign-gate calls on orders the gate would refuse anyway;
  // the gate enforces the same line server-side. Exits are unaffected (this sizes entries only),
  // and legacy self-hosted bots (ONESHOT off) are untouched.
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
  const lastMid = new Map();   // token -> last mid read by priceFor (see the gap guard below)
  // BUDGET CIRCUIT-BREAKER (incident 2026-08-06): with the exposure cap gone, bots reach the cloud
  // gate's rolling-24h ceiling (100% of portfolio in gross buys - the drain-defense hard floor) and
  // then every NEW signal fired a fresh sign request: 999 denials/90min hammered /api/cloud/sign
  // into 5xx and starved the DB. A day/hour-budget denial now pauses ALL copy entries for
  // COPY_BUDGET_PAUSE_MIN (default 30) - the window is rolling, so capacity frees continuously and
  // one probe per pause window is enough. Exits are never paused.
  let budgetPausedUntil = 0;
  const BUDGET_PAUSE_MS = (Number(process.env.COPY_BUDGET_PAUSE_MIN) > 0 ? Number(process.env.COPY_BUDGET_PAUSE_MIN) : 30) * 60_000;
  const bumpSkip = (why) => {
    const key = String(why).replace(/[0-9$.]+/g, "#").slice(0, 40);
    skipCounts.set(key, (skipCounts.get(key) ?? 0) + 1);
  };
  const recentBuy = new Map(); // cid -> ts (settle-window cooldown; also throttles scale-in cadence)
  const seen = loadSeen();     // (cid#token) -> ts of first OPEN — never re-open (persisted)
  const buyTimes = [];         // sliding-window rate limit
  const stats = { signals: 0, opens: 0, adds: 0, fills: 0 };
  let alive = true;

  async function priceFor(tokenId, capCents, floorCents) {
    const mid = await pm.getPriceCents(tokenId);
    if (mid == null) return null;
    lastMid.set(tokenId, mid);   // the executable price; priceFor RETURNS the FAK ceiling, not this

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

  async function buy(sig, orderUsd, priceCents, kind, positions, existing, key = sig.condition_id) {
    const shares = Math.max(Math.ceil(100 / priceCents), sharesFor(orderUsd, priceCents));
    const realUsd = (shares * priceCents) / 100;
    if (realUsd > (state.cash ?? 0)) return false;
    const who = (sig.wallets?.[0]?.username) || (sig.wallets?.[0]?.wallet || "").slice(0, 8);
    const tag = `${sig.category} ${sig.outcome} @${priceCents}c · ${kind} $${realUsd.toFixed(2)} · via ${who} ($${Math.round(Number(sig.his_cost_usd) || 0).toLocaleString()} in)`;
    if (DRY) { log(`copytrade DRY would ${kind === "open" ? "OPEN" : "ADD"} ${tag} · ${String(sig.market_question || "").slice(0, 40)}`); recentBuy.set(sig.condition_id, Date.now()); return true; } // DRY returns true so seen/rate-limit apply like a real fill

    // Lock the market BEFORE placing (deep-check #10): fastOpen and the polled tick each load their own
    // positions snapshot, so without this a sub-second race could double-buy the same signal.
    recentBuy.set(sig.condition_id, Date.now());
    const r = await placeWithRetry(pm, { tokenId: sig.token_id, side: "BUY", sizeShares: shares, priceCents, orderType: "FAK" }, 2, 100);
    if (!r.ok) {
      // Failed FAK must NOT burn the full 60s cooldown (deep-check #6): on a 5-min candle that lockout
      // IS the missed entry. Leave a 5s breather, then either path may retry while the market lives.
      recentBuy.set(sig.condition_id, Date.now() - COOLDOWN_MS + 5_000);
      // Log the REASON, not just the status: "open failed: 400" hid that the local risk governor
      // (not Polymarket) was refusing every buy for two days (2026-07-26 incident).
      const why = String(r.body?.polymarket?.error ?? r.error ?? r.err ?? r.status ?? "");
      if (r.cloudCode === "day_budget" || r.cloudCode === "hour_budget" || /exceed the (daily|hourly) budget/i.test(why)) {
        budgetPausedUntil = Date.now() + BUDGET_PAUSE_MS;
        bumpSkip("budget-paused");
        warn(`copytrade BUDGET reached (${r.cloudCode || "budget"}) - pausing ALL entries ${Math.round(BUDGET_PAUSE_MS / 60000)}min (rolling window frees capacity; exits unaffected)`);
      }
      warn(`copytrade ${kind} failed: ${why.slice(0, 120)}`); return false;
    }
    stats.fills++;
    cosmos.meter({ ...r.meta, source: "copytrade" }).catch(() => {}); // fire-and-forget: the trading loop must NEVER block on the metering relay (a hung await here froze tick() for 12.5h on 07-21)

    // ACTUAL FILL (2026-07-19): placeOrder now reports what MATCHED — a FAK cap routinely fills fewer
    // shares at a better price than the cap (a "97c" order really filled 3.96 sh @ 49c). Track and
    // ledger the FILL; fall back to the request only when the response carried no fill info.
    const fillShares = Number(r.meta?.size) > 0 ? Number(r.meta.size) : shares;
    const fillCents = Number(r.meta?.price) > 0 ? Number(r.meta.price) : priceCents;
    const fillUsd = Number(((fillShares * fillCents) / 100).toFixed(2));

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
  function sizeFor(sig, unitBasis, portfolio) {
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

  async function fastOpen(sig) {
    if (state.copytrade === false) return;
    if (Date.now() < budgetPausedUntil) return;   // budget breaker: no entries until the window frees
    // The fast path IS the whale-fill path. A bot that only has the adopt flag must never take one.
    if (state.copyFills === false) return;
    if (state.cash == null || state.sizing == null) return;      // no cycle data yet -> can't size
    const positions = store.load();
    let openCopy = 0; for (const p of Object.values(positions)) if (copyLive(p)) openCopy++;   // dead dust does not fill a slot
    const unitBasis = sizeForSignal(state.sizing, { source: "copytrade", outcome: "Yes" }, state.portfolio, state.deployed) * UNIT_FRACTION;
    if (!(unitBasis > 0)) return;
    const exposureCap = ((state.portfolio || 0) * MAX_EXPOSURE_PCT) / 100;
    // RATIO SIZING (owner's spec, "the beats"): our_$ = his_$ x (our_unit / his_avg_trade_$), capped at
    // the ceiling. The chain gives his exact share count, so copy-check prices his money-in and this
    // path sizes IDENTICALLY to the polled one — a flat unit would buy the same off a $50 dab as off a
    // $50,000 conviction. Below the $1 Polymarket minimum ("the first beat") we simply don't buy.
    let { target } = sizeFor(sig, unitBasis, state.portfolio);
    // TRACE EVERY REFUSAL (deep-check forensics): the server logs every verdict, but the bot refused
    // silently — 38 approved markets got no order in 24h and NOTHING said why. One line per skip.
    const skip = (why) => { bumpSkip(why); log(`copytrade fast-skip ${sig.category} ${sig.outcome}: ${why} · ${String(sig.market_question || "").slice(0, 32)}`); };
    if (!(target > 0)) return skip("beats=0 (his $" + Math.round(Number(sig.his_cost_usd) || 0) + " vs avg $" + Math.round(Number(sig.wallets?.[0]?.avg_trade_usd) || 0) + ")");
    // pre-kickoff window is the LEGACY model; one-shot buys in-play behind the gap band instead
    if (!ONESHOT && sportsWindowClosed(sig)) return skip(`pre-game window closed (<${SPORTS_MIN_LEFT_MIN}m to kickoff)`);

    if ((recentBuy.get(sig.condition_id) ?? 0) > Date.now() - COOLDOWN_MS) return skip("cooldown");
    if (target < MIN_ORDER_USD) return skip("target $" + target.toFixed(2) + " < $1 min");
    // NO POSITION-COUNT / EXPOSURE LIMITS in one-shot (owner 2026-08-06: "delete this rule - we just
    // look at 3% of the total portfolio"). Sizing (3%, $4 floor, 7% per-position cap), buy-once-ever,
    // cash itself and the 30/h rate brake are the remaining guards. Legacy keeps both caps.
    if (!ONESHOT && openCopy >= MAX_OPEN) return skip("MAX_OPEN " + openCopy);
    if (rateLimited()) return skip("rate limit " + MAX_BUYS_PER_HOUR + "/h");
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
      if (ONESHOT) return;      // one-shot: we are already in, and we never follow him up
      const held = Number(mine.size_usd) || 0;
      // Never let one position grow past the per-position ceiling, whatever the target says.
      let add = Math.min(target, posCeil) - held;
      if (add < MIN_ADD_USD) return;                              // at/over the ceiling or fully sized (steady-state)
      if (!ONESHOT && copyExposure(positions) + add > exposureCap) return skip("exposure cap (add $" + add.toFixed(2) + ")");
      const px = await priceFor(sig.token_id, addCapFor(sig), MIN_ADD_CENTS);
      if (px == null) return skip("add price out of band");
      const ok = await buy(sig, Math.min(add, state.cash ?? 0), px, "add", positions, mine);
      if (ok) buyTimes.push(Date.now());
      return;
    }
    const key = primary ? compKey : sig.condition_id;             // opposite side held -> composite key
    if (positions[key]) return skip("already hold this side");
    const seenKey = compKey;
    if (seen[seenKey]) return skip("buy-once-ever");
    target = Math.min(target, posCeil);                          // per-position ceiling on the opening clip too
    if (target < MIN_ORDER_USD) return skip("per-position cap below $1 min");
    if (!ONESHOT && copyExposure(positions) + target > exposureCap) return skip("exposure cap ($" + copyExposure(positions).toFixed(2) + "+$" + target.toFixed(2) + ">$" + exposureCap.toFixed(2) + ")");
    const capMax = String(sig.category).toUpperCase() === "SPORTS" ? 99 : MAX_ENTRY_CENTS;   // sports band 3-99c (owner 2026-07-15)
    const cap = sig.is_pair
      ? Math.min(99, Number(sig.max_entry_cents) || 99)
      : Math.min(capMax, Number(sig.max_entry_cents) || capMax);
    const floor = sig.is_pair ? 1 : (String(sig.category).toUpperCase() === "SPORTS" ? 3 : MIN_ENTRY_CENTS);
    const band = inPlayBand(sig, cap, floor);            // in-play (hosted): within ±20c of HIS avg entry
    const px = await priceFor(sig.token_id, band.cap, band.floor);
    if (px == null) return skip("price out of band (cap " + band.cap + "c)");
    const execC = lastMid.get(sig.token_id) ?? px;
    if (ONESHOT && tooFarFromHisEntry(sig, execC)) return skip("price " + execC + "c vs his avg " + Math.round(hisAvgCents(sig)) + "c (>" + Math.round(COPY_GAP_REL * 100) + "%)");
    const ok = await buy(sig, Math.min(target, state.cash ?? 0), px, "open", positions, null, key);
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
    let feed;
    try { feed = await cosmos.copySignals(); } catch (e) { warn("copytrade feed:", e.message); return; }
    const signals = feed?.signals ?? [];
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
      // ADOPT-ONLY users see ONLY adopt signals. The whale-fill copies (kind "new") are aviv's alone.
      if (state.copyFills === false && sig.kind !== "adopt") continue;
      // hosted: only signals driven by one of THIS user's picked wallets (see refreshMyWallets)
      if (ONESHOT && !(sig.wallets ?? []).some((x) => myWallets.has(String(x.wallet).toLowerCase()))) continue;
      if ((recentBuy.get(sig.condition_id) ?? 0) > Date.now() - COOLDOWN_MS) continue; // settle-window cooldown
      // pre-kickoff window is the LEGACY model; one-shot buys in-play behind the gap band instead
      if (!ONESHOT && sportsWindowClosed(sig)) continue;  // retry bound: never buy inside the last 10min pre-kickoff
      let { target } = sizeFor(sig, unitBasis, state.portfolio);
      if (!(target > 0)) continue;
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
        if (ONESHOT) continue;    // one-shot: we are already in, and we never follow him up
        const add = Math.min(target, posCeil) - (Number(mine.size_usd) || 0);
        if (add < MIN_ADD_USD) continue;                                // at the ceiling or no transition worth an order
        if (rateLimited()) continue;
        if (copyExposure(positions) + add > exposureCap) continue;      // copytrade never exceeds its slice
        // ALREADY IN: he's reinforcing, so we follow him up — but an adopt add stays inside the
        // ±20c-of-his-entry band (addCapFor); only non-adopt whale-fill adds ride to the flat cap.
        const px = await priceFor(sig.token_id, addCapFor(sig), MIN_ADD_CENTS);
        if (px == null) continue;
        const ok = await buy(sig, Math.min(add, state.cash ?? 0), px, "add", positions, mine);
        if (ok) buyTimes.push(Date.now());
      } else {
        target = Math.min(target, posCeil);                             // per-position ceiling on the opening clip
        if (target < MIN_ORDER_USD) continue;                           // first beat not reached (or capped below $1)
        if (!ONESHOT && openCopy >= MAX_OPEN) continue;
        if (rateLimited()) continue;
        // pick the store key: free primary slot -> cid; primary holds the OPPOSITE side -> composite key
        // (hold both). Primary holds the SAME side already (any engine) -> don't stack, skip.
        const key = primary ? (sameSide(primary) ? null : compKey) : sig.condition_id;
        if (!key || positions[key]) continue;
        // BUY-ONCE-EVER: a (market, side) we already opened once is never re-opened — kills the
        // salvage->cooldown->re-buy loop that shoveled $148 into one dying candle side.
        const seenKey = `${sig.condition_id}#${sig.token_id}`;
        if (seen[seenKey]) continue;
        if (!ONESHOT && copyExposure(positions) + target > exposureCap) continue;   // legacy only - one-shot has no exposure cap (owner 2026-08-06)
        // NEW ENTRY: hard 92c cap + 10c floor (owner + blowup forensics).
        // PAIR LEG (is_pair): the whale holds BOTH sides — we mirror both, so this leg is half of a
        // hedge, not a directional bet. The 92c cap and 10c floor DON'T apply: a 96c/3c pair is a good
        // arb, and refusing the 96c half would leave us naked on the 3c half. The server has already
        // verified both legs together cost less than the $1 redemption; its max_entry_cents is the cap.
        const capMax2 = String(sig.category).toUpperCase() === "SPORTS" ? 99 : MAX_ENTRY_CENTS;  // sports band 3-99c (owner 2026-07-15)
        const cap = sig.is_pair
          ? Math.min(99, Number(sig.max_entry_cents) || 99)
          : Math.min(capMax2, Number(sig.max_entry_cents) || capMax2);
        const floor = sig.is_pair ? 1 : (String(sig.category).toUpperCase() === "SPORTS" ? 3 : MIN_ENTRY_CENTS);
        const band = inPlayBand(sig, cap, floor);          // in-play (hosted): within ±20c of HIS avg entry
        const px = await priceFor(sig.token_id, band.cap, band.floor);
        if (px == null) continue;
        if (ONESHOT && tooFarFromHisEntry(sig, lastMid.get(sig.token_id) ?? px)) continue;   // >20% (rel) from his avg entry - too late (owner 2026-08-06)
        const ok = await buy(sig, Math.min(target, state.cash ?? 0), px, "open", positions, null, key);
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
        onSignal: (sig) => fastOpen(sig),
      }))
      .catch((e) => warn("chainwatch failed to start:", e?.message));
  }

  (async function run() {
    log(`copytrade: engine ON · unit=${UNIT_FRACTION}x dashboard size · exposure≤${MAX_EXPOSURE_PCT}% · ${MIN_ENTRY_CENTS}-${MAX_ENTRY_CENTS}c entries · ≤${MAX_BUYS_PER_HOUR} buys/h · max ${MAX_OPEN} open · buy-once · poll ${POLL_MS}ms${DRY ? " · DRY RUN" : ""}`);
    const si = setInterval(() => log(`copytrade … signals ${stats.signals} · opens ${stats.opens} · adds ${stats.adds} · fills ${stats.fills}`), 120_000);
    while (alive) {
      const t0 = Date.now();
      try { await tick(); } catch (e) { warn("copytrade:", e?.message); }
      await new Promise((res) => setTimeout(res, Math.max(2000, POLL_MS - (Date.now() - t0))));
    }
    clearInterval(si);
  })();
  return () => { alive = false; };
}
