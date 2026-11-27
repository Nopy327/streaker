#!/bin/zsh
set -e

APP_DIR="${0:A:h}"
NODE_BIN="/Users/nopymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"

echo "Discord Streak Bot setup"
echo ""
echo "1. Create a Discord app and bot at https://discord.com/developers/applications"
echo "2. On Installation, enable User Install with applications.commands."
echo "3. Add the app to your account; no Discord server is required."
echo ""
echo "Your bot token stays in a private file on this Mac. Never share it in chat."
echo ""

read -rs "BOT_TOKEN?Paste the bot token: "
echo ""
printf '%s\n' "$BOT_TOKEN" | \
  "$NODE_BIN" --experimental-strip-types "$APP_DIR/scripts/save-discord-config.mjs"

echo ""
echo "Setup complete. Restart Start Streak Tracker.command, then use /connect in Discord."
read -r "?Press Return to close."
