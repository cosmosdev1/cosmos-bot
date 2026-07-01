// Polymarket integration. The wallet private key stays on THIS machine and only signs orders.
// The bot posts each signed order DIRECTLY to Polymarket (so Polymarket sees the user's own
// region), then reports it to Cosmos for $0.09 metering. Written against @polymarket/clob-client-v2
// (Polymarket's CLOB V2 client — the old clob-client signs an order version V2 now rejects).
import { ClobClient, Side, OrderType, AssetType, Chain, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { createWalletClient, createPublicClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

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
// field inside the user's own locally-signed order). Empty = OFF (no fee attached, behaves as
// before). Set this after registering at polymarket.com/settings?tab=builder; builder codes are
// public, so it's fine to ship in the (public) bot. Env override: COSMOS_BUILDER_CODE.
const ZERO32 = "0x" + "0".repeat(64);
const DEFAULT_BUILDER_CODE = "0x4ddc9c090a1adb966274f26284e0e0f686b6828ec71299a1dc310ebea4bb8166"; // Cosmos's Polymarket builder code (public, safe to ship)
const BUILDER_CODE = (process.env.COSMOS_BUILDER_CODE || DEFAULT_BUILDER_CODE).trim();
const builderOn = /^0x[0-9a-fA-F]{64}$/.test(BUILDER_CODE) && BUILDER_CODE !== ZERO32;

export async function makePolymarket(config) {
  // viem signer (CLOB V2 is viem-based). Signing is local — no RPC needed.
  const account = privateKeyToAccount(config.polymarket.privateKey);
  const walletClient = createWalletClient({ account, chain: polygon, transport: http() });
  const address = account.address;
  const funder = config.polymarket.funderAddress || address;
  const publicClient = createPublicClient({ chain: polygon, transport: http() });
  let lastGoodBalance = null; // last non-zero cash read, so a transient RPC/API blip never sizes off $0
  let lastBalanceBreakdown = { onchain: null, clob: null }; // for telemetry: WHERE the cash actually is
  let lastGoodValue = null; // last good Polymarket /value total (authoritative portfolio value)

  // L1: derive (or create) the L2 API credentials from a wallet signature.
  const pre = new ClobClient({ host: CLOB_HOST, chain: Chain.POLYGON, signer: walletClient });
  const creds = await pre.createOrDeriveApiKey();
  // Full client: L1 + L2 + POLY_PROXY signing for the Polymarket proxy wallet (funder).
  // When a builder code is configured, builderConfig makes the client auto-stamp it onto every
  // order (the SDK applies it at order-build time), so Polymarket collects Cosmos's builder fee.
  const clientOpts = {
    host: CLOB_HOST,
    chain: Chain.POLYGON,
    signer: walletClient,
    creds,
    signatureType: SignatureTypeV2.POLY_PROXY,
    funderAddress: funder,
  };
  if (builderOn) clientOpts.builderConfig = { builderCode: BUILDER_CODE };
  const client = new ClobClient(clientOpts);

  const tokenCache = new Map();

  return {
    address,
    funder,
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

    // Sign an order locally and POST it DIRECTLY to Polymarket (your IP/region — not a server's).
    // FAK (Fill-And-Kill) = take whatever liquidity exists at this price NOW and cancel the rest;
    // the bot passes a *marketable* price (above mid to buy / below mid to sell). createAndPostOrder
    // builds + signs the V2 order and posts it in one call, auto-resolving tickSize + negRisk.
    async placeOrder({ tokenId, side, sizeShares, priceCents, orderType = "FAK" }) {
      const price = Math.max(0.01, Math.min(0.99, priceCents / 100));
      const size = Math.max(1, Math.floor(sizeShares));
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
        // sizeThreshold=0 (NOT 1) so our tiny 2-3 share positions aren't silently dropped, and NO
        // `limit` param (Polymarket returns [] for unrecognized params). currentValue = the live $
        // the caller sums into `deployed`.
        const res = await fetch(`${DATA_API}/positions?user=${encodeURIComponent(funder)}&sizeThreshold=0`);
        if (!res.ok) return null;
        const arr = await res.json();
        if (!Array.isArray(arr)) return null;
        return arr
          .map((p) => ({
            condition_id: p.conditionId,
            token_id: p.asset,
            outcome: p.outcome,
            entry_cents: Math.round(Number(p.avgPrice ?? 0) * 100),
            cur_cents: Math.round(Number(p.curPrice ?? 0) * 100),
            size_shares: Number(p.size ?? 0),
            cur_value: Number(p.currentValue ?? 0), // live $ value of this holding
          }))
          .filter((p) => p.condition_id && p.size_shares > 0);
      } catch {
        return null;
      }
    },
  };
}
