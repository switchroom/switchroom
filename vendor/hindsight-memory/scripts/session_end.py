#!/usr/bin/env python3
"""SessionEnd hook: final retain + daemon cleanup.

Fires once when a Claude Code session terminates. Two jobs:

1. **Final retain.** Forces a retain pass so short sessions (fewer
   turns than ``retainEveryNTurns``) still land on disk.
2. **Daemon stop.** Tears down the auto-started hindsight-embed
   daemon, if any.

Silent data-loss guard (#1071)
------------------------------
Before this change the final retain would print its error to stderr
and exit 0 — the operator sees nothing in journald (already noisy),
the agent thinks the turn was saved, the *next* session can't recall
the turn. Silent memory loss.

Now: on retain failure we serialize the full retain payload to
``~/.hindsight/pending-retains/<unix-ms>-<uuid>.json`` (see
``lib/pending.py``) and exit non-zero so ``bin/run-hook.sh`` routes
the failure through the ``switchroom issues`` sink (#424). The next
SessionStart drains the queue (see ``drain_pending.py``).

Pairs with #1070 (recall.py exit-code fix) — same threat class.

Port of: Openclaw's service.stop() in index.js.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib.config import debug_log, load_config
from lib.daemon import stop_daemon
from lib.pending import MAX_ENTRIES, count as pending_count, enqueue as pending_enqueue


# Exit codes:
#   0 — success (or retain skipped for benign reasons)
#   1 — retain failed AND was queued to pending-retains (recoverable)
#   2 — retain failed but nothing was queued — either the queue rejected
#       it (chronic backlog) or there was no payload to queue (the
#       failure happened before one was built). Not recoverable via the
#       pending-retains drain, so it's semantically "dropped", not
#       "queued".
# Only the sign of the exit code is load-bearing downstream: Claude
# Code's hook runner routes any non-zero SessionEnd exit to the issue
# sink (bin/run-hook.sh / #424); nothing distinguishes 1 from 2
# programmatically, so this is a correctness/clarity fix, not a
# contract change.
EXIT_OK = 0
EXIT_QUEUED = 1
EXIT_DROPPED = 2


def main() -> int:
    config = load_config()

    # Consume stdin
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        hook_input = {}

    debug_log(config, f"SessionEnd hook, reason: {hook_input.get('reason', 'unknown')}")

    exit_code = EXIT_OK

    # Force a final retain before stopping the daemon — guarantees short sessions
    # (fewer turns than retainEveryNTurns) still land on disk.
    if config.get("autoRetain") and hook_input.get("transcript_path"):
        try:
            from retain import run_retain

            result = run_retain(hook_input, force=True) or {}
        except Exception as e:
            # Belt-and-braces — run_retain itself shouldn't raise, but
            # if it does we treat it the same as a failed POST: queue
            # what we can (nothing, since we have no payload) and exit
            # non-zero so the issue sink picks it up.
            print(f"[Hindsight] SessionEnd final retain error: {e}", file=sys.stderr)
            result = {"status": "failed", "error": e, "payload": None}

        if result.get("status") == "failed":
            payload = result.get("payload")
            err = result.get("error") or RuntimeError("unknown retain failure")
            if payload:
                queued = pending_enqueue(payload, err)
                if queued is None:
                    print(
                        f"[Hindsight] pending-retains queue full ({MAX_ENTRIES} entries); "
                        f"dropping this retain. Operator: drain manually, then run "
                        f"`switchroom doctor`.",
                        file=sys.stderr,
                    )
                    exit_code = EXIT_DROPPED
                else:
                    debug_log(config, f"SessionEnd retain queued to {queued} (pending={pending_count()})")
                    print(
                        f"[Hindsight] SessionEnd retain failed: queued to pending-retains "
                        f"(error: {type(err).__name__}: {err}). Will retry on next "
                        f"SessionStart.",
                        file=sys.stderr,
                    )
                    exit_code = EXIT_QUEUED
            else:
                # No payload to queue — the failure happened before we
                # finished building one (e.g. URL resolution). Nothing
                # landed in pending-retains, so this is a drop, not a
                # queue (#1094 item 5): EXIT_DROPPED, not EXIT_QUEUED.
                exit_code = EXIT_DROPPED

    # Stop daemon if we started it. Always runs, even on retain failure,
    # so we don't leak a daemon process.
    def _dbg(*a):
        debug_log(config, *a)

    stop_daemon(config, debug_fn=_dbg)
    return exit_code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"[Hindsight] SessionEnd error: {e}", file=sys.stderr)
        # Surface the unexpected failure to the issue sink rather than
        # swallowing it (per #424). Stays non-zero in both debug and
        # non-debug paths so the recall.py-style silent-failure trap
        # (#1070) doesn't recur here.
        sys.exit(2)
