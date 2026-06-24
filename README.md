# Cosmos bot

Trades Cosmos insider signals automatically through **your own** Polymarket keys. Your wallet key
never leaves your machine — the bot signs orders locally and routes them through the Cosmos relay,
which meters usage ($0.09 / order) and enforces your daily limit.

This repo is intentionally **separate** from the main Cosmos app: it's the only piece that touches
your private key, so it ships and is reviewed on its own.

## Install

```sh
git clone https://github.com/<your-org>/cosmos-bot.git
cd cosmos-bot
npm install
npm run setup      # enter your Cosmos token + Polymarket keys + per-trade %
npm start
```

Requires **Node.js 18+** (https://nodejs.org). One-line installers are in `install.ps1` /
`install.sh` (set your repo URL inside them first).

## How it works

Each cycle (default 30s):

1. **Reads** your settings (`/api/v1/account`) and the **already-filtered** feed
   (`/api/v1/signals`) — limited to your plan, sources, categories, and min-score.
2. **Opens** positions: sizes at your per-trade %, skips markets past the insider entry, signs
   the order locally, and places it through the relay.
3. **Exits** using your TP/SL setting:
   - **Cosmos AI** → `/api/v1/positions/advice` (whale-exit measured in shares + price). The bot
     obeys the verdict.
   - **Fixed / Percent** → evaluated locally against the live price.
4. Optionally manages your **existing** Polymarket positions too (`applyToManualTrades`).

Open positions persist to `positions.json`, so a restart resumes safely.

## Safety

- The private key lives only in `config.json` on your machine and only signs orders.
- Cosmos never holds or moves funds. CLOB credentials pass through the relay in transit and are
  **not stored** on Cosmos servers.
- `config.json` and `positions.json` are git-ignored — never commit them.

## Status / to verify

The Cosmos-side logic (feed, sizing, dedupe, exits, relay) is complete. The Polymarket glue in
`src/polymarket.mjs` is written against `@polymarket/clob-client` v4 — **run one small live order
first** to confirm the three marked spots (create order / L2 headers / relay body) against your
installed client version before trusting size.

## Config (`config.json`)

| field | meaning |
| --- | --- |
| `cosmosApi` | `https://try-cosmos.com` |
| `cosmosToken` | your `csk_…` API token |
| `polymarket.privateKey` | wallet key used to sign (local only) |
| `polymarket.funderAddress` | your Polymarket proxy/funder address |
| `perTradePct` | % of balance per trade |
| `pollSeconds` | cycle interval |
| `maxConcurrent` | max open positions |
| `applyToManualTrades` | also run exits on your existing positions |

Not financial advice. Trade at your own risk.
