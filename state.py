"""Persisted state so the bot never double-buys a market and respects the daily cap."""
from __future__ import annotations

import json
import os
from datetime import date

_FILE = os.path.join(os.path.dirname(__file__), "state.json")


def _load() -> dict:
    try:
        with open(_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save(d: dict) -> None:
    with open(_FILE, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2)


def already_done(key: str) -> bool:
    return key in _load().get("executed", {})


def today_count() -> int:
    d = _load()
    if d.get("day") != date.today().isoformat():
        return 0
    return d.get("day_count", 0)


def record(key: str) -> None:
    d = _load()
    today = date.today().isoformat()
    if d.get("day") != today:
        d["day"] = today
        d["day_count"] = 0
    d.setdefault("executed", {})[key] = today
    d["day_count"] = d.get("day_count", 0) + 1
    _save(d)
