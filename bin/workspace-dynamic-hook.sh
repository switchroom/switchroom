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

# Cache directory shared with the post-render dedupe sidecar below. We
# need it earlier than the original code so the mtime-based fast-skip
# can read its body file before invoking the (~800ms) switchroom CLI.
CACHE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/switchroom-hookcache"
mkdir -p "$CACHE_DIR" 2>/dev/null || true
# Date-keyed cache filename: when the calendar day rolls over, the
# `today's daily` file path the renderer reads changes (the template
# embeds different filenames in its output), so we invalidate the cache
# at midnight UTC by varying the filename. Yesterday's file lingers
# harmlessly until the next sweep.
CACHE_DATE="$(date -u +%Y-%m-%d)"
CACHE_FILE="$CACHE_DIR/workspace-dynamic.${CACHE_DATE}.hash"
BODY_FILE="$CACHE_DIR/workspace-dynamic.${CACHE_DATE}.body"

# Mtime-fast-skip: if BODY_FILE exists AND is newer than every workspace
# source the renderer reads, we can emit the cached body and skip the
# ~800ms `switchroom workspace render` invocation entirely. The renderer
# reads MEMORY.md, HEARTBEAT.md, today's daily, yesterday's daily — see
# `loadDynamicBootstrapFiles` in src/agents/workspace.ts.
#
# Skip semantics: a source file that doesn't exist contributes a "very
# old" mtime (epoch-0 via stat fallback), which never invalidates the
# cache. A source file that's been updated since BODY_FILE's mtime
# triggers a fresh render. Forensics measured this fast-path saving
# ~825ms on the common case (chat turns where MEMORY/HEARTBEAT haven't
# changed since the last turn).
#
# Resolve the agent's workspace dir. Switchroom uses
# `~/.switchroom/agents/<name>/workspace/` by default. We avoid invoking
# the switchroom CLI here (would defeat the whole point of the
# fast-skip) — so derive directly from the conventional layout. If the
# operator has overridden `agents_dir` in switchroom.yaml, the fast-skip
# silently no-ops (cache miss; falls through to the renderer which
# resolves correctly).
AGENT_DIR="${SWITCHROOM_AGENT_DIR:-$HOME/.switchroom/agents/$AGENT_NAME}"
WS_DIR="$AGENT_DIR/workspace"
TODAY_FILE="$WS_DIR/memory/${CACHE_DATE}.md"
YESTERDAY_DATE="$(date -u -d 'yesterday' +%Y-%m-%d 2>/dev/null || echo "")"
YESTERDAY_FILE="$WS_DIR/memory/${YESTERDAY_DATE}.md"

if [ -f "$BODY_FILE" ]; then
  # Compare BODY_FILE mtime against every source. If any source is newer
  # the cache is stale; fall through. If all sources are older (or
  # missing), emit the cache and exit.
  body_mtime=$(stat -c '%Y' "$BODY_FILE" 2>/dev/null || echo 0)
  newest_src_mtime=0
  for src in "$WS_DIR/MEMORY.md" "$WS_DIR/HEARTBEAT.md" "$TODAY_FILE" "$YESTERDAY_FILE"; do
    if [ -f "$src" ]; then
      src_mtime=$(stat -c '%Y' "$src" 2>/dev/null || echo 0)
      if [ "$src_mtime" -gt "$newest_src_mtime" ]; then
        newest_src_mtime="$src_mtime"
      fi
    fi
  done
  if [ "$body_mtime" -gt "$newest_src_mtime" ]; then
    # Fast path: every source is older than the cached body. Emit and
    # skip the renderer entirely. Saves ~800ms cold-start of the
    # switchroom CLI plus the actual render work.
    cat "$BODY_FILE"
    exit 0
  fi
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
# render output is bit-for-bit identical to last turn — same body, no
# need to rewrite the body file. Cache files (CACHE_FILE/BODY_FILE)
# were declared at the top of the script for the mtime fast-skip;
# reuse them here.
NEW_HASH=$(printf '%s' "$WS_DYNAMIC" | sha256sum 2>/dev/null | cut -d' ' -f1)
OLD_HASH=""
if [ -f "$CACHE_FILE" ]; then
  OLD_HASH=$(head -1 "$CACHE_FILE" 2>/dev/null || echo "")
fi

if [ -n "$NEW_HASH" ] && [ "$NEW_HASH" = "$OLD_HASH" ] && [ -f "$BODY_FILE" ]; then
  cat "$BODY_FILE"
else
  # Refresh sidecar: write hash + body, then echo body. Touch the body
  # file last so the mtime fast-skip path next turn sees a fresh
  # mtime (newer than every source we just consumed).
  if [ -n "$NEW_HASH" ]; then
    printf '%s\n' "$NEW_HASH" > "$CACHE_FILE" 2>/dev/null || true
    printf '%s\n' "$WS_DYNAMIC" > "$BODY_FILE" 2>/dev/null || true
  fi
  printf '%s\n' "$WS_DYNAMIC"
fi

exit 0
