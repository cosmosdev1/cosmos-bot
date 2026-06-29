#!/usr/bin/env bash
# Cosmos bot - 24/7 installer for a VPS in a Polymarket-ALLOWED country (e.g. Vultr -> Stockholm).
#
# Reads three values from the environment (the Cosmos dashboard fills COSMOS_TOKEN in for you):
#   COSMOS_TOKEN, POLYMARKET_PRIVATE_KEY, POLYMARKET_FUNDER
# Your Polymarket key stays on THIS server only - it never reaches Cosmos. Installs Docker and runs
# the bot 24/7 with auto-restart; state persists across reboots.
set -e

: "${COSMOS_TOKEN:?COSMOS_TOKEN is not set}"
: "${POLYMARKET_PRIVATE_KEY:?POLYMARKET_PRIVATE_KEY is not set}"

# Which build to run. "main" = the latest vetted build (this repo has a single trusted owner, so new
# servers always get the newest fixes). To freeze a release instead, set COSMOS_BOT_REF="v1.1.0".
REF="${COSMOS_BOT_REF:-main}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl ca-certificates
command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh

rm -rf /opt/cosmos-bot
git clone --depth 1 --branch "$REF" https://github.com/cosmosdev1/cosmos-bot.git /opt/cosmos-bot
cd /opt/cosmos-bot
docker build -t cosmos-bot .

docker rm -f cosmos-bot 2>/dev/null || true
docker run -d --name cosmos-bot --restart=always \
  -e COSMOS_TOKEN="$COSMOS_TOKEN" \
  -e POLYMARKET_PRIVATE_KEY="$POLYMARKET_PRIVATE_KEY" \
  -e POLYMARKET_FUNDER="${POLYMARKET_FUNDER:-}" \
  -v /opt/cosmos-data:/data \
  cosmos-bot

# Hardening: best-effort scrub of the key from this box's cloud-init artifacts after launch.
for f in /var/lib/cloud/instance/user-data.txt /var/lib/cloud/instances/*/user-data.txt; do
  shred -u "$f" 2>/dev/null || rm -f "$f" 2>/dev/null || true
done

echo ""
echo "Cosmos bot deployed - it now trades 24/7 and restarts on reboot."
echo "Check it:  docker logs -f cosmos-bot   (you want to see 'geoblock: clear')"
