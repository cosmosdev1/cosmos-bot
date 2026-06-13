# Cosmos Bot

Auto-trades Cosmos insider signals on Polymarket. **Cosmos is the brain** (it decides what
to trade, via the API); **this bot is just the hands** (it places the orders with *your*
Polymarket keys, which never leave your machine).

Requires the **Bot add-on** (or Gold) on your Cosmos account.

## Install

```bash
python -m venv .venv && . .venv/Scripts/activate   # Windows
# python3 -m venv .venv && source .venv/bin/activate  # macOS/Linux
pip install -r requirements.txt
cp .env.example .env
```

## Configure (`.env`)

1. **`COSMOS_TOKEN`** — generate at https://try-cosmos.com/settings → API tokens.
2. **`POLYMARKET_PRIVATE_KEY`** (+ `POLYMARKET_FUNDER_ADDRESS`, `POLYMARKET_SIGNATURE_TYPE`)
   — your own Polymarket wallet creds. For email/magic-link accounts use signature type `1`
   and your proxy address as the funder.
3. **Filters** — `MIN_INSIDER_SCORE`, `MIN/MAX_PRICE_CENTS`, `TRADE_USD`,
   `MAX_OPEN_TRADES_PER_DAY`, `CATEGORIES_ALLOW` / `CATEGORIES_BLOCK`.
4. **`DRY_RUN=true`** (default) — logs every trade it *would* make, places nothing.

## Run

```bash
python main.py
```

It loops every `POLL_SECONDS`: pulls your tier's signals from Cosmos, applies your filters,
and (when `DRY_RUN=false`) places a Fill-Or-Kill BUY for `TRADE_USD` on each new market.
It never buys the same market twice (`state.json`) and stops at the daily cap.

## Going live

When the dry-run logs look right, set `DRY_RUN=false` and add your `POLYMARKET_PRIVATE_KEY`.
**You** hold the keys and the risk — Cosmos never sees them, and never executes anything.

## Files

| file | role |
|---|---|
| `config.py` | env loading + validation |
| `cosmos.py` | the Cosmos API (the brain) |
| `filters.py` | your trade filters + a keyword categorizer |
| `polymarket.py` | CLOB v2 order execution + token resolution |
| `state.py` | dedupe + daily cap |
| `main.py` | the loop |

Not financial advice. Trade at your own risk.
