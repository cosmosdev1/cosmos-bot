// CHILD-SIDE HUB CONTRACT (mirrors the block in src/copytrade.mjs — if the two drift, THIS is the
// one that is wrong). The money question: when the hub is quiet, does the bot keep trading?
//
// The rule being pinned: the hub may only ever REMOVE entry candidates it has positively vouched
// against. It must never be able to (a) block trading by going silent, or (b) suppress a market we
// already hold, which still needs the loop for top-ups and exit bookkeeping.
const HUB_SILENCE_MS = 90_000;

function makeChild(v2 = true) {
  let hubSignals = null, hubAt = 0, hubBeatAt = 0;
  const onMessage = (m) => {
    if (!m || typeof m !== "object") return;
    if (m.t === "enterable" && Array.isArray(m.signals)) { hubSignals = m.signals; hubAt = Date.now(); hubBeatAt = hubAt; return; }
    if (m.t === "enterable-beat") { hubBeatAt = Date.now(); }   // liveness only - NOT the data clock
  };
  const hubFresh = (now = Date.now()) => hubSignals !== null && (now - hubAt) < HUB_SILENCE_MS;
  const keys = (now) => (v2 && hubFresh(now))
    ? new Set(hubSignals.map((s) => `${s.condition_id}|${String(s.outcome).toLowerCase()}`))
    : null;
  /** returns true when the entry scan SKIPS this signal */
  const skips = (sig, positions = {}, now = Date.now()) => {
    const k = keys(now);
    return !!(k && !positions[sig.condition_id] && !k.has(`${sig.condition_id}|${String(sig.outcome).toLowerCase()}`));
  };
  return { onMessage, hubFresh, skips };
}

let pass = 0, fail = 0;
const ck = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${got}, want ${want})`}`);
  ok ? pass++ : fail++;
};

const A = { condition_id: "0xaaa", outcome: "Yes" };
const B = { condition_id: "0xbbb", outcome: "No" };

// 1. NO hub message ever -> nothing is skipped (bot behaves exactly as before the hub existed)
{
  const c = makeChild();
  ck("no hub yet -> entry scan unfiltered", c.skips(A), false);
}

// 2. hub fresh and vouches for A -> B is skipped, A is not
{
  const c = makeChild();
  c.onMessage({ t: "enterable", signals: [A] });
  ck("hub vouched -> candidate kept", c.skips(A), false);
  ck("hub silent on it -> candidate skipped", c.skips(B), true);
}

// 3. hub goes STALE -> filter switches off entirely, bot trades on its own feed again
{
  const c = makeChild();
  c.onMessage({ t: "enterable", signals: [A] });
  const later = Date.now() + HUB_SILENCE_MS + 1_000;
  ck("stale hub -> filter disabled (no trades lost)", c.skips(B, {}, later), false);
}

// 4. an EMPTY broadcast is authoritative while fresh (nothing enterable is a real answer)
{
  const c = makeChild();
  c.onMessage({ t: "enterable", signals: [] });
  ck("fresh empty set -> everything skipped", c.skips(A), true);
  const later = Date.now() + HUB_SILENCE_MS + 1_000;
  ck("...but only until it goes stale", c.skips(A, {}, later), false);
}

// 5. a market we ALREADY HOLD is never skipped - top-ups and exit bookkeeping depend on it
{
  const c = makeChild();
  c.onMessage({ t: "enterable", signals: [] });
  ck("held position survives an empty hub set", c.skips(A, { "0xaaa": { size_usd: 4 } }), false);
}

// 6. A BEAT MUST NOT REVIVE A STALE SET. This is the case that was pinned WRONG before: a beat
// used to refresh the data clock, so a permanently dead endpoint kept every child filtering
// against a frozen list forever and the stale-fallback could never fire.
{
  const c = makeChild();
  c.onMessage({ t: "enterable", signals: [A] });
  const later = Date.now() + HUB_SILENCE_MS + 1_000;
  c.onMessage({ t: "enterable-beat" });                 // runner alive, endpoint dead
  ck("beat does NOT revive a stale set", c.skips(B, {}, later), false);
  ck("fresh data still filters normally", c.skips(B), true);
}

// 8. a v1 caller is NEVER filtered - the hub verdict is v2-only
{
  const c = makeChild(false);
  c.onMessage({ t: "enterable", signals: [] });
  ck("v1 caller ignores the hub entirely", c.skips(A), false);
  ck("v1 caller ignores it even with a set", c.skips(B), false);
}

// 7. garbage messages are ignored
{
  const c = makeChild();
  c.onMessage(null); c.onMessage("nope"); c.onMessage({ t: "enterable", signals: "bad" });
  ck("garbage never arms the filter", c.skips(A), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
