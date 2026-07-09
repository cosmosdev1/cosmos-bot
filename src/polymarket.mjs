// Polymarket integration. The wallet private key stays on THIS machine and only signs orders.
// The bot posts each signed order DIRECTLY to Polymarket (so Polymarket sees the user's own
// region), then reports it to Cosmos for $0.09 metering. Written against @polymarket/clob-client-v2
// (Polymarket's CLOB V2 client — the old clob-client signs an order version V2 now rejects).
import { ClobClient, Side, OrderType, AssetType, Chain, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { createWalletClient, createPublicClient, http, fallback } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

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
const DEFAULT_BUILDER_CODE = "0x4ddc9c090a1adb966274f26284e0e0f686b6828ec71299a1dc310ebea4bb8166"; // Cosmos's Polymarket builder code (public, safe to ship)
const envCode = (process.env.COSMOS_BUILDER_CODE || "").trim();
const BUILDER_CODE = /^0x[0-9a-fA-F]{64}$/.test(envCode) && envCode !== ZERO32 ? envCode : DEFAULT_BUILDER_CODE;
const builderOn = true;

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

  // L1: derive (or create) the L2 API credentials from a wallet signature.
  const pre = new ClobClient({ host: CLOB_HOST, chain: Chain.POLYGON, signer: walletClient });
  const creds = await pre.createOrDeriveApiKey();

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

  // Full client: L1 + L2 + the DETECTED signature type for the funder account.
  // When a builder code is configured, builderConfig makes the client auto-stamp it onto every
  // order (the SDK applies it at order-build time), so Polymarket collects Cosmos's builder fee.
  const client = mkClient(sigType);

  const tokenCache = new Map();

  return {
    address,
    funder,
    sigType, // the DETECTED Polymarket signature type (0 EOA / 1 proxy / 2 safe / 3 smart wallet)
    sigTypeName: SIG_NAMES[sigType],
    walletKind, // what the funder's bytecode says it is
    builderFee: builderOn, // whether a builder fee is being attached to orders

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
      if (best >= 0.01) { lastGoodBalance = best; return best; }
      return lastGoodBalance ?? 0; // never collapse sizing to 0 on a transient failure
    },
    balanceBreakdown: () => lastBalanceBreakdown,

    // Polymarket's OWN authoritative total portfolio value for the funder (cash + all open positions
    // marked to market + redeemable), via the data-api /value endpoint. This is far more reliable than
    // summing /positions ourselves (a funder can have thousands of old resolved $0 positions across
    // many pages). Returns the number, or the last-good value on a transient failure, or null.
    async getPortfolioValue() {
      try {
        const r = await fetch(`${DATA_API}/value?user=${encodeURIComponent(funder)}`);
        if (r.ok) {
          const arr = await r.json();
          const v = Array.isArray(arr) ? Number(arr[0]?.value) : Number(arr?.value);
          if (Number.isFinite(v) && v >= 0.01) { lastGoodValue = v; return v; }
        }
      } catch { /* fall through to last-good */ }
      return lastGoodValue;
    },

    // Polymarket geoblock status for THIS server's egress IP (docs: GET /api/geoblock ->
    // { blocked, ip, country, region }). When blocked, every order is rejected with a 403, so we
    // check it up front and surface it clearly instead of blindly firing orders into a wall.
    async geoblock() {
      try {
        const res = await fetch("https://polymarket.com/api/geoblock");
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
        const res = await fetch(`${GAMMA}/markets?condition_ids=${encodeURIComponent(conditionId)}`);
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
        const res = await fetch(`${GAMMA}/markets?condition_ids=${encodeURIComponent(conditionId)}`);
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
      const size = Math.floor(sizeShares * 100) / 100;
      if (!(size > 0)) {
        return { ok: false, status: 400, body: { polymarket: { error: "size below sellable minimum (dust)" } }, meta: { market: tokenId, side: side.toLowerCase(), size: 0, price: priceCents } };
      }
      const ot = orderType === "FOK" ? OrderType.FOK : orderType === "GTC" ? OrderType.GTC : OrderType.FAK;
      const meta = { market: tokenId, side: side.toLowerCase(), size, price: priceCents };
      try {
        const resp = await client.createAndPostOrder(
          { tokenID: tokenId, price, side: side === "SELL" ? Side.SELL : Side.BUY, size },
          undefined, // options: let the client resolve tickSize + negRisk per market
          ot,
        );
        // V2 returns { error, status } on failure (throwOnError is off by default).
        if (resp && resp.error) return { ok: false, status: resp.status ?? 400, body: { polymarket: resp }, meta };
        return { ok: true, status: 200, body: { polymarket: resp }, meta };
      } catch (e) {
        return { ok: false, status: 400, body: { polymarket: { error: e?.message ?? "order failed" } }, meta };
      }
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
          const res = await fetch(`${DATA_API}/positions?user=${encodeURIComponent(funder)}&sizeThreshold=0&sortBy=CURRENT&sortDirection=DESC&limit=500&offset=${pg * 500}`);
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
