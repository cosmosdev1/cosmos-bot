// ONE CHAIN SUBSCRIPTION PER MACHINE (scale build Inc 1.5, 2026-08-18).
//
// Every bot child used to open its OWN WebSocket to a Polygon node and subscribe to its own whale
// set. With ~90 children on one box that is ~90 sockets, ~90 subscriptions and - the expensive part
// - ~90 keepalives every 30s, all watching a HEAVILY OVERLAPPING set of wallets (users pick from a
// shared pool of whales, so the union is far smaller than the sum). Three costs:
//   * metered RPC becomes unaffordable: 90 keepalives x 2/min x 20 credits = ~150M credits/month,
//     against a 10M plan - the reason we could not simply point the fleet at a paid endpoint;
//   * public nodes rate-limit and ban by IP, and 90 sockets from one machine looks like abuse;
//   * every socket costs CPU and memory on a box that was already CPU-starved.
//
// This module keeps ONE socket for the whole machine, subscribed to the UNION of every child's
// wallets, and hands each matching log back to the runner to fan out over IPC. The child-side
// filtering is unchanged (chainwatch drops logs for wallets it does not follow), so a child sees
// exactly what it saw before - just delivered through the parent instead of its own socket.
//
// SAFETY: the fast path is the product. If this hub stops delivering, children fall back to their
// own socket on their own (see chainwatch.mjs hub-mode watchdog) - the hub sends a heartbeat every
// 20s precisely so silence is detectable and never mistaken for "no whale activity".
const WSImpl = globalThis.WebSocket ?? (await import("ws")).WebSocket;

const CTF_ERC1155 = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const T_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
const T_BATCH = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";

// The hub is the ONLY thing that should use a metered endpoint: one socket, one keepalive.
// COSMOS_HUB_WSS / COSMOS_HUB_RPC let the runner point the hub at a paid node while children (and
// every self-hosted bot) keep the free public defaults.
const WSS = (process.env.COSMOS_HUB_WSS || process.env.COSMOS_WSS_URLS || "wss://polygon-bor-rpc.publicnode.com,wss://polygon.drpc.org")
  .split(",").map((s) => s.trim()).filter(Boolean);
// BACKFILL endpoints. Deliberately SEPARATE from the socket: a metered plan may cap eth_getLogs to
// a few blocks (QuickNode's free tier: 5), while the public nodes serve ~100. rpc() falls through
// on any error, so listing the paid node first and the public ones after gets the best of both.
const HTTP = (process.env.COSMOS_HUB_RPC || process.env.COSMOS_RPC_URL || "https://polygon-bor-rpc.publicnode.com,https://polygon.drpc.org")
  .split(",").map((s) => s.trim()).filter(Boolean);

const PING_MS = Number(process.env.COSMOS_HUB_PING_MS) || 240_000;   // 4 min (was 30s per child)
const HEARTBEAT_MS = 20_000;
const pad32 = (addr) => "0x" + addr.replace(/^0x/, "").toLowerCase().padStart(64, "0");

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

/**
 * @param {(log:object)=>void} onLog        every matching log, for the runner to broadcast
 * @param {()=>void} onBeat                 liveness tick, broadcast so children know the hub lives
 * @param {(msg:string)=>void} log
 */
import { createChainCursor } from "./chain-cursor.mjs";
export function startChainHub({ onLog, onBeat, log = console.log, warn = console.warn }) {
  // CONTIGUOUS GAP-AWARE CURSOR (owner 2026-08-30): the seal source for the canonical driver. Fed by
  // newHeads (every header), live logs, disconnects and every backfill chunk's outcome.
  const cursor = createChainCursor({ headLag: Number(process.env.COSMOS_SEAL_HEAD_LAG) || 1 });
  let headSub = null;
  let wallets = [];               // the union, lowercased
  let ws = null, sub = null, urlIx = 0, alive = false, lastBlock = 0, resubTimer = null;
  let connected = false, delivered = 0;

  function currentTopics() {
    return ["logs", { address: CTF_ERC1155, topics: [[T_SINGLE, T_BATCH], null, null, wallets.map(pad32)] }];
  }

  // Re-subscribing on every child's wallet refresh would thrash the socket, so changes are
  // debounced: children report independently and a new bot booting would otherwise trigger one
  // reconnect per child.
  function setWallets(list) {
    const next = [...new Set(list.map((w) => String(w).toLowerCase()).filter((w) => /^0x[a-f0-9]{40}$/.test(w)))].sort();
    const same = next.length === wallets.length && next.every((w, i) => w === wallets[i]);
    if (same) return;
    wallets = next;
    log(`[chainhub] wallet union now ${wallets.length}`);
    if (resubTimer) clearTimeout(resubTimer);
    resubTimer = setTimeout(() => { if (ws) { try { ws.close(); } catch { /* onclose reconnects */ } } else connect(); }, 3000);
  }

  // Replay the blocks missed across a reconnect. Same reasoning as the per-child watcher: a
  // subscription only delivers what happens while you are listening, and those seconds are exactly
  // when a whale fill goes missing with no error anywhere.
  const CHUNK = Number(process.env.COSMOS_HUB_BACKFILL_CHUNK) || 100;
  const MAX_GAP = Number(process.env.COPY_BACKFILL_BLOCKS) || 100;
  async function backfill() {
    if (!wallets.length) return;
    const head = parseInt(await rpc("eth_blockNumber", []) ?? "0x0", 16);
    if (!Number.isFinite(head) || head <= 0) return;
    if (!lastBlock) { lastBlock = head; return; }
    let from = lastBlock + 1;
    if (from > head) return;
    if (head - from > MAX_GAP) {
      warn(`[chainhub] gap of ${head - from} blocks exceeds what the RPC will serve - ${head - from - MAX_GAP} blocks NOT recovered`);
      cursor.onBackfillStart(from, head - MAX_GAP - 1); cursor.onBackfillDone(from, head - MAX_GAP - 1, false);   // known, unrecovered: stays pending
      from = head - MAX_GAP;
    }
    let found = 0;
    for (let a = from; a <= head; a += CHUNK) {
      const b = Math.min(a + CHUNK - 1, head);
      cursor.onBackfillStart(a, b);
      const logs = await rpc("eth_getLogs", [{
        address: CTF_ERC1155,
        fromBlock: "0x" + a.toString(16),
        toBlock: "0x" + b.toString(16),
        topics: [[T_SINGLE, T_BATCH], null, null, wallets.map(pad32)],
      }]);
      if (!Array.isArray(logs)) { warn(`[chainhub] backfill ${a}-${b} refused - those blocks are unchecked`); cursor.onBackfillDone(a, b, false); continue; }
      found += logs.length;
      for (const l of logs) { try { deliver(l); } catch { /* keep going */ } }
      cursor.onBackfillDone(a, b, true);
    }
    if (found) log(`[chainhub] backfilled ${found} log(s) across blocks ${from}-${head}`);
    lastBlock = head;
  }

  function deliver(l) {
    const b = parseInt(l.blockNumber, 16);
    if (Number.isFinite(b) && b > lastBlock) lastBlock = b;
    if (Number.isFinite(b)) cursor.onLog(b);
    delivered++;
    onLog(l);
  }

  function connect() {
    const url = WSS[urlIx % WSS.length];
    urlIx++;
    let socket;
    try { socket = new WSImpl(url); } catch (e) { warn("[chainhub] ws:", e.message); return setTimeout(connect, 5000); }
    ws = socket;
    let pinger = null, confirm = null;

    socket.onopen = () => {
      alive = true;
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: currentTopics() }));
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_subscribe", params: ["newHeads"] }));   // one header per block: the seal cursor's contiguity source
      // A CONNECTED SOCKET WITH NO SUBSCRIPTION is the worst failure mode - it looks healthy and
      // delivers nothing, forever. Public nodes do intermittently answer eth_subscribe with an
      // internal error, so an unconfirmed subscription tears the socket down and rotates.
      confirm = setTimeout(() => {
        if (!sub) { warn("[chainhub] no subscription confirmed in 10s - reconnecting"); try { socket.close(); } catch { /* onclose */ } }
      }, 10_000);
      // Keepalive at 4 MINUTES, not 30 seconds. This is the single call that made a metered
      // endpoint unaffordable when every child had its own; one hub at 4min is ~11k calls/month.
      pinger = setInterval(() => { try { socket.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "net_version", params: [] })); } catch { /* closing */ } }, PING_MS);
    };
    socket.onmessage = (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); } catch { return; }
      if (m.id === 2) { if (m.result) headSub = m.result; else warn("[chainhub] newHeads subscribe rejected - sealing will stay at 0 until it works:", JSON.stringify(m.error ?? {}).slice(0, 80)); return; }
      if (m.id === 1) {
        if (m.result) {
          sub = m.result; connected = true;
          if (confirm) clearTimeout(confirm);
          log(`[chainhub] LIVE - ${wallets.length} wallets on one socket via ${url.replace(/^wss:\/\//, "").split("/")[0]}`);
          cursor.onReconnect();
          backfill();
        } else {
          warn("[chainhub] subscribe rejected:", JSON.stringify(m.error ?? {}).slice(0, 80));
          try { socket.close(); } catch { /* onclose */ }
        }
        return;
      }
      if (m.method === "eth_subscription" && m.params?.result) {
        if (headSub && m.params.subscription === headSub) { const hn = parseInt(m.params.result?.number, 16); if (Number.isFinite(hn)) cursor.onHead(hn); return; }
        try { deliver(m.params.result); } catch (e) { warn("[chainhub] deliver:", e.message); }
      }
    };
    const down = () => {
      if (pinger) clearInterval(pinger);
      if (confirm) clearTimeout(confirm);
      if (!alive) return;
      alive = false; sub = null; headSub = null; connected = false; ws = null;
      cursor.onDisconnect();
      warn("[chainhub] socket down - reconnecting");
      setTimeout(connect, 2000);
    };
    socket.onclose = down;
    socket.onerror = () => { try { socket.close(); } catch { down(); } };
  }

  // The heartbeat is what lets a child tell "the hub is alive and the whales are quiet" apart from
  // "the hub died and I am deaf". Without it, silence is ambiguous and the fast path can be lost
  // without a single error being logged anywhere.
  setInterval(() => { try { onBeat(); } catch { /* never let the beat kill the hub */ } }, HEARTBEAT_MS).unref?.();

  connect();
  return {
    setWallets,
    cursor: () => cursor.state(),
    sealable: () => cursor.sealable(),
    stats: () => ({ wallets: wallets.length, connected, delivered, cursor: cursor.state() }),
  };
}
