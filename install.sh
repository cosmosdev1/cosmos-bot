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
[ -f ./config.json ] && node src/bot.mjs
