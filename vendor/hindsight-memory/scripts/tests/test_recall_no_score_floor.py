"""M4 P-REC test (f) — no score floor applied outside degraded mode.

epic §M4 TDD plan (f): "a regression test asserting no score floor is
applied outside degraded mode (guards against the refused recommendation
sneaking in)." E-13 measured a real rank-1 hit scoring ~0.001 and any floor
emptied 28% of healthy recalls (#3761) — the floor MUST stay scoped to
degraded turns only (``recallMinScoreScope`` default ``"degraded"``).

This is a regression TRIPWIRE, not new behaviour: ``recall.py`` already
scopes the floor correctly (``2731-2735``). Per the red-team audit (Finding:
test (f) leaned on the ``min_score_applied`` flag alone), this asserts on
BOTH the flag AND the rendered injected content — the full candidate set
must actually reach ``additionalContext`` on a healthy turn even when a
floor is configured, so a future "add a real floor" PR that drops rows
while leaving the flag mis-set still fails RED.

Stdlib-only; drives ``recall.main()`` end to end. Reuses the harness shape
from ``tests/test_recall_min_score.py`` (kept in a dedicated M4 file per the
carve's named test-file convention).
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
NOISE = 0.0006  # E-13's measured rank-1-hit-that-scores-almost-zero regime


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


class NoScoreFloorOutsideDegradedTests(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="recall-no-floor-test-")
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
        self.assertTrue(rows)
        return rows[-1]

    def test_healthy_turn_ignores_a_configured_floor_flag_and_rendered_output(self):
        # 6 noise-scoring candidates, a floor set well above their score, own
        # bank answers cleanly (no timeout/error) — a HEALTHY turn.
        results = [_memory(f"noise fact {i}", f"m{i}", NOISE) for i in range(6)]
        client = _Client(results)
        hook_input = {
            "prompt": "what did we decide about the auth flow",
            "session_id": "test-session",
            "transcript_path": "",
            "cwd": "/tmp",
        }
        config = {
            "autoRecall": True,
            "bankId": OWN,
            "recallMaxTokens": 4096,
            "recallMinScore": 0.5,  # configured floor, well above NOISE
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
        self.assertTrue(out)
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]

        # Rendered-output assertion (the redteam-mandated strengthening): the
        # FULL pre-floor candidate set reaches the prompt, not just a flag.
        for i in range(6):
            self.assertIn(f"noise fact {i}", ctx,
                           "a score floor silently dropped a healthy-turn candidate")

        row = self._log_row()
        self.assertFalse(row["min_score_applied"])
        self.assertEqual(row["dropped_below_min_score"], 0)


if __name__ == "__main__":
    unittest.main()
