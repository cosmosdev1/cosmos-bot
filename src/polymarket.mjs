// Polymarket integration. The wallet private key stays on THIS machine and only signs orders.
// The bot posts each signed order DIRECTLY to Polymarket (so Polymarket sees the user's own
// region), then reports it to Cosmos for $0.09 metering. Written against @polymarket/clob-client-v2
// (Polymarket's CLOB V2 client — the old clob-client signs an order version V2 now rejects).
import { ClobClient, Side, OrderType, AssetType, Chain, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const CLOB_HOST = "https://clob.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";
const GAMMA = "https://gamma-api.polymarket.com";

export async function makePolymarket(config) {
  // viem signer (CLOB V2 is viem-based). Signing is local — no RPC needed.
  const account = privateKeyToAccount(config.polymarket.privateKey);
  const walletClient = createWalletClient({ account, chain: polygon, transport: http() });
  const address = account.address;
  const funder = config.polymarket.funderAddress || address;

  // L1: derive (or create) the L2 API credentials from a wallet signature.
  const pre = new ClobClient({ host: CLOB_HOST, chain: Chain.POLYGON, signer: walletClient });
  const creds = await pre.createOrDeriveApiKey();
  // Full client: L1 + L2 + POLY_PROXY signing for the Polymarket proxy wallet (funder).
  const client = new ClobClient({
    host: CLOB_HOST,
    chain: Chain.POLYGON,
    signer: walletClient,
    creds,
    signatureType: SignatureTypeV2.POLY_PROXY,
    funderAddress: funder,
  });

  const tokenCache = new Map();

  return {
    address,
    funder,

    // USDC balance, for position sizing.
    async getBalanceUsd() {
      try {
        const c = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        return Number(c?.balance ?? 0) / 1e6; // USDC = 6 decimals
      } catch {
        return 0;
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
    async getMyPositions() {
      try {
        const res = await fetch(`${DATA_API}/positions?user=${encodeURIComponent(funder)}&sizeThreshold=1`);
        const arr = await res.json();
        if (!Array.isArray(arr)) return [];
        return arr
          .map((p) => ({
            condition_id: p.conditionId,
            token_id: p.asset,
            outcome: p.outcome,
            entry_cents: Math.round(Number(p.avgPrice ?? 0) * 100),
            cur_cents: Math.round(Number(p.curPrice ?? 0) * 100),
            size_shares: Number(p.size ?? 0),
          }))
          .filter((p) => p.condition_id && p.size_shares > 0);
      } catch {
        return [];
      }
    },
  };
}
