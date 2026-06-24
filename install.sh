#!/usr/bin/env sh
# Cosmos bot installer (macOS / Linux).
# Set REPO to your cosmos-bot repo, then:  curl -fsSL https://.../install.sh | sh
set -e
REPO="https://github.com/<your-org>/cosmos-bot.git"
DIR="$HOME/cosmos-bot"

printf "\n  Installing the Cosmos bot to %s\n\n" "$DIR"
command -v node >/dev/null 2>&1 || { echo "  Node.js 18+ required: https://nodejs.org/"; exit 1; }
command -v git  >/dev/null 2>&1 || { echo "  git required: https://git-scm.com/"; exit 1; }

if [ -d "$DIR" ]; then cd "$DIR"; git pull --quiet; else git clone --quiet "$REPO" "$DIR"; cd "$DIR"; fi
npm install --silent

printf "\n  Done. Next:\n\n    cd %s\n    npm run setup\n    npm start\n\n" "$DIR"
