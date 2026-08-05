#!/usr/bin/env python3
"""Auto-retain hook for Stop event.

Port of: agent_end handler in Openclaw index.js
Adapted for Claude Code hooks (ephemeral process, JSON stdin/stdout).

Flow:
  1. Read hook input from stdin (session_id, transcript_path, cwd)
  2. Read conversation transcript from transcript_path
  3. Apply chunked retention logic (retainEveryNTurns + overlap window)
  4. Resolve API URL (external, existing local, or auto-start daemon)
  5. Derive bank ID and ensure mission
  6. Format transcript (strip memory tags, filter roles)
  7. POST to Hindsight retain API (async)

Exit codes:
  0 — always (graceful degradation on any error)
"""

import hashlib
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Switchroom self-improve PR4 (slice 4a) — per-turn correction tagging.
# The self-improve Stop hook (a SEPARATE process — src/cli/self-improve-stop.ts)
# drops SELF_IMPROVE_CORRECTION_PENDING_FILE into the shared agent state dir when
# the deterministic gate fires on an operator-correction. This hook reads-and-
# clears it and stamps SELF_IMPROVE_CORRECTION_TAG on that turn's retain so PR5's
# failure-synthesis cron can recall correction turns cheaply. Both constants are
# pinned to their TS source (src/memory/hindsight-retain-provenance.ts) by
# tests/scaffold.retain-provenance.test.ts — they must not drift.
SELF_IMPROVE_CORRECTION_PENDING_FILE = "self-improve-correction-pending"
SELF_IMPROVE_CORRECTION_TAG = "self-improve:correction"

from lib import watermark
from lib.bank import derive_bank_id, ensure_bank_mission
from lib.client import HindsightClient
from lib.config import compute_observation_scopes, debug_log, load_config
from lib.content import (
    prepare_retention_transcript,
    slice_last_turns_by_user_boundary,
)
from lib.daemon import get_api_url
from lib.pacing import inflight_lock
from lib.state import increment_turn_count, track_retention


def _self_improve_state_dir() -> str:
    """State dir the self-improve Stop hook drops its correction sentinel into.

    Mirrors ``resolveStateDir()`` in ``src/cli/self-improve-stop.ts``:
    ``TELEGRAM_STATE_DIR`` when set, else ``~/.claude/channels/telegram``. Both
    hooks run in the same agent process env, so they agree on this path.
    """
    env = os.environ.get("TELEGRAM_STATE_DIR")
    if env:
        return env
    return os.path.join(os.path.expanduser("~"), ".claude", "channels", "telegram")


def read_and_clear_correction_pending(state_dir: str | None = None) -> list:
    """Read-and-clear the per-turn operator-correction sentinel (PR4 slice 4a).

    Returns ``[SELF_IMPROVE_CORRECTION_TAG]`` when the sentinel is present (and
    REMOVES it, so exactly one retain carries the tag — read-once), else ``[]``.
    Called from ``run_retain`` only (the live Stop-hook entry), NOT from the
    network-free ``build_retain_payload`` seam, so backfill / reconcile /
    subagent retains never consume a live turn's marker. Best-effort and NEVER
    raises — a triage marker must not be able to fail a retain.
    """
    try:
        d = state_dir if state_dir is not None else _self_improve_state_dir()
        path = os.path.join(d, SELF_IMPROVE_CORRECTION_PENDING_FILE)
        if not os.path.exists(path):
            return []
        try:
            os.remove(path)
        except OSError:
            pass
        return [SELF_IMPROVE_CORRECTION_TAG]
    except Exception:
        return []


def read_transcript(transcript_path: str, max_bytes: int | None = None) -> list:
    """Read a JSONL transcript file and return list of message dicts.

    Claude Code transcript format nests messages:
      {type: "user", message: {role: "user", content: "..."}, uuid: "...", ...}
    Also supports flat format for testing:
      {role: "user", content: "...", uuid: "..."}

    The per-entry ``uuid`` Claude Code stamps on every ``.jsonl`` line is
    surfaced onto the returned message dict (switchroom #3244) so the
    deterministic content-derived ``document_id`` and the durable retain
    watermark can key on it. The uuid is stable across compaction and unique
    per entry. Adding the key is inert for downstream formatting
    (``lib/content`` reads only ``role``/``content``).

    ``max_bytes`` (switchroom hindsight-leverage PR5 — bounded read): when set,
    only the LAST ``max_bytes`` of the file are read and the first (possibly
    partial) line of that window is discarded, so a multi-hour worker's
    arbitrarily-large sidechain transcript can never eat the hook budget on the
    read before the volume-gate/POST. Transcript ORDER is preserved (we read the
    tail, in order); a window this covers >> the retain window + gate floors, so
    the "last N turns" slice and PASS/skip decision are unaffected in practice.
    ``None`` (default) reads the whole file — the main Stop/reconcile paths are
    unchanged.
    """
    if not transcript_path or not os.path.isfile(transcript_path):
        return []
    messages = []
    try:
        with open(transcript_path, encoding="utf-8", errors="replace") as f:
            if max_bytes is not None and max_bytes > 0:
                try:
                    size = os.path.getsize(transcript_path)
                    if size > max_bytes:
                        f.seek(size - max_bytes)
                        f.readline()  # drop the partial first line of the window
                except OSError:
                    pass
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    # Claude Code nested format: {type: "user", message: {role, content}}
                    if entry.get("type") in ("user", "assistant"):
                        msg = entry.get("message", {})
                        if isinstance(msg, dict) and msg.get("role"):
                            # Surface the transcript-entry uuid (nested format
                            # carries it on the OUTER entry, not the message).
                            uid = entry.get("uuid")
                            if uid is not None and "uuid" not in msg:
                                msg = dict(msg)
                                msg["uuid"] = uid
                            messages.append(msg)
                    # Flat format (testing / future compatibility)
                    elif "role" in entry and "content" in entry:
                        messages.append(entry)
                except json.JSONDecodeError:
                    continue
    except OSError:
        pass
    return messages


def select_retain_window(
    retain_mode: str,
    retain_every_n: int,
    overlap_turns: int,
    all_messages: list,
    force: bool = False,
) -> tuple:
    """Decide which messages to retain and whether to send as a full window.

    Returns ``(messages_to_retain, retain_full_window)``.

    SWITCHROOM DIVERGENCE (Phase 6b — candidate to upstream to
    vectorize-io/hindsight): the chunked sliding-window is decoupled from
    the ``retainEveryNTurns > 1`` throttle. Upstream only sliced a window
    when ``retain_every_n > 1``; at ``retainEveryNTurns=1`` (switchroom's
    historical every-turn crash-durability setting; the current scaffold.ts
    default is 3) chunked
    mode fell through to full-session and re-consolidated the ENTIRE
    accumulated transcript on every Stop fire — an unbounded, per-turn cost.

    Decoupling is safe because window selection and the throttle answer two
    independent questions: the throttle decides *whether* to fire this turn
    (still owned by run_retain, unchanged); this function only decides *what*
    to retain once a fire happens. A chunked window of
    ``max(retain_every_n, 1) + overlap_turns`` turns is correct for any
    ``retain_every_n >= 1``. At the current switchroom defaults
    (``retain_every_n=3, overlap=1``) the window is the 4 most-recent HUMAN
    turns; at ``retain_every_n=1, overlap=2`` it is the 3 most-recent
    (tool_result messages don't count as turns — see
    slice_last_turns_by_user_boundary).

    ``force=True`` (SessionEnd final retain) widens chunked mode to a
    full-session sweep — belt-and-braces so a graceful shutdown always flushes
    the whole session even if per-turn windowing had an edge. This costs a
    full sweep only ONCE per session (at end), not per turn.

    Durability invariant (jtbd-memory-survives-restart UAT): the window
    always extends to the END of the transcript (``slice_last_turns_by_user_boundary``
    returns ``messages[start:]``), so the turn that just completed — the one
    whose Stop hook is firing — is ALWAYS included. Every turn fires (no
    throttle at n=1), so every turn's content is retained on its own fire.
    Boundaries are counted on human messages only, so a tool-heavy turn can't
    push the human's fact outside the window. No fact can fall outside every
    window.
    """
    if retain_mode == "chunked" and not force:
        # Sliding window: N turns + configured overlap. max(retain_every_n, 1)
        # keeps the window valid at n=1 (the decoupling); for n>1 this equals
        # the previous `retain_every_n + overlap_turns` (behaviour unchanged).
        window_turns = max(retain_every_n, 1) + overlap_turns
        messages_to_retain = slice_last_turns_by_user_boundary(all_messages, window_turns)
        return messages_to_retain, True
    # Full session: vendor full-session mode, OR a forced (SessionEnd) chunked
    # sweep. Retain all messages, always as a full window.
    return list(all_messages), True


def _ordered_uuids(all_messages: list) -> list:
    """Transcript-order list of entry uuids (skips entries without one)."""
    out = []
    for m in all_messages:
        if isinstance(m, dict):
            uid = m.get("uuid")
            if uid:
                out.append(uid)
    return out


def slice_document_id(session_id: str, messages_slice: list, transcript_text: str) -> str:
    """Deterministic, content-derived retain ``document_id`` (switchroom #3244 §1).

    ``{session_id}-r{start_uuid}-{end_uuid}`` from the FULL first/last transcript
    entry uuids of the retained slice — NOT truncated (32+32 bits birthday-
    collide across months of history and a collision is *silent loss*, not a
    dup). The id is a pure function of *which turns* (which start/end uuids) are
    retained, so any two writes of the **identical** slice — the live Stop-hook
    path re-firing the same window, or boot reconciliation re-posting it —
    compute the same id and upsert on the daemon's document_id key instead of
    double-storing. No wall clock, no randomness.

    CAUTION — this convergence is only for the *same slice boundaries*. The live
    path slices a *sliding* ``retainEveryNTurns``+overlap window (see
    ``select_retain_window``) while the PR2 backfill slices *non-overlapping*
    fixed-size chunks; they do NOT produce the same boundaries for the same
    turns, so their ids do NOT converge and the daemon cannot upsert one against
    the other. The backfill stays duplicate-free via its total-loss gate (it
    only re-posts sessions the live path wrote nothing for), NOT via id-identity
    with the live path — do not conflate the two.

    Fallback (legacy/flat transcripts with no per-entry uuid): a sha256 of the
    formatted transcript content — still purely deterministic and convergent
    across paths for identical content.
    """
    start = messages_slice[0].get("uuid") if messages_slice else None
    end = messages_slice[-1].get("uuid") if messages_slice else None
    if start and end:
        return f"{session_id}-r{start}-{end}"
    digest = hashlib.sha256((transcript_text or "").encode("utf-8")).hexdigest()[:32]
    return f"{session_id}-r{digest}"


def detect_lesson_tags(transcript: str, config: dict) -> list:
    """Deterministic lesson / anti-pattern tag detection (switchroom E2 / #398).

    Scans the formatted transcript slice for explicit lesson / anti-pattern
    markers and returns the sorted, de-duplicated list of tags to attach. This
    is the retain-side half of #398: a transcript that captures a self-recognised
    lesson ("lesson learned", "note to self:") or a failure mode ("anti-pattern:",
    "what not to do") is tagged so recall's per-tag score-penalty weight map
    (recallTagWeights, PR5) can DEMOTE it below clean first-party memories without
    ever hard-dropping it.

    Detection is a deterministic case-insensitive substring match against the
    configurable ``lessonTagMarkers`` map — NOT model-dependent, so the behaviour
    is reproducible and testable. Returns ``[]`` when tagging is disabled
    (``lessonTagging`` false), the transcript is empty, the marker map is malformed,
    or nothing matches. NON-GOAL (epic-recorded): this fires on NEW retains only;
    the historical corpus is never re-tagged.
    """
    if not config.get("lessonTagging", True):
        return []
    if not isinstance(transcript, str) or not transcript:
        return []
    markers = config.get("lessonTagMarkers")
    if not isinstance(markers, dict) or not markers:
        return []
    hay = transcript.lower()
    tags = set()
    for tag, needles in markers.items():
        if not isinstance(tag, str) or not tag.strip():
            continue
        if not isinstance(needles, list):
            continue
        for needle in needles:
            if isinstance(needle, str) and needle and needle.lower() in hay:
                tags.add(tag.strip())
                break
    return sorted(tags)


def build_retain_payload(
    config: dict,
    session_id: str,
    messages_to_retain: list,
    all_messages: list,
    *,
    bank_id: str,
    api_url,
    api_token,
    retain_full_window: bool = True,
    document_id=None,
    extra_tags=None,
) -> dict | None:
    """Pure transcript → retain payload + deterministic id (switchroom #3244 §1.4).

    NETWORK-FREE and MISSION-WRITE-FREE by contract: it formats the slice,
    computes the deterministic content-derived ``document_id`` (unless one is
    supplied, e.g. the full-session compaction-tracked id), and assembles the
    exact kwargs ``client.retain()`` / the pending-retains drainer expect. It
    issues NO HTTP and never touches ``ensure_bank_mission`` — so the boot
    reconciler and the PR2 dry-run can import it and stay genuinely write-free.

    Returns ``{payload, document_id, message_count, last_uuid, ordered_uuids,
    transcript}`` or ``None`` when the slice formats to nothing.

    NEVER raises on a bad ``observationScopes`` / ``observationScopeStrategy``.
    Every retain producer builds its payload here, so this seam sees the typo —
    but it is also the seam the memory itself is made at, and a config typo must
    not be able to destroy one. An off-list value degrades the SCOPE (the
    engine's own default stands for a bad pin; ``curated`` stands for a bad
    strategy) and is shouted about on stderr; the memory is still built, still
    POSTed, still queued on failure. See ``lib.config.compute_observation_scopes``.
    """
    retain_roles = config.get("retainRoles", ["user", "assistant"])
    include_tool_calls = config.get("retainToolCalls", True)
    transcript, message_count = prepare_retention_transcript(
        messages_to_retain, retain_roles, retain_full_window, include_tool_calls=include_tool_calls
    )
    if not transcript:
        return None

    if document_id is None:
        document_id = slice_document_id(session_id, messages_to_retain, transcript)

    template_vars = {
        "session_id": session_id,
        "bank_id": bank_id,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "user_id": os.environ.get("HINDSIGHT_USER_ID", ""),
    }

    def _resolve_template(value: str) -> str:
        for k, v in template_vars.items():
            value = value.replace(f"{{{k}}}", v)
        return value

    raw_tags = config.get("retainTags", [])
    if raw_tags:
        tags = []
        for original in raw_tags:
            resolved = _resolve_template(original)
            if ":" in resolved and resolved.split(":", 1)[1] == "":
                continue
            tags.append(resolved)
        if not tags:
            tags = None
    else:
        tags = None

    # Switchroom E2 / PR9 (#398) — attach lesson / anti-pattern tags detected in
    # the transcript slice so recall can demote failure-mode-adjacent memories via
    # the PR5 score-penalty weight map. Deterministic, best-effort, never fails a
    # build; applies to both Stop-hook and sidechain retains (shared code path).
    lesson_tags = detect_lesson_tags(transcript, config)
    if lesson_tags:
        merged = list(tags) if tags else []
        for lt in lesson_tags:
            if lt not in merged:
                merged.append(lt)
        tags = merged

    # Switchroom self-improve PR4 (slice 4a) — per-turn correction tag. The
    # caller (``run_retain``) reads-and-clears the operator-correction sentinel
    # and threads the resulting tag(s) in here; this seam stays network-free and
    # state-free (no sentinel IO), so it composes with lesson tags and rides the
    # SAME payload the pending-retains queue persists. ``self-improve:correction``
    # is STABLE by contract (it must NOT match DEFAULT_VOLATILE_SCOPE_PATTERNS),
    # so on a correction turn the retain lands in its own
    # ``[["self-improve:correction"]]`` consolidation scope — exactly the
    # partition PR5's failure-synthesis cron works over. Absent ⇒ tag absent ⇒
    # scope stays byte-identical to a normal turn's ``"shared"``.
    if extra_tags:
        merged = list(tags) if tags else []
        for et in extra_tags:
            if isinstance(et, str) and et and et not in merged:
                merged.append(et)
        tags = merged or None

    metadata = {
        "retained_at": template_vars["timestamp"],
        "message_count": str(message_count),
        "session_id": session_id,
    }
    for k, v in config.get("retainMetadata", {}).items():
        metadata[k] = _resolve_template(str(v))

    # Topic tagging (switchroom PR6a) — best-effort, never fails a build.
    try:
        from lib.gateway_ipc import extract_topic_from_prompt

        topic_chat_id = None
        topic_thread_id = None
        for m in reversed(messages_to_retain):
            if not isinstance(m, dict) or m.get("role") != "user":
                continue
            content = m.get("content")
            text = content if isinstance(content, str) else (
                next((p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"), "")
                if isinstance(content, list) else ""
            )
            c_id, t_id = extract_topic_from_prompt(text)
            if c_id is not None:
                topic_chat_id, topic_thread_id = c_id, t_id
                break
        if topic_chat_id is not None:
            metadata["chat_id"] = topic_chat_id
            if topic_thread_id is not None:
                metadata["thread_id"] = topic_thread_id
                aliases_json = os.environ.get("HINDSIGHT_TOPIC_ALIASES_JSON", "")
                if aliases_json:
                    try:
                        aliases = json.loads(aliases_json)
                        if isinstance(aliases, dict):
                            inverse = {str(v): k for k, v in aliases.items()}
                            alias = inverse.get(str(topic_thread_id))
                            if alias:
                                metadata["topic_alias"] = alias
                    except (json.JSONDecodeError, ValueError, TypeError):
                        pass
    except Exception:
        pass

    # Per-row observation scope (switchroom). Default `curated`: volatile
    # per-session provenance tags are stripped from the CONSOLIDATION scope
    # (kept on the source fact) so observations dedup across sessions instead of
    # per-session — a non-empty stable tag set yields an explicit `[[stable…]]`
    # scope, an all-volatile/empty set yields `"shared"`. A None (opt-out via
    # observationScopeStrategy=combined/off, or a manual observationScopes typo)
    # is dropped at the wire by HindsightClient._retain_one, so that request
    # body is byte-identical to the pre-feature default. Carried ON THE PAYLOAD
    # so it survives the pending-retains queue: a retain that fails and drains
    # hours later must land in the SAME scope it would have landed in inline.
    #
    # CLASSIFIED, NOT VALIDATED. This is the one seam every retain producer
    # funnels through, which makes it the tempting place to reject a typo — and
    # the worst possible place to raise from. Raising here does not "fail the
    # retain", it DELETES the turn: the exception propagates out of run_retain,
    # past retain.main's pending_enqueue (so nothing is queued and the
    # watermark never advances), session_end.py catches it with no payload to
    # queue, and session_start.py's reconciler swallows it into debug_log and
    # aborts the loop that would have re-derived it. Every producer loses its
    # memory outright, silently, for as long as the bad value sits in the
    # config — switchroom #3244's exact shape.
    #
    # So a bad value degrades to the PRE-FEATURE behaviour (field omitted, the
    # engine's own default scope stands) and is shouted about on stderr. Wrong
    # scope is recoverable; a lost turn is not.
    scope, scope_error = compute_observation_scopes(tags, config)
    if scope_error:
        print(
            f"[Hindsight] observation_scopes IGNORED for this retain: {scope_error} "
            "The memory is being retained at the engine's default scope rather "
            "than dropped — fix the value, then `switchroom apply` and restart "
            "the agent.",
            file=sys.stderr,
        )
    payload = {
        "api_url": api_url,
        "api_token": api_token,
        "bank_id": bank_id,
        "content": transcript,
        "document_id": document_id,
        "context": config.get("retainContext", "claude-code"),
        "metadata": metadata,
        "tags": tags,
        "observation_scopes": scope,
    }
    return {
        "payload": payload,
        "document_id": document_id,
        "message_count": message_count,
        "last_uuid": messages_to_retain[-1].get("uuid") if messages_to_retain else None,
        "ordered_uuids": _ordered_uuids(all_messages),
        "transcript": transcript,
    }


def run_retain(hook_input: dict, force: bool = False) -> dict:
    """Run the auto-retain flow.

    Returns a status dict::

        {"status": "ok" | "skipped" | "failed",
         "payload": {...},   # only when status == "failed"
         "error":   Exception}  # only when status == "failed"

    The ``payload`` field carries the exact arguments that were going to
    be sent to ``client.retain()`` plus the resolved ``api_url`` /
    ``api_token`` — sufficient to retry the call from a different
    process (the SessionStart drainer, see ``drain_pending.py`` and
    ``lib/pending.py``). ``status="skipped"`` is the normal early-exit
    cases (auto-retain disabled, empty transcript, throttled chunk).
    """
    config = load_config()

    if not config.get("autoRetain"):
        debug_log(config, "Auto-retain disabled, exiting")
        return {"status": "skipped", "reason": "autoRetain disabled"}

    debug_log(config, f"Retain hook_input keys: {list(hook_input.keys())} force={force}")

    # Blocked-Stop double-fire guard (switchroom #2848 Phase 3): when
    # directive_verify.py blocks a Stop, the model continues and the Stop
    # event fires AGAIN, this time carrying ``stop_hook_active: true``.
    # Retaining on that second fire would (a) POST a duplicate transcript
    # document and (b) at retainEveryNTurns>1 call increment_turn_count a
    # second time for the SAME logical turn — drifting the cadence throttle.
    # Skip the re-fire entirely BEFORE any store or turn-count increment.
    # A forced SessionEnd sweep (force=True) is a distinct hook event and
    # must always flush, so it is exempt.
    if not force and hook_input.get("stop_hook_active"):
        debug_log(
            config,
            "Stop re-fire (stop_hook_active=true) — skipping retain to avoid "
            "duplicate document / turn-count drift",
        )
        return {"status": "skipped", "reason": "stop_hook_active"}

    session_id = hook_input.get("session_id", "unknown")
    transcript_path = hook_input.get("transcript_path", "")

    # Read full transcript
    all_messages = read_transcript(transcript_path)
    if not all_messages:
        debug_log(config, "No messages in transcript, skipping retain")
        return {"status": "skipped", "reason": "empty transcript"}

    debug_log(config, f"Read {len(all_messages)} messages from transcript")

    # Retention mode: full session (vendor default) or chunked. Switchroom
    # overrides to chunked in scaffold.ts, at the cascaded
    # memory.retain.every_n_turns (default 3) / .overlap_turns (default 1) —
    # a fire every 3rd turn over a ~4-turn window. See select_retain_window
    # and scaffold.ts (HINDSIGHT_DEFAULT_RETAIN_*).
    retain_mode = config.get("retainMode", "full-session")
    retain_every_n = max(1, config.get("retainEveryNTurns", 1))
    retain_full_window = False
    messages_to_retain = all_messages

    # Respect retainEveryNTurns in both modes, unless force=True (SessionEnd final retain)
    if retain_every_n > 1 and not force:
        turn_count = increment_turn_count(session_id)
        if turn_count % retain_every_n != 0:
            next_at = ((turn_count // retain_every_n) + 1) * retain_every_n
            debug_log(config, f"Turn {turn_count}/{retain_every_n}, skipping retain (next at turn {next_at})")
            return {"status": "skipped", "reason": "throttled"}

    # Window selection is decoupled from the throttle above — see
    # select_retain_window() for the switchroom-divergence rationale
    # (Phase 6b: chunked window-slicing now works at retainEveryNTurns=1).
    overlap_turns = config.get("retainOverlapTurns", 0)
    messages_to_retain, retain_full_window = select_retain_window(
        retain_mode, retain_every_n, overlap_turns, all_messages, force=force
    )
    if retain_mode == "chunked" and not force:
        window_turns = max(retain_every_n, 1) + overlap_turns
        debug_log(
            config,
            f"Chunked retain firing (window: {window_turns} human turns, {len(messages_to_retain)} messages)",
        )
    elif retain_mode == "chunked" and force:
        debug_log(
            config,
            f"Chunked retain, forced full-session sweep (SessionEnd): {len(all_messages)} messages",
        )
    else:
        debug_log(config, f"Full session retain: {len(all_messages)} messages")

    # Resolve API URL
    def _dbg(*a):
        debug_log(config, *a)

    try:
        api_url = get_api_url(config, debug_fn=_dbg, allow_daemon_start=True)
    except RuntimeError as e:
        print(f"[Hindsight] {e}", file=sys.stderr)
        return {"status": "failed", "error": e, "payload": None}

    api_token = config.get("hindsightApiToken")
    try:
        # Upstream 55ef70679 — honor the optional requestTimeoutSeconds
        # override (retain runs outside the recall hook budget, so a longer
        # timeout is safe here; recall.py deliberately omits this).
        client = HindsightClient(
            api_url,
            api_token,
            request_timeout_override=config.get("requestTimeoutSeconds"),
        )
    except ValueError as e:
        print(f"[Hindsight] Invalid API URL: {e}", file=sys.stderr)
        return {"status": "failed", "error": e, "payload": None}

    # Derive bank ID and ensure mission
    bank_id = derive_bank_id(hook_input, config)
    ensure_bank_mission(client, bank_id, config, debug_fn=_dbg)

    # Document ID strategy (switchroom #3244 §1 — single deterministic namespace):
    # - Chunked mode at retainEveryNTurns>1 (the deployed default): a
    #   *content-derived* id computed from the slice's first/last transcript
    #   uuids (``document_id=None`` lets build_retain_payload compute it). This
    #   REPLACES the former wall-clock ``{session_id}-{time.time()*1000}`` id so
    #   the live path, boot reconciliation, and the PR2 backfill all mint the
    #   SAME id for the same turns ⇒ upsert, not duplicate.
    # - Full-session mode / n==1: unchanged — a stable ``session_id`` base with
    #   a compaction chunk counter so a shrinking transcript doesn't overwrite
    #   the pre-compaction document with a shorter one.
    if retain_mode == "chunked" and retain_every_n > 1:
        document_id = None  # build_retain_payload computes the content-derived id
    else:
        chunk_index, compacted = track_retention(session_id, len(all_messages))
        if compacted:
            debug_log(
                config,
                f"Compaction detected for session {session_id}: transcript shrank, "
                f"advancing to chunk {chunk_index} to preserve prior document",
            )
        # chunk 0 → plain session_id (backwards compatible with existing docs)
        document_id = session_id if chunk_index == 0 else f"{session_id}-c{chunk_index}"

    # Switchroom self-improve PR4 (slice 4a) — read-and-clear the per-turn
    # operator-correction sentinel here, in the live Stop path only, AFTER the
    # throttle / re-fire / empty-transcript early-returns above so only a retain
    # that actually FIRES consumes the marker (a throttled turn leaves it for the
    # next firing retain, whose overlapping window still contains the correction).
    # Read-once: the tag rides exactly one retain. Best-effort; never raises.
    extra_tags = read_and_clear_correction_pending()

    # Build the payload via the shared, network-free seam (§1.4). This carries
    # the deterministic id, connection info, formatted transcript, tags and
    # metadata — sufficient to retry from a different process (drain_pending).
    built = build_retain_payload(
        config,
        session_id,
        messages_to_retain,
        all_messages,
        bank_id=bank_id,
        api_url=api_url,
        api_token=api_token,
        retain_full_window=retain_full_window,
        document_id=document_id,
        extra_tags=extra_tags,
    )
    if built is None:
        debug_log(config, "Empty transcript after formatting, skipping retain")
        return {"status": "skipped", "reason": "empty transcript after formatting"}

    payload = built["payload"]
    document_id = built["document_id"]
    debug_log(
        config,
        f"Retaining to bank '{bank_id}', doc '{document_id}', {built['message_count']} messages",
    )

    # POST to Hindsight retain API under the shared fleet pacing lock (§1.5) so
    # at most one durability POST is in flight for this agent. The live Stop
    # path acquires it NON-BLOCKING (turn latency must not regress): if a boot
    # reconcile / backfill holds it, we do NOT wait — we return the failure
    # payload so main() enqueues it and the next boot drain delivers it. A
    # forced SessionEnd sweep waits (blocking) since it is the final flush.
    with inflight_lock(blocking=force) as acquired:
        if not acquired:
            debug_log(config, "retain-inflight lock busy; deferring retain to pending-retains")
            return {
                "status": "failed",
                "error": RuntimeError("retain-inflight lock busy; deferring to pending-retains"),
                "payload": payload,
            }
        try:
            # async_processing=False (§1.1): commit-before-ack so the 200 proves
            # durable persistence before we advance the watermark. A bare async
            # 200 (ack-of-receipt) must never mark unpersisted work committed.
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
            print(f"[Hindsight] Retain failed: {e}", file=sys.stderr)
            return {"status": "failed", "error": e, "payload": payload}

    debug_log(config, f"Retain response: {json.dumps(response)[:200]}")

    # Advance the durable watermark ONLY after confirmed persistence (§1.1).
    # Best-effort: a watermark write failure must never fail a landed retain —
    # worst case the boot reconciler re-upserts the same slice idempotently.
    try:
        watermark.commit(
            session_id,
            built["last_uuid"],
            document_id,
            transcript_path=transcript_path,
            ordered_uuids=built["ordered_uuids"],
        )
    except Exception as e:  # pragma: no cover - defensive
        debug_log(config, f"watermark commit skipped: {e}")

    return {"status": "ok", "response": response}


def main():
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        print("[Hindsight] Failed to read hook input", file=sys.stderr)
        return

    # Close hole A2 (switchroom #3244): the Stop entrypoint used to discard
    # run_retain's return value, so a failed per-turn retain (daemon busy /
    # unreachable / lock-deferred) was silently dropped — never queued, never
    # surfaced. Mirror session_end.py: on a failed retain WITH a payload,
    # durably enqueue it to pending-retains so the next SessionStart drain
    # replays it. The deterministic content-derived document_id (§1) means a
    # queued entry and a later boot-reconcile entry for the same window collide
    # on id ⇒ upsert, not duplicate — so no id rewrite is needed here.
    #
    # We keep exit 0: retain.py is registered as an async Stop hook (hooks.json)
    # whose exit code Claude Code discards. Durability comes from the enqueue,
    # not the exit code.
    result = run_retain(hook_input, force=False) or {}
    if result.get("status") == "failed" and result.get("payload"):
        try:
            from lib.pending import MAX_ENTRIES, count as pending_count, enqueue as pending_enqueue

            err = result.get("error") or RuntimeError("stop retain failed")
            queued = pending_enqueue(result["payload"], err)
            if queued is None:
                print(
                    f"[Hindsight] pending-retains queue full ({MAX_ENTRIES} entries); "
                    f"dropping this Stop retain. Operator: drain manually, then run "
                    f"`switchroom doctor`.",
                    file=sys.stderr,
                )
            else:
                print(
                    f"[Hindsight] Stop retain failed: queued to pending-retains "
                    f"(error: {type(err).__name__}: {err}, pending={pending_count()}). "
                    f"Will retry on next SessionStart.",
                    file=sys.stderr,
                )
        except Exception as e:  # pragma: no cover - defensive
            print(f"[Hindsight] Stop retain enqueue failed: {e}", file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[Hindsight] Unexpected error in retain: {e}", file=sys.stderr)
        try:
            from lib.config import load_config

            sys.exit(2 if load_config().get("debug") else 0)
        except Exception:
            sys.exit(0)
