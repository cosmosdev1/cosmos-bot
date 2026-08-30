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
import { mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { parseProcStat } from "./proc.mjs";
import { deriveCap } from "./admission.mjs";
import { merge as mMerge, emptyAggregate as mEmpty } from "./metrics.mjs";
import { qualifyingFillIds, fillsFromLog } from "./fills.mjs";
import { startS4Hub } from "./s4-hub.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const API = (process.env.COSMOS_API || "https://try-cosmos.com").replace(/\/$/, "");
const SECRET = process.env.RUNNER_SECRET || "";
// CAP FROM THE MACHINE, not a stale hardcode (scale build Inc 0.5, 2026-08-17), and since stage 2F
// (2026-08-28) from BOTH resources: min(memory, cpu), each budgeted from the measured distribution's
// tail with explicit headroom. The single 55 MB/child constant this replaces was read once, 16
// minutes after a restart, and implied 22 GB at its own cap on a 15.6 GB box. Derivation, the
// measurements and every knob live in ./admission.mjs; the result is logged at boot below so the
// cap in force is never a guess. RUNNER_MAX still overrides when set explicitly.
const ADMISSION = deriveCap({ totalMemMB: os.totalmem() / 1048576, nproc: os.cpus().length || 1, env: process.env });
const MAX = ADMISSION.cap;
console.log(`[runner] admission cap ${ADMISSION.detail} · binding: ${ADMISSION.binding}`);
// Boot ramp: children started per reconcile pass (~60s apart). 8/pass fills a 48-slot box in ~6
// minutes while keeping the platform's boot load flat. Env-tunable for a cold-start hurry.
// SPAWN RAMP, scaled to the roster (scale QA 2026-08-20). A flat 8 per ~60s reconcile pass means a
// cold start takes N/8 minutes - fine at 93 (12 min), but 2,000 bots would sit DARK for 4h10m, and
// the ramp applies to every restart and every deploy, not just first boot. Scaling with the cap
// holds a full cold start near 20 minutes at any fleet size while still spreading the thundering
// herd that the ramp exists to prevent.
const RAMP = Number(process.env.RUNNER_SPAWN_RAMP) || Math.max(8, Math.ceil(MAX / 20));
const DATA_ROOT = (process.env.COSMOS_DATA_DIR || "/data").replace(/\/$/, "");
const POLL_MS = 60_000;
const BOT = join(dirname(fileURLToPath(import.meta.url)), "bot.mjs");

if (!SECRET) { console.error("[runner] RUNNER_SECRET is required"); process.exit(1); }

// STAGE 1 FLEET METRICS. One in-memory aggregate for the whole box, flushed as ONE row per minute.
// Never per event: that is what made scan_runs a 3.5M-row problem.
let fleetMetrics = mEmpty();
let s4Mode = process.env.COSMOS_S4_MODE || "off";         // off until the roster says otherwise (fail closed for a shadow)
let s4 = null;                                              // stage 4 shadow hub, started with the chainhub below
// Distinct qualifying fill identities seen this interval. Bounded by fills/minute (tens), cleared on
// every flush - it is a COUNT that leaves, never a growing label set.
let fillIds = new Set();
// Which children reported this interval. Stage 4 must be able to tell a COMPLETE interval from a
// PARTIAL one: cc arrives from children over lossy IPC while the denominator is counted here, so a
// silent child biases the multiplier DOWNWARD - the direction that would fake success.
let reporters = new Set();
let metricSeq = 0;
// Distinguishes "the runner restarted" from "an interval went missing": the sequence restarts at 0
// under a new boot id, rather than looking like a gap.
const BOOT_ID = Math.random().toString(36).slice(2, 10);
const isWatchedAddr = (a) => watchedAddrs.has(String(a || "").toLowerCase());
let watchedAddrs = new Set();
const METRICS_MS = Number(process.env.COSMOS_METRICS_MS) || 60_000;

let lastFlushWarn = 0;
function warnFlush(msg) { if (Date.now() - lastFlushWarn < 600_000) return; lastFlushWarn = Date.now(); console.warn(new Date().toISOString(), "[runner] metrics:", msg); }
async function flushMetrics() {
  const m = fleetMetrics;
  fleetMetrics = mEmpty();                       // swap first: a slow POST must not lose the next interval
  m.kids = kids.size;
  m.fills = fillIds.size;                        // distinct qualifying fills: the Stage 4 denominator
  m.reporters = reporters.size;
  m.seq = ++metricSeq;
  m.boot = BOOT_ID;
  m.complete = kids.size > 0 && reporters.size >= kids.size ? 1 : 0;
  fillIds = new Set();
  reporters = new Set();
  if (!m.ev && !m.cc && !m.reap && !m.fills && !m.s4Sent && !m.s4Recv) return;   // nothing happened - do not write a row saying so
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15_000);
  // Build the body first, and never let a bad sample take the counters down with it: the samples
  // are forensics, the counters are the instrument. A failure here is LOGGED (rate-limited) - the
  // 2026-08-29 shadow deploy went dark for 40 minutes behind a silent catch.
  let body;
  try {
    let samples = [];
    try { samples = s4 ? s4.drainSamples(20) : []; JSON.stringify(samples); } catch (e) { samples = []; warnFlush(`samples dropped: ${e.message}`); }
    // ROSTER AUDIT (owner 2026-08-30): what each child currently watches and when it last refreshed,
    // so the server can diff it against the authoritative picks. Bounded: 250 wallets per child.
    const rosters = [...childRoster.entries()].filter(([u]) => kids.has(u)).map(([u, r]) => { const v = rosterMap.get(u), ack = childAck.get(u); return { u, at: r.at, src: r.source, n: r.n, w: r.list, vr: v ? { version: v.v, at: v.at, n: v.w.length, w: v.w.slice(0, 250) } : null, ack: ack || null, dd: childDd.get(u) || null }; });
    // a pushed roster the child never acknowledged within 60 s is an IPC delivery failure - counted
    for (const [u, v] of rosterMap) { if (kids.has(u) && Date.now() - v.at > 60_000 && (childAck.get(u)?.version ?? 0) < v.v) mMerge(fleetMetrics, { rosterAckMiss: 1 }); }
    body = JSON.stringify({ m, window_s: Math.round(METRICS_MS / 1000), host: process.env.FLY_MACHINE_ID || "runner", s4Samples: samples, rosters, epoch: rosterEpoch });
  } catch (e) { warnFlush(`body build failed: ${e.message}`); clearTimeout(t); return; }
  try {
    const r = await fetch(`${API}/api/cloud/runner/metrics`, { method: "POST", headers: { "content-type": "application/json", "x-runner-secret": SECRET }, body, signal: ctl.signal });
    if (!r.ok) warnFlush(`metrics POST ${r.status}`);
  } catch (e) { warnFlush(`metrics POST failed: ${e.message}`); }   // observability must never disturb the fleet; the interval is lost, but not silently
  finally { clearTimeout(t); }
}
if (METRICS_MS > 0) setInterval(() => { flushMetrics().catch(() => {}); }, METRICS_MS).unref?.();

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
// NETWORK LIVENESS (declared early on purpose - the roster fetch calls netOk() during startup,
// long before the watchdog block near the bottom of this file is evaluated).
let lastNetOk = Date.now();
export const netOk = () => { lastNetOk = Date.now(); };

process.on("uncaughtException", (e) => console.error(new Date().toISOString(), "runner uncaught:", e?.stack ?? e));
process.on("unhandledRejection", (e) => console.error(new Date().toISOString(), "runner unhandled rejection:", e?.stack ?? e));
let hubToken = null;
let sigHub = null;
/** userId -> string[] of wallets that child follows (reported over IPC) */
const childWallets = new Map();
/** userId -> { at, source, n, list } of the child's last SUCCESSFUL roster refresh - reported to the server every interval for the roster audit (2026-08-30) */
const childRoster = new Map();
/** VERSIONED ROSTER (shadow): the map pushed to children, keyed by user; and each child's ack. */
let rosterEpoch = null, rosterMap = new Map(), rosterMapAt = 0;
const childAck = new Map();                    // userId -> { version, at }
const childDd = new Map();                     // userId -> drawdown latch state (correctness-fix rollout audit)
async function fetchRosterMap(epoch) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20_000);
  try {
    const r = await fetch(`${API}/api/cloud/runner/roster-map`, { headers: { "x-runner-secret": SECRET }, signal: ctl.signal });
    if (!r.ok) { mMerge(fleetMetrics, { rosterMapErr: 1 }); log(`roster-map HTTP ${r.status} (epoch ${epoch}) - keeping the previous map`); return; }
    const j = await r.json().catch(() => null);
    if (!j?.ready || !Array.isArray(j.users)) { mMerge(fleetMetrics, { rosterMapErr: 1 }); return; }
    rosterMap = new Map(j.users.map((u) => [u.u, { v: Number(u.v) || 1, w: Array.isArray(u.w) ? u.w : [], at: Date.now() }]));
    rosterMapAt = Date.now(); mMerge(fleetMetrics, { rosterMapOk: 1 });
    log(`roster-map: epoch ${j.epoch} · ${rosterMap.size} users · pushing to ${kids.size} children`);
    for (const [userId] of kids) pushRoster(userId);
  } catch (e) { mMerge(fleetMetrics, { rosterMapErr: 1 }); log(`roster-map fetch failed: ${e?.message ?? e}`); }
  finally { clearTimeout(t); }
}
function pushRoster(userId) {
  const k = kids.get(userId), entry = rosterMap.get(userId);
  if (!k?.child || !entry) return;
  try { k.child.send({ t: "roster", list: entry.w, version: entry.v, epoch: rosterEpoch, at: entry.at }); mMerge(fleetMetrics, { rosterPush: 1 }); } catch { /* child gone */ }
}
let hub = null;
let sealWorker = null;
function syncHubWallets() {
  if (!hub) return;
  const union = [...childWallets.values()].flat();
  watchedAddrs = new Set(union.map((w) => String(w || "").toLowerCase()));
  hub.setWallets(union);
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
    netOk();   // ANY http answer proves our sockets work - the wedge watchdog only fires on silence
    if (!r.ok) { log(`roster HTTP ${r.status}`); return null; }
    const j = await r.json().catch(() => null);
    if (typeof j?.s4_mode === "string" && j.s4_mode !== s4Mode) { log(`s4 mode ${s4Mode} -> ${j.s4_mode} (roster)`); s4Mode = j.s4_mode; }
    // VERSIONED ROSTER (owner 2026-08-30, shadow): the fleet epoch rides on every roster poll; a change
    // triggers ONE map fetch and a push to every child. No per-fill, no per-child network reads.
    if (j && j.roster_epoch !== null && Number.isFinite(Number(j.roster_epoch))) { const e = Number(j.roster_epoch); if (e !== rosterEpoch) { rosterEpoch = e; fetchRosterMap(e).catch(() => {}); } }
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
    if (m?.t === "wallets" && Array.isArray(m.list)) { childWallets.set(a.user_id, m.list); childRoster.set(a.user_id, { at: Number(m.at) || Date.now(), source: m.source || null, n: m.list.length, list: m.list.slice(0, 250) }); syncHubWallets(); if (!childAck.has(a.user_id)) pushRoster(a.user_id); }
    // a child's single counter increment (roster refresh outcomes); merge() drops unknown keys
    else if (m?.t === "metric" && typeof m.k === "string") { mMerge(fleetMetrics, { [m.k]: 1 }); }
    else if (m?.t === "roster-ack") { childAck.set(a.user_id, { version: Number(m.version) || 0, at: Number(m.at) || Date.now() }); mMerge(fleetMetrics, { rosterAck: 1 }); }
    else if (m?.t === "dd") { childDd.set(a.user_id, { halt: m.halt === true, reason: String(m.reason || "").slice(0, 80), portfolio: Number(m.portfolio) || 0, high: Number(m.high) || 0, trippedHigh: Number(m.trippedHigh) || 0, trippedAt: Number(m.trippedAt) || 0, migration: m.migration ? { kind: m.migration.kind, reason: String(m.migration.reason || "").slice(0, 80), at: m.migration.at } : null, at: Date.now() }); }
    // STAGE 1: a child's counter DELTA for the last interval. Merged in memory; nothing is written
    // per message. merge() drops unknown keys, so one misbehaving child cannot inflate cardinality.
    else if (m?.t === "metrics" && m.m) { mMerge(fleetMetrics, m.m); reporters.add(a.user_id); }
    // STAGE 4 SHADOW: a child saw a sequence gap and asks for the ring; or forwards a bounded sample.
    else if (m?.t === "s4gap" && s4) { s4.replay(child, Number(m.from) || 0, Number(m.to) || 0); }
    else if (m?.t === "s4sample" && s4 && m.s) { s4.sample({ ...m.s, user: String(a.user_id).slice(0, 8) }); }
  });
  const rec = { child, startedAt: Date.now(), backoffMs: kids.get(a.user_id)?.backoffMs ?? 30_000, entry: a };
  child.on("exit", (code, sig) => {
    const uptimeS = Math.round((Date.now() - rec.startedAt) / 1000);
    log(`bot ${tag} exited code=${code} sig=${sig} uptime=${uptimeS}s`);
    noteChildExit(uptimeS);
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
  childRoster.delete(userId); childAck.delete(userId); childDd.delete(userId);
  if (childWallets.delete(userId)) syncHubWallets();
  if (rec.child) {
    log(`stopping bot ${userId.slice(0, 8)} - ${why}`);
    rec.child.kill("SIGTERM");
    const c = rec.child;
    setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* already gone */ } }, 10_000).unref();
  }
}

function uptimeSeconds() {
  try { return Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) || 0; } catch { return 0; }
}

const ORPHAN_MIN_AGE_S = Number(process.env.COSMOS_ORPHAN_MIN_AGE_S) || 120;

// ---- ORPHAN REAPER (2026-08-27) ----------------------------------------------------------------
// MEASURED: four bot.mjs processes were running with ppid 1 while 103 healthy children carried the
// live runner's pid. They were burning 40-42% of a core EACH - 82% of a two-core box - against a
// median healthy bot of 0.28%, and their users each had a second, supervised process. Two bots on
// one wallet produced 147 duplicate order pairs (no double-fill; the signature cap and FAK held).
//
// HOW THEY SURVIVE: stop() sends SIGTERM and schedules SIGKILL on an .unref()'d timer. An unref'd
// timer does not hold the event loop open, so if the runner exits inside that 10s grace window the
// SIGKILL never fires. The child - stuck in a loop that never yields, which is why it ignored both
// SIGTERM and the IPC 'disconnect' - is then reparented to init, and stop()'s `if (!rec) return`
// guarantees no future runner will ever look at it again.
//
// WHY ppid === 1 IS THE TEST: this box runs exactly one runner, and children are spawn()ed directly
// (no double-fork), so every legitimate child carries the runner's pid as its parent. Reparenting to
// init happens only when the supervisor died. Deliberately NOT "ppid !== my pid": that would also
// match a second runner's children if the topology ever grows, and killing another supervisor's
// bots is a far worse failure than leaving an orphan alive one more pass.
//
// Linux-only and best-effort by construction: no /proc, or any read failure, means reap nothing.
// COSMOS_NO_ORPHAN_REAP=1 disables it without a deploy.
function reapOrphans() {
  if (/^(1|true|yes|on)$/i.test(process.env.COSMOS_NO_ORPHAN_REAP || "")) return 0;
  let killed = 0;
  try {
    if (!existsSync("/proc")) return 0;                  // not Linux - nothing to scan
    const me = process.pid;
    const nowUp = uptimeSeconds();                       // read ONCE: a per-process read would let
    if (!(nowUp > 0)) return 0;                          // the age cutoff drift mid-scan
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === me || pid === 1) continue;
      let cmd = "", stat = "";
      try {
        cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      } catch { continue; }                                  // vanished mid-scan, or not ours to read
      // Match what the runner actually spawns - argv[0] a node binary, argv[1] the bot entrypoint -
      // rather than "the string bot.mjs appears somewhere". A command line like
      // `grep -r bot.mjs /app/repo/src/` contains it too, and this function sends SIGKILL.
      const argv = cmd.split("\0").filter(Boolean);
      if (argv.length < 2) continue;
      if (!/(^|\/)node(\.exe)?$/.test(argv[0]) && !argv[0].includes("node")) continue;
      if (!argv.slice(1).some((a) => a.endsWith("/bot.mjs") || a === "bot.mjs")) continue;
      const info = parseProcStat(stat);
      if (!info || info.ppid !== 1) continue;                // supervised by someone - leave it
      // AGE GUARD: a genuine orphan is old by definition - it outlived its supervisor. Refusing to
      // touch anything young removes every startup race in one line, at the cost of one extra pass.
      const ageS = nowUp - info.startTimeS;
      if (!(ageS > ORPHAN_MIN_AGE_S)) continue;
      try {
        process.kill(pid, "SIGKILL");
        killed++; fleetMetrics.reap = (fleetMetrics.reap || 0) + 1;
        log(`ORPHAN REAPED pid ${pid} (bot.mjs, ppid 1 - its supervisor died and left it running)`);
      } catch (e) {
        log(`orphan pid ${pid} could not be killed: ${e.code || e.message}`);
      }
    }
  } catch (e) {
    log(`orphan reap skipped: ${e.message}`);                // never let this break a reconcile pass
  }
  return killed;
}

async function reconcile() {
  reapOrphans();                                     // before roster(): a wedged box must recover even if the API is down
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
      onLog: (l) => {
        // THE MULTIPLIER'S DENOMINATOR. The hub receives each on-chain fill ONCE and fans it to
        // every child. sum(cc) across children divided by this is the events x bots multiplier the
        // audit inferred at ~96.6x. Counting it here rather than in a child is the whole point:
        // a child can only ever see its own copy.
        fleetMetrics.hubEv = (fleetMetrics.hubEv || 0) + 1;      // raw logs - operational, NOT the denominator
        // THE STAGE 4 DENOMINATOR. Distinct QUALIFYING FILLS, which is the unit that produces one
        // copy-check each. One TransferBatch log carries several, so counting logs would understate
        // fan-out. Uses the same parser chainwatch uses, so numerator and denominator cannot diverge.
        for (const id of qualifyingFillIds(l, isWatchedAddr)) fillIds.add(id);
        // STAGE 4 SHADOW: one evaluation per fill, broadcast as a neutral result AFTER the raw log below.
        // Children compare it with their own copy-check; nothing acts on it (s4-child.mjs).
        if (s4) { try { s4.onFills(fillsFromLog(l, isWatchedAddr)); } catch (e) { console.warn("s4 hub:", e.message); } }
        broadcast({ t: "log", log: l });
      },
      onBeat: () => broadcast({ t: "beat" }),
      log: (...a) => console.log(new Date().toISOString(), ...a),
      warn: (...a) => console.warn(new Date().toISOString(), ...a),
    });
    const inc = (k, n = 1) => { fleetMetrics[k] = (fleetMetrics[k] || 0) + (Number(n) || 1); };
    // how many children follow a wallet: the legacy copy-checks a fallback of one of its fills would cost
    const followers = (wallet) => { const w = String(wallet || "").toLowerCase(); let n = 0; for (const list of childWallets.values()) if (list.includes(w)) n++; return n; };
    s4 = startS4Hub({ api: API, secret: SECRET, broadcast, log, mode: () => s4Mode, sealable: () => (hub ? hub.sealable() : 0), gapOpen: () => Boolean(hub && hub.cursor().gapOpen), followers, inc });
    log(`s4 shadow hub up · mode ${s4Mode} · boot ${s4.boot}`);
    // BLOCK-RECONCILIATION SEAL (owner-approved 2026-08-30): sealing is driven by cursor advancement, never by another fill
    const { startSealWorker } = await import("./s4-seal.mjs");
    sealWorker = startSealWorker({ api: API, secret: SECRET, hub, s4, log, inc, isWatched: isWatchedAddr });
    setInterval(() => {
      const s = hub.stats();
      log(`chainhub: ${s.connected ? "connected" : "DISCONNECTED"} · ${s.wallets} wallets · ${s.delivered} logs delivered · ${kids.size} children`);
      if (s4) { const x = s4.stats(); const w = sealWorker ? sealWorker.stats() : null; log(`s4 hub: mode ${x.mode} · seq ${x.seq} · queued ${x.queued} · inflight ${x.inflight} · hung ${x.hung} · ring ${x.ring} · sealable ${x.sealable}${w ? ` · sealed through ${w.lastSealed} (behind ${w.behind}${w.pendingBlock ? `, pending ${w.pendingBlock} x${w.attempts}` : ""})` : ""}${x.breaker ? " · BREAKER" : ""}`); if (w && w.lastSealed > 0 && w.behind > 0) fleetMetrics.s4ReconPending = w.behind; }
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

// SELF-HEAL EXITS (fleet crash + network wedge, 2026-08-21/22). Two failure shapes proved that a
// LIVE runner can preside over a dead fleet forever, because the launcher only reinstalls/restarts
// when the RUNNER process dies:
//   1. broken dependency tree: every child exits within seconds of boot, the runner keeps
//      respawning them into the same wall - it must exit so the launcher re-runs the verified
//      install;
//   2. exhausted sockets after a thrash: 98 children alive with every network call failing
//      instantly for half an hour - processes must be recycled to get fresh descriptors.
// Both paths exit THROUGH dieClean so children are stopped first: the launcher swaps node_modules
// right after the runner dies, and an orphan reading a half-written tree is exactly how the first
// crash spread. Children also self-exit on IPC disconnect as a belt-and-braces (bot.mjs).
function dieClean(reason) {
  log(`SELF-HEAL EXIT: ${reason} - stopping ${kids.size} bots, launcher will reinstall+restart`);
  for (const userId of [...kids.keys()]) stop(userId, "self-heal restart");
  setTimeout(() => process.exit(1), 11_500);   // > the 10s SIGKILL fallback in stop()
}

// crash-storm detector: N children dying young in a short window = the TREE is broken, not a bot.
let quickDeaths = 0, quickDeathsResetAt = 0;
export function noteChildExit(uptimeS) {
  const now = Date.now();
  if (now > quickDeathsResetAt) { quickDeaths = 0; quickDeathsResetAt = now + 2 * 60_000; }
  if (uptimeS < 10) {
    quickDeaths++;
    if (quickDeaths >= 6) dieClean(`${quickDeaths} children died within seconds in under 2 minutes (broken tree?)`);
  } else if (uptimeS > 60) {
    quickDeaths = 0;   // a healthy child disproves the broken-tree theory
  }
}

// network-wedge watchdog: the timer lives here, but lastNetOk/netOk are declared at the TOP of the
// file (2026-08-23 fix). `const netOk = ...` in TDZ meant the FIRST roster fetch - which runs long
// before this line is evaluated - threw "Cannot access 'netOk' before initialization", so the
// runner could never fetch its roster and the whole fleet sat dark. A watchdog must never be able
// to break the thing it watches.
setInterval(() => {
  if (Date.now() - lastNetOk > 10 * 60_000) dieClean("no successful API call in 10 minutes (socket wedge?)");
}, 60_000).unref();
