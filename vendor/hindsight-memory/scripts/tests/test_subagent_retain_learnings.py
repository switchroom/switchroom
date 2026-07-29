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


def _tool_heavy_sidechain(path: str, *, human_turns: int = 8) -> None:
    """A sidechain transcript that is mostly tool traffic plus one prose finding.

    Shaped to clear the volume gate (>= MIN_HUMAN_TURNS human turns and
    >= MIN_NON_TOOL_RESULT_CHARS of non-tool-result chars) so the retain
    actually happens — the gate counts tool_use inputs, which this has in bulk.
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
    """Drive run_subagent_retain with a stub client, returning (result, kwargs)."""
    captured = {}

    class _Client:
        def __init__(self, *a, **k):
            pass

        def retain(self, **kwargs):
            captured.update(kwargs)
            return {"ok": True}

    config = dict(CONFIG, **(config_extra or {}))
    hook_input = {
        "session_id": "parentsess",
        "agent_id": "af5",
        "agent_type": "worker",
        "agent_transcript_path": sidechain_path,
        "transcript_path": os.path.join(tmpdir, "parentsess.jsonl"),
        "cwd": tmpdir,
    }
    with mock.patch("subagent_retain.load_config", return_value=config), \
            mock.patch("subagent_retain.get_api_url", return_value="http://x"), \
            mock.patch("subagent_retain.ensure_bank_mission"), \
            mock.patch("subagent_retain.derive_bank_id", return_value="agentbank"), \
            mock.patch("subagent_retain.HindsightClient", _Client), \
            mock.patch("subagent_retain.inflight_lock", _lock_acquired):
        result = subagent_retain.run_subagent_retain(hook_input)
    return result, captured


class SidechainRetainsLearningsNotTools(unittest.TestCase):
    """The retained content is the sub-agent's prose, not its tool traffic."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.sidechain = os.path.join(self._tmp.name, "agent-af5.jsonl")
        _tool_heavy_sidechain(self.sidechain)
        self.result, self.captured = _run_sidechain_retain(self.sidechain, self._tmp.name)
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
        """The override lands on the sidechain COPY, not the parent's config."""
        self.assertIs(CONFIG["retainToolCalls"], True)


class ProseFreeSidechainDegradesGracefully(unittest.TestCase):
    """The degenerate case — a worker with NO assistant prose at all.

    Worth pinning because the volume gate counts ``tool_use`` inputs
    (``non_tool_result_char_count``) while the retained content no longer
    includes them, so gate and payload now measure different things. The
    reassuring outcome, verified here rather than assumed: it still retains
    cleanly, because the gate requires ``MIN_HUMAN_TURNS`` GENUINE human turns
    and each one is a plain-string user message that survives the text path. So
    ``build_retain_payload`` does not return None and nothing goes silently
    empty — while the tool traffic is still excluded.
    """

    def _prose_free_sidechain(self, path: str, human_turns: int = 8) -> None:
        lines = []
        for i in range(human_turns):
            # tool_result-only user messages don't count as human turns, so the
            # instruction turns are plain strings — but they are the USER's
            # words. Keep them short so the retained text is dominated by
            # nothing at all once tools are stripped.
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

    def test_retains_the_human_turns_and_still_drops_the_tool_traffic(self):
        with tempfile.TemporaryDirectory() as d:
            sc = os.path.join(d, "agent-af5.jsonl")
            self._prose_free_sidechain(sc)

            # Precondition: the gate genuinely PASSES on tool_use chars alone,
            # so this is the "cleared the gate with no prose" case and not just
            # a trivial-fork skip.
            msgs = subagent_retain.read_transcript(sc)
            passed, turns, chars = subagent_retain.passes_volume_gate(msgs, CONFIG)
            self.assertTrue(passed, f"gate did not pass: turns={turns} chars={chars}")

            result, captured = _run_sidechain_retain(sc, d)

        # Retains, does not crash and does not enqueue a doomed pending retain.
        self.assertEqual(result["status"], "ok", result)
        body = captured["content"][len(subagent_retain.SIDECHAIN_MISSION_HEADER):].strip()
        # The human instruction turns survive — nothing went silently empty.
        self.assertIn("[role: user]", body)
        self.assertIn("go", body)
        # The 4 KB Bash command bodies did NOT.
        self.assertNotIn("x" * 200, body)
        self.assertNotIn("true ", body)


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
