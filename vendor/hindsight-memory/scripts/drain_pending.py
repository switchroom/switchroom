#!/usr/bin/env python3
"""Drain ``~/.hindsight/pending-retains/``.

SessionStart calls into ``drain()`` to retry any retain payloads that
``session_end.py`` queued on failure (#1071). Each entry is retried up
to ``MAX_ATTEMPTS`` (5) times; after that a **permanently** failing entry
(a 4xx that a re-POST cannot fix — see ``pending.is_permanent_failure``)
is renamed to ``.dead`` so the queue no longer drains it but the operator
can still inspect via ``switchroom doctor``. An entry failing on anything
else — a 5xx, a timeout, a connection error — stays queued past the
attempt budget: a transient upstream is never evidence that the memory
is unsaveable, and retiring it would lose content the user believes was
saved.

An entry past the budget is DEMOTED rather than retired (``_drain_order``
and ``_over_budget``): it sorts behind everything still inside its budget
and abstains from the stall guard. That is what keeps "never destroy a
memory" from degrading into "never drain anything" — the drain is
sequential and oldest-first, so without the demotion three chronically
failing entries sit at the head and end every run at zero progress.

Boundaries
----------
* Per-entry HTTP timeout: ``HINDSIGHT_DRAIN_TIMEOUT`` (default 5s), but
  clamped to the budget still remaining (see below) so a single slow
  entry can never overshoot the wall-clock cap. The default timeout (5s)
  intentionally exceeds the default budget (4s): the clamp, not the raw
  timeout, is what bounds a slow entry.
* Total wall-clock cap: ``HINDSIGHT_DRAIN_BUDGET_S`` (default 4s) so
  drain never blocks SessionStart longer than the upstream hook timeout
  permits. This is the authoritative bound. The clamp is recomputed
  **before every request** — the presence GET and, if it falls through,
  the POST — against the budget remaining *at that moment*, not once per
  entry. Clamping once per entry spends the same allowance twice (a 9s
  budget with an 8s timeout measured 16.0s), so the overshoot is bounded
  by the clamp floor (~1s) only if each request re-reads the remaining
  budget.
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
never deleted and is re-posted on every session start. The queue depth was a symptom
of that loop, not of lost memory: a full sweep of 5,751 queued entries on
this fleet (2026-07-25) found **4,048 (70.4%) already existed as
documents**, 3,815 of them with facts extracted.

``--backlog`` is therefore a two-phase, out-of-hook replay:

* **Phase 1 — reconcile (free).** GET the document. If it exists, the
  memory is already durable; retire the queue entry without a POST. No
  LLM work, no cost, idempotent, resumable at any point. Only for
  post-#3244 CONTENT-derived ``document_id``s — a pre-#3244 bare session
  id is answered 200 by any retain in that session, so its 200 says
  nothing about this entry (see ``_reconcilable_on_presence``).
* **Phase 2 — drain (real work).** Only for genuinely absent documents:
  POST with a realistic timeout, then **re-GET to confirm the document
  exists before retiring the entry**. A 200 is an ack, not proof
  (switchroom #3244).

"Retire" never means ``os.remove``: an entry leaves the queue by MOVING
into the bounded ``pending-reconciled/`` archive (``pending.
archive_reconciled``), because every retire decision here rests on a 200.
That holds unconditionally for THIS module. It does not make the queue
immortal: if the archive cannot be written the entry stays queued, and a
disk that stays full eventually drives ``pending._evict_to_fit`` to shed the
OLDEST live entries on the ENQUEUE path (ledgered, and a ``switchroom
doctor`` failure). Nothing the drain does deletes a turn; a full disk does.

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
    archive_reconciled,
    is_content_derived_document_id,
    is_permanent_failure,
    iter_entries,
    mark_dead,
    update_attempt,
)
from lib.retain_split import retain_client_deadline


STALL_THRESHOLD = 3


def _clamp(timeout: int, budget: float, started: float) -> int:
    """Per-REQUEST HTTP timeout: ``timeout`` capped by the budget LEFT NOW.

    Called immediately before each request — the presence GET and the POST
    — not once per entry. Computing it once and spending it twice makes the
    per-entry cost additive: with the fleet's own settings (budget 9s,
    timeout 8s) a single slow entry measured 16.0s against a 9s budget,
    while the module docstring promised an overshoot of at most the clamp
    floor.

    Floor at 1s so a near-exhausted budget still gets one bounded shot
    rather than a 0s (instant-fail) request. That floor is the entire
    overshoot: at most ~1s per request, ~2s for a GET+POST entry.

    The 1s floor is expressed TWICE and the two are mutually redundant:
    the early ``remaining < 1`` return and the ``max(1, ...)`` below each
    enforce it alone (``int(0.5)`` → 0 → 1; ``int(-5)`` → -5 → 1). That
    redundancy — not a coverage hole — is why single mutations here
    survive: ``<`` → ``<=``, ``max(1`` → ``max(0``, and deleting either
    guard are all EQUIVALENT mutants, verified by exhaustive comparison
    over the boundary plus 200k random remainders (#3599 review R3-L4,
    which reported it as unpinned). What matters is the floor's OUTCOME,
    and that IS pinned: removing both guards fails
    ``ClampAndEnvKnobBoundaryTest.test_clamp_floors_at_one_second_never_zero``
    and ``test_session_start_reconcile_respects_the_hook_budget``. Left as
    two lines deliberately — the shortcut states the intent where a reader
    looks for it, and no mutation of it can change behaviour.

    THE EQUIVALENCE HAS A PRECONDITION, and it is not this function's
    (#3599 review R4-Lb — the paragraph above used to claim it
    unconditionally). ``max(1, min(timeout, int(remaining)))`` collapses to
    ``max(0, ...)`` only while ``timeout >= 1``. With ``timeout == 0`` a
    healthy budget takes the ``max`` branch and the ``max(0`` mutant returns
    **0** — the instant-fail request the floor exists to prevent, on every
    entry. The only callsite invariant that rules this out is
    ``_per_entry_timeout()``'s own ``max(1, v)``, which is what turns
    ``HINDSIGHT_DRAIN_TIMEOUT=0`` into 1. Both callers below take their
    ``timeout`` from it (``drain``'s local, line ~396). So the honest
    statement is: equivalent FOR EVERY REACHABLE INPUT, because
    ``_per_entry_timeout`` floors first — a fact pinned by
    ``ClampAndEnvKnobBoundaryTest.test_the_per_entry_timeout_is_floored_at_one_second``,
    not by anything here. Change that floor and this proof dies with it.
    """
    remaining = budget - (time.monotonic() - started)
    if remaining < 1:
        return 1
    return max(1, min(timeout, int(remaining)))


def _reconcilable_on_presence(entry: dict) -> bool:
    """May a bare presence GET retire this entry? See ``pending.py``.

    Only for post-#3244 content-derived ``document_id``s. A pre-#3244
    entry's id is a bare session id, so a 200 reflects *some* retain in
    that session, not this entry's content.
    """
    return is_content_derived_document_id(entry.get("document_id"))


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

    The default is DERIVED, not a literal: it is
    ``retain_split.retain_client_deadline()`` (280s), the same deadline the
    retain content bound is sized against. Those two must be ONE number.
    This function shipped as a bare ``180`` (#3599), and against a 180s
    deadline both halves of the retain budget break: a maximally-sized part
    is ~276s of sequential extraction, and the SERVER per-call timeout
    derived in ``src/setup/hindsight.ts`` (#3611) is 204s — so the drain
    client would abandon a request the server is still legitimately working
    on, leave the entry queued, and rebuild the re-post loop #3599 exists to
    kill, one size class up.

    ``HINDSIGHT_DRAIN_BACKLOG_TIMEOUT`` still overrides it outright;
    ``HINDSIGHT_RETAIN_CLIENT_DEADLINE_S`` moves the derivation and the
    content bound together.
    """
    return _env_num(
        "HINDSIGHT_DRAIN_BACKLOG_TIMEOUT",
        int(retain_client_deadline()),
        int,
        lo=1,
    )


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

    A CONFIGURED-BUT-BROKEN probe is not the same as an unset one, and
    used to be indistinguishable: ``out.returncode`` was ignored, so a
    typo'd or unauthorized command produced empty stdout, ``int()`` raised,
    and the bare ``except`` returned ``-1`` — silently disabling the very
    backoff the operator had asked for. It still returns ``-1`` (a replay
    that halts because its probe is broken is worse than one that runs
    unpaced), but it now says so loudly on stderr, naming the exit status
    and stderr tail, so the gap is visible in the drain log.
    """
    cmd = os.environ.get("HINDSIGHT_DRAIN_P95_CMD")
    if not cmd:
        return -1
    try:
        out = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=45
        )
    except Exception as e:
        _blog(
            f"p95 probe FAILED to run ({type(e).__name__}: {e}) — backoff is "
            f"DISABLED for this run. Fix HINDSIGHT_DRAIN_P95_CMD."
        )
        return -1
    if out.returncode != 0:
        _blog(
            f"p95 probe exited {out.returncode} — backoff is DISABLED for this "
            f"run. Fix HINDSIGHT_DRAIN_P95_CMD. stderr: "
            f"{(out.stderr or '').strip()[:200]}"
        )
        return -1
    try:
        return int(out.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        _blog(
            f"p95 probe exited 0 but printed no millisecond figure — backoff is "
            f"DISABLED for this run. stdout: {(out.stdout or '').strip()[:200]!r}"
        )
        return -1


def _retry_one(entry: dict, timeout: int) -> None:
    """POST a single queued retain. Raises on failure.

    Posts ``async_processing=False`` (commit-before-ack, switchroom #3244 §1.1):
    the drain is a DURABILITY path — it retires the pending entry on a 200, so
    the 200 must prove durable persistence, not merely ack-of-receipt. A bare
    async 200 followed by a dropped extraction would retire the queue entry
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


def _drain_order(entries: list[tuple[str, dict]]) -> list[tuple[str, dict]]:
    """Oldest-first, but with budget-exhausted entries demoted to the back.

    THE HEAD-OF-LINE BUG THIS EXISTS FOR. Since the permanence gate in
    ``_record_failure``, an entry failing on anything transient stays queued
    past ``MAX_ATTEMPTS`` indefinitely — deliberately, because a transient
    upstream is not evidence the memory is unsaveable. But ``iter_entries()``
    is oldest-first, and the entries that have been failing longest are by
    construction the OLDEST, so they sit at the head of every drain. Backlog
    concurrency defaults to 1 (``_backlog_concurrency``), so the drain is
    sequential: three such entries in a row trip ``STALL_THRESHOLD`` and the
    run breaks having drained nothing — and, because they never retire, it
    breaks identically on every subsequent run. Measured on this branch before
    this function existed: 6 queued entries, the 3 oldest raising
    ``TimeoutError``, 4 consecutive ``drain_backlog`` runs each returning
    ``stalled=True, drained=0`` with the queue depth still 6. The 3 healthy
    entries behind them were never even attempted. On ``main`` the same repro
    converges: run 0 retires the 3 heads to ``.dead`` and run 1 onward drains
    normally. So the permanence gate, alone, traded "rarely destroys a memory"
    for "eventually drains nothing at all".

    ``.dead`` was doing double duty: it was the honesty policy AND it was the
    queue's only un-wedging mechanism. Removing it as a policy has to leave
    the un-wedging behind, and demotion is that — it keeps every property the
    gate was added for (the entry is still queued, still retried, never
    destroyed) while removing the one it broke (it can no longer starve a
    healthy entry behind it).

    The terminal condition for a permanently-unsaveable entry is therefore no
    longer deletion but DEMOTION: ``attempt_count`` only ever climbs, so such
    an entry crosses the budget once and stays in the back group for good,
    where it can delay only itself. It is still reconciled for free on every
    run — ``_reconcile_phase`` sweeps ALL entries with a sub-second presence
    GET, in no particular order and with no stall guard — so an entry whose
    document did land is still retired without a POST.

    Ordering is a stable partition, so relative age is preserved inside each
    group and FIFO still holds for everything that has not blown its budget.
    """
    fresh: list[tuple[str, dict]] = []
    exhausted: list[tuple[str, dict]] = []
    for path, entry in entries:
        (exhausted if _over_budget(entry) else fresh).append((path, entry))
    return fresh + exhausted


def _over_budget(entry: dict) -> bool:
    """Has this entry already burned its ``MAX_ATTEMPTS`` budget?

    Such an entry is chronically failing but, since the permanence gate, is
    never retired. It gets two demotions — last in the drain order
    (``_drain_order``) and no vote in the stall guard (see below) — because
    ordering alone does not close the wedge. Ordering fixes the common shape
    (a few old poison entries in front of healthy ones), but not the shape
    where the WHOLE queue is over budget: an upstream down for a week takes
    every entry past 5 attempts, and when it recovers the partition is empty
    on one side, the poisoned entries are at the head again, and the run
    stalls before reaching the entries that would now succeed. Measured: with
    ordering alone and all 6 entries at ``MAX_ATTEMPTS``, 4 consecutive runs
    still returned ``stalled=True, drained=0``.
    """
    try:
        return int(entry.get("attempt_count", 0)) >= MAX_ATTEMPTS
    except (TypeError, ValueError):
        # A hand-edited or corrupt counter must not decide ordering, and must
        # not raise on the drain path. Treat it as fresh: the cost of guessing
        # wrong here is one retry in the normal position, not a lost memory.
        return False


def _record_failure(
    config: dict,
    path: str,
    entry: dict,
    e: Exception,
    summary: dict,
) -> str:
    """Apply the per-entry failure policy. Returns the error class name.

    Shared by the sequential (SessionStart) and backlog drains so both age
    entries toward ``.dead`` on exactly the same schedule — and, since the
    permanence gate below, refuse to retire them on exactly the same rule.
    """
    err_class = type(e).__name__
    attempts = int(entry.get("attempt_count", 1))
    # ``.dead`` retires a memory the user believes was saved, so it is gated on
    # the failure being PERMANENT — a 4xx that re-POSTing cannot fix. A
    # transient failure keeps its attempt counter climbing but stays queued,
    # because an exhausted attempt budget is not evidence that the content is
    # unpersistable.
    #
    # Before this gate, ANY five failures retired the entry. The dominant
    # failure on this fleet is an HTTP 500 "Fact extraction failed … chunk 0:
    # JSONDecodeError" — the extraction model returned an empty or non-JSON
    # completion for one chunk on that sampling run. The identical content
    # succeeds on a later attempt, so five unlucky samples were destroying
    # memories that were never unsaveable. See ``pending.is_permanent_failure``.
    #
    # WHAT BOUNDS THIS, precisely — because an unbounded queue of undying
    # entries would be a worse outcome than the bug this gate fixes.
    #
    # DISK is bounded by the queue's MAX_ENTRIES / MAX_BYTES caps, which shed
    # the oldest entries into ``pending-evicted/`` (an archive, not a delete).
    # Note what that bound is NOT: ``_evict_to_fit`` is called only from
    # ``enqueue`` (lib/pending.py:933), so it fires on new writes, never on
    # drain — and it "bounds" the queue by shedding memory unsaved, which is
    # the very outcome this gate exists to avoid. It is a backstop, not the
    # answer.
    #
    # PROGRESS is bounded by ``_drain_order`` / ``_over_budget``. An entry that
    # can never be persisted no longer terminates by being destroyed; it
    # terminates by being DEMOTED — sorted behind every entry still inside its
    # budget, and stripped of its vote in the stall guard. ``attempt_count``
    # only ever climbs, so the crossing happens once and is permanent. That is
    # the real terminal condition, and it is what keeps a poisoned entry from
    # starving the queue behind it. Without it, three such entries ended every
    # drain at zero progress, permanently (tests/test_pending_wedge.py).
    #
    # The attempt counter itself was never a bound on either, and ``switchroom
    # doctor`` still surfaces queue depth so the operator sees a growing tail.
    if attempts >= MAX_ATTEMPTS and is_permanent_failure(e):
        marker = mark_dead(path, entry)
        summary["dead"] += 1
        print(
            f"[Hindsight] drain_pending: entry exceeded {MAX_ATTEMPTS} "
            f"attempts on a permanent failure, marking dead at {marker} "
            f"(last error: {err_class}: {e})",
            file=sys.stderr,
        )
    else:
        update_attempt(path, entry, e)
        summary["retried"] += 1
        debug_log(
            config,
            # ``attempts`` can now exceed MAX_ATTEMPTS — a transient failure
            # keeps the entry queued past the budget instead of retiring it —
            # so print the budget as a threshold, not as a fraction that would
            # render the nonsense "retry 7/5".
            f"drain_pending: retry {attempts} (budget {MAX_ATTEMPTS}) failed "
            f"for {path} ({err_class}: {e})",
        )
    return err_class


def _new_summary() -> dict:
    return {
        "drained": 0,
        "retried": 0,
        "dead": 0,
        "reconciled": 0,
        "unknown": 0,
        # Presence WAS established, but the entry could not be moved into
        # the archive (ENOSPC, EACCES, read-only mount). It is still queued
        # — archiving never falls back to a delete (#3599 review R3-M1) —
        # so it must not be counted as drained/reconciled, which would
        # report a retire that did not happen.
        "archive_failed": 0,
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

        {"drained": int,   # successful retries (entries archived)
         "retried": int,   # failures kept for next session
         "dead":    int,   # entries promoted to .dead this run
         "reconciled": int,# already durable, archived without a POST
         "unknown": int,   # presence unknown, left queued
         "archive_failed": int,  # durable, but the archive was unwritable
                                 # so the entry is STILL QUEUED
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

    # Budget-exhausted entries go last so they cannot starve the healthy ones
    # behind them — see ``_drain_order``. Matters even more here than in the
    # backlog drain: the in-hook budget is ~4s, so a single entry at the head
    # that always burns its clamped timeout consumes the entire run.
    entries = _drain_order(iter_entries())
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

        # RECONCILE BEFORE RETRY — this is the fix for the re-post loop in
        # the path that actually runs on every boot, not just in --backlog.
        # 70.4% of the measured fleet backlog already existed as documents;
        # re-POSTing those inside the hook is a guaranteed client timeout
        # (the clamp is far below a 30-90s synchronous retain), 30-90s of
        # wasted server-side extraction, and one more step toward .dead for
        # a memory that was never actually lost.
        #
        # A GET is sub-second and it REPLACES that doomed POST, so this
        # strictly reduces both hook latency and upstream load. Only a
        # definite True retires the entry: False and None (unknown) fall
        # through to the retry, because guessing "present" would retire the
        # last on-disk copy of a turn.
        #
        # GATED ON THE ID SHAPE. A presence GET only proves *this* entry's
        # content was committed when the document_id is content-derived
        # (post-#3244 `retain.slice_document_id`). A pre-#3244 entry carries
        # a bare session id, for which the bank answers 200 after ANY
        # successful retain in that session — reconciling on that deletes a
        # turn that was never committed. Such entries skip the free pass and
        # go straight to the POST, which is the only thing that can make
        # them durable.
        if _reconcilable_on_presence(entry):
            if _document_state(entry, timeout=_clamp(timeout, budget, started)) is True:
                if archive_reconciled(path):
                    summary["reconciled"] += 1
                else:
                    # Archive unwritable: the entry is STILL QUEUED (it is
                    # never deleted), so calling it reconciled would be a lie.
                    summary["archive_failed"] += 1
                consecutive_failures = 0
                last_error_class = None
                continue

        try:
            # Re-clamp: the GET above spent part of the budget, and the same
            # allowance must not be handed out twice (#3599 review F2).
            _retry_one(entry, timeout=_clamp(timeout, budget, started))
        except Exception as e:
            # Read the budget state BEFORE _record_failure: update_attempt
            # mutates `entry["attempt_count"]` in place (lib/pending.py:1020),
            # so asking afterwards would count the entry that just CROSSED the
            # budget on this very failure as an abstainer, silently weakening
            # the stall guard for ordinary entries.
            abstains = _over_budget(entry)
            err_class = _record_failure(config, path, entry, e, summary)
            # STALL GUARD ABSTENTION — see ``_over_budget``. The guard exists
            # to detect a broken UPSTREAM and stop hammering it. A chronically
            # failing entry that has already burned its attempt budget is
            # evidence about that ENTRY, not about the upstream, and letting it
            # vote is what wedges the queue: it never retires, so it fails
            # identically on every run, and three of them end every run before
            # the healthy entries behind them are ever reached. It abstains —
            # neither incrementing the counter nor resetting it, so a genuine
            # upstream outage is still caught by the fresh entries around it.
            if not abstains:
                if err_class == last_error_class:
                    consecutive_failures += 1
                else:
                    consecutive_failures = 1
                    last_error_class = err_class

            if not abstains and consecutive_failures >= STALL_THRESHOLD:
                summary["stalled"] = True
                print(
                    f"[Hindsight] drain_pending: {consecutive_failures} consecutive "
                    f"failures with {err_class}, stalling drain. Remaining entries "
                    f"stay queued.",
                    file=sys.stderr,
                )
                break
            continue

        # Success — retire the entry. ARCHIVED, not deleted.
        #
        # The evidence here is the POST's own 200 and nothing else: a 5s
        # hook budget has no room for the confirming re-GET the backlog
        # drain issues. Not a BARE 200 though (#3599 review R4-B3 corrects
        # this comment, which used to say so): ``_retry_one`` posts
        # ``async_processing=False``, so the 200 is a commit-before-ack
        # (#3244 §1.1) — the daemon's statement that it durably committed,
        # not merely that it received. Weaker than an independent read,
        # much stronger than an async ack.
        #
        # The residual risk is a daemon that does not honour ``async=false``.
        # Archiving rather than deleting keeps a recoverable copy for that
        # case — bounded by ``pending-reconciled/``'s caps, so recoverable
        # has a horizon; ``pending._trim_dir`` documents exactly what that
        # horizon costs.
        if archive_reconciled(path):
            summary["drained"] += 1
        else:
            summary["archive_failed"] += 1
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

    Only a definite ``True`` retires an entry, and only for a post-#3244
    content-derived ``document_id`` (see ``_reconcilable_on_presence``) —
    a bare session id's 200 says nothing about *this* entry's content.
    ``False`` leaves it for phase 2; ``None`` (unknown) leaves it queued
    and is counted — never guessed. Retiring MOVES the entry into
    ``pending-reconciled/``; it is never ``os.remove``d.
    """
    entries = iter_entries()
    if not entries:
        return
    _blog(f"phase 1 reconcile: checking {len(entries)} entries (no LLM cost)")
    skipped = 0
    for path, entry in entries:
        if not _reconcilable_on_presence(entry):
            skipped += 1
            continue
        state = _document_state(entry)
        if state is True:
            if dry_run or archive_reconciled(path):
                summary["reconciled"] += 1
            else:
                summary["archive_failed"] += 1
        elif state is None:
            summary["unknown"] += 1
    if skipped:
        _blog(
            f"phase 1: {skipped} entries have a pre-#3244 (bare session) "
            f"document_id — a presence GET cannot prove THEIR content was "
            f"committed, so they go to phase 2 rather than the free pass"
        )
    _blog(
        f"phase 1 done: {summary['reconciled']} already durable "
        f"(no POST issued), {summary['unknown']} unknown (left queued)"
        + (
            f", {summary['archive_failed']} confirmed durable but NOT retired "
            f"(archive unwritable — still queued)"
            if summary["archive_failed"]
            else ""
        )
    )


def _wait_for_upstream(backoff_ms: int, started: float, budget: float) -> bool:
    """Block while the p95 probe says upstream is slow. False ⇒ give up.

    The wait is bounded by the SAME wall-clock budget as the drain itself.
    An unbounded ``while True: sleep(120)`` would let a persistently
    degraded upstream block ``drain_backlog()`` indefinitely, long past the
    budget the operator set — the one guarantee this mode makes about how
    long it will run.
    """
    if backoff_ms <= 0:
        return True
    while True:
        p95 = _p95_probe_ms()
        if p95 < 0 or p95 <= backoff_ms:
            return True
        if time.monotonic() - started + 120 > budget:
            _blog(
                f"upstream still slow (p95={p95}ms > {backoff_ms}ms) and the "
                f"budget is exhausted — stopping rather than waiting past it. "
                f"Remaining entries stay queued; re-run when upstream recovers."
            )
            return False
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

    # See ``_drain_order``: without this, three budget-exhausted entries at the
    # head trip the stall guard on every run forever and the drain never makes
    # progress again.
    entries = _drain_order(iter_entries())
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

    # BUDGET GRANULARITY: checked between waves, not mid-wave, so a run can
    # overshoot `budget` by at most one wave — up to HINDSIGHT_DRAIN_BACKLOG_
    # TIMEOUT (280s default, `_backlog_timeout`) plus the confirming GETs.
    # That is deliberate:
    # abandoning an in-flight wave would leave entries whose POST the server
    # is still committing, and the whole point of commit-before-delete is not
    # to guess about those. Unlike the in-hook drain (whose overshoot is
    # clamped to ~1s because a SessionStart hook has a hard deadline), this
    # mode has no deadline to miss — so a bounded overshoot is the cheaper
    # trade.
    for start in range(0, len(entries), width):
        if time.monotonic() - started > budget:
            summary["budget_exceeded"] = True
            _blog("budget exhausted, stopping. Remaining entries stay queued — re-run to continue.")
            break

        if not _wait_for_upstream(backoff_ms, started, budget):
            summary["budget_exceeded"] = True
            break

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
                # COMMIT-BEFORE-RETIRE. A 200 is an ack, not proof the
                # document is durable (switchroom #3244), so re-GET before
                # retiring the last on-disk copy. Anything other than a
                # definite True keeps the entry. This confirming GET is
                # meaningful even for a pre-#3244 bare-session id: unlike
                # the free reconcile pass, it is corroborated by the
                # synchronous POST of THIS entry's content that just
                # returned 200. And the entry is archived, not deleted.
                if _document_state(entry) is True:
                    if archive_reconciled(path):
                        summary["drained"] += 1
                    else:
                        summary["archive_failed"] += 1
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
            # STALL GUARD ABSTENTION for entries past their attempt budget —
            # see ``_over_budget`` and the matching branch in the sequential
            # drain. Evaluated here, before ``_record_failure``, which is both
            # where the sequential drain evaluates it and necessary anyway
            # because ``update_attempt`` mutates ``attempt_count`` in place.
            abstains = _over_budget(entry)
            if not abstains:
                if err_class == last_error_class:
                    consecutive_failures += 1
                else:
                    consecutive_failures = 1
                    last_error_class = err_class

            _record_failure(config, path, entry, err, summary)

            if not abstains and consecutive_failures >= STALL_THRESHOLD:
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
        summary[k]
        for k in (
            "drained",
            "retried",
            "dead",
            "reconciled",
            "unknown",
            "archive_failed",
        )
    ):
        print(
            f"[Hindsight] drain_pending{'(backlog)' if args.backlog else ''}: "
            f"drained={summary['drained']} reconciled={summary['reconciled']} "
            f"retried={summary['retried']} dead={summary['dead']} "
            f"unknown={summary['unknown']} "
            f"archive_failed={summary['archive_failed']} "
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
