"""Talks to the Cosmos public API - the 'brain' that decides what to trade."""
from __future__ import annotations

import requests

import config


class CosmosError(Exception):
    pass


def _headers() -> dict:
    return {"Authorization": f"Bearer {config.COSMOS_TOKEN}"}


def account() -> dict:
    """Verify the token + see the tier. Raises on auth failure."""
    r = requests.get(f"{config.COSMOS_API}/api/v1/account", headers=_headers(), timeout=20)
    if r.status_code == 401:
        raise CosmosError("Cosmos token invalid or revoked.")
    if r.status_code == 403:
        raise CosmosError("This token's account is not active (need Bot add-on or Gold).")
    r.raise_for_status()
    return r.json()


def signals() -> list[dict]:
    """Live insider signals for this token's tier. Each item:
    { id, condition_id, market_question, market_url, outcome, side,
      insider_score, bet_usd, price_cents, insider_count, end_date, detected_at }
    """
    r = requests.get(f"{config.COSMOS_API}/api/v1/signals", headers=_headers(), timeout=30)
    if r.status_code == 429:
        return []  # rate limited - back off, try next loop
    r.raise_for_status()
    return r.json().get("signals", [])
