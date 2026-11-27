#!/bin/zsh

APP_DIR="/Users/nopymac/Documents/Codex/2026-09-09/are-y/outputs/streak-tracker"
NODE_BIN="/Users/nopymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
BOT_URL="http://127.0.0.1:3211/health"

clear
echo "Starting Streak Bot..."
echo ""

if curl --silent --fail "$BOT_URL" >/dev/null 2>&1; then
  echo "The Streak Bot is already running automatically."
  echo "You can close this window."
  read -r "?Press Return to close."
  exit 0
fi

if [[ ! -x "$NODE_BIN" ]]; then
  echo "The bot runtime is missing. Ask Codex to repair the Streak Bot."
  read -r "?Press Return to close."
  exit 1
fi

if [[ ! -f "$APP_DIR/.discord-bot/config.json" ]]; then
  echo "The bot has not been configured yet."
  echo "Run Configure Discord Bot.command first."
  read -r "?Press Return to close."
  exit 1
fi

cd "$APP_DIR"
echo "The bot is running. Keep this window open."
echo "Press Control-C when you want to stop it."
echo ""
exec "$NODE_BIN" --experimental-strip-types scripts/discord-streak-bot.mjs
