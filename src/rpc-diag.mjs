// SOCKET-LEVEL REQUEST DIAGNOSTICS (owner 2026-09-03, Diagnostic Path 1). OBSERVATION ONLY.
//
// Nine stuck ticks, all in the seal worker's `header` stage, all on a call that carries an 8 s
// per-endpoint abort and still did not settle for 90 s+. The seal worker's own instrumentation
// already names the await; it cannot see below it. This does.
//
// It subscribes to undici's diagnostics channels and records, per request, the monotonic instant of
// each transport phase. It changes NOTHING: no timeouts, no retries, no DNS, no agent or pool
// configuration, no concurrency. It never mutates a request, a response or a socket, and it never
// adds a header - correlation to a logical operation is done with AsyncLocalStorage, so the bytes on
// the wire are identical with the instrumentation on or off.
//
// EVERY SUBSCRIBER IS WRAPPED, and that is not defensive habit. A diagnostics_channel subscriber that
// throws propagates out of Channel.publish and takes the PROCESS down - verified against Node 24
// before this file was written. This process hosts the seal worker and every child, so an
// instrumentation bug that escaped would be far more expensive than the defect being investigated.

import dc from "node:diagnostics_channel";
import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage();

// A monotonic clock, with one wall-clock anchor so a phase can be reported as an ISO instant without
// inheriting clock jumps. Date.now() alone would let an NTP correction masquerade as a stall.
const MONO0 = performance.now();
const WALL0 = Date.now();
const mono = () => performance.now();
const wall = (m) => new Date(WALL0 + (m - MONO0)).toISOString();

// The phase names, in the order they can occur. `created -> sent` spans connection acquisition, which
// is where DNS, TCP, TLS and pool queueing all live; `sent -> headers` is the server; `headers ->
// trailers` is the body on the wire; `trailers -> parsed` is our own read and JSON.parse.
export const PHASES = Object.freeze([
  "created", "connect_start", "connected", "connect_error",
  "headers_sent", "body_sent", "response_headers", "response_trailers",
  "body_read_start", "parsed", "error", "socket_close",
]);

const MAX_LIVE = Number(process.env.COSMOS_RPC_DIAG_MAX_LIVE) || 64;
const MAX_RECENT = Number(process.env.COSMOS_RPC_DIAG_RECENT) || 32;

const byRequest = new WeakMap();     // undici request object -> record
const bySocket = new WeakMap();      // socket -> { connect_start, connected }
const byConnectParams = new WeakMap(); // connectParams -> connect_start (beforeConnect has no socket yet)
const live = new Map();              // id -> record, in-flight only
const recent = [];                   // bounded ring of finished records
let idSeq = 0;
let evicted = 0;
let subscribed = false;

// A record must not depend on a call site remembering to close it. Labelled records are closed by
// label()'s finally; unlabelled ones - every other fetch in the process - are swept once their
// transport has finished. Nothing here uses a timer, so there is no handle to leak and no scheduling
// to perturb; the sweep runs lazily whenever the map is touched.
const ORPHAN_MS = Number(process.env.COSMOS_RPC_DIAG_ORPHAN_MS) || 300_000;

const sweep = () => {
  const t = mono();
  for (const r of live.values()) {
    // An orphan is a record whose request neither completed nor errored - an abort that emitted no
    // event, say. Labelled records are closed by their own scope, so this is the last resort only.
    if (t - r.startedMono > ORPHAN_MS) { r.orphaned = true; finish(r); }
  }
};

const rec = (label, origin, scope) => {
  const r = {
    id: ++idSeq, label: label || "unlabelled", origin: origin || null, scoped: Boolean(scope),
    startedMono: mono(), startedAt: wall(mono()),
    phases: Object.create(null), status: null, errorText: null, reusedConnection: null,
  };
  r.phases.created = 0;
  live.set(r.id, r);
  if (scope) scope.born.push(r);
  sweep();
  // Bounded. Only hung requests survive here (finished ones are deleted), so an overflow is itself a
  // signal and is counted rather than silently dropped.
  if (live.size > MAX_LIVE) {
    const oldest = live.keys().next().value;
    live.delete(oldest);
    evicted++;
  }
  return r;
};

const mark = (r, phase, extra) => {
  if (!r || r.phases[phase] !== undefined) return;   // first occurrence wins; never overwrite
  r.phases[phase] = Number((mono() - r.startedMono).toFixed(1));
  if (extra) Object.assign(r, extra);
};

const finish = (r) => {
  if (!r) return;
  live.delete(r.id);
  r.endedMono = mono();
  r.totalMs = Number((r.endedMono - r.startedMono).toFixed(1));
  recent.push(r);
  while (recent.length > MAX_RECENT) recent.shift();
};

// The last phase that actually completed - the answer to "where did it stop".
export const lastPhase = (r) => {
  if (!r) return null;
  let best = null, bestT = -1;
  for (const p of Object.keys(r.phases)) if (r.phases[p] >= bestT) { bestT = r.phases[p]; best = p; }
  return best;
};

// WHAT THE STALL LOOKS LIKE, in the three shapes the owner asked to distinguish.
export const classify = (r) => {
  if (!r) return null;
  const p = r.phases;
  if (p.error !== undefined) return "errored";
  if (p.parsed !== undefined) return "complete";
  // Only a LABELLED call site reports when it finished parsing. For every other request in the
  // process, transport completion is all we can see, and calling that a parse stall would manufacture
  // hundreds of false positives out of ordinary traffic.
  if (p.response_trailers !== undefined) return r.scoped ? "body_complete_parse_stalled" : "complete";
  if (p.response_headers !== undefined) return "headers_arrived_body_incomplete";
  if (p.headers_sent !== undefined) return "request_sent_no_response_headers";
  if (p.connected !== undefined) return "connected_request_not_sent";
  if (p.connect_start !== undefined) return "connecting_never_connected";
  return "created_never_connected";
};

// WHICH CHANNELS THIS RUNTIME ACTUALLY PUBLISHES. The deployed image is node:20-slim and this was
// developed on 24; rather than assume parity, every handler records that it fired, and the mask is
// reported as a gauge. If a channel is missing in production the data says so immediately, instead of
// the absence being discovered as a hole in the evidence during the one stall we were waiting for.
const CHAN_BIT = Object.freeze({
  create: 1, beforeConnect: 2, connected: 4, connectError: 8,
  sendHeaders: 16, bodySent: 32, headers: 64, trailers: 128, error: 256,
});
let chanMask = 0;
export const channelMask = () => chanMask;
export const channelsSeen = () => Object.keys(CHAN_BIT).filter((k) => chanMask & CHAN_BIT[k]);
export const channelsMissing = () => Object.keys(CHAN_BIT).filter((k) => !(chanMask & CHAN_BIT[k]));

const safe = (bit, fn) => (msg) => { try { chanMask |= bit; fn(msg); } catch { /* instrumentation must never reach production */ } };

export function install() {
  if (subscribed) return;
  subscribed = true;

  dc.subscribe("undici:request:create", safe(CHAN_BIT.create, ({ request }) => {
    const store = als.getStore();
    const origin = String(request?.origin ?? "");
    const r = rec(store?.label, origin, store);
    byRequest.set(request, r);
  }));

  dc.subscribe("undici:client:beforeConnect", safe(CHAN_BIT.beforeConnect, ({ connectParams }) => {
    if (connectParams) byConnectParams.set(connectParams, mono());
  }));

  dc.subscribe("undici:client:connected", safe(CHAN_BIT.connected, ({ connectParams, socket }) => {
    if (!socket) return;
    const started = connectParams ? byConnectParams.get(connectParams) : undefined;
    bySocket.set(socket, { connect_start: started ?? null, connected: mono() });
  }));

  dc.subscribe("undici:client:connectError", safe(CHAN_BIT.connectError, ({ connectParams, error }) => {
    if (!connectParams) return;
    const started = byConnectParams.get(connectParams);
    // No socket to hang it on; record it against every request still waiting to be sent.
    for (const r of live.values()) {
      if (r.phases.headers_sent === undefined) {
        mark(r, "connect_error", { errorText: String(error?.message ?? error).slice(0, 200) });
        if (started != null && r.phases.connect_start === undefined) r.phases.connect_start = Number((started - r.startedMono).toFixed(1));
      }
    }
  }));

  // The request-to-socket link. Connect timings observed above are attached HERE, which is the first
  // moment the two are known to belong together.
  dc.subscribe("undici:client:sendHeaders", safe(CHAN_BIT.sendHeaders, ({ request, socket }) => {
    const r = byRequest.get(request);
    if (!r) return;
    const c = socket ? bySocket.get(socket) : null;
    if (c) {
      if (c.connect_start != null) r.phases.connect_start = Number((c.connect_start - r.startedMono).toFixed(1));
      r.phases.connected = Number((c.connected - r.startedMono).toFixed(1));
      r.reusedConnection = c.connected < r.startedMono;   // the connection predates the request
    } else {
      r.reusedConnection = true;                          // sent with no connect observed for this socket
    }
    mark(r, "headers_sent");
  }));

  dc.subscribe("undici:request:bodySent", safe(CHAN_BIT.bodySent, ({ request }) => mark(byRequest.get(request), "body_sent")));

  dc.subscribe("undici:request:headers", safe(CHAN_BIT.headers, ({ request, response }) => {
    mark(byRequest.get(request), "response_headers", { status: response?.statusCode ?? null });
  }));

  dc.subscribe("undici:request:trailers", safe(CHAN_BIT.trailers, ({ request }) => {
    const r = byRequest.get(request);
    mark(r, "response_trailers");
    if (r && !r.scoped) finish(r);      // nothing else will ever close it: no call site is watching
  }));

  dc.subscribe("undici:request:error", safe(CHAN_BIT.error, ({ request, error }) => {
    const r = byRequest.get(request);
    if (!r) return;
    mark(r, "error", { errorText: String(error?.message ?? error).slice(0, 200) });
    finish(r);
  }));

  return true;
}

/**
 * Tag every undici request created inside `fn` with a logical label, and close those records when it
 * settles. The ONLY call-site change, and not a behavioural one: als.run invokes fn immediately, and
 * the returned promise is passed through .finally(), which preserves both the resolved value and the
 * rejection exactly. The request, its timeouts and its error propagation are untouched.
 */
export const label = (name, fn) => {
  const scope = { label: String(name), born: [] };
  const close = () => { for (const r of scope.born) finish(r); };
  let out;
  try { out = als.run(scope, fn); }
  catch (e) { close(); throw e; }
  if (out && typeof out.then === "function") return out.finally(close);
  close();
  return out;
};

/** Our own two boundaries: the transport cannot see when WE start reading or finish parsing. */
export const beginBodyRead = () => { const r = currentOf(); if (r) mark(r, "body_read_start"); return r; };
export const endParse = (r) => { if (r) mark(r, "parsed"); };

// The request created most recently inside the current label scope. rpcT issues one request per
// attempt and awaits it, so "the newest live record with this label" is unambiguous.
function currentOf() {
  const store = als.getStore();
  if (!store) return null;
  let best = null;
  for (const r of live.values()) if (r.label === store.label && (!best || r.startedMono > best.startedMono)) best = r;
  return best;
}

const view = (r) => ({
  id: r.id, label: r.label, origin: r.origin, startedAt: r.startedAt,
  ageMs: Number((mono() - r.startedMono).toFixed(1)),
  phases: { ...r.phases }, lastPhase: lastPhase(r), classification: classify(r),
  status: r.status ?? null, reusedConnection: r.reusedConnection, error: r.errorText ?? null,
});

/** The newest live record with this exact label - how a watchdog in another scope finds its request. */
export const byLabel = (name) => {
  let best = null;
  for (const r of live.values()) if (r.label === name && (!best || r.startedMono > best.startedMono)) best = r;
  return best ? view(best) : null;
};

/** The record for the request in progress in the current label scope. */
export const current = () => { const r = currentOf(); return r ? view(r) : null; };

/** In-flight requests, oldest first. The first entry is the one a stuck tick is waiting on. */
export const inflight = () => { sweep(); return [...live.values()].sort((a, b) => a.startedMono - b.startedMono).map(view); };

/** The oldest in-flight request, which is what a STUCK TICK snapshot should carry. */
export const oldestInflight = () => inflight()[0] ?? null;

/** Finished requests, newest last - for correlating a hang counter with the phase it stopped at. */
export const recentFinished = () => recent.map(view);

export const stats = () => (sweep(), {
  installed: subscribed, channelMask: chanMask, channelsSeen: channelsSeen(), channelsMissing: channelsMissing(), liveCount: live.size, evicted, recentCount: recent.length,
  byClassification: recent.reduce((a, r) => { const c = classify(r); a[c] = (a[c] || 0) + 1; return a; }, Object.create(null)),
});

/** Tests only. */
export const _reset = () => { live.clear(); recent.length = 0; idSeq = 0; evicted = 0; };
