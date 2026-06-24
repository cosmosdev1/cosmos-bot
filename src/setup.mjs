// Interactive setup: collects the Cosmos token + Polymarket keys + per-trade size, verifies the
// token against Cosmos, and writes config.json. Run: npm run setup
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const rl = createInterface({ input, output });
const ask = async (q, def) => {
  const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
  return a || def || "";
};

console.log("\n  Cosmos bot — setup\n  ------------------\n");
const existing = existsSync("./config.json") ? JSON.parse(readFileSync("./config.json", "utf8")) : {};
const api = await ask("Cosmos API URL", existing.cosmosApi || "https://try-cosmos.com");
const cosmosToken = await ask("Your Cosmos API token (csk_...)", existing.cosmosToken);

process.stdout.write("  Verifying token... ");
try {
  const res = await fetch(`${api.replace(/\/$/, "")}/api/v1/account`, { headers: { Authorization: `Bearer ${cosmosToken}` } });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
  if (!d.bot_access) throw new Error("this plan does not include bot/API trading. Upgrade in the dashboard.");
  console.log(`ok · plan: ${d.tier}.`);
} catch (e) {
  console.log(`\n  Token check failed: ${e.message}\n`);
  rl.close();
  process.exit(1);
}

console.log("\n  Polymarket keys (used locally to sign orders — they never leave this machine):");
const privateKey = await ask("  Wallet private key (0x...)", existing.polymarket?.privateKey);
const funderAddress = await ask("  Funder / proxy address (0x...)", existing.polymarket?.funderAddress);

const perTradePct = Number(await ask("\n  Per-trade size, % of balance", String(existing.perTradePct ?? 5))) || 5;
const pollSeconds = Number(await ask("  Poll interval (seconds)", String(existing.pollSeconds ?? 30))) || 30;
const maxConcurrent = Number(await ask("  Max concurrent positions", String(existing.maxConcurrent ?? 10))) || 10;
const applyAns = (await ask("  Also manage your EXISTING Polymarket positions? (y/N)", existing.applyToManualTrades ? "y" : "n")).toLowerCase();

const config = {
  cosmosApi: api,
  cosmosToken,
  polymarket: { privateKey, funderAddress },
  perTradePct,
  pollSeconds,
  maxConcurrent,
  applyToManualTrades: applyAns.startsWith("y"),
};
writeFileSync("./config.json", JSON.stringify(config, null, 2), { mode: 0o600 }); // owner-only (protects the key)
console.log("\n  Saved config.json (owner-only). Start the bot with:  npm start\n");
rl.close();
