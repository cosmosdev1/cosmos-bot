// SERVER-INDEPENDENT FLEET KILL SWITCH (2026-07-22). The bot polls a signed FLEETSTATE from a host
// that is NOT the Cosmos web server (GitHub raw — a separate trust domain), so the owner can freeze
// or tighten the whole fleet in seconds EVEN IF the Cosmos server is fully compromised. The attacker
// controls /api/v1/account (the normal Stop flag), so that path can't be trusted during an incident;
// this one can, because it's verified against an Ed25519 public key baked into this git-pulled source
// and signed by a private key the owner holds OFFLINE. FLEETSTATE can only HALT or TIGHTEN — never
// cause a trade — so worst case its compromise is a denial of service, not a drain.
import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Public half of the offline owner key. Safe to ship (it only VERIFIES). Rotate by committing a new
// one here; a compromised server cannot swap it because it lives in the audited git-pulled src/.
const PUBKEY_B64 = "0k4HaDm0R9PBttPGO6SF6XnJKn6qKyDa2U4N+18sd1o=";
const PUBKEY = crypto.createPublicKey({
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(PUBKEY_B64, "base64")]),
  format: "der", type: "spki",
});
// Out-of-band URL, overridable but defaults to this repo's raw main. Poll is independent of the git
// pull, so a halt lands in <=POLL seconds, not the 10-min code-update window.
// MIRRORS (scale build Inc 1.13, 2026-08-17). One URL meant the kill switch got WEAKER as the
// fleet grew: at 10K bots polling every 45s that is ~222 req/s at raw.githubusercontent.com, and
// a throttle there means the signed HALT stops propagating at exactly the fleet size where an
// incident hurts most. Any number of mirrors can be listed (COSMOS_FLEETSTATE_URLS, comma-
// separated); they are tried in a rotating order until one returns a VALID SIGNED document.
// Adding mirrors adds no trust: every document is Ed25519-verified against the offline owner key
// baked into this git-pulled source, and the ts replay guard rejects an older state - so a
// hostile or stale mirror can neither forge a resume nor roll us back.
const URLS = (process.env.COSMOS_FLEETSTATE_URLS || process.env.COSMOS_FLEETSTATE_URL ||
  "https://raw.githubusercontent.com/cosmosdev1/cosmos-bot/main/FLEETSTATE")
  .split(",").map((s) => s.trim()).filter(Boolean);
const POLL_MS = (Number(process.env.COSMOS_FLEETSTATE_SECONDS) || 45) * 1000;
// Jitter the poll so a fleet restart does not turn into a synchronized stampede on the mirrors
// (the audit's thundering-herd class: every fixed timer in the fleet fires in the same second).
const jitter = () => POLL_MS * (0.85 + Math.random() * 0.3);

const DIR = process.env.COSMOS_DATA_DIR ? process.env.COSMOS_DATA_DIR.replace(/\/$/, "") : join(homedir(), ".cosmos");
try { mkdirSync(DIR, { recursive: true }); } catch { /* best-effort */ }
const TS_FILE = join(DIR, "fleetstate-ts.json");
let lastTs = 0; try { lastTs = Number(JSON.parse(readFileSync(TS_FILE, "utf8")).ts) || 0; } catch { /* fresh */ }

// Live state the bot reads before every entry. Default: NOT halted (fail-open on availability — an
// attacker who merely BLOCKS the URL can't force a halt, and can never force a resume either).
const state = { halt: false, reason: "", maxTradePct: null, ts: 0 };
export function fleetHalted() { return state.halt; }
export function fleetMaxTradePct() { return state.maxTradePct; }
export function fleetReason() { return state.reason; }

function apply(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return; }
  const p = doc?.payload, sig = doc?.sig;
  if (!p || typeof sig !== "string") return;
  // canonical bytes MUST match the signer exactly (fixed key order)
  const canon = JSON.stringify(p, ["halt", "reason", "max_trade_pct", "ts"]);
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(canon, "utf8"), PUBKEY, Buffer.from(sig, "base64")); } catch { ok = false; }
  if (!ok) return;                                   // forged / corrupt -> ignore, keep current state
  const ts = Number(p.ts) || 0;
  if (ts < lastTs) return;                            // replay of an older state (e.g. a stale "resume") -> reject
  lastTs = ts; try { writeFileSync(TS_FILE, JSON.stringify({ ts })); } catch { /* best-effort */ }
  state.halt = p.halt === true;
  state.reason = String(p.reason || "");
  state.maxTradePct = Number.isFinite(Number(p.max_trade_pct)) && Number(p.max_trade_pct) > 0 ? Number(p.max_trade_pct) : null;
  state.ts = ts;
}

let started = false;
let rot = Math.floor(Math.random() * 1e6);          // per-process mirror rotation offset
export function startFleetStateWatch(log) {
  if (started) return; started = true;
  const tick = async () => {
    // Try mirrors in a rotating order; stop at the first one that yields a VALID SIGNED doc, so
    // the normal cost stays one request per poll and a dead mirror only costs one extra try.
    const order = URLS.map((_, i) => URLS[(rot + i) % URLS.length]);
    rot++;
    for (const url of order) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000), cache: "no-store" });
        if (!r.ok) continue;
        const before = state.halt, beforeTs = state.ts;
        apply(await r.text());
        if (state.ts !== beforeTs || state.halt !== before) {
          if (state.halt !== before) (log || console.log)(`[fleetstate] ${state.halt ? "HALT" : "RESUME"} — ${state.reason || "(no reason)"} (ts ${state.ts})`);
          return;                                    // a valid doc was applied - done for this tick
        }
        return;                                      // valid but unchanged (the common case)
      } catch { /* try the next mirror */ }
    }
    // Every mirror unreachable -> keep the last state. Fail-open on AVAILABILITY is deliberate:
    // blocking the URL must never be able to freeze the fleet, and never able to resume it either.
  };
  tick();
  const schedule = () => setTimeout(() => { tick().finally(schedule); }, jitter()).unref?.();
  schedule();
}
