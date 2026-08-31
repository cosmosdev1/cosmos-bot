// chainwatch.mjs — REAL-TIME whale detection, straight off the Polygon chain (owner 2026-07-14).
//
// WHY THIS EXISTS. The copy feed used to be built from Polymarket's activity indexer, and that indexer
// is ~360 SECONDS behind reality. Measured, not guessed: bbwlover bought a 5-minute BTC candle at
// 10:33:20 with 100s of runway left; our engine only saw it at 10:39:21 and emitted a signal FOUR
// MINUTES AFTER the market had closed — on the losing leg. No amount of tuning fixes late data.
//
// The chain doesn't lag. When a whale's order fills, the ConditionalTokens ERC-1155 contract emits a
// TransferSingle putting the outcome tokens in his wallet, and that log is in the block (~2s). We
// subscribe to exactly those logs, filtered to our whale addresses, and act on them:
//
//   his fill lands in a block  ->  we get the log pushed (~1-2s)
//   -> token_id -> /api/v1/copy-check (server applies EVERY rule: new-only, category, runway,
//      pair cost, entry band, and upserts the signal)          (~200ms)
//   -> the bot buys                                            (<1s from trigger)
//
// The cron feed keeps running underneath as the slow, authoritative path (money-in, peak shares,
// mirror exits, the ledger). This just gets us there ~6 minutes earlier. The bot's own buy-once-ever
// map means a signal arriving twice (fast + slow) can still only ever open a position once.
import { log, warn } from "./log.mjs";

const WSImpl = globalThis.WebSocket ?? (await import("ws")).WebSocket;

const CTF_ERC1155 = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
// TransferSingle(operator, from, to, id, value) / TransferBatch(operator, from, to, ids[], values[])
const T_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
const T_BATCH = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";

const WSS = (process.env.COSMOS_WSS_URLS || "wss://polygon-bor-rpc.publicnode.com,wss://polygon.drpc.org")
  .split(",").map((s) => s.trim()).filter(Boolean);
// HTTP twin of the socket, used to BACKFILL the gap around a reconnect (see below).
const HTTP = (process.env.COSMOS_RPC_URL || "https://polygon-bor-rpc.publicnode.com,https://polygon.drpc.org")
  .split(",").map((s) => s.trim()).filter(Boolean);
const WALLET_REFRESH_MS = 5 * 60_000;
// Set ONLY by the hosted runner (src/runner.mjs). Self-hosted bots never see it, so their
// behaviour is bit-for-bit what it was: their own socket, their own subscription.
import { inc, observe } from "./metrics.mjs";
import { tokensFromLog } from "./fills.mjs";
import { startS4Child } from "./s4-child.mjs";
import * as authority from "./s4-authority.mjs";
const HUB = process.env.COSMOS_CHAINHUB === "1" && typeof process.send === "function";

async function rpc(method, params) {
  for (const url of HTTP) {
    try {
      const r = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(8000),
      }).then((x) => x.json());
      if (r?.result !== undefined) return r.result;
    } catch { /* next endpoint */ }
  }
  return null;
}

const pad32 = (addr) => "0x" + addr.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const words = (hex) => (hex.replace(/^0x/, "").match(/.{64}/g) ?? []);

// tokensFromLog now lives in ./fills.mjs so the runner's denominator and this parser cannot drift.

// Start the watcher. `onSignal(signal, meta)` gets a fully vetted signal from the server; the caller
// executes it with the same guards + sizing as the polled feed.
export function startChainWatch({ cosmos, onSignal, isArmed, s4Ctx }) {
  // STAGE 4 SHADOW: pairs this child's own copy-check answer with the hub's neutral result and
  // counts the discrepancy class. Observational only - it has no path to onSignal.
  const s4 = startS4Child({ inc, log, warn, send: (m) => { try { process.send?.(m); } catch { /* not under the runner */ } },
    ctx: (wallet, neutral) => {
      const base = typeof s4Ctx === "function" ? s4Ctx() : {};
      const mem = Array.isArray(neutral?.WHALE_TRACK_MEMBERSHIPS) ? neutral.WHALE_TRACK_MEMBERSHIPS : [];
      // EXECUTION MODE COMES FROM THE SERVER (owner 2026-08-31). The local signer flag decides how this
      // process SIGNS; it does not decide business semantics like the 2-day vs 7-day horizon. The
      // authoritative answer rides on the versioned roster; while that is missing or stale the child
      // falls back to SELF, which is the conservative side - a stale child can never widen a horizon.
      // NEVER INFER SELF FROM MISSING STATE (owner's rule, applied here too). Coercing an unknown or
      // expired mode to `self` narrowed the horizon and produced FALSE hosted/horizon contradictions -
      // a comparison cannot be made at all without knowing which semantics apply, so it is skipped
      // rather than decided wrongly. The execution path is separately gated by canaryAuthorized.
      const fresh = versioned && Date.now() - (versioned.receivedAt || 0) <= ROSTER_MAX_STALE_MS;
      const modeKnown = Boolean(fresh) && typeof versioned.hosted === "boolean";
      return { copytrade: base.copytrade === true, followsWallet: byAddr.has(String(wallet || "").toLowerCase()), diamondBlocked: false,
        modeKnown, hosted: modeKnown ? versioned.hosted : null, hostedSource: modeKnown ? "server" : "unknown",
        v2: base.v2 === true, group: base.group ?? (mem.find((g) => g < 1000) ?? mem[0] ?? 1) };
    } });
  let wallets = [];          // [{wallet, username}]
  let byAddr = new Map();
  let lastRosterAt = 0;                                  // the last SUCCESSFUL roster refresh (0 = never)
  let versioned = null;                                  // { list, version, epoch, at, receivedAt } pushed by the runner (shadow)
  const rosterMetric = (k) => { try { process.send?.({ t: "metric", k }); } catch { /* parent gone */ } };
  let ws = null, sub = null, urlIx = 0, alive = false, seenCount = 0, lastBlock = 0;
  const done = new Set();    // txHash#logIndex — a reconnect can replay logs; never act twice

  async function refreshWallets() {
    try {
      const r = await cosmos.copyWallets();
      const list = (r?.wallets ?? []).filter((w) => /^0x[a-f0-9]{40}$/.test(w.wallet));
      const changed = list.length !== wallets.length || list.some((w, i) => w.wallet !== wallets[i]?.wallet);
      wallets = list;
      byAddr = new Map(list.map((w) => [w.wallet, w]));
      // In hub mode the PARENT owns the socket, so it needs our wallet set to build the union it
      // subscribes to. Reported on every refresh; the hub debounces and only re-subscribes on a
      // real change.
      lastRosterAt = Date.now(); rosterMetric("rosterOk");
      if (HUB) { try { process.send?.({ t: "wallets", list: list.map((w) => w.wallet), at: lastRosterAt, source: r?.source || null }); } catch { /* parent gone; watchdog covers */ } }
      return changed;
    } catch (e) { warn("chainwatch wallets:", e.message); rosterMetric("rosterErr"); return false; }
  }

  // A whale's position just grew. Ask the server whether we may copy it — every rule lives there.
  // BOUNDED RETRY (owner 2026-07-19, "never miss an event"): a transient copy-check failure (network
  // blip, cold start, 5xx) used to DROP the fill from the fast path entirely — the cron's slow path
  // would re-find it ~6min later, which on a pre-game window entry can be the whole edge. Retry the
  // check up to 3 times with backoff; a real REFUSAL (res.ok === false) is final, not retried.
  //
  // STORM BREAKER (DB-saturation 2026-08-07). When the SERVER is the thing failing, 34 bots each
  // retrying 3x within ~1.2s is the documented self-amplifying collapse: slow DB -> timeouts ->
  // triple the requests -> slower DB. Two changes, both bot-side so no fill is ever lost:
  //   * backoff is 1.5s/6s (not 400/800ms) — a recovering server sees a trickle, not a volley;
  //   * after 3 consecutive FAILED checks (errors, not refusals) the fast path stands down for
  //     60s and lets the cron's slow path carry — it re-finds every fill ~6min later anyway.
  let checkFails = 0, standdownUntil = 0;
  // DETERMINISTIC STAGGER (2026-08-23). One whale fill fans out to EVERY bot that follows him, and
  // each child calls /copy-check independently: after the 12-whale base roster that went from ~30
  // concurrent calls per fill to ~103, all landing inside the same second. The server work is
  // already memoised (book 2s, market 3s, wallet row cached) - the cost was pure QUEUEING, and
  // measured vet latency went from ~4s to a p50 of 43s and p90 of 69s, which silently breaks the
  // crypto fast path the owner just prioritised.
  // Spreading the same calls over ~2.5s cuts peak concurrency by an order of magnitude while adding
  // at most 2.5s to any one fill. The offset is a hash of THIS bot's identity, not random: stable
  // across restarts, evenly spread across the fleet, and never re-orders the same bot against
  // itself. Candles keep the front of the window - they are the latency-critical class.
  const selfTag = String(process.env.COSMOS_USER_ID || process.env.COSMOS_BOT_TAG || Math.random());
  let h = 0; for (let i = 0; i < selfTag.length; i++) h = (h * 31 + selfTag.charCodeAt(i)) >>> 0;
  const STAGGER_MS = Number(process.env.COSMOS_CHECK_STAGGER_MS) || 2_500;
  const myOffset = STAGGER_MS ? h % STAGGER_MS : 0;

  // CANARY EXECUTION (owner 2026-08-30). For a whale on the canary list this child ACTS on the
  // shared Stage 4 evaluation instead of its own copy-check answer. The old path still runs - it
  // writes the production rows the exit ladder needs and it is the comparison - but it no longer
  // decides. Three safety properties, in order:
  //   * the wait is BOUNDED: no answer in S4_WAIT_MS -> the old path decides, so a hub outage can
  //     never cost a fill (counted s4CanaryFallback);
  //   * the versioned roster must be fresh and must contain this whale, or Stage 4 authority is
  //     refused for that fill (counted s4CanaryBlocked) - ownership is never taken on trust;
  //   * removing the wallet from the list reverts that whale within one roster cycle, no deploy.
  const S4_WAIT_MS = Number(process.env.COSMOS_S4_CANARY_WAIT_MS) || 4_000;
  const ROSTER_MAX_STALE_MS = Number(process.env.COSMOS_S4_CANARY_ROSTER_STALE_MS) || 300_000;
  function canaryAuthorized(wallet) {
    const v = versioned;
    if (!v || !Array.isArray(v.list)) return { ok: false, why: "no versioned roster yet", code: "roster-unavailable" };
    if (Date.now() - (v.receivedAt || 0) > ROSTER_MAX_STALE_MS) return { ok: false, why: `versioned roster stale ${Math.round((Date.now() - (v.receivedAt || 0)) / 1000)}s`, code: "roster-stale" };
    if (!v.list.includes(String(wallet || "").toLowerCase())) return { ok: false, why: "whale not on this account's versioned roster", code: "not-on-roster" };
    // NO AUTHORITATIVE EXECUTION MODE => STAGE 4 IS UNAVAILABLE, NOT CONSERVATIVE (owner 2026-08-31).
    // Falling back to SELF narrows the horizon, which is safe for sizing but REFUSES markets the
    // production route approves - three of those became "missed qualifying signal" and reverted the
    // canary at 12:24Z. An unknown mode is an availability event: the old path decides, as it does for
    // any other fill Stage 4 cannot answer.
    if (typeof v.hosted !== "boolean") return { ok: false, why: "no authoritative execution mode yet", code: "no-mode" };
    return { ok: true };
  }

  async function onFill(w, tokenId, shares, l, fillId) {
    // STAGE 1: the two terms of the fan-out multiplier, counted at the only place both are visible.
    // "ev" is one whale fill THIS child was handed; "cc" is a copy-check actually issued for it.
    // Fleet-wide, sum(cc) / distinct(ev) is the events x bots multiplier the audit put at ~96.6x and
    // Stage 4 must drive toward ~1x. Counted before the standdown return so a struggling server
    // shows as ev >> cc rather than as a silent hole in both.
    inc("ev");
    if (Date.now() < standdownUntil) { if (fillId) s4.recordOld(fillId, { ok: false, reason: "stand-down", wallet: w.wallet }); return; }   // server is struggling - slow path covers this fill; recorded so the shadow does not count it as missing
    const t0 = Date.now();
    if (myOffset) await new Promise((r) => setTimeout(r, myOffset));
    // the old path, unchanged: it answers, it records the comparison, and it writes the production rows
    const runOldCheck = async () => {
      for (let a = 0; ; a++) {
        try { inc("cc"); const r = await cosmos.copyCheck({ wallet: w.wallet, token_id: tokenId, shares }); checkFails = 0; observe(Date.now() - t0);
          if (fillId) s4.recordOld(fillId, { ok: Boolean(r?.ok), reason: r?.reason ?? null, signal: r?.ok ? r.signal : null, wallet: w.wallet });
          return r; }
        catch (e) {
          if (a >= 2) {
            inc("ccFail");
            if (fillId) s4.recordOld(fillId, { ok: false, reason: "copy-check failed", wallet: w.wallet });
            if (++checkFails >= 3) { standdownUntil = Date.now() + 60_000; warn("chainwatch: 3 checks failed in a row - fast path stands down 60s (slow path covers)"); }
            else warn(`chainwatch check failed ${a + 1}x (giving up; slow path covers):`, e.message);
            return null;
          }
          await new Promise((r) => setTimeout(r, 1500 * Math.pow(4, a)));
        }
      }
    };
    let res = null, source = "old";
    if (fillId && s4.isCanary(w.wallet)) {
      const auth = canaryAuthorized(w.wallet);
      const old = runOldCheck();                                   // runs in parallel: rows + comparison
      old.catch(() => {});
      if (!auth.ok) {
        // WHY Stage 4 was unavailable, not just that it was: the owner's gate reports degraded-mode
        // fallbacks by cause, and an unexpectedly high rate in ONE cause is a rollout-quality signal.
        inc("s4CanaryBlocked");
        inc(auth.code === "no-mode" ? "s4CanaryNoMode" : auth.code === "roster-stale" ? "s4CanaryStaleRoster" : auth.code === "not-on-roster" ? "s4CanaryNotOnRoster" : "s4CanaryNoRoster");
        warn(`chainwatch: STAGE 4 authority refused for ${w.username} (${auth.why}) - old path decides`);
        res = await old;
      }
      else {
        const a = await s4.awaitAnswer(fillId, w.wallet, S4_WAIT_MS);
        if (a) { res = a; source = "s4"; inc("s4CanaryAct"); old.then((o) => { if (o) inc(Boolean(o.ok) === Boolean(a.ok) ? "s4CanaryAgree" : "s4CanaryDiffer"); }).catch(() => {}); }
        else { inc("s4CanaryFallback"); res = await old; }
      }
      // EXACTLY ONE EXECUTION AUTHORITY (owner 2026-08-30). This path has now decided the market for
      // this whale - buy or no buy, Stage 4 or its bounded-wait fallback - so the polled/adopt tick,
      // which would otherwise reach the same buy off the row the old /copy-check just wrote, defers.
      // Marked for BOTH outcomes: "no buy" is a decision, and it is the case where the old row would
      // have made the polled tick buy something Stage 4 refused.
      // The marker carries the STATE the production row will show after this decision, so it protects
      // THIS business event and nothing else: a later fill grows the row past it and the polled sweep
      // is free again (that is how a fill this path misses is still recovered).
      { const n = s4.lastNeutral?.(fillId);
        const track = (n?.tracks || []).find((t) => t?.ledger?.row || t?.old?.row);
        const cid = res?.signal?.condition_id ?? n?.conditionId ?? null;
        const outcome = res?.signal?.outcome ?? n?.outcome ?? null;
        if (cid && outcome) {
          authority.markDecided(cid, outcome, w.wallet, authority.stateOf(res?.signal) || authority.stateOf(track?.ledger?.row) || authority.stateOf(track?.old?.row) || {});
          // the OLD path's own answer is what the polled tick will actually see in the row; when it
          // lands (it may be seconds later, or never) the marker ratchets up to it
          old.then((o) => { if (o?.ok && o.signal) authority.markDecided(cid, outcome, w.wallet, authority.stateOf(o.signal)); }).catch(() => {});
        } }
    } else {
      res = await runOldCheck();
    }
    if (!res) return;                                              // the old path gave up; the slow path covers
    const ms = Date.now() - t0;
    if (!res?.ok) {
      log(`chainwatch: ${w.username} +${shares.toFixed(0)} sh -> SKIP (${res?.reason ?? "no"}) · ${ms}ms${source === "s4" ? " · STAGE 4" : ""}`);
      return;
    }
    const s = res.signal;
    log(`chainwatch: ${w.username} +${shares.toFixed(0)} sh -> ${s.outcome} @${s.entry_cents}c${s.is_pair ? " [PAIR]" : ""} · vetted in ${ms}ms${source === "s4" ? " · STAGE 4 AUTHORITY" : ""} · ${String(s.market_question).slice(0, 40)}`);
    try { await onSignal(s, { wallet: w, shares, block: l.blockNumber, s4: source === "s4", fillId }); }
    catch (e) { warn("chainwatch buy:", e.message); }
  }

  // SPLIT FILTER (deep-check #3). A CTF PositionSplit MINTS both outcome tokens to the whale in one tx
  // ($1 -> Up + Down). That is NOT a market buy — he paid exactly $1 for the pair and expressed no
  // direction, but each minted leg fired onFill and (with the pair gate relaxed) we bought BOTH legs at
  // the ask: 53c + 53c = 106c for a $1 redemption, a guaranteed -6c on every split he does. A split
  // delivers BOTH complements with EQUAL share counts in one tx; a real fill (even a mint-matched one)
  // delivers only ONE token to him. So buffer a tx's transfers for a beat and drop the equal-sized
  // multi-token deliveries. Costs ~350ms of latency on ~2-3s total — cheap for never buying a non-trade.
  const txBuf = new Map(); // `${tx}|${wallet}` -> { w, l, fills, timer }
  function flushFills(e) {
    const { w, l, fills } = e;
    if (fills.length >= 2) {
      const shs = fills.map((f) => f.shares);
      const distinct = new Set(fills.map((f) => f.tokenId)).size >= 2;
      const equal = Math.max(...shs) - Math.min(...shs) <= Math.max(...shs) * 0.01;
      if (distinct && equal) { log(`chainwatch: ${w.username} SPLIT mint (${fills.length} legs × ${shs[0].toFixed(0)} sh) — not a trade, skipped`); return; }
    }
    for (const f of fills) { seenCount++; onFill(w, f.tokenId, f.shares, l, f.fillId); }   // fire-and-forget: never block the socket
  }
  function handle(l) {
    const key = `${l.transactionHash}#${l.logIndex}`;
    if (done.has(key)) return;
    done.add(key);
    if (done.size > 5000) done.clear();
    const b = parseInt(l.blockNumber, 16);
    if (Number.isFinite(b) && b > lastBlock) lastBlock = b;    // how far we have actually seen
    const to = "0x" + String(l.topics[3] ?? "").slice(-40).toLowerCase();
    const w = byAddr.get(to);
    if (!w) return;                                   // not one of ours (shouldn't happen: the node filters)
    const from = "0x" + String(l.topics[2] ?? "").slice(-40).toLowerCase();
    if (byAddr.has(from)) return;                      // whale-to-whale shuffle, not a new position
    const k = `${l.transactionHash}|${w.wallet}`;
    let e = txBuf.get(k);
    if (!e) { e = { w, l, fills: [], timer: setTimeout(() => { txBuf.delete(k); flushFills(e); }, 350) }; txBuf.set(k, e); }
    // STAGE 4: the fill id uses the index into tokensFromLog (same rule as the hub's qualifyingFillIds)
    tokensFromLog(l).forEach(({ tokenId, shares }, i) => { if (shares > 0) e.fills.push({ tokenId, shares, fillId: `${l.transactionHash}#${l.logIndex}#${i}` }); });
  }

  // BACKFILL THE RECONNECT GAP. A subscription only pushes what happens while you are listening, and
  // the public nodes drop the socket every couple of minutes (observed live). Those seconds are exactly
  // when a whale fill would be lost — silently, with no error anywhere. So on every (re)subscribe we
  // replay the logs from the last block we actually saw. handle()'s tx#logIndex dedupe makes a replayed
  // fill a no-op, and buy-once-ever backstops it again at the order layer.
  // The FREE Polygon RPCs only serve eth_getLogs over a SHORT recent window — ask for more and they
  // answer "Archive requests require a personal token" (publicnode) or reject the range (drpc). A
  // too-greedy backfill therefore errors and recovers NOTHING, silently, which is worse than not
  // trying. So: walk the gap in small chunks, and say out loud when a gap is too old to recover.
  // MEASURED, not assumed: publicnode serves eth_getLogs only for roughly the last 100 blocks and calls
  // anything older an "archive request" (4 of 5 chunks refused at 400 blocks back). drpc rejects the
  // range outright. A reconnect gap is normally seconds, so ~100 blocks (3.5 min) covers the real case;
  // a longer outage simply cannot be recovered on a free node, and we SAY so rather than pretend.
  // A paid RPC (COSMOS_RPC_URL / COSMOS_WSS_URLS) removes this limit entirely.
  const CHUNK = 100;
  const MAX_GAP = Number(process.env.COPY_BACKFILL_BLOCKS) || 100;
  async function backfill() {
    const head = parseInt(await rpc("eth_blockNumber", []) ?? "0x0", 16);
    if (!Number.isFinite(head) || head <= 0) return;
    if (!lastBlock) { lastBlock = head; return; }                 // first connect: start from now
    let from = lastBlock + 1;
    if (from > head) return;
    if (head - from > MAX_GAP) {
      warn(`chainwatch: gap of ${head - from} blocks is beyond what a free RPC will serve — ${head - from - MAX_GAP} blocks NOT recovered`);
      from = head - MAX_GAP;
    }
    let found = 0;
    for (let a = from; a <= head; a += CHUNK) {
      const b = Math.min(a + CHUNK - 1, head);
      const logs = await rpc("eth_getLogs", [{
        address: CTF_ERC1155,
        fromBlock: "0x" + a.toString(16),
        toBlock: "0x" + b.toString(16),
        topics: [[T_SINGLE, T_BATCH], null, null, wallets.map((w) => pad32(w.wallet))],
      }]);
      if (!Array.isArray(logs)) { warn(`chainwatch: backfill ${a}-${b} failed (rpc refused) — those blocks are unchecked`); continue; }
      found += logs.length;
      for (const l of logs) { try { handle(l); } catch { /* keep going */ } }
    }
    if (found) log(`chainwatch: backfilled ${found} fill(s) missed across blocks ${from}-${head}`);
    lastBlock = head;
  }

  function connect() {
    if (!wallets.length) return;
    const url = WSS[urlIx % WSS.length];
    urlIx++;
    let socket;
    try { socket = new WSImpl(url); } catch (e) { warn("chainwatch ws:", e.message); return setTimeout(connect, 5000); }
    ws = socket;
    let pinger = null;

    let confirm = null;
    socket.onopen = () => {
      alive = true;
      const params = [
        "logs",
        { address: CTF_ERC1155, topics: [[T_SINGLE, T_BATCH], null, null, wallets.map((w) => pad32(w.wallet))] },
      ];
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params }));
      // A CONNECTED SOCKET WITH NO SUBSCRIPTION IS THE WORST FAILURE MODE: it looks perfectly healthy
      // and copies nothing, forever. The public nodes DO intermittently answer eth_subscribe with
      // "Internal error" (seen live). So: if the subscription isn't confirmed, tear the socket down and
      // reconnect — which rotates to the next endpoint.
      confirm = setTimeout(() => {
        if (!sub) { warn("chainwatch: no subscription confirmed in 10s — reconnecting"); try { socket.close(); } catch { /* onclose reconnects */ } }
      }, 10_000);
      pinger = setInterval(() => { try { socket.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "net_version", params: [] })); } catch { /* closing */ } }, 30_000);
    };
    socket.onmessage = (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); } catch { return; }
      if (m.id === 1) {
        if (m.result) {
          sub = m.result;
          if (confirm) clearTimeout(confirm);
          log(`chainwatch: LIVE — watching ${wallets.length} wallets on-chain via ${url.replace("wss://", "")}`);
          backfill();                                   // cover the blocks we were disconnected for
        } else {
          warn("chainwatch subscribe rejected:", JSON.stringify(m.error ?? {}).slice(0, 80));
          try { socket.close(); } catch { /* onclose reconnects on the next endpoint */ }
        }
        return;
      }
      if (m.method === "eth_subscription" && m.params?.result) { try { handle(m.params.result); } catch (e) { warn("chainwatch handle:", e.message); } }
    };
    const down = () => {
      if (pinger) clearInterval(pinger);
      if (!alive) return;
      alive = false; sub = null;
      warn("chainwatch: socket down, reconnecting…");
      setTimeout(connect, 3000);                       // next URL in the list — survives one node dying
    };
    socket.onclose = down;
    socket.onerror = down;
  }

  // HUB MODE (Inc 1.5). The runner sets COSMOS_CHAINHUB=1 and keeps ONE socket for the whole
  // machine, forwarding every matching log over IPC. We then open no socket of our own - which is
  // the entire point: ~90 sockets, subscriptions and keepalives collapse to one. Filtering is
  // unchanged, because handle() already drops any log whose recipient is not in OUR byAddr map.
  //
  // The danger this must not create: a hub that dies leaves every child deaf, with no error and no
  // missing-fill alarm - the exact "looks healthy, copies nothing" failure the socket code fights
  // everywhere else. So the hub beats every 20s, and if two minutes pass with no beat we assume it
  // is gone and open our own socket. Falling back costs a little RPC; staying deaf costs trades.
  const HUB_SILENCE_MS = Number(process.env.COSMOS_HUB_SILENCE_MS) || 120_000;
  let lastBeat = 0, fellBack = false;
  function startHubMode() {
    lastBeat = Date.now();
    process.on("message", (m) => {
      if (!m || typeof m !== "object") return;
      if (m.t === "beat") { lastBeat = Date.now(); return; }
      if (m.t === "s4" || m.t === "s4replay" || m.t === "s4canary") { try { s4.onMessage(m); } catch (e) { warn("s4 child:", e.message); } return; }   // stage 4: compare, and for a canary whale execute
      // VERSIONED ROSTER (owner 2026-08-30, shadow): stored and acknowledged; NOT used for filtering
      // until the proof passes (ROSTER_MODE=versioned). The ack is the IPC delivery proof.
      if (m.t === "roster" && Array.isArray(m.list)) {
        // MONOTONIC (owner 2026-08-31, "roster version lag"): a push that is OLDER than what we hold is
        // dropped. Without this a late delivery could resurrect a stale execution mode - re-granting the
        // hosted 7-day horizon after the server had already downgraded the account to self.
        const incoming = Number(m.version) || 0;
        if (versioned && incoming && incoming < versioned.version) { try { process.send?.({ t: "roster-ack", version: versioned.version, at: Date.now(), stale: incoming }); } catch { /* parent gone */ } return; }
        // ABSENT MUST STAY ABSENT: coercing a missing execution mode to false narrowed the horizon
        // and refused markets the production route approves (the 12:24Z revert).
        versioned = { list: m.list.map((w) => String(w).toLowerCase()), version: Number(m.version) || 0, epoch: m.epoch ?? null, hosted: typeof m.hosted === "boolean" ? m.hosted : undefined, at: Number(m.at) || Date.now(), receivedAt: Date.now() };
        try { process.send?.({ t: "roster-ack", version: versioned.version, at: Date.now() }); } catch { /* parent gone */ }
        return;
      }
      if (m.t === "log" && m.log) { lastBeat = Date.now(); try { handle(m.log); } catch (e) { warn("chainwatch hub log:", e.message); } }
    });
    log(`chainwatch: HUB mode - ${wallets.length} wallets, socket owned by the runner`);
    setInterval(() => {
      if (fellBack || !isArmed()) return;
      if (Date.now() - lastBeat > HUB_SILENCE_MS) {
        fellBack = true;
        warn(`chainwatch: no hub heartbeat for ${Math.round((Date.now() - lastBeat) / 1000)}s - opening our OWN socket (fallback)`);
        connect();
      }
    }, 30_000).unref?.();
  }

  (async function run() {
    await refreshWallets();
    if (!wallets.length) { log("chainwatch: no wallets to watch (copytrade off?)"); return; }
    if (HUB) startHubMode(); else connect();
    // ROSTER FREEZE (2026-08-30 stage 4 audit, 24 of 114 children): this refresh used to return while
    // the engine was disarmed (drawdown breaker, Stop, fleet halt), so a halted child kept its boot-time
    // watch list for the whole halt - hours - while its fill path went on calling copy-check with it.
    // Knowledge of the roster is not an entry; it refreshes regardless of the engine state.
    setInterval(async () => {
      const changed = await refreshWallets();
      // In hub mode the parent re-subscribes for us when the union changes; closing a socket we do
      // not own would be meaningless (and in fallback mode `ws` is ours again, so this still works).
      if (changed && ws) { try { ws.close(); } catch { /* reconnect handles it */ } }   // resubscribe with the new roster
    }, WALLET_REFRESH_MS);
    // WATCHDOG. Same reason as the confirm timeout: a watcher that is quietly not subscribed is
    // indistinguishable from a quiet market, and would cost us every trade without ever erroring.
    // Say so out loud every 10 minutes, and self-heal if the subscription is gone.
    setInterval(() => {
      if (!isArmed()) return;
      // In hub mode "subscribed" means the hub is beating; we have no socket of our own to check.
      if (HUB && !fellBack) {
        const age = Math.round((Date.now() - lastBeat) / 1000);
        log(`chainwatch: alive (hub) · ${wallets.length} wallets · ${seenCount} fills seen · last hub beat ${age}s ago`);
        return;
      }
      if (sub) log(`chainwatch: alive · ${wallets.length} wallets · ${seenCount} fills seen`);
      else { warn("chainwatch: NOT subscribed — reconnecting"); if (ws) { try { ws.close(); } catch { /* ignore */ } } else connect(); }
    }, 10 * 60_000);
  })();
}
