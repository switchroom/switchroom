#!/usr/bin/env python3
"""Sidechain retains carry LEARNINGS, not raw transcripts and tools.

Ken, 2026-07-29: "I don't want sub-agents' transcripts but definitely their
learnings should be captured but not raw transcripts and tools."

``run_subagent_retain`` forces ``retainToolCalls = False`` on its config COPY,
which routes the window through ``_prepare_text_transcript`` /
``_extract_text_content`` instead of ``_prepare_json_transcript`` /
``_extract_message_blocks``. These tests pin the observable consequences:

  1. Structural exclusion — a ``Write`` body, a ``Bash`` command and a
     ``tool_result`` marker are all absent from the POSTed content, while an
     assistant prose finding survives; and the content is NOT JSON (proving the
     text path, not the JSON path, produced it).
  2. Nothing goes silently empty — the text-only formatter still yields a
     substantive transcript for a representative sidechain fixture.

Stdlib-only, hermetic (no network, no live container); runs under
``python3 -m unittest discover tests/``.
"""

import contextlib
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import subagent_retain  # noqa: E402
from lib.content import prepare_retention_transcript  # noqa: E402

# Mirrors tests/test_subagent_retain.py CONFIG, including its
# ``retainToolCalls: True`` — the point is that the sidechain path must override
# it regardless of what the operator configured.
CONFIG = {
    "autoRetain": True,
    "retainMode": "chunked",
    "retainRoles": ["user", "assistant"],
    "retainToolCalls": True,
    "retainTags": ["{session_id}"],
    "retainMetadata": {},
    "retainContext": "claude-code",
    "hindsightApiToken": None,
    "debug": False,
}

# Distinctive markers. Each must be absent from the retained content.
WRITE_BODY_MARKER = "MARKER_WRITE_FILE_BODY_9f3a"
BASH_COMMAND_MARKER = "MARKER_BASH_COMMAND_c71d"
TOOL_RESULT_MARKER = "MARKER_TOOL_RESULT_PAYLOAD_4e82"

# The one thing that MUST survive: the sub-agent's own prose finding.
FINDING = (
    "Durable finding: the recall hook's stderr warning is swallowed by the CLI, "
    "so directives_omitted on the recall_log row is the only visible signal."
)


def _entry(role: str, content, uuid: str) -> str:
    """One nested Claude Code sidechain jsonl entry."""
    return json.dumps(
        {
            "type": role,
            "isSidechain": True,
            "agentId": "af5fba739c0ee6b38",
            "sessionId": "parentsess",
            "uuid": uuid,
            "message": {"role": role, "content": content},
        }
    )


# Per-turn assistant prose. Substantive text blocks so the fixture clears the
# RECALIBRATED (text-only) volume gate on genuine retainable prose — not on the
# tool_use volume the payload drops (#3994). ~180 chars each * 8 turns > the
# 2,000-char floor, all of it text the text-only path keeps.
TURN_PROSE = (
    "Reasoning step {i}: ruled out the consolidator dedup theory — world and "
    "experience facts never traverse the observation dedup path, so overlap "
    "persists as extra rows. Recording the constraint before moving on."
)


def _tool_heavy_sidechain(path: str, *, human_turns: int = 8) -> None:
    """A sidechain transcript that is mostly tool traffic plus real prose.

    Shaped to clear the volume gate (>= MIN_HUMAN_TURNS human turns and
    >= MIN_NON_TOOL_RESULT_CHARS of RETAINED text) on the assistant PROSE — the
    metric the recalibrated gate counts (#3994) — while the bulk of the bytes on
    disk is the tool traffic the text-only retain path drops.
    """
    lines = []
    for i in range(human_turns):
        lines.append(_entry("user", f"instruction {i}: keep going with the audit task", f"u{i}"))
        lines.append(
            _entry(
                "assistant",
                [
                    {
                        "type": "thinking",
                        "thinking": "internal reasoning that must never be retained",
                    },
                    {
                        "type": "text",
                        "text": TURN_PROSE.format(i=i),
                    },
                    {
                        "type": "tool_use",
                        "id": f"tu_w{i}",
                        "name": "Write",
                        # ~50 KB body — the class of payload this change exists to drop.
                        "input": {
                            "file_path": f"/tmp/scratch/out{i}.txt",
                            "content": WRITE_BODY_MARKER + ("Z" * 50_000),
                        },
                    },
                    {
                        "type": "tool_use",
                        "id": f"tu_b{i}",
                        "name": "Bash",
                        "input": {"command": f"{BASH_COMMAND_MARKER} --iteration {i}"},
                    },
                ],
                f"a{i}",
            )
        )
        lines.append(
            _entry(
                "user",
                [
                    {
                        "type": "tool_result",
                        "tool_use_id": f"tu_b{i}",
                        "content": TOOL_RESULT_MARKER + " " + ("q" * 4000),
                    }
                ],
                f"tr{i}",
            )
        )

    # The sub-agent's own prose, last — the learning that must survive.
    lines.append(_entry("user", "wrap up and report what you learned", "ufinal"))
    lines.append(_entry("assistant", [{"type": "text", "text": FINDING}], "afinal"))

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


@contextlib.contextmanager
def _lock_acquired(blocking=False):
    yield True


def _run_sidechain_retain(sidechain_path: str, tmpdir: str, config_extra=None):
    """Drive run_subagent_retain with a stub client.

    Returns ``(result, captured_retain_kwargs, passed_config)`` where
    ``passed_config`` is the EXACT dict object ``run_subagent_retain`` receives
    from ``load_config`` — the object the production code actually holds and
    could mutate. Tests assert on THAT object, never on the module-level
    ``CONFIG`` template (which the code never sees; asserting on it is vacuous —
    it passes even if the retainToolCalls-copy fix is deleted). See #3999.
    """
    captured = {}

    class _Client:
        def __init__(self, *a, **k):
            pass

        def retain(self, **kwargs):
            captured.update(kwargs)
            return {"ok": True}

    # A FRESH copy per run — this is the object the code receives via
    # load_config and is expected NOT to mutate.
    passed_config = dict(CONFIG, **(config_extra or {}))
    hook_input = {
        "session_id": "parentsess",
        "agent_id": "af5",
        "agent_type": "worker",
        "agent_transcript_path": sidechain_path,
        "transcript_path": os.path.join(tmpdir, "parentsess.jsonl"),
        "cwd": tmpdir,
    }
    with mock.patch("subagent_retain.load_config", return_value=passed_config), \
            mock.patch("subagent_retain.get_api_url", return_value="http://x"), \
            mock.patch("subagent_retain.ensure_bank_mission"), \
            mock.patch("subagent_retain.derive_bank_id", return_value="agentbank"), \
            mock.patch("subagent_retain.HindsightClient", _Client), \
            mock.patch("subagent_retain.inflight_lock", _lock_acquired):
        result = subagent_retain.run_subagent_retain(hook_input)
    return result, captured, passed_config


class SidechainRetainsLearningsNotTools(unittest.TestCase):
    """The retained content is the sub-agent's prose, not its tool traffic."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.sidechain = os.path.join(self._tmp.name, "agent-af5.jsonl")
        _tool_heavy_sidechain(self.sidechain)
        self.result, self.captured, self.passed_config = _run_sidechain_retain(
            self.sidechain, self._tmp.name
        )
        self.assertEqual(self.result["status"], "ok", self.result)
        self.content = self.captured["content"]

    def test_sub_agent_prose_finding_survives(self):
        self.assertIn(FINDING, self.content)

    def test_write_tool_body_is_excluded(self):
        self.assertNotIn(WRITE_BODY_MARKER, self.content)
        # And the 50 KB body itself is nowhere in the payload.
        self.assertNotIn("Z" * 200, self.content)

    def test_bash_command_is_excluded(self):
        self.assertNotIn(BASH_COMMAND_MARKER, self.content)

    def test_tool_result_body_is_excluded(self):
        self.assertNotIn(TOOL_RESULT_MARKER, self.content)

    def test_thinking_blocks_are_excluded(self):
        self.assertNotIn("internal reasoning that must never be retained", self.content)

    def test_content_is_not_the_json_transcript_form(self):
        """Proves we are on the text path, not _prepare_json_transcript.

        The JSON path emits a ``json.dumps`` list of ``{role, content: [blocks]}``;
        the text path emits ``[role: x]...[x:end]`` markers, which is not JSON.
        The mission header is prepended to both, so strip it first — otherwise
        this would pass for the wrong reason.
        """
        body = self.content[len(subagent_retain.SIDECHAIN_MISSION_HEADER):].strip()
        self.assertTrue(body, "no transcript body after the mission header")
        with self.assertRaises(json.JSONDecodeError):
            json.loads(body)
        # Positive check on the text-path shape.
        self.assertIn("[role: assistant]", body)

    def test_payload_is_far_smaller_than_the_raw_transcript(self):
        """Volume, not just shape: the whole point is fewer chars to extract."""
        raw_bytes = os.path.getsize(self.sidechain)
        self.assertLess(
            len(self.content),
            raw_bytes / 5,
            f"retained {len(self.content)} chars from a {raw_bytes}-byte transcript "
            "— expected a large reduction on the text-only path",
        )

    def test_operator_config_is_not_mutated(self):
        """The ``retainToolCalls = False`` override lands on the sidechain COPY
        (``sub_config = dict(config)``), never on the config the hook received.

        Asserts on ``passed_config`` — the EXACT object ``run_subagent_retain``
        got from ``load_config`` and could have mutated in place — not on the
        module-level ``CONFIG`` template. The old assertion (`CONFIG[...] is
        True`) was vacuous: the harness always hands the code a fresh copy, so
        ``CONFIG`` stays True even if the production copy is deleted and the code
        mutates its input directly. This version goes RED in exactly that case.
        """
        self.assertEqual(
            self.passed_config["retainToolCalls"],
            True,
            "run_subagent_retain mutated its caller's config (retainToolCalls "
            "flipped to False in place) instead of overriding on a copy",
        )

    def test_override_is_applied_on_the_copy_the_client_sees(self):
        """The flip must still REACH the payload: the stub client's retained
        content is on the text-only path (no tool bodies), which only happens if
        the sidechain copy carried ``retainToolCalls = False``. Together with
        the test above this pins BOTH halves — copied AND applied — so deleting
        either the copy or the override turns one of them RED."""
        self.assertNotIn(WRITE_BODY_MARKER, self.captured["content"])
        self.assertNotIn(BASH_COMMAND_MARKER, self.captured["content"])
        # Positive shape check: the text-only formatter's role markers, not JSON.
        self.assertIn("[role: assistant]", self.captured["content"])


class ProseFreeSidechainIsSkipped(unittest.TestCase):
    """The degenerate case — a worker with NO assistant prose, only tool traffic.

    Post-#3994 the volume gate counts ONLY the chars the text-only path keeps
    (``retained_text_char_count`` -> ``_extract_text_content``), so a fork whose
    bulk is entirely tool_use inputs + tool_result bodies now FAILS the char
    floor: once tools are stripped there is almost nothing to retain, and the
    tiny "go" instruction turns fall far under ``MIN_NON_TOOL_RESULT_CHARS``.
    That is the correct outcome — the old gate cleared on tool-command volume and
    then retained a near-empty document (the mismatch #3994 closes). This pins
    the SKIP so a revert to counting tool_use chars goes RED here.
    """

    def _prose_free_sidechain(self, path: str, human_turns: int = 8) -> None:
        lines = []
        for i in range(human_turns):
            # tool_result-only user messages don't count as human turns, so the
            # instruction turns are plain strings — but they are the USER's
            # words. Keep them short so, once tools are stripped, there is almost
            # no retainable text left.
            lines.append(_entry("user", "go", f"u{i}"))
            lines.append(
                _entry(
                    "assistant",
                    [
                        {
                            "type": "tool_use",
                            "id": f"tu{i}",
                            "name": "Bash",
                            "input": {"command": "true " + ("x" * 4000)},
                        }
                    ],
                    f"a{i}",
                )
            )
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")

    def test_prose_free_fork_fails_the_recalibrated_char_floor(self):
        with tempfile.TemporaryDirectory() as d:
            sc = os.path.join(d, "agent-af5.jsonl")
            self._prose_free_sidechain(sc)
            msgs = subagent_retain.read_transcript(sc)

            # It clears MIN_HUMAN_TURNS (8 genuine "go" turns)...
            self.assertGreaterEqual(
                subagent_retain.count_human_turns(msgs), subagent_retain.MIN_HUMAN_TURNS
            )
            # ...but the recalibrated (text-only) char count is far below the
            # floor, because every 4 KB Bash body is excluded from the count.
            passed, turns, chars = subagent_retain.passes_volume_gate(msgs, CONFIG)
            self.assertFalse(
                passed,
                f"prose-free fork should now SKIP: turns={turns} chars={chars} "
                f"(floor {subagent_retain.MIN_NON_TOOL_RESULT_CHARS})",
            )
            self.assertLess(chars, subagent_retain.MIN_NON_TOOL_RESULT_CHARS)

            # End to end: the retain is skipped by the volume gate; nothing POSTs.
            result, captured, _ = _run_sidechain_retain(sc, d)

        self.assertEqual(result["status"], "skipped", result)
        self.assertEqual(result["reason"], "volume gate")
        self.assertEqual(captured, {}, "a skipped fork must not POST a retain")


class TextOnlyPathIsNotEmpty(unittest.TestCase):
    """A representative sidechain still yields a substantive transcript.

    Prior measurement over 200 real klanker sidechain transcripts found 0 empty
    and 0 under 500 chars (p10 5,035 / p50 10,058 / p90 26,040 chars). A floor
    assertion, deliberately not an exact size.
    """

    # Well under the measured p10 (5,035) — this guards "silently empty",
    # not the exact reduction ratio.
    MIN_TRANSCRIPT_CHARS = 500

    def _representative_messages(self):
        """Prose-bearing assistant turns interleaved with tool traffic."""
        msgs = []
        for i in range(10):
            msgs.append({"role": "user", "content": f"step {i}: continue the investigation"})
            msgs.append(
                {
                    "role": "assistant",
                    "content": [
                        {"type": "thinking", "thinking": "internal " * 50},
                        {
                            "type": "text",
                            "text": (
                                f"Step {i}: confirmed the guard only probes observation rows, "
                                "so world/experience facts never traverse the semantic dedup "
                                "path. That is why overlap persists as extra rows."
                            ),
                        },
                        {
                            "type": "tool_use",
                            "id": f"tu{i}",
                            "name": "Bash",
                            "input": {"command": "grep -rn dedup " + ("x" * 3000)},
                        },
                    ],
                }
            )
            msgs.append(
                {
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": f"tu{i}", "content": "y" * 5000}
                    ],
                }
            )
        return msgs

    def test_text_only_transcript_is_non_empty_and_non_trivial(self):
        transcript, count = prepare_retention_transcript(
            self._representative_messages(),
            ["user", "assistant"],
            True,
            include_tool_calls=False,
        )
        self.assertIsNotNone(transcript, "text-only path formatted to nothing")
        self.assertGreaterEqual(
            len(transcript),
            self.MIN_TRANSCRIPT_CHARS,
            f"text-only transcript is only {len(transcript)} chars — below the "
            f"{self.MIN_TRANSCRIPT_CHARS}-char floor",
        )
        self.assertGreater(count, 0)
        # The prose is what carries; the tool traffic is what went.
        self.assertIn("never traverse the semantic dedup", transcript)
        self.assertNotIn("grep -rn dedup", transcript)

    def test_text_only_is_materially_smaller_than_json_form(self):
        msgs = self._representative_messages()
        text_form, _ = prepare_retention_transcript(
            msgs, ["user", "assistant"], True, include_tool_calls=False
        )
        json_form, _ = prepare_retention_transcript(
            msgs, ["user", "assistant"], True, include_tool_calls=True
        )
        self.assertLess(len(text_form), len(json_form) / 5)


if __name__ == "__main__":
    unittest.main()
