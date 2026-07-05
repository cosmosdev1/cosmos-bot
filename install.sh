#!/usr/bin/env sh
# Cosmos bot installer (macOS / Linux).
#   curl -fsSL https://try-cosmos.com/bot/install.sh | COSMOS_TOKEN="csk_..." sh
set -e
REPO="https://github.com/cosmosdev1/cosmos-bot.git"
DIR="$HOME/cosmos-bot"

printf "\n  Installing the Cosmos bot...\n\n"
command -v node >/dev/null 2>&1 || { echo "  Node.js 18+ required: https://nodejs.org/"; exit 1; }
command -v git  >/dev/null 2>&1 || { echo "  git required: https://git-scm.com/"; exit 1; }

if [ -d "$DIR" ]; then cd "$DIR"; git pull --quiet; else git clone --quiet "$REPO" "$DIR"; cd "$DIR"; fi
npm install --silent

# Configure (uses COSMOS_TOKEN, asks only for your Polymarket key), then start trading.
node src/setup.mjs
# Restart loop: the bot exits cleanly after a self-update; pull + relaunch so local installs
# stay current instead of dying on every code push (the launcher contract).
export COSMOS_LAUNCHER=1
if [ -f ./config.json ]; then
  while true; do
    node src/bot.mjs
    sleep 3
    git pull --quiet 2>/dev/null || true
    npm install --silent 2>/dev/null || true
    echo "[launcher] restarting bot..."
  done
fi
