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
import { privateKeyToAccount } from "viem/accounts";
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
const USDC_ADDRESSES = [
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC.e (bridged) - Polymarket collateral
  "0x3c499c542cEF5E3811e1192ce70d8cc03d5c3359", // native USDC
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
// AFFILIATE ROTATION (owner 2026-07-16): when this user was referred by an active affiliate, the server
// sends the affiliate's builder code and every 5th order carries IT instead of Cosmos's — 4/5 Cosmos,
// 1/5 affiliate = the affiliate's ~20% share, paid by Polymarket directly to their account (never via
// Cosmos). The counter persists to disk so restarts don't reset the cadence.
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
const AFF_EVERY = 5;

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
const MAX_TRADE_PCT = capPct("COSMOS_MAX_TRADE_PCT", 8);    // one fill: <=8% of portfolio (legit max ~6%; the "10%" attack is impossible)
const MAX_HOUR_PCT  = capPct("COSMOS_MAX_HOUR_PCT", 40);    // rolling 60min buy-volume ceiling
const MAX_DAY_PCT   = capPct("COSMOS_MAX_DAY_PCT", 100);    // rolling 24h buy-volume ceiling
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
  const hourCap = port > 0 ? (port * MAX_HOUR_PCT) / 100 : MIN_FLOOR_USD;
  const dayCap  = port > 0 ? (port * MAX_DAY_PCT) / 100 : MIN_FLOOR_USD;
  const hourSpent = spendWindow(3600e3), daySpent = spendWindow(86400e3);
  const hourBuys = spendLog.filter((b) => b.t >= Date.now() - 3600e3).length;
  if (hourBuys >= MAX_HOUR_BUYS) return { shares: 0, capped: true, reason: `hourly buy-count cap (${hourBuys}/${MAX_HOUR_BUYS})` };
  const roomUsd = Math.min(perFillUsd, Math.max(0, hourCap - hourSpent), Math.max(0, dayCap - daySpent));
  if (roomUsd < MIN_FLOOR_USD) return { shares: 0, capped: true, reason: `rolling buy-volume cap (h ${hourSpent.toFixed(0)}/${hourCap.toFixed(0)} · d ${daySpent.toFixed(0)}/${dayCap.toFixed(0)})` };
  if (wantUsd <= roomUsd) return { shares: sizeShares, capped: false, reason: "" };
  return { shares: Math.floor((roomUsd / price) * 100) / 100, capped: true, reason: `per-fill/${MAX_TRADE_PCT}% clamp $${wantUsd.toFixed(0)}->$${roomUsd.toFixed(0)}` };
}
function riskRecordBuy(usd) { spendLog.push({ t: Date.now(), usd }); if (spendLog.length > 500) spendLog = spendLog.slice(-400); spendSave(); }

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
// raw read violates the hard invariants (filled ≤ requested, price inside 0-100c) we retry the read
// as 1e6 base units; if neither interpretation is sane we return null rather than guess.
function extractFill(resp, side, reqShares) {
  const t = Number(resp?.takingAmount), m = Number(resp?.makingAmount);
  if (!Number.isFinite(t) || !Number.isFinite(m)) return null;
  if (t === 0 && m === 0) return { shares: 0 };
  for (const div of [1, 1e6]) {
    const shares = (side === "SELL" ? m : t) / div;   // the shares leg of the fill
    const usd = (side === "SELL" ? t : m) / div;      // the USDC leg of the fill
    if (!(shares > 0) || !(usd > 0)) continue;
    const priceC = (usd / shares) * 100;
    if (shares <= reqShares * 1.001 && priceC >= 0.1 && priceC <= 100.5) {
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
  // viem signer (CLOB V2 is viem-based). Signing is local — no RPC needed.
  const account = privateKeyToAccount(config.polymarket.privateKey);
  const walletClient = createWalletClient({ account, chain: polygon, transport: http() });
  const address = account.address;
  const funder = config.polymarket.funderAddress || address;
  const publicClient = createPublicClient({ chain: polygon, transport: fallback(RPC_URLS.map((u) => http(u))) });
  let lastGoodBalance = null; // last non-zero cash read, so a transient RPC/API blip never sizes off $0
  let lastBalanceBreakdown = { onchain: null, clob: null }; // for telemetry: WHERE the cash actually is
  let lastGoodValue = null; // last good Polymarket /value total (authoritative portfolio value)
  let lastClobRefresh = 0; // last time we forced the CLOB to recompute its cached balance

  // L1: derive (or create) the L2 API credentials from a wallet signature. These are bound to the
  // SIGNER EOA — correct for EOA / POLY_PROXY / Safe accounts.
  const pre = new ClobClient({ host: CLOB_HOST, chain: Chain.POLYGON, signer: walletClient });
  const creds = await pre.createOrDeriveApiKey();

  // API key bound to the FUNDER (deposit wallet), signed by the EOA — REQUIRED for POLY_1271 accounts
  // (Polymarket's NEW deposit-wallet flow): the CLOB demands order.signer (= the deposit wallet) equal
  // the API key's address, so the EOA-bound `creds` above are rejected with "maker address not
  // allowed, please use the deposit wallet flow". Ported from the validated qtable-live tester —
  // without this, every new-style Polymarket account fails 100% of its orders.
  const DEPOSIT_ERR = /deposit wallet|maker address not allowed|signer address has to be the address of the API/i;
  let depositCreds = null;
  const deriveForFunder = async () => {
    if (depositCreds) return depositCreds;
    try {
      const mkH = async () => createL1Headers(walletClient, 137, 0, undefined, funder);
      let jj = await fetch(`${CLOB_HOST}/auth/api-key`, { method: "POST", headers: await mkH(), signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!jj?.apiKey) jj = await fetch(`${CLOB_HOST}/auth/derive-api-key`, { headers: await mkH(), signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      depositCreds = jj?.apiKey ? { key: jj.apiKey, secret: jj.secret, passphrase: jj.passphrase } : null;
    } catch { depositCreds = null; }
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
  try {
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
  let affCode = null, affClient = null, affSig = null, affCreds = null;
  const getAffClient = () => {
    if (!affCode) return null;
    const c = sigType === SignatureTypeV2.POLY_1271 && depositCreds ? depositCreds : creds;
    if (!affClient || affSig !== sigType || affCreds !== c) { affClient = mkClientFor(sigType, c, affCode); affSig = sigType; affCreds = c; }
    return affClient;
  };
  if (sigType === SignatureTypeV2.POLY_1271) await deriveForFunder();
  let client = sigType === SignatureTypeV2.POLY_1271 && depositCreds ? mkClientFor(sigType, depositCreds) : mkClient(sigType);

  const tokenCache = new Map();

  return {
    address,
    funder,
    sigType, // the DETECTED Polymarket signature type (0 EOA / 1 proxy / 2 safe / 3 smart wallet)
    sigTypeName: SIG_NAMES[sigType],
    walletKind, // what the funder's bytecode says it is
    builderFee: builderOn, // whether a builder fee is being attached to orders

    // AFFILIATE ROTATION: server-controlled. null/invalid clears it (all orders -> Cosmos code).
    setAffiliateCode(code) {
      const v = String(code || "").trim();
      const ok = /^0x[0-9a-fA-F]{64}$/.test(v) && v !== ZERO32 && v.toLowerCase() !== BUILDER_CODE.toLowerCase();
      const next = ok ? v : null;
      if (next !== affCode) { affCode = next; affClient = null; }
    },

    // Free USDC (cash) on the FUNDER/proxy wallet, for position sizing. On-chain balanceOf FIRST
    // (authoritative, never stale, always the funder - not the signer-EOA-derived proxy the CLOB
    // balance endpoint silently resolves to); fall back to the CLOB's cached collateral only if
    // on-chain reads ~0; and cache the last non-zero value so a transient blip never sizes off $0.
    // (Open positions are added by the caller as `deployed` for the TRUE portfolio.)
    async getBalanceUsd() {
      // Read BOTH the on-chain USDC on the funder AND the CLOB deposited collateral, and size off the
      // LARGER - a user's cash can sit EITHER on-chain in the proxy OR deposited in the CLOB exchange,
      // so we must use whichever actually holds it. Record the split (balanceBreakdown) for telemetry;
      // cache last-known-good so a transient blip never sizes off $0.
      let onchain = null;
      try {
        let sum = 0;
        for (const token of USDC_ADDRESSES) {
          const raw = await publicClient
            .readContract({ address: token, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [funder] })
            .catch(() => 0n);
          sum += Number(raw) / 1e6; // USDC = 6 decimals
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
      if (best >= 0.01) { lastGoodBalance = best; setLocalPortfolio((lastGoodValue || 0) + best); return best; }
      return lastGoodBalance ?? 0; // never collapse sizing to 0 on a transient failure
    },
    balanceBreakdown: () => lastBalanceBreakdown,

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

    // Current mid price in cents (null if unavailable).
    async getPriceCents(tokenId) {
      try {
        const mid = await client.getMidpoint(tokenId);
        const p = Number(mid?.mid ?? 0);
        return p > 0 ? Math.round(p * 100) : null;
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
      // ROTATION: order 5, 10, 15... carries the affiliate's builder code (when one is set).
      rotN++; rotSave();
      const wantAff = Boolean(getAffClient()) && rotN % AFF_EVERY === 0;
      // attempt(useAffiliate): resolves the client AND the code together, so meta.builder_code_used
      // always reports the code the order ACTUALLY carried (audit #9) — even after a deposit-wallet
      // recovery flips the signature type, or when getAffClient() has no client and we fall back.
      const attempt = async (useAffiliate) => {
        const affC = useAffiliate ? getAffClient() : null;
        const c = affC || client;                                  // no aff client -> Cosmos client
        const meta = { market: tokenId, side: side.toLowerCase(), size, price: priceCents, builder_code_used: affC ? affCode : BUILDER_CODE };
        try {
          const resp = await c.createAndPostOrder(
            { tokenID: tokenId, price, side: side === "SELL" ? Side.SELL : Side.BUY, size },
            undefined, // options: let the client resolve tickSize + negRisk per market
            ot,
          );
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
          const fill = resp ? extractFill(resp, side, size) : null;
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
          return { ok: false, status: 400, body: { polymarket: { error: e?.message ?? "order failed" } }, meta };
        }
      };
      let r = await attempt(wantAff);
      // DEPOSIT-WALLET AUTO-RECOVERY: "maker address not allowed, please use the deposit wallet flow"
      // means this account is Polymarket's NEW kind and needs POLY_1271 + a FUNDER-bound API key.
      // Detection can miss it (an empty/undeployed deposit wallet probes $0), so recover at order time:
      // derive the funder-bound key, switch the client to POLY_1271, and retry ONCE. Sticky — every
      // later order uses the working client. This is what makes the bot work for EVERY account kind.
      if (!r.ok && sigType !== SignatureTypeV2.POLY_1271 && DEPOSIT_ERR.test(JSON.stringify(r.body ?? ""))) {
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
