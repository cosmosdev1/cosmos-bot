// DRY HARNESS for the hosted-custody remote signer. No network, no Turnkey, no signatures, no money.
//
// It proves the four properties the money depends on:
//   1. an Order signed with NO context throws (fail closed) rather than trading unprotected;
//   2. one decision keeps ONE triggerId across its retries (idempotency the gate can key on);
//   3. CONCURRENT decisions never see each other's triggerId — the reason this uses
//      AsyncLocalStorage instead of a module-level variable;
//   4. a definitive refusal is reported as such, and a transient one is not.
//
// Run: node tools/dry-remote-signer.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withSignContext, makeRemoteSigner } from "../src/remote-signer.mjs";

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

// A signer whose HTTP layer is replaced by a scripted responder, so nothing leaves the process.
const SIGNER = "0x" + "a".repeat(40);
function harness(respond) {
  const seen = [];
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    const r = respond(body);
    return { ok: r.status === 200, status: r.status, json: async () => r.body };
  };
  const { account } = makeRemoteSigner({
    cosmosBase: "https://example.invalid", cosmosToken: "t",
    polymarket: { signerAddress: SIGNER },
  });
  return { account, seen };
}

const ORDER = {
  domain: { name: "Polymarket CTF Exchange", version: "1", chainId: 137, verifyingContract: "0x" + "b".repeat(40) },
  types: { Order: [{ name: "salt", type: "uint256" }] },
  primaryType: "Order",
  message: { salt: 1n },
};
const okSig = () => ({ status: 200, body: { ok: true, signature: "0xsig" } });

console.log("\nremote signer — dry harness (no network, no signatures)\n");

await t("an Order with NO sign context is REFUSED (fail closed)", async () => {
  const { account, seen } = harness(okSig);
  await assert.rejects(() => account.signTypedData(ORDER), /no triggerId in context/);
  assert.equal(seen.length, 0, "must not have reached the platform at all");
});

await t("ClobAuth needs no context (it is not an order)", async () => {
  const { account, seen } = harness(okSig);
  const sig = await account.signTypedData({
    domain: { name: "ClobAuthDomain", version: "1", chainId: 137 },
    types: { ClobAuth: [{ name: "address", type: "address" }] },
    primaryType: "ClobAuth", message: { address: SIGNER },
  });
  assert.equal(sig, "0xsig");
  assert.equal(seen[0].kind, "clobauth");
  assert.equal(seen[0].triggerId, undefined, "clobauth must carry no trigger");
});

await t("one decision keeps ONE triggerId across its retries", async () => {
  const { account, seen } = harness(okSig);
  const id = randomUUID();
  await withSignContext({ triggerId: id, conditionId: "0xcond" }, async () => {
    for (let i = 0; i < 3; i++) await account.signTypedData(ORDER);
  });
  assert.equal(seen.length, 3);
  assert.deepEqual([...new Set(seen.map((s) => s.triggerId))], [id], "retries must share one trigger");
  assert.deepEqual([...new Set(seen.map((s) => s.conditionId))], ["0xcond"]);
});

await t("CONCURRENT decisions never borrow each other's triggerId", async () => {
  // THE regression this guards: bot.mjs starts the main loop, copytrade, qtable2 and cert15 side by
  // side, and each awaits network I/O mid-placement. With a module-level context, whichever loop ran
  // last before an await resumed would win, and an order would be signed under another decision's
  // trigger — destroying the idempotency the double-fill protection rests on.
  const order = [];
  const { account, seen } = harness(() => { order.push(1); return okSig(); });
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const run = (id, delay) => withSignContext({ triggerId: id, conditionId: id }, async () => {
    await new Promise((r) => setTimeout(r, delay));          // interleave the loops
    await account.signTypedData(ORDER);
    await new Promise((r) => setTimeout(r, delay));
    await account.signTypedData(ORDER);
  });
  await Promise.all([run(ids[0], 30), run(ids[1], 10), run(ids[2], 20)]);
  assert.equal(seen.length, 6);
  for (const id of ids) {
    const mine = seen.filter((s) => s.triggerId === id);
    assert.equal(mine.length, 2, `decision ${id.slice(0, 8)} signed under its own trigger twice`);
    assert.ok(mine.every((s) => s.conditionId === id), "context fields must stay together");
  }
});

await t("a DEFINITIVE refusal is flagged (200 + code, the shape the gate actually returns)", async () => {
  for (const code of ["duplicate", "trade_signature_cap", "fleet_halted", "day_budget", "dust"]) {
    const { account } = harness(() => ({ status: 200, body: { ok: false, code, reason: code } }));
    const e = await withSignContext({ triggerId: "x" }, () => account.signTypedData(ORDER).catch((x) => x));
    assert.equal(e.cloudCode, code);
    assert.equal(e.definitive, true, `${code} must stop the retry loop`);
  }
});

await t("a TRANSIENT refusal stays retryable", async () => {
  for (const code of ["no_book", "sell_below_book", "buy_above_book", "approver_unreachable", "sign_failed", "reserve_failed"]) {
    const { account } = harness(() => ({ status: 200, body: { ok: false, code, reason: code } }));
    const e = await withSignContext({ triggerId: "x" }, () => account.signTypedData(ORDER).catch((x) => x));
    assert.equal(e.definitive, false, `${code} must remain retryable`);
  }
});

await t("an UNKNOWN code fails safe (retryable, never a skipped exit)", async () => {
  const { account } = harness(() => ({ status: 200, body: { ok: false, code: "some_future_code" } }));
  const e = await withSignContext({ triggerId: "x" }, () => account.signTypedData(ORDER).catch((x) => x));
  assert.equal(e.definitive, false);
});

await t("a 4xx is definitive; a 5xx and a network failure are not", async () => {
  const h4 = harness(() => ({ status: 409, body: { ok: false, code: "weird" } }));
  const e4 = await withSignContext({ triggerId: "x" }, () => h4.account.signTypedData(ORDER).catch((x) => x));
  assert.equal(e4.definitive, true);

  const h5 = harness(() => ({ status: 503, body: { ok: false, code: "weird" } }));
  const e5 = await withSignContext({ triggerId: "x" }, () => h5.account.signTypedData(ORDER).catch((x) => x));
  assert.equal(e5.definitive, false);

  global.fetch = async () => { throw new Error("ECONNRESET"); };
  const { account } = makeRemoteSigner({ cosmosBase: "https://example.invalid", cosmosToken: "t", polymarket: { signerAddress: SIGNER } });
  const en = await withSignContext({ triggerId: "x" }, () => account.signTypedData(ORDER).catch((x) => x));
  assert.equal(en.cloudCode, "unreachable");
  assert.notEqual(en.definitive, true, "a network failure must never be read as a definitive refusal");
});

await t("an ERC-7739 TypedDataSign envelope routes as an ORDER (context required, trigger carried)", async () => {
  const { account, seen } = harness(okSig);
  const env7739 = {
    domain: ORDER.domain, // same exchange domain — that is the 7739 shape
    types: { TypedDataSign: [{ name: "contents", type: "Order" }], Order: ORDER.types.Order },
    primaryType: "TypedDataSign",
    message: { contents: ORDER.message, name: "DepositWallet", version: "1", chainId: 137, verifyingContract: "0x" + "c".repeat(40), salt: "0x" + "0".repeat(64) },
  };
  await assert.rejects(() => account.signTypedData(env7739), /no triggerId in context/);
  const id = randomUUID();
  await withSignContext({ triggerId: id, conditionId: "0xcond" }, () => account.signTypedData(env7739));
  assert.equal(seen.at(-1).triggerId, id, "envelope order must carry the decision trigger");
});

await t("the signer refuses everything that is not an Order or ClobAuth", async () => {
  const { account } = harness(okSig);
  await assert.rejects(() => account.signMessage({ message: "hi" }), /not supported/);
  await assert.rejects(() => account.signTransaction({}), /not supported/);
  await assert.rejects(
    () => account.signTypedData({ domain: { name: "USDC" }, types: {}, primaryType: "Permit", message: {} }),
    /refusing to sign unrecognised typed data/);
});

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
