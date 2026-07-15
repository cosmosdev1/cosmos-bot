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

// TransferSingle: data = [id, value]. TransferBatch: data = [idsOffset, valsOffset, len, ...ids, len, ...vals]
function tokensFromLog(l) {
  const w = words(l.data);
  if (l.topics[0] === T_SINGLE) {
    if (w.length < 2) return [];
    return [{ tokenId: BigInt("0x" + w[0]).toString(), shares: Number(BigInt("0x" + w[1])) / 1e6 }];
  }
  if (l.topics[0] === T_BATCH) {
    try {
      const idsAt = Number(BigInt("0x" + w[0])) / 32;
      const valsAt = Number(BigInt("0x" + w[1])) / 32;
      const n = Number(BigInt("0x" + w[idsAt]));
      const out = [];
      for (let i = 0; i < n; i++) {
        out.push({
          tokenId: BigInt("0x" + w[idsAt + 1 + i]).toString(),
          shares: Number(BigInt("0x" + w[valsAt + 1 + i])) / 1e6,
        });
      }
      return out;
    } catch { return []; }
  }
  return [];
}

// Start the watcher. `onSignal(signal, meta)` gets a fully vetted signal from the server; the caller
// executes it with the same guards + sizing as the polled feed.
export function startChainWatch({ cosmos, onSignal, isArmed }) {
  let wallets = [];          // [{wallet, username}]
  let byAddr = new Map();
  let ws = null, sub = null, urlIx = 0, alive = false, seenCount = 0, lastBlock = 0;
  const done = new Set();    // txHash#logIndex — a reconnect can replay logs; never act twice

  async function refreshWallets() {
    try {
      const r = await cosmos.copyWallets();
      const list = (r?.wallets ?? []).filter((w) => /^0x[a-f0-9]{40}$/.test(w.wallet));
      const changed = list.length !== wallets.length || list.some((w, i) => w.wallet !== wallets[i]?.wallet);
      wallets = list;
      byAddr = new Map(list.map((w) => [w.wallet, w]));
      return changed;
    } catch (e) { warn("chainwatch wallets:", e.message); return false; }
  }

  // A whale's position just grew. Ask the server whether we may copy it — every rule lives there.
  async function onFill(w, tokenId, shares, l) {
    const t0 = Date.now();
    let res;
    try { res = await cosmos.copyCheck({ wallet: w.wallet, token_id: tokenId, shares }); }
    catch (e) { warn("chainwatch check:", e.message); return; }
    const ms = Date.now() - t0;
    if (!res?.ok) {
      log(`chainwatch: ${w.username} +${shares.toFixed(0)} sh -> SKIP (${res?.reason ?? "no"}) · ${ms}ms`);
      return;
    }
    const s = res.signal;
    log(`chainwatch: ${w.username} +${shares.toFixed(0)} sh -> ${s.outcome} @${s.entry_cents}c${s.is_pair ? " [PAIR]" : ""} · vetted in ${ms}ms · ${String(s.market_question).slice(0, 40)}`);
    try { await onSignal(s, { wallet: w, shares, block: l.blockNumber }); }
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
    for (const f of fills) { seenCount++; onFill(w, f.tokenId, f.shares, l); }   // fire-and-forget: never block the socket
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
    for (const { tokenId, shares } of tokensFromLog(l)) if (shares > 0) e.fills.push({ tokenId, shares });
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

  (async function run() {
    await refreshWallets();
    if (!wallets.length) { log("chainwatch: no wallets to watch (copytrade off?)"); return; }
    connect();
    setInterval(async () => {
      if (!isArmed()) return;
      const changed = await refreshWallets();
      if (changed && ws) { try { ws.close(); } catch { /* reconnect handles it */ } }   // resubscribe with the new roster
    }, WALLET_REFRESH_MS);
    // WATCHDOG. Same reason as the confirm timeout: a watcher that is quietly not subscribed is
    // indistinguishable from a quiet market, and would cost us every trade without ever erroring.
    // Say so out loud every 10 minutes, and self-heal if the subscription is gone.
    setInterval(() => {
      if (!isArmed()) return;
      if (sub) log(`chainwatch: alive · ${wallets.length} wallets · ${seenCount} fills seen`);
      else { warn("chainwatch: NOT subscribed — reconnecting"); if (ws) { try { ws.close(); } catch { /* ignore */ } } else connect(); }
    }, 10 * 60_000);
  })();
}
