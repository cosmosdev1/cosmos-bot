"""Bot configuration, loaded from .env."""
from __future__ import annotations

import os
from dotenv import load_dotenv

load_dotenv()


def _bool(key: str, default: bool) -> bool:
    return os.getenv(key, str(default)).strip().lower() in ("1", "true", "yes", "on")


def _int(key: str, default: int) -> int:
    try:
        return int(os.getenv(key, str(default)))
    except ValueError:
        return default


def _list(key: str) -> list[str]:
    return [x.strip() for x in os.getenv(key, "").split(",") if x.strip()]


# Cosmos (the brain)
COSMOS_API = os.getenv("COSMOS_API", "https://try-cosmos.com").rstrip("/")
COSMOS_TOKEN = os.getenv("COSMOS_TOKEN", "")

# Polymarket (your keys)
POLYMARKET_PRIVATE_KEY = os.getenv("POLYMARKET_PRIVATE_KEY", "")
POLYMARKET_FUNDER_ADDRESS = os.getenv("POLYMARKET_FUNDER_ADDRESS", "")
POLYMARKET_SIGNATURE_TYPE = _int("POLYMARKET_SIGNATURE_TYPE", 1)
CLOB_API_URL = os.getenv("CLOB_API_URL", "https://clob.polymarket.com")

# Safety
DRY_RUN = _bool("DRY_RUN", True)

# Filters
MIN_INSIDER_SCORE = _int("MIN_INSIDER_SCORE", 40)
MIN_PRICE_CENTS = _int("MIN_PRICE_CENTS", 3)
MAX_PRICE_CENTS = _int("MAX_PRICE_CENTS", 90)
TRADE_USD = float(os.getenv("TRADE_USD", "25"))
MAX_OPEN_TRADES_PER_DAY = _int("MAX_OPEN_TRADES_PER_DAY", 30)
CATEGORIES_ALLOW = _list("CATEGORIES_ALLOW")
CATEGORIES_BLOCK = _list("CATEGORIES_BLOCK")

# Loop
POLL_SECONDS = _int("POLL_SECONDS", 120)


def validate() -> list[str]:
    """Return a list of fatal config problems (empty = OK)."""
    errs = []
    if not COSMOS_TOKEN.startswith("csk_"):
        errs.append("COSMOS_TOKEN missing/invalid (generate one at /settings).")
    if not DRY_RUN and not POLYMARKET_PRIVATE_KEY:
        errs.append("POLYMARKET_PRIVATE_KEY required when DRY_RUN=false.")
    return errs
