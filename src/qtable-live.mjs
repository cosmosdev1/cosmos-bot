// qtable-live.mjs — FAST local live-TEST bot for the QTABLE candle strategy. Mirrors the paper dry
// desk EXACTLY: Chainlink RTDS reference + spot (the price Polymarket resolves these on), the refit
// table (tow-aware, bug-fixed), STRICT guards (|d|>=5bps, elapsed 10-95%, >=90s left, P>=50%),
// multiplicative edge >= QTL_EDGE vs the REAL best ask, price floor 5-97c, CANDLES ONLY, $2
// marketable FAK + builder code. Latency-instrumented on every signal.
//
// SAFETY: DRY-RUN unless LIVE=1. Dry-run logs the would-be fill + eval latency and needs no key.
//   Dry:   node --env-file=qtable-live.env src/qtable-live.mjs
//   Live:  set LIVE=1 (+ your key) in qtable-live.env, then the same command.
import { readFileSync } from "node:fs";
import { ClobClient, Side, OrderType, Chain, SignatureTypeV2, createL1Headers } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const N = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };
const LIVE = process.env.LIVE === "1";
const STAKE = N("QTL_STAKE_USD", 2);
const EDGE = N("QTL_EDGE", 1.08);
const COINS = (process.env.QTL_COINS || "BTCUSDT,ETHUSDT").split(",").map((s) => s.trim());
const KEY = (process.env.POLYMARKET_PRIVATE_KEY || "").trim();

// strategy guards — identical to the paper desk (strict mode)
const MIN_D = 0.0005, MIN_P = 0.5, MIN_ELAPSED = 10, MAX_ELAPSED = 95, MIN_REMAIN_S = 90;
const MIN_PRICE = 0.05, MAX_PRICE = 0.97;
const STALE_MS = N("QTL_MAX_SPOT_AGE_MS", 8000);  // don't trade on a Chainlink spot older than this
const MAX_EDGE = N("QTL_MAX_EDGE", 3.0);          // reject absurd edges (P/ask): a >3x gap almost
//   always means a WRONG reference (bad data), not a real edge — this is what killed the fake "$6
//   move" ETH signal. Real fast-move edges are ~1.1-1.8x.
const MAX_ORDERS = N("QTL_MAX_ORDERS", 25);       // hard safety cap: stop placing after N live orders
const FRAME_MS = { "5m": 300_000, "15m": 900_000 };
const TABLE_FRAME = { "5m": "5m", "15m": "15m" };
const WS_SYM = { "btc/usd": "BTCUSDT", "eth/usd": "ETHUSDT" };
const API_SYM = { BTCUSDT: "BTC", ETHUSDT: "ETH" };
const VARIANT = { "5m": "fiveminute", "15m": "fifteenminute" };

const TABLE = JSON.parse(readFileSync(new URL("./qtable-live-data.json", import.meta.url), "utf8"));
const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(stamp(), ...a);

// Self-contained order client (does NOT touch the production polymarket.mjs). Signs marketable FAK
// orders with the Cosmos builder code. Starts at the detected type and AUTO-FALLS-BACK to POLY_1271
// (deposit wallets) when Polymarket returns "maker address not allowed, please use the deposit wallet
// flow" — the clob-client-v2 SDK already builds the ERC-7739-wrapped POLY_1271 signature. Force a type
// with QTL_SIG_TYPE=0|1|2|3 to skip detection.
const BUILDER_CODE = "0x4ddc9c090a1adb966274f26284e0e0f686b6828ec71299a1dc310ebea4bb8166";
const SIG_NAMES = { 0: "EOA", 1: "POLY_PROXY", 2: "POLY_GNOSIS_SAFE", 3: "POLY_1271" };
const DEPOSIT_ERR = /deposit wallet|maker address not allowed|signer address has to be the address of the API/i;
async function makeTrader(key, funderAddr) {
  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain: polygon, transport: http() });
  const funder = funderAddr || account.address;
  const host = "https://clob.polymarket.com";
  // API key bound to the EOA (works for EOA / POLY_PROXY / Safe).
  const eoaCreds = await new ClobClient({ host, chain: Chain.POLYGON, signer: wallet }).createOrDeriveApiKey();
  // API key bound to the DEPOSIT WALLET (address = funder), signed by the EOA — the missing piece for
  // POLY_1271: the CLOB requires order.signer (= the deposit wallet) to equal the API key's address.
  const deriveForFunder = async () => {
    try {
      const mkH = async () => createL1Headers(wallet, 137, 0, undefined, funder);
      let jj = await fetch(`${host}/auth/api-key`, { method: "POST", headers: await mkH() }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!jj?.apiKey) jj = await fetch(`${host}/auth/derive-api-key`, { headers: await mkH() }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      return jj?.apiKey ? { key: jj.apiKey, secret: jj.secret, passphrase: jj.passphrase } : null;
    } catch { return null; }
  };
  const mk = (t, creds) => new ClobClient({ host, chain: Chain.POLYGON, signer: wallet, creds, signatureType: t, funderAddress: funder, builderConfig: { builderCode: BUILDER_CODE } });
  const forced = process.env.QTL_SIG_TYPE;
  let sig = (forced != null && forced !== "") ? Number(forced)
    : (funder.toLowerCase() !== account.address.toLowerCase() ? SignatureTypeV2.POLY_PROXY : SignatureTypeV2.EOA);
  let depCreds = null;
  if (sig === SignatureTypeV2.POLY_1271) { depCreds = await deriveForFunder(); log(depCreds ? "✓ API key bound to the deposit wallet" : "⚠ could NOT derive a deposit-wallet API key"); }
  let client = mk(sig, sig === SignatureTypeV2.POLY_1271 ? (depCreds || eoaCreds) : eoaCreds);
  const attempt = async (c, tokenId, price, size) => {
    try { const r = await c.createAndPostOrder({ tokenID: tokenId, price, side: Side.BUY, size }, undefined, OrderType.FAK); return r?.error ? { ok: false, err: r.error } : { ok: true }; }
    catch (e) { return { ok: false, err: e?.message ?? "order failed" }; }
  };
  return {
    address: account.address, funder,
    sigName: () => SIG_NAMES[sig] ?? String(sig),
    async place({ tokenId, priceCents, sizeShares }) {
      const price = Math.max(0.01, Math.min(0.99, priceCents / 100));
      const size = Math.floor(sizeShares * 100) / 100;
      if (!(size > 0)) return { ok: false, err: "size below sellable minimum" };
      let r = await attempt(client, tokenId, price, size);
      // deposit-wallet path: switch to POLY_1271 with an API key bound to the deposit wallet
      if (!r.ok && sig !== SignatureTypeV2.POLY_1271 && DEPOSIT_ERR.test(String(r.err))) {
        if (!depCreds) { depCreds = await deriveForFunder(); log(depCreds ? "✓ derived API key bound to the deposit wallet" : "⚠ could NOT derive a deposit-wallet API key"); }
        sig = SignatureTypeV2.POLY_1271; client = mk(sig, depCreds || eoaCreds);
        log("↻ retrying as POLY_1271 (deposit wallet)…");
        r = await attempt(client, tokenId, price, size);
        if (r.ok) log("✓ deposit wallet works — POLY_1271 + deposit-wallet API key from now on");
      }
      return r;
    },
  };
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
  return base.surv[gi] ?? null;
}

// ---- Chainlink RTDS: reference buffer + live spot (same source Polymarket resolves on) ----
const hist = {}; // sym -> [{t,v}] last ~35min
const spot = {}; // sym -> latest value
const refFor = (sym, windowStartMs) => {
  const h = hist[sym]; if (!h || !h.length || h[0].t > windowStartMs) return null;
  for (let i = 0; i < h.length; i++) if (h[i].t >= windowStartMs) return h[i].v;
  return null;
};
function connectChainlink() {
  let ws, stopped = false;
  const go = () => {
    try { ws = new WebSocket("wss://ws-live-data.polymarket.com"); } catch { return setTimeout(go, 1500); }
    ws.onopen = () => { ws.send(JSON.stringify({ action: "subscribe", subscriptions: [
      { topic: "crypto_prices_chainlink", type: "*", filters: JSON.stringify({ symbol: "btc/usd" }) },
      { topic: "crypto_prices_chainlink", type: "*", filters: JSON.stringify({ symbol: "eth/usd" }) },
    ] })); log("chainlink: connected"); };
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
  return () => { stopped = true; try { ws?.close(); } catch { /* */ } };
}

const j = async (u, ms = 4000) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; } };
const parseArr = (s) => { try { return JSON.parse(String(s ?? "[]")); } catch { return []; } };

// ---- market discovery (candles only) ----
const SERIES = [
  { frame: "5m", sym: "BTCUSDT", slug: "btc-up-or-down-5m" },
  { frame: "5m", sym: "ETHUSDT", slug: "eth-up-or-down-5m" },
  { frame: "15m", sym: "BTCUSDT", slug: "btc-up-or-down-15m" },
  { frame: "15m", sym: "ETHUSDT", slug: "eth-up-or-down-15m" },
  { frame: "15m", sym: "ETHUSDT", slug: "ethereum-up-or-down-15m" },
].filter((s) => COINS.includes(s.sym));

let markets = new Map(); // cid -> descriptor
const apiRef = {}; // cid -> backfilled reference

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
      if (!markets.has(cid)) markets.set(cid, { cid, sym: s.sym, frame: s.frame, frameMs, endMs, windowStartMs: endMs - frameMs, question: String(m.question ?? ""), tokenUp: toks[ai], tokenDn: toks[bi] });
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

// ---- engine ----
const done = new Set(); // cid -> already ordered (or tried)
let pm = null, trader = null, stats = { signals: 0, orders: 0, fills: 0 };

async function evalMarket(m) {
  const now = Date.now();
  const remaining = m.endMs - now;
  if (remaining <= 0 || remaining > m.frameMs) return;   // not in window
  if (done.has(m.cid)) return;
  const strike = strikeFor(m); if (strike == null) return;
  const S = spot[m.sym]; if (!S) return;
  const h = hist[m.sym]; const spotAge = h?.length ? now - h[h.length - 1].t : Infinity;
  if (spotAge > STALE_MS) return; // stale spot -> d is meaningless (e.g. ETH feed quiet off-hours)
  const d = (S - strike) / strike;
  const elapsed = 100 * (1 - remaining / m.frameMs);
  // STRICT guards
  if (Math.abs(d) < MIN_D) return;
  if (elapsed < MIN_ELAPSED || elapsed > MAX_ELAPSED) return;
  if (remaining < MIN_REMAIN_S * 1000) return;
  const towB = TABLE.meta.towBuckets ? towBucket(m.windowStartMs, TABLE.meta.towBuckets) : undefined;
  const pAbove = lookupP(m.sym, TABLE_FRAME[m.frame], elapsed, d, towB);
  if (pAbove == null) return;
  const pUp = pAbove, pDn = 1 - pAbove;
  // fetch the REAL best ask for whichever side(s) clear P>=50% (only touch the book when it matters)
  const cands = [];
  if (pUp >= MIN_P) { const ask = await bestAsk(m.tokenUp); const e = ask ? pUp / ask : 0; if (ask != null && ask >= MIN_PRICE && ask <= MAX_PRICE && e >= EDGE && e <= MAX_EDGE) cands.push({ side: "Up", token: m.tokenUp, p: pUp, ask, edge: e }); }
  if (pDn >= MIN_P) { const ask = await bestAsk(m.tokenDn); const e = ask ? pDn / ask : 0; if (ask != null && ask >= MIN_PRICE && ask <= MAX_PRICE && e >= EDGE && e <= MAX_EDGE) cands.push({ side: "Down", token: m.tokenDn, p: pDn, ask, edge: e }); }
  const pick = cands.sort((a, b) => b.edge - a.edge)[0];
  if (!pick) return;

  stats.signals++;
  done.add(m.cid); // one shot per market
  const priceCents = Math.min(97, Math.round(pick.ask * 100) + 1); // cross the ask
  const shares = STAKE / (priceCents / 100);
  const tag = `${pick.side} ${m.frame} ${m.sym} @ ${priceCents}c P=${(pick.p * 100).toFixed(0)}% edge=${pick.edge.toFixed(3)} d=${(d * 100).toFixed(3)}% t=${elapsed.toFixed(0)}% spotAge=${spotAge}ms · ${m.question.slice(0, 40)}`;

  if (!LIVE || !trader) { log(`DRY  would BUY ${tag}`); return; }
  if (stats.orders >= MAX_ORDERS) { log(`⏸ MAX_ORDERS (${MAX_ORDERS}) reached — safety cap, not placing more. ${tag}`); return; }
  const t0 = Date.now();
  const r = await trader.place({ tokenId: pick.token, priceCents, sizeShares: shares });
  const lat = Date.now() - t0;
  stats.orders++;
  if (r.ok) { stats.fills++; log(`BUY  ${tag} · lat=${lat}ms · sig=${trader.sigName()} ✓`); }
  else { log(`FAIL ${tag} · lat=${lat}ms · sig=${trader.sigName()} · ${String(r.err).slice(0, 140)}`); }
}

(async function main() {
  log(`qtable-live: ${LIVE ? "🔴 LIVE" : "🟡 DRY-RUN"} · $${STAKE}/trade · edge>=${EDGE} · ${COINS.join(",")} · STRICT guards`);
  if (!KEY && LIVE) { log("LIVE=1 but POLYMARKET_PRIVATE_KEY is empty — refusing to start."); process.exit(1); }
  if (KEY) {
    // Pre-flight runs in BOTH modes (read-only: derives API creds, reads balance, checks geoblock —
    // NO orders). In dry-run it just proves your setup is good before you flip LIVE=1.
    const { makePolymarket } = await import("./polymarket.mjs");
    pm = await makePolymarket({ polymarket: { privateKey: KEY, funderAddress: (process.env.POLYMARKET_FUNDER || "").trim() || undefined } });
    const gb = await pm.geoblock(); const bal = await pm.getBalanceUsd(); const bb = pm.balanceBreakdown();
    log(`wallet ${pm.address} · type ${pm.sigTypeName} · cash $${bal.toFixed(2)} (on-chain $${(bb.onchain ?? 0).toFixed(2)} / deposited-in-Polymarket $${(bb.clob ?? 0).toFixed(2)}) · builder-fee ${pm.builderFee ? "on" : "off"} · geoblock ${gb.blocked ? "BLOCKED(" + gb.country + ")" : "ok"}`);
    if (LIVE && gb.blocked) { log("egress IP is geoblocked — orders would 403. Stop and use an allowed region."); process.exit(1); }
    if ((bb.clob ?? 0) < STAKE && (bb.onchain ?? 0) >= STAKE) log(`⚠ your USDC is ON-CHAIN in the proxy but NOT deposited into Polymarket (deposited=$${(bb.clob ?? 0).toFixed(2)}). The CLOB rejects every order with "use the deposit wallet flow" until you complete DEPOSIT in the Polymarket app for this account.`);
    else if (LIVE && bal < STAKE) log(`⚠ cash $${bal.toFixed(2)} < stake $${STAKE} — orders will fail until funded.`);
    if (!LIVE) log("↑ pre-flight OK (dry-run — no orders). Set LIVE=1 in qtable-live.env to trade for real.");
  }
  if (KEY) {
    trader = await makeTrader(KEY, (process.env.POLYMARKET_FUNDER || "").trim() || undefined);
    log(`order signer: ${trader.sigName()}${process.env.QTL_SIG_TYPE ? " (forced via QTL_SIG_TYPE)" : ""} · auto-retries as POLY_1271 if this is a deposit wallet`);
  }
  connectChainlink();
  await discover();
  setInterval(discover, 15_000);
  setInterval(backfillRefs, 4_000);
  setInterval(() => log(`… tracking ${markets.size} markets · signals ${stats.signals} · orders ${stats.orders} · fills ${stats.fills}`), 30_000);

  // fast loop: evaluate every in-window market as quickly as the book fetches allow
  while (true) {
    const t0 = Date.now();
    try { await Promise.all([...markets.values()].map(evalMarket)); } catch (e) { log("loop err", e?.message); }
    await new Promise((res) => setTimeout(res, Math.max(120, 250 - (Date.now() - t0))));
  }
})();
