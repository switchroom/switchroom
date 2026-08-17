"""M4 P-REC test (e) — cap truncation, OUTCOME test.

epic §M4 TDD plan (e): "candidate sets larger than 8/4096 are truncated at
injection, logged truthfully." The truncation mechanism itself
(``recallMaxMemories`` head-slice / bank-slot reservation, ``recall.py``
~2757-2795) already exists pre-M4; this is the M4-scoped regression guard
that asserts it on RENDERED output and the truthful log row, per the
red-team's "assert on transport/rendered output, not a flag" rule — not
merely that ``capped`` was set internally.

Stdlib-only; drives ``recall.main()`` end to end against a fake client, no
network. Harness mirrors ``tests/test_recall_min_score.py``.
"""

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import recall  # noqa: E402

OWN = "test-bank"


def _memory(text, mem_id, score):
    return {"text": text, "type": "fact", "mentioned_at": "2026-01-01", "id": mem_id,
            "scores": {"final": score}}


class _Client:
    def __init__(self, results):
        self._results = results

    def list_directives(self, bank_id, active_only=True, timeout=2):
        return {"items": []}

    def recall(self, bank_id, query, **kwargs):
        return {"results": [dict(m) for m in self._results]}


class CapTruncationTests(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="recall-cap-test-")
        self._prev = os.environ.get("CLAUDE_PLUGIN_DATA")
        os.environ["CLAUDE_PLUGIN_DATA"] = self._tmpdir

    def tearDown(self):
        shutil.rmtree(self._tmpdir, ignore_errors=True)
        if self._prev is None:
            os.environ.pop("CLAUDE_PLUGIN_DATA", None)
        else:
            os.environ["CLAUDE_PLUGIN_DATA"] = self._prev

    def _log_row(self):
        path = os.path.join(self._tmpdir, "state", "recall_log.jsonl")
        with open(path, encoding="utf-8") as fh:
            rows = [json.loads(line) for line in fh if line.strip()]
        self.assertTrue(rows, "no recall_log row was written")
        return rows[-1]

    def _run(self, n_candidates, max_memories):
        # Distinct scores so ordering (and therefore which 8 survive) is
        # deterministic: candidate 0 highest score .. candidate N-1 lowest.
        results = [
            _memory(f"candidate {i}", f"m{i}", score=1.0 - (i * 0.01))
            for i in range(n_candidates)
        ]
        client = _Client(results)
        hook_input = {
            "prompt": "what do you remember about the deploy pipeline",
            "session_id": "test-session",
            "transcript_path": "",
            "cwd": "/tmp",
        }
        config = {
            "autoRecall": True,
            "bankId": OWN,
            "recallMaxTokens": 4096,
            "recallMaxMemories": max_memories,
            "recallBudget": "mid",
            "recallContextTurns": 1,
            "recallMaxQueryChars": 800,
            "recallPromptPreamble": "",
            "recallParallelDeadlineSeconds": 5,
            "directivesCacheTtlSeconds": 0,
        }
        stdout = io.StringIO()
        with patch("recall.load_config", return_value=config), \
                patch("recall.get_api_url", return_value="http://fake"), \
                patch("recall.HindsightClient", return_value=client), \
                patch("recall.ensure_bank_mission"), \
                patch("sys.stdin", io.StringIO(json.dumps(hook_input))), \
                patch("sys.stdout", stdout):
            recall.main()
        out = stdout.getvalue()
        ctx = None
        if out:
            parsed = json.loads(out)
            ctx = parsed.get("hookSpecificOutput", {}).get("additionalContext")
        return ctx

    def test_candidate_set_above_cap_is_truncated_in_rendered_output(self):
        ctx = self._run(n_candidates=12, max_memories=8)
        self.assertIsNotNone(ctx)
        injected = sum(1 for i in range(12) if f"candidate {i}" in ctx)
        self.assertEqual(injected, 8, "rendered output must contain exactly the cap's worth of memories")

    def test_log_row_reports_capped_true_with_truthful_pre_cap_count(self):
        self._run(n_candidates=12, max_memories=8)
        row = self._log_row()
        self.assertTrue(row["capped"])
        self.assertEqual(row["pre_cap_count"], 12)

    def test_candidate_set_at_or_below_cap_is_not_truncated(self):
        ctx = self._run(n_candidates=8, max_memories=8)
        self.assertIsNotNone(ctx)
        for i in range(8):
            self.assertIn(f"candidate {i}", ctx)
        row = self._log_row()
        self.assertFalse(row["capped"])
        self.assertEqual(row["pre_cap_count"], 8)


if __name__ == "__main__":
    unittest.main()
