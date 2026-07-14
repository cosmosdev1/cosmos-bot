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
const WALLET_REFRESH_MS = 5 * 60_000;

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
  let ws = null, sub = null, urlIx = 0, alive = false;
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
    try { res = await cosmos.copyCheck({ wallet: w.wallet, token_id: tokenId }); }
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

  function handle(l) {
    const key = `${l.transactionHash}#${l.logIndex}`;
    if (done.has(key)) return;
    done.add(key);
    if (done.size > 5000) done.clear();
    const to = "0x" + String(l.topics[3] ?? "").slice(-40).toLowerCase();
    const w = byAddr.get(to);
    if (!w) return;                                   // not one of ours (shouldn't happen: the node filters)
    const from = "0x" + String(l.topics[2] ?? "").slice(-40).toLowerCase();
    if (byAddr.has(from)) return;                      // whale-to-whale shuffle, not a new position
    for (const { tokenId, shares } of tokensFromLog(l)) {
      if (shares <= 0) continue;
      onFill(w, tokenId, shares, l);                   // fire-and-forget: never block the socket
    }
  }

  function connect() {
    if (!wallets.length) return;
    const url = WSS[urlIx % WSS.length];
    urlIx++;
    let socket;
    try { socket = new WSImpl(url); } catch (e) { warn("chainwatch ws:", e.message); return setTimeout(connect, 5000); }
    ws = socket;
    let pinger = null;

    socket.onopen = () => {
      alive = true;
      const params = [
        "logs",
        { address: CTF_ERC1155, topics: [[T_SINGLE, T_BATCH], null, null, wallets.map((w) => pad32(w.wallet))] },
      ];
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params }));
      log(`chainwatch: watching ${wallets.length} wallets on-chain via ${url.replace("wss://", "")}`);
      pinger = setInterval(() => { try { socket.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "net_version", params: [] })); } catch { /* closing */ } }, 30_000);
    };
    socket.onmessage = (ev) => {
      let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); } catch { return; }
      if (m.id === 1) { if (m.result) sub = m.result; else warn("chainwatch subscribe failed:", JSON.stringify(m.error ?? {}).slice(0, 80)); return; }
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
  })();
}
