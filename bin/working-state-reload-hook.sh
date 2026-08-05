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
# This hook closes that gap deterministically, in three layers:
#   1. It ALWAYS emits a short, static recovery/orientation block — for
#      EVERY agent, whether or not it maintains a working-state file. This
#      is the load-bearing default: it tells the model its context was just
#      compacted mid-conversation, that the native summary is lossy, and
#      which concrete recovery tools exist in this environment.
#   2. If the agent maintains a working-state file AND it is non-empty, the
#      hook additionally appends that file verbatim (with its last-modified
#      time, so a stale/forgotten file is visibly stale rather than silently
#      steering).
#   3. It emits a LEAN briefing (P1) — a scoped recent Telegram tail + a
#      Hindsight recall — so the compacted session gets fresh-boot PARITY:
#      it picks up the actual conversation, not just the fact it was
#      compacted. This is delegated to handoff-briefing.sh --lean (the SINGLE
#      briefing assembler; no copy of the sqlite/recall logic here), so BOTH
#      legacy- and gateway-briefing agents share one compaction re-seat path.
#      Lean by design: it skips daily-memory/workspace re-render (token
#      duplication — the native summary already keeps recent turns) and
#      ignores SWITCHROOM_PENDING_* to brief the db-latest chat surface rather
#      than a stale pending-turn one. Graceful: if history.db or Hindsight is
#      unavailable it emits what it can (or nothing) and never fails the hook.
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
# The static recovery block and working-state append are local-only (a heredoc
# plus at most one `stat`/`cat` of a small file) — sub-second. The lean
# briefing (layer 3) adds one local SQLite read and ONE network hop to
# Hindsight, which handoff-briefing.sh caps (HANDOFF_BRIEFING_HINDSIGHT_TIMEOUT,
# default 3s). Worst-case runtime is therefore a few seconds, dominated by that
# cap; the SessionStart(compact) hook's Claude Code timeout is set accordingly
# in src/agents/scaffold.ts. Latency here is a non-issue by design: compaction
# itself takes far longer, and the prompt cache is already invalidated by the
# summary replacing the transcript. (Contrast the hindsight session_start.py
# SessionStart hook, which times out at its 5s budget on every firing — a
# separate, independent context-loss cause tracked against the hindsight-memory
# plugin, NOT fixed here.)
#
# Failure modes are all silent: a hook that errors would surface on the issues
# card via run-hook.sh, but a missing/absent working-state file, an unreadable
# mtime, a missing history.db, or an unreachable Hindsight is never an error —
# the recovery block still emits and the hook exits 0.

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
# skip the working-state append — the recovery block above already emitted,
# and the lean briefing below still runs.
#
# NOTE: this is a GUARDED block (not an early `exit`), because the lean
# post-compaction briefing further down must run for EVERY compaction,
# including the common case of an agent that keeps no working-state file.
# ---------------------------------------------------------------------------
STATE_DIR="${TELEGRAM_STATE_DIR:-}"
if [ -z "$STATE_DIR" ]; then
  AGENT_NAME="${SWITCHROOM_AGENT_NAME:-}"
  if [ -n "$AGENT_NAME" ] && [ -n "${HOME:-}" ]; then
    STATE_DIR="$HOME/.switchroom/agents/$AGENT_NAME/telegram"
  fi
fi

WORKING_STATE_FILE=""
if [ -n "$STATE_DIR" ]; then
  WORKING_STATE_FILE="$STATE_DIR/.working-state.md"
fi

# Append the working state only when the file resolves AND is non-empty.
if [ -n "$WORKING_STATE_FILE" ] && [ -s "$WORKING_STATE_FILE" ]; then
  # -------------------------------------------------------------------------
  # Resolve the working-state file's last-modified time so a stale, forgotten
  # file is VISIBLY stale to the model rather than silently steering it. Try a
  # portable sequence: GNU/busybox `stat -c %y`, then BSD/macOS `stat -f %Sm`,
  # then GNU `date -r <file>`. If none work, omit the mtime — never fail the
  # hook over it.
  # -------------------------------------------------------------------------
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

  # -------------------------------------------------------------------------
  # Append the working state verbatim, wrapped in its own delimiter block. The
  # header line carries the mtime (when resolvable) so a stale file reads as
  # stale.
  # -------------------------------------------------------------------------
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
fi

# ---------------------------------------------------------------------------
# Lean post-compaction briefing (P1). ADDITIVE on source=compact, after the
# static recovery block and the optional working-state append. It re-seats the
# compacted session to fresh-boot PARITY: a scoped recent Telegram tail + a
# Hindsight recall, so the agent picks up the actual conversation rather than
# only being TOLD it was compacted.
#
# DRY: the assembly is delegated to handoff-briefing.sh --lean — the SINGLE
# briefing assembler. No copy of the sqlite/recall logic lives here. Lean mode
# emits ONLY the Telegram-tail + recall (daily-memory and the boot header are
# skipped — token duplication, the native summary already keeps recent turns),
# and IGNORES SWITCHROOM_PENDING_* to derive the db-latest surface (a stale
# pending-turn scope would brief the wrong chat at a mid-session compaction).
#
# SHARED PATH: this hook fires on SessionStart(compact) for EVERY agent,
# regardless of session_continuity.briefing mode (legacy vs gateway), so both
# modes get identical compaction re-seat through this one path.
#
# GRACEFUL: if the assembler script is not found, or emits nothing (no
# history.db, Hindsight unreachable), the block is simply omitted. The lean
# briefing NEVER fails the hook — the recovery block above already stands on
# its own. handoff-briefing.sh caps its only network hop (Hindsight) at a few
# seconds, so runtime is bounded.
# ---------------------------------------------------------------------------
BRIEFING_SCRIPT=""
_HOOK_DIR=$(dirname -- "$0" 2>/dev/null || true)
if [ -n "$_HOOK_DIR" ] && [ -r "$_HOOK_DIR/handoff-briefing.sh" ]; then
  BRIEFING_SCRIPT="$_HOOK_DIR/handoff-briefing.sh"
elif command -v handoff-briefing.sh >/dev/null 2>&1; then
  BRIEFING_SCRIPT="handoff-briefing.sh"
fi

if [ -n "$BRIEFING_SCRIPT" ]; then
  # Inner timeout, SHORTER than the 8s Claude Code hook budget, so a slow
  # assembler degrades to "recovery block only" instead of losing everything.
  # Without it, if the assembler runs long (e.g. an operator raises
  # HANDOFF_BRIEFING_HINDSIGHT_TIMEOUT past the hook budget) Claude Code kills
  # the WHOLE hook at 8s and discards ALL stdout — including the near-unkillable
  # <compact-recovery> orientation block already printed above. Capping the
  # assembler at 5s keeps the #4390 recovery floor intact. `timeout` is
  # coreutils (present in the agent image); fall back to an un-timed call if it
  # is somehow unavailable, so the lean briefing still works.
  if command -v timeout >/dev/null 2>&1; then
    LEAN_BRIEFING=$(timeout 5 bash "$BRIEFING_SCRIPT" --lean 2>/dev/null || true)
  else
    LEAN_BRIEFING=$(bash "$BRIEFING_SCRIPT" --lean 2>/dev/null || true)
  fi
  if [ -n "$LEAN_BRIEFING" ]; then
    printf '%s\n' '<compact-briefing source="switchroom working-state-reload hook">'
    printf '%s\n' 'The recent conversation and recalled memory below are re-seated so this'
    printf '%s\n' 'compacted session has the same footing as a fresh boot. Use them to pick up'
    printf '%s\n' 'the thread; reconcile against the native summary above before trusting either.'
    printf '%s\n' '---'
    printf '%s\n' "$LEAN_BRIEFING"
    printf '%s\n' '</compact-briefing>'
  fi
fi

exit 0
