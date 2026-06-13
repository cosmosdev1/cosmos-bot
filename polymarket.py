"""The technical trading layer: resolve a market's outcome token and place a BUY
order on Polymarket's CLOB. The 'brain' (when/what) comes from Cosmos; this just
executes. Your Polymarket keys live only here, on your machine."""
from __future__ import annotations

import json
import logging

import requests

import config

logger = logging.getLogger("polymarket")

GAMMA = "https://gamma-api.polymarket.com"

try:
    from py_clob_client.client import ClobClient
    from py_clob_client.clob_types import OrderArgs
    from py_clob_client.order_builder.constants import BUY
except Exception:  # pragma: no cover - import guard for dry-run-only installs
    ClobClient = None
    OrderArgs = None
    BUY = "BUY"


def _parse_arr(v) -> list[str]:
    if isinstance(v, list):
        return [str(x) for x in v]
    if isinstance(v, str):
        try:
            p = json.loads(v)
            return [str(x) for x in p] if isinstance(p, list) else []
        except Exception:
            return []
    return []


def resolve_token_id(condition_id: str, outcome: str) -> str | None:
    """Map (condition_id, outcome) -> the CLOB ERC-1155 token id for that outcome."""
    try:
        r = requests.get(f"{GAMMA}/markets", params={"condition_ids": condition_id}, timeout=20)
        r.raise_for_status()
        data = r.json()
        m = data[0] if isinstance(data, list) and data else None
        if not m:
            return None
        outcomes = _parse_arr(m.get("outcomes"))
        token_ids = _parse_arr(m.get("clobTokenIds"))
        if len(outcomes) != len(token_ids):
            return None
        target = (outcome or "").strip().lower()
        for name, tid in zip(outcomes, token_ids):
            if name.strip().lower() == target:
                return tid
    except Exception as e:
        logger.warning("token resolve failed for %s/%s: %s", condition_id[:10], outcome, e)
    return None


class Trader:
    def __init__(self) -> None:
        self._clob = None

    def _client(self):
        if self._clob is not None:
            return self._clob
        if ClobClient is None:
            raise RuntimeError("py-clob-client-v2 not installed - run pip install -r requirements.txt")
        client = ClobClient(
            host=config.CLOB_API_URL,
            key=config.POLYMARKET_PRIVATE_KEY,
            chain_id=137,
            signature_type=config.POLYMARKET_SIGNATURE_TYPE,
            funder=config.POLYMARKET_FUNDER_ADDRESS or None,
        )
        creds = client.create_or_derive_api_creds()
        client.set_api_creds(creds)
        self._clob = client
        logger.info("CLOB client ready (sig_type=%d)", config.POLYMARKET_SIGNATURE_TYPE)
        return client

    def buy(self, token_id: str, price_cents: int, usd: float) -> dict:
        """Place a Fill-Or-Kill BUY for ~usd dollars at the given price.
        Returns { success, status, orderID, errorMsg }."""
        price = max(0.01, min(0.99, round(price_cents / 100, 2)))
        size = round(usd / price, 2)  # shares

        if config.DRY_RUN:
            logger.info("[DRY_RUN] would BUY %.2f shares @ %.2f ($%.2f) token=%s",
                        size, price, usd, token_id[:12])
            return {"success": True, "status": "dry_run", "orderID": "", "errorMsg": None}

        try:
            resp = self._client().create_and_post_order(
                OrderArgs(tokenID=token_id, price=price, size=size, side=BUY),
                options={"tickSize": 0.01},
                order_type="FOK",
            )
            raw = resp if isinstance(resp, dict) else {}
            return {
                "success": bool(raw.get("success", False)),
                "status": raw.get("status", "unknown"),
                "orderID": raw.get("orderID", ""),
                "errorMsg": raw.get("errorMsg"),
            }
        except Exception as e:
            logger.error("order failed: %s", e)
            return {"success": False, "status": "error", "orderID": "", "errorMsg": str(e)}
