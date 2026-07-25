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

Backlog mode (switchroom #3596)
-------------------------------
The bounds above are sized for the SessionStart hook and CANNOT clear an
accumulated backlog. Worse, they CREATE one: the per-entry timeout is
clamped to the remaining hook budget (1-8s) while ``_retry_one`` posts
synchronously and a real retain takes 30-90s, so **the server commits the
document and the client always gives up before the ack**. The entry is
never deleted and is re-posted on every session start, forever, until it
hits ``MAX_ATTEMPTS`` and goes ``.dead``. The queue depth was a symptom
of that loop, not of lost memory: a full sweep of 5,751 queued entries on
this fleet (2026-07-25) found **4,048 (70.4%) already existed as
documents**, 3,815 of them with facts extracted.

``--backlog`` is therefore a two-phase, out-of-hook replay:

* **Phase 1 — reconcile (free).** GET the document. If it exists, the
  memory is already durable; drop the queue entry without a POST. No LLM
  work, no cost, idempotent, resumable at any point.
* **Phase 2 — drain (real work).** Only for genuinely absent documents:
  POST with a realistic timeout, then **re-GET to confirm the document
  exists before deleting the entry**. A 200 is an ack, not proof
  (switchroom #3244).

Pacing is not optional. The local model group backing retain has a small,
fixed number of lanes shared with live retains, reflect and consolidation,
so backlog replay defaults to **concurrency 1** with a sleep between
entries, and will pause entirely while an operator-supplied p95 probe
reports the upstream is already slow.

Standalone usage::

    python3 drain_pending.py               # bounded in-hook drain
    python3 drain_pending.py --backlog     # two-phase backlog replay
    python3 drain_pending.py --backlog --phase reconcile   # free pass only
    python3 drain_pending.py --backlog --dry-run
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

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


def _env_num(name: str, default, cast=float, lo=None, hi=None):
    """Read a numeric env knob, falling back to ``default`` on garbage."""
    try:
        v = cast(os.environ.get(name) or default)
    except (TypeError, ValueError):
        v = cast(default)
    if lo is not None:
        v = max(lo, v)
    if hi is not None:
        v = min(hi, v)
    return v


def _backlog_timeout() -> int:
    """Per-entry HTTP timeout in backlog mode.

    A synchronous retain takes 30-90s on this fleet, so the SessionStart
    default (5-8s, further clamped by the hook budget) guarantees a
    client-side timeout on a request the server then commits anyway.
    """
    return _env_num("HINDSIGHT_DRAIN_BACKLOG_TIMEOUT", 180, int, lo=1)


def _backlog_budget_seconds() -> float:
    """Total wall-clock cap in backlog mode (default 1h)."""
    return _env_num("HINDSIGHT_DRAIN_BACKLOG_BUDGET_S", 3600, float, lo=1.0)


def _backlog_concurrency() -> int:
    """Entries retried in parallel in backlog mode.

    **Defaults to 1, deliberately.** The local model group serving retain
    has a small fixed number of lanes (4 on this fleet: 2 boxes x 2 slots)
    SHARED with live retains, reflect and consolidation. A drain at width
    4 consumes the whole pool; run per-agent across 11 agents and it is
    44 lanes of demand against 4, which trips the latency watchdog. One
    lane leaves the rest for live work. Raise it only if you know the
    pool is idle.
    """
    return _env_num("HINDSIGHT_DRAIN_CONCURRENCY", 1, int, lo=1, hi=16)


def _backlog_sleep_seconds() -> float:
    """Pause between phase-2 retains, so replay never runs flat out."""
    return _env_num("HINDSIGHT_DRAIN_SLEEP_S", 2.0, float, lo=0.0)


def _p95_backoff_ms() -> int:
    """Pause phase 2 while the upstream p95 exceeds this."""
    return _env_num("HINDSIGHT_DRAIN_P95_BACKOFF_MS", 38000, int, lo=0)


def _p95_probe_ms() -> int:
    """Current upstream p95 in ms, or ``-1`` when unknown.

    The probe is an operator-supplied command (``HINDSIGHT_DRAIN_P95_CMD``)
    that prints a millisecond figure on stdout. It is NOT built in: the
    authoritative latency figure on this fleet lives in LiteLLM's spend
    log in postgres, which an agent container cannot reach — inventing a
    weaker in-container proxy for it would be a worse signal that looks
    like a better one. Unset ⇒ no backoff, and ``--backlog`` says so.
    """
    cmd = os.environ.get("HINDSIGHT_DRAIN_P95_CMD")
    if not cmd:
        return -1
    try:
        out = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=45
        )
        return int(out.stdout.strip().splitlines()[-1])
    except Exception:
        return -1


def _retry_one(entry: dict, timeout: int) -> None:
    """POST a single queued retain. Raises on failure.

    Posts ``async_processing=False`` (commit-before-ack, switchroom #3244 §1.1):
    the drain is a DURABILITY path — it deletes the pending entry on a 200, so
    the 200 must prove durable persistence, not merely ack-of-receipt. A bare
    async 200 followed by a dropped extraction would delete the queue entry
    while the content never lands, and (for boot-reconcile remainders whose
    watermark already advanced) there is no reconcile backstop — silent loss
    (the #3244 bug). All drained entries — Stop-hook A2 failures, SessionEnd
    failures, and reconcile-remainder deferrals — are durability retries, so
    sync is correct for every one.
    """
    client = HindsightClient(entry["api_url"], entry.get("api_token"))
    client.retain(
        bank_id=entry["bank_id"],
        content=entry["content"],
        document_id=entry.get("document_id", "conversation"),
        context=entry.get("context"),
        metadata=entry.get("metadata") or {},
        tags=entry.get("tags"),
        timeout=timeout,
        async_processing=False,
    )


def _document_state(entry: dict, timeout: int = 30):
    """Tri-state presence of this entry's document. See ``document_exists``.

    ``True`` present / ``False`` absent / ``None`` unknown. Never raises —
    an unknown must never be mistaken for an absence (which would re-POST
    a durable document) nor for a presence (which would delete the last
    on-disk copy of a turn).
    """
    did = entry.get("document_id")
    bank = entry.get("bank_id")
    if not did or not bank:
        return None
    try:
        client = HindsightClient(entry["api_url"], entry.get("api_token"))
        return client.document_exists(bank, did, timeout=timeout)
    except Exception:
        return None


def _record_failure(
    config: dict,
    path: str,
    entry: dict,
    e: Exception,
    summary: dict,
) -> str:
    """Apply the per-entry failure policy. Returns the error class name.

    Shared by the sequential (SessionStart) and backlog drains so both age
    entries toward ``.dead`` on exactly the same schedule.
    """
    err_class = type(e).__name__
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
    return err_class


def _new_summary() -> dict:
    return {
        "drained": 0,
        "retried": 0,
        "dead": 0,
        "reconciled": 0,
        "unknown": 0,
        "stalled": False,
        "budget_exceeded": False,
    }


def drain_backlog(config: dict | None = None, **kw) -> dict:
    """Two-phase backlog replay, off the SessionStart budget entirely.

    See the module docstring. Summary shape is ``drain()``'s plus
    ``reconciled`` (already durable — no POST issued) and ``unknown``
    (presence could not be established; left queued).
    """
    return drain(config, backlog=True, **kw)


def drain(
    config: dict | None = None,
    backlog: bool = False,
    phase: str = "both",
    dry_run: bool = False,
) -> dict:
    """Walk the pending-retains directory and retry each entry.

    ``backlog=False`` (default) is the bounded in-hook drain.
    ``backlog=True`` is the operator backlog replay — see ``drain_backlog()``.

    Returns a summary dict::

        {"drained": int,   # successful retries (entries deleted)
         "retried": int,   # failures kept for next session
         "dead":    int,   # entries promoted to .dead this run
         "reconciled": int,# already durable, dropped without a POST
         "unknown": int,   # presence unknown, left queued
         "stalled": bool,  # stall guard tripped
         "budget_exceeded": bool}
    """
    config = config or load_config()
    if backlog:
        return _drain_backlog_impl(config, phase=phase, dry_run=dry_run)
    timeout = _per_entry_timeout()
    budget = _budget_seconds()
    started = time.monotonic()

    summary = _new_summary()

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
            err_class = _record_failure(config, path, entry, e, summary)
            if err_class == last_error_class:
                consecutive_failures += 1
            else:
                consecutive_failures = 1
                last_error_class = err_class

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


def _blog(msg: str) -> None:
    print(f"[Hindsight] drain_pending(backlog): {msg}", file=sys.stderr)


def _reconcile_phase(config: dict, summary: dict, dry_run: bool) -> None:
    """PHASE 1 — free pass: drop entries whose document already exists.

    This is the phase that makes backlog replay affordable. 70.4% of a
    measured 5,751-entry fleet backlog was already durable; POSTing those
    is duplicated LLM extraction for zero new memory. A GET costs nothing
    on the model pool.

    Only a definite ``True`` drops an entry. ``False`` leaves it for phase
    2; ``None`` (unknown) leaves it queued and is counted — never guessed.
    """
    entries = iter_entries()
    if not entries:
        return
    _blog(f"phase 1 reconcile: checking {len(entries)} entries (no LLM cost)")
    for path, entry in entries:
        state = _document_state(entry)
        if state is True:
            summary["reconciled"] += 1
            if not dry_run:
                delete_entry(path)
        elif state is None:
            summary["unknown"] += 1
    _blog(
        f"phase 1 done: {summary['reconciled']} already durable "
        f"(no POST issued), {summary['unknown']} unknown (left queued)"
    )


def _wait_for_upstream(config: dict, backoff_ms: int) -> None:
    """Block while the operator-supplied p95 probe says upstream is slow."""
    if backoff_ms <= 0:
        return
    while True:
        p95 = _p95_probe_ms()
        if p95 < 0 or p95 <= backoff_ms:
            return
        _blog(
            f"BACKOFF: upstream p95={p95}ms > {backoff_ms}ms — pausing 120s so "
            f"the replay never becomes the cause of a latency alarm"
        )
        time.sleep(120)


def _drain_backlog_impl(
    config: dict, phase: str = "both", dry_run: bool = False
) -> dict:
    """Concurrent-capable, long-budget, two-phase backlog replay."""
    summary = _new_summary()

    if phase in ("reconcile", "both"):
        _reconcile_phase(config, summary, dry_run)
    if phase == "reconcile":
        return summary

    timeout = _backlog_timeout()
    budget = _backlog_budget_seconds()
    width = _backlog_concurrency()
    sleep_s = _backlog_sleep_seconds()
    backoff_ms = _p95_backoff_ms()
    started = time.monotonic()

    entries = iter_entries()
    if not entries:
        _blog("phase 2: nothing left to retain")
        return summary

    _blog(
        f"phase 2 drain: {len(entries)} entries genuinely need retaining "
        f"(concurrency={width} timeout={timeout}s budget={budget:.0f}s "
        f"sleep={sleep_s}s p95_probe="
        f"{'on' if os.environ.get('HINDSIGHT_DRAIN_P95_CMD') else 'unset'})"
    )
    if dry_run:
        _blog("dry run — no retains issued")
        return summary

    consecutive_failures = 0
    last_error_class: str | None = None

    for start in range(0, len(entries), width):
        if time.monotonic() - started > budget:
            summary["budget_exceeded"] = True
            _blog("budget exhausted, stopping. Remaining entries stay queued — re-run to continue.")
            break

        _wait_for_upstream(config, backoff_ms)

        wave = entries[start : start + width]
        # Results are collected in SUBMISSION order (not completion order)
        # so the stall guard sees a deterministic sequence and behaves
        # identically to the sequential drain.
        with ThreadPoolExecutor(max_workers=width) as pool:
            futures = [
                pool.submit(_retry_one, entry, timeout) for _path, entry in wave
            ]
            outcomes = []
            for fut in futures:
                try:
                    fut.result()
                    outcomes.append(None)
                except Exception as e:  # noqa: BLE001 — per-entry policy below
                    outcomes.append(e)

        for (path, entry), err in zip(wave, outcomes):
            if err is None:
                # COMMIT-BEFORE-DELETE. A 200 is an ack, not proof the
                # document is durable (switchroom #3244), so re-GET before
                # dropping the last on-disk copy. Anything other than a
                # definite True keeps the entry.
                if _document_state(entry) is True:
                    delete_entry(path)
                    summary["drained"] += 1
                else:
                    summary["unknown"] += 1
                    _blog(
                        f"posted but document not confirmed, keeping entry: "
                        f"{os.path.basename(path)}"
                    )
                consecutive_failures = 0
                last_error_class = None
                continue

            # STALL GUARD, evaluated BEFORE the failure is recorded for the
            # rest of the wave. Recording first would let a wave of `width`
            # identical timeouts bump attempt_count on all of them before
            # the loop breaks — aging entries toward .dead FASTER than the
            # sequential drain, the opposite of the point. Counting first
            # and breaking immediately after the tripping entry makes the
            # two paths bump exactly the same number of entries.
            err_class = type(err).__name__
            if err_class == last_error_class:
                consecutive_failures += 1
            else:
                consecutive_failures = 1
                last_error_class = err_class

            _record_failure(config, path, entry, err, summary)

            if consecutive_failures >= STALL_THRESHOLD:
                summary["stalled"] = True
                _blog(
                    f"{consecutive_failures} consecutive failures with "
                    f"{err_class}, stalling. Fix the upstream, then re-run. "
                    f"Remaining entries stay queued."
                )
                break

        if summary["stalled"]:
            break
        if sleep_s:
            time.sleep(sleep_s)

    return summary


def _parse_args(argv: list[str] | None):
    """Real argument parsing.

    Was a bare ``"--backlog" in argv`` membership test, which silently ran
    the 4-second in-hook drain on a typo like ``--backlogg`` while the
    operator believed they had started a backlog replay.
    """
    ap = argparse.ArgumentParser(
        prog="drain_pending.py",
        description="Drain the hindsight pending-retains queue.",
    )
    ap.add_argument(
        "--backlog",
        action="store_true",
        help="two-phase backlog replay, off the SessionStart budget",
    )
    ap.add_argument(
        "--phase",
        choices=["reconcile", "drain", "both"],
        default="both",
        help="with --backlog: run only the free reconcile pass, only the "
        "retain pass, or both (default)",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="with --backlog: report what would happen, issue no writes",
    )
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    if (args.phase != "both" or args.dry_run) and not args.backlog:
        print(
            "[Hindsight] drain_pending: --phase/--dry-run require --backlog",
            file=sys.stderr,
        )
        return 2
    config = load_config()
    summary = drain(
        config, backlog=args.backlog, phase=args.phase, dry_run=args.dry_run
    )
    if any(
        summary[k] for k in ("drained", "retried", "dead", "reconciled", "unknown")
    ):
        print(
            f"[Hindsight] drain_pending{'(backlog)' if args.backlog else ''}: "
            f"drained={summary['drained']} reconciled={summary['reconciled']} "
            f"retried={summary['retried']} dead={summary['dead']} "
            f"unknown={summary['unknown']} "
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
