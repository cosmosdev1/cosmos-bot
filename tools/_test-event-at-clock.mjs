// The v2 window must tick off wallets[0].event_at when present, end_date otherwise.
// Mirrors the block in src/copytrade.mjs - if the two drift, THIS is the one that is wrong.
const V2_WINDOW_MS = 4 * 3600e3, V2_MIN_MS = 0.5 * 3600e3;
const v2ClockMs = (sig) => {
  const ev = Date.parse(String(sig?.wallets?.[0]?.event_at ?? ""));
  if (Number.isFinite(ev)) return ev;
  const end = Date.parse(String(sig?.end_date ?? ""));
  return Number.isFinite(end) ? end : NaN;
};
const outside = (sig) => {
  const end = v2ClockMs(sig);
  if (!Number.isFinite(end)) return false;
  const left = end - Date.now();
  return left > V2_WINDOW_MS || left < V2_MIN_MS;
};
const iso = (h) => new Date(Date.now() + h * 3600e3).toISOString();
let pass = 0, fail = 0;
const ck = (name, got, want) => { const ok = got === want; console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); ok ? pass++ : fail++; };

// tennis shape: end_date is a far tournament stamp, event_at is the real match in 2h
ck("event_at 2h away, end_date 76h away -> IN window",   outside({ end_date: iso(76), wallets: [{ event_at: iso(2) }] }), false);
// same row without event_at (v1-era signal) -> falls back to end_date -> outside
ck("no event_at, end_date 76h away -> outside",           outside({ end_date: iso(76), wallets: [{}] }), true);
// event_at says the match already started -> too late, even though end_date is hours out
ck("event_at 10min ago, end_date 3h away -> too late",    outside({ end_date: iso(3), wallets: [{ event_at: iso(-0.17) }] }), true);
// esports shape: end_date=start+3h in-window, event_at=start 5h away -> NOT yet
ck("event_at 5h away, end_date 3h away -> not yet",       outside({ end_date: iso(3), wallets: [{ event_at: iso(5) }] }), true);
// garbage event_at -> end_date decides
ck("garbage event_at, end_date 2h away -> IN window",     outside({ end_date: iso(2), wallets: [{ event_at: "not-a-date" }] }), false);
// neither -> other gates decide (never guess)
ck("no times at all -> other gates decide",               outside({ wallets: [{}] }), false);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
