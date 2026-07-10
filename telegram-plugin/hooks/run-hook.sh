#!/bin/sh
# run-hook.sh — resilient launcher for Claude Code Node hooks (issue #2555).
#
# Under cgroup memory-ceiling pressure (the cgroup pinned at memory.max with
# reclaim lagging, page cache ~= cap), a freshly-spawned Node process can abort
# at STARTUP with exit 134 (SIGABRT) inside the libuv threadpool constructor —
# `Assertion failed: (0) == (uv_thread_create(...))` — BEFORE any hook code
# runs. It is a transient allocation failure, not a real hook error, but it
# surfaces a 🔴 issues card and skips the hook's work (e.g. the secret-guard
# scan) on that one tool call.
#
# This wrapper makes the invocation tolerant:
#   1. Shrink the libuv threadpool to 1 so Node needs the fewest possible
#      thread-stack mmaps at startup (minimises the failure window).
#   2. Retry ONCE on a 134 abort after a brief backoff. The abort happens
#      before stdin is read, so the hook payload is still buffered in the pipe
#      and the retry sees it.
#   3. If it still aborts, SKIP CLEANLY (exit 0) with a single warn to stderr,
#      rather than propagating 134 (which the runtime treats as a hook error
#      and cards). A skipped hook on one call is the documented, accepted
#      degradation; a crash card storm under memory pressure is not.
#
# Any non-134 exit status is passed through unchanged — real hook decisions
# (block/allow/non-zero) are never masked.
#
# Usage (from hooks.json):
#   sh "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.sh" node "${CLAUDE_PLUGIN_ROOT}/hooks/<name>.mjs"

export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-1}"

"$@"
status=$?
if [ "$status" -ne 134 ]; then
  exit "$status"
fi

# Transient thread-create abort — brief backoff, then retry once.
sleep 0.15
"$@"
status=$?
if [ "$status" -eq 134 ]; then
  echo "run-hook: '$2' aborted twice with exit 134 (uv_thread_create under memory pressure) — skipping hook cleanly (#2555)" >&2
  exit 0
fi
exit "$status"
