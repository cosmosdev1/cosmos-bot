// THE HOSTED-RUNNER SUPERVISOR (owner 2026-08-02: "when he selects a whale, automatically start
// trading"). One always-on process that turns the roster of active hosted (Turnkey) accounts into
// running bots - a child `bot.mjs` per account - with zero per-user owner action.
//
// The supervisor is deliberately DUMB: every who-should-run decision (active status, wallet picks,
// one-bot-per-funder, self-hosted collisions) is made by the server's roster endpoint. This process
// only reconciles: start children the roster wants, stop children it no longer lists, restart
// crashes with backoff. All trading behaviour lives in the child, which is the SAME bot.mjs every
// self-hosted user runs - hosted mode is just its env (COSMOS_SIGNER=turnkey + one-shot sizing).
//
// Env:
//   COSMOS_API      base URL (default https://try-cosmos.com)
//   RUNNER_SECRET   shared secret for /api/cloud/runner/roster (required)
//   RUNNER_MAX      max concurrent children (default 25)
//   COSMOS_DATA_DIR state root; each child gets <root>/u-<userId> (rotation counter, seen.json)
//
// Per-child env (from the roster entry): COSMOS_TOKEN, COSMOS_SIGN_URL, COSMOS_SIGNER=turnkey,
// TURNKEY_SIGN_WITH, POLYMARKET_FUNDER, POLYMARKET_SIG_TYPE, CLOB[_DEPOSIT]_* creds when cached,
// COSMOS_ONESHOT=1 (hosted pays per signature - the one-shot architecture IS the hosted product),
// COSMOS_NO_1271_RECOVERY=1 (the recovery derive always fails for deposit wallets and costs a paid
// signature per attempt - proven during the 2026-07-30 prove-out).

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = (process.env.COSMOS_API || "https://try-cosmos.com").replace(/\/$/, "");
const SECRET = process.env.RUNNER_SECRET || "";
const MAX = Number(process.env.RUNNER_MAX) || 25;
const DATA_ROOT = (process.env.COSMOS_DATA_DIR || "/data").replace(/\/$/, "");
const POLL_MS = 60_000;
const BOT = join(dirname(fileURLToPath(import.meta.url)), "bot.mjs");

if (!SECRET) { console.error("[runner] RUNNER_SECRET is required"); process.exit(1); }

/** userId -> { child, startedAt, backoffMs, entry } */
const kids = new Map();
const log = (...a) => console.log(new Date().toISOString(), "[runner]", ...a);

async function roster() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20_000); // deadline rule: a hung poll must not wedge the loop
  try {
    const r = await fetch(`${API}/api/cloud/runner/roster`, { headers: { "x-runner-secret": SECRET }, signal: ctl.signal });
    if (!r.ok) { log(`roster HTTP ${r.status}`); return null; }
    const j = await r.json().catch(() => null);
    return Array.isArray(j?.accounts) ? j.accounts : null;
  } catch (e) {
    log("roster fetch failed:", e?.message ?? e);
    return null;
  } finally { clearTimeout(t); }
}

function childEnv(a) {
  const env = {
    ...process.env,
    COSMOS_API: API,
    COSMOS_TOKEN: a.token,
    COSMOS_SIGN_URL: API,                       // remote signer base; the module appends its paths
    COSMOS_SIGNER: "turnkey",
    TURNKEY_SIGN_WITH: a.signer || "",
    POLYMARKET_FUNDER: a.funder || "",
    POLYMARKET_SIG_TYPE: a.sig_type || "",
    COSMOS_ONESHOT: "1",
    COSMOS_NO_1271_RECOVERY: "1",
    COSMOS_DATA_DIR: join(DATA_ROOT, `u-${a.user_id}`),
  };
  delete env.POLYMARKET_PRIVATE_KEY;            // hosted children must NEVER inherit a local key
  delete env.RUNNER_SECRET;                     // and never see the fleet secret
  if (a.clob?.key) {
    env.CLOB_API_KEY = a.clob.key; env.CLOB_API_SECRET = a.clob.secret || ""; env.CLOB_PASSPHRASE = a.clob.passphrase || "";
  }
  if (a.clob_deposit?.key) {
    env.CLOB_DEPOSIT_API_KEY = a.clob_deposit.key;
    env.CLOB_DEPOSIT_API_SECRET = a.clob_deposit.secret || "";
    env.CLOB_DEPOSIT_PASSPHRASE = a.clob_deposit.passphrase || "";
  }
  return env;
}

function start(a) {
  try { mkdirSync(join(DATA_ROOT, `u-${a.user_id}`), { recursive: true }); } catch { /* child retries */ }
  const child = spawn(process.execPath, [BOT], { env: childEnv(a), stdio: ["ignore", "pipe", "pipe"] });
  const tag = a.user_id.slice(0, 8);
  child.stdout.on("data", (d) => process.stdout.write(`[${tag}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${tag}] ${d}`));
  const rec = { child, startedAt: Date.now(), backoffMs: kids.get(a.user_id)?.backoffMs ?? 30_000, entry: a };
  child.on("exit", (code, sig) => {
    const uptimeS = Math.round((Date.now() - rec.startedAt) / 1000);
    log(`bot ${tag} exited code=${code} sig=${sig} uptime=${uptimeS}s`);
    // A child that survived 10+ minutes earns a fresh backoff; a crash loop doubles up to 10 min.
    rec.backoffMs = uptimeS > 600 ? 30_000 : Math.min(rec.backoffMs * 2, 600_000);
    rec.child = null;
    rec.retryAt = Date.now() + rec.backoffMs;
  });
  kids.set(a.user_id, rec);
  log(`started bot ${tag} (funder ${String(a.funder || "").slice(0, 10)}, wallets ${a.wallets}, sig ${a.sig_type || "auto"})`);
}

function stop(userId, why) {
  const rec = kids.get(userId);
  if (!rec) return;
  kids.delete(userId);
  if (rec.child) {
    log(`stopping bot ${userId.slice(0, 8)} - ${why}`);
    rec.child.kill("SIGTERM");
    const c = rec.child;
    setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* already gone */ } }, 10_000).unref();
  }
}

async function reconcile() {
  const list = await roster();
  if (!list) return; // transient server trouble: keep current children running untouched

  const want = new Map();
  for (const a of list) {
    if (a.skip) { log(`skip ${a.user_id.slice(0, 8)}: ${a.skip}`); continue; }
    if (!a.token || !(a.wallets > 0) || a.bot_enabled === false) continue;
    want.set(a.user_id, a);
  }

  for (const userId of [...kids.keys()]) {
    if (!want.has(userId)) stop(userId, "no longer on the roster (halted, disabled, or wallets cleared)");
  }

  for (const [userId, a] of want) {
    const rec = kids.get(userId);
    if (rec?.child) continue;                          // running
    if (rec && rec.retryAt && Date.now() < rec.retryAt) continue; // crash backoff
    if ([...kids.values()].filter((k) => k.child).length >= MAX) { log(`at RUNNER_MAX=${MAX}, deferring ${userId.slice(0, 8)}`); break; }
    start(a);
  }
}

log(`hosted runner up - api ${API}, max ${MAX} bots, data ${DATA_ROOT}`);
await reconcile();
setInterval(() => { reconcile().catch((e) => log("reconcile error:", e?.message ?? e)); }, POLL_MS);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`${sig}: stopping ${kids.size} bots`);
    for (const userId of [...kids.keys()]) stop(userId, "supervisor shutdown");
    setTimeout(() => process.exit(0), 2_000);
  });
}
