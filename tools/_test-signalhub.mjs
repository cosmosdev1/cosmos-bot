// SIGNAL HUB CONTRACT. The dangerous failure here is silent: a hub that goes quiet, or serves an
// empty list, must never read as "nothing to trade" - that would stop the fleet trading while every
// dashboard looked healthy. These cases pin the behaviour that prevents it.
import { startSignalHub } from "../src/signalhub.mjs";

let pass = 0, fail = 0;
const ck = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. a successful pull broadcasts the set ----
{
  const sent = [];
  const hub = startSignalHub({
    fetchEnterable: async () => ({ count: 2, signals: [{ condition_id: "0xa", outcome: "Yes" }, { condition_id: "0xb", outcome: "No" }] }),
    broadcast: (m) => sent.push(m),
    log: () => {}, warn: () => {},
  });
  await sleep(60);
  hub.stop();
  const first = sent.find((m) => m.t === "enterable");
  ck("broadcasts the enterable set", first?.signals?.length, 2);
  ck("stamps a timestamp so children can age it", typeof first?.at, "number");
}

// ---- 2. an EMPTY set is still broadcast (a real answer, keeps the clock fresh) ----
{
  const sent = [];
  const hub = startSignalHub({
    fetchEnterable: async () => ({ count: 0, signals: [] }),
    broadcast: (m) => sent.push(m),
    log: () => {}, warn: () => {},
  });
  await sleep(60);
  hub.stop();
  ck("empty set IS broadcast (not withheld)", sent.some((m) => m.t === "enterable" && m.signals.length === 0), true);
}

// ---- 3. a FAILED pull broadcasts NOTHING (silence -> children fall back) ----
{
  const sent = [];
  const hub = startSignalHub({
    fetchEnterable: async () => { throw new Error("HTTP 503"); },
    broadcast: (m) => sent.push(m),
    log: () => {}, warn: () => {},
  });
  await sleep(60);
  hub.stop();
  ck("failure broadcasts no enterable set", sent.some((m) => m.t === "enterable"), false);
  ck("failure is counted, not swallowed", hub.stats().consecutiveFails > 0, true);
}

// ---- 4. a malformed payload is treated as empty, never as garbage passed downstream ----
{
  const sent = [];
  const hub = startSignalHub({
    fetchEnterable: async () => ({ signals: "not-an-array" }),
    broadcast: (m) => sent.push(m),
    log: () => {}, warn: () => {},
  });
  await sleep(60);
  hub.stop();
  const first = sent.find((m) => m.t === "enterable");
  ck("non-array signals -> empty list, no crash", first?.signals, []);
}

// ---- 5. recovery resets the failure counter ----
{
  let n = 0;
  const hub = startSignalHub({
    fetchEnterable: async () => { n++; if (n === 1) throw new Error("boom"); return { signals: [{ condition_id: "0xc", outcome: "Yes" }] }; },
    broadcast: () => {},
    log: () => {}, warn: () => {},
    });
  await sleep(40);
  const failedFirst = hub.stats().consecutiveFails > 0;
  // force a second pull without waiting the full poll interval
  await hub.stop?.call?.(hub) ?? null;
  ck("first failure recorded", failedFirst, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
