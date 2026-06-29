#!/usr/bin/env bash
# Cosmos bot - 24/7 deploy for a VPS in a Polymarket-ALLOWED country (e.g. Vultr -> Stockholm).
# Paste this into your server's "Startup Script" box. It installs Docker, builds the bot, and runs
# it 24/7 with auto-restart. Your Polymarket key stays on THIS server only - it never reaches Cosmos.
#
# Replace the three values below (the Cosmos dashboard fills COSMOS_TOKEN in for you).
set -e

# ===== YOUR VALUES =========================================================
export COSMOS_TOKEN="csk_PASTE_YOUR_COSMOS_TOKEN"
export POLYMARKET_PRIVATE_KEY="0xPASTE_YOUR_WALLET_PRIVATE_KEY"
export POLYMARKET_FUNDER="0xPASTE_YOUR_POLYMARKET_ADDRESS"
# ===========================================================================

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl ca-certificates
command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh

rm -rf /opt/cosmos-bot
git clone --depth 1 https://github.com/cosmosdev1/cosmos-bot.git /opt/cosmos-bot
cd /opt/cosmos-bot
docker build -t cosmos-bot .

docker rm -f cosmos-bot 2>/dev/null || true
docker run -d --name cosmos-bot --restart=always \
  -e COSMOS_TOKEN="$COSMOS_TOKEN" \
  -e POLYMARKET_PRIVATE_KEY="$POLYMARKET_PRIVATE_KEY" \
  -e POLYMARKET_FUNDER="$POLYMARKET_FUNDER" \
  -v /opt/cosmos-data:/data \
  cosmos-bot

echo "Cosmos bot deployed. It now runs 24/7 and restarts on reboot."
echo "Check it is working:  docker logs -f cosmos-bot   (look for 'geoblock: clear')"
