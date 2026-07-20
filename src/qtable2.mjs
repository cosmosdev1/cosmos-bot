// qtable2.mjs — QTABLE candle engine, CORRECTED, integrated into the fleet bot.
//
// This is the fixed successor to qtable.mjs (which used the pre-refit table + Binance spot — the fit
// bug that ran −18.6% in 24h). It mirrors the validated standalone tester (qtable-live.mjs) EXACTLY:
//   • Chainlink RTDS reference + spot (wss://ws-live-data.polymarket.com) — the price Polymarket
//     resolves these candles on (exact, not Binance-approximated).
//   • the REFIT tow-aware table (qtable-live-data.json): conditional fit, 50 time-of-week buckets.
//   • STRICT guards: |d|≥5bps, elapsed 10–95%, ≥90s left, P≥50%, price floor 5–97c, multiplicative
//     edge (P/ask) in [EDGE, MAX_EDGE], Chainlink-spot staleness cutoff. CANDLES ONLY.
//   • $2 marketable FAK placed through the bot's OWN pm/placeWithRetry (builder code already applied).
//
// Spawned from main() ONLY when QTABLE2_ENABLED=1 (per-deployment gate — set as a Fly secret on ONE
// user's app; every other bot leaves the flag unset and never even imports this file). Runs as a fast
// ~250ms side-loop next to the 30s cycle. DRY: QTABLE2_DRY=1 logs would-be fills, places nothing.
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { log, warn } from "./log.mjs";

// The bot runs on node:20-slim, which has NO global WebSocket. Without this the Chainlink RTDS feed
// silently retries forever (the reconnect catch swallows the ReferenceError) and the engine never gets
// spot -> never signals. Fall back to the `ws` package (already a transitive dep, pinned in package.json).
const WSImpl = globalThis.WebSocket ?? (await import("ws")).WebSocket;
const WS_OPTS = globalThis.WebSocket ? undefined : { headers: { Origin: "https://polymarket.com" } };

const N = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };
const STAKE = N("QTABLE2_STAKE_USD", 0);        // fixed $/trade override; 0 (default) = account's dashboard % sizing (e.g. 3%)
const EDGE = N("QTABLE2_EDGE", 1.15);           // multiplicative: P / best-ask (1.08 -> 1.10 -> 1.15, owner 2026-07-14 off the 24h replay)
const MAX_OPEN = N("QTABLE2_MAX_OPEN", 8);
const TICK_MS = N("QTABLE2_TICK_MS", 250);
const DRY = process.env.QTABLE2_DRY === "1";
// guards — identical to the validated qtable-live engine
const MIN_D = 0.0005, MIN_ELAPSED = 10, MAX_ELAPSED = 95, MIN_REMAIN_S = 90;
// Tiered entry — RECALIBRATED 2026-07-13 from the 78-trade live audit: the 35-54% band lost money
// under every rule-set tested (0/2 even with the persistence guard), so the default floor is back at
// 55%. The tier machinery stays env-enabled (QTABLE2_MIN_P=0.35 re-opens the mid band).
const MIN_P = N("QTABLE2_MIN_P", 0.55);         // absolute floor — never trade a side below this model prob
const HIGH_P = N("QTABLE2_HIGH_P", 0.55);       // p >= HIGH_P uses EDGE; MIN_P..HIGH_P uses the stricter EDGE_MID
const EDGE_MID = N("QTABLE2_EDGE_MID", 1.18);   // required edge (P/ask) on the mid band (if re-opened)

// EDGE FLOOR + WINDOW HARDENING (owner 2026-07-14). The base floor is now 1.15, chosen off a 24h
// replay of all 492 candles: at 1.10-1.30 the model made +$11 (its live result, reproduced to within
// 0.1pp by the replay); at a 1.15 floor with no ceiling it made +$45 on the same capital.
// The earlier "+2pp" hardening is folded INTO that 1.15 base, so the bump is now only the extra
// strictness inside the owner's 16:00-18:30 Israel window (Mon-Fri), where fills are worst: 1.16.
const EDGE_BUMP = N("QTABLE2_EDGE_BUMP", 0);               // base floor already carries the hardening
const EDGE_BUMP_PEAK = N("QTABLE2_EDGE_BUMP_PEAK", 0.01);  // instead of EDGE_BUMP inside the window
const PEAK_TZ = process.env.QTABLE2_PEAK_TZ || "Asia/Jerusalem";
const PEAK_FROM_MIN = N("QTABLE2_PEAK_FROM", 16 * 60);     // 16:00
const PEAK_TO_MIN = N("QTABLE2_PEAK_TO", 18 * 60 + 30);    // 18:30
// Mon..Fri in the owner's own timezone — DST-correct, because the wall clock is what he specified.
function inPeakWindow(now = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: PEAK_TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, hourCycle: "h23",
  }).formatToParts(now);
  const get = (t) => p.find((x) => x.type === t)?.value ?? "";
  const day = get("weekday");                               // Mon Tue Wed Thu Fri Sat Sun
  if (!["Mon", "Tue", "Wed", "Thu", "Fri"].includes(day)) return false;
  const mins = Number(get("hour")) * 60 + Number(get("minute"));
  return mins >= PEAK_FROM_MIN && mins < PEAK_TO_MIN;
}
const edgeBump = () => (inPeakWindow() ? EDGE_BUMP_PEAK : EDGE_BUMP);
const edgeReqFor = (p) => (p >= HIGH_P ? EDGE : EDGE_MID) + edgeBump(); // (only called when p >= MIN_P)
// Entry price band 5-97c -> 7-90c (owner 2026-07-14, same replay): below 7c the spread eats the
// edge, above 90c you risk 90c to win 10c and the winners are already priced.
const MIN_PRICE = N("QTABLE2_MIN_PRICE", 0.10), MAX_PRICE = N("QTABLE2_MAX_PRICE", 0.90);   // 7c floor went 0-for-2 live (-100% of stake) - back to 10c
const STALE_MS = N("QTABLE2_MAX_SPOT_AGE_MS", 8000);
// CEILING REMOVED (owner 2026-07-14). The 1.30 cap came from a 78-fill audit on 2026-07-13 ("every
// trade with edge >1.30 lost, 0/7 above 1.5"). The 24h replay of ALL 492 candles says the opposite —
// the trades above 1.30 were the most profitable in the book, and the cap alone cost +$22/day. That
// old audit predates the persistence guard and the Chainlink-reference fix, i.e. it was very likely
// measuring the fake edges those bugs manufactured, not real ones.
// WATCH THIS: the ±3s prints show these entries land just before a 16-30c repricing, so the fills are
// the risk, not the signal. Re-cap instantly with QTABLE2_MAX_EDGE=1.30 if slippage shows up.
//
// IT SHOWED UP. Uncapped, 2026-07-14 16:54->19:00 UTC: 13 markets, -$7.36 on $34.86 staked (-21% of
// stake, vs -9% under the cap in the same session). Every sub-20c entry the uncapped model reached for
// was a total wipeout (2 of 2, -$6.12, -100%). This is the SAME failure the engine was paused for on
// 07-09: a big edge number is the model being WRONG about a cheap token, not a bargain - P is inflated
// exactly where the ask is thin. The 24h replay that said "uncapped is worth +$22/day" was fitting that
// error, not measuring it. Cap restored; do not remove it again without an OUT-OF-SAMPLE test.
const MAX_EDGE = N("QTABLE2_MAX_EDGE", 1.30);
// ---- DEEP-CHECK GUARDS (2026-07-15, fleet forensics: -$1,211 on $6,026 over 72h) ----
// LEADING SIDE ONLY. Calibration by signed d: buying the side spot moved AGAINST ("mean-revert",
// |d|>=5bps) claimed ~35% and won 17% (-47% ROI); the |d|<2.5bps noise zone was a coin flip sold as
// 57%. Only the side spot ALREADY favors, by at least this margin, was honestly priced. Kills the two
// regions that carried -$803 of the -$1,211.
const LEAD_D = N("QTABLE2_LEAD_D", 0.00025);        // 2.5bps: Up needs d >= +LEAD_D, Down needs d <= -LEAD_D
// DISAGREEMENT BAND — the 07-09 pause's revival condition that never got built. The model may not
// claim more than this many points above the market: p - ask <= band. The 60-69c kill zone (claimed
// 69-79%, won 50%, -$34 in 48h on one account) and every thin-cell P=1.0 buy die here.
const MAX_DISAGREE = N("QTABLE2_MAX_DISAGREE", 0.10);
// ENTRY GATE REWORK (owner 2026-07-20, "3 signals in a minute then 0 for 10 hours"): the
// multiplicative edge floor (>=1.15) and the disagreement cap (<=10pp) CONTRADICT each other above
// ~50c asks - at a 64c ask the corridor is 0.4pp wide, above ~66c it is empty. That is why the
// fleet went silent while one env-loosened bot printed all day. The pause research's real finding
// was that ABSOLUTE divergence of 4-10pp is the profitable set (>=4pp +10.8%/$, n=128; >12pp
// negative), so the absolute band is now the PRIMARY gate: 4pp <= P-ask <= 10pp. The multiplicative
// floor is retired (MAX_EDGE stays as the too-good-to-be-true cap). QTABLE2_MIN_DISAGREE tunes it.
const MIN_DISAGREE = N("QTABLE2_MIN_DISAGREE", 0.04);
const minDisagreeReq = () => MIN_DISAGREE + edgeBump(); // the Mon-Fri peak window still adds +1pp
// PERSISTENCE GUARD (the root-cause fix, 2026-07-13): the audit showed the bot entered on sub-second
// d spikes that reverted before settlement (recorded d disagreed with the settled d in 65/78 trades,
// overstating P by ~18pp). Require the displacement to have ALREADY HELD PERSIST_S seconds ago — same
// sign, still >= MIN_D — read from the in-memory Chainlink buffer. ZERO added latency: the order still
// fires the same instant off the live tick; we only additionally check a past tick we already hold.
const PERSIST_S = N("QTABLE2_PERSIST_S", 6);
const spotAt = (sym, atMs) => {  // latest buffered tick at/just before atMs (null if none)
  const h = hist[sym]; if (!h?.length || h[0].t > atMs) return null;
  let v = null; for (const x of h) { if (x.t > atMs) break; v = x.v; }
  return v;
};

const FRAME_MS = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000 };
const TABLE_FRAME = { "5m": "5m", "15m": "15m", "1h": "1h" };
const WS_SYM = { "btc/usd": "BTCUSDT", "eth/usd": "ETHUSDT", "sol/usd": "SOLUSDT", "xrp/usd": "XRPUSDT", "doge/usd": "DOGEUSDT" };
const SYM_WS = Object.fromEntries(Object.entries(WS_SYM).map(([k, v]) => [v, k]));
const API_SYM = { BTCUSDT: "BTC", ETHUSDT: "ETH", SOLUSDT: "SOL", XRPUSDT: "XRP", DOGEUSDT: "DOGE" };
const VARIANT = { "5m": "fiveminute", "15m": "fifteenminute", "1h": "hourly" };
// MEMORY (2026-07-13): the table is loaded PER COIN. The old monolithic qtable-live-data.json was 21MB
// of JSON across 5 coins and JSON.parse blew it up to ~147MB RSS AT IMPORT TIME — on a 256MB host the
// OOM killer took down the ENTIRE bot every ~2 minutes (not just qtable2: no feed, no exits, no
// copytrade — the whole process died, for hours). Each coin costs ~25MB, so we parse only what we trade.
// Owner 2026-07-13: DOGE and XRP DROPPED from this strategy. BTC+ETH+SOL = 95MB RSS, 161MB headroom.
const TDIR = new URL("./qtable-data/", import.meta.url);
const TMETA = JSON.parse(readFileSync(new URL("meta.json", TDIR), "utf8"));
const WANT = (process.env.QTABLE2_COINS || "BTCUSDT,ETHUSDT,SOLUSDT").split(",").map((s) => s.trim()).filter(Boolean);
const TABLE = { meta: TMETA.meta, coins: {} };
for (const c of WANT) {
  try { TABLE.coins[c] = JSON.parse(readFileSync(new URL(`${c}.json`, TDIR), "utf8")); }
  catch { warn(`qtable2: no table data for ${c} — skipping (have: ${TMETA.coins.join(",")})`); }
}
const COINS = Object.keys(TABLE.coins);

// Durable per-trade ledger on the persistent volume (survives restarts) — read by src/qtable2-report.mjs.
const DATA_DIR = (process.env.COSMOS_DATA_DIR || ".").replace(/\/$/, "");
const LEDGER = `${DATA_DIR}/qtable2-trades.ndjson`;
function appendLedger(rec) { try { appendFileSync(LEDGER, JSON.stringify(rec) + "\n"); } catch (e) { warn("qtable2 ledger:", e?.message); } }

// HOURLY TRADE CAP (owner 2026-07-20: 3 per rolling 60min for the fleet-live rollout — one notch
// under cert15's 4). Timestamps persist to the volume so a restart cannot reset the window.
// Fills and DRY would-buys consume a slot; failed FAKs do not.
const MAX_PER_HOUR = N("QTABLE2_MAX_PER_HOUR", 3);
const HOURLY_FILE = `${DATA_DIR}/qtable2-hourly.json`;
let hourly = [];
try { hourly = (JSON.parse(readFileSync(HOURLY_FILE, "utf8")).ts || []).filter((t) => Number.isFinite(t) && t > Date.now() - 3600e3); } catch { /* fresh */ }
function hourlyCapped() {
  const cut = Date.now() - 3600e3;
  while (hourly.length && hourly[0] < cut) hourly.shift();
  return hourly.length >= MAX_PER_HOUR;
}
function hourlyMark() {
  hourly.push(Date.now());
  try { writeFileSync(HOURLY_FILE, JSON.stringify({ ts: hourly })); } catch (e) { warn("qtable2 hourly:", e?.message); }
}

// ---- table lookup (tow-aware; ported from lib/qtable.ts) ----
function towBucket(ms, buckets) {
  const d = new Date(ms);
  const sow = d.getUTCDay() * 86400 + d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  return Math.min(buckets - 1, Math.max(0, Math.floor(sow / (604800 / buckets))));
}
function lookupP(sym, tblFrame, elapsedPct, d, towB) {
  const fr = TABLE.coins[sym]?.frames?.[tblFrame];
  if (!fr?.pts?.length) return null;
  const gmax = TABLE.meta.gmax;
  const gi = Math.max(0, Math.min(2 * gmax, Math.round(d / TABLE.meta.step) + gmax));
  if (towB != null && fr.tow && fr.tow[towB]?.length) {
    let best = null;
    for (const r of fr.tow[towB]) if (best == null || Math.abs(r.pct - elapsedPct) < Math.abs(best.pct - elapsedPct)) best = r;
    if (best) { const j = gi - best.g0; if (j >= 0 && j < best.p.length) return best.p[j] / 1000; }
  }
  let base = fr.pts[0];
  for (const p of fr.pts) if (Math.abs(p.pct - elapsedPct) < Math.abs(base.pct - elapsedPct)) base = p;
  // Deep-check 2026-07-15: the base layer is RAW 365d frequencies with no n floor — 61-69% of tradable
  // cells are EXACTLY 0 or 1 (one observation, ever). At |d|>=60bps most lookups fell through the tow
  // window onto these, served P=1.000, max "edge", and bought tops (the 13-14c 0-for-2 wipeouts live).
  // A raw certainty cell is a sample-size artifact, not a probability: refuse it.
  const v = base.surv[gi] ?? null;
  if (v == null || v <= 0.001 || v >= 0.999) return null;
  return v;
}

// ---- Chainlink RTDS: reference buffer + live spot (same source Polymarket resolves on) ----
const hist = {}; // sym -> [{t,v}] last ~35min
const spot = {}; // sym -> latest value
// Trust a buffered tick as the window-open reference ONLY if it landed near the boundary. A dormant
// event-driven feed (ETH/SOL/XRP off-hours) wakes AFTER a move, so its first tick can be minutes late
// and post-move — a wrong reference → fake d → fake edge (the audited "$6 ETH move" mechanism; probe
// 2026-07-13 measured a 9.6bps late-tick ref error live). Late ref -> null -> price-history backfill
// or NO TRADE. Verified-correct data or nothing.
const REF_TRUST_MS = N("QTABLE2_REF_TRUST_MS", 15000);
const refFor = (sym, windowStartMs) => {
  const h = hist[sym]; if (!h || !h.length || h[0].t > windowStartMs) return null;
  for (let i = 0; i < h.length; i++) if (h[i].t >= windowStartMs) return h[i].t - windowStartMs <= REF_TRUST_MS ? h[i].v : null;
  return null;
};
function connectChainlink() {
  let ws, stopped = false;
  const go = () => {
    try { ws = new WSImpl("wss://ws-live-data.polymarket.com", WS_OPTS); } catch { return setTimeout(go, 1500); }
    // Topic-wide subscribe, client-side filtering — per-symbol filters are broken server-side (the
    // root cause of "silently loses 2/3 of its coins"; see cert15.mjs connectChainlink, probed 2026-07-20).
    ws.onopen = () => { ws.send(JSON.stringify({ action: "subscribe", subscriptions:
      [{ topic: "crypto_prices_chainlink", type: "*" }],
    })); log(`qtable2 chainlink: connected, topic-wide (want ${COINS.map((c) => SYM_WS[c]).join(", ")})`); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      const p = m?.payload ?? m; const sym = WS_SYM[String(p?.symbol ?? "").toLowerCase()];
      if (!sym) return;
      const h = hist[sym] ?? (hist[sym] = []); let last = 0;
      if (Array.isArray(p.data)) { for (const d of p.data) { const t = Number(d?.timestamp), v = Number(d?.value); if (v > 0 && t > 0) { h.push({ t, v }); last = v; } }
        const mp = new Map(); for (const x of h) mp.set(x.t, x.v); hist[sym] = [...mp.entries()].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
      } else { const t = Number(p.timestamp) || Date.now(), v = Number(p.value); if (v > 0) { h.push({ t, v }); last = v; } }
      const buf = hist[sym]; const cut = (buf.length ? buf[buf.length - 1].t : Date.now()) - 35 * 60_000;
      while (buf.length > 1 && buf[0].t < cut) buf.shift();
      if (last > 0) spot[sym] = last;
    };
    ws.onclose = () => { if (!stopped) setTimeout(go, 1500); };
    ws.onerror = () => { try { ws.close(); } catch { /* */ } };
  };
  go();
  return {
    stop: () => { stopped = true; try { ws?.close(); } catch { /* */ } },
    // WATCHDOG HOOK (2026-07-14): RTDS subscriptions can HALF-DIE — the socket stays open and BTC keeps
    // ticking while ETH/SOL go silent (observed: 85+ min stale on a live socket while a fresh
    // subscription got ticks instantly). onclose-based reconnect never fires for that, so the engine
    // silently loses 2/3 of its coins. kick() closes the socket, forcing a clean reconnect+resubscribe.
    kick: () => { try { ws?.close(); } catch { /* */ } },
  };
}

const j = async (u, ms = 4000) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; } };
const parseArr = (s) => { try { return JSON.parse(String(s ?? "[]")); } catch { return []; } };

// All Polymarket up-or-down candle families (verified live 2026-07-13). A slug that stops existing
// just returns nothing from gamma; a coin not in COINS/table is filtered out.
const SERIES = [
  { frame: "5m", sym: "BTCUSDT", slug: "btc-up-or-down-5m" },
  { frame: "5m", sym: "ETHUSDT", slug: "eth-up-or-down-5m" },
  { frame: "5m", sym: "SOLUSDT", slug: "sol-up-or-down-5m" },
  { frame: "5m", sym: "XRPUSDT", slug: "xrp-up-or-down-5m" },
  { frame: "5m", sym: "DOGEUSDT", slug: "doge-up-or-down-5m" },
  { frame: "15m", sym: "BTCUSDT", slug: "btc-up-or-down-15m" },
  { frame: "15m", sym: "ETHUSDT", slug: "eth-up-or-down-15m" },
  { frame: "15m", sym: "ETHUSDT", slug: "ethereum-up-or-down-15m" },
  { frame: "15m", sym: "SOLUSDT", slug: "sol-up-or-down-15m" },
  { frame: "15m", sym: "XRPUSDT", slug: "xrp-up-or-down-15m" },
  { frame: "15m", sym: "DOGEUSDT", slug: "doge-up-or-down-15m" },
  { frame: "1h", sym: "BTCUSDT", slug: "btc-up-or-down-hourly" },
  { frame: "1h", sym: "ETHUSDT", slug: "eth-up-or-down-hourly" },
  { frame: "1h", sym: "XRPUSDT", slug: "xrp-up-or-down-hourly" },
  { frame: "1h", sym: "DOGEUSDT", slug: "doge-up-or-down-hourly" },
].filter((s) => COINS.includes(s.sym));

// ASK-STABILITY VETO (deep-check 2026-07-15, the main leak at ~-$416/day): only 26.4% of our entries
// had spot moving WITH our side in the prior 10s (control: 63.7%) — because P is a static table,
// edge = P/ask crosses 1.15 exactly when informed makers mark the ask DOWN. We were a falling-ask
// detector. Veto any entry whose ask dropped >= ASK_DROP_VETO within the last ASK_VETO_WINDOW_S:
// a falling ask means the book knows something the table does not.
const ASK_DROP_VETO = N("QTABLE2_ASK_DROP_VETO", 0.04);
const ASK_VETO_WINDOW_S = N("QTABLE2_ASK_VETO_WINDOW_S", 30);
const askHist = new Map();   // tokenId -> [{t, ask}] (we evaluate candidates every 250ms, so this fills itself)
function askFalling(tokenId, ask) {
  const now = Date.now();
  const h = askHist.get(tokenId) ?? [];
  h.push({ t: now, ask });
  while (h.length && h[0].t < now - (ASK_VETO_WINDOW_S + 10) * 1000) h.shift();
  askHist.set(tokenId, h);
  let maxPast = null;
  for (const e of h) if (e.t <= now - 8_000 && (maxPast == null || e.ask > maxPast)) maxPast = e.ask;   // ignore the last 8s (that's the move we ride)
  return maxPast != null && maxPast - ask >= ASK_DROP_VETO;
}

// best ASK (what a marketable BUY actually pays), in [0,1], with a two-sided-book spread sanity guard
async function bestAsk(tokenId) {
  const d = await j(`https://clob.polymarket.com/book?token_id=${tokenId}`, 3000);
  const asks = d?.asks || [], bids = d?.bids || [];
  let ba = null, bb = null;
  for (const a of asks) { const p = Number(a?.price); const sz = Number(a?.size); if (p > 0 && sz > 0 && (ba == null || p < ba)) ba = p; }
  for (const b of bids) { const p = Number(b?.price); const sz = Number(b?.size); if (p > 0 && sz > 0 && (bb == null || p > bb)) bb = p; }
  if (ba == null || bb == null) return null;             // one-sided book -> not tradable
  if (ba - bb > 0.10) return null;                       // spread too wide -> skip
  return ba;
}

export function startQTable2(deps) {
  const { pm, cosmos, store, placeWithRetry, sharesFor, sizeForSignal, state } = deps;
  const markets = new Map();  // cid -> descriptor
  const apiRef = {};          // cid -> backfilled window-open reference
  const done = new Set();     // cid -> already ordered / permanently skipped this run
  const fails = new Map();    // cid -> failed order attempts
  const stats = { signals: 0, orders: 0, fills: 0, capSkips: 0 };
  let alive = true, lastCapLog = 0;

  async function discover() {
    const now = Date.now();
    for (const s of SERIES) {
      const evs = await j(`https://gamma-api.polymarket.com/events?series_slug=${s.slug}&closed=false&limit=8&order=endDate&ascending=true&end_date_min=${new Date(now).toISOString()}`);
      if (!Array.isArray(evs)) continue;
      const frameMs = FRAME_MS[s.frame];
      for (const e of evs) for (const m of (e.markets ?? [])) {
        const cid = String(m.conditionId ?? ""); if (!cid) continue;
        const endMs = Date.parse(m.endDate ?? e.endDate ?? ""); if (!Number.isFinite(endMs) || endMs <= now) continue;
        if (endMs - now > 2 * frameMs) continue;
        const toks = parseArr(m.clobTokenIds), outs = parseArr(m.outcomes);
        const ai = outs.findIndex((o) => /^up$/i.test(o)), bi = outs.findIndex((o) => /^down$/i.test(o));
        if (ai < 0 || bi < 0 || !toks[ai] || !toks[bi]) continue;
        if (!markets.has(cid)) markets.set(cid, { cid, sym: s.sym, frame: s.frame, frameMs, endMs, windowStartMs: endMs - frameMs, question: String(m.question ?? ""), tokenUp: String(toks[ai]), tokenDn: String(toks[bi]), outUp: String(outs[ai]), outDn: String(outs[bi]) });
      }
    }
    for (const [cid, m] of markets) if (m.endMs <= now - 30_000) markets.delete(cid);
  }

  // backfill the window-open reference for in-window candles we missed live (Polymarket price-history)
  async function backfillRefs() {
    const now = Date.now();
    for (const m of markets.values()) {
      if (apiRef[m.cid] != null || refFor(m.sym, m.windowStartMs) != null) continue;
      const rem = m.endMs - now; if (rem <= 0 || rem > m.frameMs) continue;
      if ((m.frameMs - rem) / 1000 <= 130) continue;
      const startISO = new Date(m.windowStartMs).toISOString(), endISO = new Date(m.windowStartMs + m.frameMs).toISOString();
      const arr = await j(`https://polymarket.com/api/crypto/price-history?symbol=${API_SYM[m.sym]}&variant=${VARIANT[m.frame]}&eventStartTime=${encodeURIComponent(startISO)}&endDate=${encodeURIComponent(endISO)}`);
      const v = Array.isArray(arr) && arr[0] ? Number(arr[0].value) : NaN;
      if (Number.isFinite(v) && v > 0) apiRef[m.cid] = v;
    }
  }
  const strikeFor = (m) => refFor(m.sym, m.windowStartMs) ?? apiRef[m.cid] ?? null;

  // one pass over every in-window market. Sequential + single positions load per tick (mirrors
  // qtable.mjs): the in-window candle set is tiny (1–2 markets), and it avoids the store clobber a
  // concurrent load/save would cause.
  async function tick() {
    if (state.qtable2 === false) return;                     // server turned the engine off -> stop trading
    if (state.cash == null || state.sizing == null) return;  // no cycle data yet (first 30s after boot)
    const now = Date.now();
    const positions = store.load();
    // openQt counts only LIVE qtable positions. Dead ones (market already ended; worthless loser dust
    // that never hit the 97c TP or 3c salvage) linger in positions.json because their shares stay in
    // the wallet — 3 fleet bots hit MAX_OPEN purely on dust (9-24 stuck) and their engine froze forever.
    let openQt = 0;
    for (const p of Object.values(positions)) {
      if (p.source !== "qtable") continue;
      // A position's end time, most to least reliable: end_date -> end_ms -> opened_at + a candle's max
      // life. Older records stored NO end field at all, so `p.end_date` was always undefined, `ended`
      // was always false, and EVERY qtable position counted as open forever — the engine froze at
      // MAX_OPEN on pure dust. opened_at is always present, so this recovers those stuck positions too.
      const endMs = p.end_date && p.end_date !== "none" ? Date.parse(p.end_date)
        : p.end_ms ? Number(p.end_ms)
        : p.opened_at ? Date.parse(p.opened_at) + 90 * 60_000
        : now;                                                 // truly unknowable -> never let it freeze the engine
      const ended = !Number.isFinite(endMs) || endMs < now - 15 * 60_000;
      if (!ended) openQt++;
    }

    for (const m of [...markets.values()]) {
      const remaining = m.endMs - now;
      if (remaining <= 0) { markets.delete(m.cid); continue; }
      if (remaining > m.frameMs) continue;                    // window not started
      if (done.has(m.cid)) continue;
      if (positions[m.cid]) { done.add(m.cid); markets.delete(m.cid); continue; }
      if (openQt >= MAX_OPEN) return;
      const strike = strikeFor(m); if (strike == null) continue;
      const S = spot[m.sym]; if (!S) continue;
      const h = hist[m.sym]; const spotAge = h?.length ? now - h[h.length - 1].t : Infinity;
      if (spotAge > STALE_MS) continue;                       // stale Chainlink spot -> d meaningless
      const d = (S - strike) / strike;
      const elapsed = 100 * (1 - remaining / m.frameMs);
      if (Math.abs(d) < MIN_D) continue;
      // persistence guard: the same displacement must ALREADY have been in force PERSIST_S ago —
      // otherwise this is a fresh sub-second spike (the audited money-loser). In-memory, no latency.
      const past = spotAt(m.sym, now - PERSIST_S * 1000);
      if (past == null) continue;
      const dPast = (past - strike) / strike;
      if (Math.sign(dPast) !== Math.sign(d) || Math.abs(dPast) < MIN_D) continue;
      if (elapsed < MIN_ELAPSED || elapsed > MAX_ELAPSED) continue;
      if (remaining < MIN_REMAIN_S * 1000) continue;
      const towB = TABLE.meta.towBuckets ? towBucket(m.windowStartMs, TABLE.meta.towBuckets) : undefined;
      const pAbove = lookupP(m.sym, TABLE_FRAME[m.frame], elapsed, d, towB);
      if (pAbove == null) continue;
      const pUp = pAbove, pDn = 1 - pAbove;
      const tBook = Date.now();                                        // start of book-fetch + order latency
      const cands = [];
      if (pUp >= MIN_P && d >= LEAD_D) { const ask = await bestAsk(m.tokenUp); const e = ask ? pUp / ask : 0; if (ask != null && ask >= MIN_PRICE && ask <= MAX_PRICE && (pUp - ask) >= minDisagreeReq() && e <= MAX_EDGE && (pUp - ask) <= MAX_DISAGREE && !askFalling(m.tokenUp, ask)) cands.push({ side: "Up", token: m.tokenUp, outcome: m.outUp, p: pUp, ask, edge: e }); }
      if (pDn >= MIN_P && d <= -LEAD_D) { const ask = await bestAsk(m.tokenDn); const e = ask ? pDn / ask : 0; if (ask != null && ask >= MIN_PRICE && ask <= MAX_PRICE && (pDn - ask) >= minDisagreeReq() && e <= MAX_EDGE && (pDn - ask) <= MAX_DISAGREE && !askFalling(m.tokenDn, ask)) cands.push({ side: "Down", token: m.tokenDn, outcome: m.outDn, p: pDn, ask, edge: e }); }
      const pick = cands.sort((a, b) => b.edge - a.edge)[0];
      if (!pick) continue;

      // HOURLY CAP: skip WITHOUT done-ing the market — a slot can free up while the edge holds.
      if (hourlyCapped()) {
        stats.capSkips++;
        if (Date.now() - lastCapLog > 60_000) { lastCapLog = Date.now(); log(`qtable2: hourly cap ${hourly.length}/${MAX_PER_HOUR} — signal skipped (${m.question.slice(0, 36)})`); }
        continue;
      }

      stats.signals++;
      const bookMs = Date.now() - tBook;                               // book-fetch + decision latency
      // sizing: fixed $ if QTABLE2_STAKE_USD>0, else the account's dashboard % (e.g. 3% flat), floored at $2
      const sizeUsd = STAKE > 0 ? STAKE : Math.max(2, sizeForSignal(state.sizing, { source: "qtable", outcome: pick.outcome }, state.portfolio, state.deployed));
      const priceCents = Math.min(97, Math.round(pick.ask * 100) + 1); // cross the ask
      const shares = Math.max(Math.ceil(100 / priceCents), sharesFor(sizeUsd, priceCents));
      const orderUsd = (shares * priceCents) / 100;
      const tag = `${pick.side} ${m.frame} ${m.sym} @ ${priceCents}c P=${(pick.p * 100).toFixed(0)}% gain=${((pick.p - pick.ask) * 100).toFixed(1)}pp (edge ${pick.edge.toFixed(3)})${inPeakWindow() ? "[peak]" : ""} d=${(d * 100).toFixed(3)}% t=${elapsed.toFixed(0)}%`;
      if (orderUsd > state.cash) { done.add(m.cid); continue; }        // no room; re-armed next discover
      if (DRY) { hourlyMark(); log(`qtable2 DRY would BUY ${tag} · hourly ${hourly.length}/${MAX_PER_HOUR} · spotAge=${spotAge}ms book=${bookMs}ms · ${m.question.slice(0, 36)}`); done.add(m.cid); continue; }

      done.add(m.cid); // one shot per market
      const t0 = Date.now();
      const r = await placeWithRetry(pm, { tokenId: pick.token, side: "BUY", sizeShares: shares, priceCents, orderType: "FAK" }, 2, 80);
      const orderMs = Date.now() - t0, totalMs = bookMs + orderMs;     // fresh-spot -> order landed
      stats.orders++;
      const rec = { ts: new Date().toISOString(), cid: m.cid, q: m.question, sym: m.sym, frame: m.frame, side: pick.side, outcome: pick.outcome, entry_cents: priceCents, edge: Number(pick.edge.toFixed(4)), p: Number(pick.p.toFixed(4)), d_pct: Number((d * 100).toFixed(4)), d_past_pct: Number((dPast * 100).toFixed(4)), elapsed_pct: Number(elapsed.toFixed(1)), size_usd: Number(orderUsd.toFixed(2)), shares: Number(shares.toFixed(2)), token_id: pick.token, end_ms: m.endMs, spot_age_ms: spotAge, book_ms: bookMs, order_ms: orderMs, total_ms: totalMs };
      if (!r.ok) {
        const f = (fails.get(m.cid) ?? 0) + 1; fails.set(m.cid, f);
        if (!(f >= 5 || (typeof r.status === "number" && r.status >= 400 && r.status < 500 && f >= 3))) done.delete(m.cid); // let it retry next tick
        else markets.delete(m.cid);
        appendLedger({ ...rec, ok: false, err: String(r.error ?? r.err ?? r.status ?? "").slice(0, 140) });
        log(`FAIL [qtable2] ${tag} · order=${orderMs}ms · ${String(r.error ?? r.err ?? r.status ?? "").slice(0, 110)}`);
        continue;
      }
      stats.fills++;
      hourlyMark();                                          // a filled entry consumes an hourly slot
      try { await cosmos.meter({ ...r.meta, source: "qtable" }); } catch { /* best-effort */ }
      positions[m.cid] = {
        condition_id: m.cid, token_id: pick.token, outcome: pick.outcome, source: "qtable",
        entry_cents: priceCents, size_usd: orderUsd, size_shares: shares, entry_whales: [],
        market_question: m.question, opened_at: rec.ts,
        end_ms: m.endMs, end_date: new Date(m.endMs).toISOString(),   // so the MAX_OPEN dust-guard can tell a dead candle from a live one
      };
      store.save(positions);
      appendLedger({ ...rec, ok: true });
      state.cash -= orderUsd; state.deployed += orderUsd; openQt++;
      markets.delete(m.cid);
      log(`BUY  [qtable2] ${tag} · $${orderUsd.toFixed(2)} · spotAge=${spotAge}ms book=${bookMs}ms order=${orderMs}ms total=${totalMs}ms${totalMs > 1000 ? " ⚠SLOW" : ""} · ${m.question.slice(0, 36)} ✓`);
    }
  }

  (async function run() {
    log(`qtable2: engine ON · ${STAKE > 0 ? "$" + STAKE + "/trade" : "dashboard % sizing"} · gain ${(MIN_DISAGREE * 100).toFixed(0)}-${(MAX_DISAGREE * 100).toFixed(0)}pp@p≥${(MIN_P * 100).toFixed(0)}% (hardened +${(EDGE_BUMP * 100).toFixed(0)}pp; +${(EDGE_BUMP_PEAK * 100).toFixed(0)}pp Mon-Fri 16:00-18:30 ${PEAK_TZ}) · persist ${PERSIST_S}s · ${COINS.join(",")} · max ${MAX_PER_HOUR}/h (rolling, persisted) · tick ${TICK_MS}ms${DRY ? " · DRY RUN" : ""}`);
    const wsCtl = connectChainlink();
    await discover().catch(() => {});
    const di = setInterval(() => discover().catch(() => {}), 15_000);
    const bi = setInterval(() => backfillRefs().catch(() => {}), 4_000);
    // FEED WATCHDOG: a coin that HAS ticked before but has been silent > WATCHDOG_MS means the
    // subscription half-died (socket open, stream gone — the 2026-07-14 overnight failure: eth/sol
    // stale 85 min while btc ticked). Force a reconnect; rate-limited so a genuinely dormant feed
    // only costs one cheap reconnect every few minutes.
    const WATCHDOG_MS = N("QTABLE2_FEED_WATCHDOG_MS", 300_000);
    let lastKick = 0;
    const si = setInterval(() => {
      const feeds = COINS.map((c) => {
        const h = hist[c]; const age = h?.length ? Date.now() - h[h.length - 1].t : Infinity;
        return `${API_SYM[c].toLowerCase()} ${age === Infinity ? "NO FEED ⚠" : (age / 1000).toFixed(1) + "s"}`;
      }).join(" · ");
      log(`qtable2 … tracking ${markets.size} · ${feeds} · signals ${stats.signals} · orders ${stats.orders} · fills ${stats.fills} · hourly ${hourly.filter((t) => t > Date.now() - 3600e3).length}/${MAX_PER_HOUR}${stats.capSkips ? ` (cap-skipped ${stats.capSkips})` : ""}`);
      const staleCoin = COINS.find((c) => { const h = hist[c]; return h?.length && Date.now() - h[h.length - 1].t > WATCHDOG_MS; });
      if (staleCoin && Date.now() - lastKick > WATCHDOG_MS) {
        lastKick = Date.now();
        warn(`qtable2 watchdog: ${API_SYM[staleCoin]} silent ${Math.round((Date.now() - hist[staleCoin][hist[staleCoin].length - 1].t) / 1000)}s on an open socket — forcing reconnect`);
        wsCtl.kick();
      }
    }, 30_000);
    while (alive) {
      const t0 = Date.now();
      try { await tick(); } catch (e) { warn("qtable2:", e?.message); }
      await new Promise((res) => setTimeout(res, Math.max(120, TICK_MS - (Date.now() - t0))));
    }
    clearInterval(di); clearInterval(bi); clearInterval(si); wsCtl.stop();
  })();
  return () => { alive = false; };
}
