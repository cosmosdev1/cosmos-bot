// One-off: split the monolithic qtable-live-data.json (21MB, 5 coins) into per-coin files so the bot
// only PARSES the coins it actually trades. The monolith forced JSON.parse over all 5 coins at import
// time -> ~112MB heap on a 256MB host -> the OOM killer took down the WHOLE bot (not just qtable2).
//   node tools/split-qtable.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const src = "src/qtable-live-data.json";
const outDir = "src/qtable-data";
const t = JSON.parse(readFileSync(src, "utf8"));
mkdirSync(outDir, { recursive: true });

writeFileSync(`${outDir}/meta.json`, JSON.stringify({ meta: t.meta, coins: Object.keys(t.coins) }));
console.log(`meta.json  (${Object.keys(t.coins).length} coins listed)`);

for (const [coin, data] of Object.entries(t.coins)) {
  const j = JSON.stringify(data);
  writeFileSync(`${outDir}/${coin}.json`, j);
  console.log(`${coin}.json  ${(j.length / 1048576).toFixed(1)} MB`);
}
console.log(`\nsplit -> ${outDir}/  · the bot now loads only QTABLE2_COINS (default BTCUSDT,ETHUSDT = 7.4MB)`);
