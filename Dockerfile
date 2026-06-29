# Portable, SELF-UPDATING image so the bot runs anywhere 24/7 — Fly.io, a $5 VPS, a Raspberry Pi.
# It's a thin launcher: at runtime it clones the latest bot code and, every hour, pulls new commits
# and restarts the bot — so ONE push updates EVERY deployed server automatically. The Cosmos token +
# Polymarket key are passed at RUNTIME as env vars; they are NEVER baked in.
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY entrypoint.sh ./entrypoint.sh
# Strip any CR (Windows line endings) so bash doesn't choke on \r, then make it executable.
RUN sed -i 's/\r$//' ./entrypoint.sh && chmod +x ./entrypoint.sh
ENV COSMOS_DATA_DIR=/data
ENV COSMOS_BOT_REPO=https://github.com/cosmosdev1/cosmos-bot.git
VOLUME /data
CMD ["bash", "/app/entrypoint.sh"]
