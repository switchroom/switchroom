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
#   SWITCHROOM_AGENT_NAME       - The agent name (required, set in start.sh)
#   SWITCHROOM_INJECT_ON_CHANGE - When "1", enables inject-on-change
#                                 semantics: content is only emitted when the
#                                 session_id changes or file content changes.
#                                 HEARTBEAT.md is additionally gated: only
#                                 emitted when the prompt contains "heartbeat"
#                                 (case-insensitive) or when HEARTBEAT.md
#                                 itself changed. When "0" or unset (legacy
#                                 mode), content is emitted every turn as
#                                 before (full emit). Default in new agents
#                                 is "1" (set by scaffold.ts when
#                                 inject_on_change is true, the default).
#
# Failure modes (all silent — workspace injection must never block the turn):
#   - switchroom CLI missing  → exit 0 with no output
#   - workspace dir missing   → exit 0 with no output
#   - workspace render fails  → exit 0 with no output
#   - empty result set        → exit 0 with no output
#   - state dir error         → emit full content (fail-open)

set -u

AGENT_NAME="${SWITCHROOM_AGENT_NAME:-}"
INJECT_ON_CHANGE="${SWITCHROOM_INJECT_ON_CHANGE:-0}"

if [ -z "$AGENT_NAME" ]; then
  exit 0
fi

if ! command -v switchroom >/dev/null 2>&1; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Inject-on-change: read session_id and prompt from stdin JSON (when enabled)
# ---------------------------------------------------------------------------
SESSION_ID=""
PROMPT_TEXT=""
if [ "$INJECT_ON_CHANGE" = "1" ]; then
  # Read stdin (non-blocking: if no stdin supplied in tests, just skip).
  if ! [ -t 0 ]; then
    STDIN_JSON=$(cat 2>/dev/null || true)
    if command -v jq >/dev/null 2>&1; then
      SESSION_ID=$(printf '%s' "$STDIN_JSON" | jq -r '.session_id // empty' 2>/dev/null || true)
      PROMPT_TEXT=$(printf '%s' "$STDIN_JSON" | jq -r '.prompt // empty' 2>/dev/null || true)
    else
      SESSION_ID=$(printf '%s' "$STDIN_JSON" | grep -o '"session_id":"[^"]*"' | sed 's/"session_id":"//;s/"//' 2>/dev/null || true)
      PROMPT_TEXT=$(printf '%s' "$STDIN_JSON" | grep -o '"prompt":"[^"]*"' | sed 's/"prompt":"//;s/"//' 2>/dev/null || true)
    fi
    # Sanitise session_id — must be alphanumeric + hyphens only.
    if ! printf '%s' "${SESSION_ID:-}" | grep -qE '^[a-zA-Z0-9_-]{1,128}$' 2>/dev/null; then
      SESSION_ID=""
    fi
  fi
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
    # Fast path: every source is older than the cached body.
    # In inject-on-change mode, also check the session-state file — if the
    # session_id matches the last-emitted session AND the hash matches, we
    # can suppress entirely (model already has this content in context).
    if [ "$INJECT_ON_CHANGE" = "1" ] && [ -n "$SESSION_ID" ]; then
      SESSION_STATE_DIR="${TELEGRAM_STATE_DIR:-${HOME:-/tmp}/.claude/switchroom-hookcache}/.hook-state"
      SESSION_STATE_FILE="$SESSION_STATE_DIR/ws-dynamic.$SESSION_ID"
      if [ -f "$SESSION_STATE_FILE" ]; then
        RECORDED_HASH=$(head -1 "$SESSION_STATE_FILE" 2>/dev/null || echo "")
        # Read hash from body cache to compare with session state.
        CACHED_HASH=$(head -1 "$CACHE_FILE" 2>/dev/null || echo "")
        if [ -n "$CACHED_HASH" ] && [ "$CACHED_HASH" = "$RECORDED_HASH" ]; then
          # Same session, same content — suppress injection.
          exit 0
        fi
      fi
      # Different session or hash changed — emit, then update session state.
      mkdir -p "$SESSION_STATE_DIR" 2>/dev/null || true
      CACHED_HASH_FOR_STATE=$(head -1 "$CACHE_FILE" 2>/dev/null || echo "")
      if [ -n "$CACHED_HASH_FOR_STATE" ]; then
        printf '%s\n%s\n' "$CACHED_HASH_FOR_STATE" "$SESSION_ID" > "$SESSION_STATE_FILE" 2>/dev/null || true
      fi
    fi
    # Check HEARTBEAT suppression in inject-on-change mode.
    # HEARTBEAT.md content is filtered out unless prompt matches OR it changed.
    # (Suppression is handled by re-rendering with HEARTBEAT excluded; here
    # we emit the full body and rely on the HEARTBEAT-aware render path below.)
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

# ---------------------------------------------------------------------------
# HEARTBEAT.md gating (inject-on-change mode only).
#
# HEARTBEAT.md is a cron-updated "intentions" file that rarely changes
# mid-session. In inject-on-change mode we suppress it unless:
#   a) The prompt mentions "heartbeat" or "HEARTBEAT" (the cron scheduler's
#      own heartbeat-prompt pattern), OR
#   b) The HEARTBEAT.md file content changed since the last time we emitted it.
#
# Technique: compute a hash of the HEARTBEAT.md file directly (not the full
# render). Keep a separate per-session state entry for the HEARTBEAT hash.
# Strip the HEARTBEAT section from WS_DYNAMIC when suppressed, using awk.
# ---------------------------------------------------------------------------
if [ "$INJECT_ON_CHANGE" = "1" ]; then
  HEARTBEAT_FILE="$WS_DIR/HEARTBEAT.md"
  PROMPT_IS_HEARTBEAT=0
  # Case-insensitive substring match on the prompt text.
  if printf '%s' "${PROMPT_TEXT:-}" | grep -qi "heartbeat"; then
    PROMPT_IS_HEARTBEAT=1
  fi

  if [ "$PROMPT_IS_HEARTBEAT" = "0" ]; then
    # Compute hash of HEARTBEAT.md (if it exists).
    HB_HASH=""
    if [ -f "$HEARTBEAT_FILE" ]; then
      HB_HASH=$(sha256sum < "$HEARTBEAT_FILE" 2>/dev/null | cut -d' ' -f1 || true)
    fi

    # Check per-session HEARTBEAT state.
    HB_SUPPRESS=0
    if [ -n "$SESSION_ID" ]; then
      HB_STATE_DIR="${TELEGRAM_STATE_DIR:-${HOME:-/tmp}/.claude/switchroom-hookcache}/.hook-state"
      HB_STATE_FILE="$HB_STATE_DIR/ws-heartbeat.$SESSION_ID"
      if [ -f "$HB_STATE_FILE" ]; then
        RECORDED_HB_HASH=$(head -1 "$HB_STATE_FILE" 2>/dev/null || echo "")
        if [ -n "$HB_HASH" ] && [ "$HB_HASH" = "$RECORDED_HB_HASH" ]; then
          HB_SUPPRESS=1
        fi
      fi
      # Record current HEARTBEAT hash for this session (even if unchanged).
      if [ -n "$HB_HASH" ]; then
        mkdir -p "$HB_STATE_DIR" 2>/dev/null || true
        printf '%s\n%s\n' "$HB_HASH" "$SESSION_ID" > "$HB_STATE_FILE" 2>/dev/null || true
      fi
    fi

    if [ "$HB_SUPPRESS" = "1" ]; then
      # Strip the HEARTBEAT.md section from the rendered output. The
      # section starts at a line matching "## .*/HEARTBEAT.md" and ends
      # just before the next "## " section header (or end of output).
      WS_DYNAMIC=$(printf '%s' "$WS_DYNAMIC" | awk '
        /^## .*HEARTBEAT\.md/ { skip=1; next }
        /^## / { skip=0 }
        !skip { print }
      ' 2>/dev/null || printf '%s' "$WS_DYNAMIC")
      # If stripping left an empty body, emit nothing.
      WS_DYNAMIC_TRIMMED=$(printf '%s' "$WS_DYNAMIC" | tr -d '[:space:]' 2>/dev/null || true)
      if [ -z "$WS_DYNAMIC_TRIMMED" ]; then
        exit 0
      fi
    fi
  fi
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

# Session-state helper (shared by both the hash-match and hash-changed paths).
_ws_record_session_state() {
  local hash="$1" sid="$2"
  if [ -n "$hash" ] && [ -n "$sid" ]; then
    local sdir="${TELEGRAM_STATE_DIR:-${HOME:-/tmp}/.claude/switchroom-hookcache}/.hook-state"
    mkdir -p "$sdir" 2>/dev/null || true
    printf '%s\n%s\n' "$hash" "$sid" > "$sdir/ws-dynamic.$sid" 2>/dev/null || true
  fi
}

if [ -n "$NEW_HASH" ] && [ "$NEW_HASH" = "$OLD_HASH" ] && [ -f "$BODY_FILE" ]; then
  # Content unchanged since last render. In inject-on-change mode, check if
  # we already injected this content in the current session — if so, suppress.
  if [ "$INJECT_ON_CHANGE" = "1" ] && [ -n "$SESSION_ID" ]; then
    SESSION_STATE_DIR="${TELEGRAM_STATE_DIR:-${HOME:-/tmp}/.claude/switchroom-hookcache}/.hook-state"
    SESSION_STATE_FILE="$SESSION_STATE_DIR/ws-dynamic.$SESSION_ID"
    if [ -f "$SESSION_STATE_FILE" ]; then
      RECORDED_HASH=$(head -1 "$SESSION_STATE_FILE" 2>/dev/null || echo "")
      if [ "$RECORDED_HASH" = "$NEW_HASH" ]; then
        # Same session, same content — suppress injection.
        exit 0
      fi
    fi
    # New session or session state mismatch — emit and record.
    _ws_record_session_state "$NEW_HASH" "$SESSION_ID"
  fi
  cat "$BODY_FILE"
else
  # Refresh sidecar: write hash + body, then echo body. Touch the body
  # file last so the mtime fast-skip path next turn sees a fresh
  # mtime (newer than every source we just consumed).
  if [ -n "$NEW_HASH" ]; then
    printf '%s\n' "$NEW_HASH" > "$CACHE_FILE" 2>/dev/null || true
    printf '%s\n' "$WS_DYNAMIC" > "$BODY_FILE" 2>/dev/null || true
    if [ "$INJECT_ON_CHANGE" = "1" ] && [ -n "$SESSION_ID" ]; then
      _ws_record_session_state "$NEW_HASH" "$SESSION_ID"
    fi
  fi
  printf '%s\n' "$WS_DYNAMIC"
fi

exit 0
