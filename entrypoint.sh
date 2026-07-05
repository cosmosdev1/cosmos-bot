#!/usr/bin/env bash
# Self-updating launcher. Clones the bot, runs it, and on a schedule pulls the latest code and
# restarts it - so ONE push to the repo updates EVERY deployed bot automatically, on any host
# (Fly.io, a VPS, a Pi - anywhere this image runs). State lives in /data and persists across
# restarts, so updating mid-run is safe (the bot resumes its open positions).
set -u
REPO="${COSMOS_BOT_REPO:-https://github.com/cosmosdev1/cosmos-bot.git}"
BRANCH="${COSMOS_BOT_REF:-main}"
SRC=/app/repo
INTERVAL="${COSMOS_UPDATE_SECONDS:-600}"    # check for updates every 10 min so a repo push reaches every bot fast

if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$SRC"
fi
cd "$SRC"

export COSMOS_LAUNCHER=1  # tells the bot a restarter is present, so its self-update may exit

BOT_PID=""
start_bot() {
  npm install --omit=dev --no-audit --no-fund --silent || true
  node src/bot.mjs &
  BOT_PID=$!
  echo "[launcher] bot started (pid $BOT_PID) @ $(git rev-parse --short HEAD 2>/dev/null || echo '?')"
}

start_bot

while true; do
  sleep "$INTERVAL"
  BEFORE=$(git rev-parse HEAD 2>/dev/null || echo none)
  if git fetch --depth 1 origin "$BRANCH" --quiet 2>/dev/null; then
    # Reset to the FETCHED commit. Use FETCH_HEAD (which `git fetch` ALWAYS updates) rather than the
    # origin/<branch> tracking ref - a shallow fetch does NOT reliably update origin/<branch>, which is
    # the bug that left bots stuck on old code (the compare thought it was already current). Idempotent.
    git reset --hard FETCH_HEAD --quiet 2>/dev/null || true
  else
    echo "[launcher] git fetch failed; will retry in ${INTERVAL}s"
  fi
  AFTER=$(git rev-parse HEAD 2>/dev/null || echo none)
  if [ "$BEFORE" != "$AFTER" ]; then
    echo "[launcher] updated $BEFORE -> $AFTER; restarting bot with the new code"
    kill "$BOT_PID" 2>/dev/null || true
    wait "$BOT_PID" 2>/dev/null || true
    start_bot
    continue
  fi
  # crash recovery: if the bot process died, bring it back
  if ! kill -0 "$BOT_PID" 2>/dev/null; then
    echo "[launcher] bot not running; restarting"
    start_bot
  fi
done
