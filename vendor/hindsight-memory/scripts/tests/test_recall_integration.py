"""Integration tests for recall.py — block composition + ordering.

Exercises the actual main() flow with stubbed dependencies so we can
verify:
  - The <active_directives> block is emitted ABOVE <hindsight_memories>
  - Empty bank (no directives, no memories) → no output at all
  - Active directives present but no memories → directives block alone
  - Active memories present but no directives → unchanged legacy behavior
  - Recall API failure with directives present → directives still emitted
    (so a recall outage doesn't blind the agent to its own HARD RULES)

Stdlib-only (unittest + mock).
"""

import io
import json
import os
import sys
import unittest
from unittest.mock import patch

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import recall  # noqa: E402


def _directive(name, content, priority=5):
    return {
        "id": f"id-{name}",
        "bank_id": "test-bank",
        "name": name,
        "content": content,
        "priority": priority,
        "is_active": True,
        "tags": [],
    }


def _memory(text, mem_type="fact", mentioned_at="2026-01-01"):
    return {"text": text, "type": mem_type, "mentioned_at": mentioned_at}


class _FakeClient:
    """Stand-in for HindsightClient with configurable responses."""

    def __init__(self, directives=None, memories=None, recall_exc=None, list_exc=None):
        self._directives = directives if directives is not None else []
        self._memories = memories if memories is not None else []
        self._recall_exc = recall_exc
        self._list_exc = list_exc

    def list_directives(self, bank_id, active_only=True, timeout=2):
        if self._list_exc is not None:
            raise self._list_exc
        return {"items": list(self._directives)}

    def recall(self, bank_id, query, max_tokens=1024, budget="mid", types=None, timeout=10):
        if self._recall_exc is not None:
            raise self._recall_exc
        return {"results": list(self._memories)}


def _run_main_with(client, prompt="What is the meaning of life?"):
    """Invoke recall.main with a fake client and capture stdout JSON.

    Returns (additional_context_string_or_None, raw_stdout).
    """
    hook_input = {
        "prompt": prompt,
        "session_id": "test-session",
        "transcript_path": "",
        "cwd": "/tmp",
    }
    config = {
        "autoRecall": True,
        "bankId": "test-bank",
        "recallMaxTokens": 1024,
        "recallBudget": "mid",
        "recallContextTurns": 1,
        "recallMaxQueryChars": 800,
        "recallPromptPreamble": "",
    }

    stdout = io.StringIO()
    stderr = io.StringIO()
    with patch.object(recall, "load_config", return_value=config), patch.object(
        recall, "get_api_url", return_value="http://localhost:18888"
    ), patch.object(recall, "HindsightClient", return_value=client), patch.object(
        recall, "ensure_bank_mission", return_value=None
    ), patch.object(recall, "write_state", return_value=None), patch(
        "sys.stdin", new=io.StringIO(json.dumps(hook_input))
    ), patch("sys.stdout", new=stdout), patch("sys.stderr", new=stderr):
        recall.main()

    raw = stdout.getvalue()
    if not raw.strip():
        return None, raw
    parsed = json.loads(raw)
    return parsed["hookSpecificOutput"]["additionalContext"], raw


class RecallIntegrationTests(unittest.TestCase):
    def test_directives_block_appears_above_memories_block(self):
        client = _FakeClient(
            directives=[_directive("trailer", "End every response with: [VERIFIED]", priority=10)],
            memories=[_memory("user prefers concise answers")],
        )
        ctx, _ = _run_main_with(client)
        self.assertIsNotNone(ctx)
        d_idx = ctx.find("<active_directives>")
        m_idx = ctx.find("<hindsight_memories>")
        self.assertGreaterEqual(d_idx, 0, "active_directives block missing")
        self.assertGreaterEqual(m_idx, 0, "hindsight_memories block missing")
        self.assertLess(d_idx, m_idx, "directives must come before memories")

    def test_empty_bank_emits_no_output(self):
        client = _FakeClient(directives=[], memories=[])
        ctx, raw = _run_main_with(client)
        self.assertIsNone(ctx)
        self.assertEqual(raw.strip(), "")

    def test_directives_only_emits_directives_block_alone(self):
        client = _FakeClient(
            directives=[_directive("trailer", "End every response with: [VERIFIED]", priority=10)],
            memories=[],
        )
        ctx, _ = _run_main_with(client)
        self.assertIsNotNone(ctx)
        self.assertIn("<active_directives>", ctx)
        self.assertNotIn("<hindsight_memories>", ctx)
        self.assertIn("End every response with: [VERIFIED]", ctx)

    def test_memories_only_unchanged_legacy_behavior(self):
        # No directives → block omitted entirely (not an empty wrapper).
        client = _FakeClient(directives=[], memories=[_memory("an old preference")])
        ctx, _ = _run_main_with(client)
        self.assertIsNotNone(ctx)
        self.assertNotIn("<active_directives>", ctx)
        self.assertIn("<hindsight_memories>", ctx)
        self.assertIn("an old preference", ctx)

    def test_recall_failure_with_directives_still_emits_directives(self):
        # A recall API outage must NOT blind the agent to its HARD RULES.
        client = _FakeClient(
            directives=[_directive("trailer", "End every response with: [VERIFIED]", priority=10)],
            memories=[],
            recall_exc=RuntimeError("HTTP 503"),
        )
        ctx, _ = _run_main_with(client)
        self.assertIsNotNone(ctx)
        self.assertIn("<active_directives>", ctx)
        self.assertNotIn("<hindsight_memories>", ctx)

    def test_directives_failure_does_not_kill_recall(self):
        # Symmetric: a list_directives failure must not block the recall
        # block from being emitted.
        client = _FakeClient(
            directives=[],
            memories=[_memory("legacy memory still useful")],
            list_exc=RuntimeError("HTTP 500"),
        )
        ctx, _ = _run_main_with(client)
        self.assertIsNotNone(ctx)
        self.assertIn("<hindsight_memories>", ctx)
        self.assertNotIn("<active_directives>", ctx)

    def test_blocks_separated_by_blank_line(self):
        client = _FakeClient(
            directives=[_directive("rule", "do the thing", priority=5)],
            memories=[_memory("a memory")],
        )
        ctx, _ = _run_main_with(client)
        self.assertIn("</active_directives>\n\n<hindsight_memories>", ctx)


if __name__ == "__main__":
    unittest.main()
