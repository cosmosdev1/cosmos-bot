// One-shot setup: reads the Cosmos token from the install command (COSMOS_TOKEN),
// verifies it, asks ONLY for the Polymarket keys (which stay on this machine), and
// writes config.json. Everything else uses sensible defaults you can tweak later
// in config.json. Run automatically by the installer, or: npm run setup
import { writeFileSync, existsSync, readFileSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline/promises";

// Prompt from the real terminal even when the installer was piped (curl | sh).
let input = process.stdin;
if (!process.stdin.isTTY) {
  try { input = createReadStream("/dev/tty"); } catch { /* fall back to stdin */ }
}
const rl = createInterface({ input, output: process.stdout });
const ask = async (q, def) => {
  const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
  return a || def || "";
};

const existing = existsSync("./config.json") ? JSON.parse(readFileSync("./config.json", "utf8")) : {};
const api = (process.env.COSMOS_API || existing.cosmosApi || "https://try-cosmos.com").replace(/\/$/, "");

console.log("\n  Cosmos bot — setup\n");

// Token: from the install command, or ask once if it wasn't passed.
let cosmosToken = process.env.COSMOS_TOKEN || existing.cosmosToken;
if (!cosmosToken) cosmosToken = await ask("  Paste your Cosmos API token (csk_...)");

process.stdout.write("  Verifying token... ");
try {
  const res = await fetch(`${api}/api/v1/account`, { headers: { Authorization: `Bearer ${cosmosToken}` } });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
  if (!d.bot_access) throw new Error("this plan does not include bot/API trading. Upgrade in the dashboard.");
  console.log(`ok · plan: ${d.tier}.`);
} catch (e) {
  console.log(`\n  Token check failed: ${e.message}\n  Create a token at ${api}/cosmos-api and run setup again.\n`);
  rl.close();
  process.exit(1);
}

console.log("\n  Now your Polymarket keys. They are used ONLY on this machine to sign orders");
console.log("  and are never sent to Cosmos.\n");
const privateKey = await ask("  Wallet private key (0x...)", existing.polymarket?.privateKey);
const funderAddress = await ask("  Polymarket address / proxy (0x...)", existing.polymarket?.funderAddress);

const config = {
  cosmosApi: api,
  cosmosToken,
  polymarket: { privateKey, funderAddress },
  // Sensible defaults — edit config.json any time to change these.
  perTradePct: existing.perTradePct ?? 5,
  pollSeconds: existing.pollSeconds ?? 30,
  maxConcurrent: existing.maxConcurrent ?? 10,
  applyToManualTrades: existing.applyToManualTrades ?? false,
};
writeFileSync("./config.json", JSON.stringify(config, null, 2), { mode: 0o600 }); // owner-only (protects the key)
rl.close();
console.log("\n  All set. Starting the bot...  (stop with Ctrl+C · restart any time with: npm start)\n");
