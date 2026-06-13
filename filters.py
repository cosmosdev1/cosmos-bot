"""Decide whether a Cosmos signal should be traded, per the user's config."""
from __future__ import annotations

import config

# Lightweight keyword categorizer (the API returns the market question, not a category).
_CATS = {
    "Crypto": ("bitcoin", "btc", "ethereum", "eth", "solana", "sol", "xrp", "doge", "crypto", "hyperliquid"),
    "Sports": ("vs.", " vs ", "nba", "nfl", "ufc", "soccer", "premier league", "world cup", "win the", "beat the", "match"),
    "Politics": ("election", "president", "senate", "congress", "prime minister", "nominee", "candidate", "vote"),
    "Economy": ("fed", "rate", "inflation", "cpi", "gdp", "recession", "jobs report"),
}


def categorize(question: str) -> str:
    q = (question or "").lower()
    for cat, kws in _CATS.items():
        if any(k in q for k in kws):
            return cat
    return "Other"


def should_trade(sig: dict) -> tuple[bool, str]:
    """Returns (ok, reason). reason explains a skip."""
    score = sig.get("insider_score", 0)
    if score < config.MIN_INSIDER_SCORE:
        return False, f"score {score} < {config.MIN_INSIDER_SCORE}"

    price = sig.get("price_cents", 0)
    if price < config.MIN_PRICE_CENTS or price > config.MAX_PRICE_CENTS:
        return False, f"price {price}c out of [{config.MIN_PRICE_CENTS},{config.MAX_PRICE_CENTS}]"

    if (sig.get("side") or "BUY").upper() != "BUY":
        return False, "not a BUY"

    cat = categorize(sig.get("market_question", ""))
    if config.CATEGORIES_BLOCK and cat in config.CATEGORIES_BLOCK:
        return False, f"category {cat} blocked"
    if config.CATEGORIES_ALLOW and cat not in config.CATEGORIES_ALLOW:
        return False, f"category {cat} not in allow-list"

    return True, "ok"
