#!/bin/zsh
set -e

APP_DIR="${0:A:h}"
NODE_DIR="/Users/nopymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
NODE_BIN="$NODE_DIR/node"
APP_URL="http://localhost:3210"
FRESH_URL="$APP_URL/?refresh=$(date +%s)"
BOT_URL="http://127.0.0.1:3211/health"

cd "$APP_DIR"

if [[ ! -x "$NODE_BIN" ]]; then
  echo "The local app runtime is missing. Please ask Codex to restore the streak tracker dependencies."
  read -r "?Press Return to close."
  exit 1
fi

export PATH="$NODE_DIR:$PATH"
if curl --silent --fail "$APP_URL" >/dev/null 2>&1; then
  open "$FRESH_URL"
  echo "Streak Tracker is already running at $APP_URL"
  exit 0
fi

echo "Preparing the local app..."
"$NODE_BIN" "$APP_DIR/node_modules/vinext/dist/cli.js" build

BOT_PID=""
if ! curl --silent --fail "$BOT_URL" >/dev/null 2>&1; then
  "$NODE_BIN" --experimental-strip-types "$APP_DIR/scripts/discord-streak-bot.mjs" &
  BOT_PID=$!
fi

"$NODE_BIN" "$APP_DIR/node_modules/vinext/dist/cli.js" start --port 3210 --hostname localhost &
SERVER_PID=$!

function stop_services() {
  kill "$SERVER_PID" 2>/dev/null || true
  if [[ -n "$BOT_PID" ]]; then
    kill "$BOT_PID" 2>/dev/null || true
  fi
}

trap stop_services EXIT INT TERM

for attempt in {1..40}; do
  if curl --silent --fail "$APP_URL" >/dev/null 2>&1; then
    open "$FRESH_URL"
    break
  fi
  sleep 0.25
done

echo ""
echo "Streaker is running at $APP_URL"
echo "Discord daily reports are active when configured."
echo "Keep this window open. Press Control-C to stop the app."
wait "$SERVER_PID"
