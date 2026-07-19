"""Content processing utilities.

Faithful port of Openclaw plugin's content processing: memory tag stripping,
query composition/truncation, transcript formatting, and memory formatting.

Source: reference/openclaw-source/index.js — stripMemoryTags, composeRecallQuery,
truncateRecallQuery, sliceLastTurnsByUserBoundary, prepareRetentionTranscript,
formatMemories.
"""

import os
import re
from datetime import datetime

try:  # Python 3.9+; present in every switchroom agent image.
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - defensive only
    ZoneInfo = None  # type: ignore[assignment,misc]

# ---------------------------------------------------------------------------
# Memory tag stripping (anti-feedback-loop)
# ---------------------------------------------------------------------------


def strip_channel_envelope(content: str) -> str:
    """Strip Claude Code channel XML wrappers from user messages.

    Claude Code wraps incoming channel messages in XML:
      <channel source="plugin:telegram:telegram" chat_id="..." ...>
      actual message text
      </channel>

    This is the Claude Code equivalent of Openclaw's stripMetadataEnvelopes().
    Extracts the inner text, preserving the actual user message while removing
    transport metadata that Hindsight doesn't need.

    A single prompt may carry MORE THAN ONE envelope (e.g. a coalesced
    burst where several inbound messages were concatenated). Since this now
    sits on the live recall-query path (hindsight-leverage PR 1, review
    finding 6), coalesce EVERY envelope's inner text rather than keeping only
    the first and silently dropping everything after the first ``</channel>``.
    """
    # Match every <channel ...>content</channel> — extract & join inner texts.
    matches = re.findall(r"<channel\b[^>]*>([\s\S]*?)</channel>", content)
    if matches:
        return "\n".join(m.strip() for m in matches if m.strip()).strip()
    return content


def strip_memory_tags(content: str) -> str:
    """Remove <hindsight_memories> and <relevant_memories> blocks.

    Prevents retain feedback loop — these were injected during recall and
    should not be re-stored.

    Port of: stripMemoryTags() in index.js
    """
    content = re.sub(r"<hindsight_memories>[\s\S]*?</hindsight_memories>", "", content)
    content = re.sub(r"<relevant_memories>[\s\S]*?</relevant_memories>", "", content)
    return content


# ---------------------------------------------------------------------------
# Recall: query composition and truncation
# ---------------------------------------------------------------------------


def compose_recall_query(
    latest_query: str,
    messages: list,
    recall_context_turns: int,
    recall_roles: list = None,
) -> str:
    """Compose a multi-turn recall query from conversation history.

    Port of: composeRecallQuery() in index.js

    When recallContextTurns > 1, includes prior context from the transcript
    above the latest user query. Format:

        Prior context:

        user: ...
        assistant: ...

        <latest query>
    """
    # Switchroom A1 (hindsight-leverage PR 1) — strip the <channel> envelope
    # from the latest query INSIDE the helper as well, so any caller (present
    # or future) gets an envelope-free composed query. The recall.py caller
    # already strips before calling, but keeping the strip here is defence in
    # depth: it guarantees the trailing latest-query segment appended below
    # (and returned on the turns<=1 short-circuit) never carries the raw
    # chat_id/ts/user XML noise into the embedding or the char cap.
    latest = strip_channel_envelope(latest_query).strip()
    if recall_context_turns <= 1 or not isinstance(messages, list) or not messages:
        return latest

    allowed_roles = set(recall_roles or ["user", "assistant"])
    contextual_messages = slice_last_turns_by_user_boundary(messages, recall_context_turns)

    context_lines = []
    for msg in contextual_messages:
        role = msg.get("role")
        if role not in allowed_roles:
            continue

        content = _extract_text_content(msg.get("content", ""), role=role)
        content = strip_channel_envelope(content)
        content = strip_memory_tags(content).strip()
        if not content:
            continue

        # Skip if this is the same as the latest query (avoid duplication)
        if role == "user" and content == latest:
            continue

        context_lines.append(f"{role}: {content}")

    if not context_lines:
        return latest

    return "\n\n".join(
        [
            "Prior context:",
            "\n".join(context_lines),
            latest,
        ]
    )


def truncate_recall_query(query: str, latest_query: str, max_chars: int) -> str:
    """Truncate a composed recall query to max_chars.

    Port of: truncateRecallQuery() in index.js

    Preserves the latest user message. When the query contains "Prior context:",
    drops oldest context lines first (from the top) to fit within the limit.
    """
    if max_chars <= 0:
        return query

    latest = latest_query.strip()
    if len(query) <= max_chars:
        return query

    # If even the latest alone is too long, hard-truncate it
    latest_only = latest[:max_chars] if len(latest) > max_chars else latest

    if "Prior context:" not in query:
        return latest_only

    context_marker = "Prior context:\n\n"
    marker_index = query.find(context_marker)
    if marker_index == -1:
        return latest_only

    suffix_marker = "\n\n" + latest
    suffix_index = query.rfind(suffix_marker)
    if suffix_index == -1:
        return latest_only

    suffix = query[suffix_index:]  # \n\n<latest>
    if len(suffix) >= max_chars:
        return latest_only

    context_body = query[marker_index + len(context_marker) : suffix_index]
    context_lines = [line for line in context_body.split("\n") if line]

    # Add context lines from newest (bottom) to oldest (top), stop when exceeding
    kept = []
    for i in range(len(context_lines) - 1, -1, -1):
        kept.insert(0, context_lines[i])
        candidate = f"{context_marker}{chr(10).join(kept)}{suffix}"
        if len(candidate) > max_chars:
            kept.pop(0)
            break

    if kept:
        return f"{context_marker}{chr(10).join(kept)}{suffix}"
    return latest_only


# ---------------------------------------------------------------------------
# Turn slicing
# ---------------------------------------------------------------------------


def _is_tool_result_only_user_message(message: dict) -> bool:
    """True when a ``role="user"`` message carries ONLY tool_result blocks.

    SWITCHROOM DIVERGENCE (candidate to upstream to vectorize-io/hindsight):
    Claude Code emits tool results as ``role="user"`` messages whose content
    is a list of ``{"type": "tool_result", ...}`` blocks — they are NOT
    human turns. A genuine human turn has text (a string, or a content list
    with at least one non-tool_result block, e.g. ``{"type": "text"}`` or an
    image). Treating tool_result messages as turn boundaries lets a tool-heavy
    turn (≥N sequential tool rounds) fill a fixed-size retain window with
    tool_result messages and push the actual human message OUTSIDE the window
    — silently dropping the fact from that fire, and from every later fire
    (whose window starts even further from the human message). On restart the
    fact is gone. This helper lets the boundary counter skip those messages so
    "window = N turns" means N *human* turns regardless of tool volume.
    """
    if message.get("role") != "user":
        return False
    content = message.get("content")
    if isinstance(content, list):
        blocks = [b for b in content if isinstance(b, dict)]
        # A non-empty content list that is ENTIRELY tool_result blocks.
        if blocks and all(b.get("type") == "tool_result" for b in blocks):
            return True
    return False


def slice_last_turns_by_user_boundary(messages: list, turns: int) -> list:
    """Slice messages to the last N turns, where a turn starts at a user message.

    Port of: sliceLastTurnsByUserBoundary() in index.js

    Walks backward counting GENUINE HUMAN user messages as turn boundaries.
    Returns messages from the Nth human boundary to the end.

    SWITCHROOM DIVERGENCE (candidate to upstream): tool_result messages carry
    ``role="user"`` in the Claude Code transcript but are not human turns; they
    are skipped as boundaries (see ``_is_tool_result_only_user_message``). This
    keeps the fixed-size retain window anchored to human turns so a tool-heavy
    turn can never push the human's fact outside the window (silent memory loss).
    Affects both the retain window-slice and the recall context slice — both
    want "N human turns", not "N transcript user-messages".
    """
    if not isinstance(messages, list) or not messages or turns <= 0:
        return []

    user_turns_seen = 0
    start_index = -1

    for i in range(len(messages) - 1, -1, -1):
        msg = messages[i]
        if msg.get("role") == "user" and not _is_tool_result_only_user_message(msg):
            user_turns_seen += 1
            if user_turns_seen >= turns:
                start_index = i
                break

    if start_index == -1:
        return list(messages)

    return messages[start_index:]


# ---------------------------------------------------------------------------
# Memory formatting (recall results → context string)
# ---------------------------------------------------------------------------


def format_memories(results: list) -> str:
    """Format recall results into human-readable text.

    Port of: formatMemories() in index.js
    Format: - <text> [<type>] (<mentioned_at>)
    """
    if not results:
        return ""
    lines = []
    for r in results:
        text = r.get("text", "")
        mem_type = r.get("type", "")
        mentioned_at = r.get("mentioned_at", "")
        type_str = f" [{mem_type}]" if mem_type else ""
        # switchroom #tz-fix (recall side): mentioned_at arrives as a UTC ISO
        # timestamp from the Hindsight server. Render it through the same
        # SWITCHROOM_TIMEZONE→TZ→UTC zoneinfo conversion as format_current_time
        # so recall lines never inject a UTC "when". Date-only / unparseable
        # values are surfaced verbatim rather than crashing recall.
        display_at = _format_local_timestamp(mentioned_at) if mentioned_at else ""
        date_str = f" ({display_at})" if display_at else ""
        lines.append(f"- {text}{type_str}{date_str}")
    return "\n\n".join(lines)


def _resolve_agent_timezone() -> str:
    """Resolve the agent's configured IANA timezone.

    Mirrors the switchroom cascade used by ``bin/timezone-hook.sh`` and
    ``src/config/timezone.ts``: ``SWITCHROOM_TIMEZONE`` → ``TZ`` → ``UTC``.
    This recall hook runs as a plugin subprocess INSIDE the agent container,
    so it inherits both env vars (compose.ts bakes them onto the container).
    """
    return os.environ.get("SWITCHROOM_TIMEZONE") or os.environ.get("TZ") or "UTC"


def _format_local_timestamp(value: str) -> str:
    """Render a UTC ISO timestamp in the agent's LOCAL timezone (am/pm form).

    Used by ``format_memories`` to convert the server-supplied ``mentioned_at``
    (UTC ISO, e.g. ``2026-07-16T04:09:00Z``) through the same
    SWITCHROOM_TIMEZONE→TZ→UTC zoneinfo cascade as ``format_current_time``,
    so recalled memories never surface a UTC "when".

    Guarding: only full ISO *datetime* values (those carrying a time component,
    i.e. containing ``T``) are converted. Date-only strings (``2024-01-01``) and
    anything unparseable are returned verbatim rather than crashing recall or
    fabricating a midnight time.
    """
    if not isinstance(value, str):
        return value
    raw = value.strip()
    # Only convert full ISO datetimes — a bare date has no wall-clock to shift.
    if "T" not in raw:
        return value
    parsed = None
    try:
        # Python <3.11 fromisoformat rejects a trailing 'Z'; normalise it.
        iso = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
        parsed = datetime.fromisoformat(iso)
    except (ValueError, TypeError):
        return value
    # Naive value → server sends UTC, so assume UTC before converting.
    if parsed.tzinfo is None:
        if ZoneInfo is not None:
            try:
                parsed = parsed.replace(tzinfo=ZoneInfo("UTC"))
            except Exception:
                return value
        else:
            return value
    tz_name = _resolve_agent_timezone()
    if ZoneInfo is not None:
        try:
            local = parsed.astimezone(ZoneInfo(tz_name))
        except Exception:  # unknown/invalid zone — degrade to process-local.
            local = parsed.astimezone()
    else:
        local = parsed.astimezone()
    return local.strftime("%Y-%m-%d %I:%M %p %Z")


def format_current_time() -> str:
    """Format the current time in the agent's LOCAL timezone for recall context.

    Switchroom #tz-fix: previously this emitted ``"%Y-%m-%d %H:%M UTC"``, the
    STRONGEST of several competing UTC "current time" strings the model saw
    each turn — it fought the single correct local-time hint and made agents
    intermittently report UTC / wrong-offset times. We now render the agent's
    LOCAL wall clock in am/pm form (e.g. ``2026-07-16 04:09 PM AEST``) so the
    recall block never injects a UTC "now". Deterministic — the timezone comes
    from the container env, not model discipline.

    Port of: formatCurrentTimeForRecall() in index.js
    """
    tz_name = _resolve_agent_timezone()
    now = None
    if ZoneInfo is not None:
        try:
            now = datetime.now(ZoneInfo(tz_name))
        except Exception:  # unknown/invalid zone — degrade, don't crash recall.
            now = None
    if now is None:
        # No zoneinfo or bad zone: fall back to the process-local clock, which
        # already honours the container's TZ env via libc. am/pm form, no "UTC".
        now = datetime.now().astimezone()
    # "%Y-%m-%d %I:%M %p %Z" → e.g. "2026-07-16 04:09 PM AEST" (mirrors the
    # %I:%M %p %Z tail of bin/timezone-hook.sh's format).
    return now.strftime("%Y-%m-%d %I:%M %p %Z")


# ---------------------------------------------------------------------------
# Retention transcript formatting
# ---------------------------------------------------------------------------


def _extract_message_blocks(content, role: str = "") -> list:
    """Extract structured content blocks from a message for JSON retention.

    Returns a list of dicts, each representing a content block:
      - {"type": "text", "text": "..."} for text blocks
      - {"type": "tool_use", "name": "...", "input": {...}} for tool calls
      - Channel message tool_use blocks get their text extracted inline.
    """
    if isinstance(content, str):
        cleaned = strip_channel_envelope(strip_memory_tags(content)).strip()
        return [{"type": "text", "text": cleaned}] if cleaned else []

    if not isinstance(content, list):
        return []

    blocks = []
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type", "")

        if block_type == "text":
            text = strip_channel_envelope(strip_memory_tags(block.get("text", ""))).strip()
            if text:
                blocks.append({"type": "text", "text": text})

        elif block_type == "tool_use" and role == "assistant":
            if _is_channel_message_tool(block):
                # Channel messages: extract the outgoing text
                tool_input = block.get("input", {})
                for field in _MESSAGE_TEXT_FIELDS:
                    val = tool_input.get(field)
                    if isinstance(val, str) and val.strip():
                        blocks.append({"type": "text", "text": val.strip()})
                        break
            else:
                name = block.get("name", "unknown")
                inp = block.get("input", {})
                # Skip Hindsight MCP tools to avoid feedback loops
                if name.startswith("mcp__") and _OPERATIONAL_TOOL_PATTERN.search(name.split("__")[-1]):
                    continue
                blocks.append({"type": "tool_use", "name": name, "input": inp})

        elif block_type == "tool_result":
            # Include tool results for context.
            # content can be a plain string or a list of content blocks
            # (e.g. [{"type": "text", "text": "..."}] for Agent results).
            result_content = block.get("content", "")
            if isinstance(result_content, list):
                # Extract text from content blocks
                parts = []
                for item in result_content:
                    if isinstance(item, dict) and item.get("type") == "text":
                        t = item.get("text", "").strip()
                        if t:
                            parts.append(t)
                result_content = "\n".join(parts)
            if isinstance(result_content, str) and result_content.strip():
                text = result_content.strip()
                # Truncate very long results
                if len(text) > 2000:
                    text = text[:2000] + "... (truncated)"
                blocks.append({"type": "tool_result", "tool_use_id": block.get("tool_use_id", ""), "content": text})

    return blocks


def prepare_retention_transcript(
    messages: list,
    retain_roles: list = None,
    retain_full_window: bool = False,
    include_tool_calls: bool = False,
) -> tuple:
    """Format messages into a retention transcript.

    When include_tool_calls is True, outputs JSON with full message structure
    including tool calls and their inputs. Otherwise outputs the legacy
    text format with [role: ...]...[role:end] markers.

    Args:
        messages: List of message dicts with 'role' and 'content'.
        retain_roles: Roles to include (default: ['user', 'assistant']).
        retain_full_window: If True, retain all messages (chunked mode).
            If False, retain only the last turn (last user msg + responses).
        include_tool_calls: If True, output JSON format with full tool call data.

    Returns:
        (transcript_text, message_count) or (None, 0) if nothing to retain.
    """
    if not messages:
        return None, 0

    if retain_full_window:
        target_messages = messages
    else:
        # Default: retain only the last turn
        last_user_idx = -1
        for i in range(len(messages) - 1, -1, -1):
            if messages[i].get("role") == "user":
                last_user_idx = i
                break
        if last_user_idx == -1:
            return None, 0
        target_messages = messages[last_user_idx:]

    allowed_roles = set(retain_roles or ["user", "assistant"])

    if include_tool_calls:
        return _prepare_json_transcript(target_messages, allowed_roles)
    return _prepare_text_transcript(target_messages, allowed_roles)


def _prepare_json_transcript(messages: list, allowed_roles: set) -> tuple:
    """Format messages as JSON with full tool call data."""
    import json

    structured_messages = []
    for msg in messages:
        role = msg.get("role", "unknown")
        if role not in allowed_roles:
            continue

        blocks = _extract_message_blocks(msg.get("content", ""), role=role)
        if not blocks:
            continue

        structured_messages.append({"role": role, "content": blocks})

    if not structured_messages:
        return None, 0

    transcript = json.dumps(structured_messages, indent=None, ensure_ascii=False)
    if len(transcript.strip()) < 10:
        return None, 0

    return transcript, len(structured_messages)


def _prepare_text_transcript(messages: list, allowed_roles: set) -> tuple:
    """Format messages as legacy text with [role:]...[role:end] markers."""
    parts = []

    for msg in messages:
        role = msg.get("role", "unknown")
        if role not in allowed_roles:
            continue

        content = _extract_text_content(msg.get("content", ""), role=role)
        content = strip_channel_envelope(content)
        content = strip_memory_tags(content).strip()

        if not content:
            continue

        parts.append(f"[role: {role}]\n{content}\n[{role}:end]")

    if not parts:
        return None, 0

    transcript = "\n\n".join(parts)
    if len(transcript.strip()) < 10:
        return None, 0

    return transcript, len(parts)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Fields in tool_use input that carry the outgoing message text.
# Ordered by likelihood — first match wins.
_MESSAGE_TEXT_FIELDS = ("text", "body", "message", "content")

# MCP tool name suffixes that are operational, not conversational.
# Checked against the last segment of the tool name (after the last __).
import re as _re

_OPERATIONAL_TOOL_PATTERN = _re.compile(
    r"(?:recall|retain|reflect|search|extract|create_|delete_|update_|get_|list_)",
    _re.IGNORECASE,
)


def _is_channel_message_tool(block: dict) -> bool:
    """Detect if a tool_use block is a channel message (reply/send).

    Uses a structural approach rather than name-matching for robustness:
      1. Must be an MCP tool (name starts with "mcp__")
      2. Must NOT match known operational patterns (recall, search, CRUD)
      3. Must have a text-like field in input (text, body, message, content)

    This catches any channel plugin (Telegram, Slack, Discord, Matrix,
    future channels) without hardcoding tool names. Built-in tools (Bash,
    Read, Write) don't start with mcp__. MCP tools for non-messaging
    purposes (hindsight recall, search) are excluded by pattern and by
    lacking text/body fields.
    """
    name = block.get("name", "")
    if not name.startswith("mcp__"):
        return False

    # Exclude operational MCP tools (check only the tool suffix, not server name)
    tool_suffix = name.split("__")[-1]
    if _OPERATIONAL_TOOL_PATTERN.search(tool_suffix):
        return False

    tool_input = block.get("input", {})
    if not isinstance(tool_input, dict):
        return False

    # Must have a text-carrying field with actual content
    return any(isinstance(tool_input.get(f), str) and tool_input[f].strip() for f in _MESSAGE_TEXT_FIELDS)


def _extract_text_content(content, role: str = "") -> str:
    """Extract text from message content (string or content blocks array).

    For user messages: extracts from plain strings (channel XML wrappers
    are stripped separately by strip_channel_envelope).

    For assistant messages: extracts from:
      - {type: "text"} blocks — terminal output/narration
      - {type: "tool_use"} blocks detected as channel messages — the agent's
        actual responses to the user. Detection is structural (MCP tool with
        text-like input field), not name-based, for channel-agnosticism.

    Excludes:
      - {type: "thinking"} — internal reasoning
      - {type: "tool_use"} for operational tools — Bash, Read, Write, recall, etc.
      - {type: "tool_result"} — operational results, not conversation
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts = []
        for block in content:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type", "")

            # Text blocks: terminal output / narration
            if block_type == "text":
                text = block.get("text", "").strip()
                if text:
                    texts.append(text)

            # Tool use blocks: extract channel messages
            elif block_type == "tool_use" and role == "assistant":
                if _is_channel_message_tool(block):
                    tool_input = block.get("input", {})
                    for field in _MESSAGE_TEXT_FIELDS:
                        val = tool_input.get(field)
                        if isinstance(val, str) and val.strip():
                            texts.append(val.strip())
                            break

        return "\n".join(texts)
    return ""
