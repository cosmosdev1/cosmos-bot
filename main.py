"""Cosmos Bot - pulls insider trades from the Cosmos API (the brain) and executes
them on Polymarket (your keys). Cosmos decides WHAT to trade; this bot just does it.

  python main.py
"""
from __future__ import annotations

import logging
import time

import config
import cosmos
import state
from filters import categorize, should_trade
from polymarket import Trader, resolve_token_id

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("cosmos-bot")


def run_once(trader: Trader) -> None:
    try:
        sigs = cosmos.signals()
    except Exception as e:
        log.error("could not fetch signals: %s", e)
        return
    log.info("fetched %d signals", len(sigs))

    for sig in sigs:
        key = f"{sig.get('condition_id')}|{sig.get('outcome')}"
        if state.already_done(key):
            continue

        ok, reason = should_trade(sig)
        if not ok:
            log.debug("skip %s (%s)", sig.get("market_question", "")[:40], reason)
            continue

        if state.today_count() >= config.MAX_OPEN_TRADES_PER_DAY:
            log.info("daily cap (%d) reached - holding.", config.MAX_OPEN_TRADES_PER_DAY)
            return

        token_id = resolve_token_id(sig["condition_id"], sig["outcome"])
        if not token_id:
            log.warning("no token id for %s / %s - skipping", sig.get("condition_id", "")[:10], sig.get("outcome"))
            continue

        cat = categorize(sig.get("market_question", ""))
        log.info(
            "TRADE [%s] %s -> BUY %s @ %dc | score %s | $%.0f",
            cat,
            sig.get("market_question", "")[:46],
            sig.get("outcome"),
            sig.get("price_cents", 0),
            sig.get("insider_score"),
            config.TRADE_USD,
        )
        res = trader.buy(token_id, sig["price_cents"], config.TRADE_USD)
        if res["success"]:
            state.record(key)
            log.info("  -> %s %s", res["status"], res.get("orderID", ""))
        else:
            log.error("  -> FAILED: %s", res.get("errorMsg"))


def main() -> None:
    print("=" * 64)
    print("  COSMOS BOT" + ("   [DRY RUN - no real orders]" if config.DRY_RUN else "   *** LIVE TRADING ***"))
    print("=" * 64)

    errs = config.validate()
    if errs:
        for e in errs:
            log.error("config: %s", e)
        return

    try:
        acct = cosmos.account()
        log.info("Cosmos OK - tier=%s, bot_access=%s", acct.get("tier"), acct.get("bot_access"))
    except Exception as e:
        log.error("Cosmos auth failed: %s", e)
        return

    log.info(
        "filters: score>=%d, price %d-%dc, $%.0f/trade, cap %d/day, allow=%s block=%s",
        config.MIN_INSIDER_SCORE, config.MIN_PRICE_CENTS, config.MAX_PRICE_CENTS,
        config.TRADE_USD, config.MAX_OPEN_TRADES_PER_DAY,
        config.CATEGORIES_ALLOW or "all", config.CATEGORIES_BLOCK or "none",
    )

    trader = Trader()
    while True:
        run_once(trader)
        time.sleep(config.POLL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nstopped.")
