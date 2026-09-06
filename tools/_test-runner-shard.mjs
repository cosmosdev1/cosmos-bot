// What a runner VM tells the roster about itself: group from FLY_PROCESS_GROUP (RUNNER_GROUP overrides), legacy
// RUNNER_SHARD kept as the no-map fallback, metrics host label per shard and slug-capped.
import assert from "node:assert";
import { shardQuery } from "../src/runner-shard.mjs";
let pass = 0, fail = 0; const ck = (n, c) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n); } };
const a = shardQuery({ FLY_PROCESS_GROUP: "app", FLY_MACHINE_ID: "1853edec3e3678" });
ck("default Fly group 'app' + machine id", a.group === "app" && a.machine === "1853edec3e3678" && a.shard === "");
ck("host label carries the group", a.host === "app-1853edec3e3678");
const b = shardQuery({ FLY_PROCESS_GROUP: "Shard2", FLY_MACHINE_ID: "e784e1f3c5d1e8", RUNNER_SHARD: "2/2" });
ck("group lower-cased; legacy RUNNER_SHARD passed through", b.group === "shard2" && b.shard === "2/2" && b.host === "shard2-e784e1f3c5d1e8");
ck("RUNNER_GROUP overrides FLY_PROCESS_GROUP", shardQuery({ FLY_PROCESS_GROUP: "app", RUNNER_GROUP: "shard1" }).group === "shard1");
ck("no Fly env at all: no group, host 'runner' (today's label)", (() => { const s = shardQuery({}); return s.group === "" && s.machine === "" && s.host === "runner"; })());
ck("malformed RUNNER_SHARD ignored", shardQuery({ RUNNER_SHARD: "x/y" }).shard === "");
ck("host is slug-capped at 24 chars", shardQuery({ FLY_PROCESS_GROUP: "averyveryverylonggroupname", FLY_MACHINE_ID: "1853edec3e3678" }).host.length <= 24);
console.log("\n" + (fail === 0 ? "ALL PASS" : "FAILURES") + ": " + pass + " passed, " + fail + " failed");
assert.equal(fail, 0);
