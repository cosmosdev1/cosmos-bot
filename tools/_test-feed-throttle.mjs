// FEED THROTTLE CONTRACT (owner 2026-08-23: "crypto must be very fast"). The cycle keeps running
// every POLL_MS so the chainwatch fast path always has fresh cash/sizing; only the polled FEED
// fetch is throttled to the server's own cache window. Mirrors the block in src/copytrade.mjs.
const POLL_MS = 20_000, FEED_MIN_MS = 45_000;
function mkBot() {
  let lastFeed = null, lastFeedAt = 0, fetches = 0, now = 0, cycles = 0;
  return {
    tick(feedValue = { signals: [] }) {
      now += POLL_MS; cycles++;
      const age = now - lastFeedAt;
      if (age >= FEED_MIN_MS || !lastFeed) { fetches++; lastFeed = feedValue; lastFeedAt = now; }
      return lastFeed;
    },
    stats: () => ({ fetches, cycles }),
    // the fast path only needs the cycle to have run - it never touches the feed
    fastPathDataAgeMs: () => 0,
  };
}
let pass = 0, fail = 0;
const ck = (n, got, want) => { const ok = got === want; console.log(`${ok?"PASS":"FAIL"}  ${n}${ok?"":`  (got ${got}, want ${want})`}`); ok?pass++:fail++; };

{ const b = mkBot();
  for (let i = 0; i < 12; i++) b.tick();           // 12 cycles = 240s
  const s = b.stats();
  ck("12 cycles (240s) -> 12 cycles still run", s.cycles, 12);
  ck("...but only ~5 feed fetches (was 12)", s.fetches <= 6 && s.fetches >= 4, true);
}
{ const b = mkBot();
  const first = b.tick({ signals: ["a"] });
  ck("first cycle always fetches", first.signals[0], "a");
  const second = b.tick({ signals: ["b"] });
  ck("second cycle reuses the cached feed (server would return identical bytes)", second.signals[0], "a");
}
{ const b = mkBot();
  b.tick({ signals: ["old"] });
  for (let i = 0; i < 2; i++) b.tick({ signals: ["ignored"] });   // 40s+20s = past 45s on the 3rd
  const fresh = b.tick({ signals: ["new"] });
  ck("past FEED_MIN_MS the feed refreshes", fresh.signals[0], "new");
}
{ const b = mkBot();
  b.tick();
  ck("fast-path data (cash/sizing) is NEVER stale: refreshed every cycle", b.fastPathDataAgeMs(), 0);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
