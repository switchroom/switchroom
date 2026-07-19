"""Switchroom hindsight-leverage PR5 — unit tests for subagent_retain.py.

Covers the SubagentStop sidechain retain: transcript resolution (first-class
``agent_transcript_path`` + directory-scan fallback), the volume gate, the
window slice + deterministic dedup id, and the pending-retains enqueue on
failure. Stdlib-only; runs under ``python3 -m unittest discover tests/``.
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


def _sidechain_line(role: str, text: str, uuid: str, is_tool_result: bool = False) -> str:
    """One nested Claude Code sidechain jsonl entry."""
    if is_tool_result:
        content = [{"type": "tool_result", "tool_use_id": "t1", "content": text}]
    else:
        content = text
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


def _write_sidechain(path: str, num_turns: int, chars_per_msg: int = 500) -> None:
    """Write a sidechain jsonl with num_turns human turns of substantive text."""
    lines = []
    for i in range(num_turns):
        body = f"turn {i} " + ("x" * chars_per_msg)
        lines.append(_sidechain_line("user", body, f"u{i}"))
        lines.append(_sidechain_line("assistant", f"did work {i} " + ("y" * chars_per_msg), f"a{i}"))
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


@contextlib.contextmanager
def _lock_acquired(blocking=False):
    yield True


class ResolveSidechainTranscript(unittest.TestCase):
    def test_prefers_agent_transcript_path(self):
        with tempfile.TemporaryDirectory() as d:
            sc = os.path.join(d, "agent-abc.jsonl")
            _write_sidechain(sc, 3)
            got = subagent_retain.resolve_sidechain_transcript(
                {"agent_transcript_path": sc, "transcript_path": "/nope", "session_id": "s"}
            )
            self.assertEqual(got, sc)

    def test_derives_from_session_and_agent_id_when_field_absent(self):
        with tempfile.TemporaryDirectory() as d:
            proj = d
            parent = os.path.join(proj, "sess1.jsonl")
            open(parent, "w").close()
            sub_dir = os.path.join(proj, "sess1", "subagents")
            os.makedirs(sub_dir)
            sc = os.path.join(sub_dir, "agent-XYZ.jsonl")
            _write_sidechain(sc, 2)
            got = subagent_retain.resolve_sidechain_transcript(
                {"transcript_path": parent, "session_id": "sess1", "agent_id": "XYZ"}
            )
            self.assertEqual(got, sc)

    def test_scan_fallback_picks_newest_sidechain_jsonl(self):
        with tempfile.TemporaryDirectory() as d:
            parent = os.path.join(d, "sess1.jsonl")
            open(parent, "w").close()
            sub_dir = os.path.join(d, "sess1", "subagents")
            os.makedirs(sub_dir)
            older = os.path.join(sub_dir, "agent-old.jsonl")
            newer = os.path.join(sub_dir, "agent-new.jsonl")
            _write_sidechain(older, 2)
            _write_sidechain(newer, 2)
            # Make `newer` genuinely newer by mtime.
            os.utime(older, (1000, 1000))
            os.utime(newer, (2000, 2000))
            # No agent_id → must scan and pick newest.
            got = subagent_retain.resolve_sidechain_transcript(
                {"transcript_path": parent, "session_id": "sess1"}
            )
            self.assertEqual(got, newer)

    def test_ignores_non_sidechain_jsonl_in_scan(self):
        with tempfile.TemporaryDirectory() as d:
            parent = os.path.join(d, "sess1.jsonl")
            open(parent, "w").close()
            sub_dir = os.path.join(d, "sess1", "subagents")
            os.makedirs(sub_dir)
            # A non-sidechain file (first line lacks isSidechain).
            plain = os.path.join(sub_dir, "agent-plain.jsonl")
            with open(plain, "w") as f:
                f.write(json.dumps({"type": "user", "message": {"role": "user", "content": "hi"}}) + "\n")
            got = subagent_retain.resolve_sidechain_transcript(
                {"transcript_path": parent, "session_id": "sess1"}
            )
            self.assertEqual(got, "")

    def test_returns_empty_when_nothing_found(self):
        got = subagent_retain.resolve_sidechain_transcript(
            {"transcript_path": "/does/not/exist.jsonl", "session_id": "x"}
        )
        self.assertEqual(got, "")


class VolumeGate(unittest.TestCase):
    def test_counts_human_turns_excluding_tool_results(self):
        msgs = [
            {"role": "user", "content": "real turn 1"},
            {"role": "assistant", "content": "ok"},
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": "x"}]},
            {"role": "user", "content": "real turn 2"},
        ]
        self.assertEqual(subagent_retain.count_human_turns(msgs), 2)

    def test_skip_below_turn_floor(self):
        # 3 turns, plenty of chars → still skipped (turns < 6).
        msgs = []
        for i in range(3):
            msgs.append({"role": "user", "content": "x" * 2000})
            msgs.append({"role": "assistant", "content": "y" * 2000})
        passed, turns, chars = subagent_retain.passes_volume_gate(msgs, CONFIG)
        self.assertFalse(passed)
        self.assertEqual(turns, 3)

    def test_skip_below_char_floor(self):
        # 8 turns but tiny → skipped (chars < 2000).
        msgs = []
        for i in range(8):
            msgs.append({"role": "user", "content": "hi"})
            msgs.append({"role": "assistant", "content": "ok"})
        passed, turns, chars = subagent_retain.passes_volume_gate(msgs, CONFIG)
        self.assertFalse(passed)
        self.assertGreaterEqual(turns, 6)
        self.assertLess(chars, subagent_retain.MIN_NON_TOOL_RESULT_CHARS)

    def test_tool_result_bodies_do_not_count_toward_char_floor(self):
        # 8 turns whose ONLY bulk is tool_result output → below char floor.
        msgs = []
        for i in range(8):
            msgs.append({"role": "user", "content": "go"})
            msgs.append(
                {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "k"},
                        {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}},
                    ],
                }
            )
            msgs.append(
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": "Z" * 5000}]}
            )
        passed, turns, chars = subagent_retain.passes_volume_gate(msgs, CONFIG)
        self.assertFalse(passed)
        self.assertLess(chars, subagent_retain.MIN_NON_TOOL_RESULT_CHARS)

    def test_passes_when_both_floors_met(self):
        msgs = []
        for i in range(7):
            msgs.append({"role": "user", "content": "x" * 400})
            msgs.append({"role": "assistant", "content": "y" * 400})
        passed, turns, chars = subagent_retain.passes_volume_gate(msgs, CONFIG)
        self.assertTrue(passed)


class RunSubagentRetain(unittest.TestCase):
    def _run(self, hook_input):
        captured = {}

        class _Client:
            def __init__(self, *a, **k):
                pass

            def retain(self, **kwargs):
                captured.update(kwargs)
                return {"ok": True}

        with mock.patch("subagent_retain.load_config", return_value=dict(CONFIG)), \
                mock.patch("subagent_retain.get_api_url", return_value="http://x"), \
                mock.patch("subagent_retain.ensure_bank_mission"), \
                mock.patch("subagent_retain.derive_bank_id", return_value="agentbank"), \
                mock.patch("subagent_retain.HindsightClient", _Client), \
                mock.patch("subagent_retain.inflight_lock", _lock_acquired):
            result = subagent_retain.run_subagent_retain(hook_input)
        return result, captured

    def test_substantive_sidechain_retained_with_tags_and_window(self):
        with tempfile.TemporaryDirectory() as d:
            sc = os.path.join(d, "agent-af5.jsonl")
            _write_sidechain(sc, 8, chars_per_msg=400)
            hook_input = {
                "session_id": "parentsess",
                "agent_id": "af5",
                "agent_type": "worker",
                "agent_transcript_path": sc,
                "transcript_path": os.path.join(d, "parentsess.jsonl"),
                "cwd": d,
            }
            result, captured = self._run(hook_input)

        self.assertEqual(result["status"], "ok")
        # Tagged sidechain + parent link.
        self.assertIn("sidechain", captured["tags"])
        self.assertIn("parent_session:parentsess", captured["tags"])
        self.assertIn("agent_type:worker", captured["tags"])
        # Deterministic id in a DISTINCT namespace from parent retains.
        self.assertTrue(captured["document_id"].startswith("parentsess-sub-af5-r"))
        # Process-fact framing header is prepended.
        self.assertIn("extract PROCESS facts", captured["content"])
        # Distinct provenance context.
        self.assertEqual(captured["context"], "claude-code-sidechain")
        self.assertEqual(captured["metadata"]["parent_session_id"], "parentsess")

    def test_document_id_is_stable_across_refires(self):
        with tempfile.TemporaryDirectory() as d:
            sc = os.path.join(d, "agent-af5.jsonl")
            _write_sidechain(sc, 8, chars_per_msg=400)
            hook_input = {
                "session_id": "parentsess",
                "agent_id": "af5",
                "agent_transcript_path": sc,
                "transcript_path": os.path.join(d, "parentsess.jsonl"),
                "cwd": d,
            }
            r1, c1 = self._run(hook_input)
            r2, c2 = self._run(hook_input)
        self.assertEqual(c1["document_id"], c2["document_id"])

    def test_window_capped_at_N_turns(self):
        with tempfile.TemporaryDirectory() as d:
            sc = os.path.join(d, "agent-af5.jsonl")
            # More than the window: 50 turns, window is 40.
            _write_sidechain(sc, 50, chars_per_msg=60)
            hook_input = {
                "session_id": "parentsess",
                "agent_id": "af5",
                "agent_transcript_path": sc,
                "transcript_path": os.path.join(d, "parentsess.jsonl"),
                "cwd": d,
            }
            result, captured = self._run(hook_input)
        self.assertEqual(result["status"], "ok")
        content = captured["content"]
        # The last turn (49) must be present; an early dropped turn (0) absent.
        self.assertIn("turn 49", content)
        self.assertNotIn("turn 0 ", content)

    def test_volume_gate_skips_trivial_fork_no_retain(self):
        with tempfile.TemporaryDirectory() as d:
            sc = os.path.join(d, "agent-tiny.jsonl")
            _write_sidechain(sc, 2, chars_per_msg=5)  # 2 turns, tiny
            hook_input = {
                "session_id": "parentsess",
                "agent_id": "tiny",
                "agent_transcript_path": sc,
                "transcript_path": os.path.join(d, "parentsess.jsonl"),
                "cwd": d,
            }
            result, captured = self._run(hook_input)
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["reason"], "volume gate")
        self.assertEqual(captured, {})  # nothing posted

    def test_no_transcript_skips(self):
        result, captured = self._run(
            {"session_id": "s", "agent_id": "a", "transcript_path": "/no/where.jsonl"}
        )
        self.assertEqual(result["status"], "skipped")

    def test_lock_busy_returns_failed_payload_for_enqueue(self):
        @contextlib.contextmanager
        def _busy(blocking=False):
            yield False

        with tempfile.TemporaryDirectory() as d:
            sc = os.path.join(d, "agent-af5.jsonl")
            _write_sidechain(sc, 8, chars_per_msg=400)
            hook_input = {
                "session_id": "parentsess",
                "agent_id": "af5",
                "agent_transcript_path": sc,
                "transcript_path": os.path.join(d, "parentsess.jsonl"),
                "cwd": d,
            }
            with mock.patch("subagent_retain.load_config", return_value=dict(CONFIG)), \
                    mock.patch("subagent_retain.get_api_url", return_value="http://x"), \
                    mock.patch("subagent_retain.ensure_bank_mission"), \
                    mock.patch("subagent_retain.derive_bank_id", return_value="agentbank"), \
                    mock.patch("subagent_retain.HindsightClient"), \
                    mock.patch("subagent_retain.inflight_lock", _busy):
                result = subagent_retain.run_subagent_retain(hook_input)
        self.assertEqual(result["status"], "failed")
        self.assertIsNotNone(result["payload"])
        # Payload is enqueue-shaped (matches lib.pending expectations).
        for k in ("bank_id", "content", "document_id", "context", "metadata", "tags"):
            self.assertIn(k, result["payload"])


class HookRegistration(unittest.TestCase):
    def test_subagentstop_registered_in_plugin_hooks_json(self):
        hooks_path = os.path.abspath(
            os.path.join(SCRIPTS_DIR, "..", "hooks", "hooks.json")
        )
        with open(hooks_path) as f:
            hooks = json.load(f)
        self.assertIn("SubagentStop", hooks["hooks"])
        entry = hooks["hooks"]["SubagentStop"][0]["hooks"][0]
        self.assertIn("subagent_retain.py", entry["command"])
        self.assertTrue(entry.get("async"))
        self.assertEqual(entry.get("timeout"), 15)


if __name__ == "__main__":
    unittest.main()
