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
#   - On EVERY invocation, success or failure: append one JSON line
#     carrying `duration_ms` to the hook-timing log (#3564).
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
#
# ── Timing log (#3564) ──────────────────────────────────────────────────
#
# Before this, the wrapper logged ONLY failures — no timestamps, no
# durations. That is why `secret-guard-pretool` could sit at ~145ms per
# tool call for months (#3543) and `workspace-dynamic-hook` at ~825ms-1.1s
# per message (#3546) without producing a single log line: neither was
# FAILING, merely slow, and slow-but-successful was invisible.
#
# So every invocation now appends one JSON line to
#   ${TELEGRAM_STATE_DIR}/hook-timings-<Ddd>.log        (Mon..Sun)
# shaped as:
#   {"ts":"...","date":"YYYY-MM-DD","source":"hook:x","code":"x.mjs",
#    "duration_ms":142,"status":0}
# so `grep duration_ms` answers any future hook-cost question.
#
# Cost discipline — the wrapper's own overhead was measured at 0-2ms and
# must stay there, so the whole timing path is FORK-FREE:
#   - `EPOCHREALTIME` (bash 5 builtin) for start/end, integer arithmetic
#     for the delta. No `date`, no `stat`, no subshell.
#   - The file name embeds the weekday, giving a self-truncating 7-day
#     ring: on the first write of a new day the existing file's first line
#     carries last week's date, so we truncate instead of appending. The
#     staleness check is a builtin `read` from the file — measured
#     0.024ms/append vs 0.81ms for a single `stat` fork, which is why
#     size-based rotation was rejected here.
# Measured net cost of `log_timing` (2000-iteration in-shell loop, a busy
# build host): 0.40-0.78ms per invocation, dominated by the append's
# open/write/close. That fits inside the stated 0-2ms wrapper budget with
# room to spare; a `date` + `stat` implementation would not.
#
# Env:
#   SWITCHROOM_HOOK_TIMING=0        disable timing log entirely
#   SWITCHROOM_HOOK_TIMING_DIR      override the log directory
#   SWITCHROOM_HOOK_TIMING_MIN_MS   only log invocations at/above this
#                                   duration (default 0 = log everything;
#                                   the whole failure mode here is that
#                                   slow-but-successful is invisible, so
#                                   the default must not filter).

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

# Fork-free monotonic-ish start stamp. EPOCHREALTIME is a bash 5 builtin;
# on bash 4 it is unset and timing degrades to a silent no-op.
TIMING_START="${EPOCHREALTIME:-}"

"$COMMAND" "$@" 2>"$STDERR_TMP"
STATUS=$?

TIMING_END="${EPOCHREALTIME:-}"

# Replay captured stderr to our own stderr now that the command has
# fully exited — preserves journald visibility without the streaming
# property (which hooks don't need; they're short-lived).
if [ -s "$STDERR_TMP" ]; then
  cat "$STDERR_TMP" >&2
fi

emit_warn() {
  echo "run-hook.sh: $1" >&2
}

# ── Timing log (#3564) ────────────────────────────────────────────────────
#
# Everything below is deliberately FORK-FREE: no command substitution (which
# forks a subshell), no `date`, no `stat`. Helpers return values by assigning
# to a caller-visible global rather than via `$(...)`.

# Split EPOCHREALTIME ("1753412345.123456") into whole milliseconds.
# LC_NUMERIC can make the separator a comma, so accept either.
# Sets `_EPOCH_MS`; returns 1 (and leaves _EPOCH_MS empty) on a bad shape.
_EPOCH_MS=""
_epoch_to_ms() {
  local raw="$1" secs usecs
  _EPOCH_MS=""
  case "$raw" in
    *[.,]*) secs="${raw%%[.,]*}"; usecs="${raw#*[.,]}" ;;
    *)      secs="$raw"; usecs="0" ;;
  esac
  case "$secs" in
    ''|*[!0-9]*) return 1 ;;
  esac
  case "$usecs" in
    ''|*[!0-9]*) return 1 ;;
  esac
  # Pad/truncate the fractional part to exactly 6 digits, then force base 10
  # so a leading zero is not read as octal.
  usecs="${usecs}000000"
  usecs="${usecs:0:6}"
  _EPOCH_MS=$(( secs * 1000 + (10#$usecs) / 1000 ))
  return 0
}

# JSON-escape into `_JSON_ESCAPED`. Hook sources and command basenames are
# operator-authored and tame, but a backslash or quote in one must not be
# able to emit a malformed line (or inject extra fields) into a log that
# other tooling parses.
_JSON_ESCAPED=""
_json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  _JSON_ESCAPED="$s"
}

log_timing() {
  [ "${SWITCHROOM_HOOK_TIMING:-1}" = "0" ] && return 0
  [ -n "$TIMING_START" ] || return 0
  [ -n "$TIMING_END" ] || return 0

  local timing_dir="${SWITCHROOM_HOOK_TIMING_DIR:-$STATE_DIR}"
  [ -n "$timing_dir" ] || return 0
  [ -d "$timing_dir" ] || return 0

  local start_ms end_ms duration_ms
  _epoch_to_ms "$TIMING_START" || return 0
  start_ms="$_EPOCH_MS"
  _epoch_to_ms "$TIMING_END" || return 0
  end_ms="$_EPOCH_MS"
  duration_ms=$(( end_ms - start_ms ))
  # A clock step backwards must not emit a negative duration.
  [ "$duration_ms" -lt 0 ] && duration_ms=0

  local min_ms="${SWITCHROOM_HOOK_TIMING_MIN_MS:-0}"
  case "$min_ms" in
    ''|*[!0-9]*) min_ms=0 ;;
  esac
  [ "$duration_ms" -lt "$min_ms" ] && return 0

  # Builtin date formatting — no `date` fork.
  local today dow ts
  printf -v today '%(%Y-%m-%d)T' -1
  printf -v dow '%(%a)T' -1
  printf -v ts '%(%Y-%m-%dT%H:%M:%S%z)T' -1

  local logfile="${timing_dir}/hook-timings-${dow}.log"

  # 7-day self-truncating ring: the weekday-named file is either today's or
  # exactly a week stale, so if its first line does not carry today's date,
  # reset it. `read` from a file is a builtin — no fork.
  if [ -s "$logfile" ]; then
    local first=''
    read -r first < "$logfile" 2>/dev/null || first=''
    case "$first" in
      *"\"date\":\"${today}\""*) : ;;
      *) : > "$logfile" 2>/dev/null || return 0 ;;
    esac
  fi

  local esc_source esc_code
  _json_escape "$SOURCE"; esc_source="$_JSON_ESCAPED"
  _json_escape "$CODE";   esc_code="$_JSON_ESCAPED"

  printf '{"ts":"%s","date":"%s","source":"%s","code":"%s","duration_ms":%s,"status":%s}\n' \
    "$ts" "$today" "$esc_source" "$esc_code" "$duration_ms" "$STATUS" \
    >> "$logfile" 2>/dev/null || true
}

# When RUN_HOOK_DEBUG=1 is set, drop the stderr redirect on the
# issues-CLI invocations so an operator debugging a broken record-path
# sees the actual cause in journald instead of just the generic
# "failed to record issue (non-fatal)" line. See #445.
debug_mode() {
  [ "${RUN_HOOK_DEBUG:-}" = "1" ]
}

record_failure() {
  local summary has_detail
  summary="${SOURCE}: ${CODE} exited ${STATUS}"
  if [ -s "$STDERR_TMP" ]; then
    has_detail=1
  else
    has_detail=0
  fi

  # SECURITY (#1069): hook stderr is untrusted — a failing hook may
  # echo a bearer token (401), a PAT URL (git clone fail), an LLM
  # provider response body (recall.py traceback), etc. Before #1069 the
  # raw bytes landed in issues.jsonl and surfaced verbatim in Telegram
  # via the issues-card / `/issues` list.
  #
  # The fix runs inside the CLI: `issues record --detail-stdin` pipes
  # the input through `secret-detect/redact.ts` before `capDetail`
  # writes to the store (see src/issues/store.ts:capDetail). One bun
  # CLI fork covers both the record AND the redact, vs. two forks for
  # an explicit `... | secret-detect redact --stdin | issues record`
  # pipeline that would double the ~785ms cold-start documented in
  # `resolve_success`. The standalone `switchroom secret-detect redact
  # --stdin` shim is still wired for ad-hoc operator use and tests.
  #
  # We never materialize the stderr tail into a bash variable —
  # streaming `tail | issues record` keeps RSS bounded if a hook prints
  # megabytes (the CLI side caps stdin at 64 KB anyway).

  if debug_mode; then
    if [ "$has_detail" -eq 1 ]; then
      tail -n 60 "$STDERR_TMP" | "$SWITCHROOM_CLI" issues record \
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
    if [ "$has_detail" -eq 1 ]; then
      tail -n 60 "$STDERR_TMP" | "$SWITCHROOM_CLI" issues record \
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

# Timing is emitted on EVERY path, including the degraded no-CLI path below
# — it writes a file directly and does not need the switchroom CLI, so hook
# cost stays observable even when issue tracking is off (#3564).
log_timing

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
