#!/bin/bash
# working-state-reload-hook.sh — deliver post-compaction continuation into
# context immediately after context compaction.
#
# WHY THIS EXISTS
# ---------------
# Claude Code auto-compacts late in the context window. The native
# auto-summarizer produces a structured summary of intent/changes/pending
# work, but it is lossy: fast-moving detail an agent is actively juggling
# mid-task (a checklist, the current plan, in-flight IDs, the exact "where
# was I" scratch, recent phrasing) is exactly what a summary flattens or
# drops. Worse, the model resuming from a summary can read it as a FRESH
# start and re-greet the user, breaking a conversation the user experiences
# as unbroken.
#
# This hook closes that gap deterministically, in two layers:
#   1. It ALWAYS emits a short, static recovery/orientation block — for
#      EVERY agent, whether or not it maintains a working-state file. This
#      is the load-bearing default: it tells the model its context was just
#      compacted mid-conversation, that the native summary is lossy, and
#      which concrete recovery tools exist in this environment.
#   2. If the agent maintains a working-state file AND it is non-empty, the
#      hook additionally appends that file verbatim (with its last-modified
#      time, so a stale/forgotten file is visibly stale rather than silently
#      steering).
#
# It is wired as a SessionStart hook with matcher "compact" (see
# src/agents/scaffold.ts buildSettingsHooksBlock). Per Claude Code's hook
# contract:
#   - SessionStart fires with source="compact" on auto OR manual compaction,
#     mid-turn, right after the compaction boundary.
#   - Text a SessionStart hook prints to stdout IS added to the model's
#     context (unlike PreCompact stdout, which is NOT injected).
# So printing here re-seats orientation (and any working state) into context
# the instant the summary replaces the transcript — no marker file, no
# gateway round-trip, no waiting for the next user message.
#
# The matcher "compact" is load-bearing: it scopes this hook to compaction
# ONLY. A bare (matcher-less) SessionStart also fires on "startup", "resume",
# "clear", and "fork", which would inject the recovery block on every boot —
# noise, and prompt-cache churn. We rely on the matcher AND, belt-and-braces,
# re-check the `source` field from stdin below so a future Claude Code matcher
# regression can never turn this into an every-boot inject.
#
# THE WORKING-STATE FILE CONVENTION
# ---------------------------------
#   $TELEGRAM_STATE_DIR/.working-state.md
# i.e. <agentDir>/telegram/.working-state.md (TELEGRAM_STATE_DIR is exported
# by start.sh as "<agentDir>/telegram"). An agent maintains this file itself
# as its durable scratch of "what I'm mid-way through". If the file is absent
# or empty — the common case for agents that don't use it — the hook simply
# skips the append; the static recovery block is still emitted. No file is
# ever created here.
#
# PERFORMANCE
# -----------
# SessionStart hooks run on every matching session start and must be fast.
# This one is a heredoc string plus, at most, one `stat` and one `cat` of a
# small file: no network, no heavy interpreter, no CLI invocation. Sub-second
# by construction. (Contrast the hindsight session_start.py SessionStart hook,
# which times out at its 5s budget on every firing — a separate, independent
# post-compaction context-loss cause tracked against the hindsight-memory
# plugin, NOT fixed here.)
#
# Failure modes are all silent: a hook that errors would surface on the issues
# card via run-hook.sh, but a missing/absent working-state file or an
# unreadable mtime is never an error — the recovery block still emits and the
# hook exits 0.

set -u

# ---------------------------------------------------------------------------
# Defensive source guard. The matcher "compact" in settings.json already
# scopes Claude Code to fire this hook only on compaction, but we re-verify
# the source from the hook's stdin JSON so a matcher regression (or a manual
# mis-wire) can never cause this to inject on a normal startup/resume/clear/
# fork boot. If stdin carries a `source` and it is not "compact", exit
# silently. If there is no stdin (e.g. a unit test invoking the script
# directly), fall through and trust the matcher.
# ---------------------------------------------------------------------------
if ! [ -t 0 ]; then
  STDIN_JSON=$(cat 2>/dev/null || true)
  if [ -n "${STDIN_JSON:-}" ]; then
    SOURCE=""
    if command -v jq >/dev/null 2>&1; then
      SOURCE=$(printf '%s' "$STDIN_JSON" | jq -r '.source // empty' 2>/dev/null || true)
    else
      SOURCE=$(printf '%s' "$STDIN_JSON" \
        | grep -o '"source"[[:space:]]*:[[:space:]]*"[^"]*"' \
        | head -1 \
        | sed 's/.*"source"[[:space:]]*:[[:space:]]*"//;s/"$//' 2>/dev/null || true)
    fi
    if [ -n "$SOURCE" ] && [ "$SOURCE" != "compact" ]; then
      exit 0
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Static recovery/orientation block. ALWAYS emitted on a compaction start,
# for EVERY agent — this is the load-bearing default. Plain stdout from a
# SessionStart hook IS added to the model's context by Claude Code, so this
# re-orients the model the instant the native summary replaces the transcript.
# Deterministic heredoc string: no network, no CLI fork.
# ---------------------------------------------------------------------------
cat <<'EOF'
<compact-recovery source="switchroom working-state-reload hook">
Your context was just COMPACTED mid-conversation. This is NOT a fresh start:
you are CONTINUING a conversation the user experiences as unbroken. The native
summary above is lossy — it flattens or drops fast-moving detail (in-flight
IDs, the exact "where was I", recent phrasing). Do not greet the user or act
as if starting over; pick up where the conversation left off.

Re-orient using the recovery tools in THIS environment before continuing:
  - Telegram chat history: the get_recent_messages MCP tool
    (mcp__switchroom-telegram__get_recent_messages) to re-read what was just
    being discussed.
  - Hindsight memory: recall / reflect (mcp__hindsight__recall,
    mcp__hindsight__reflect) for facts and decisions from earlier sessions.
  - Workspace files for durable task state.
</compact-recovery>
EOF

# ---------------------------------------------------------------------------
# Resolve the working-state file. Primary: $TELEGRAM_STATE_DIR (exported by
# start.sh for telegram-plugin agents). Fallback: derive the conventional
# telegram state dir from the agent name, so the hook still works if invoked
# in a context where TELEGRAM_STATE_DIR is not exported. If neither resolves,
# skip the append — the recovery block above already emitted.
# ---------------------------------------------------------------------------
STATE_DIR="${TELEGRAM_STATE_DIR:-}"
if [ -z "$STATE_DIR" ]; then
  AGENT_NAME="${SWITCHROOM_AGENT_NAME:-}"
  if [ -n "$AGENT_NAME" ] && [ -n "${HOME:-}" ]; then
    STATE_DIR="$HOME/.switchroom/agents/$AGENT_NAME/telegram"
  fi
fi

if [ -z "$STATE_DIR" ]; then
  exit 0
fi

WORKING_STATE_FILE="$STATE_DIR/.working-state.md"

# Absent or empty → nothing to append. The recovery block above is enough.
if [ ! -s "$WORKING_STATE_FILE" ]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Resolve the working-state file's last-modified time so a stale, forgotten
# file is VISIBLY stale to the model rather than silently steering it. Try a
# portable sequence: GNU/busybox `stat -c %y`, then BSD/macOS `stat -f %Sm`,
# then GNU `date -r <file>`. If none work, omit the mtime — never fail the
# hook over it.
# ---------------------------------------------------------------------------
MTIME=""
if MTIME=$(stat -c %y "$WORKING_STATE_FILE" 2>/dev/null) && [ -n "$MTIME" ]; then
  :
elif MTIME=$(stat -f '%Sm' "$WORKING_STATE_FILE" 2>/dev/null) && [ -n "$MTIME" ]; then
  :
elif MTIME=$(date -r "$WORKING_STATE_FILE" 2>/dev/null) && [ -n "$MTIME" ]; then
  :
else
  MTIME=""
fi

# ---------------------------------------------------------------------------
# Append the working state verbatim, wrapped in its own delimiter block. The
# header line carries the mtime (when resolvable) so a stale file reads as
# stale.
# ---------------------------------------------------------------------------
printf '%s\n' '<working-state source="switchroom working-state-reload hook">'
if [ -n "$MTIME" ]; then
  printf '%s\n' 'The following is your working-state file ('"$WORKING_STATE_FILE"', last updated '"$MTIME"'),'
else
  printf '%s\n' 'The following is your working-state file ('"$WORKING_STATE_FILE"'),'
fi
printf '%s\n' 'reloaded verbatim so in-flight task state survives the summarizer. It may'
printf '%s\n' 'be stale — reconcile it against the summary and the recovery tools above'
printf '%s\n' 'before trusting it, then continue.'
printf '%s\n' '---'
cat "$WORKING_STATE_FILE"
printf '\n%s\n' '</working-state>'

exit 0
