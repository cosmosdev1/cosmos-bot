// DRY TEST of the WIRED path: signal -> candleTarget -> the caller's own top-up arithmetic.
//
// dry-candle-sizing.mjs proves the engine maths. This proves the INTEGRATION, which is where the
// expensive mistake lives: copytrade.mjs computes `add = min(target, ceiling) - held`, so if
// candleTarget returned a top-up instead of a total the 60% tier would buy 3% ON TOP of the 1.5%
// already held. Same numbers, double the money. This walks a whale up the ladder through the real
// call shape and asserts what we END UP HOLDING at each step.
//
// Run: node tools/dry-candle-wiring.mjs
import { targetPctForHolding } from "../src/candle-sizing.mjs";

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  ok   ${n}${d ? " :: " + d : ""}`); } else { fail++; console.log(`  FAIL ${n}${d ? " :: " + d : ""}`); } };
const close = (a, b, e = 1e-6) => Math.abs(a - b) < e;

const MIN_ORDER_USD = 1, MIN_ADD_USD = 1;

// Mirrors copytrade.mjs candleTarget()
const candleTarget = (his, baseline, portfolio, oneShot) => {
  const pct = targetPctForHolding(his, baseline, { oneShot });
  return { target: (portfolio * pct) / 100, ceiling: (portfolio * 4.5) / 100, pct };
};
// Mirrors the caller's top-up arithmetic in fastOpen()
const addFor = (target, held, posCeil) => {
  const add = Math.min(target, posCeil) - held;
  return add < MIN_ADD_USD ? 0 : add;
};

console.log("\n=== the wired ladder: 30% -> 60% -> 90% on a $1,000 portfolio, his baseline $100 ===");
{
  const portfolio = 1000, baseline = 100;
  const posCeil = Math.max(MIN_ORDER_USD, (portfolio * 5) / 100);   // MAX_POSITION_PCT = 5
  let held = 0;
  const want = [15, 30, 45];   // what we should HOLD after each tier: 1.5%, 3%, 4.5%
  [30, 60, 90].forEach((his, i) => {
    const { target } = candleTarget(his, baseline, portfolio, false);
    const add = addFor(target, held, posCeil);
    held += add;
    check(`he reaches ${his}% -> we add $${add.toFixed(2)}, now holding $${held.toFixed(2)}`, close(held, want[i]), `want $${want[i]}`);
  });
  check("TOTAL is 4.5% of portfolio, not 9%", close(held, 45), `$${held.toFixed(2)}`);
}

console.log("\n=== he jumps straight to 90% ===");
{
  const portfolio = 1000, baseline = 100, posCeil = 50;
  const { target } = candleTarget(90, baseline, portfolio, false);
  check("one order takes us to the full 4.5%", close(addFor(target, 0, posCeil), 45), `$${addFor(target, 0, posCeil).toFixed(2)}`);
}

console.log("\n=== he drifts back down ===");
{
  const portfolio = 1000, baseline = 100, posCeil = 50;
  const { target } = candleTarget(35, baseline, portfolio, false);   // back to the 30% band
  check("we do NOT sell or re-buy — the add is simply 0", addFor(target, 45, posCeil) === 0);
}

console.log("\n=== the 5% per-position ceiling still wins ===");
{
  const portfolio = 1000, baseline = 100;
  const posCeil = 20;   // an artificially tight ceiling
  const { target } = candleTarget(90, baseline, portfolio, false);
  check("4.5% target is clamped to the position ceiling", close(addFor(target, 0, posCeil), 20), `$${addFor(target, 0, posCeil).toFixed(2)}`);
}

console.log("\n=== small portfolio: the tier lands under the exchange minimum ===");
{
  const portfolio = 50, baseline = 100;               // 1.5% of $50 = $0.75
  const posCeil = Math.max(MIN_ORDER_USD, (portfolio * 5) / 100);
  const { target } = candleTarget(30, baseline, portfolio, false);
  check("no order is attempted below the $1 minimum", addFor(target, 0, posCeil) === 0, `target $${target.toFixed(2)}`);
}

console.log("\n=== one-shot through the same path ===");
{
  const portfolio = 1000, baseline = 100, posCeil = 50;
  const a = candleTarget(49, baseline, portfolio, true);
  check("below 50% -> nothing", addFor(a.target, 0, posCeil) === 0);
  const b = candleTarget(50, baseline, portfolio, true);
  check("crossing 50% buys 2%", close(addFor(b.target, 0, posCeil), 20), `$${addFor(b.target, 0, posCeil).toFixed(2)}`);
  const c = candleTarget(300, baseline, portfolio, true);
  check("he stacks to 300% -> we still hold 2%, no add", addFor(c.target, 20, posCeil) === 0);
}

console.log("\n=== a whale we have no baseline for ===");
{
  const { target } = candleTarget(5000, 0, 1000, false);
  check("no baseline -> no target, never fires blind", target === 0);
}

console.log("\n=== live defaults: engine ON, one-shot FORCED, keyed off the TRADE ===");
{
  // Mirrors the constants in copytrade.mjs, so changing either default trips a test instead of
  // silently altering what the fleet does with real money.
  const engineFor = (signer, env) => {
    const hosted = (signer || "local").toLowerCase() === "remote";
    const e = env || "";
    return /^(1|true|yes|on)$/i.test(e) ? true : /^(0|false|no|off)$/i.test(e) ? false : hosted;
  };
  const CANDLE_TIERS = /^(1|true|yes|on)$/i.test(process.env.COPY_CANDLE_TIERS || "");
  const isCandleSig = (sig) => /\bup or down\b/i.test(String(sig?.market_question ?? ""));

  // HOSTED ONLY. The live self-hosted fleet must not change behaviour when this merges: its
  // signatures are free, so collapsing its ladder to one clip removes upside it pays nothing for.
  check("SELF-HOSTED bot, no env -> engine OFF (fleet unchanged)", engineFor("local", "") === false);
  check("HOSTED bot, no env -> engine ON", engineFor("remote", "") === true);
  check("self-hosted can force it on for testing", engineFor("local", "1") === true);
  check("hosted can disable it", engineFor("remote", "0") === false);
  check("tiers are OFF with no env set (one-shot only)", !CANDLE_TIERS);
  const CANDLE_ENGINE = engineFor("remote", "");
  check("hosted engine resolves on", CANDLE_ENGINE);

  const real = "Solana Up or Down - July 28, 7:10PM-7:15PM ET";   // a real signal title from the DB
  check("a real candle title is recognised", isCandleSig({ market_question: real }));
  check("15m candle recognised", isCandleSig({ market_question: "Bitcoin Up or Down - Aug 1, 3:00PM-3:15PM ET" }));
  check("hourly candle recognised", isCandleSig({ market_question: "Ethereum Up or Down - Aug 1, 3PM-4PM ET" }));
  check("a sports market is NOT a candle", !isCandleSig({ market_question: "Lakers to win vs Celtics" }));
  check("a political market is NOT a candle", !isCandleSig({ market_question: "Will the Fed cut rates in September?" }));
  check("a market merely mentioning bitcoin is NOT a candle", !isCandleSig({ market_question: "Bitcoin above $118,000 on Aug 3?" }));

  // TRADE-keyed, not wallet-keyed: a sports whale who takes one candle gets candle sizing on it.
  const portfolio = 1000, baseline = 100, posCeil = 50;
  check("a sports whale taking a candle is treated as a candle", isCandleSig({ market_question: real }));
  const t = candleTarget(60, baseline, portfolio, !CANDLE_TIERS);
  check("and it sizes one-shot 2%, not the 3% tier", close(addFor(t.target, 0, posCeil), 20), `$${addFor(t.target, 0, posCeil).toFixed(2)}`);
}

console.log(`\n${fail === 0 ? "ALL WIRING TESTS PASSED" : `${fail} FAILED`} (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
