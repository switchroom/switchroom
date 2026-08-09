#!/usr/bin/env python3
"""Boot reconciliation of un-committed transcript tails (switchroom #3244 §1.3).

The load-bearing guarantee. The `.jsonl` transcript survives *every* kind of
session death (SIGKILL / OOM / watchdog / SIGTERM) because Claude Code writes it
independent of any hook. This module runs at SessionStart, AFTER the
pending-retains drain, and diffs the durable per-session watermark
(``lib/watermark``) against the on-disk transcript tail: any human turns after
the watermark that were never committed are retained here, BEFORE the new
session starts — so the next ``recall``/``reflect`` sees work an abrupt kill
would otherwise have silently dropped.

Properties (design §1.3):

* **Deterministic + idempotent.** Each slice is posted under the content-derived
  ``document_id`` (``retain.slice_document_id``), so running reconcile twice over
  an unchanged transcript upserts the identical documents. The watermark is
  advanced only after a **confirmed** (``async_processing=False``) 200, so a
  crash mid-reconcile re-does the same slice next boot, never skips it.
* **Bounded, but NEVER silently truncating.** Three bounds — a lookback window
  (``HINDSIGHT_RECONCILE_LOOKBACK_H``, 48h), a per-session turn cap
  (``HINDSIGHT_RECONCILE_MAX_TURNS``, 200), and a wall-clock budget
  (``HINDSIGHT_RECONCILE_BUDGET_S``, 4s) — keep boot cheap, but every bound
  ENQUEUES the excluded remainder to ``pending-retains/`` (drained next boot)
  rather than dropping it. A >48h idle-then-killed session, a >200-turn loss, or
  an over-budget boot is recovered across one or more boots, not forgotten.
* **Shared pacing.** Every inline POST goes through the shared
  ``retain-inflight.lock`` (§1.5) so boot reconcile can never storm the daemon
  alongside a live retain or a running backfill.
"""

from __future__ import annotations

import glob
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib import watermark
from lib.bank import derive_bank_id
from lib.client import HindsightClient
from lib.config import debug_log, load_config
from lib.content import (
    _is_tool_result_only_user_message,
    slice_last_turns_by_user_boundary,
    transcript_first_line_is_sidechain,
)
from lib.daemon import get_api_url
from lib.pacing import inflight_lock
from lib.pending import enqueue as pending_enqueue
from retain import build_retain_payload, read_transcript


def _lookback_seconds() -> float:
    try:
        return max(0.0, float(os.environ.get("HINDSIGHT_RECONCILE_LOOKBACK_H", "48"))) * 3600.0
    except ValueError:
        return 48 * 3600.0


def _max_turns() -> int:
    try:
        return max(1, int(os.environ.get("HINDSIGHT_RECONCILE_MAX_TURNS", "200")))
    except ValueError:
        return 200


def _budget_seconds() -> float:
    try:
        return max(0.5, float(os.environ.get("HINDSIGHT_RECONCILE_BUDGET_S", "4")))
    except ValueError:
        return 4.0


def _enabled(config: dict) -> bool:
    env = os.environ.get("HINDSIGHT_RECONCILE_ON_START")
    if env is not None:
        return env.strip().lower() in ("1", "true", "yes")
    # Config flag (scaffold: memory.retain.reconcile_on_start), default on.
    return bool(config.get("reconcileOnStart", True))


def _transcripts_dir(hook_input: dict | None) -> str | None:
    """Resolve the directory holding this agent's session ``.jsonl`` files.

    Override with ``HINDSIGHT_TRANSCRIPTS_DIR`` (tests / explicit). Otherwise
    derive the Claude ``projects/<project>/`` directory from the boot hook's
    ``transcript_path``. Returns ``None`` when it can't be located (reconcile
    then no-ops — never a crash).
    """
    override = os.environ.get("HINDSIGHT_TRANSCRIPTS_DIR")
    if override:
        return override
    tpath = (hook_input or {}).get("transcript_path") or ""
    if tpath:
        d = os.path.dirname(os.path.abspath(tpath))
        if os.path.isdir(d):
            return d
    return None


def _human_turns(messages: list) -> int:
    return sum(
        1
        for m in messages
        if isinstance(m, dict) and m.get("role") == "user" and not _is_tool_result_only_user_message(m)
    )


def _tail_after(messages: list, last_uuid: str | None) -> list:
    """Return the transcript entries AFTER the watermark anchor.

    No watermark, or a stale anchor compaction removed → the whole transcript is
    the gap (a safe re-upsert, never a skip).
    """
    if not last_uuid:
        return list(messages)
    for i, m in enumerate(messages):
        if isinstance(m, dict) and m.get("uuid") == last_uuid:
            return messages[i + 1:]
    return list(messages)


def _session_id_from_path(path: str) -> str:
    return os.path.splitext(os.path.basename(path))[0]


def _annotate_reconcile_payload(payload: dict, session_id: str, built: dict) -> dict:
    """Stamp watermark-anchoring fields onto a QUEUED reconcile payload.

    switchroom #4571 — the recurring ``pending-retains`` spike. A slice that
    reconcile enqueues (over-budget / out-of-lookback) or defers (turn-cap
    split) is later drained by ``drain_pending.py`` on a confirmed 200, but the
    drain had no way to know WHICH session/uuid the entry anchored, so it never
    advanced the transcript watermark for these paths. Reconcile's gap detection
    is watermark-keyed, so on the next boot it re-derives the identical tail and
    re-enqueues it — a false-alarm queue spike that recurs every boot (no memory
    is lost: enqueue dedupe + the archive protect it, but the depth trips the
    memory-queue watchdog). These fields let the drain advance the watermark once
    the slice is confirmed durable, under the no-loss guard in
    ``drain_pending._commit_reconcile_watermark``.

    ``reconcile_is_tail`` is the load-bearing one: only a slice whose last uuid
    is the TRANSCRIPT tail may ever anchor the watermark. An older remainder
    (turn-cap split) ends mid-transcript, so advancing to it would skip the
    newer turns that follow it.
    """
    ordered = built.get("ordered_uuids") or []
    last_uuid = built.get("last_uuid")
    tail_uuid = ordered[-1] if ordered else None
    payload["reconcile_session_id"] = session_id
    payload["reconcile_last_uuid"] = last_uuid
    payload["reconcile_ordered_uuids"] = ordered
    payload["reconcile_is_tail"] = bool(last_uuid) and last_uuid == tail_uuid
    return payload


def reconcile(config: dict | None = None, hook_input: dict | None = None) -> dict:
    """Diff watermarks vs transcript tails and recover un-committed work.

    Returns a summary dict. Never raises — boot must not be broken by reconcile.
    """
    config = config or load_config()
    summary = {
        "scanned": 0,
        "reconciled": 0,      # transcripts with an inline-posted gap
        "posts_ok": 0,
        "enqueued": 0,        # slices deferred to pending-retains (bounds/failure)
        "skipped_clean": 0,
        "skipped_sidechain": 0,  # sub-agent transcripts (owned by subagent_retain.py)
        "disabled": False,
    }
    if not config.get("autoRetain"):
        summary["disabled"] = True
        return summary
    if not _enabled(config):
        summary["disabled"] = True
        return summary

    tdir = _transcripts_dir(hook_input)
    if not tdir:
        debug_log(config, "reconcile_tail: no transcripts dir resolved, skipping")
        return summary

    # Resolve the daemon WITHOUT starting it — session_start only calls us when
    # the health check already passed. If it's unreachable, skip: the transcript
    # stays on disk and the next boot reconciles (no loss).
    def _dbg(*a):
        debug_log(config, *a)

    try:
        api_url = get_api_url(config, debug_fn=_dbg, allow_daemon_start=False)
        client = HindsightClient(
            api_url,
            config.get("hindsightApiToken"),
            request_timeout_override=config.get("requestTimeoutSeconds"),
        )
    except (RuntimeError, ValueError) as e:
        debug_log(config, f"reconcile_tail: daemon unavailable, skipping: {e}")
        return summary

    api_token = config.get("hindsightApiToken")
    lookback = _lookback_seconds()
    max_turns = _max_turns()
    budget = _budget_seconds()
    started = time.monotonic()
    now = time.time()

    transcripts = sorted(
        glob.glob(os.path.join(tdir, "**", "*.jsonl"), recursive=True)
        + glob.glob(os.path.join(tdir, "*.jsonl"))
    )
    # De-dup (the two globs can overlap) while keeping order.
    seen = set()
    transcripts = [p for p in transcripts if not (p in seen or seen.add(p))]

    for path in transcripts:
        summary["scanned"] += 1
        session_id = _session_id_from_path(path)

        # Sub-agent (sidechain) transcripts are NOT sessions. The recursive glob
        # above matches <session>/subagents/agent-<id>.jsonl, each of which has a
        # human turn, no watermark, and (fresh) an in-lookback mtime — so without
        # this guard reconcile would treat every worker fork as a pseudo-session
        # and retain it here at boot: an UNTAGGED document
        # (agent-<id>-r{u}-{u}, disjoint namespace from subagent_retain.py's
        # {parent}-sub-{agent} ids ⇒ permanent duplicate), at FULL recall weight
        # (defeating the recallTagWeights sidechain:0.8 demotion), bypassing the
        # volume gate (trivial 10s forks get LLM-extracted at boot). Sidechains
        # are owned SOLELY by subagent_retain.py (SubagentStop) — skip them here.
        if transcript_first_line_is_sidechain(path):
            summary["skipped_sidechain"] += 1
            debug_log(config, f"reconcile_tail: skipping sidechain transcript {path}")
            continue

        try:
            mtime = os.path.getmtime(path)
        except OSError:
            continue
        within_lookback = (now - mtime) <= lookback

        messages = read_transcript(path)
        if not messages:
            continue
        wm = watermark.load(session_id)
        last_uuid = wm.get("last_uuid") if wm else None
        tail = _tail_after(messages, last_uuid)
        if _human_turns(tail) == 0:
            summary["skipped_clean"] += 1
            continue

        synthetic_hook = {"session_id": session_id, "cwd": (hook_input or {}).get("cwd", "")}
        bank_id = derive_bank_id(synthetic_hook, config)

        # Out-of-lookback but with a real un-committed tail → do NOT drop it
        # (design §1.3 tier ii): enqueue for a later boot, don't process inline.
        # Over-budget → same treatment.
        if not within_lookback or (time.monotonic() - started) > budget:
            if _enqueue_slice(config, session_id, path, messages, tail, bank_id, api_url, api_token):
                summary["enqueued"] += 1
            continue

        # Turn-cap split: process the most-recent MAX_TURNS human turns inline;
        # defer the OLDER remainder (never truncate).
        recent = slice_last_turns_by_user_boundary(tail, max_turns)
        did_split = len(recent) < len(tail)
        if did_split and _human_turns(tail[: len(tail) - len(recent)]) > 0:
            older = tail[: len(tail) - len(recent)]
            if _enqueue_slice(config, session_id, path, messages, older, bank_id, api_url, api_token):
                summary["enqueued"] += 1

        # CRITICAL (switchroom #3244 F1/F2): when we split, the older remainder
        # (which precedes `recent` in the transcript) is only DEFERRED — either
        # enqueued for a later sync drain, or, if the enqueue failed, not stored
        # at all. Either way it is NOT yet confirmed-persisted. The watermark is
        # a single "last contiguously-committed entry" pointer, so advancing it
        # to `recent`'s end (the transcript tail) would jump PAST the unconfirmed
        # older remainder — and `_tail_after` would then never re-derive it,
        # silently losing it if the drain drops (async) or the enqueue failed.
        # So on a split we do NOT advance the watermark: the recent slice is
        # upserted for immediate recall, but the anchor stays put and the next
        # boot re-derives (and idempotently re-upserts) the whole tail until it
        # fits the budget and is confirmed end-to-end. Redundant work in the
        # rare >MAX_TURNS-loss case; never loss.
        posted = _post_inline(
            config, client, session_id, path, messages, recent, bank_id, api_url, api_token,
            advance_watermark=not did_split,
        )
        if posted == "ok":
            summary["reconciled"] += 1
            summary["posts_ok"] += 1
        elif posted == "enqueued":
            summary["enqueued"] += 1

    debug_log(config, f"reconcile_tail summary: {summary}")
    return summary


def _post_inline(
    config, client, session_id, path, all_messages, slice_messages, bank_id, api_url, api_token,
    advance_watermark: bool = True,
) -> str:
    """POST one gap slice inline, advancing the watermark on confirmed persistence.

    Returns "ok", "enqueued" (POST failed / lock busy → deferred), or "skip".

    ``advance_watermark=False`` (turn-cap split, #3244 F1/F2): the slice is
    upserted for immediate recall but the watermark is NOT moved, because an
    unconfirmed older remainder precedes this slice — advancing would jump past
    it and risk silent loss. The next boot re-derives and idempotently
    re-upserts.
    """
    built = build_retain_payload(
        config,
        session_id,
        slice_messages,
        all_messages,
        bank_id=bank_id,
        api_url=api_url,
        api_token=api_token,
        retain_full_window=True,
        document_id=None,  # deterministic content-derived id (§1)
    )
    if built is None:
        return "skip"
    payload = built["payload"]
    document_id = built["document_id"]
    # Stamp the watermark-anchoring fields so that IF this slice falls through
    # to the pending queue (lock busy / POST failed) the drain can advance the
    # watermark once it lands, instead of leaving reconcile to re-enqueue it
    # every boot (switchroom #4571).
    _annotate_reconcile_payload(payload, session_id, built)

    with inflight_lock(blocking=True) as acquired:
        if not acquired:  # pragma: no cover - blocking acquire fails open
            pending_enqueue(payload, RuntimeError("reconcile lock unavailable"))
            return "enqueued"
        try:
            client.retain(
                bank_id=bank_id,
                content=payload["content"],
                document_id=document_id,
                context=payload["context"],
                metadata=payload["metadata"],
                tags=payload["tags"],
                timeout=15,
                async_processing=False,
                observation_scopes=payload.get("observation_scopes"),
            )
        except Exception as e:
            debug_log(config, f"reconcile_tail: inline POST failed, enqueuing: {e}")
            pending_enqueue(payload, e)
            return "enqueued"

    if not advance_watermark:
        return "ok"

    try:
        watermark.commit(
            session_id,
            built["last_uuid"],
            document_id,
            transcript_path=path,
            ordered_uuids=built["ordered_uuids"],
        )
    except Exception as e:  # pragma: no cover - defensive
        debug_log(config, f"reconcile_tail: watermark commit skipped: {e}")
    return "ok"


def _enqueue_slice(config, session_id, path, all_messages, slice_messages, bank_id, api_url, api_token) -> bool:
    """Build a payload for a slice and enqueue it to pending-retains (no POST)."""
    built = build_retain_payload(
        config,
        session_id,
        slice_messages,
        all_messages,
        bank_id=bank_id,
        api_url=api_url,
        api_token=api_token,
        retain_full_window=True,
        document_id=None,
    )
    if built is None:
        return False
    _annotate_reconcile_payload(built["payload"], session_id, built)
    queued = pending_enqueue(built["payload"], RuntimeError("reconcile deferred (bound/budget)"))
    if queued is None:
        debug_log(config, "reconcile_tail: pending-retains full, could not enqueue remainder")
        return False
    return True


if __name__ == "__main__":
    try:
        s = reconcile()
        print(f"[Hindsight] reconcile_tail: {s}", file=sys.stderr)
    except Exception as e:
        print(f"[Hindsight] reconcile_tail unexpected error: {e}", file=sys.stderr)
        sys.exit(0)
