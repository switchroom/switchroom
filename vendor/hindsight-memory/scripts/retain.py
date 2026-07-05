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

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib.bank import derive_bank_id, ensure_bank_mission
from lib.client import HindsightClient
from lib.config import debug_log, load_config
from lib.content import (
    prepare_retention_transcript,
    slice_last_turns_by_user_boundary,
)
from lib.daemon import get_api_url
from lib.state import increment_turn_count, track_retention


def read_transcript(transcript_path: str) -> list:
    """Read a JSONL transcript file and return list of message dicts.

    Claude Code transcript format nests messages:
      {type: "user", message: {role: "user", content: "..."}, uuid: "...", ...}
    Also supports flat format for testing:
      {role: "user", content: "..."}
    """
    if not transcript_path or not os.path.isfile(transcript_path):
        return []
    messages = []
    try:
        with open(transcript_path, encoding="utf-8") as f:
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
) -> tuple:
    """Decide which messages to retain and whether to send as a full window.

    Returns ``(messages_to_retain, retain_full_window)``.

    SWITCHROOM DIVERGENCE (Phase 6b — candidate to upstream to
    vectorize-io/hindsight): the chunked sliding-window is decoupled from
    the ``retainEveryNTurns > 1`` throttle. Upstream only sliced a window
    when ``retain_every_n > 1``; with ``retainEveryNTurns=1`` (switchroom's
    every-turn crash-durability setting, applied in scaffold.ts) chunked
    mode fell through to full-session and re-consolidated the ENTIRE
    accumulated transcript on every Stop fire — an unbounded, per-turn cost.

    Decoupling is safe because window selection and the throttle answer two
    independent questions: the throttle decides *whether* to fire this turn
    (still owned by run_retain, unchanged); this function only decides *what*
    to retain once a fire happens. A chunked window of
    ``max(retain_every_n, 1) + overlap_turns`` turns is correct for any
    ``retain_every_n >= 1``. With ``retain_every_n=1, overlap=2`` the window
    is the 3 most-recent turns.

    Durability invariant (jtbd-memory-survives-restart UAT): the window
    always extends to the END of the transcript (``slice_last_turns_by_user_boundary``
    returns ``messages[start:]``), so the turn that just completed — the one
    whose Stop hook is firing — is ALWAYS included. Every turn fires (no
    throttle at n=1), so every turn's content is retained on its own fire.
    No fact can fall outside every window.
    """
    if retain_mode == "chunked":
        # Sliding window: N turns + configured overlap. max(retain_every_n, 1)
        # keeps the window valid at n=1 (the decoupling); for n>1 this equals
        # the previous `retain_every_n + overlap_turns` (behaviour unchanged).
        window_turns = max(retain_every_n, 1) + overlap_turns
        messages_to_retain = slice_last_turns_by_user_boundary(all_messages, window_turns)
        return messages_to_retain, True
    # Full session mode: retain all messages, always as a full window.
    return list(all_messages), True


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

    session_id = hook_input.get("session_id", "unknown")
    transcript_path = hook_input.get("transcript_path", "")

    # Read full transcript
    all_messages = read_transcript(transcript_path)
    if not all_messages:
        debug_log(config, "No messages in transcript, skipping retain")
        return {"status": "skipped", "reason": "empty transcript"}

    debug_log(config, f"Read {len(all_messages)} messages from transcript")

    # Retention mode: full session (vendor default) or chunked. Switchroom
    # runs chunked at retainEveryNTurns=1 (see select_retain_window / scaffold.ts).
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
        retain_mode, retain_every_n, overlap_turns, all_messages
    )
    if retain_mode == "chunked":
        window_turns = max(retain_every_n, 1) + overlap_turns
        debug_log(
            config,
            f"Chunked retain firing (window: {window_turns} turns, {len(messages_to_retain)} messages)",
        )
    else:
        debug_log(config, f"Full session retain: {len(all_messages)} messages")

    # Format transcript
    retain_roles = config.get("retainRoles", ["user", "assistant"])
    include_tool_calls = config.get("retainToolCalls", True)
    transcript, message_count = prepare_retention_transcript(
        messages_to_retain, retain_roles, retain_full_window, include_tool_calls=include_tool_calls
    )

    if not transcript:
        debug_log(config, "Empty transcript after formatting, skipping retain")
        return {"status": "skipped", "reason": "empty transcript after formatting"}

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

    # Document ID strategy:
    # - Chunked mode: each chunk gets a timestamped document_id.
    # - Full-session mode: uses session_id as base, but tracks message count
    #   to detect compaction.  When Claude Code compacts the conversation the
    #   transcript shrinks — if we kept the same document_id we'd overwrite the
    #   pre-compaction document with a shorter one, losing context.  Instead we
    #   increment a chunk counter so the old document is preserved.
    if retain_mode == "chunked" and retain_every_n > 1:
        document_id = f"{session_id}-{int(time.time() * 1000)}"
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

    # Resolve template variables in tags and metadata.
    # Supported variables: {session_id}, {bank_id}, {timestamp}, {user_id}
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

    # Tags from config with template resolution.
    # Drop tags whose resolved form ends in an empty namespace part (e.g. "user:"
    # when HINDSIGHT_USER_ID is unset). Tags without ':' are preserved as-is.
    raw_tags = config.get("retainTags", [])
    if raw_tags:
        tags = []
        for original in raw_tags:
            resolved = _resolve_template(original)
            if ":" in resolved and resolved.split(":", 1)[1] == "":
                debug_log(config, f"Dropping tag '{original}' -> '{resolved}' (empty content after ':')")
                continue
            tags.append(resolved)
        if not tags:
            tags = None
    else:
        tags = None

    # Metadata: merge built-in defaults with user-configured extras
    metadata = {
        "retained_at": template_vars["timestamp"],
        "message_count": str(message_count),
        "session_id": session_id,
    }
    for k, v in config.get("retainMetadata", {}).items():
        metadata[k] = _resolve_template(str(v))

    # Switchroom PR6a — topic tagging for supergroup-mode agents.
    # Scan the messages we're retaining for the latest `<channel
    # chat_id=... message_thread_id=...>` envelope and stamp the
    # tuple into metadata. Downstream (recall.py) uses this to log
    # active-vs-source topic for binding-failure analysis and to
    # support hard-filter mode when an operator opts in.
    #
    # No-op for fleet-shared / DM topology where every inbound from
    # this agent carries the same chat_id (or no chat envelope at all
    # for interactive / cron-only sessions) — the metadata is added
    # but doesn't change behaviour.
    try:
        from lib.gateway_ipc import extract_topic_from_prompt
        topic_chat_id = None
        topic_thread_id = None
        # Walk in reverse — most recent user message is the authoritative
        # "active topic" at retain time.
        for m in reversed(messages_to_retain):
            if not isinstance(m, dict) or m.get("role") != "user":
                continue
            content = m.get("content")
            text = content if isinstance(content, str) else (
                # Claude Code list-content shape: [{type:"text", text:"..."}, ...]
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
                # Resolve alias from operator-injected env map.
                aliases_json = os.environ.get("HINDSIGHT_TOPIC_ALIASES_JSON", "")
                if aliases_json:
                    try:
                        aliases = json.loads(aliases_json)
                        # aliases is {alias_name: thread_id_int_or_str}; build
                        # the inverse lookup once.
                        if isinstance(aliases, dict):
                            inverse = {str(v): k for k, v in aliases.items()}
                            alias = inverse.get(str(topic_thread_id))
                            if alias:
                                metadata["topic_alias"] = alias
                    except (json.JSONDecodeError, ValueError, TypeError):
                        pass  # malformed env is non-fatal
    except Exception as e:
        # Topic tagging is best-effort — never fail a retain over it.
        debug_log(config, f"Topic tagging skipped: {e}")

    debug_log(
        config, f"Retaining to bank '{bank_id}', doc '{document_id}', {message_count} messages, {len(transcript)} chars"
    )
    if tags:
        debug_log(config, f"Tags: {tags}")

    # Build the full payload up-front so we can hand it to the pending-
    # retains queue verbatim if the POST fails. The payload mirrors the
    # client.retain() kwargs plus connection info (api_url, api_token)
    # so the drainer can reconstruct the call from a different process.
    payload = {
        "api_url": api_url,
        "api_token": api_token,
        "bank_id": bank_id,
        "content": transcript,
        "document_id": document_id,
        "context": config.get("retainContext", "claude-code"),
        "metadata": metadata,
        "tags": tags,
    }

    # POST to Hindsight retain API
    try:
        response = client.retain(
            bank_id=bank_id,
            content=transcript,
            document_id=document_id,
            context=payload["context"],
            metadata=metadata,
            tags=tags,
            timeout=15,
        )
        debug_log(config, f"Retain response: {json.dumps(response)[:200]}")
        return {"status": "ok", "response": response}
    except Exception as e:
        print(f"[Hindsight] Retain failed: {e}", file=sys.stderr)
        return {"status": "failed", "error": e, "payload": payload}


def main():
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        print("[Hindsight] Failed to read hook input", file=sys.stderr)
        return
    run_retain(hook_input, force=False)


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
