#!/bin/bash
# UserPromptSubmit hook for dynamic workspace bootstrap (MEMORY.md, daily
# notes).
#
# Wired into the agent's .claude/settings.json hooks.UserPromptSubmit by
# scaffold.ts. On every inbound user prompt, this script re-renders the
# dynamic workspace files and prints the result to stdout — Claude Code
# prepends this output to the user message as hook context.
#
# Configuration is via env vars (set at start.sh time):
#
#   SWITCHROOM_AGENT_NAME       - The agent name (required, set in start.sh)
#   SWITCHROOM_INJECT_ON_CHANGE - Inject-on-change semantics are the default:
#                                 content is only emitted when the session_id
#                                 changes or file content changes. Set to "0"
#                                 to opt out and emit every turn (legacy full
#                                 emit) — scaffold.ts threads this negation
#                                 only when an agent sets
#                                 channels.telegram.inject_on_change: false.
#
# Failure modes (all silent — workspace injection must never block the turn):
#   - switchroom CLI missing  → exit 0 with no output
#   - workspace dir missing   → exit 0 with no output
#   - workspace render fails  → exit 0 with no output
#   - empty result set        → exit 0 with no output
#   - state dir error         → emit full content (fail-open)

set -u

AGENT_NAME="${SWITCHROOM_AGENT_NAME:-}"
INJECT_ON_CHANGE="${SWITCHROOM_INJECT_ON_CHANGE:-1}"

if [ -z "$AGENT_NAME" ]; then
  exit 0
fi

if ! command -v switchroom >/dev/null 2>&1; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Inject-on-change: read session_id from stdin JSON (when enabled)
# ---------------------------------------------------------------------------
SESSION_ID=""
if [ "$INJECT_ON_CHANGE" != "0" ]; then
  # Read stdin (non-blocking: if no stdin supplied in tests, just skip).
  if ! [ -t 0 ]; then
    STDIN_JSON=$(cat 2>/dev/null || true)
    if command -v jq >/dev/null 2>&1; then
      SESSION_ID=$(printf '%s' "$STDIN_JSON" | jq -r '.session_id // empty' 2>/dev/null || true)
    else
      SESSION_ID=$(printf '%s' "$STDIN_JSON" | grep -o '"session_id":"[^"]*"' | sed 's/"session_id":"//;s/"//' 2>/dev/null || true)
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
# at midnight by varying the filename.
#
# Prior days' files are never cleaned up — there is no sweeper for this
# directory anywhere in the repo. That is deliberate and cheap, not an
# oversight: three small files per agent per day (~1100/year), a hash
# and a signature of 65 bytes each plus a body bounded by
# DEFAULT_DYNAMIC_TOTAL_MAX_CHARS. If that ever needs reclaiming it
# should be a real sweeper, not a comment claiming one exists.
#
# LOCAL time, not UTC — this MUST match the renderer. See
# `dailyMemoryRelativePath` in src/agents/workspace.ts, which derives
# today's daily-memory path from getFullYear/getMonth/getDate (local)
# on purpose: UTC would roll "today" over at early-morning for UTC+10
# hosts. When the hook used `date -u` here, every day from 00:00 until
# UTC midnight local the renderer's "today" file was absent from the
# hook's watch set, so writes to it did not invalidate the cache and a
# stale body was served.
CACHE_DATE="$(date +%Y-%m-%d)"
CACHE_FILE="$CACHE_DIR/workspace-dynamic.${CACHE_DATE}.hash"
BODY_FILE="$CACHE_DIR/workspace-dynamic.${CACHE_DATE}.body"
SIG_FILE="$CACHE_DIR/workspace-dynamic.${CACHE_DATE}.srcsig"

# Source-signature fast-skip: if BODY_FILE exists AND the signature of
# the workspace source *set* is byte-identical to the signature recorded
# when that body was produced, we can emit the cached body and skip the
# ~800ms `switchroom workspace render` invocation entirely. The renderer
# reads MEMORY.md, today's daily, yesterday's daily — see
# `loadDynamicBootstrapFiles` in src/agents/workspace.ts.
#
# The signature covers each source's name + mtime + size, and records
# missing files explicitly. A max-mtime comparison (the previous
# approach) could not see a *deletion*: a missing source contributed
# mtime 0, which never exceeded the body's mtime, so removing MEMORY.md
# served the cached body forever. It also lost any source modified
# between the render and the body write (the write-during-render race):
# such a source ended up older than the body and became invisible
# indefinitely. Capturing the signature *before* invoking the renderer
# closes both: anything that changes during or after the render window
# yields a different signature on the next turn.
#
# Forensics measured this fast-path saving ~825ms on the common case
# (chat turns where no source has changed since the last turn).
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
# Local-time "yesterday", matching addDays(now, -1) in workspace.ts.
YESTERDAY_DATE="$(date -d 'yesterday' +%Y-%m-%d 2>/dev/null || echo "")"
YESTERDAY_FILE="$WS_DIR/memory/${YESTERDAY_DATE}.md"

# Signature of the source set: name + mtime + size for each source the
# renderer reads, with missing files recorded explicitly so a deletion
# changes the signature.
#
# `%.9Y` (nanosecond mtime), NOT `%Y`. With whole-second mtimes, a
# content change that lands in the same second as the previous one and
# happens to keep the same file size produces an identical signature, so
# the edit is served stale indefinitely — until some later change moves
# the second or the size. That is strictly worse than the max-mtime
# comparison this replaced, which fell through on an equal-second
# collision (`-gt` is false when equal) and re-rendered. Nanosecond
# resolution closes it. If a filesystem reports a zero nanosecond field
# the signature degrades to second precision, i.e. exactly the old
# behaviour, never worse.
_ws_source_signature() {
  local src meta
  {
    for src in "$WS_DIR/MEMORY.md" "$TODAY_FILE" "$YESTERDAY_FILE"; do
      if [ -f "$src" ]; then
        meta=$(stat -c '%.9Y:%s' "$src" 2>/dev/null || echo "stat-error")
        printf '%s\t%s\n' "$src" "$meta"
      else
        printf '%s\tMISSING\n' "$src"
      fi
    done
  } | sha256sum 2>/dev/null | cut -d' ' -f1
}

# Captured BEFORE the renderer runs, so a source mutated during the
# render window is not falsely credited to this body.
SRC_SIG="$(_ws_source_signature)"

# Is the cached body intact? CACHE_FILE holds sha256 of the render output
# with no trailing newline; BODY_FILE holds that same output plus one
# trailing newline (or is empty for an empty render). Command substitution
# strips trailing newlines, so this reproduces the recorded hash exactly in
# both cases. Without it a body truncated by a crash mid-write is served to
# the model verbatim and pinned into the fast path forever, because the
# signature only vouches for the *sources*, never for the body. One sha256
# over at most DEFAULT_DYNAMIC_TOTAL_MAX_CHARS is negligible against the
# ~825ms render it guards.
_ws_body_intact() {
  local recorded actual
  recorded=$(head -1 "$CACHE_FILE" 2>/dev/null || echo "")
  [ -n "$recorded" ] || return 1
  actual=$(printf '%s' "$(cat "$BODY_FILE" 2>/dev/null)" | sha256sum 2>/dev/null | cut -d' ' -f1)
  [ -n "$actual" ] && [ "$actual" = "$recorded" ]
}

if [ -f "$BODY_FILE" ] && [ -f "$SIG_FILE" ] && [ -n "$SRC_SIG" ]; then
  RECORDED_SIG=$(head -1 "$SIG_FILE" 2>/dev/null || echo "")
  if [ "$RECORDED_SIG" = "$SRC_SIG" ] && _ws_body_intact; then
    # Fast path: the source set is unchanged since this body was made.
    # In inject-on-change mode, also check the session-state file — if the
    # session_id matches the last-emitted session AND the hash matches, we
    # can suppress entirely (model already has this content in context).
    if [ "$INJECT_ON_CHANGE" != "0" ] && [ -n "$SESSION_ID" ]; then
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
    cat "$BODY_FILE"
    exit 0
  fi
fi

# Render the dynamic workspace files (MEMORY.md, today/yesterday daily).
# The render command exits 0 and returns empty string if the workspace
# doesn't exist or all dynamic files are missing/empty, so no special-casing
# needed here.
#
# --warning-mode off: truncation warnings go to the stable render (where they
# can surface during scaffold/reconcile), not the per-turn path where they'd
# spam every turn.
#
# timeout 3: belt-and-braces so a hung render (disk I/O stall, etc) can't
# freeze the user's turn. The render is a few file reads and should finish in
# <50ms; 3s is generous headroom.
WS_DYNAMIC=$(timeout 3 switchroom workspace render "$AGENT_NAME" --dynamic --warning-mode off 2>/dev/null || true)

# An empty render IS cached. It used to `exit 0` here without writing the
# cache, on the theory that "caching an empty body would re-emit empty
# forever even after MEMORY comes back online" — that justification is
# obsolete: the fast-skip re-derives the source signature every turn, so a
# MEMORY.md that later appears (or any daily-memory write) changes the
# signature and forces a fresh render. Not caching it meant agents whose
# render is empty never had a cached body, the fast-skip never engaged, and
# they paid the full ~825ms-1.1s render on every single message to produce
# nothing.
#
# BODY_OUT is the exact byte string emitted on both the fresh and the cached
# path, so `cat "$BODY_FILE"` is byte-identical to a fresh emit (Anthropic's
# prompt cache is keyed on byte equality). Empty render → empty body file →
# empty stdout, not a bare newline.
if [ -n "$WS_DYNAMIC" ]; then
  BODY_OUT="$WS_DYNAMIC
"
else
  BODY_OUT=""
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
    [ -d "$sdir" ] || mkdir -p "$sdir" 2>/dev/null || true
    if [ -d "$sdir" ]; then
      printf '%s\n%s\n' "$hash" "$sid" > "$sdir/ws-dynamic.$sid" 2>/dev/null || true
      # Keep at most 5 ws-dynamic state files to bound growth.
      # shellcheck disable=SC2012
      local old_count
      old_count=$(ls -1 "$sdir"/ws-dynamic.* 2>/dev/null | grep -cv "ws-dynamic\.$sid$" || true)
      if [ "$old_count" -gt 5 ]; then
        ls -1t "$sdir"/ws-dynamic.* 2>/dev/null \
          | grep -v "ws-dynamic\.$sid$" \
          | tail -n +6 \
          | xargs rm -f 2>/dev/null || true
      fi
    fi
  fi
}

# Write a cache file atomically: fill a per-PID temp file, then rename it
# into place. A plain `>` redirect truncates first, so a concurrent hook
# process can observe (and cache, and serve) a half-written body. rename(2)
# is atomic within a filesystem, so a reader sees either the whole old file
# or the whole new one.
_ws_write_atomic() {
  local dest="$1" content="$2" tmp="$1.tmp.$$"
  if printf '%s' "$content" > "$tmp" 2>/dev/null; then
    mv -f "$tmp" "$dest" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
  else
    rm -f "$tmp" 2>/dev/null || true
  fi
}

# Publish the body and the pre-render source signature that vouches for it.
# Body first, signature second, both atomic: the signature is what arms the
# fast path, so it must never become visible before the body it describes.
# The signature is only written once the body file actually exists, so a
# failed body write can never leave a "fresh" signature pointing at a stale
# body.
_ws_publish() {
  _ws_write_atomic "$BODY_FILE" "$BODY_OUT"
  if [ -n "$SRC_SIG" ] && [ -f "$BODY_FILE" ]; then
    _ws_write_atomic "$SIG_FILE" "$SRC_SIG
"
  fi
}

if [ -n "$NEW_HASH" ] && [ "$NEW_HASH" = "$OLD_HASH" ] && [ -f "$BODY_FILE" ]; then
  # Rewrite the body unconditionally, even though the hash says it is
  # unchanged. NEW_HASH and OLD_HASH both derive from CACHE_FILE and the
  # fresh render — neither validates BODY_FILE — so a body truncated by a
  # crash mid-write would otherwise be cat'd to the model AND pinned into
  # the fast path by the signature we are about to stamp on it.
  _ws_publish
  # Content unchanged since last render. In inject-on-change mode, check if
  # we already injected this content in the current session — if so, suppress.
  if [ "$INJECT_ON_CHANGE" != "0" ] && [ -n "$SESSION_ID" ]; then
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
  # Refresh sidecar: write hash + body, then echo body.
  if [ -n "$NEW_HASH" ]; then
    _ws_write_atomic "$CACHE_FILE" "$NEW_HASH
"
    _ws_publish
    if [ "$INJECT_ON_CHANGE" != "0" ] && [ -n "$SESSION_ID" ]; then
      _ws_record_session_state "$NEW_HASH" "$SESSION_ID"
    fi
  fi
  printf '%s' "$BODY_OUT"
fi

exit 0
