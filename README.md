# Cosmos bot

Trades Cosmos insider signals automatically through **your own** Polymarket keys. Your wallet key
never leaves your machine — the bot signs orders locally and routes them through the Cosmos relay,
which meters usage ($0.09 / order) and enforces your daily limit.

This repo is intentionally **separate** from the main Cosmos app: it's the only piece that touches
your private key, so it ships and is reviewed on its own.

## Install

```sh
git clone https://github.com/cosmosdev1/cosmos-bot.git
cd cosmos-bot
npm install
npm run setup      # enter your Cosmos token + Polymarket keys + per-trade %
npm start
```

Requires **Node.js 18+** (https://nodejs.org). One-line installers are in `install.ps1` /
`install.sh` (set your repo URL inside them first).

## Run it 24/7 (computer can be off)

The bot is a long-running process, so closing your computer stops it. To trade around the clock,
run it on an always-on box **you control** — your key still never reaches Cosmos. Simplest is a
one-click deploy to **Render**:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/cosmosdev1/cosmos-bot)

1. Click the button and sign in to Render.
2. When prompted, paste 3 secrets: `COSMOS_TOKEN`, `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_FUNDER`.
3. Deploy. It runs 24/7 (~$7/mo, billed to **your** Render account).

The blueprint (`render.yaml`) pins **region: Frankfurt** on purpose — Polymarket geoblocks US
datacenters, so an EU region is required (a US host gets "Trading restricted in your region").
Your key is a Render secret env var, visible only to you — Cosmos never sees it, same as local.

The included **`Dockerfile`** runs the exact same bot on any host (Railway, Fly.io, a $4 VPS, a
Raspberry Pi) — just set the same env vars. State (`positions.json` / `seen.json`) persists to
`COSMOS_DATA_DIR` (a mounted disk) so restarts resume safely.

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

- The private key lives only in `config.json` on your machine (written owner-only, `0600`) and is
  used solely to sign orders. It is **never** sent anywhere.
- Cosmos never holds or moves funds. Your CLOB API credentials (not the private key) pass *through*
  the relay in transit to reach Polymarket and are **not stored** on Cosmos servers.
- `config.json` and `positions.json` are git-ignored — never commit them.
- Orders are placed **marketable Fill-And-Kill** (fill now or cancel — they never rest), and the
  bot **reconciles** `positions.json` against your real wallet each cycle, so state can't drift.

## Supply chain

Pin and review dependencies. After install:

```sh
npm audit
```

The only runtime deps are `@polymarket/clob-client-v2` (Polymarket's CLOB **V2** client) and
`viem` (the signer it uses). The old `@polymarket/clob-client` signs an order version Polymarket's
V2 exchange now rejects — do not downgrade.

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

**On a hosted / 24-7 deploy** (no `config.json`), set these as **env vars** instead — they take
precedence: `COSMOS_TOKEN`, `POLYMARKET_PRIVATE_KEY`, `POLYMARKET_FUNDER`, and optionally
`COSMOS_DATA_DIR` (persistent-disk path for state), `COSMOS_API`, `POLL_SECONDS`, `MAX_CONCURRENT`.

Not financial advice. Trade at your own risk.
