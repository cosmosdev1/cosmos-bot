// COSMOS CLOUD remote signer (Option C). COSMOS_SIGNER=remote: the bot holds NO key of any kind.
// Every signature is produced by the platform's /api/cloud/sign — the delegate initiates, a SEPARATE
// approver independently re-prices the order and co-signs, and only then does the enclave complete it.
// See docs/cosmos-cloud-plan.md + cosmos-cloud-cutover.md in the platform repo.
//
// The account is a viem LocalAccount whose signTypedData POSTs the typed data to the platform and
// returns the enclave signature. Everything downstream (ClobClient, order signing, L1->L2 auth) is
// unchanged — clob-client-v2 just needs a signer exposing signTypedData.
//
// IDEMPOTENCY: an ORDER signature carries a per-DECISION `triggerId` (see withSignContext) held
// stable across that decision's retries. So a retried order collapses to ONE reservation on the
// platform and can never double-fill; the retry gets a definitive `duplicate`. ClobAuth (credential
// derivation) is not an order and needs no trigger.
//
// INTEGRATION — both placement entry points in bot.mjs, and there are exactly two:
//     placeWithRetry   every BUY (main loop, copytrade, qtable, qtable2, cert15 all route through it)
//     marketableSell   every SELL (stops, take-profits, mirror exits, salvage)
// Each wraps its retry loop in withSignContext({ triggerId: randomUUID(), conditionId }). One call
// == one economic decision, which gives retry-stable, decision-unique ids with NO CLOCK — the exact
// contract lib/cloud/gate.ts requires. Miss either one and that side of the trade cannot sign at
// all (the Order branch below throws), which is the intended failure: loud, not silent.

import { toAccount } from "viem/accounts";

const ORDER_DOMAIN = "Polymarket CTF Exchange";
const CLOBAUTH_DOMAIN = "ClobAuthDomain";

// SIGN CONTEXT — which economic decision the signature about to be made belongs to.
//
// Held in AsyncLocalStorage, NOT a module-level variable. The bot runs several placement loops
// CONCURRENTLY (main loop + copytrade + qtable2 + cert15, all started side by side in bot.mjs), and
// every one of them awaits network I/O mid-placement. A module-level context would be overwritten by
// whichever loop ran last before the await resumed, so an order could be signed under ANOTHER
// decision's triggerId. That silently destroys the idempotency guarantee: the retry of the first
// order would then mint a different key and could double-fill real money. AsyncLocalStorage binds
// the context to the async call chain, so interleaving is harmless by construction.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage();

/** Read-only view of the bound context, for the isolation test. Never used by production paths. */
export function _ctxForTests() { return store.getStore() || {}; }

/** STAGE 4 ATTRIBUTION (owner 2026-08-31). The placement loop mints the triggerId deep inside bot.mjs
 *  and knows nothing about Stage 4, so the attribution is pinned on an OUTER context that
 *  withSignContext inherits. Set only where the Stage 4 answer decided; an old-path order must carry
 *  nothing, which is what makes "a Stage 4 order without attribution" a detectable defect. */
export function withS4Attribution({ fillId, group } = {}, fn) {
  const outer = store.getStore() || {};
  return store.run({ ...outer, s4: true, s4FillId: fillId ?? null, s4Group: Number.isFinite(Number(group)) ? Number(group) : null }, fn);
}

/** Run `fn` with the sign context bound to this one decision. One decision = one triggerId. */
export function withSignContext({ triggerId, conditionId, s4FillId, s4Group } = {}, fn) {
  const outer = store.getStore() || {};
  return store.run({ triggerId: triggerId ?? null, conditionId: conditionId ?? "", orderRowId: null,
    s4: outer.s4 === true, s4FillId: s4FillId ?? outer.s4FillId ?? null, s4Group: s4Group ?? outer.s4Group ?? null }, fn);
}

/**
 * The cloud_orders row this decision signed, so the caller can report what the EXCHANGE did with it.
 *
 * Until 2026-08-24 nothing ever did. Every signed order sat at status `signed` forever with a null
 * fill, and the platform's risk gate - which cannot see the CLOB - charged all of them against the
 * 7% per-market cap and the hour/day budgets for a full day. Measured that morning: 1,920 signed
 * orders in 24h, none in any later state, $15,155 of notional booked for positions that do not
 * exist, 403 (user, market) pairs wedged shut. Three accounts that connected that day never traded
 * at all - their own failed attempts had eaten every cap they had.
 */
export function signedOrderRowId() {
  return store.getStore()?.orderRowId ?? null;
}

// BigInt-safe JSON (order amounts are often BigInt in viem's message).
const jsonBig = (o) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

// A refusal a RETRY CANNOT FIX. This matters for money, not just tidiness: the platform answers a
// gate refusal with HTTP 200 + {ok:false, code}, so status alone cannot tell "denied" from "the
// book blipped". Without this list, placeWithRetry and marketableSell would re-post a permanent
// refusal four more times, and marketableSell re-prices on every attempt — so each of those posts
// is a DIFFERENT order, a fresh idempotency key, and a fresh paid enclave signature.
//
// Deliberately EXCLUDED — a retry genuinely can succeed, so these stay retryable:
//   no_book, no_condition_id, book_unreadable, no_portfolio,
//   halt_unreadable, account_unreadable, risk_unreadable,
//   sig_count_unreadable, clobauth_budget_unreadable, reserve_failed  - transient reads
//   sell_below_book / buy_above_book   - marketableSell re-reads the book and re-prices; that is
//                                        precisely the case a reprice is meant to fix
//   approver_unreachable, sign_failed  - network/enclave blip
//
// Every code here is mirrored from the platform (app/api/cloud/sign/route.ts, lib/cloud/gate.ts,
// lib/cloud/risk.ts). A code that drifts out of sync fails SAFE — unknown codes stay retryable, so
// the worst case is a wasted round trip, never a skipped exit. Denials never spend a signature
// (gate.ts counts only SIGNED orders), so a wrong guess here costs nothing but time.
const DEFINITIVE_CODES = new Set([
  // --- gate / route ---
  "duplicate",              // already reserved: signing again is the double-fill this exists to stop
  "trade_signature_cap",    // the 2-signature ceiling; will not clear for 24h
  "fleet_halted",           // kill switch
  "no_account", "account_halted", "account_revoked", "account_provisioning",
  "policy_funder_drift",    // needs re-provisioning, not another attempt
  "approver_not_configured",// deployment problem: the split is half-done
  "clobauth_cap",           // daily ClobAuth ceiling
  "bad_order", "bad_request",
  // --- risk engine: same verdict on every re-post of this decision ---
  "halted",                 // this account, not the fleet
  "bad_price", "bad_side", "bad_size", "dust",
  "order_too_large", "rate_limited", "hour_budget", "day_budget", "market_concentration",
]);

function isDefinitive(code, status) {
  if (code && DEFINITIVE_CODES.has(code)) return true;
  // 4xx = the platform understood and refused. 5xx/timeouts stay retryable.
  return status >= 400 && status < 500;
}

// Turnkey signs the FULL EIP-712 struct (encoding=EIP712), so the payload must carry the domain type.
// viem often omits EIP712Domain from `types`; re-add it from whichever domain fields are present.
function withDomainType(types, domain) {
  if (types?.EIP712Domain) return types;
  const d = [];
  if (domain?.name != null) d.push({ name: "name", type: "string" });
  if (domain?.version != null) d.push({ name: "version", type: "string" });
  if (domain?.chainId != null) d.push({ name: "chainId", type: "uint256" });
  if (domain?.verifyingContract != null) d.push({ name: "verifyingContract", type: "address" });
  if (domain?.salt != null) d.push({ name: "salt", type: "bytes32" });
  return { EIP712Domain: d, ...types };
}

/**
 * Tell the platform what the exchange did with the signed order. Best-effort and non-throwing: the
 * order is already placed, and bookkeeping must never break a trading loop or delay a decision.
 * `filledSizeUsd: 0` is the important case - it says the exchange took nothing, which is what stops
 * a dead attempt from eating the per-market cap for a day. It does NOT refund the signature: that
 * was really spent, and the per-trade signature cap still counts it.
 */
export async function reportOrderOutcome({ base, token, orderRowId, filledSizeUsd, polymarketOrderId, error }) {
  if (!base || !token || !orderRowId) return false;
  try {
    let b = String(base); while (b.endsWith("/")) b = b.slice(0, -1);
    const url = b + "/api/cloud/sign/outcome";
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        orderRowId,
        filledSizeUsd: Math.max(0, Number(filledSizeUsd) || 0),
        polymarketOrderId: polymarketOrderId ?? null,
        error: error ? String(error).slice(0, 400) : null,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch {
    return false;   // the gate falls back to counting it in full for CLOUD_OUTCOME_TTL_MS
  }
}

export function makeRemoteSigner(config) {
  const base = String(process.env.COSMOS_SIGN_URL || config?.cosmosBase || config?.cosmos?.baseUrl || "").replace(/\/$/, "");
  const token = config?.cosmosToken || config?.cosmos?.token || process.env.COSMOS_TOKEN || "";
  const signWith = config?.polymarket?.signerAddress || process.env.TURNKEY_SIGN_WITH || "";
  if (!base) throw new Error("COSMOS_SIGNER=remote requires COSMOS_SIGN_URL (the platform base URL)");
  if (!token) throw new Error("COSMOS_SIGNER=remote requires a Cosmos API token (config.cosmosToken)");
  if (!/^0x[0-9a-fA-F]{40}$/.test(signWith)) throw new Error("COSMOS_SIGNER=remote requires the signer EOA (config.polymarket.signerAddress)");

  async function postSign(body) {
    let r, d;
    try {
      r = await fetch(`${base}/api/cloud/sign`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: jsonBig(body),
        signal: AbortSignal.timeout(30_000),
      });
      d = await r.json().catch(() => ({}));
    } catch (e) {
      // A network failure is NOT a definitive rejection — the placement layer may retry.
      const err = new Error(`cloud sign unreachable: ${e?.message || e}`);
      err.cloudCode = "unreachable";
      throw err;
    }
    if (r.ok && d.ok && d.signature) {
      // Remember which cloud_orders row this was so reportOrderOutcome() can close it out. Only an
      // ORDER signature has one; a ClobAuth has no order row and leaves the slot null.
      const ctx = store.getStore();
      if (ctx && d.orderRowId) ctx.orderRowId = String(d.orderRowId);
      return d.signature;
    }
    // Definitive outcomes (duplicate / denied / approver refusal) MUST NOT be retried into a
    // double-fill. Surface a typed error so placeWithRetry can stop rather than re-post.
    const err = new Error(`cloud sign ${d.code || `http_${r.status}`}: ${d.reason || d.error || "no signature"}`);
    err.cloudCode = d.code || `http_${r.status}`;
    err.cloudReason = d.reason || d.error || "";
    err.definitive = isDefinitive(d.code, r.status);
    throw err;
  }

  const account = toAccount({
    address: signWith,
    async signTypedData(typedData) {
      const { domain, types, primaryType, message } = typedData;
      const td = { domain, types: withDomainType(types, domain), primaryType, message };
      if (domain?.name === CLOBAUTH_DOMAIN || primaryType === "ClobAuth") {
        return await postSign({ typedData: td, kind: "clobauth" });
      }
      // "TypedDataSign" is the ERC-7739 envelope deposit-wallet (POLY_1271) accounts sign orders
      // in — same exchange domain, the Order nested under message.contents. The domain match alone
      // already routes it here, but the explicit primaryType keeps a future refactor to
      // primaryType-first matching from silently orphaning every deposit-wallet order.
      if (domain?.name === ORDER_DOMAIN || primaryType === "Order" || primaryType === "TypedDataSign") {
        // FAIL CLOSED on a missing context. Minting a triggerId here instead would look harmless and
        // would quietly remove idempotency for that order — every retry a fresh key, every key a
        // fresh paid signature. An unwired caller must break loudly, not trade unprotected.
        const ctx = store.getStore();
        if (!ctx?.triggerId) throw new Error("remote signer: no triggerId in context — wrap the placement in withSignContext() (see remote-signer.mjs header)");
        return await postSign({ typedData: td, triggerId: ctx.triggerId, conditionId: ctx.conditionId || "", s4: ctx.s4 === true, s4FillId: ctx.s4FillId || null, s4Group: ctx.s4Group ?? null });
      }
      throw new Error(`remote signer: refusing to sign unrecognised typed data (primaryType ${primaryType}, domain ${domain?.name})`);
    },
    async signMessage() { throw new Error("remote signer: signMessage not supported (enclave policy allows only EIP-712 Order/ClobAuth)"); },
    async signTransaction() { throw new Error("remote signer: signTransaction not supported (enclave policy denies transactions)"); },
  });

  return { account, address: signWith, mode: "remote" };
}
