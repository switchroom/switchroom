#!/usr/bin/env python3
"""Auto-retain hook for the SubagentStop event (switchroom hindsight-leverage PR5).

Delegated (sub-agent / Task-tool) work is the biggest systematic memory hole:
the main-session Stop retain only ever reads the parent ``transcript_path``, so
a worker's hours of reasoning — the constraints it discovered, the structural
dead ends it ruled out — reach memory only as the terse final report the parent
transcript captures. This hook closes that hole by retaining a bounded window of
the *sidechain* transcript when a sub-agent terminates.

Scope (Ken, 2026-07-29): LEARNINGS, not raw transcripts and tools. The window is
retained on the TEXT-ONLY formatting path (``run_subagent_retain`` forces
``retainToolCalls = False`` on its config copy), so what reaches memory is the
sub-agent's own prose — reasoning, findings, final report — and NOT tool_use
inputs, tool_result bodies, file contents or diffs.

The text-only path cannot format to nothing here: the volume gate already
requires ``MIN_HUMAN_TURNS`` GENUINE human turns (tool_result-only user messages
are explicitly not counted, ``count_human_turns``), and every such turn is a
plain-string user message that ``_extract_text_content`` returns verbatim. So a
window that clears the gate always carries at least its instruction turns, and
``build_retain_payload`` never returns None on this path for volume reasons.

Probe result (Claude Code 2.1.215, PR5 Task 0 — recorded in the PR body):
the ``SubagentStop`` hook input carries BOTH the parent ``transcript_path`` AND
a first-class ``agent_transcript_path`` pointing straight at the sidechain
``.jsonl`` (``<projectdir>/<session_id>/subagents/agent-<agent_id>.jsonl``),
plus ``agent_id`` / ``agent_type`` / ``last_assistant_message``. So the design's
assumed field exists — just named ``agent_transcript_path``, not
``transcript_path``. We use it as the primary path and keep the documented
directory-scan (newest ``isSidechain:true`` jsonl) as a fallback for older CLIs
that predate the field.

Flow:
  1. Read hook input from stdin (session_id, transcript_path,
     agent_transcript_path, agent_id, cwd, ...).
  2. Resolve the sidechain transcript (agent_transcript_path → derived
     subagents/ dir → project-dir scan).
  3. Volume gate: skip sub-agents below the floor (< 6 human turns OR
     < 2,000 chars of RETAINED text — the chars the text-only path keeps,
     #3994) — SubagentStop fires for every Task including 10-second forks, and
     each retain is an LLM-backed extraction.
  4. Retain a bounded window (last N=40 human turns), tagged ``sidechain`` +
     ``parent_session:<id>``, with a deterministic content-derived document_id
     so re-fires upsert instead of duplicating.
  5. Failures enqueue to the SAME pending-retains durability queue the Stop
     retain uses (drained at the next SessionStart) — no new machinery.

Exit codes:
  0 — always (graceful degradation on any error). Durability comes from the
      pending-retains enqueue, not the exit code (retain.py mirrors this).
"""

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib.bank import derive_bank_id, ensure_bank_mission
from lib.client import HindsightClient
from lib.config import debug_log, load_config
from lib.content import (
    _extract_text_content,
    _is_tool_result_only_user_message,
    slice_last_turns_by_user_boundary,
    transcript_first_line_is_sidechain,
)
from lib.daemon import get_api_url
from lib.pacing import inflight_lock

# retain.py owns the transcript reader, the deterministic-id recipe and the
# network-free payload builder; reuse them wholesale so the sidechain path
# stays byte-identical to the main path where it matters (dedup ids, formatting).
from retain import (
    _has_open_interval,
    build_retain_payload,
    read_privacy_state,
    read_transcript,
)

# Retain the last N human turns of the sidechain. The window is formatted on the
# TEXT-ONLY path (``retainToolCalls`` is forced False for the sidechain — see
# ``run_subagent_retain``), so tool_use inputs and tool_result bodies are dropped
# entirely rather than passed through / truncated. ``_extract_text_content`` is
# imported here so the volume gate's char count measures the SAME text the retain
# path keeps (#3994) — gate and payload never diverge.
SIDECHAIN_WINDOW_TURNS = 40

# Volume gate floors — SubagentStop fires for every Task, so skip trivial forks.
MIN_HUMAN_TURNS = 6
MIN_NON_TOOL_RESULT_CHARS = 2000

# Bounded read (review finding 4): cap the sidechain transcript read so a
# multi-hour worker's arbitrarily-large jsonl can't eat the 15s hook budget on
# the read before the POST/enqueue. 8 MB comfortably holds >> the 40-turn retain
# window and the gate floors even with truncated tool_results; the tail is read
# in order, so the window slice and PASS/skip are unaffected in practice.
SIDECHAIN_MAX_READ_BYTES = 8 * 1024 * 1024

# Fallback scan freshness window (review finding 3): when we have to SCAN for the
# sidechain (older CLIs with no ``agent_transcript_path``), only accept a file
# whose mtime is within this many seconds of the hook fire, so a stale sidechain
# from an earlier turn in the same session dir is never mis-picked. Residual race
# (documented, unavoidable without the first-class field): two old-CLI workers
# that BOTH stop inside this window pick the newest by mtime, so the other's
# sidechain is skipped this fire — it is recovered on no path (old CLIs predate
# agent_transcript_path); this is strictly better than the pre-field behaviour of
# no sidechain retain at all, and does not affect any CLI that populates the
# first-class field (the common path, which never scans).
SIDECHAIN_SCAN_FRESH_WINDOW_S = 300

# Extraction-framing header prepended to the retained content. The retain API
# has no per-call mission (mission is bank-level), so the only lever available
# here is a short in-content note. Deterministic text — it does not change the
# document_id (that is computed from the raw slice before this is prepended).
#
# 2026-07-29 rewrite. The original text asked the extractor for "PROCESS facts:
# files/paths touched, commands that worked, ..." — i.e. it explicitly SOLICITED
# the exact classes the bank-level mission (`DEFAULT_RETAIN_MISSION` in
# src/memory/hindsight.ts) enumerates as NEVER-extract: file paths, tool-result
# exhaust, narration of what the assistant did, volatile state. Because this
# header sits inside the content the extractor reads, it read as a local
# override and countermanded the bank mission on the sidechain path. The header
# now REINFORCES the bank mission instead of fighting it: it keeps the genuinely
# durable half of the old wording (decisions with their rationale, non-obvious
# technique, structural dead ends) and names the ephemera to drop.
# Governing test: would this still be worth knowing in a month?
SIDECHAIN_MISSION_HEADER = (
    "[sidechain sub-agent work log. Apply the bank's retain mission unchanged; "
    "this is raw work exhaust and most of it is NOT memorable. Extract only "
    "durable knowledge — something that would still be worth knowing in a month: "
    "decisions made and the reasoning behind them; a non-obvious technique or "
    "constraint that would save the next agent real time; a STRUCTURAL dead end "
    "(\"X cannot work because Y\") as opposed to an incidental one (\"the command "
    "failed so I retried\"). "
    "Do NOT extract: the status of in-flight or unfinished work; PR, issue, "
    "branch, review or CI state; counts, metrics, versions, sizes or any other "
    "value that changes; container, process or runtime snapshots; narration of "
    "what the agent did, including lists of the files, paths or commands it "
    "touched; paths under /tmp or a scratchpad directory; session, agent, "
    "request or operation IDs; the restated mission prose; routine tool chatter. "
    "Anything whose truth expires when this session does is not a memory. "
    "If nothing durable remains, extract nothing.]"
)


def _agent_id_from_path(path: str) -> str:
    """Best-effort agent id from a ``.../subagents/agent-<id>.jsonl`` filename."""
    if not path:
        return ""
    base = os.path.basename(path)
    if base.startswith("agent-") and base.endswith(".jsonl"):
        return base[len("agent-"):-len(".jsonl")]
    return ""


def resolve_sidechain_transcript(hook_input: dict) -> str:
    """Resolve the sidechain transcript path from the SubagentStop hook input.

    Layered, most-authoritative first:

    1. ``agent_transcript_path`` — the first-class field the CLI provides
       (probe-confirmed on 2.1.215). Accepted only after VALIDATION (review
       finding 2): it must exist, actually be a sidechain
       (``transcript_first_line_is_sidechain``), and NOT equal the parent
       ``transcript_path`` — so a CLI that populates the field differently can
       never make us retain the parent's main-session content under the
       sub-agent namespace (systematic double-retain).
    2. Derived ``<projectdir>/<session_id>/subagents/agent-<agent_id>.jsonl``
       from ``transcript_path`` + ``session_id`` + ``agent_id`` — for CLIs that
       omit ``agent_transcript_path`` but still write the standard layout.
    3. Newest ``isSidechain:true`` ``.jsonl`` in that exact ``subagents/`` dir
       whose mtime is the most recent AND within ``SIDECHAIN_SCAN_FRESH_WINDOW_S``
       of the hook fire — the design's documented directory-scan fallback (see
       that constant for the residual old-CLI race bound). The scan is
       deliberately confined to the derived ``<session_id>/subagents/`` dir
       (a single, bounded ``listdir``) — NOT a recursive walk of the project
       dir, which for a malformed ``transcript_path`` could resolve to ``/`` and
       walk the whole filesystem.

    Returns "" when nothing plausible is found.
    """
    parent_transcript = hook_input.get("transcript_path", "") or ""

    # 1. First-class field — validated (finding 2).
    p = hook_input.get("agent_transcript_path")
    if (
        isinstance(p, str)
        and p
        and p != parent_transcript
        and os.path.isfile(p)
        and transcript_first_line_is_sidechain(p)
    ):
        return p

    session_id = hook_input.get("session_id", "") or ""
    agent_id = hook_input.get("agent_id", "") or ""

    # The parent transcript lives at <projectdir>/<session_id>.jsonl; the
    # sidechains sit under <projectdir>/<session_id>/subagents/.
    project_dir = os.path.dirname(parent_transcript) if parent_transcript else ""
    subagents_dir = ""
    if project_dir and session_id:
        subagents_dir = os.path.join(project_dir, session_id, "subagents")

    # 2. Derived exact path from agent_id — still validated as a sidechain and
    # not the parent (defensive symmetry with path 1).
    if subagents_dir and agent_id:
        cand = os.path.join(subagents_dir, f"agent-{agent_id}.jsonl")
        if (
            os.path.isfile(cand)
            and cand != parent_transcript
            and transcript_first_line_is_sidechain(cand)
        ):
            return cand

    # 3. Newest fresh isSidechain jsonl in the bounded subagents dir (never a
    # recursive project-dir walk — see the docstring).
    return _newest_sidechain_jsonl(subagents_dir, exclude=parent_transcript) if subagents_dir else ""


def _newest_sidechain_jsonl(root: str, exclude: str = "") -> str:
    """Newest (by mtime) ``.jsonl`` directly in ``root`` whose first line is a
    sidechain entry AND whose mtime is within ``SIDECHAIN_SCAN_FRESH_WINDOW_S``
    of now. Non-recursive: a single bounded ``listdir`` of the derived
    ``<session_id>/subagents/`` dir.

    ``exclude`` skips a specific path (the parent transcript). Returns "" if none
    / dir missing. The freshness window (finding 3) keeps a stale sidechain from
    a prior turn out of contention; see the constant for the residual race bound.
    """
    if not root or not os.path.isdir(root):
        return ""
    cutoff = time.time() - SIDECHAIN_SCAN_FRESH_WINDOW_S
    best_path = ""
    best_mtime = -1.0
    try:
        names = os.listdir(root)
    except OSError:
        return ""
    for name in names:
        if not name.endswith(".jsonl"):
            continue
        full = os.path.join(root, name)
        if exclude and os.path.abspath(full) == os.path.abspath(exclude):
            continue
        try:
            mtime = os.path.getmtime(full)
        except OSError:
            continue
        if mtime < cutoff or mtime <= best_mtime:
            continue
        if transcript_first_line_is_sidechain(full):
            best_path, best_mtime = full, mtime
    return best_path


def count_human_turns(messages: list) -> int:
    """Genuine human-turn count (tool_result-only user messages don't count)."""
    n = 0
    for m in messages:
        if not isinstance(m, dict):
            continue
        if m.get("role") == "user" and not _is_tool_result_only_user_message(m):
            n += 1
    return n


def retained_text_char_count(messages: list, stop_at: int | None = None) -> int:
    """Total chars of the content the TEXT-ONLY retain path actually keeps.

    #3994 — GATE COUNTS WHAT IS RETAINED. The sidechain payload is built with
    ``retainToolCalls = False`` (``run_subagent_retain``), so what reaches memory
    is exactly ``_extract_text_content``: assistant ``text`` blocks, channel-
    message tool_use text, and plain-string user turns — and NOTHING else. This
    gate counts the same thing, per message, so "cleared the floor" now means
    "has >= N chars of RETAINABLE prose", not "emitted N chars of tool traffic
    the payload then drops".

    The previous revision counted ``tool_use`` name+input serialized size on top
    of text. Those chars are no longer in the payload, so the old gate could
    clear on tool volume that contributed zero to the stored memory (a tool-heavy
    / prose-light fork passed, then retained a near-empty document). Counting via
    ``_extract_text_content`` closes that mismatch: gate and payload measure the
    identical char set. The 2,000-char floor was re-measured against this metric
    — see ``docs/measurements/subagent-volume-gate-3994.md`` and the replay
    harness ``scripts/tests/data/replay_volume_gate_3994.py``.

    ``stop_at`` (review finding 4 — early short-circuit): return as soon as the
    running total reaches this many chars. The gate only needs to know whether
    the floor is CLEARED, not the exact size — so on a large worker transcript we
    stop the walk the moment the floor is met (the returned value is then a
    floor, ``>= stop_at``, sufficient for the ``>=`` comparison and the skip
    log's "chars>=N" read).
    """
    total = 0
    for m in messages:
        if not isinstance(m, dict):
            continue
        # Count exactly the chars the text-only retain path keeps for this
        # message — identical extraction to ``prepare_retention_transcript``'s
        # ``include_tool_calls=False`` branch, so gate and payload never diverge.
        total += len(_extract_text_content(m.get("content", ""), role=m.get("role", "")))
        if stop_at is not None and total >= stop_at:
            return total
    return total


# Back-compat alias: the previous name measured a superset (text + tool_use).
# Kept so an out-of-tree caller does not break, but it now returns the
# recalibrated text-only count (#3994).
non_tool_result_char_count = retained_text_char_count


def passes_volume_gate(messages: list, config: dict) -> tuple:
    """Return ``(passed, human_turns, char_count)`` for the volume gate.

    Skip sub-agents below EITHER floor: < ``MIN_HUMAN_TURNS`` human turns OR
    < ``MIN_NON_TOOL_RESULT_CHARS`` chars of RETAINED text (the chars the
    text-only path actually keeps, #3994). The char walk short-circuits at the
    floor (finding 4) — ``char_count`` is exact when below the floor and a lower
    bound (``>= floor``) once cleared.
    """
    turns = count_human_turns(messages)
    chars = retained_text_char_count(messages, stop_at=MIN_NON_TOOL_RESULT_CHARS)
    passed = turns >= MIN_HUMAN_TURNS and chars >= MIN_NON_TOOL_RESULT_CHARS
    return passed, turns, chars


def run_subagent_retain(hook_input: dict) -> dict:
    """Retain a bounded window of the sidechain transcript.

    Returns a status dict shaped like ``retain.run_retain``::

        {"status": "ok" | "skipped" | "failed",
         "payload": {...},   # only when status == "failed" (for enqueue)
         "error":   Exception}  # only when status == "failed"
    """
    # /private-mode enforcement (switchroom privacy PR1) — FIRST, before
    # load_config(). Subagents have no toggle of their own; they honor the
    # parent session's privacy state file (same env, same path). An OPEN private
    # interval means confidential material is being discussed right now, so the
    # sidechain retain must not fire — placed above load_config() so a
    # HINDSIGHT_AUTO_RETAIN=true env pin cannot override the privacy guarantee.
    if _has_open_interval(read_privacy_state()):
        return {"status": "skipped", "reason": "private-mode"}

    config = load_config()

    if not config.get("autoRetain"):
        debug_log(config, "Auto-retain disabled, exiting subagent retain")
        return {"status": "skipped", "reason": "autoRetain disabled"}

    # Blocked-Stop-style re-fire guard: harmless here (deterministic id upserts),
    # but skip a re-fire to avoid a redundant LLM extraction.
    #
    # KNOWN LIMITATION (review finding 5): if another SubagentStop hook BLOCKS
    # the stop, the sub-agent continues and SubagentStop re-fires carrying
    # ``stop_hook_active: true``; we skip that fire, so any turns the sub-agent
    # ADDED after the block are not retained on the re-fire. Accepted, because
    # (a) the deterministic ``{session}-sub-{agent}-r{start}-{end}`` id means the
    # eventual non-blocked fire (or a later re-dispatch) upserts the fuller
    # window, and (b) skipping avoids a duplicate LLM extraction on every blocked
    # continuation. No sidechain currently registers a blocking SubagentStop, so
    # this is latent; revisit if one is added.
    if hook_input.get("stop_hook_active"):
        debug_log(config, "SubagentStop re-fire (stop_hook_active) — skipping")
        return {"status": "skipped", "reason": "stop_hook_active"}

    session_id = hook_input.get("session_id", "unknown")
    agent_id = hook_input.get("agent_id", "") or ""
    agent_type = hook_input.get("agent_type", "") or ""

    transcript_path = resolve_sidechain_transcript(hook_input)
    if not transcript_path:
        debug_log(
            config,
            f"SubagentStop: no sidechain transcript resolved "
            f"(session={session_id}, agent={agent_id}) — skipping",
        )
        return {"status": "skipped", "reason": "no sidechain transcript"}

    if not agent_id:
        agent_id = _agent_id_from_path(transcript_path) or "unknown"

    # Bounded read (finding 4): cap the read so an arbitrarily-large worker
    # transcript can't eat the hook budget before the gate/POST. The tail is read
    # in order and covers >> the retain window + gate floors.
    all_messages = read_transcript(transcript_path, max_bytes=SIDECHAIN_MAX_READ_BYTES)
    if not all_messages:
        debug_log(config, f"SubagentStop: empty sidechain transcript {transcript_path}")
        return {"status": "skipped", "reason": "empty transcript"}

    # Volume gate — skip trivial forks, log the skip for coverage auditing.
    passed, turns, chars = passes_volume_gate(all_messages, config)
    if not passed:
        debug_log(
            config,
            f"SubagentStop volume-gate SKIP: session={session_id} agent={agent_id} "
            f"turns={turns} (min {MIN_HUMAN_TURNS}) chars={chars} "
            f"(min {MIN_NON_TOOL_RESULT_CHARS})",
        )
        return {"status": "skipped", "reason": "volume gate", "turns": turns, "chars": chars}

    # Bounded window: last N human turns (extends to end, so the sub-agent's
    # final report is always included).
    messages_to_retain = slice_last_turns_by_user_boundary(all_messages, SIDECHAIN_WINDOW_TURNS)

    # Resolve API URL + client.
    def _dbg(*a):
        debug_log(config, *a)

    try:
        api_url = get_api_url(config, debug_fn=_dbg, allow_daemon_start=True)
    except RuntimeError as e:
        print(f"[Hindsight] {e}", file=sys.stderr)
        return {"status": "failed", "error": e, "payload": None}

    api_token = config.get("hindsightApiToken")
    try:
        client = HindsightClient(
            api_url,
            api_token,
            request_timeout_override=config.get("requestTimeoutSeconds"),
        )
    except ValueError as e:
        print(f"[Hindsight] Invalid API URL: {e}", file=sys.stderr)
        return {"status": "failed", "error": e, "payload": None}

    # Bank == the parent agent's bank (derive_bank_id keys on cwd/session, both
    # shared with the parent), so sidechain memories land alongside the agent's
    # own memory rather than a stray per-worker bank.
    bank_id = derive_bank_id(hook_input, config)
    ensure_bank_mission(client, bank_id, config, debug_fn=_dbg)

    # Deterministic content-derived document_id in a DISTINCT namespace from the
    # main-session retains: reuse retain.py's ``slice_document_id`` recipe via a
    # composite session key so (a) re-fires of the SAME sub-agent window upsert
    # server-side, and (b) it never collides with the parent's own
    # ``{session_id}-r...`` documents.
    #
    # Client-side diffing against the parent's final-report retain is still NOT
    # attempted, but NOT because "hindsight's consolidation dedups" — the
    # original claim here (design item 4) was FALSE and is the assumption that
    # licensed the sidechain volume. Verified against the engine source
    # (upstream image ``ghcr.io/vectorize-io/hindsight``):
    #   * The only SEMANTIC dedup lives in
    #     ``hindsight_api/engine/consolidation/consolidator.py`` and is a guard
    #     on the consolidator's OWN OUTPUT: ``_dedup_adjudicate`` probes a newly
    #     created/updated ``observation`` against existing ones, passing the
    #     literal fact-type list ``["observation"]`` to
    #     ``retrieve_semantic_bm25_combined``.
    #   * ``world`` and ``experience`` are the raw extracted facts that FEED the
    #     consolidator (it selects ``fact_type IN ('experience', 'world')`` for
    #     unconsolidated rows) — they never traverse the observation dedup path.
    #   * Grepping ``hindsight_api/engine/retain/*.py`` for dedup finds only
    #     content-hash CHUNK dedup (``chunk_storage.compute_chunk_hash``), i.e.
    #     byte-identical-chunk skipping. There is no semantic dedup on the
    #     retain path at all.
    # So overlap between a sidechain retain and the parent's own retain persists
    # as extra ``world``/``experience`` rows forever. Volume control has to come
    # from retaining LESS (see ``retainToolCalls`` below), not from a downstream
    # dedup that does not exist. Diffing is still skipped here because the
    # deterministic document_id already makes re-fires of the SAME window upsert,
    # which is the duplicate class this path can actually create.
    sub_session_id = f"{session_id}-sub-{agent_id}"

    # Sidechain tags + a topic-friendly parent link. Reuse the config-driven tag
    # machinery by augmenting a copy of retainTags (template {session_id} →
    # sub_session_id). ``sidechain`` is the recall-side weight key
    # (recallTagWeights); ``parent_session:<id>`` lets a fresh session pull a
    # worker's process facts by parent.
    sub_config = dict(config)

    # Learnings, not raw transcripts and tools (Ken, 2026-07-29): "I don't want
    # sub-agents' transcripts but definitely their learnings should be captured
    # but not raw transcripts and tools."
    #
    # With ``retainToolCalls`` on, ``build_retain_payload`` formats the window
    # via ``_prepare_json_transcript`` → ``_extract_message_blocks``, which emits
    # every ``tool_use.input`` verbatim (an entire ``Write.content``, a full
    # ``Edit`` diff, a full ``Bash.command``) plus every ``tool_result`` at up to
    # 2,000 chars per block.
    #
    # The cost mechanism is DOCUMENT FAN-OUT, not one oversized payload: a large
    # payload is not truncated, it is CAPPED and SPLIT by
    # ``lib.retain_split.split_retain_content`` at ``retain_content_limit()``
    # (33,000 chars on the shipped inputs) into ``{base}-p{i}of{n}`` parts
    # (``client.py`` ~:235). Real sidechain retains have been observed splitting
    # into 38 parts / 1,022 messages, and every part is separately chunked and
    # LLM-extracted into ``world``/``experience`` rows. Shrinking the content is
    # therefore the lever that reduces rows.
    #
    # Forcing it OFF for the sidechain path routes the window through
    # ``_prepare_text_transcript`` → ``_extract_text_content``, keeping assistant
    # ``text`` blocks and channel-message tool_use text. Measured on real fleet
    # sidechains: 5.5x smaller over 30 sampled transcripts (2,012,376 → 367,796
    # chars), and independently 6.4x over the 84 most recent GATE-PASSING ones
    # (26,278,261 → 4,085,678 chars) — of which 0 formatted to empty and 0 came
    # out under 500 chars.
    #
    # ACCEPTED LOSS — this is not a clean "tool noise only" filter.
    # ``_extract_text_content`` also drops image blocks, ALL ``tool_result``
    # content, and sub-agent Task report bodies. So a fact that existed ONLY in
    # tool output is unrecoverable: if a query returned ``43442`` and the agent
    # merely replied "checked, it's the backlog", the number is gone. That trade
    # is deliberate and is what Ken asked for; sub-agent prose was separately
    # measured to carry durable learnings at essentially the main-session rate
    # (5.24% vs 6.87%), so the learnings themselves survive.
    #
    # Mid-session safety: ``slice_document_id`` derives the BASE id from the
    # slice's first/last uuids, not from the formatted text, so a re-fire of the
    # same window still targets the same base id. Note the part SUFFIX embeds the
    # part total, so a document that used to split into n parts and now splits
    # into m < n leaves parts m+1..n in place — they are not overwritten and not
    # duplicated. Historical sidechain rows are untouched by this change; this
    # fixes INTAKE going forward only.
    #
    # Deliberately set on the COPY, not on ``config``: the parent session's own
    # Stop retain keeps whatever the operator configured.
    sub_config["retainToolCalls"] = False

    base_tags = list(config.get("retainTags") or [])
    extra_tags = ["sidechain", f"parent_session:{session_id}"]
    if agent_type:
        extra_tags.append(f"agent_type:{agent_type}")
    sub_config["retainTags"] = base_tags + extra_tags

    built = build_retain_payload(
        sub_config,
        sub_session_id,
        messages_to_retain,
        all_messages,
        bank_id=bank_id,
        api_url=api_url,
        api_token=api_token,
        retain_full_window=True,
        document_id=None,  # content-derived from the slice's first/last uuids
    )
    if built is None:
        # #4001 — this must NOT be silent. It is the "should never happen" branch
        # (the volume gate guarantees >= MIN_NON_TOOL_RESULT_CHARS of retainable
        # text, so a window that cleared the gate should always format to
        # something), so if it fires it means the gate and the formatter disagree
        # about what counts as retainable — a real regression that would
        # otherwise vanish with debug off in the shipped settings. Emit
        # unconditionally on stderr so it surfaces in the gateway log regardless
        # of the debug flag; keep the debug_log for the verbose trace.
        debug_log(config, "SubagentStop: empty transcript after formatting, skipping")
        print(
            "[Hindsight] SubagentStop: sidechain window formatted to EMPTY on the "
            f"text-only path despite clearing the volume gate "
            f"(session={session_id} agent={agent_id} turns={turns} chars>={chars}) "
            "— retain skipped. This should not happen; if it recurs the volume "
            "gate and the text-only formatter have diverged (investigate #3994).",
            file=sys.stderr,
        )
        return {"status": "skipped", "reason": "empty transcript after formatting"}

    payload = built["payload"]
    # Prepend the process-fact extraction framing (does not affect document_id,
    # which was computed from the raw slice inside build_retain_payload).
    payload["content"] = SIDECHAIN_MISSION_HEADER + "\n\n" + payload["content"]
    payload["context"] = "claude-code-sidechain"
    payload["metadata"]["parent_session_id"] = session_id
    payload["metadata"]["agent_id"] = agent_id
    if agent_type:
        payload["metadata"]["agent_type"] = agent_type

    document_id = built["document_id"]
    debug_log(
        config,
        f"SubagentStop retain: bank='{bank_id}' doc='{document_id}' "
        f"turns={turns} chars={chars} msgs={built['message_count']}",
    )

    # POST under the shared fleet pacing lock, NON-BLOCKING (an async Stop hook
    # must not wait on a boot reconcile / backfill). On a busy lock we defer to
    # pending-retains, mirroring retain.py exactly.
    with inflight_lock(blocking=False) as acquired:
        if not acquired:
            debug_log(config, "retain-inflight lock busy; deferring sidechain retain to pending-retains")
            return {
                "status": "failed",
                "error": RuntimeError("retain-inflight lock busy; deferring to pending-retains"),
                "payload": payload,
            }
        try:
            response = client.retain(
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
            print(f"[Hindsight] Sidechain retain failed: {e}", file=sys.stderr)
            return {"status": "failed", "error": e, "payload": payload}

    debug_log(config, f"Sidechain retain response: {json.dumps(response)[:200]}")
    return {"status": "ok", "response": response}


def main():
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        print("[Hindsight] Failed to read SubagentStop hook input", file=sys.stderr)
        return

    result = run_subagent_retain(hook_input) or {}
    # On a failed retain WITH a payload, durably enqueue to pending-retains so
    # the next SessionStart drain replays it — identical durability path to
    # retain.py's Stop entrypoint. The deterministic content-derived id means a
    # queued entry and a later re-fire collide on id ⇒ upsert, not duplicate.
    if result.get("status") == "failed" and result.get("payload"):
        try:
            from lib.pending import MAX_ENTRIES, count as pending_count, enqueue as pending_enqueue

            err = result.get("error") or RuntimeError("subagent retain failed")
            queued = pending_enqueue(result["payload"], err)
            if queued is None:
                print(
                    f"[Hindsight] pending-retains queue full ({MAX_ENTRIES} entries); "
                    f"dropping this SubagentStop retain. Operator: drain manually, "
                    f"then run `switchroom doctor`.",
                    file=sys.stderr,
                )
            else:
                print(
                    f"[Hindsight] SubagentStop retain failed: queued to pending-retains "
                    f"(error: {type(err).__name__}: {err}, pending={pending_count()}). "
                    f"Will retry on next SessionStart.",
                    file=sys.stderr,
                )
        except Exception as e:  # pragma: no cover - defensive
            print(f"[Hindsight] SubagentStop retain enqueue failed: {e}", file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[Hindsight] Unexpected error in subagent_retain: {e}", file=sys.stderr)
        try:
            from lib.config import load_config

            sys.exit(2 if load_config().get("debug") else 0)
        except Exception:
            sys.exit(0)
