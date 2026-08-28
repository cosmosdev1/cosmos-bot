// Polymarket integration. The wallet private key stays on THIS machine and only signs orders.
// The bot posts each signed order DIRECTLY to Polymarket (so Polymarket sees the user's own
// region), then reports it to Cosmos for $0.09 metering. Written against @polymarket/clob-client-v2
// (Polymarket's CLOB V2 client — the old clob-client signs an order version V2 now rejects).
import { ClobClient, Side, OrderType, AssetType, Chain, SignatureTypeV2, createL1Headers } from "@polymarket/clob-client-v2";
import { readFileSync as _rfs, writeFileSync as _wfs, mkdirSync as _mkd } from "node:fs";
import { homedir as _home } from "node:os";
import { join as _pjoin } from "node:path";
import { createWalletClient, createPublicClient, http, fallback } from "viem";
import { polygon } from "viem/chains";
import { makeSigner } from "./signer.mjs";
import { fleetHalted, fleetMaxTradePct } from "./fleetstate.mjs";

// Polygon RPCs for the on-chain USDC read. viem's default for the polygon chain (polygon-rpc.com)
// now returns 401 Unauthorized (it went key-only), which silently killed the on-chain balance leg
// on EVERY bot - so cash could read $0 for users whose USDC sits in the proxy wallet. Use proven
// free public RPCs with automatic failover; COSMOS_RPC_URL (comma-separated) overrides.
const RPC_URLS = (process.env.COSMOS_RPC_URL || "https://polygon-bor-rpc.publicnode.com,https://polygon.drpc.org")
  .split(",").map((s) => s.trim()).filter(Boolean);

const CLOB_HOST = "https://clob.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";
const GAMMA = "https://gamma-api.polymarket.com";

// USDC on Polygon: bridged USDC.e (Polymarket's collateral) + native USDC. We read the funder's USDC
// on-chain (authoritative, never stale, correct wallet) and only fall back to the CLOB's cached
// balance if the on-chain read is ~0 - matching the whales-radar portfolio_sizer approach.
// pUSD FIRST (incident 2026-08-05). Polymarket migrated its collateral to its own token, and a
// modern deposit wallet holds nothing but pUSD - so reading only USDC.e answered a truthful $0 and
// the bot sized every entry off "no cash". Ten hosted accounts holding $2,445 between them were
// invisible this way, one of them $1,213, one $907. Read all three and take the largest.
const USDC_ADDRESSES = [
  "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB", // pUSD - Polymarket USD (current collateral)
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC.e (bridged) - legacy collateral
  // CHECKSUM FIX (2026-08-18): this address carried an invalid EIP-55 checksum ("...d8cc03..."
  // where the correct byte is "...d8cC03..."). viem REJECTS a mis-checksummed address before any
  // network call, and the per-token read swallows the throw as 0n - so native-USDC cash has
  // always read as $0, silently, for every account holding it. Found only because the batched
  // read validates all addresses up front and failed loudly where the sequential one did not.
  "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // native USDC
];
const ERC20_BALANCE_ABI = [{
  name: "balanceOf", type: "function", stateMutability: "view",
  inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }],
}];

// Cosmos's Polymarket BUILDER CODE (bytes32). When set (non-zero), every order the bot signs
// carries it, so Polymarket takes Cosmos's builder fee out of the fill — the user simply earns a
// little less, with no separate bill, and Cosmos stays fully non-custodial (the code is just a
// field inside the user's own locally-signed order). The builder fee is Cosmos's payment for the
// signal feed and is NOT optional: the server reconciles on-chain trades against the builder
// ledger daily and stops serving signals to bots whose trades don't carry the code (see ToS).
// COSMOS_BUILDER_CODE may override to another VALID code (ops flexibility); an invalid or zero
// value falls back to the default — it never disables attribution.
const ZERO32 = "0x" + "0".repeat(64);
// Cosmos's Polymarket builder code (public, safe to ship). Updated 2026-07-20 after the account
// migration -> fees now land in the NEW builder wallet 0xb1a0303affadd68a63a128ac1c3f02811239e45e.
const DEFAULT_BUILDER_CODE = "0xbb05bc9c71cb8e40ba9a0fab6e58bcac9df3cb53fb0b2553628b3c2bde5d6bf7";
const envCode = (process.env.COSMOS_BUILDER_CODE || "").trim();
const BUILDER_CODE = /^0x[0-9a-fA-F]{64}$/.test(envCode) && envCode !== ZERO32 ? envCode : DEFAULT_BUILDER_CODE;
const builderOn = true;
// AFFILIATE ROTATION (owner 2026-07-16; tiered 2026-08-02): when this user was referred by an active
// affiliate, the server sends the affiliate's builder code plus a SLOT COUNT k, and k orders out of
// every 36 carry IT instead of Cosmos's, paid by Polymarket directly to their account (never via
// Cosmos). k is the affiliate's tier: 7 at base (1.80% fee x 7/36 = exactly the 0.35% the site
// quotes) up to 20 at 650 referrals (= 1.00%). The window is 36 because it is the only small
// denominator where EVERY tier's share (rate / 1.80%) is a whole number of orders. "Every Nth
// order" could not express the ladder - 0.40% is every 4.5th, 1.00% every 1.8th.
// The counter persists to disk so restarts don't reset the cadence.
// COSMOS_DATA_DIR when set (Fly mounts /data — keep that); otherwise a FIXED per-user dir
// (~/.cosmos), NOT the cwd: a bot relaunched from a different directory (or a host whose working
// dir is wiped on restart) would silently reset the 1-in-5 cadence and over/under-serve the
// affiliate's share. The home dir survives restarts everywhere.
const ROT_DIR = process.env.COSMOS_DATA_DIR
  ? process.env.COSMOS_DATA_DIR.replace(/\/$/, "")
  : _pjoin(_home(), ".cosmos");
try { _mkd(ROT_DIR, { recursive: true }); } catch { /* rotSave stays best-effort */ }
const ROT_FILE = _pjoin(ROT_DIR, "builder-rotation.json");
let rotN = 0; try { rotN = Number(JSON.parse(_rfs(ROT_FILE, "utf8")).n) || 0; } catch { /* fresh */ }
function rotSave() { try { _wfs(ROT_FILE, JSON.stringify({ n: rotN })); } catch { /* best-effort */ } }
const AFF_WINDOW = 36;
const AFF_SLOTS_DEFAULT = 7; // base tier - what a bot pays when the server predates affiliate_slots
// Bresenham spacing: order n is an affiliate slot when floor(n*k/36) ticks over. The k slots land
// evenly through the window (k=7 -> gaps of 5 and 6, practically today's cadence; k=20 -> every
// other order, then two in a row once per window) instead of clumping at the window's start - so a
// low-volume bot that only places a few orders a day still serves the affiliate their true share.
const affSlotHit = (n, k) => Math.floor((n * k) / AFF_WINDOW) > Math.floor(((n - 1) * k) / AFF_WINDOW);

// ============================================================================
// LOCAL RISK CAP (2026-07-22) — the last line of defence against a COMPROMISED
// COSMOS SERVER. Cosmos never holds the key, but the bot polls Cosmos for signals,
// sizing and exit advice. If that server is breached it could tell every bot to
// "buy 10% of portfolio of a 1c longshot" and drain the fleet. Every BUY in the
// entire codebase — every engine, present and future — funnels through placeOrder
// below, so this is the ONE choke point where a hard bound belongs.
//
// It uses ZERO server-supplied values: the portfolio basis is the bot's OWN
// on-chain USDC + Polymarket position value (cached from getBalanceUsd/
// getPortfolioValue, which read the chain and Polymarket's data-api — never
// Cosmos), and the limits are constants compiled into the git-pulled src/. The
// env overrides can only LOWER a cap, never raise it, so a hostile server that
// also set env vars (it can't — those live on the user's own Fly machine) still
// couldn't widen these. A lying server can still pick a bad market, but each hit
// costs at most one clamped fill, and the rolling governor bounds the bleed per
// hour and per day regardless of how the loss is realised (counted on BUYS, never
// reduced by sells — so attacker-driven exits can't free the budget to buy again).
const capPct = (env, hard) => { const v = Number(process.env[env]); return Number.isFinite(v) && v > 0 ? Math.min(v, hard) : hard; };
const MAX_TRADE_PCT = capPct("COSMOS_MAX_TRADE_PCT", 5);    // one fill: <=5% of portfolio (owner 2026-07-22)
// PER STRATEGY (owner 2026-08-18). v2 enters only inside a 1h-4h window, so the same dollar is
// meant to recycle several times a day; v1 parks capital for days and keeps the numbers it has
// always run on. One bot process serves ONE user, so a module-level flag IS per-user here - and
// v2 is a five-account pilot, so the wider envelope must not reach the other 83 bots.
// setStrategyV2() is called each cycle from bot.mjs with the server's per-user answer.
let V2_BUDGETS = false;
export function setStrategyV2(on) { V2_BUDGETS = on === true; }
const MAX_HOUR_PCT_V1 = capPct("COSMOS_MAX_HOUR_PCT", 40);  // rolling 60min buy-volume ceiling
const MAX_HOUR_PCT_V2 = capPct("COSMOS_V2_MAX_HOUR_PCT", 70);
const MAX_HOUR_PCT = () => (V2_BUDGETS ? MAX_HOUR_PCT_V2 : MAX_HOUR_PCT_V1);
// Matched to the platform gate (CLOUD_MAX_DAY_PCT / CLOUD_V2_MAX_DAY_PCT). These must move TOGETHER
// per strategy - the LOWER of the pair actually binds, so a mismatch silently self-limits the bot
// before the gate is ever asked.
const MAX_DAY_PCT_V1 = capPct("COSMOS_MAX_DAY_PCT", 250);   // rolling 24h buy-volume ceiling
const MAX_DAY_PCT_V2 = capPct("COSMOS_V2_MAX_DAY_PCT", 800);
const MAX_DAY_PCT = () => (V2_BUDGETS ? MAX_DAY_PCT_V2 : MAX_DAY_PCT_V1);
const MAX_HOUR_BUYS = Math.min(Number(process.env.COSMOS_MAX_HOUR_BUYS) || 45, 45); // count backstop (legit peak ~38: copy 30 + qt 4 + cert 4)
const MIN_FLOOR_USD = 2;                                    // never clamp a fill below the ~$1-2 min order — sub-$50 accounts must still trade
let lastLocalPortfolio = 0;                                 // set ONLY by getBalanceUsd/getPortfolioValue (chain + Polymarket)
const setLocalPortfolio = (v) => { if (Number.isFinite(v) && v > 0) lastLocalPortfolio = v; };
const SPEND_FILE = _pjoin(ROT_DIR, "risk-ledger.json");
let spendLog = []; try { spendLog = (JSON.parse(_rfs(SPEND_FILE, "utf8")).buys || []).filter((b) => b && Number.isFinite(b.t)); } catch { /* fresh */ }
function spendSave() { try { _wfs(SPEND_FILE, JSON.stringify({ buys: spendLog.slice(-400) })); } catch { /* best-effort */ } }
function spendWindow(sinceMs) { const cut = Date.now() - sinceMs; return spendLog.filter((b) => b.t >= cut).reduce((s, b) => s + (b.usd || 0), 0); }
// Returns {shares, capped, reason} — the shares actually allowed for this BUY (0 = refuse). Portfolio
// unknown (a cold boot before the first balance read) -> allow ONLY the $ floor, never an unbounded order.
function riskClampBuy(sizeShares, price) {
  const port = lastLocalPortfolio;
  const wantUsd = sizeShares * price;
  const fleetPct = fleetMaxTradePct();                         // signed live tightening (null = none)
  const effPct = fleetPct != null ? Math.min(MAX_TRADE_PCT, fleetPct) : MAX_TRADE_PCT;
  const perFillUsd = port > 0 ? Math.max(MIN_FLOOR_USD, (port * effPct) / 100) : MIN_FLOOR_USD;
  // rolling governors (buy-volume, never reduced by sells) + count backstop
  // FLOORED at MIN_FLOOR_USD (2026-07-26): 40%/h of a sub-$5 portfolio computes under the $2 floor,
  // so roomUsd < floor refused EVERY buy at ZERO spend ("rolling buy-volume cap (h 0/2)") — the same
  // bug class as the copy posCeil $1 floor, one layer deeper. With the floor, a tiny account places
  // ~one $2 clip per hour window instead of being silently dead.
  const hourCap = port > 0 ? Math.max(MIN_FLOOR_USD, (port * MAX_HOUR_PCT()) / 100) : MIN_FLOOR_USD;
  const dayCap  = port > 0 ? Math.max(MIN_FLOOR_USD, (port * MAX_DAY_PCT()) / 100) : MIN_FLOOR_USD;
  const hourSpent = spendWindow(3600e3), daySpent = spendWindow(86400e3);
  const hourBuys = spendLog.filter((b) => b.t >= Date.now() - 3600e3).length;
  if (hourBuys >= MAX_HOUR_BUYS) return { shares: 0, capped: true, reason: `hourly buy-count cap (${hourBuys}/${MAX_HOUR_BUYS})` };
  const roomUsd = Math.min(perFillUsd, Math.max(0, hourCap - hourSpent), Math.max(0, dayCap - daySpent));
  if (roomUsd < MIN_FLOOR_USD) return { shares: 0, capped: true, reason: `rolling buy-volume cap (h ${hourSpent.toFixed(0)}/${hourCap.toFixed(0)} · d ${daySpent.toFixed(0)}/${dayCap.toFixed(0)})` };
  if (wantUsd <= roomUsd) return { shares: sizeShares, capped: false, reason: "" };
  return { shares: Math.floor((roomUsd / price) * 100) / 100, capped: true, reason: `per-fill/${MAX_TRADE_PCT}% clamp $${wantUsd.toFixed(0)}->$${roomUsd.toFixed(0)}` };
}
function riskRecordBuy(usd) { spendLog.push({ t: Date.now(), usd }); if (spendLog.length > 500) spendLog = spendLog.slice(-400); spendSave(); }

// ---- BALANCE READ CACHE (2026-08-18) ----
// The cash number was re-read from the chain EVERY cycle (~30s) x3 collateral tokens = ~259k
// on-chain calls per bot per month, and that loop - not the whale watching - was ~95% of our RPC
// consumption. It is also pure waste: a bot's cash changes at exactly one moment, when one of its
// own orders fills, and that moment is observable locally.
//
// So: serve the cached number for BAL_TTL_MS, and invalidate the instant a fill is recorded, so
// the read after a fill is always live. NOTHING about signal speed changes - whale detection is
// push-based (chainwatch subscribes; it does not poll) and never touched this path. Sizing was
// already computed from an in-memory number (lastLocalPortfolio); this only changes how often
// that memory is refreshed from the network.
//
// Deliberately NOT cached: the post-fill read (invalidated), and any caller passing {fresh:true}.
// A failed read is never cached - the existing lastGoodBalance fallback still covers blips.
const BAL_TTL_MS = Number(process.env.COSMOS_BALANCE_TTL_MS) || 300_000;   // 5 min
let balCache = { at: 0, usd: null };
let balInflight = null;                        // single-flight: concurrent callers share one read
function invalidateBalanceCache() { balCache = { at: 0, usd: null }; }

// ---- ACTUAL-FILL extraction (2026-07-19) ----
// The CLOB's POST /order response (clob-client-v2 OrderResponse: { success, errorMsg, orderID,
// transactionsHashes, tradeIDs, status, takingAmount, makingAmount }) reports what actually MATCHED,
// as maker/taker asset amounts:
//   BUY : maker asset = USDC   -> makingAmount = $ spent,      takingAmount = shares received
//   SELL: maker asset = shares -> makingAmount = shares sold,  takingAmount = $ received
// A FAK's price is only a CEILING and its size only a REQUEST — the real fill is routinely smaller
// and better-priced (a "97c" order really filled 3.96 sh @ 49c; a sell ledgered $132 vs $242 real).
// Returns:
//   { shares, priceCents }  something matched (partial or full) — shares filled + avg price in cents
//   { shares: 0 }           fill fields present and zero: the FAK was killed with NOTHING filled
//   null                    no readable fill info in the response (caller falls back + flags it)
// Units are validated, never assumed: the amounts are documented as human-decimal strings, but if a
// raw read violates the hard invariants we retry the read as 1e6 base units; if neither
// interpretation is sane we return null rather than guess.
//
// WHICH LEG IS CAPPED DEPENDS ON THE SIDE (fixed 2026-08-09). The old code capped SHARES on both
// sides ("filled ≤ requested"). That is true for a SELL — we cannot deliver more shares than we
// offered — but FALSE for a BUY: a marketable FAK buy commits reqShares × limit in USDC and spends
// all of it, so whenever it matches BELOW the limit it hands back MORE shares than requested. The
// share cap therefore rejected precisely the price-improved (i.e. successful) buys, fell through to
// null, and the caller ledgered the INTENT — the requested size at the limit price. Dollars stayed
// exact while share counts ran ~7% low, and because lib/bot-pnl.ts marks losers at 0c and winners at
// 100c, the missing shares only ever subtracted from WINNERS: real profits displayed as losses.
// A BUY's true ceiling is the USDC leg — never more than we committed. (Note the price-sanity check
// cannot discriminate units on its own: div cancels out of usd/shares, so priceC is identical for
// both readings. The magnitude cap is the ONLY unit discriminator, which is why each side needs the
// correct one rather than a shared approximation.)
function extractFill(resp, side, reqShares, limitCents) {
  const t = Number(resp?.takingAmount), m = Number(resp?.makingAmount);
  if (!Number.isFinite(t) || !Number.isFinite(m)) return null;
  if (t === 0 && m === 0) return { shares: 0 };
  // What a BUY can spend: the committed USDC. Without a usable limit, a share can never cost more
  // than $1, so reqShares dollars is always a valid (looser) ceiling.
  const usdCap = Number.isFinite(limitCents) && limitCents > 0 ? reqShares * (limitCents / 100) : reqShares;
  for (const div of [1, 1e6]) {
    const shares = (side === "SELL" ? m : t) / div;   // the shares leg of the fill
    const usd = (side === "SELL" ? t : m) / div;      // the USDC leg of the fill
    if (!(shares > 0) || !(usd > 0)) continue;
    const priceC = (usd / shares) * 100;
    const withinCap = side === "SELL" ? shares <= reqShares * 1.001 : usd <= usdCap * 1.001;
    if (withinCap && priceC >= 0.1 && priceC <= 100.5) {
      const sh = Math.round(shares * 100) / 100;      // 2dp — matches Polymarket's share precision
      // Sub-0.005-share dust = effectively nothing filled — but only trust that verdict from the
      // primary human-units reading. In the 1e6 fallback a "dust" result is more likely a misparse,
      // and misreading a REAL fill as zero would make the caller retry into a double-buy: fall
      // through to null (fill_unknown) instead, which never re-fires an order.
      if (!(sh > 0)) { if (div === 1) return { shares: 0 }; continue; }
      return { shares: sh, priceCents: Math.round(priceC * 100) / 100 };
    }
  }
  return null;
}

// The audit-relevant slice of the CLOB's order response, reported to the server via meter() so
// bot_orders.polymarket_response lets fills be audited server-side (orderID + tx hashes + the
// taking/making amounts are the reconciliation gold). Only these fields — never the whole client
// object — and the server caps the stored payload at ~4KB on top.
function trimClobResp(resp) {
  if (!resp || typeof resp !== "object") return null;
  const { success, errorMsg, error, orderID, status, takingAmount, makingAmount, transactionsHashes, tradeIDs } = resp;
  return { success, errorMsg, error, orderID, status, takingAmount, makingAmount, transactionsHashes, tradeIDs };
}

export async function makePolymarket(config) {
  // viem signer (CLOB V2 is viem-based). COSMOS_SIGNER=local (default) keeps the key in this
  // process exactly as before; COSMOS_SIGNER=turnkey signs remotely inside the user's own enclave
  // sub-organization, policy-limited to Polymarket orders only. Everything downstream is unchanged
  // either way - the ClobClient just needs a viem account. See src/signer.mjs.
  const { account, address, mode: signerMode } = await makeSigner(config);
  const walletClient = createWalletClient({ account, chain: polygon, transport: http() });
  if (signerMode !== "local") console.log(`[polymarket] signer: ${signerMode} (${address})`);
  const funder = config.polymarket.funderAddress || address;
  const publicClient = createPublicClient({ chain: polygon, transport: fallback(RPC_URLS.map((u) => http(u))) });
  let lastGoodBalance = null; // last non-zero cash read, so a transient RPC/API blip never sizes off $0
  let lastBalanceBreakdown = { onchain: null, clob: null }; // for telemetry: WHERE the cash actually is
  let lastGoodValue = null; // last good Polymarket /value total (authoritative portfolio value)
  let lastClobRefresh = 0; // last time we forced the CLOB to recompute its cached balance

  // L1: derive (or create) the L2 API credentials from a wallet signature. These are bound to the
  // SIGNER EOA — correct for EOA / POLY_PROXY / Safe accounts.
  //
  // PRE-SUPPLIED CREDS SKIP DERIVATION ENTIRELY (hosted prove-out 2026-07-30). Derivation is free
  // when the key is local, but hosted every L1 header is a PAID enclave ClobAuth signature — and
  // createOrDeriveApiKey signs TWICE (create, then derive, each building its own header). Five boots
  // exhausted the platform's 8/day ClobAuth cap without placing a single order. Credentials are
  // deterministic per signer and long-lived, so deriving them once and injecting them here turns
  // every later boot into zero ClobAuth spend. Env names mirror the platform's cloud_accounts cache.
  const injected = {
    key: process.env.CLOB_API_KEY || config?.polymarket?.clobApiKey || "",
    secret: process.env.CLOB_API_SECRET || config?.polymarket?.clobApiSecret || "",
    passphrase: process.env.CLOB_PASSPHRASE || config?.polymarket?.clobPassphrase || "",
  };
  const haveInjected = injected.key && injected.secret && injected.passphrase;
  if (haveInjected) console.log("[polymarket] CLOB creds injected from config — skipping derivation (0 signatures)");
  const pre = new ClobClient({ host: CLOB_HOST, chain: Chain.POLYGON, signer: walletClient });
  const creds = haveInjected ? injected : await pre.createOrDeriveApiKey();

  // API key bound to the FUNDER (deposit wallet), signed by the EOA — REQUIRED for POLY_1271 accounts
  // (Polymarket's NEW deposit-wallet flow): the CLOB demands order.signer (= the deposit wallet) equal
  // the API key's address, so the EOA-bound `creds` above are rejected with "maker address not
  // allowed, please use the deposit wallet flow". Ported from the validated qtable-live tester —
  // without this, every new-style Polymarket account fails 100% of its orders.
  const TRACE_2E_MAX = Number(process.env.COPY_2E_TRACE_MAX ?? 25);
let trace2eN = 0;
function trace2e(f) {
  if (trace2eN >= TRACE_2E_MAX) return;
  trace2eN++;
  console.log(`[2e-trace] ${JSON.stringify(f)}${trace2eN === TRACE_2E_MAX ? " (trace cap reached, no further 2e lines)" : ""}`);
}

const DEPOSIT_ERR = /deposit wallet|maker address not allowed|signer address has to be the address of the API/i;
  // Funder-bound creds may be INJECTED like the EOA-bound set (policy v2, 2026-07-30): the platform
  // caches them per hosted account (cloud_accounts.clob_deposit_*), and hosted every L1 header is a
  // paid enclave ClobAuth signature — injection makes a deposit-wallet boot cost zero.
  const injectedDeposit = {
    key: process.env.CLOB_DEPOSIT_API_KEY || config?.polymarket?.clobDepositApiKey || "",
    secret: process.env.CLOB_DEPOSIT_API_SECRET || config?.polymarket?.clobDepositApiSecret || "",
    passphrase: process.env.CLOB_DEPOSIT_PASSPHRASE || config?.polymarket?.clobDepositPassphrase || "",
  };
  let depositCreds = injectedDeposit.key && injectedDeposit.secret && injectedDeposit.passphrase ? injectedDeposit : null;
  if (depositCreds) console.log("[polymarket] deposit-wallet CLOB creds injected from config — skipping funder derivation (0 signatures)");
  const deriveForFunder = async () => {
    if (depositCreds) return depositCreds;
    try {
      // ONE set of L1 headers for BOTH fetches (policy v2): the ClobAuth signature covers only
      // address+timestamp+nonce+message, never method or path — and hosted, each header build is a
      // PAID enclave signature. Building it twice literally doubled the cost of every derivation.
      const h = await createL1Headers(walletClient, 137, 0, undefined, funder);
      // SURFACE the CLOB's own words on failure. Swallowing them into `null` cost a paid signature
      // and told us nothing — "could not derive a deposit-wallet API key" is not a diagnosis.
      const call = async (method, path) => {
        const r = await fetch(`${CLOB_HOST}${path}`, { method, headers: h, signal: AbortSignal.timeout(10_000) });
        const body = await r.text().catch(() => "");
        if (!r.ok) { console.warn(`[polymarket] funder-key ${method} ${path} -> ${r.status} ${body.slice(0, 220)}`); return null; }
        try { return JSON.parse(body); } catch { return null; }
      };
      let jj = await call("POST", "/auth/api-key");
      if (!jj?.apiKey) jj = await call("GET", "/auth/derive-api-key");
      depositCreds = jj?.apiKey ? { key: jj.apiKey, secret: jj.secret, passphrase: jj.passphrase } : null;
    } catch (e) { console.warn(`[polymarket] funder-key derivation threw: ${e?.message ?? e}`); depositCreds = null; }
    console.log(depositCreds ? "[polymarket] ✓ API key bound to the deposit wallet (POLY_1271 ready)" : "[polymarket] ⚠ could not derive a deposit-wallet API key");
    return depositCreds;
  };

  // ---- AUTO-DETECT the Polymarket account's SIGNATURE TYPE. ----
  // Polymarket has FOUR account kinds, and hardcoding POLY_PROXY (the original email/Magic wallets)
  // silently broke every newer account: the CLOB derives the trading account from signer +
  // signature_type, so the wrong type resolves a DIFFERENT (empty) account - balance reads $0 and
  // orders can't spend the user's real cash, even though the app shows money. Verified on-chain:
  //   - legacy email accounts  -> 45-byte EIP-1167 minimal proxy  -> POLY_PROXY (1)
  //   - browser-wallet accounts-> Gnosis Safe proxy               -> POLY_GNOSIS_SAFE (2)
  //   - NEW Polymarket wallets -> EIP-1967 smart wallet           -> POLY_1271 (3)
  //   - direct EOA trading     -> funder == signer                -> EOA (0)
  // Strategy: classify the funder's bytecode, then PROBE the CLOB balance under each candidate type
  // (read-only) - a non-zero balance is positive proof the type resolves the user's real account.
  // If every probe reads 0 (genuinely empty account), trust the bytecode classification.
  const mkClient = (sigType) => {
    const o = { host: CLOB_HOST, chain: Chain.POLYGON, signer: walletClient, creds, signatureType: sigType, funderAddress: funder };
    if (builderOn) o.builderConfig = { builderCode: BUILDER_CODE };
    return new ClobClient(o);
  };
  const probeClob = async (sigType) => {
    try {
      const r = await mkClient(sigType).getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      return Number(r?.balance ?? 0) / 1e6;
    } catch { return null; }
  };
  const SIG_NAMES = { 0: "EOA", 1: "POLY_PROXY", 2: "POLY_GNOSIS_SAFE", 3: "POLY_1271" };
  let sigType = SignatureTypeV2.POLY_PROXY;
  let walletKind = "unknown";
  // EXPLICIT OVERRIDE beats guessing (hosted prove-out 2026-07-30). The heuristics below misread the
  // owner's 146-byte proxy variant (bytecode matched none of the known patterns -> "safe-or-other")
  // and the balance probe then confirmed the WRONG type, because the CLOB answers a balance under
  // more than one type for some accounts. Under POLY_1271 the client wraps orders in an ERC-7739
  // TypedDataSign envelope, which the hosted gate (and the enclave policy, pinned to primaryType
  // 'Order') rightly refuses — so a misdetection means no order can ever sign. Hosted accounts have
  // a CLOB-verified type recorded platform-side (cloud_accounts.sig_type); passing it here skips
  // detection entirely. Self-hosted users can set it too if detection ever misreads their wallet.
  const SIG_BY_NAME = { EOA: SignatureTypeV2.EOA, POLY_PROXY: SignatureTypeV2.POLY_PROXY, POLY_GNOSIS_SAFE: SignatureTypeV2.POLY_GNOSIS_SAFE, POLY_1271: SignatureTypeV2.POLY_1271 };
  const forcedName = String(process.env.POLYMARKET_SIG_TYPE || config?.polymarket?.sigType || "").toUpperCase().trim();
  const forced = Object.prototype.hasOwnProperty.call(SIG_BY_NAME, forcedName);
  if (forced) { sigType = SIG_BY_NAME[forcedName]; walletKind = "forced-by-config"; }
  else try {
    if (funder.toLowerCase() === address.toLowerCase()) {
      sigType = SignatureTypeV2.EOA; walletKind = "eoa";
    } else {
      const getCode = publicClient.getCode ?? publicClient.getBytecode; // viem renamed getBytecode -> getCode
      const code = (await getCode.call(publicClient, { address: funder }).catch(() => null)) ?? "0x";
      let candidates;
      if (code.includes("360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc")) {
        walletKind = "smart-wallet-1967"; candidates = [SignatureTypeV2.POLY_1271, SignatureTypeV2.POLY_GNOSIS_SAFE, SignatureTypeV2.POLY_PROXY];
      } else if (code.includes("5af43d82803e903d91602b57fd5bf3")) {
        walletKind = "magic-proxy-1167"; candidates = [SignatureTypeV2.POLY_PROXY, SignatureTypeV2.POLY_GNOSIS_SAFE, SignatureTypeV2.POLY_1271];
      } else if (code === "0x") {
        walletKind = "no-contract"; candidates = [SignatureTypeV2.POLY_PROXY, SignatureTypeV2.POLY_GNOSIS_SAFE, SignatureTypeV2.POLY_1271];
      } else {
        walletKind = "safe-or-other"; candidates = [SignatureTypeV2.POLY_GNOSIS_SAFE, SignatureTypeV2.POLY_1271, SignatureTypeV2.POLY_PROXY];
      }
      sigType = candidates[0]; // bytecode-implied default
      for (const t of candidates) {
        const bal = await probeClob(t);
        if (bal != null && bal >= 0.01) { sigType = t; break; } // the user's own cash confirms the type
      }
    }
  } catch { /* detection must never block startup - default stays POLY_PROXY */ }
  console.log(`[polymarket] account type: ${SIG_NAMES[sigType]} (wallet: ${walletKind})`);

  // FUNDER SANITY CHECK (non-blocking, loud): the #1 silent-failure onboarding mistake is pasting the
  // wrong address — the DEPOSIT address from the deposit dialog, a truncated paste, or the untouched
  // placeholder — and the first symptom used to be "bot runs, never trades". Verify the funder against
  // Polymarket's public data API and say EXACTLY what's wrong in the log the user actually reads.
  try {
    const [valR, actR] = await Promise.all([
      fetch(`${DATA_API}/value?user=${funder}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`${DATA_API}/activity?user=${funder}&limit=1`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    const value = Array.isArray(valR) ? Number(valR[0]?.value ?? 0) : 0;
    const known = value > 0 || (Array.isArray(actR) && actR.length > 0);
    if (!known && funder.toLowerCase() !== address.toLowerCase()) {
      console.warn(
        `[polymarket] ⚠ FUNDER CHECK: ${funder} has NO history on Polymarket. This usually means the ` +
        `address is wrong — most often it's the DEPOSIT address instead of your account address. Open ` +
        `polymarket.com, click your profile picture, and copy the address shown on your PROFILE page ` +
        `(polymarket.com/profile/0x…). Then redeploy with that as POLYMARKET_FUNDER. The bot will keep ` +
        `running but cannot trade until this is fixed.`,
      );
    } else if (known) {
      console.log(`[polymarket] funder verified on Polymarket ✓`);
    }
  } catch { /* advisory only — never block startup */ }

  // Full client: L1 + L2 + the DETECTED signature type for the funder account. POLY_1271 (deposit
  // wallets) needs the FUNDER-bound key; everything else uses the EOA-bound key.
  // When a builder code is configured, builderConfig makes the client auto-stamp it onto every
  // order (the SDK applies it at order-build time), so Polymarket collects Cosmos's builder fee.
  const mkClientFor = (t, c, code = BUILDER_CODE) => {
    const o = { host: CLOB_HOST, chain: Chain.POLYGON, signer: walletClient, creds: c, signatureType: t, funderAddress: funder };
    if (builderOn) o.builderConfig = { builderCode: code };
    return new ClobClient(o);
  };
  // Affiliate client is built lazily and rebuilt whenever the code or the signature type changes
  // (the deposit-wallet recovery can flip sigType at order time).
  let affCode = null, affClient = null, affSig = null, affCreds = null, affSlots = AFF_SLOTS_DEFAULT;
  const getAffClient = () => {
    if (!affCode) return null;
    const c = sigType === SignatureTypeV2.POLY_1271 && depositCreds ? depositCreds : creds;
    if (!affClient || affSig !== sigType || affCreds !== c) { affClient = mkClientFor(sigType, c, affCode); affSig = sigType; affCreds = c; }
    return affClient;
  };
  // NOT at boot (prove-out 2026-07-30). A funder-bound key cannot be derived for a deposit wallet:
  // the CLOB answers 401 "Invalid L1 Request headers" because the funder is a CONTRACT and our
  // signature is a plain EOA ECDSA it cannot verify against it. And it is not needed — a POLY_1271
  // order signed as the ERC-7739 envelope authenticates fine under the EOA-bound key (proven: the
  // CLOB accepted the auth and moved on to validating amounts). Deriving it at boot therefore spent
  // a real enclave signature, every boot, for a call that always fails. The order-time recovery at
  // the DEPOSIT_ERR branch still tries it if the CLOB ever does demand one.
  if (sigType === SignatureTypeV2.POLY_1271 && /^(1|true|yes|on)$/i.test(process.env.COSMOS_DERIVE_FUNDER_KEY || "")) {
    await deriveForFunder();
  }
  let client = sigType === SignatureTypeV2.POLY_1271 && depositCreds ? mkClientFor(sigType, depositCreds) : mkClient(sigType);

  const tokenCache = new Map();
  // Midpoint cache fed by primeMidpoints() (scale build Inc 1.12). Deliberately SHORT: exit
  // decisions must price off a live book, so this only collapses the reads of ONE cycle pass.
  const midCache = new Map();
  const MID_TTL_MS = Number(process.env.MID_CACHE_TTL_MS) || 4000;

  return {
    address,
    funder,
    sigType, // the DETECTED Polymarket signature type (0 EOA / 1 proxy / 2 safe / 3 smart wallet)
    sigTypeName: SIG_NAMES[sigType],
    walletKind, // what the funder's bytecode says it is
    builderFee: builderOn, // whether a builder fee is being attached to orders

    // AFFILIATE ROTATION: server-controlled. null/invalid clears it (all orders -> Cosmos code).
    // slots = the referrer's tier (orders per 36); absent/invalid -> the base tier, so a bot talking
    // to an older server keeps earning the affiliate their floor rather than nothing.
    setAffiliateCode(code, slots) {
      const v = String(code || "").trim();
      const ok = /^0x[0-9a-fA-F]{64}$/.test(v) && v !== ZERO32 && v.toLowerCase() !== BUILDER_CODE.toLowerCase();
      const next = ok ? v : null;
      if (next !== affCode) { affCode = next; affClient = null; }
      const k = Math.floor(Number(slots));
      affSlots = Number.isFinite(k) && k >= 1 && k <= AFF_WINDOW ? k : AFF_SLOTS_DEFAULT;
    },

    // Free USDC (cash) on the FUNDER/proxy wallet, for position sizing. On-chain balanceOf FIRST
    // (authoritative, never stale, always the funder - not the signer-EOA-derived proxy the CLOB
    // balance endpoint silently resolves to); fall back to the CLOB's cached collateral only if
    // on-chain reads ~0; and cache the last non-zero value so a transient blip never sizes off $0.
    // (Open positions are added by the caller as `deployed` for the TRUE portfolio.)
    async getBalanceUsd(opts) {
      // Cached for BAL_TTL_MS and invalidated on every fill (see invalidateBalanceCache). Pass
      // {fresh:true} to force a live read. Concurrent callers share one in-flight read.
      const fresh = opts?.fresh === true;
      if (!fresh) {
        if (balCache.usd != null && Date.now() - balCache.at < BAL_TTL_MS) return balCache.usd;
        if (balInflight) return balInflight;
      }
      const run = (async () => {
      // Read BOTH the on-chain USDC on the funder AND the CLOB deposited collateral, and size off the
      // LARGER - a user's cash can sit EITHER on-chain in the proxy OR deposited in the CLOB exchange,
      // so we must use whichever actually holds it. Record the split (balanceBreakdown) for telemetry;
      // cache last-known-good so a transient blip never sizes off $0.
      let onchain = null;
      try {
        // ONE batched call for all three collateral tokens instead of three sequential ones
        // (multicall3, which viem's polygon chain config already knows). Same numbers, a third of
        // the requests and a third of the latency. Any failure falls back to the original
        // per-token reads, so an RPC without multicall support behaves exactly as before.
        let sum = null;
        try {
          const res = await publicClient.multicall({
            contracts: USDC_ADDRESSES.map((address) => ({ address, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [funder] })),
            allowFailure: true,
          });
          // EVERY call must succeed before the batch is believed. A partial result must NEVER be
          // summed: a failed leg is an UNKNOWN balance, not a zero, and treating it as zero is how
          // a funded account gets sized as broke. (Exactly what happened in testing: one
          // mis-checksummed address failed the whole batch and would have reported $0 for an
          // account holding $329.) Anything less than all-success falls through to the per-token
          // path below, which has its own last-known-good protection.
          if (Array.isArray(res) && res.length === USDC_ADDRESSES.length && res.every((r) => r?.status === "success")) {
            sum = res.reduce((t, r) => t + Number(r.result) / 1e6, 0);
          }
        } catch { sum = null; }
        if (sum == null) {
          // A FAILED per-token read is UNKNOWN, not $0 (2026-08-21). `.catch(() => 0n)` here
          // laundered every RPC failure into a zero balance, which meant `onchain` could never be
          // null - so the "both sources unreadable" protection below was unreachable dead code, and
          // a total RPC outage read as "the wallet is empty". A token read that fails poisons the
          // whole sum to unknown; a partial sum would under-report (pUSD is where most deposits
          // actually sit, e.g. $109-$329 measured on three live funders today).
          sum = 0;
          for (const token of USDC_ADDRESSES) {
            try {
              const raw = await publicClient
                .readContract({ address: token, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [funder] });
              sum += Number(raw) / 1e6; // USDC = 6 decimals
            } catch { sum = null; break; }
          }
        }
        onchain = sum;
      } catch { onchain = null; }
      let clob = null;
      try {
        const c = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        clob = Number(c?.balance ?? 0) / 1e6;
        // The CLOB's balance endpoint serves a CACHED number that can sit at a stale $0 (or an old
        // value) until an explicit refresh - and since Polymarket's newer deposits credit the CLOB
        // ledger rather than parking USDC in the proxy wallet, a stale $0 here means "user HAS cash,
        // bot sees none, never trades". When it reads ~0, force a server-side recompute (at most
        // once per 5 min) and read again.
        if (clob <= 0.01 && Date.now() - lastClobRefresh > 300_000) {
          lastClobRefresh = Date.now();
          try {
            await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
            const c2 = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
            clob = Number(c2?.balance ?? 0) / 1e6;
          } catch { /* keep the first read */ }
        }
      } catch { clob = null; }
      lastBalanceBreakdown = { onchain, clob };
      const best = Math.max(onchain ?? 0, clob ?? 0);
      if (best >= 0.01) {
        lastGoodBalance = best; setLocalPortfolio((lastGoodValue || 0) + best);
        balCache = { at: Date.now(), usd: best };     // cache SUCCESS only
        return best;
      }
      // A FAILED READ AND A REAL ZERO ARE NOT THE SAME THING (2026-08-21). This used to return
      // last-known-good for BOTH, which meant an account that genuinely emptied kept reporting its
      // old balance for the life of the process - and kept sizing, signing and burning Turnkey
      // signatures against money that was not there. Measured across the fleet: 4 accounts, 140
      // signatures in 7 days, zero fills, every one claiming cash while the chain, Polymarket and
      // the CLOB ledger all said $0. One of them had never held a cent in its life.
      //
      // `null` means the source did not answer; `0` means it answered and the wallet is empty. So:
      //   - at least one source answered ->  believe it, even when the answer is zero
      //   - nothing answered             ->  keep the blip protection this fallback exists for
      // WALLET-AWARE ZERO (2026-08-21, replacing this morning's version measured to be a
      // regression). For a proxy/1271 wallet, tradeable cash lives in the CLOB ledger and the
      // funder can legitimately read $0 on-chain forever - so "on-chain answered zero" proves
      // NOTHING while the CLOB read failed: believing it would zero out a funded account on any
      // CLOB blip (71 of 105 fleet accounts are POLY_1271; the pilot itself would silently stop
      // entering via the min-portfolio floor). The zero is believable only when every source that
      // could actually hold this wallet's cash answered:
      //   - CLOB answered (any wallet kind)  -> its ledger is authoritative for tradeable cash,
      //     and the on-chain leg was also read this cycle: an empty answer here is real.
      //   - CLOB failed but this account has never had CLOB creds provisioned (client absent) ->
      //     on-chain is the only source there is; believe its answer.
      //   - CLOB failed on a provisioned account -> UNKNOWN. Keep last-known-good, exactly the
      //     blip protection this fallback has always existed for.
      // `client` is always constructed (creds or not), so the provisioning signal is the creds
      // themselves: without them every CLOB call 401s forever and on-chain is the only real source.
      const clobProvisioned = !!creds;
      const zeroIsReal = clob != null || (!clobProvisioned && onchain != null);
      if (zeroIsReal) {
        lastGoodBalance = 0;
        return 0;
      }
      return lastGoodBalance ?? 0; // the source that could hold the cash did not answer: hold the line
      })();
      if (!fresh) balInflight = run;
      try { return await run; } finally { if (balInflight === run) balInflight = null; }
    },
    balanceBreakdown: () => lastBalanceBreakdown,
    // Exposed on the RETURNED object, not just as a module export: bot.mjs holds the factory
    // result (`pm`), so a module-level function would have been invisible to it and the optional
    // call would have silently no-opped - leaving a pilot account on the v1 budgets forever with
    // nothing in the logs to say so.
    setStrategyV2,

    // Polymarket's OWN authoritative total portfolio value for the funder (cash + all open positions
    // marked to market + redeemable), via the data-api /value endpoint. This is far more reliable than
    // summing /positions ourselves (a funder can have thousands of old resolved $0 positions across
    // many pages). Returns the number, or the last-good value on a transient failure, or null.
    async getPortfolioValue() {
      try {
        const r = await fetch(`${DATA_API}/value?user=${encodeURIComponent(funder)}`, { signal: AbortSignal.timeout(10_000) });
        if (r.ok) {
          const arr = await r.json();
          const v = Array.isArray(arr) ? Number(arr[0]?.value) : Number(arr?.value);
          if (Number.isFinite(v) && v >= 0.01) { lastGoodValue = v; setLocalPortfolio(v + (lastGoodBalance || 0)); return v; }
        }
      } catch { /* fall through to last-good */ }
      return lastGoodValue;
    },

    // Polymarket geoblock status for THIS server's egress IP (docs: GET /api/geoblock ->
    // { blocked, ip, country, region }). When blocked, every order is rejected with a 403, so we
    // check it up front and surface it clearly instead of blindly firing orders into a wall.
    async geoblock() {
      try {
        const res = await fetch("https://polymarket.com/api/geoblock", { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return { ok: false, status: res.status };
        const d = await res.json();
        return { ok: true, blocked: Boolean(d?.blocked), ip: d?.ip ?? null, country: d?.country ?? null, region: d?.region ?? null };
      } catch (e) {
        return { ok: false, error: e?.message };
      }
    },

    // Market end date (ISO) for a condition id - the horizon stop's capital-lock input.
    async getMarketEndDate(conditionId) {
      try {
        const res = await fetch(`${GAMMA}/markets?condition_ids=${encodeURIComponent(conditionId)}`, { signal: AbortSignal.timeout(10_000) });
        const arr = await res.json();
        const m = Array.isArray(arr) ? arr[0] : null;
        return m?.endDate ?? null;
      } catch {
        return null;
      }
    },

    // condition_id + outcome -> CLOB token id (needed to place an order).
    async resolveToken(conditionId, outcome) {
      const key = `${conditionId}:${outcome}`.toLowerCase();
      if (tokenCache.has(key)) return tokenCache.get(key);
      try {
        const res = await fetch(`${GAMMA}/markets?condition_ids=${encodeURIComponent(conditionId)}`, { signal: AbortSignal.timeout(10_000) });
        const arr = await res.json();
        const m = Array.isArray(arr) ? arr[0] : null;
        if (!m) return null;
        const names = JSON.parse(m.outcomes || "[]");
        const ids = JSON.parse(m.clobTokenIds || "[]");
        const i = names.findIndex((n) => String(n).toLowerCase() === String(outcome).toLowerCase());
        const tok = i >= 0 ? ids[i] : null;
        if (tok) tokenCache.set(key, tok);
        return tok;
      } catch {
        return null;
      }
    },

    // BATCH PRIME (scale build Inc 1.12, 2026-08-17). The exit pass reads one midpoint PER OPEN
    // POSITION PER CYCLE - at 20 positions x 2 cycles/min that is 40 CLOB round trips a minute
    // from ONE bot, and at fleet scale it is the heaviest load we put on the exchange (the audit's
    // ceiling #16: throttled price reads make take-profits and salvages stop firing fleet-wide).
    // getMidpoints() answers the whole set in ONE request. This primes a short-lived cache that
    // getPriceCents reads; ANY failure just leaves the cache empty and every caller falls back to
    // its own per-token request exactly as before - so the exit path can never depend on it.
    async primeMidpoints(tokenIds) {
      const ids = [...new Set((tokenIds || []).filter(Boolean).map(String))];
      if (ids.length < 2) return 0;                       // one position: no batching win
      try {
        const rows = await client.getMidpoints(ids.map((token_id) => ({ token_id })));
        const now = Date.now();
        let n = 0;
        // The endpoint answers either a map {tokenId: "0.42"} or an array of {token_id, mid}.
        if (rows && !Array.isArray(rows) && typeof rows === "object") {
          for (const [k, v] of Object.entries(rows)) {
            const p = Number(v?.mid ?? v);
            if (p > 0) { midCache.set(String(k), { at: now, cents: Math.round(p * 100) }); n++; }
          }
        } else if (Array.isArray(rows)) {
          for (const r of rows) {
            const p = Number(r?.mid ?? r?.price ?? 0);
            const id = String(r?.token_id ?? r?.asset_id ?? "");
            if (id && p > 0) { midCache.set(id, { at: now, cents: Math.round(p * 100) }); n++; }
          }
        }
        return n;
      } catch {
        return 0;                                          // fall back to per-token reads
      }
    },

    // Current mid price in cents (null if unavailable). Serves from the batch prime when fresh -
    // EXITS ONLY. Pass {fresh:true} to force a live read: ENTRY paths (the max_entry_price cap and
    // copytrade's priceFor) must never size or gate money-in off a cached price, however short the
    // window. Exits are safe on it because every sell still confirms against a LIVE best bid.
    async getPriceCents(tokenId, opts) {
      const hit = opts?.fresh ? null : midCache.get(String(tokenId));
      if (hit && Date.now() - hit.at < MID_TTL_MS) return hit.cents;
      try {
        const mid = await client.getMidpoint(tokenId);
        const p = Number(mid?.mid ?? 0);
        const cents = p > 0 ? Math.round(p * 100) : null;
        if (cents != null) midCache.set(String(tokenId), { at: Date.now(), cents });
        return cents;
      } catch {
        return null;
      }
    },

    // The LIVE best bid in cents - the highest price a buyer is currently resting. This is the price
    // a SELL is GUARANTEED to cross (a FAK sell priced at/under the best bid takes that resting bid
    // and fills). Selling off the mid alone misses when the book is thin/wide near the 1c/99c edges;
    // reading the real bid is what makes a stop actually fill. Returns null if there is NO bid at all
    // (nothing to sell into) or the book can't be read.
    async getBestBidCents(tokenId) {
      try {
        const book = await client.getOrderBook(tokenId);
        const bids = book?.bids || book?.buys || [];
        let best = 0;
        for (const b of bids) {
          const price = Number(b?.price ?? b?.[0] ?? 0);
          const size = Number(b?.size ?? b?.[1] ?? 0);
          if (price > best && size > 0) best = price;
        }
        return best > 0 ? Math.round(best * 100) : null;
      } catch {
        return null;
      }
    },

    // STAGE 2E LIVE TRACE - TEMPORARY AND BOUNDED. Remove once the invariant is confirmed.
    // Console only, never the database: a per-event DB write is what made scan_runs a 3.5M-row
    // problem. Hard-capped per process (default 25) so a busy bot cannot turn this into a log flood,
    // and it carries no secrets - numeric amounts plus a 12-char token prefix for correlation.
    // Purpose: prove on REAL venue-bound orders that k*c%100 != 0 is what the venue rejects, and
    // that the proposed floor is a no-op on orders that already satisfy it.

    // Sign an order locally and POST it DIRECTLY to Polymarket (your IP/region — not a server's).
    // FAK (Fill-And-Kill) = take whatever liquidity exists at this price NOW and cancel the rest;
    // the bot passes a *marketable* price (above mid to buy / below mid to sell). createAndPostOrder
    // builds + signs the V2 order and posts it in one call, auto-resolving tickSize + negRisk.
    async placeOrder({ tokenId, side, sizeShares, priceCents, orderType = "FAK" }) {
      const price = Math.max(0.01, Math.min(0.99, priceCents / 100));
      // Polymarket shares are fractional (6 decimals). Use the REAL size, floored to 2 decimals so a
      // SELL never exceeds the wallet balance; never round a sub-1-share holding UP to 1 (that caused
      // "sell 1.0 but only hold 0.48"). A size that rounds to 0 is un-sellable dust -> report it so
      // the caller stops retrying (it settles on its own at resolution).
      let size = Math.floor(sizeShares * 100) / 100;
      // STAGE 2E REVERTED 2026-08-28. A quantiser sat here that floored BUY size to 100/gcd(c,100)
      // hundredths of a share so that size*price would land on a whole cent. It was shadowed over 24h
      // of real orders and looked airtight (460/460 reconstructed failures became valid, nothing
      // rounded up). LIVE IT DID THE OPPOSITE: over the same clock window the day before vs after,
      // orders whose intended spend carried >2 decimals failed 25% of the time on the old code and
      // 96.4% (53 of 55) with the quantiser in. Mechanism still unexplained - prices were all whole
      // cents, so the obvious fractional-price theory is dead. Reverted rather than iterated on,
      // because it shrank real position sizes while making the failure it targeted far worse.
      // Do not reinstate without live evidence, not just a replay: the replay was what got this wrong.
      if (!(size > 0)) {
        return { ok: false, status: 400, body: { polymarket: { error: "size below sellable minimum (dust)" } }, meta: { market: tokenId, side: side.toLowerCase(), size: 0, price: priceCents } };
      }
      // LOCAL RISK CAP — BUYS ONLY (sells must always be allowed: never trap open money). Clamps the
      // shares to the per-fill %-of-portfolio ceiling and the rolling hour/day buy-volume governors,
      // all computed from the bot's OWN portfolio, never from Cosmos. A hostile server cannot widen it.
      if (side === "BUY") {
        if (fleetHalted()) {
          console.warn(`[fleetstate] BUY refused: fleet is HALTED · token ${String(tokenId).slice(0, 12)}`);
          return { ok: false, status: 400, body: { polymarket: { error: "fleet halted (signed kill switch)" } }, meta: { market: tokenId, side: "buy", size: 0, price: priceCents, fleet_halted: true } };
        }
        const rc = riskClampBuy(size, price);
        if (rc.shares <= 0) {
          console.warn(`[risk] BUY refused: ${rc.reason} · token ${String(tokenId).slice(0, 12)} · portfolio $${lastLocalPortfolio.toFixed(0)}`);
          return { ok: false, status: 400, body: { polymarket: { error: `local risk cap: ${rc.reason}` } }, meta: { market: tokenId, side: "buy", size: 0, price: priceCents, risk_capped: true } };
        }
        if (rc.capped) { console.warn(`[risk] BUY clamped: ${rc.reason} · token ${String(tokenId).slice(0, 12)}`); size = Math.floor(rc.shares * 100) / 100; }
        if (!(size > 0)) return { ok: false, status: 400, body: { polymarket: { error: "local risk cap: clamped to dust" } }, meta: { market: tokenId, side: "buy", size: 0, price: priceCents, risk_capped: true } };
      }
      const ot = orderType === "FOK" ? OrderType.FOK : orderType === "GTC" ? OrderType.GTC : OrderType.FAK;
      // ROTATION: k of every 36 orders carry the affiliate's builder code (when one is set),
      // Bresenham-spaced so the slots spread evenly through the window.
      rotN++; rotSave();
      const wantAff = Boolean(getAffClient()) && affSlotHit(rotN, affSlots);
      // attempt(useAffiliate): resolves the client AND the code together, so meta.builder_code_used
      // always reports the code the order ACTUALLY carried (audit #9) — even after a deposit-wallet
      // recovery flips the signature type, or when getAffClient() has no client and we fall back.
      const attempt = async (useAffiliate) => {
        const affC = useAffiliate ? getAffClient() : null;
        const c = affC || client;                                  // no aff client -> Cosmos client
        const meta = { market: tokenId, side: side.toLowerCase(), size, price: priceCents, builder_code_used: affC ? affCode : BUILDER_CODE };
        try {
          // Snapshot the FINAL size - after riskClampBuy, after every clamp, immediately before the
          // order is built. This is the exact quantity the venue judges, and the place the reverted
          // fix should have been: it sat before the clamp, which then overwrote it.
          const t2e = side !== "SELL" ? (() => {
            const cc = Math.round(price * 100);
            const kk = Math.round(size * 100);
            const gg = (a, b) => (b ? gg(b, a % b) : a);
            const step = 100 / gg(cc, 100);
            const k2 = Math.floor(kk / step) * step;
            return { tok: String(tokenId).slice(0, 12), cents: cc, sizeSent: size, k: kk,
                     mod: (kk * cc) % 100, maker: Number((kk * cc / 10000).toFixed(6)),
                     propSize: k2 / 100, propMod: (k2 * cc) % 100, noop: k2 === kk };
          })() : null;
          const resp = await c.createAndPostOrder(
            { tokenID: tokenId, price, side: side === "SELL" ? Side.SELL : Side.BUY, size },
            undefined, // options: let the client resolve tickSize + negRisk per market
            ot,
          );
          if (t2e) {
            const blob = (() => { try { return JSON.stringify(resp ?? {}); } catch { return ""; } })();
            trace2e({ ...t2e, invalidAmounts: /invalid amounts/i.test(blob),
                      rejected: Boolean(resp && (resp.error || resp.success === false)) });
          }
          // V2 returns { error, status } on failure (throwOnError is off by default); the CLOB can
          // also answer 200 with success:false — both mean the placement itself failed, nothing filled.
          // rejected:true = the CLOB ANSWERED and said "not accepted" — the one failure class where a
          // re-post (affiliate fallback below) is provably safe, because no order sits on the book.
          if (resp && (resp.error || resp.success === false)) return { ok: false, rejected: true, status: resp.status ?? 400, body: { polymarket: resp }, meta };
          // RECORD THE FILL, NOT THE INTENT (2026-07-19). `size`/`priceCents` above are the REQUEST —
          // the FAK cap and the shares we asked for. Every downstream ledger (bot_orders via the meter
          // meta, copy_trades via copyReport) must see what MATCHED instead. Keep the request on new
          // keys (audit trail; harmless extra keys server-side), overwrite size/price with the actual
          // fill, and turn a zero-fill kill into ok:false so no phantom trade is ever recorded.
          meta.req_size = size;               // shares we ASKED for
          meta.limit_price = priceCents;      // the FAK cap we signed (cents)
          const fill = resp ? extractFill(resp, side, size, priceCents) : null;
          if (!fill) {
            meta.fill_unknown = true;         // response carried no readable fill info — report the request, flagged, never guessed
          } else if (!(fill.shares > 0)) {
            // FAK killed in full: the order placed NOTHING. Report it as a failure (status 400 — the
            // same class callers already treat as a FAK kill: placeWithRetry retries, entries burn
            // after their 4xx budget) so ledgers and metering never record a phantom trade.
            // Deliberately NOT rejected:true — the order WAS accepted (and killed by the book, a
            // FINAL verdict on this price/size); the builder code was never the problem, so the
            // affiliate fallback must not fire the same doomed order again on the Cosmos code.
            return { ok: false, status: 400, body: { polymarket: { ...resp, error: "FAK killed: nothing filled" } }, meta: { ...meta, size: 0 } };
          } else {
            meta.size = fill.shares;          // shares that actually filled (partials included)
            meta.price = fill.priceCents;     // average fill price in cents, not the limit cap
            // Record the REALISED buy $ in the rolling risk ledger (actual fill, not the request) so
            // the hour/day governors bound true deployed capital. BUYS only; sells never count.
            if (side === "BUY") riskRecordBuy((fill.shares || 0) * ((fill.priceCents || priceCents) / 100));
            // MONEY JUST MOVED -> the cached cash number is stale. Invalidating here (rather than
            // polling on a timer) is what makes the 5-minute balance TTL safe: the very next read
            // after any fill, on either side, goes to the chain.
            invalidateBalanceCache();
          }
          // Carry the CLOB's own answer (orderID, tx hashes, taking/making amounts) into the meta so
          // meter() reports it and the server can audit fills against what we ledgered (the orders
          // route used to store null here). Trimmed to the audit fields — never the whole client blob.
          meta.polymarket_response = trimClobResp(resp);
          return { ok: true, status: 200, body: { polymarket: resp }, meta };
        } catch (e) {
          // A THROW is transport-level (timeout, connection reset, DNS, signing) — the request may
          // have reached the CLOB and the order may be LIVE even though we never saw the answer.
          // Deliberately NOT rejected:true: re-posting here (affiliate fallback) could double-fill.
          //
          // COSMOS CLOUD: a hosted signature refused by the platform gate throws from inside
          // createAndPostOrder, so without these two fields it is indistinguishable from a network
          // blip and every retry layer above would re-post it. Carry the verdict up instead — a
          // definitive refusal (duplicate, signature cap, halt) must stop the loop, because
          // marketableSell re-prices per attempt and each re-post is a fresh PAID signature.
          return {
            ok: false, status: 400,
            cloudCode: e?.cloudCode, cloudDefinitive: Boolean(e?.definitive),
            body: { polymarket: { error: e?.message ?? "order failed" } }, meta,
          };
        }
      };
      let r = await attempt(wantAff);
      // DEPOSIT-WALLET AUTO-RECOVERY: "maker address not allowed, please use the deposit wallet flow"
      // means this account is Polymarket's NEW kind and needs POLY_1271 + a FUNDER-bound API key.
      // Detection can miss it (an empty/undeployed deposit wallet probes $0), so recover at order time:
      // derive the funder-bound key, switch the client to POLY_1271, and retry ONCE. Sticky — every
      // later order uses the working client. This is what makes the bot work for EVERY account kind.
      if (!r.ok && sigType !== SignatureTypeV2.POLY_1271 && DEPOSIT_ERR.test(JSON.stringify(r.body ?? ""))) {
        // Print the CLOB's OWN words before recovery overwrites them (prove-out 2026-07-30: the flip
        // masked the first rejection and we could not tell WHICH deposit-wallet condition fired).
        console.warn("[polymarket] CLOB rejected the order:", JSON.stringify(r.body?.polymarket ?? r.body).slice(0, 400));
        if (/^(1|true|yes|on)$/i.test(process.env.COSMOS_NO_1271_RECOVERY || "")) {
          console.warn("[polymarket] POLY_1271 auto-recovery disabled (COSMOS_NO_1271_RECOVERY) — returning the rejection as-is");
          return r;
        }
        console.log("[polymarket] ↻ deposit-wallet account detected at order time — switching to POLY_1271 with a funder-bound API key…");
        const dc = await deriveForFunder();
        sigType = SignatureTypeV2.POLY_1271;
        client = mkClientFor(sigType, dc || creds);
        affClient = null;                       // rebuilt with the new sigType on the next rotation hit
        r = await attempt(wantAff);
        if (r.ok) console.log("[polymarket] ✓ POLY_1271 (deposit wallet) works — using it from now on");
      }
      // AFFILIATE FALLBACK (audit #4): if the AFFILIATE-coded order was REJECTED (an invalid/
      // unregistered code), retry ONCE with the Cosmos client so the referred user's order still
      // fills — the affiliate simply forfeits this slot.
      // GATED on r.rejected (deep-check fix): only a DEFINITIVE CLOB rejection — the API answered
      // with an error, so the order provably never landed on the book — may re-post. Two failure
      // classes must NEVER reach this retry, and neither carries rejected:true:
      //   * a thrown timeout/network error — the order may have been ACCEPTED without us seeing the
      //     answer; re-posting would risk a silent double-fill of real money;
      //   * "FAK killed: nothing filled" — the order WAS accepted and killed by the book, a final
      //     verdict on this price/size that has nothing to do with the builder code; re-posting
      //     just fires the same doomed order twice.
      if (!r.ok && wantAff && r.rejected && !DEPOSIT_ERR.test(JSON.stringify(r.body ?? ""))) {
        const r2 = await attempt(false);
        if (r2.ok) console.log("[polymarket] affiliate builder code rejected — order placed on the Cosmos code instead");
        r = r2;
      }
      return r;
    },

    // The wallet's current Polymarket holdings (for reconcile + "apply to manual trades").
    // Returns the array of holdings on success (possibly []), or NULL if the fetch FAILED - so the
    // caller can tell "no positions" apart from "couldn't check" and never collapse sizing to cash.
    async getMyPositions() {
      try {
        // PAGINATED + value-sorted. The old single unsorted page of 100 was a real bug: a wallet
        // with 100+ resolved historical rows (old candles etc.) filled the whole page, every LIVE
        // position became invisible, and reconcile deleted them from tracking - so exits (incl.
        // the horizon stop) silently never ran. sortBy=CURRENT puts live value first; resolved
        // rows (redeemable - auto-claimed at $1, nothing to manage) are skipped.
        const out = [];
        for (let pg = 0; pg < 4; pg++) {
          const res = await fetch(`${DATA_API}/positions?user=${encodeURIComponent(funder)}&sizeThreshold=0&sortBy=CURRENT&sortDirection=DESC&limit=500&offset=${pg * 500}`, { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) return pg === 0 ? null : out;
          const arr = await res.json();
          if (!Array.isArray(arr)) return pg === 0 ? null : out;
          for (const p of arr) {
            if (p.redeemable) continue; // resolved - Polymarket redeems winners automatically
            const row = {
              condition_id: p.conditionId,
              token_id: p.asset,
              outcome: p.outcome,
              entry_cents: Math.round(Number(p.avgPrice ?? 0) * 100),
              cur_cents: Math.round(Number(p.curPrice ?? 0) * 100),
              size_shares: Number(p.size ?? 0),
              cur_value: Number(p.currentValue ?? 0), // live $ value of this holding
              title: String(p.title ?? ""),
              end_date: p.endDate ?? null,
            };
            if (row.condition_id && row.size_shares > 0) out.push(row);
          }
          if (arr.length < 500) break;
        }
        return out;
      } catch {
        return null;
      }
    },
  };
}
