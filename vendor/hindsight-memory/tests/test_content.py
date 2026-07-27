"""Tests for lib/content.py — pure content-processing functions."""

import re

import pytest

from lib.content import (
    _extract_text_content,
    _is_channel_message_tool,
    compose_recall_query,
    format_current_time,
    format_memories,
    prepare_retention_transcript,
    shape_recall_query,
    slice_last_turns_by_user_boundary,
    strip_channel_envelope,
    strip_memory_tags,
    tokenize_for_bm25,
    truncate_recall_query,
)


# ---------------------------------------------------------------------------
# strip_channel_envelope
# ---------------------------------------------------------------------------


class TestStripChannelEnvelope:
    def test_strips_channel_xml(self):
        raw = '<channel source="plugin:telegram:telegram" chat_id="123">Hello world</channel>'
        assert strip_channel_envelope(raw) == "Hello world"

    def test_passthrough_plain_text(self):
        assert strip_channel_envelope("just plain text") == "just plain text"

    def test_strips_multiline_channel(self):
        raw = "<channel source='s'>\nline1\nline2\n</channel>"
        assert strip_channel_envelope(raw) == "line1\nline2"

    def test_passthrough_when_no_channel_tag(self):
        raw = "<other>stuff</other>"
        assert strip_channel_envelope(raw) == raw


# ---------------------------------------------------------------------------
# strip_memory_tags
# ---------------------------------------------------------------------------


class TestStripMemoryTags:
    def test_strips_hindsight_memories_block(self):
        raw = "before\n<hindsight_memories>secret</hindsight_memories>\nafter"
        assert "hindsight_memories" not in strip_memory_tags(raw)
        assert "before" in strip_memory_tags(raw)
        assert "after" in strip_memory_tags(raw)

    def test_strips_relevant_memories_block(self):
        raw = "text <relevant_memories>old stuff</relevant_memories> text"
        result = strip_memory_tags(raw)
        assert "relevant_memories" not in result
        assert "old stuff" not in result

    def test_passthrough_clean_text(self):
        raw = "no memory tags here"
        assert strip_memory_tags(raw) == raw

    def test_strips_multiline_block(self):
        raw = "<hindsight_memories>\n- mem1\n- mem2\n</hindsight_memories>"
        assert strip_memory_tags(raw).strip() == ""


# ---------------------------------------------------------------------------
# slice_last_turns_by_user_boundary
# ---------------------------------------------------------------------------


def _msgs(*pairs):
    """Build a message list from (role, content) pairs."""
    return [{"role": r, "content": c} for r, c in pairs]


class TestSliceLastTurnsByUserBoundary:
    def test_returns_all_when_fewer_turns_than_requested(self):
        msgs = _msgs(("user", "hi"), ("assistant", "hello"))
        assert slice_last_turns_by_user_boundary(msgs, 5) == msgs

    def test_slices_to_last_one_turn(self):
        msgs = _msgs(
            ("user", "first"),
            ("assistant", "a1"),
            ("user", "second"),
            ("assistant", "a2"),
        )
        result = slice_last_turns_by_user_boundary(msgs, 1)
        assert result[0]["content"] == "second"
        assert len(result) == 2

    def test_slices_to_last_two_turns(self):
        msgs = _msgs(
            ("user", "u1"),
            ("assistant", "a1"),
            ("user", "u2"),
            ("assistant", "a2"),
            ("user", "u3"),
            ("assistant", "a3"),
        )
        result = slice_last_turns_by_user_boundary(msgs, 2)
        assert result[0]["content"] == "u2"
        assert len(result) == 4

    def test_empty_list_returns_empty(self):
        assert slice_last_turns_by_user_boundary([], 3) == []

    def test_zero_turns_returns_empty(self):
        msgs = _msgs(("user", "hi"))
        assert slice_last_turns_by_user_boundary(msgs, 0) == []

    def test_non_list_returns_empty(self):
        assert slice_last_turns_by_user_boundary(None, 1) == []

    # --- switchroom divergence: tool_result user-messages are NOT turns ---

    @staticmethod
    def _tool_result(tuid: str, text: str) -> dict:
        # Claude Code emits tool results as role="user" with a content list of
        # tool_result blocks (the shape read_transcript produces).
        return {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": tuid, "content": text}],
        }

    def test_tool_result_messages_are_not_turn_boundaries(self):
        # One human turn + 3 tool rounds. Requesting 1 turn must anchor to the
        # human message, NOT the newest tool_result — otherwise a tool-heavy
        # turn drops the human's text from the window (silent memory loss).
        msgs = [
            {"role": "user", "content": "human fact"},
            {"role": "assistant", "content": "a"},
            self._tool_result("t1", "r1"),
            {"role": "assistant", "content": "a"},
            self._tool_result("t2", "r2"),
            {"role": "assistant", "content": "a"},
            self._tool_result("t3", "r3"),
            {"role": "assistant", "content": "a"},
        ]
        result = slice_last_turns_by_user_boundary(msgs, 1)
        assert result[0]["content"] == "human fact"
        assert result == msgs  # only 1 human turn, so the whole thing is kept

    def test_counts_human_turns_only_across_tool_heavy_turns(self):
        # 2 human turns, each followed by a tool round. Requesting 1 human turn
        # slices to the SECOND human message, not into the first turn's tools.
        msgs = [
            {"role": "user", "content": "human one"},
            {"role": "assistant", "content": "a"},
            self._tool_result("t1", "r1"),
            {"role": "user", "content": "human two"},
            {"role": "assistant", "content": "a"},
            self._tool_result("t2", "r2"),
        ]
        result = slice_last_turns_by_user_boundary(msgs, 1)
        assert result[0]["content"] == "human two"

    def test_mixed_text_and_tool_result_block_is_a_boundary(self):
        # A user message with BOTH text and a tool_result block still counts as
        # a human turn (conservative — only pure tool_result messages are skipped).
        msgs = [
            {"role": "user", "content": "older"},
            {"role": "assistant", "content": "a"},
            {"role": "user", "content": [
                {"type": "text", "text": "human with attached result"},
                {"type": "tool_result", "tool_use_id": "t1", "content": "r1"},
            ]},
            {"role": "assistant", "content": "a"},
        ]
        result = slice_last_turns_by_user_boundary(msgs, 1)
        assert result[0]["content"][0]["text"] == "human with attached result"


# ---------------------------------------------------------------------------
# compose_recall_query
# ---------------------------------------------------------------------------


class TestComposeRecallQuery:
    def test_single_turn_returns_latest_only(self):
        msgs = _msgs(("user", "previous"), ("assistant", "reply"))
        result = compose_recall_query("new query", msgs, recall_context_turns=1)
        assert result == "new query"

    def test_multi_turn_includes_prior_context(self):
        msgs = _msgs(("user", "prior question"), ("assistant", "prior answer"))
        result = compose_recall_query("current question", msgs, recall_context_turns=2)
        assert "Prior context:" in result
        assert "prior question" in result
        assert "current question" in result

    def test_skips_duplicate_of_latest_query(self):
        msgs = _msgs(("user", "same question"), ("assistant", "answer"))
        result = compose_recall_query("same question", msgs, recall_context_turns=2)
        # duplicate user msg should be dropped from context
        assert result.count("same question") == 1

    def test_empty_messages_returns_latest(self):
        result = compose_recall_query("query", [], recall_context_turns=3)
        assert result == "query"

    def test_strips_memory_tags_from_context(self):
        msgs = _msgs(
            ("user", "<hindsight_memories>secret</hindsight_memories> actual question"),
        )
        result = compose_recall_query("now", msgs, recall_context_turns=2)
        assert "hindsight_memories" not in result
        assert "secret" not in result

    def test_filters_by_recall_roles(self):
        msgs = _msgs(("user", "user msg"), ("assistant", "assistant msg"))
        result = compose_recall_query("query", msgs, recall_context_turns=2, recall_roles=["user"])
        assert "user msg" in result
        assert "assistant msg" not in result

    # --- switchroom divergence: the recall context slice counts HUMAN turns,
    # not tool_result pseudo-turns (follow-up to #2830, closing the reviewer nit
    # that the retain path had a test but the recall path — the OTHER caller of
    # slice_last_turns_by_user_boundary — did not).

    def test_tool_heavy_prior_turn_keeps_human_text_in_recall_context(self):
        # A prior human turn stating a fact, then 3 sequential tool rounds
        # (Claude Code emits tool results as role="user"). recall_context_turns=2
        # asks for the latest turn + one prior HUMAN turn. If the tool_result
        # messages were counted as boundaries the human fact would be sliced
        # out; the guard skips them so the fact lands in "Prior context:".
        messages = [
            {"role": "user", "content": "my prod database is called ORCHID_PRIMARY"},
            {"role": "assistant", "content": "let me look that up"},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "TOOLPAYLOAD_1"}]},
            {"role": "assistant", "content": "checking more"},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t2", "content": "TOOLPAYLOAD_2"}]},
            {"role": "assistant", "content": "one more"},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t3", "content": "TOOLPAYLOAD_3"}]},
            {"role": "assistant", "content": "here is your schema"},
        ]
        result = compose_recall_query("what port does it listen on", messages, recall_context_turns=2)
        assert "Prior context:" in result
        assert "ORCHID_PRIMARY" in result  # human turn survived the tool-heavy turn
        assert "TOOLPAYLOAD" not in result  # tool_result payload is not human context

    def test_recall_context_anchors_to_human_turns_across_tool_volume(self):
        # Two prior human turns, each followed by tool rounds. Asking for 3
        # context turns (latest + 2 prior HUMAN) must reach past all the
        # tool_result messages to the oldest human turn — tool volume must not
        # consume the turn budget.
        messages = [
            {"role": "user", "content": "the deploy key is FALCON_9_KEY"},
            {"role": "assistant", "content": "looking"},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "out a"}]},
            {"role": "assistant", "content": "more"},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t2", "content": "out b"}]},
            {"role": "user", "content": "and remind me of the region too"},
            {"role": "assistant", "content": "checking region"},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t3", "content": "out c"}]},
            {"role": "assistant", "content": "region is ap-southeast-2"},
        ]
        result = compose_recall_query("put those together for me", messages, recall_context_turns=3)
        assert "Prior context:" in result
        assert "FALCON_9_KEY" in result
        assert "and remind me of the region too" in result


# ---------------------------------------------------------------------------
# truncate_recall_query
# ---------------------------------------------------------------------------


class TestTruncateRecallQuery:
    def test_short_query_unchanged(self):
        q = "short"
        assert truncate_recall_query(q, q, max_chars=100) == q

    def test_plain_query_truncated_to_max(self):
        q = "x" * 50
        result = truncate_recall_query(q, q, max_chars=20)
        assert len(result) <= 20

    def test_preserves_latest_when_context_dropped(self):
        latest = "final question"
        query = f"Prior context:\n\nuser: old stuff\nassistant: old reply\n\n{latest}"
        result = truncate_recall_query(query, latest, max_chars=30)
        assert latest in result

    def test_drops_oldest_context_lines_first(self):
        latest = "latest"
        query = f"Prior context:\n\nuser: oldest\nassistant: old\nuser: newer\n\n{latest}"
        # Allow only the newest context line + latest
        result = truncate_recall_query(query, latest, max_chars=len(f"Prior context:\n\nnewer\n\n{latest}") + 5)
        if "Prior context:" in result:
            assert "oldest" not in result

    def test_zero_max_returns_query_unchanged(self):
        q = "anything"
        assert truncate_recall_query(q, q, max_chars=0) == q


# ---------------------------------------------------------------------------
# format_memories
# ---------------------------------------------------------------------------


class TestFormatMemories:
    def test_formats_single_memory(self):
        mems = [{"text": "Paris is the capital", "type": "world", "mentioned_at": "2024-01-01"}]
        result = format_memories(mems)
        assert "Paris is the capital" in result
        assert "[world]" in result
        assert "(2024-01-01)" in result

    def test_formats_multiple_memories_with_separator(self):
        mems = [
            {"text": "mem1", "type": "experience", "mentioned_at": "2024-01-01"},
            {"text": "mem2", "type": "world", "mentioned_at": "2024-02-01"},
        ]
        result = format_memories(mems)
        assert "mem1" in result
        assert "mem2" in result

    def test_empty_list_returns_empty_string(self):
        assert format_memories([]) == ""

    def test_missing_optional_fields_graceful(self):
        mems = [{"text": "bare memory"}]
        result = format_memories(mems)
        assert "bare memory" in result

    # switchroom #tz-fix (recall side): mentioned_at is a UTC ISO timestamp
    # from the Hindsight server; recall must render it in the agent's LOCAL
    # am/pm, not surface a UTC "when".
    def test_mentioned_at_utc_iso_rendered_local(self, monkeypatch):
        monkeypatch.setenv("SWITCHROOM_TIMEZONE", "Australia/Melbourne")
        monkeypatch.delenv("TZ", raising=False)
        # 04:09Z in July → AEST (UTC+10) → 02:09 PM local.
        mems = [{"text": "m", "mentioned_at": "2026-07-16T04:09:00Z"}]
        result = format_memories(mems)
        assert "(2026-07-16 02:09 PM AEST)" in result
        # Never the raw UTC value.
        assert "04:09:00Z" not in result
        assert "T04:09" not in result

    def test_mentioned_at_offset_form_rendered_local(self, monkeypatch):
        monkeypatch.setenv("SWITCHROOM_TIMEZONE", "Australia/Melbourne")
        monkeypatch.delenv("TZ", raising=False)
        mems = [{"text": "m", "mentioned_at": "2026-07-16T04:09:00+00:00"}]
        result = format_memories(mems)
        assert "(2026-07-16 02:09 PM AEST)" in result

    def test_mentioned_at_date_only_preserved_verbatim(self, monkeypatch):
        # A bare date has no wall clock to shift — surface it verbatim rather
        # than fabricating a midnight time.
        monkeypatch.setenv("SWITCHROOM_TIMEZONE", "Australia/Melbourne")
        mems = [{"text": "m", "mentioned_at": "2024-01-01"}]
        result = format_memories(mems)
        assert "(2024-01-01)" in result

    def test_mentioned_at_unparseable_preserved_verbatim(self, monkeypatch):
        monkeypatch.setenv("SWITCHROOM_TIMEZONE", "Australia/Melbourne")
        mems = [{"text": "m", "mentioned_at": "not-a-timestampT!!"}]
        result = format_memories(mems)
        assert "(not-a-timestampT!!)" in result


# ---------------------------------------------------------------------------
# _is_channel_message_tool
# ---------------------------------------------------------------------------


class TestIsChannelMessageTool:
    def test_telegram_send_message(self):
        block = {"type": "tool_use", "name": "mcp__telegram__sendMessage", "input": {"text": "hello"}}
        assert _is_channel_message_tool(block) is True

    def test_slack_reply_tool(self):
        block = {"type": "tool_use", "name": "mcp__slack__reply", "input": {"body": "hi there"}}
        assert _is_channel_message_tool(block) is True

    def test_operational_recall_tool_excluded(self):
        block = {"type": "tool_use", "name": "mcp__hindsight__recall", "input": {"query": "test"}}
        assert _is_channel_message_tool(block) is False

    def test_builtin_bash_tool_excluded(self):
        block = {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}}
        assert _is_channel_message_tool(block) is False

    def test_mcp_tool_without_text_field_excluded(self):
        block = {"type": "tool_use", "name": "mcp__something__action", "input": {"id": 123}}
        assert _is_channel_message_tool(block) is False

    def test_mcp_tool_with_empty_text_excluded(self):
        block = {"type": "tool_use", "name": "mcp__telegram__send", "input": {"text": "   "}}
        assert _is_channel_message_tool(block) is False

    def test_mcp_create_action_excluded(self):
        block = {"type": "tool_use", "name": "mcp__notion__create_page", "input": {"content": "hello"}}
        assert _is_channel_message_tool(block) is False


# ---------------------------------------------------------------------------
# _extract_text_content
# ---------------------------------------------------------------------------


class TestExtractTextContent:
    def test_plain_string_returned_as_is(self):
        assert _extract_text_content("hello", role="user") == "hello"

    def test_text_block_extracted(self):
        content = [{"type": "text", "text": "response text"}]
        assert _extract_text_content(content, role="assistant") == "response text"

    def test_thinking_block_excluded(self):
        content = [{"type": "thinking", "thinking": "private"}, {"type": "text", "text": "public"}]
        result = _extract_text_content(content, role="assistant")
        assert "private" not in result
        assert "public" in result

    def test_channel_tool_use_extracted_for_assistant(self):
        content = [{"type": "tool_use", "name": "mcp__telegram__send", "input": {"text": "hello user"}}]
        result = _extract_text_content(content, role="assistant")
        assert "hello user" in result

    def test_tool_use_not_extracted_for_user(self):
        content = [{"type": "tool_use", "name": "mcp__telegram__send", "input": {"text": "hello user"}}]
        result = _extract_text_content(content, role="user")
        assert "hello user" not in result

    def test_empty_list_returns_empty_string(self):
        assert _extract_text_content([], role="assistant") == ""

    def test_non_string_non_list_returns_empty(self):
        assert _extract_text_content(None, role="user") == ""
        assert _extract_text_content(42, role="user") == ""


# ---------------------------------------------------------------------------
# prepare_retention_transcript
# ---------------------------------------------------------------------------


class TestPrepareRetentionTranscript:
    def test_formats_last_turn_by_default(self):
        msgs = _msgs(("user", "old"), ("assistant", "old reply"), ("user", "new"), ("assistant", "new reply"))
        transcript, count = prepare_retention_transcript(msgs, retain_full_window=False)
        assert "new" in transcript
        assert "new reply" in transcript
        assert count == 2

    def test_full_window_retains_all(self):
        msgs = _msgs(("user", "msg1"), ("assistant", "reply1"), ("user", "msg2"), ("assistant", "reply2"))
        transcript, count = prepare_retention_transcript(msgs, retain_full_window=True)
        assert "msg1" in transcript
        assert "msg2" in transcript
        assert count == 4

    def test_strips_memory_tags(self):
        msgs = _msgs(("user", "<hindsight_memories>leaked</hindsight_memories> actual question"))
        transcript, _ = prepare_retention_transcript(msgs, retain_full_window=True)
        assert "leaked" not in transcript
        assert "actual question" in transcript

    def test_filters_by_retain_roles(self):
        msgs = _msgs(("user", "user msg"), ("assistant", "assistant msg"))
        transcript, _ = prepare_retention_transcript(msgs, retain_roles=["user"], retain_full_window=True)
        assert "user msg" in transcript
        assert "assistant msg" not in transcript

    def test_empty_messages_returns_none(self):
        result, count = prepare_retention_transcript([])
        assert result is None
        assert count == 0

    def test_role_markers_present(self):
        msgs = _msgs(("user", "hello"))
        transcript, _ = prepare_retention_transcript(msgs, retain_full_window=True)
        assert "[role: user]" in transcript
        assert "[user:end]" in transcript

    def test_no_user_message_returns_none(self):
        msgs = [{"role": "assistant", "content": "only assistant"}]
        result, _ = prepare_retention_transcript(msgs, retain_full_window=False)
        assert result is None

    def test_json_format_with_tool_calls(self):
        """When include_tool_calls=True, output should be JSON with tool_use blocks."""
        import json

        msgs = [
            {"role": "user", "content": "edit the file"},
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "I'll edit that file."},
                    {
                        "type": "tool_use",
                        "name": "Edit",
                        "input": {"file_path": "/tmp/foo.py", "old_string": "old", "new_string": "new"},
                    },
                ],
            },
        ]
        transcript, count = prepare_retention_transcript(
            msgs, retain_full_window=True, include_tool_calls=True
        )
        assert transcript is not None
        data = json.loads(transcript)
        assert len(data) == 2
        assert data[0]["role"] == "user"
        assert data[1]["role"] == "assistant"
        # Should have both text and tool_use blocks
        block_types = [b["type"] for b in data[1]["content"]]
        assert "text" in block_types
        assert "tool_use" in block_types
        # Tool input should be preserved
        tool_block = next(b for b in data[1]["content"] if b["type"] == "tool_use")
        assert tool_block["name"] == "Edit"
        assert tool_block["input"]["file_path"] == "/tmp/foo.py"

    def test_json_format_excludes_hindsight_mcp_tools(self):
        """Hindsight MCP tools should be excluded even in JSON mode."""
        import json

        msgs = [
            {"role": "user", "content": "recall something"},
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "Let me check."},
                    {"type": "tool_use", "name": "mcp__hindsight__recall", "input": {"query": "test"}},
                ],
            },
        ]
        transcript, _ = prepare_retention_transcript(
            msgs, retain_full_window=True, include_tool_calls=True
        )
        data = json.loads(transcript)
        assistant_blocks = data[1]["content"]
        assert len(assistant_blocks) == 1
        assert assistant_blocks[0]["type"] == "text"

    def test_json_format_includes_tool_results(self):
        """Tool results should be included in JSON mode."""
        import json

        msgs = [
            {"role": "user", "content": "run ls"},
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "Running ls."},
                    {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}},
                ],
            },
            {
                "role": "assistant",
                "content": [
                    {"type": "tool_result", "tool_use_id": "123", "content": "file1.py\nfile2.py"},
                    {"type": "text", "text": "Here are the files."},
                ],
            },
        ]
        transcript, _ = prepare_retention_transcript(
            msgs, retain_full_window=True, include_tool_calls=True
        )
        data = json.loads(transcript)
        result_msg = next(m for m in data if any(b.get("type") == "tool_result" for b in m["content"]))
        result_block = next(b for b in result_msg["content"] if b["type"] == "tool_result")
        assert "file1.py" in result_block["content"]

    def test_json_format_handles_list_content_tool_results(self):
        """Tool results with list content (e.g. Agent subagent responses) should be extracted."""
        import json

        msgs = [
            {"role": "user", "content": "analyze the code"},
            {
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "name": "Agent", "input": {"prompt": "check code"}},
                ],
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_abc",
                        "content": [
                            {"type": "text", "text": "Found 3 issues in the codebase."},
                            {"type": "text", "text": "1. Missing error handling in auth module"},
                        ],
                    },
                ],
            },
        ]
        transcript, _ = prepare_retention_transcript(
            msgs, retain_full_window=True, include_tool_calls=True
        )
        data = json.loads(transcript)
        result_msg = next(m for m in data if any(b.get("type") == "tool_result" for b in m["content"]))
        result_block = next(b for b in result_msg["content"] if b["type"] == "tool_result")
        assert "Found 3 issues" in result_block["content"]
        assert "Missing error handling" in result_block["content"]

    def test_without_tool_calls_uses_text_format(self):
        """Default (include_tool_calls=False) should use legacy text format."""
        msgs = _msgs(("user", "hello"), ("assistant", "world"))
        transcript, _ = prepare_retention_transcript(msgs, retain_full_window=True, include_tool_calls=False)
        assert "[role: user]" in transcript
        assert "[user:end]" in transcript


# ---------------------------------------------------------------------------
# format_current_time
# ---------------------------------------------------------------------------


class TestFormatCurrentTime:
    # switchroom #tz-fix: recall's "Current time - …" line now renders the
    # agent's LOCAL wall clock in am/pm, NOT UTC — it was the strongest of
    # several competing UTC "now" strings the model saw each turn.
    def test_local_am_pm_shape(self, monkeypatch):
        # A real IANA zone → am/pm form with the zone abbreviation, no "UTC".
        monkeypatch.setenv("SWITCHROOM_TIMEZONE", "Australia/Melbourne")
        monkeypatch.delenv("TZ", raising=False)
        out = format_current_time()
        # e.g. "2026-07-16 04:09 PM AEST" / "… AEDT" (DST) — abbrev is 3-5 alpha.
        assert re.fullmatch(
            r"\d{4}-\d{2}-\d{2} \d{2}:\d{2} (?:AM|PM) [A-Za-z]{2,5}", out
        ), out

    def test_never_emits_utc_current_time(self, monkeypatch):
        # The whole point of the fix: no UTC "current time" for a real zone.
        monkeypatch.setenv("SWITCHROOM_TIMEZONE", "Australia/Melbourne")
        monkeypatch.delenv("TZ", raising=False)
        out = format_current_time()
        assert "UTC" not in out
        assert not out.endswith("Z")

    def test_am_pm_when_no_zone_configured(self, monkeypatch):
        # No SWITCHROOM_TIMEZONE / TZ → still am/pm shape (process-local clock),
        # never the old "%Y-%m-%d %H:%M UTC" 24h form.
        monkeypatch.delenv("SWITCHROOM_TIMEZONE", raising=False)
        monkeypatch.delenv("TZ", raising=False)
        out = format_current_time()
        assert re.match(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2} (?:AM|PM)", out), out


# ---------------------------------------------------------------------------
# Switchroom #3757 — BM25 query shaping
#
# The bug these guard: the recall hook composed an 800-char, ~110-token query
# and Hindsight OR-joined every token into one tsquery. On the live `overlord`
# bank that matched 119,510 of 135,565 rows and took 14.0s for the 3-arm BM25
# UNION — past the per-bank client timeout, so 96.8% of that agent's own-bank
# recalls returned NOTHING. Two of those tokens were scaffolding this hook
# added itself: `user` (67,363 rows = 50% of the bank) and `assistant`
# (29,942 = 22%).
# ---------------------------------------------------------------------------


def _production_shaped_query():
    """A composed query with the shape recall.py actually produces."""
    msgs = _msgs(
        ("user", "the deploy went out this morning but the rollout never reached the fleet"),
        (
            "assistant",
            "I checked the manifest for v0.19.17 and the digest does not match what "
            "the agent container is running, so the pull raced the tag",
        ),
    )
    return compose_recall_query(
        "why did recall for the v0.19.17 rollout return v0.18.15 instead",
        msgs,
        recall_context_turns=2,
    )


class TestComposedQueryHasNoRoleLabels:
    def test_compose_does_not_prefix_role_labels(self):
        # The regression this guards: `context_lines.append(f"{role}: {content}")`.
        msgs = _msgs(("user", "prior question"), ("assistant", "prior answer"))
        result = compose_recall_query("current question", msgs, recall_context_turns=2)
        assert "prior question" in result
        assert "prior answer" in result
        assert "user:" not in result
        assert "assistant:" not in result

    def test_role_labels_are_not_bm25_tokens(self):
        # The property that actually matters — not "the string is absent" but
        # "the term never reaches the tsquery".
        query = _production_shaped_query()
        shaped = shape_recall_query(query, "why did recall for the v0.19.17 rollout "
                                           "return v0.18.15 instead")
        terms = set(tokenize_for_bm25(shaped))
        assert "user" not in terms
        assert "assistant" not in terms
        assert "prior" not in terms
        assert "context" not in terms

    def test_labels_embedded_in_transcript_text_are_still_stripped(self):
        # Defence in depth: an old composed string, or a turn that literally
        # contains a `user:` line, must not smuggle the label back in.
        legacy = "Prior context:\n\nuser: the deploy failed\nassistant: I checked it\n\nwhy"
        terms = set(tokenize_for_bm25(shape_recall_query(legacy, "why")))
        assert "user" not in terms
        assert "assistant" not in terms
        assert "deploy" in terms


class TestShapeRecallQuery:
    def test_caps_distinct_bm25_terms(self):
        query = " ".join(f"distinctword{i}" for i in range(200))
        shaped = shape_recall_query(query, "", max_tokens=24)
        assert len(set(tokenize_for_bm25(shaped))) <= 24

    def test_cap_counts_compound_token_expansion(self):
        # A compound is emitted by the server ALONGSIDE its fragments
        # (`v0.19.17` → v0.19.17, v0, 19, 17), so a naive "count the words we
        # sent" cap would silently ship 4x the terms it promised.
        query = " ".join(f"v0.19.{i}" for i in range(40))
        shaped = shape_recall_query(query, "", max_tokens=24)
        assert len(set(tokenize_for_bm25(shaped))) <= 24

    def test_cap_is_configurable(self):
        query = " ".join(f"distinctword{i}" for i in range(200))
        assert len(set(tokenize_for_bm25(shape_recall_query(query, "", max_tokens=8)))) <= 8
        assert len(set(tokenize_for_bm25(shape_recall_query(query, "", max_tokens=40)))) <= 40

    def test_zero_disables_shaping(self):
        query = "Prior context:\n\nsomething\n\nlatest"
        assert shape_recall_query(query, "latest", max_tokens=0) == query

    def test_prefers_latest_turn_over_prior_context(self):
        # A chronological truncation would keep the OLDEST context and throw
        # away the question the user actually asked.
        prior = " ".join(f"stalecontextword{i}" for i in range(60))
        latest = "why does the reaper skip orphaned worktrees"
        query = f"Prior context:\n\n{prior}\n\n{latest}"
        # Budget = exactly the latest turn's content terms: prior context is
        # what gets sacrificed, never the question.
        tight = set(tokenize_for_bm25(shape_recall_query(query, latest, max_tokens=4)))
        assert tight == {"reaper", "skip", "orphaned", "worktrees"}
        assert not any(t.startswith("stalecontextword") for t in tight)
        # With slack, the latest turn is still fully present and the leftover
        # budget goes to context (which is the point of composing at all).
        loose = set(tokenize_for_bm25(shape_recall_query(query, latest, max_tokens=12)))
        assert {"reaper", "skip", "orphaned", "worktrees"} <= loose
        assert any(t.startswith("stalecontextword") for t in loose)
        assert len(loose) <= 12

    def test_drops_english_stopwords(self):
        latest = "what did we decide about the worktree reaper"
        terms = set(tokenize_for_bm25(shape_recall_query(latest, latest, max_tokens=24)))
        assert "worktree" in terms
        assert "reaper" in terms
        assert "decide" in terms
        for stop in ("what", "did", "we", "about", "the"):
            assert stop not in terms

    def test_operator_stop_terms_are_dropped(self):
        # Bank-specific high-df words the generic stoplist cannot know about.
        latest = "the switchroom agent rollout stalled on the reaper"
        terms = set(
            tokenize_for_bm25(
                shape_recall_query(latest, latest, max_tokens=24,
                                   stop_terms=["switchroom", "agent"])
            )
        )
        assert "reaper" in terms
        assert "rollout" in terms
        assert "switchroom" not in terms
        assert "agent" not in terms

    def test_short_query_survives_intact(self):
        # No regression for the small-bank / short-prompt case: every content
        # word is kept, so recall quality is unchanged.
        latest = "worktree gc reaper timings"
        terms = set(tokenize_for_bm25(shape_recall_query(latest, latest, max_tokens=24)))
        assert terms == {"worktree", "gc", "reaper", "timings"}

    def test_all_stopword_query_is_not_emptied(self):
        # A conversational prompt must never be shaped down to nothing — an
        # empty query would return zero memories, the exact failure we are
        # fixing.
        latest = "what about that"
        shaped = shape_recall_query(latest, latest, max_tokens=24)
        assert tokenize_for_bm25(shaped)

    def test_untokenizable_query_returns_original(self):
        assert shape_recall_query("!!! ???", "!!! ???", max_tokens=24) == "!!! ???"

    def test_preserves_original_word_order(self):
        latest = "reaper skipped orphaned worktrees before rollout"
        shaped = shape_recall_query(latest, latest, max_tokens=24)
        # "before" is a stopword; the survivors keep the source order.
        assert shaped.split() == ["reaper", "skipped", "orphaned", "worktrees", "rollout"]

    def test_preserves_original_case(self):
        # The shaped string feeds BOTH arms. BM25 lowercases server-side, but
        # the embedding arm does not, so shaping must not flatten `Python` to
        # `python` or `PR` to `pr`.
        latest = "should the Python worker open a PR against Coolify"
        shaped = shape_recall_query(latest, latest, max_tokens=24)
        assert shaped.split() == ["Python", "worker", "open", "PR", "Coolify"]

    def test_production_shaped_query_fits_the_budget(self):
        query = _production_shaped_query()
        latest = "why did recall for the v0.19.17 rollout return v0.18.15 instead"
        shaped = shape_recall_query(query, latest, max_tokens=24)
        terms = set(tokenize_for_bm25(shaped))
        assert len(terms) <= 24
        # The discriminating identifiers from the latest turn survive.
        assert "v0.19.17" in terms
        assert "rollout" in terms


class TestTokenizeForBm25:
    def test_matches_server_tokenizer_on_compounds(self):
        # Mirrors hindsight_api/engine/search/retrieval.py::tokenize_query —
        # fragments PLUS the intact compound.
        tokens = tokenize_for_bm25("bumped to v0.19.17")
        assert "v0.19.17" in tokens
        assert {"v0", "19", "17"} <= set(tokens)

    def test_empty_for_punctuation_only(self):
        assert tokenize_for_bm25("!!! ???") == []
