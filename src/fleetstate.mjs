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
const URL = process.env.COSMOS_FLEETSTATE_URL || "https://raw.githubusercontent.com/cosmosdev1/cosmos-bot/main/FLEETSTATE";
const POLL_MS = (Number(process.env.COSMOS_FLEETSTATE_SECONDS) || 45) * 1000;

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
export function startFleetStateWatch(log) {
  if (started) return; started = true;
  const tick = async () => {
    try {
      const r = await fetch(URL, { signal: AbortSignal.timeout(8000), cache: "no-store" });
      if (r.ok) { const before = state.halt; apply(await r.text()); if (state.halt !== before) (log || console.log)(`[fleetstate] ${state.halt ? "HALT" : "RESUME"} — ${state.reason || "(no reason)"} (ts ${state.ts})`); }
    } catch { /* unreachable -> keep last state; never fail a cycle over this */ }
  };
  tick();
  setInterval(tick, POLL_MS).unref?.();
}
