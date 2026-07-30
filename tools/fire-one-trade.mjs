// FIRE ONE HOSTED-CUSTODY TRADE — the end-to-end prove-out.
//
// This is deliberately NOT a strategy. It places exactly ONE order through the exact production
// path, so a fill here proves the whole chain works with real money:
//
//   this script -> bot's makePolymarket (COSMOS_SIGNER=remote)
//               -> remote-signer  -> POST /api/cloud/sign
//               -> gate  (halt, account, book, signature cap, idempotency, risk)
//               -> delegate initiates the enclave signature
//               -> a SEPARATE approver re-prices and co-signs
//               -> Turnkey enclave completes it under the sub-org policy set
//               -> signed order -> Polymarket CLOB -> fill
//
// COST: enclave signatures are billed, so this defaults to a DRY RUN and prints exactly what it
// would spend. Nothing is signed and no order is placed without --fire.
//
//   node tools/fire-one-trade.mjs                     # dry run: preview only
//   node tools/fire-one-trade.mjs --fire              # place it for real
//   node tools/fire-one-trade.mjs --usd 2 --fire
//   node tools/fire-one-trade.mjs --token <tokenId> --fire
//
// Env required (or a config.json alongside):
//   COSMOS_SIGN_URL   platform base url  (e.g. http://localhost:3021 or https://try-cosmos.com)
//   COSMOS_TOKEN      the account's csk_ API token
//   TURNKEY_SIGN_WITH the sub-org signer EOA
//   POLYMARKET_FUNDER the Polymarket funder/proxy address

import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { makePolymarket } from "../src/polymarket.mjs";
import { withSignContext } from "../src/remote-signer.mjs";

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const FIRE = argv.includes("--fire");
const USD = Number(flag("usd", 1));
const TOKEN = flag("token", "");

process.env.COSMOS_SIGNER = "remote"; // the whole point: never the local key path

const f = existsSync("./config.json") ? JSON.parse(readFileSync("./config.json", "utf8")) : {};
const config = {
  cosmosApi: (process.env.COSMOS_API || f.cosmosApi || "https://try-cosmos.com").replace(/\/$/, ""),
  cosmosBase: (process.env.COSMOS_SIGN_URL || f.cosmosBase || "").replace(/\/$/, ""),
  cosmosToken: process.env.COSMOS_TOKEN || f.cosmosToken,
  polymarket: {
    signerAddress: process.env.TURNKEY_SIGN_WITH || f.polymarket?.signerAddress || "",
    funderAddress: process.env.POLYMARKET_FUNDER || f.polymarket?.funderAddress || "",
  },
};

const die = (m) => { console.error(`\n✗ ${m}\n`); process.exit(1); };
if (!config.cosmosBase) die("COSMOS_SIGN_URL is not set (the platform base url that hosts /api/cloud/sign)");
if (!config.cosmosToken) die("COSMOS_TOKEN is not set (the account's csk_ API token)");
if (!config.polymarket.signerAddress) die("TURNKEY_SIGN_WITH is not set (the sub-org signer EOA)");
if (!config.polymarket.funderAddress) die("POLYMARKET_FUNDER is not set (the Polymarket funder/proxy)");

console.log(`
──────────────────────────────────────────────────────────────
 HOSTED CUSTODY — one-trade prove-out   ${FIRE ? "*** LIVE ***" : "(dry run)"}
──────────────────────────────────────────────────────────────
 platform ...... ${config.cosmosBase}
 signer EOA .... ${config.polymarket.signerAddress}
 funder ........ ${config.polymarket.funderAddress}
 order size .... $${USD.toFixed(2)}
`);

// ---- pick the market -------------------------------------------------------
// Default to the nearest hourly Bitcoin Up/Down market: it is always liquid, it is small, and it
// resolves within the hour so the test capital comes straight back.
async function pickMarket() {
  if (TOKEN) return { tokenId: TOKEN, title: "(token supplied on the command line)", outcome: "?" };
  // end_date_min is REQUIRED. Without it gamma answers with the oldest unresolved markets it has
  // (stale ones from months back) and the hourly crypto series never appears at all.
  const now = Date.now();
  const qs = new URLSearchParams({
    closed: "false", active: "true", limit: "200", order: "endDate", ascending: "true",
    end_date_min: new Date(now + 4 * 60_000).toISOString(),   // room to fill before it settles
    end_date_max: new Date(now + 3 * 3600_000).toISOString(),
  });
  const r = await fetch(`https://gamma-api.polymarket.com/markets?${qs}`, { signal: AbortSignal.timeout(20_000) });
  const rows = await r.json();
  const cands = (Array.isArray(rows) ? rows : [])
    .filter((m) => /bitcoin up or down/i.test(m.question || ""))
    .sort((a, b) => new Date(a.endDate) - new Date(b.endDate));
  const m = cands[0];
  if (!m) return null;
  const tokens = JSON.parse(m.clobTokenIds || "[]");
  const outcomes = JSON.parse(m.outcomes || "[]");
  return { tokenId: tokens[0], title: m.question, outcome: outcomes[0], endDate: m.endDate };
}

const pick = await pickMarket();
if (!pick?.tokenId) die("could not find a live Bitcoin Up/Down market — pass --token <tokenId> instead");
console.log(` market ........ ${pick.title}`);
console.log(` outcome ....... ${pick.outcome}`);
if (pick.endDate) console.log(` resolves ...... ${new Date(pick.endDate).toISOString()}`);

// ---- price it, WITHOUT booting the bot stack -------------------------------
// Deliberately no makePolymarket() yet: it derives CLOB L2 credentials at boot, and hosted that
// derivation is a real ClobAuth enclave signature — billed. A dry run that quietly cost a signature
// would defeat the point of having one, so everything below the --fire check stays pure reads.
//
// The book comes from the public CLOB endpoint: the same source the platform gate uses server-side,
// so what we price against is what the gate will independently re-check.
async function readBook(tokenId) {
  const r = await fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) return { ask: null, bid: null, askDepthUsd: 0 };
  const book = await r.json();
  let ask = Infinity, bid = 0, askDepthUsd = 0;
  for (const a of book?.asks ?? []) {
    const price = Number(a?.price ?? 0), size = Number(a?.size ?? 0);
    if (size > 0 && price > 0) { if (price < ask) ask = price; askDepthUsd += price * size; }
  }
  for (const b of book?.bids ?? []) {
    const price = Number(b?.price ?? 0), size = Number(b?.size ?? 0);
    if (size > 0 && price > bid) bid = price;
  }
  return {
    ask: Number.isFinite(ask) ? Math.round(ask * 100) : null,
    bid: bid > 0 ? Math.round(bid * 100) : null,
    askDepthUsd,
  };
}

const { ask, bid, askDepthUsd } = await readBook(pick.tokenId);
const mid = ask != null && bid != null ? Math.round((ask + bid) / 2) : null;
if (ask == null) die("no best ask on this market — refusing to buy into an unknown book");
// Cross the spread by a cent so the FAK actually fills. Well inside the gate's 15% slip band.
const priceCents = Math.max(1, Math.min(99, ask + 1));
// CEIL, not floor (prove-out: 2.32sh x 43c = $0.9976 -> the gate's $1 dust floor refused it). Ceiling
// puts the notional a hair ABOVE the target, so integer-cent rounding can never dip under the minimum.
const shares = Math.ceil((USD / (priceCents / 100)) * 100) / 100;

console.log(`
 best bid/ask .. ${bid ?? "?"}c / ${ask}c        (mid ${mid ?? "?"}c, ask depth $${askDepthUsd.toFixed(0)})
 our limit ..... ${priceCents}c
 shares ........ ${shares}
 notional ...... $${(shares * priceCents / 100).toFixed(2)}
`);

console.log(` signatures this will spend:`);
console.log(`   1x ClobAuth  (credential derivation — only if this account has no L2 creds yet)`);
console.log(`   1x Order     (the trade itself)`);
console.log(`   cap enforced server-side: 2 per (market, token, side) per 24h\n`);

if (!FIRE) {
  console.log("──────────────────────────────────────────────────────────────");
  console.log(" DRY RUN — nothing signed, nothing placed, nothing billed.");
  console.log(" Re-run with --fire to place it for real.");
  console.log("──────────────────────────────────────────────────────────────\n");
  process.exit(0);
}

// ---- fire ------------------------------------------------------------------
// Only NOW do we boot the bot stack: this is what derives the CLOB credentials (a paid ClobAuth
// signature on the first run for this account) and builds the remote signer.
const pm = await makePolymarket(config);

// One decision = one triggerId, exactly as placeWithRetry does it. Deliberately NO retry loop here:
// this is a one-shot prove-out and a retry would be a second paid signature for no new information.
const triggerId = randomUUID();
console.log(` firing … triggerId ${triggerId}\n`);

const res = await withSignContext({ triggerId }, () =>
  pm.placeOrder({ tokenId: pick.tokenId, side: "BUY", sizeShares: shares, priceCents, orderType: "FAK" }));

console.log("──────────────────────────────────────────────────────────────");
if (res.ok) {
  console.log(` ✓ FILLED — ${res.meta?.size} shares @ ${res.meta?.price}c  ($${((res.meta?.size || 0) * (res.meta?.price || 0) / 100).toFixed(2)})`);
  console.log(`   order id: ${res.meta?.polymarket_response?.orderID ?? "(see response)"}`);
} else {
  console.log(` ✗ NOT FILLED`);
  console.log(`   cloud code .. ${res.cloudCode ?? "(none — the CLOB refused, not the platform)"}`);
  console.log(`   definitive .. ${res.cloudDefinitive ? "yes (a retry cannot help)" : "no (transient)"}`);
  console.log(`   detail ...... ${JSON.stringify(res.body?.polymarket ?? res.body).slice(0, 600)}`);
}
console.log("──────────────────────────────────────────────────────────────\n");
process.exit(res.ok ? 0 : 1);
