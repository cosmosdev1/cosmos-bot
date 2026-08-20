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
// Per-child env (from the roster entry): COSMOS_TOKEN, COSMOS_SIGN_URL, COSMOS_SIGNER=remote,
// TURNKEY_SIGN_WITH, POLYMARKET_FUNDER, POLYMARKET_SIG_TYPE, CLOB[_DEPOSIT]_* creds when cached,
// COSMOS_ONESHOT=1 (hosted pays per signature - the one-shot architecture IS the hosted product),
// COSMOS_NO_1271_RECOVERY=1 (the recovery derive always fails for deposit wallets and costs a paid
// signature per attempt - proven during the 2026-07-30 prove-out).

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const API = (process.env.COSMOS_API || "https://try-cosmos.com").replace(/\/$/, "");
const SECRET = process.env.RUNNER_SECRET || "";
// CAP FROM THE MACHINE, not a stale hardcode (scale build Inc 0.5, 2026-08-17). The cap and the
// box diverged twice (60 runnable vs cap 48, ~$1,050 of accounts silently unmanaged; and the
// 08-05 OOM the other direction). Default = what the memory actually supports at ~80MB/child
// with 600MB reserved for OS + runner. RUNNER_MAX still overrides when set explicitly.
// 80MB/child was a conservative guess; MEASURED 2026-08-18 on the live box it is ~39MB (88
// children used 3.4GB above a ~600MB base). Budgeting 55MB keeps a wide margin over the measurement
// while no longer under-provisioning a box by half - the 08-05 OOM taught the cost of being too
// generous, and the 08-11 starvation taught the cost of being too stingy.
const derivedMax = Math.max(4, Math.floor((os.totalmem() / 1048576 - 600) / 55));
const MAX = Number(process.env.RUNNER_MAX) || derivedMax;
// Boot ramp: children started per reconcile pass (~60s apart). 8/pass fills a 48-slot box in ~6
// minutes while keeping the platform's boot load flat. Env-tunable for a cold-start hurry.
const RAMP = Number(process.env.RUNNER_SPAWN_RAMP) || 8;
const DATA_ROOT = (process.env.COSMOS_DATA_DIR || "/data").replace(/\/$/, "");
const POLL_MS = 60_000;
const BOT = join(dirname(fileURLToPath(import.meta.url)), "bot.mjs");

if (!SECRET) { console.error("[runner] RUNNER_SECRET is required"); process.exit(1); }

/** userId -> { child, startedAt, backoffMs, entry } */
const kids = new Map();
const log = (...a) => console.log(new Date().toISOString(), "[runner]", ...a);

// ---- SHARED CHAIN SUBSCRIPTION (Inc 1.5) ----
// One socket for this whole box instead of one per child. Off by default so the first deploy is a
// no-op; COSMOS_CHAINHUB=1 on the RUNNER turns it on for the children it spawns.
const HUB_ENABLED = process.env.COSMOS_CHAINHUB === "1";
// SIGNAL HUB (scale build 2026-08-20): one shared evaluation per box instead of one per child.
// Off by default so the first deploy is a no-op; COSMOS_SIGNALHUB=1 turns it on.
const SIGNALHUB_ENABLED = process.env.COSMOS_SIGNALHUB === "1";
// The supervisor had NO top-level handlers while every child has both (bot.mjs). One unhandled
// rejection here takes the entire fleet dark until Fly restarts it, then the ramp costs minutes.
process.on("uncaughtException", (e) => console.error(new Date().toISOString(), "runner uncaught:", e?.stack ?? e));
process.on("unhandledRejection", (e) => console.error(new Date().toISOString(), "runner unhandled rejection:", e?.stack ?? e));
let hubToken = null;
let sigHub = null;
/** userId -> string[] of wallets that child follows (reported over IPC) */
const childWallets = new Map();
let hub = null;
function syncHubWallets() {
  if (!hub) return;
  hub.setWallets([...childWallets.values()].flat());
}
function broadcast(msg) {
  for (const rec of kids.values()) {
    if (!rec.child?.connected) continue;
    try { rec.child.send(msg); } catch { /* a child mid-exit; its own watchdog covers it */ }
  }
}

// SHARDING (scale build Inc 1.3, 2026-08-17): RUNNER_SHARD="i/N" gives this VM a disjoint,
// stable slice of the fleet (hashed server-side on user_id). Unset = the whole fleet, as before.
// Capacity now grows by adding VMs instead of raising one box's cap.
const SHARD = /^\d+\/\d+$/.test(process.env.RUNNER_SHARD || "") ? process.env.RUNNER_SHARD : "";

async function roster() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20_000); // deadline rule: a hung poll must not wedge the loop
  try {
    // Report our REAL cap so the platform's capacity warning can never drift from it (that mirror
    // has been wrong in both directions before - see the roster route's note).
    const qs = new URLSearchParams();
    if (SHARD) qs.set("shard", SHARD);
    qs.set("cap", String(MAX));
    const url = `${API}/api/cloud/runner/roster?${qs.toString()}`;
    const r = await fetch(url, { headers: { "x-runner-secret": SECRET }, signal: ctl.signal });
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
    // "remote", NOT "turnkey" (first live fleet start, 2026-08-03): signer.mjs refuses direct
    // Turnkey from the bot - it would bypass the risk gate, the approver and the per-trade
    // signature cap. remote signs through the platform's /api/cloud/sign gate, which is the
    // live-proven path. All 8 children crash-looped on this one word.
    COSMOS_SIGNER: "remote",
    TURNKEY_SIGN_WITH: a.signer || "",
    POLYMARKET_FUNDER: a.funder || "",
    POLYMARKET_SIG_TYPE: a.sig_type || "",
    COSMOS_ONESHOT: "1",
    COSMOS_NO_1271_RECOVERY: "1",
    COSMOS_DATA_DIR: join(DATA_ROOT, `u-${a.user_id}`),
    // Inc 1.5: this box keeps ONE chain subscription and forwards logs over IPC, so the child must
    // not open its own. Hosted-only by construction - a self-hosted bot never has this set.
    ...(HUB_ENABLED ? { COSMOS_CHAINHUB: "1" } : {}),
  };
  delete env.POLYMARKET_PRIVATE_KEY;            // hosted children must NEVER inherit a local key
  delete env.RUNNER_SECRET;                     // and never see the fleet secret
  // The metered endpoint belongs to the HUB alone (one socket, one keepalive). Children must not
  // inherit it, or we are back to ~90 clients on a plan priced for one.
  delete env.COSMOS_HUB_WSS;
  delete env.COSMOS_HUB_RPC;
  delete env.QUICKNODE_WSS;
  delete env.QUICKNODE_HTTP;
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
  // "ipc" adds a message channel (child.send / process.on("message")). It is what lets ONE socket
  // on this box serve every child (chainhub, Inc 1.5) instead of ~90 sockets and ~90 keepalives.
  let child;
  try {
    child = spawn(process.execPath, [BOT], { env: childEnv(a), stdio: ["ignore", "pipe", "pipe", "ipc"] });
  } catch (e) {
    // A supervisor that dies on a failed spawn is the wrong failure mode at any size: Fly restarts
    // it, it spawns again, and the fleet crash-loops dark. Log and move on - the reconcile pass
    // retries this child next minute. (QA 2026-08-20)
    console.warn(new Date().toISOString(), `spawn failed for ${a.user_id?.slice(0, 8)}: ${e?.message ?? e}`);
    return;
  }
  // Node emits 'error' ASYNCHRONOUSLY on spawn failure, and an unlistened 'error' event THROWS.
  child.on("error", (e) => console.warn(new Date().toISOString(), `child ${a.user_id?.slice(0, 8)} error: ${e?.message ?? e}`));
  const tag = a.user_id.slice(0, 8);
  child.stdout.on("data", (d) => process.stdout.write(`[${tag}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${tag}] ${d}`));
  // Children report the wallets they follow; the hub subscribes to the union of all of them.
  child.on("message", (m) => {
    if (m?.t === "wallets" && Array.isArray(m.list)) { childWallets.set(a.user_id, m.list); syncHubWallets(); }
  });
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
  // Drop its wallets from the union too, or the hub keeps subscribing to whales nobody follows.
  if (childWallets.delete(userId)) syncHubWallets();
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
    // The signal hub calls /copy-enterable, which needs a bot token. The payload is identical for
    // every caller (it is the objective enterable set, not anyone's feed), so any live token on
    // this box serves. Refreshed from the roster each pass so a departing user cannot strand it.
    hubToken = hubToken || a.token;
  }
  if (hubToken && ![...want.values()].some((a) => a.token === hubToken)) hubToken = [...want.values()][0]?.token || null;

  for (const userId of [...kids.keys()]) {
    if (!want.has(userId)) stop(userId, "no longer on the roster (halted, disabled, or wallets cleared)");
  }

  // COUNT the starvation instead of break-ing blind (scale build Inc 0.5): every deferred account
  // is user money with no manager, and that must page, not whisper in a Fly log.
  let running = [...kids.values()].filter((k) => k.child).length;
  let deferred = 0, startedThisPass = 0;
  for (const [userId, a] of want) {
    const rec = kids.get(userId);
    if (rec?.child) continue;                          // running
    if (rec && rec.retryAt && Date.now() < rec.retryAt) continue; // crash backoff
    if (running >= MAX) { deferred++; continue; }
    // SPAWN RAMP (scale build Inc 1.3, 2026-08-17): a deploy or a cold start used to launch EVERY
    // child in one pass - each booting child immediately hits /v1/account, /signals, the CLOB and
    // the sign path, and that synchronized herd is what 5xx'd the platform on 2026-08-05. Ramp:
    // at most RAMP children per reconcile pass (~60s apart), each with a small random boot delay
    // so even within a pass they do not fire in lockstep. This ONLY affects boot; a running bot's
    // trading loop and the <1s chainwatch fast path are untouched.
    if (startedThisPass >= RAMP) { continue; }         // next pass takes the rest (not a deferral)
    startedThisPass++;
    const jitter = Math.floor(Math.random() * 4000);
    setTimeout(() => { if (!kids.get(userId)?.child) start(a); }, jitter).unref();
    running++;
  }
  if (startedThisPass >= RAMP) log(`spawn ramp: started ${startedThisPass} this pass, more next pass`);
  if (deferred > 0) {
    log(`ALARM: ${deferred} runnable account(s) deferred at MAX=${MAX} - money with no manager`);
    alertPlatform(`runner at capacity: ${deferred} account(s) deferred (MAX=${MAX})`, deferred);
  }
}

// Throttled alert to the platform's alarm channel (scan_runs source alarm-runner) - fire and
// forget, never let alerting wedge the reconcile loop.
let lastAlertAt = 0;
function alertPlatform(note, count) {
  if (Date.now() - lastAlertAt < 10 * 60_000) return;
  lastAlertAt = Date.now();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8_000);
  fetch(`${API}/api/cloud/runner/alert`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runner-secret": SECRET },
    body: JSON.stringify({ note, count }),
    signal: ctl.signal,
  }).catch(() => {}).finally(() => clearTimeout(t));
}

log(`hosted runner up - api ${API}, max ${MAX} bots, data ${DATA_ROOT}${HUB_ENABLED ? ", chainhub ON" : ""}`);

// Start the shared subscription BEFORE any child, so the first wallets reported find a live hub.
// Loaded dynamically so a box with the hub off never even parses it.
if (SIGNALHUB_ENABLED) {
  try {
    const { startSignalHub } = await import("./signalhub.mjs");
    sigHub = startSignalHub({
      fetchEnterable: async () => {
        if (!hubToken) throw new Error("no bot token on this box yet");
        const r = await fetch(`${API}/api/v1/copy-enterable`, {
          headers: { authorization: `Bearer ${hubToken}` },
          signal: AbortSignal.timeout(12_000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      },
      broadcast,
      log: (...a) => console.log(new Date().toISOString(), ...a),
      warn: (...a) => console.warn(new Date().toISOString(), ...a),
    });
    setInterval(() => {
      const s2 = sigHub.stats();
      log(`signalhub: ${s2.ageMs == null ? "NEVER OK" : `last ok ${Math.round(s2.ageMs / 1000)}s ago`} · ${s2.lastCount} enterable · ${s2.consecutiveFails} fails · ${kids.size} children`);
    }, 300_000);
  } catch (e) {
    console.warn("signalhub failed to start:", e?.message ?? e);
  }
}

if (HUB_ENABLED) {
  try {
    const { startChainHub } = await import("./chainhub.mjs");
    hub = startChainHub({
      onLog: (l) => broadcast({ t: "log", log: l }),
      onBeat: () => broadcast({ t: "beat" }),
      log: (...a) => console.log(new Date().toISOString(), ...a),
      warn: (...a) => console.warn(new Date().toISOString(), ...a),
    });
    setInterval(() => {
      const s = hub.stats();
      log(`chainhub: ${s.connected ? "connected" : "DISCONNECTED"} · ${s.wallets} wallets · ${s.delivered} logs delivered · ${kids.size} children`);
    }, 10 * 60_000).unref?.();
  } catch (e) {
    // Never let a hub failure stop the fleet: with no hub the children hear no heartbeat and each
    // opens its own socket after 2 minutes - exactly the pre-1.5 behaviour.
    log("chainhub failed to start - children will fall back to their own sockets:", e?.message ?? e);
    hub = null;
  }
}

await reconcile();
setInterval(() => { reconcile().catch((e) => log("reconcile error:", e?.message ?? e)); }, POLL_MS);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`${sig}: stopping ${kids.size} bots`);
    for (const userId of [...kids.keys()]) stop(userId, "supervisor shutdown");
    setTimeout(() => process.exit(0), 2_000);
  });
}
