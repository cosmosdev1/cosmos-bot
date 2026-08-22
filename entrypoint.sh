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

# PINNING (fixed 2026-07-21 after an external audit). We documented "pin COSMOS_BOT_REF to a commit
# SHA and the bot will never move", but the clone below used `--branch "$REF"`, and git's --branch
# accepts ONLY branch and tag names - a SHA fails with "Remote branch <sha> not found in upstream
# origin" and the bot never starts. The repo also has zero tags, so the documented escape hatch did
# not exist in practice: every install was unpinned, and "audit the public source" meant auditing
# code that could be replaced 10 minutes later. A pin is the only way an audit can mean anything,
# so it has to actually work. A SHA is fetched directly (GitHub serves arbitrary reachable SHAs)
# and checked out detached; a branch/tag keeps the old fast path.
case "$BRANCH" in
  *[!0-9a-fA-F]* | "") PINNED=0 ;;                       # contains a non-hex char -> a branch or tag
  ???????*)            PINNED=1 ;;                       # 7+ hex chars -> a commit SHA
  *)                   PINNED=0 ;;
esac

if [ ! -d "$SRC/.git" ]; then
  if [ "$PINNED" = "1" ]; then
    mkdir -p "$SRC"
    git init -q "$SRC"
    git -C "$SRC" remote add origin "$REPO"
    if git -C "$SRC" fetch --depth 1 origin "$BRANCH" --quiet 2>/dev/null; then
      git -C "$SRC" checkout -q --detach FETCH_HEAD
      echo "[launcher] PINNED to $BRANCH - auto-update is disabled for this machine"
    else
      echo "[launcher] could not fetch pinned commit $BRANCH - refusing to silently fall back to main."
      echo "[launcher] use the FULL 40-character commit SHA (GitHub cannot serve an abbreviated one),"
      echo "[launcher] or unset COSMOS_BOT_REF to follow main."
      exit 1
    fi
  else
    git clone --depth 1 --branch "$BRANCH" "$REPO" "$SRC"
  fi
fi
cd "$SRC"

export COSMOS_LAUNCHER=1  # tells the bot a restarter is present, so its self-update may exit

# Which entry file this machine runs. Default is the single-tenant bot (every legacy machine, no
# behaviour change); the hosted-runner app sets COSMOS_ENTRY=src/runner.mjs and gets the SAME
# self-updating launcher - one push to the repo updates the supervisor exactly like it updates bots.
ENTRY="${COSMOS_ENTRY:-src/bot.mjs}"

BOT_PID=""
start_bot() {
  # SUPPLY CHAIN (security sweep 2026-07-22): npm ci against the committed lockfile, with lifecycle
  # scripts DISABLED. This install runs next to POLYMARKET_PRIVATE_KEY in process.env after every
  # 10-minute auto-pull - with scripts enabled, a compromised transitive dependency's postinstall
  # would execute inside every bot in the fleet within one update window. Our deps (viem, ws,
  # @polymarket/clob-client-v2) are pure JS and need no build scripts; ws's optional native addons
  # are skipped harmlessly. npm install remains only as the fallback for a lock desync, so a bad
  # lockfile can never brick the fleet - it logs loudly instead.
  # INSTALL IS VERIFIED OR THE BOT DOES NOT START (fleet crash 2026-08-21/22). A network blip
  # mid-install left node_modules half-written, the old `|| true` started the runner on the broken
  # tree anyway, and every child then died at boot on MODULE_NOT_FOUND - a fleet-wide crash-loop
  # that could never heal, because the surviving runner never re-triggers an install. Now: give any
  # straggler children time to die before touching the tree (their SIGKILL fallback is 10s), retry
  # the install with a canary require of real deps, and if the tree still cannot be verified, WAIT
  # and retry rather than start broken - a delayed start costs minutes, a broken start costs the
  # whole fleet.
  sleep 12
  INSTALL_OK=0
  for ATTEMPT in 1 2 3 4; do
    if [ "$ATTEMPT" = "4" ]; then rm -rf node_modules; fi   # last resort: clean slate
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent       || npm install --omit=dev --ignore-scripts --no-audit --no-fund --silent || true
    if node -e "['viem','ws','form-data','asynckit'].forEach(function(m){require.resolve(m)})" 2>/dev/null; then
      INSTALL_OK=1; break
    fi
    echo "[launcher] dependency tree failed verification (attempt $ATTEMPT); retrying in 20s"
    sleep 20
  done
  if [ "$INSTALL_OK" != "1" ]; then
    echo "[launcher] REFUSING to start on a broken dependency tree - will retry on the next cycle"
    return 1 2>/dev/null || true
  fi
  node "$ENTRY" &
  BOT_PID=$!
  echo "[launcher] bot started (pid $BOT_PID) @ $(git rev-parse --short HEAD 2>/dev/null || echo '?')"
}

start_bot

while true; do
  sleep "$INTERVAL"
  # A pinned machine NEVER auto-updates - that is the entire point of pinning. It still restarts the
  # bot if the process dies (crash recovery below), just always on the reviewed commit.
  if [ "$PINNED" = "1" ]; then
    if ! kill -0 "$BOT_PID" 2>/dev/null; then
      echo "[launcher] bot not running; restarting (pinned $BRANCH)"
      start_bot
    fi
    continue
  fi
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
