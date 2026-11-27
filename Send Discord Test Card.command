#!/bin/zsh
set -e

APP_DIR="${0:A:h}"
NODE_BIN="/Users/nopymac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"

read "PERSON?Which connected card should be sent? [nopy]: "
if [[ -z "$PERSON" ]]; then
  PERSON="nopy"
fi

"$NODE_BIN" --experimental-strip-types "$APP_DIR/scripts/discord-streak-bot.mjs" --send-now "${PERSON:l}"
read -r "?Press Return to close."
