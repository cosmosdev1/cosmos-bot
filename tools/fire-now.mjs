// One-command wrapper for the hosted-custody prove-out: loads .proveout.env and fires ONE trade.
// Usage:  node tools/fire-now.mjs          (LIVE — places the order)
//         node tools/fire-now.mjs --dry    (preview only)
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const l of readFileSync(join(root, ".proveout.env"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^([A-Za-z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}
const dry = process.argv.includes("--dry");
const r = spawnSync(process.execPath, [join(root, "tools/fire-one-trade.mjs"), ...(dry ? [] : ["--fire"])], { stdio: "inherit", cwd: root });
process.exit(r.status ?? 1);
