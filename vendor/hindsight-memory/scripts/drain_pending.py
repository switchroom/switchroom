#!/usr/bin/env python3
"""Drain ``~/.hindsight/pending-retains/``.

SessionStart calls into ``drain()`` to retry any retain payloads that
``session_end.py`` queued on failure (#1071). Each entry is retried up
to ``MAX_ATTEMPTS`` (5) times; after that it's renamed to ``.dead`` so
the queue no longer drains it but the operator can still inspect via
``switchroom doctor``.

Boundaries
----------
* Per-entry HTTP timeout: ``HINDSIGHT_DRAIN_TIMEOUT`` (default 5s), but
  clamped per entry to the budget still remaining (see below) so a
  single slow entry can never overshoot the wall-clock cap. The default
  timeout (5s) intentionally exceeds the default budget (4s): the clamp,
  not the raw timeout, is what bounds a slow entry.
* Total wall-clock cap: ``HINDSIGHT_DRAIN_BUDGET_S`` (default 4s) so
  drain never blocks SessionStart longer than the upstream hook timeout
  permits. This is the authoritative bound; the per-entry timeout is
  clamped down to ``max(1, remaining budget)`` before each request, so
  even one slow upstream entry overshoots the budget by at most the
  clamp floor (~1s), not by ``HINDSIGHT_DRAIN_TIMEOUT - budget``.
* Stall guard: if ``STALL_THRESHOLD`` (3) consecutive entries fail with
  the same error class, we stop draining for this session — that's a
  systemic outage, not a transient flake, and continuing would only
  burn the SessionStart timeout budget. The remaining entries stay
  queued for the next session.

Standalone usage::

    python3 drain_pending.py        # one-shot drain, prints summary
"""

from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib.client import HindsightClient
from lib.config import debug_log, load_config
from lib.pending import (
    MAX_ATTEMPTS,
    delete_entry,
    iter_entries,
    mark_dead,
    update_attempt,
)


STALL_THRESHOLD = 3


def _per_entry_timeout() -> int:
    raw = os.environ.get("HINDSIGHT_DRAIN_TIMEOUT", "5")
    try:
        v = int(raw)
        return max(1, v)
    except ValueError:
        return 5


def _budget_seconds() -> float:
    raw = os.environ.get("HINDSIGHT_DRAIN_BUDGET_S", "4")
    try:
        v = float(raw)
        return max(0.5, v)
    except ValueError:
        return 4.0


def _retry_one(entry: dict, timeout: int) -> None:
    """POST a single queued retain. Raises on failure."""
    client = HindsightClient(entry["api_url"], entry.get("api_token"))
    client.retain(
        bank_id=entry["bank_id"],
        content=entry["content"],
        document_id=entry.get("document_id", "conversation"),
        context=entry.get("context"),
        metadata=entry.get("metadata") or {},
        tags=entry.get("tags"),
        timeout=timeout,
    )


def drain(config: dict | None = None) -> dict:
    """Walk the pending-retains directory and retry each entry.

    Returns a summary dict::

        {"drained": int,   # successful retries (entries deleted)
         "retried": int,   # failures kept for next session
         "dead":    int,   # entries promoted to .dead this run
         "stalled": bool,  # stall guard tripped
         "budget_exceeded": bool}
    """
    config = config or load_config()
    timeout = _per_entry_timeout()
    budget = _budget_seconds()
    started = time.monotonic()

    summary = {
        "drained": 0,
        "retried": 0,
        "dead": 0,
        "stalled": False,
        "budget_exceeded": False,
    }

    entries = iter_entries()
    if not entries:
        debug_log(config, "drain_pending: queue empty")
        return summary

    debug_log(config, f"drain_pending: {len(entries)} entries to retry")

    consecutive_failures = 0
    last_error_class: str | None = None

    for path, entry in entries:
        elapsed = time.monotonic() - started
        if elapsed > budget:
            summary["budget_exceeded"] = True
            debug_log(config, "drain_pending: total budget exceeded, stopping")
            break

        # Clamp the per-entry HTTP timeout to the budget still remaining
        # (#1094 item 2). Without this, a single slow entry using the full
        # HINDSIGHT_DRAIN_TIMEOUT (default 5s) overshoots the total budget
        # (default 4s). Floor at 1s so we still give a near-exhausted
        # budget one bounded shot rather than a 0s (instant-fail) request.
        remaining = budget - elapsed
        effective_timeout = max(1, min(timeout, int(remaining) if remaining >= 1 else 1))

        try:
            _retry_one(entry, timeout=effective_timeout)
        except Exception as e:
            err_class = type(e).__name__
            if err_class == last_error_class:
                consecutive_failures += 1
            else:
                consecutive_failures = 1
                last_error_class = err_class

            attempts = int(entry.get("attempt_count", 1))
            if attempts >= MAX_ATTEMPTS:
                marker = mark_dead(path, entry)
                summary["dead"] += 1
                print(
                    f"[Hindsight] drain_pending: entry exceeded {MAX_ATTEMPTS} "
                    f"attempts, marking dead at {marker} (last error: {err_class}: {e})",
                    file=sys.stderr,
                )
            else:
                update_attempt(path, entry, e)
                summary["retried"] += 1
                debug_log(
                    config,
                    f"drain_pending: retry {attempts}/{MAX_ATTEMPTS} failed for {path} ({err_class}: {e})",
                )

            if consecutive_failures >= STALL_THRESHOLD:
                summary["stalled"] = True
                print(
                    f"[Hindsight] drain_pending: {consecutive_failures} consecutive "
                    f"failures with {err_class}, stalling drain. Remaining entries "
                    f"stay queued.",
                    file=sys.stderr,
                )
                break
            continue

        # Success — delete the entry.
        delete_entry(path)
        summary["drained"] += 1
        consecutive_failures = 0
        last_error_class = None

    return summary


def main() -> int:
    config = load_config()
    summary = drain(config)
    if summary["drained"] or summary["retried"] or summary["dead"]:
        print(
            f"[Hindsight] drain_pending: "
            f"drained={summary['drained']} retried={summary['retried']} "
            f"dead={summary['dead']} "
            f"stalled={summary['stalled']} budget_exceeded={summary['budget_exceeded']}",
            file=sys.stderr,
        )
    # Non-zero only when we promoted entries to .dead — that's the
    # operator-visible signal. Plain retry-still-pending isn't an error,
    # the next SessionStart picks them up.
    return 1 if summary["dead"] else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"[Hindsight] drain_pending unexpected error: {e}", file=sys.stderr)
        sys.exit(2)
