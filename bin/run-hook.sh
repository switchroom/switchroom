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

# When RUN_HOOK_DEBUG=1 is set, drop the stderr redirect on the
# issues-CLI invocations so an operator debugging a broken record-path
# sees the actual cause in journald instead of just the generic
# "failed to record issue (non-fatal)" line. See #445.
debug_mode() {
  [ "${RUN_HOOK_DEBUG:-}" = "1" ]
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
  if debug_mode; then
    if [ -n "$detail" ]; then
      printf '%s' "$detail" | "$SWITCHROOM_CLI" issues record \
        --severity error \
        --source "$SOURCE" \
        --code "$CODE" \
        --summary "$summary" \
        --detail-stdin \
        --quiet \
        ${STATE_DIR:+--state-dir "$STATE_DIR"} \
        || emit_warn "failed to record issue (non-fatal)"
    else
      "$SWITCHROOM_CLI" issues record \
        --severity error \
        --source "$SOURCE" \
        --code "$CODE" \
        --summary "$summary" \
        --quiet \
        ${STATE_DIR:+--state-dir "$STATE_DIR"} \
        || emit_warn "failed to record issue (non-fatal)"
    fi
  else
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
  fi
}

resolve_success() {
  # Fast-skip the CLI fork when there is nothing to resolve.
  #
  # Cold-starting the switchroom CLI to call `issues resolve` costs
  # ~785ms on a typical box (measured 2026-05-01 across three runs).
  # With 3-5 successful hooks per turn this is 2.4-4 s of pure wrapper
  # overhead per turn — bigger than the model's first-token latency.
  #
  # Most hooks succeed and most successful hooks have nothing to clear
  # (a fleet check on 2026-05-01 found 0 unresolved entries across 5
  # production agents). In that case `issues resolve` walks the file,
  # finds no matching unresolved entry, and returns 0 — pure waste.
  #
  # Bash-side prefilter mirrors the CLI's match condition exactly:
  #   - fingerprint == "<source>::<code>"  (per src/issues/fingerprint.ts)
  #   - resolved_at is null/missing        (per IssueEvent.resolved_at?)
  # Since IssueEvent.resolved_at is optional and JSON.stringify omits
  # undefined fields, an unresolved entry's JSONL line will NOT contain
  # the substring `"resolved_at":` at all. So the prefilter is:
  #
  #   any line containing the fingerprint AND lacking `"resolved_at":`
  #
  # If no such line exists, the CLI's resolve op is a guaranteed no-op
  # and we skip the fork. False positives (forking when we don't need
  # to) match today's behaviour and are harmless. False negatives
  # (skipping when we should fork) require a fingerprint substring
  # collision with `"resolved_at":` somewhere on the same line, which
  # the JSON ordering and key set make impossible.
  local fingerprint="${SOURCE}::${CODE}"
  local issues_file="${STATE_DIR}/issues.jsonl"

  if [ -z "$STATE_DIR" ] || [ ! -s "$issues_file" ]; then
    return 0
  fi
  if ! grep -F "\"fingerprint\":\"${fingerprint}\"" "$issues_file" 2>/dev/null \
    | grep -vqF '"resolved_at":'; then
    return 0
  fi

  # Real work — fork the CLI to do the actual flip.
  if debug_mode; then
    "$SWITCHROOM_CLI" issues resolve --source "$SOURCE" --code "$CODE" \
      ${STATE_DIR:+--state-dir "$STATE_DIR"} \
      || true
  else
    "$SWITCHROOM_CLI" issues resolve --source "$SOURCE" --code "$CODE" \
      ${STATE_DIR:+--state-dir "$STATE_DIR"} \
      >/dev/null 2>&1 || true
  fi
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
