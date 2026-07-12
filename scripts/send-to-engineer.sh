#!/usr/bin/env bash
# Phase 5.66 — pipe Captain's reply (from Claude Desktop, pasted into
# the viewer's textarea) into the engineer-Claude tmux pane.
#
# Usage: send-to-engineer.sh <tmux_target> <reply_file>
#   tmux_target: e.g. 'manymuse-discover:1.1' (session:window.pane)
#   reply_file:  path to a file containing the reply markdown
#
# Uses tmux load-buffer + paste-buffer for clean multi-line paste
# (avoids per-newline send-keys interpretation that would prematurely
# submit each line as its own prompt). Sleep before Enter so tmux
# finishes flushing the paste into the target pane before submit —
# without it a ~500-line handoff can split-submit.

set -euo pipefail

TARGET="${1:-}"
REPLY_FILE="${2:-}"

if [[ -z "$TARGET" || -z "$REPLY_FILE" ]]; then
  echo "usage: $0 <tmux_target> <reply_file>" >&2
  exit 2
fi

if [[ ! -f "$REPLY_FILE" ]]; then
  echo "reply file not found: $REPLY_FILE" >&2
  exit 3
fi

# Verify the target exists before sending — avoids creating phantom
# panes or piping content into a long-dead session.
if ! tmux list-panes -t "$TARGET" -F '#{pane_id}' >/dev/null 2>&1; then
  echo "tmux target not alive: $TARGET" >&2
  exit 4
fi

# Load reply into a named tmux buffer, paste into target, send Enter.
# The named buffer + `-d` lets us delete the buffer after paste so
# nothing lingers in the tmux buffer stack.
# NOTE: no `-p` flag — that's the primary-buffer pull, which can
# race with what's already on the pane's clipboard at submit time.
BUFFER_NAME="captain-reply-$$"
tmux load-buffer -b "$BUFFER_NAME" "$REPLY_FILE"
tmux paste-buffer -b "$BUFFER_NAME" -t "$TARGET" -d

# Settle pause before Enter — large pastes need a beat for tmux to
# finish flushing into the pane. Without this a ~500-line handoff
# can split-submit at a partial point.
sleep 0.3

tmux send-keys -t "$TARGET" Enter

echo "ok: pasted $(wc -c < "$REPLY_FILE") bytes to $TARGET"
