#!/bin/sh
# run-hook.sh — resilient launcher for Claude Code Node hooks (issue #2555).
#
# Under cgroup memory-ceiling pressure (the cgroup pinned at memory.max with
# reclaim lagging, page cache ~= cap), a freshly-spawned Node process can abort
# at STARTUP with exit 134 (SIGABRT) inside the libuv threadpool constructor —
# `Assertion failed: (0) == (uv_thread_create(...))` — BEFORE any hook code
# runs. It is a transient allocation failure, not a real hook error, but it
# surfaces a 🔴 issues card and skips the hook's work on that one tool call.
#
# This wrapper makes the invocation tolerant:
#   1. Shrink the libuv threadpool to 1 so Node needs the fewest possible
#      thread-stack mmaps at startup (minimises the failure window).
#   2. Capture the hook payload from stdin ONCE and replay it on each attempt.
#      The abort can land AFTER Node started draining the pipe, so a naive
#      retry would feed the second attempt EMPTY stdin — a secret scanner would
#      then scan nothing. Replaying the captured payload keeps the retry
#      faithful.
#   3. Retry ONCE on a 134 abort after a brief backoff.
#   4. If it STILL aborts:
#        - for SECURITY-CRITICAL hooks (secret-guard / secret-scrub) FAIL
#          CLOSED — propagate 134 so the runtime cards it. 134 is a generic
#          SIGABRT (assertion / OOM / any abort), not memory-pressure-specific,
#          so silently returning 0 for a genuinely broken scanner would be a
#          silent security BYPASS. Those hooks must never fail open.
#        - for all other hooks, SKIP CLEANLY (exit 0) with a single stderr
#          warn. A skipped label/context hook on one call is the documented,
#          accepted degradation; a crash-card storm under memory pressure is
#          not.
#
# Any non-134 exit status is passed through unchanged — real hook decisions
# (block/allow/non-zero) are never masked. `sleep 0.15` uses a fractional
# second (supported by GNU/BusyBox sleep, both present in the agent image).
#
# Usage (from hooks.json):
#   sh "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh" node "${CLAUDE_PLUGIN_ROOT}/hooks/<name>.mjs"

export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-1}"

# Identify the hook script (the .mjs argument) to decide fail-open vs closed.
hook_path=""
for a in "$@"; do
  case "$a" in
    *.mjs) hook_path="$a" ;;
  esac
done
hook_name=$(basename "$hook_path" 2>/dev/null)

# Security-critical hooks MUST fail closed on a persistent abort.
fail_closed=0
case "$hook_name" in
  secret-guard-pretool.mjs | secret-scrub-stop.mjs) fail_closed=1 ;;
esac

# Capture stdin once so both attempts see the SAME payload. Claude Code feeds
# the hook a single JSON object on stdin and closes it, so `cat` returns at
# EOF. (Command substitution strips trailing newlines, which JSON parsing does
# not care about.)
payload=$(cat)

run_hook() {
  printf '%s' "$payload" | "$@"
}

run_hook "$@"
status=$?
if [ "$status" -ne 134 ]; then
  exit "$status"
fi

# Transient thread-create abort — brief backoff, then retry once with the
# faithfully-replayed payload.
sleep 0.15
run_hook "$@"
status=$?
if [ "$status" -eq 134 ]; then
  if [ "$fail_closed" -eq 1 ]; then
    echo "run-hook: security hook '$hook_name' aborted twice with exit 134 — FAILING CLOSED (not skipping) (#2555)" >&2
    exit 134
  fi
  echo "run-hook: '$hook_name' aborted twice with exit 134 (uv_thread_create under memory pressure) — skipping hook cleanly (#2555)" >&2
  exit 0
fi
exit "$status"
