#!/bin/bash
# UserPromptSubmit hook that emits the per-turn pacing directive.
#
# Wired into the agent's .claude/settings.json hooks.UserPromptSubmit by
# scaffold.ts when context_efficiency inject_on_change is enabled (the
# default). Replaces the inline `printf` that previously re-injected the
# static directive on every single turn, causing ~3 KB of redundant context
# per turn (measured ~290 KB over a 26-prompt session).
#
# Environment variables (set in the hook command by scaffold.ts):
#
#   TURN_PACING_DIRECTIVE - The full directive text to inject. Scaffold.ts
#                           embeds the directive in the hook command string.
#   TURN_PACING_HASH      - sha256 of the directive text (hex). Used to
#                           detect when the directive changed between
#                           scaffold regenerations.
#
# Inject-on-change semantics: on every fire:
#   1. Read session_id from stdin JSON.
#   2. Check per-session state file under $TELEGRAM_STATE_DIR/.hook-state/.
#   3. If session matches AND directive hash matches recorded state → emit
#      nothing (the model already has the directive in context).
#   4. Otherwise emit the directive and record the new state.
#
# Fail open: any error in state management falls back to emitting the full
# directive so context is never silently dropped.
#
# State files: $TELEGRAM_STATE_DIR/.hook-state/turn-pacing.<session_id>
# Each file contains: <directive_hash>\n
# Stale state files (different session_id) are cleaned up on each new-
# session write (keeps at most 5 files to avoid accumulation).

set -u

DIRECTIVE="${TURN_PACING_DIRECTIVE:-}"
DIRECTIVE_HASH="${TURN_PACING_HASH:-}"

# If directive or hash are missing, emit whatever we have and exit.
if [ -z "$DIRECTIVE" ]; then
  exit 0
fi

emit_full() {
  printf '%s\n' "$DIRECTIVE"
}

# Read stdin JSON to extract session_id.
SESSION_ID=""
if ! [ -t 0 ]; then
  STDIN_JSON=$(cat 2>/dev/null || true)
  if command -v jq >/dev/null 2>&1; then
    SESSION_ID=$(printf '%s' "$STDIN_JSON" | jq -r '.session_id // empty' 2>/dev/null || true)
  else
    SESSION_ID=$(printf '%s' "$STDIN_JSON" | grep -o '"session_id":"[^"]*"' | sed 's/"session_id":"//;s/"//' 2>/dev/null || true)
  fi
  # Sanitise: session_id must be alphanumeric + hyphens only.
  if ! printf '%s' "${SESSION_ID:-}" | grep -qE '^[a-zA-Z0-9_-]{1,128}$' 2>/dev/null; then
    SESSION_ID=""
  fi
fi

# If we can't get a session_id, emit full (fail-open).
if [ -z "$SESSION_ID" ]; then
  emit_full
  exit 0
fi

# If hash is missing, emit full (fail-open).
if [ -z "$DIRECTIVE_HASH" ]; then
  emit_full
  exit 0
fi

# Locate state dir. Prefer $TELEGRAM_STATE_DIR (set by start.sh in the
# container); fall back to $HOME/.claude/switchroom-hookcache for dev use.
STATE_BASE="${TELEGRAM_STATE_DIR:-${HOME:-/tmp}/.claude/switchroom-hookcache}"
HOOK_STATE_DIR="$STATE_BASE/.hook-state"

# Attempt to create the state dir; if that fails emit full (fail-open).
if ! mkdir -p "$HOOK_STATE_DIR" 2>/dev/null; then
  emit_full
  exit 0
fi

STATE_FILE="$HOOK_STATE_DIR/turn-pacing.$SESSION_ID"

# Check if already emitted for this session with the same directive.
if [ -f "$STATE_FILE" ]; then
  RECORDED=$(head -1 "$STATE_FILE" 2>/dev/null || echo "")
  if [ "$RECORDED" = "$DIRECTIVE_HASH" ]; then
    # Already injected and content unchanged — suppress.
    exit 0
  fi
fi

# New session or directive changed — emit and record state.
emit_full

# Write state: hash on first line.
printf '%s\n' "$DIRECTIVE_HASH" > "$STATE_FILE" 2>/dev/null || true

# Clean up stale state files (different session_id) — keep at most 5 files.
# shellcheck disable=SC2012
OLD_COUNT=$(ls -1 "$HOOK_STATE_DIR"/turn-pacing.* 2>/dev/null | grep -cv "turn-pacing\.$SESSION_ID$" || true)
if [ "$OLD_COUNT" -gt 5 ]; then
  ls -1t "$HOOK_STATE_DIR"/turn-pacing.* 2>/dev/null \
    | grep -v "turn-pacing\.$SESSION_ID$" \
    | tail -n +6 \
    | xargs rm -f 2>/dev/null || true
fi

exit 0
