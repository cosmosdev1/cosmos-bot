// THE MONEY QUESTION: could the hub filter block a trade the bot would otherwise have taken?
// Compares, on LIVE data, the set the hub vouches for against the set a bot would accept on its own.
// Anything the bot would take but the hub omits is a LOST TRADE - the failure that must be zero.
const API = process.env.COSMOS_API || "https://try-cosmos.com";
const TOKEN = process.env.COSMOS_TOKEN;
if (!TOKEN) { console.log("SKIP: no COSMOS_TOKEN"); process.exit(0); }
const H = (p) => fetch(`${API}${p}`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(25_000) }).then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status} on ${p}`)));

const [ent, feed] = await Promise.all([H("/api/v1/copy-enterable"), H("/api/v1/copy-signals")]);
const now = Date.now();
const V2_MIN = 0.5, V2_MAX = 8;

// the bot's own view: what would IT consider enterable from its personal feed?
const clock = (s) => { const ev = Date.parse(String(s.wallets?.[0]?.event_at ?? "")); return Number.isFinite(ev) ? ev : Date.parse(String(s.end_date ?? "")); };
const tier = (s) => {
  const v2 = s.wallets?.[0]?.auto_tiers?.v2; if (!v2) return 0;
  const isC = /up or down/i.test(String(s.market_question ?? ""));
  const b = isC ? v2.candle : v2.nc; if (!b) return 0;
  const cost = Number(s.wallets?.[0]?.cost_usd ?? s.his_cost_usd ?? 0);
  if (isC) return cost >= +b.t1_usd ? 3 : cost >= +b.t2_usd ? 2 : 0;
  return cost >= +b.t1_usd ? 5 : cost >= +b.t2_usd ? 4 : cost >= +b.t3_usd ? 3 : 0;
};
const priceOk = (s) => { const his = +s.his_entry_cents || 0, cur = +s.entry_cents || 0; return !(his > 0 && cur > 0) || Math.abs(cur - his) <= Math.max(his * 0.2, 5); };

const botWould = [];
for (const s of feed.signals ?? []) {
  const h = (clock(s) - now) / 3_600_000;
  if (!(h >= V2_MIN && h <= V2_MAX)) continue;
  if (!tier(s)) continue;
  if (!priceOk(s)) continue;
  botWould.push(`${s.condition_id}|${String(s.outcome).toLowerCase()}`);
}
const hubHas = new Set((ent.signals ?? []).map(s => `${s.condition_id}|${String(s.outcome).toLowerCase()}`));
const lost = botWould.filter(k => !hubHas.has(k));
const extra = [...hubHas].filter(k => !botWould.includes(k));

console.log(`bot's personal feed:        ${(feed.signals ?? []).length} rows`);
console.log(`bot would enter:            ${botWould.length}`);
console.log(`hub vouches for:            ${hubHas.size}`);
console.log(`\nLOST TRADES (bot yes, hub no): ${lost.length}   <-- must be 0`);
for (const k of lost.slice(0, 8)) console.log(`   ${k}`);
console.log(`hub-only (not in this caller's feed): ${extra.length}   (expected - the hub is fleet-wide, this token follows fewer whales)`);
process.exit(lost.length ? 1 : 0);
