"""Switchroom recall-latency instrumentation tests.

recall.py is the UserPromptSubmit hook in front of every reply, and until now
its wall time was UNMEASURED: it is a direct plugin hook (not wrapped by
bin/run-hook.sh, so no hook-timings row) and recall_log.jsonl carried no
duration field. These tests lock in the two things this PR added:

  1. Every recall_log row (cache hit AND cache miss) carries a numeric
     `duration_ms` — including a degraded/failed recall.
  2. The hook emits a `hook-timings-<Ddd>.log` line matching bin/run-hook.sh's
     schema, into the same weekday ring, honouring the same env knobs.
  3. The instrumentation NEVER pollutes the hook's stdout contract (the
     recall-context JSON Claude Code consumes is byte-identical).

Stdlib-only (unittest + mock). Reuses the integration harness's fakes.
"""

import io
import json
import os
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)
TESTS_DIR = os.path.abspath(os.path.dirname(__file__))
if TESTS_DIR not in sys.path:
    sys.path.insert(0, TESTS_DIR)

import recall  # noqa: E402
from test_recall_integration import _FakeClient, _memory, _run_main_with  # noqa: E402


class DurationMsInRecallLogTests(unittest.TestCase):
    """recall_log.jsonl rows must carry a numeric `duration_ms`."""

    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="recall-latency-test-")
        self._prev = os.environ.get("CLAUDE_PLUGIN_DATA")
        os.environ["CLAUDE_PLUGIN_DATA"] = self._tmpdir

    def tearDown(self):
        import shutil

        shutil.rmtree(self._tmpdir, ignore_errors=True)
        if self._prev is None:
            os.environ.pop("CLAUDE_PLUGIN_DATA", None)
        else:
            os.environ["CLAUDE_PLUGIN_DATA"] = self._prev

    def _read_log(self):
        path = os.path.join(self._tmpdir, "state", "recall_log.jsonl")
        if not os.path.isfile(path):
            return []
        with open(path, encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    def test_cache_miss_row_has_numeric_duration_ms(self):
        client = _FakeClient(directives=[], memories=[_memory("x", mem_id="x1")])
        _run_main_with(client)
        e = self._read_log()[0]
        self.assertFalse(e["cache_hit"])
        self.assertIn("duration_ms", e)
        self.assertIsInstance(e["duration_ms"], int)
        self.assertGreaterEqual(e["duration_ms"], 0)
        # duration_ms (full hook) must be >= total_elapsed_ms (recall path only):
        # it strictly contains it, so the derived local overhead is never negative.
        self.assertGreaterEqual(e["duration_ms"], e["total_elapsed_ms"])

    def test_degraded_recall_still_records_a_duration(self):
        # The common case right now: the own bank is unreachable. The row must
        # still carry a numeric duration so a slow/failed recall is attributable.
        client = _FakeClient(
            directives=[],
            memories=[],
            recall_exc=RuntimeError("HTTP 503 from http://localhost:18888"),
        )
        _run_main_with(client)
        e = self._read_log()[0]
        self.assertTrue(e["bank_errored"])
        self.assertEqual(e["result_count"], 0)
        self.assertIsInstance(e["duration_ms"], int)
        self.assertGreaterEqual(e["duration_ms"], 0)

    def _run_with_real_state(self, client, prompt):
        """Invoke recall.main WITHOUT stubbing write_state/read_state, so the
        per-session recall cache actually persists to CLAUDE_PLUGIN_DATA and a
        second identical prompt takes the cache-hit path. (The shared
        _run_main_with harness stubs write_state, which disables the cache.)"""
        hook_input = {
            "prompt": prompt,
            "session_id": "cache-session",
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
            "directivesCacheTtlSeconds": 0,
        }
        with patch.object(recall, "load_config", return_value=config), patch.object(
            recall, "get_api_url", return_value="http://localhost:18888"
        ), patch.object(recall, "HindsightClient", return_value=client), patch.object(
            recall, "ensure_bank_mission", return_value=None
        ), patch("sys.stdin", new=io.StringIO(json.dumps(hook_input))), patch(
            "sys.stdout", new=io.StringIO()
        ), patch("sys.stderr", new=io.StringIO()):
            recall.main()

    def test_cache_hit_row_has_numeric_duration_ms(self):
        # Populate the cache, then hit it on a second identical prompt. The
        # cache-hit row must also carry duration_ms (total_elapsed_ms is None
        # there, so duration_ms is the only latency number on a cache hit).
        client = _FakeClient(directives=[], memories=[_memory("x", mem_id="x1")])
        with patch.dict(os.environ, {"HINDSIGHT_RECALL_CACHE_TTL_SECS": "60"}):
            self._run_with_real_state(client, "What did we decide about auth?")
            self._run_with_real_state(client, "What did we decide about auth?")
        rows = self._read_log()
        hit_rows = [r for r in rows if r["cache_hit"]]
        self.assertTrue(hit_rows, "expected at least one cache-hit row")
        e = hit_rows[0]
        self.assertIsNone(e["total_elapsed_ms"])
        self.assertIsInstance(e["duration_ms"], int)
        self.assertGreaterEqual(e["duration_ms"], 0)


class StdoutUnchangedTests(unittest.TestCase):
    """The instrumentation writes only to log files — the hook's stdout
    (the recall-context JSON Claude Code consumes) must be byte-identical."""

    def test_stdout_is_exact_and_carries_no_instrumentation(self):
        client = _FakeClient(directives=[], memories=[_memory("a stored fact")])
        # Pin the clock-derived preamble so the emitted block is deterministic,
        # letting us assert the stdout bytes EXACTLY.
        with patch.object(recall, "format_current_time", return_value="FIXED-TIME"):
            ctx, raw = _run_main_with(client)

        expected_context = (
            "<hindsight_memories>\n"
            "\n"  # empty recallPromptPreamble
            "Current time - FIXED-TIME\n\n"
            + recall.format_memories([_memory("a stored fact")])
            + "\n</hindsight_memories>"
        )
        expected_raw = json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": expected_context,
                }
            }
        )
        self.assertEqual(raw, expected_raw)
        # Belt-and-braces: no instrumentation artifact leaked into the contract.
        self.assertNotIn("duration_ms", raw)
        self.assertNotIn("hook-timings", raw)
        self.assertNotIn("total_elapsed_ms", raw)

    def test_empty_recall_emits_empty_stdout(self):
        # A no-directive, no-memory turn still emits nothing on stdout — the
        # timing line lands in a log file, never here.
        client = _FakeClient(directives=[], memories=[])
        _ctx, raw = _run_main_with(client)
        self.assertEqual(raw.strip(), "")


class HookTimingLogEmissionTests(unittest.TestCase):
    """_emit_hook_timing_log must reproduce bin/run-hook.sh's line schema,
    weekday ring, and env-knob behaviour — the hook-timings row that lets this
    UserPromptSubmit hook show up alongside every wrapped hook."""

    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="hook-timings-test-")

    def tearDown(self):
        import shutil

        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def _logfile(self):
        dow = time.strftime("%a", time.localtime())
        return os.path.join(self._tmpdir, f"hook-timings-{dow}.log")

    def test_emits_line_with_run_hook_schema(self):
        with patch.dict(os.environ, {"SWITCHROOM_HOOK_TIMING_DIR": self._tmpdir}):
            recall._emit_hook_timing_log(142, 0)
        path = self._logfile()
        self.assertTrue(os.path.isfile(path))
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
        self.assertEqual(len(lines), 1)
        row = json.loads(lines[0])
        # Exact key set + types run-hook.sh writes.
        self.assertEqual(
            set(row.keys()), {"ts", "date", "source", "code", "duration_ms", "status"}
        )
        self.assertEqual(row["source"], "hook:hindsight-recall")
        self.assertEqual(row["code"], "recall.py")
        self.assertEqual(row["duration_ms"], 142)
        self.assertEqual(row["status"], 0)
        self.assertEqual(row["date"], time.strftime("%Y-%m-%d", time.localtime()))

    def test_falls_back_to_telegram_state_dir(self):
        with patch.dict(
            os.environ,
            {"TELEGRAM_STATE_DIR": self._tmpdir},
            clear=False,
        ), patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SWITCHROOM_HOOK_TIMING_DIR", None)
            recall._emit_hook_timing_log(5, 0)
        self.assertTrue(os.path.isfile(self._logfile()))

    def test_disabled_by_env(self):
        with patch.dict(
            os.environ,
            {
                "SWITCHROOM_HOOK_TIMING": "0",
                "SWITCHROOM_HOOK_TIMING_DIR": self._tmpdir,
            },
        ):
            recall._emit_hook_timing_log(999, 0)
        self.assertFalse(os.path.isfile(self._logfile()))

    def test_min_ms_filters_fast_invocations(self):
        with patch.dict(
            os.environ,
            {
                "SWITCHROOM_HOOK_TIMING_DIR": self._tmpdir,
                "SWITCHROOM_HOOK_TIMING_MIN_MS": "100",
            },
        ):
            recall._emit_hook_timing_log(50, 0)  # below floor → dropped
            recall._emit_hook_timing_log(150, 0)  # at/above → kept
        with open(self._logfile(), encoding="utf-8") as f:
            rows = [json.loads(x) for x in f if x.strip()]
        self.assertEqual([r["duration_ms"] for r in rows], [150])

    def test_no_dir_is_silent_noop(self):
        # No timing dir and no TELEGRAM_STATE_DIR → nothing written, no raise.
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SWITCHROOM_HOOK_TIMING_DIR", None)
            os.environ.pop("TELEGRAM_STATE_DIR", None)
            recall._emit_hook_timing_log(10, 0)  # must not raise
        self.assertFalse(os.path.isfile(self._logfile()))

    def test_stale_weekday_file_is_reset(self):
        path = self._logfile()
        # Seed the ring file with a line dated a week ago (different date, same
        # weekday) — the emitter must truncate it before appending today's row.
        stale = (
            '{"ts":"2000-01-01T00:00:00+0000","date":"2000-01-01",'
            '"source":"hook:hindsight-recall","code":"recall.py",'
            '"duration_ms":1,"status":0}\n'
        )
        with open(path, "w", encoding="utf-8") as f:
            f.write(stale)
        with patch.dict(os.environ, {"SWITCHROOM_HOOK_TIMING_DIR": self._tmpdir}):
            recall._emit_hook_timing_log(7, 0)
        with open(path, encoding="utf-8") as f:
            rows = [json.loads(x) for x in f if x.strip()]
        # Stale line gone; exactly today's row remains.
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["duration_ms"], 7)
        self.assertEqual(rows[0]["date"], time.strftime("%Y-%m-%d", time.localtime()))


if __name__ == "__main__":
    unittest.main()
