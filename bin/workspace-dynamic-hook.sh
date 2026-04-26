#!/bin/bash
# UserPromptSubmit hook for dynamic workspace bootstrap (MEMORY.md, daily
# notes, HEARTBEAT.md).
#
# Wired into the agent's .claude/settings.json hooks.UserPromptSubmit by
# scaffold.ts. On every inbound user prompt, this script re-renders the
# dynamic workspace files and prints the result to stdout — Claude Code
# prepends this output to the user message as hook context.
#
# Configuration is via env vars (set at start.sh time):
#
#   SWITCHROOM_AGENT_NAME - The agent name (required, set in start.sh)
#
# Failure modes (all silent — workspace injection must never block the turn):
#   - switchroom CLI missing  → exit 0 with no output
#   - workspace dir missing   → exit 0 with no output
#   - workspace render fails  → exit 0 with no output
#   - empty result set        → exit 0 with no output

set -u

AGENT_NAME="${SWITCHROOM_AGENT_NAME:-}"

if [ -z "$AGENT_NAME" ]; then
  exit 0
fi

if ! command -v switchroom >/dev/null 2>&1; then
  exit 0
fi

# Render the dynamic workspace files (MEMORY.md, today/yesterday daily,
# HEARTBEAT.md). The render command exits 0 and returns empty string if the
# workspace doesn't exist or all dynamic files are missing/empty, so no
# special-casing needed here.
#
# --warning-mode off: truncation warnings go to the stable render (where they
# can surface during scaffold/reconcile), not the per-turn path where they'd
# spam every turn.
#
# timeout 3: belt-and-braces so a hung render (disk I/O stall, etc) can't
# freeze the user's turn. The render is a few file reads and should finish in
# <50ms; 3s is generous headroom.
WS_DYNAMIC=$(timeout 3 switchroom workspace render "$AGENT_NAME" --dynamic --warning-mode off 2>/dev/null || true)

# Empty render → emit nothing AND do NOT cache the empty body. Caching an
# empty body would re-emit empty forever even after MEMORY/HEARTBEAT come
# back online, defeating the whole purpose of the hook.
if [ -z "$WS_DYNAMIC" ]; then
  exit 0
fi

# Content-addressed dedupe sidecar. Anthropic's prompt cache is keyed on
# byte equality, so re-emitting the exact same dynamic block across turns
# preserves the cache prefix. The hash file lets us detect when the
# render output is bit-for-bit identical to last turn — in which case we
# replay the cached body (cheap) rather than printing the freshly-
# rendered string (which may differ only in non-semantic whitespace
# from earlier renders, but would still hash the same and thus be a no-op
# either way; the real win is upstream when MEMORY/HEARTBEAT change rate
# is split). Cache lives under $CLAUDE_CONFIG_DIR (per-agent), which is
# NOT swept by vault-sweep.ts (it only prunes projects/*.jsonl + SQLite).
CACHE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/switchroom-hookcache"
mkdir -p "$CACHE_DIR" 2>/dev/null || true
CACHE_FILE="$CACHE_DIR/workspace-dynamic.hash"
BODY_FILE="$CACHE_DIR/workspace-dynamic.body"

NEW_HASH=$(printf '%s' "$WS_DYNAMIC" | sha256sum 2>/dev/null | cut -d' ' -f1)
OLD_HASH=""
if [ -f "$CACHE_FILE" ]; then
  OLD_HASH=$(head -1 "$CACHE_FILE" 2>/dev/null || echo "")
fi

if [ -n "$NEW_HASH" ] && [ "$NEW_HASH" = "$OLD_HASH" ] && [ -f "$BODY_FILE" ]; then
  cat "$BODY_FILE"
else
  # Refresh sidecar atomically(-ish): write hash + body, then echo body.
  # We don't fsync — the worst case is a stale hash that gets
  # overwritten next turn, which is harmless.
  if [ -n "$NEW_HASH" ]; then
    printf '%s\n' "$NEW_HASH" > "$CACHE_FILE" 2>/dev/null || true
    printf '%s\n' "$WS_DYNAMIC" > "$BODY_FILE" 2>/dev/null || true
  fi
  printf '%s\n' "$WS_DYNAMIC"
fi

exit 0
