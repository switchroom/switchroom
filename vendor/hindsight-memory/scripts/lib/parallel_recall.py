"""Deadline-bounded parallel fan-out for the recall critical path.

Switchroom hindsight-leverage A3 (parallel multi-bank recall). The recall
hook (``recall.py``) queries the agent's own bank, every additional bank
(profile / shared / sender), and the active-directives list. Serially, the
critical-path latency is the SUM of those round-trips — a heavy agent with two
extra banks plus directives can serialise four 2-8s calls and breach the 12s
UserPromptSubmit hook ceiling, which drops recall entirely for that turn.

This runs each labelled task in its OWN daemon thread and waits only until a
single SHARED deadline (the hook ceiling minus a headroom margin). Key
properties, all enforced by mechanism rather than convention:

  * **Daemon threads.** Every worker is a daemon, so a thread still blocked on
    a socket read when the deadline elapses can NEVER keep the interpreter (and
    therefore the hook) alive past the ceiling — the process exits and the
    kernel reaps the socket. ``recall.py``'s ``__main__`` additionally calls
    ``os._exit(0)`` after flushing stdout as a belt-and-suspenders against any
    non-daemon thread a client library might spawn.

  * **One shared deadline.** Total wait is bounded by ``deadline_seconds`` from
    the moment ``run_parallel`` is entered — not per-task — so N slow banks
    cost the deadline ONCE, not N times.

  * **Completion is observed, not assumed.** Each slot records whether its
    thread finished before we stopped waiting (``completed``), its return value
    or exception, and its wall-clock ``elapsed_ms``. A slot still running at the
    deadline is ``completed=False`` with ``elapsed_ms`` pinned to the deadline —
    the caller maps that to ``timed_out`` for telemetry.

Stdlib-only (threading + time); no third-party deps, importable under the
plugin's ``python3 -m unittest`` harness.
"""

import threading
import time


class SlotResult:
    """Outcome of one labelled task run under the shared deadline.

    Attributes:
        label:      the task's key in the ``tasks`` mapping.
        value:      the callable's return value, or None if it raised / did not
                    finish before the deadline.
        error:      the exception the callable raised, or None. A slot that hit
                    the deadline mid-flight has ``error=None`` and
                    ``completed=False`` (it never got to raise or return).
        completed:  True iff the worker thread finished (returned or raised)
                    before ``run_parallel`` stopped waiting on it. False means
                    the shared deadline elapsed first.
        elapsed_ms: wall-clock ms the slot took. For a completed slot this is
                    its real duration; for a deadline-abandoned slot it is the
                    time from fan-out start to the deadline.
    """

    __slots__ = ("label", "value", "error", "completed", "elapsed_ms")

    def __init__(self, label):
        self.label = label
        self.value = None
        self.error = None
        self.completed = False
        self.elapsed_ms = None


def _runner(slot, fn, start):
    """Worker body: run the task, capturing value/exception and duration.

    Catches ``BaseException`` deliberately for slot isolation: a slot runs in
    its own daemon thread, and a task failure of ANY kind — including
    non-``Exception`` subclasses like ``KeyboardInterrupt`` /
    ``SystemExit`` — must be captured into ``slot.error`` rather than escaping
    the thread. An escaped exception would let the slot die silently and the
    deadline join would then see no value AND no recorded error. (``socket.timeout``
    is itself just an ``OSError`` subclass, i.e. an ordinary ``Exception``; the
    broad catch is about never letting any slot failure leak out of the thread.)
    """
    try:
        slot.value = fn()
    except BaseException as e:  # noqa: BLE001 - deliberate: isolate the slot
        slot.error = e
    finally:
        slot.elapsed_ms = int((time.monotonic() - start) * 1000)


def run_parallel(tasks, deadline_seconds):
    """Run ``{label: callable}`` concurrently under one shared deadline.

    Args:
        tasks: mapping of label -> zero-arg callable. Each is invoked once in
            its own daemon thread. Insertion order is preserved in the returned
            mapping (Python dicts are ordered) so the caller can emit per-slot
            telemetry deterministically regardless of completion order.
        deadline_seconds: total wall-clock budget for ALL tasks combined,
            measured from entry. Non-positive values run every task with a
            zero join (each slot is recorded as not-completed unless it was
            already instantaneous) — a degenerate "give up immediately" mode.

    Returns:
        ``dict[label] -> SlotResult`` in the same order as ``tasks``. Never
        raises for a task failure — a raising task surfaces via
        ``SlotResult.error``.
    """
    start = time.monotonic()
    pairs = []  # (SlotResult, Thread) in task order
    for label, fn in tasks.items():
        slot = SlotResult(label)
        thread = threading.Thread(
            target=_runner,
            args=(slot, fn, start),
            daemon=True,
            name=f"recall-slot-{label}",
        )
        pairs.append((slot, thread))

    for _slot, thread in pairs:
        thread.start()

    # Join each thread, but never wait past the SHARED deadline. Because the
    # remaining budget is recomputed from ``start`` on every iteration, the
    # total time spent here is bounded by ``deadline_seconds`` even with many
    # slow slots — a fast early slot leaves more budget for later ones, and
    # once the budget is exhausted every subsequent join is a non-blocking
    # ``is_alive`` check.
    for _slot, thread in pairs:
        remaining = deadline_seconds - (time.monotonic() - start)
        if remaining > 0:
            thread.join(remaining)

    # Classify each slot as completed (thread finished) or deadline-abandoned.
    now = time.monotonic()
    results = {}
    for slot, thread in pairs:
        if thread.is_alive():
            slot.completed = False
            if slot.elapsed_ms is None:
                slot.elapsed_ms = int((now - start) * 1000)
        else:
            slot.completed = True
        results[slot.label] = slot
    return results
