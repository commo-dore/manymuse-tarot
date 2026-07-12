#!/usr/bin/env bash
# Handoff viewer for manymuse-tarot — port 8083, Windows node so it can
# bind the Tailscale IP (same pattern as sproushi-ops:8082 / discover:8081).
cd "$(dirname "$0")/.."
export PORT=8083
export HANDOFF_TMUX_SESSION=manymuse-tarot
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-$(grep '^ANTHROPIC_API_KEY=' "$HOME/projects/manymuse-discover/.env.local" | cut -d= -f2)}"
export WSLENV=PORT:HANDOFF_TMUX_SESSION:ANTHROPIC_API_KEY
exec node.exe scripts/handoff-viewer.js
