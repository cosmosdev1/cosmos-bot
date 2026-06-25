# Portable image so the bot runs anywhere 24/7 — Render, Railway, Fly.io, a $4 VPS, a Raspberry Pi.
# The Cosmos token + Polymarket key are passed at RUNTIME as env vars; they are NEVER baked in.
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
ENV COSMOS_DATA_DIR=/data
VOLUME /data
CMD ["node", "src/bot.mjs"]
