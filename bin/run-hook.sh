#!/usr/bin/env bash
# run-hook.sh — wrap a hook command and surface failures to the issue
# sink (#425). Phase 0.2 of #424.
#
# Usage:
#   run-hook.sh <source> <command> [args...]
#
#   <source>  Stable identifier for this hook, e.g. "hook:handoff" or
#             "hook:secret-scrub-stop". Becomes the issue source field;
#             coalesces all failures of this hook into one entry.
#   <command> The actual hook command (binary or script path).
#   [args...] Forwarded verbatim to <command>.
#
# Behaviour:
#   - Stdin/stdout pass through unchanged. Hooks that emit JSON to
#     claude on stdout still work.
#   - Stderr is teed: visible in journald as before AND captured to a
#     buffer so we can attach the tail to the issue detail.
#   - On exit 0: auto-resolve any prior unresolved issue with the same
#     fingerprint. So a transient flake clears itself on next success.
#   - On non-zero exit: record an issue with severity=error, code = the
#     command basename, summary = "<source>: <basename> exited <code>",
#     detail = last ~60 lines of stderr.
#   - The wrapper itself never blocks the hook. If `switchroom issues`
#     fails (CLI missing, state dir not writable), we just emit a one-line
#     warning to stderr and exit with the original status.
#
# The wrapper exits with the original command's exit code, so claude
# code's hook contract (block / allow / non-zero behaviour) is preserved.

set -u

if [ "$#" -lt 2 ]; then
  echo "run-hook.sh: usage: run-hook.sh <source> <command> [args...]" >&2
  exit 2
fi

SOURCE="$1"; shift
COMMAND="$1"
shift

# Derive a code that discriminates between, e.g., `bash foo.sh` and
# `bash bar.sh`. When COMMAND is a known interpreter (bash, node, etc.)
# and the first arg looks like a script path, use its basename. So
# fingerprints stay distinct across hooks that share an interpreter.
case "$(basename -- "$COMMAND")" in
  bash|sh|node|npx|bun|python|python3|deno)
    if [ "$#" -gt 0 ]; then
      CODE="$(basename -- "$1")"
    else
      CODE="$(basename -- "$COMMAND")"
    fi
    ;;
  *)
    CODE="$(basename -- "$COMMAND")"
    ;;
esac

# Best-effort: locate the switchroom CLI. Prefer SWITCHROOM_CLI_PATH
# (set in the agent's MCP env), then PATH. If not found, the wrapper
# degrades to a passthrough — no issue recording, but the hook still
# runs.
if [ -n "${SWITCHROOM_CLI_PATH:-}" ] && [ -x "$SWITCHROOM_CLI_PATH" ]; then
  SWITCHROOM_CLI="$SWITCHROOM_CLI_PATH"
elif command -v switchroom >/dev/null 2>&1; then
  SWITCHROOM_CLI="$(command -v switchroom)"
else
  SWITCHROOM_CLI=""
fi

# We need a writable state dir to record issues. The CLI also accepts
# this via env; we just check up-front so the degraded path is obvious.
STATE_DIR="${TELEGRAM_STATE_DIR:-}"

# Run the wrapped command, capturing stderr to a temp file. After the
# command exits, replay the buffer to our own stderr so journald sees
# everything as before. This is intentionally NOT a process substitution
# with tee — bash does not wait for process substitutions to drain
# before the next command runs, which previously meant tail-reading
# the buffer could miss the final lines (the most informative ones).
# See review on #434/#435.
STDERR_TMP="$(mktemp -t run-hook-stderr.XXXXXX 2>/dev/null || mktemp)"
trap 'rm -f "$STDERR_TMP" 2>/dev/null || true' EXIT

"$COMMAND" "$@" 2>"$STDERR_TMP"
STATUS=$?

# Replay captured stderr to our own stderr now that the command has
# fully exited — preserves journald visibility without the streaming
# property (which hooks don't need; they're short-lived).
if [ -s "$STDERR_TMP" ]; then
  cat "$STDERR_TMP" >&2
fi

emit_warn() {
  echo "run-hook.sh: $1" >&2
}

record_failure() {
  local detail summary
  # Last ~60 lines of stderr; CLI will further cap to DETAIL_MAX_BYTES.
  if [ -s "$STDERR_TMP" ]; then
    detail="$(tail -n 60 "$STDERR_TMP")"
  else
    detail=""
  fi
  summary="${SOURCE}: ${CODE} exited ${STATUS}"

  # Pipe detail via stdin so we don't have to shell-quote arbitrary
  # error text. CLI reads it when --detail-stdin is set.
  if [ -n "$detail" ]; then
    printf '%s' "$detail" | "$SWITCHROOM_CLI" issues record \
      --severity error \
      --source "$SOURCE" \
      --code "$CODE" \
      --summary "$summary" \
      --detail-stdin \
      --quiet \
      ${STATE_DIR:+--state-dir "$STATE_DIR"} \
      >/dev/null 2>&1 || emit_warn "failed to record issue (non-fatal)"
  else
    "$SWITCHROOM_CLI" issues record \
      --severity error \
      --source "$SOURCE" \
      --code "$CODE" \
      --summary "$summary" \
      --quiet \
      ${STATE_DIR:+--state-dir "$STATE_DIR"} \
      >/dev/null 2>&1 || emit_warn "failed to record issue (non-fatal)"
  fi
}

resolve_success() {
  # Resolve by source+code; the CLI computes the fingerprint.
  "$SWITCHROOM_CLI" issues resolve --source "$SOURCE" --code "$CODE" \
    ${STATE_DIR:+--state-dir "$STATE_DIR"} \
    >/dev/null 2>&1 || true
}

if [ -z "$SWITCHROOM_CLI" ]; then
  # Degraded path. Emit a single warning so the operator knows visibility
  # is off, but don't change the hook's exit semantics.
  emit_warn "switchroom CLI not found on PATH; hook ran without issue tracking"
  exit "$STATUS"
fi

if [ "$STATUS" -eq 0 ]; then
  resolve_success
else
  record_failure
fi

exit "$STATUS"
