// Polymarket integration. The wallet private key stays on THIS machine and only signs orders.
// Signed orders are handed to the Cosmos relay (cosmos.relayOrder), which meters + forwards them.
//
// Written against @polymarket/clob-client v4 and the documented CLOB request shape. The three
// marked spots (CREATE ORDER / L2 HEADERS / RELAY BODY) are the parts to validate with one small
// live order, since client method names + the order body can vary across clob-client versions.
import { ClobClient, Side, OrderType, createL2Headers } from "@polymarket/clob-client";
import { orderToJson } from "@polymarket/clob-client/dist/utilities.js";
import { Wallet } from "ethers";

const CHAIN_ID = 137; // Polygon
const CLOB_HOST = "https://clob.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";
const GAMMA = "https://gamma-api.polymarket.com";

export async function makePolymarket(config) {
  const wallet = new Wallet(config.polymarket.privateKey);
  const address = await wallet.getAddress();
  const funder = config.polymarket.funderAddress || address;

  // Derive (or create) L2 API credentials from a wallet signature.
  const pre = new ClobClient(CLOB_HOST, CHAIN_ID, wallet);
  const creds = await pre.createOrDeriveApiKey();
  const client = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, creds, 1 /* signatureType: POLY_PROXY */, funder);

  const tokenCache = new Map();

  return {
    address,
    funder,

    // USDC balance, for position sizing.
    async getBalanceUsd() {
      try {
        const c = await client.getBalanceAllowance({ asset_type: "COLLATERAL" });
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

    // Current mid price in cents.
    async getPriceCents(tokenId) {
      try {
        const mid = await client.getMidpoint(tokenId);
        const p = Number(mid?.mid ?? 0);
        return p > 0 ? Math.round(p * 100) : null;
      } catch {
        return null;
      }
    },

    // Build + sign an order locally; return the exact CLOB request for the relay to forward.
    // Default order type is FAK (Fill-And-Kill): fill whatever liquidity is available at this
    // price NOW and cancel the rest — never rests on the book. The bot passes a *marketable*
    // price (above mid to buy / below mid to sell) so stops actually execute.
    async buildSignedOrder({ tokenId, side, sizeShares, priceCents, orderType = "FAK" }) {
      const price = Math.max(0.01, Math.min(0.99, priceCents / 100));
      const size = Math.max(1, Math.floor(sizeShares));
      const ot = orderType === "FOK" ? OrderType.FOK : orderType === "GTC" ? OrderType.GTC : OrderType.FAK;

      // (1) CREATE ORDER — build + sign (EIP-712) with the local wallet.
      // Do NOT pass feeRateBps: the client fetches the market's required rate itself
      // (GET /fee-rate). Passing 0 trips its mismatch guard when the market fee is non-zero.
      const signed = await client.createOrder({
        tokenID: tokenId,
        price,
        side: side === "SELL" ? Side.SELL : Side.BUY,
        size,
      });

      // (2) BODY + L2 HEADERS — the exact POST /order payload (orderToJson) and the POLY_*
      // auth headers signed over that body. createL2Headers is a top-level helper (not a
      // client method); the relay re-serializes `body` to the identical string we signed.
      const payload = orderToJson(signed, creds.key, ot);
      const headers = await createL2Headers(wallet, creds, {
        method: "POST",
        requestPath: "/order",
        body: JSON.stringify(payload),
      });

      // (3) RELAY BODY — exactly what /api/v1/orders forwards to clob.polymarket.com/order.
      return {
        clob: { path: "/order", method: "POST", headers, body: payload },
        meta: { market: tokenId, side: side.toLowerCase(), size, price: priceCents },
      };
    },

    // The wallet's current Polymarket holdings (for "apply to manual trades").
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
