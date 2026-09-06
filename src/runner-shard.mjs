// RUNNER IDENTITY FOR SHARDING (owner 2026-09-07). Pure: what this VM tells the roster about itself.
//   shard   - the legacy RUNNER_SHARD="i/N" env (kept as the no-map fallback; the server's map wins)
//   group   - the Fly process group (FLY_PROCESS_GROUP, or RUNNER_GROUP to override) - the key the
//             server's RUNNER_SHARD_MAP is written against; stable across restarts and deploys
//   machine - FLY_MACHINE_ID, for the audit trail only
//   host    - the metrics label: "<group>-<machine>", slug-capped like the metrics route expects, so
//             every fleet row (metrics, roster-audit, alarms) says which shard wrote it
export function shardQuery(env = process.env) {
  const shard = /^\d+\/\d+$/.test(String(env.RUNNER_SHARD || "")) ? String(env.RUNNER_SHARD) : "";
  const group = String(env.RUNNER_GROUP || env.FLY_PROCESS_GROUP || "").trim().toLowerCase();
  const machine = String(env.FLY_MACHINE_ID || "").trim();
  const host = ((group ? group + "-" : "") + (machine || "runner")).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "runner";
  return { shard, group, machine, host };
}
