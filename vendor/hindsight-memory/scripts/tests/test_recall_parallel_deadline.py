"""Switchroom hindsight-leverage PR 3 (workstream A3 stage 2) — parallel
multi-bank recall under one shared deadline.

Acceptance guarantees (epic #3430 exit-criterion 1 fallback: stub-timing
acceptance tests that prove a slow bank cannot breach the hook ceiling):

  1. **A slow bank cannot breach the ceiling.** With a bank stubbed to sleep far
     past the shared deadline, `recall.main()` returns in ~deadline (NOT
     ~sleep), the fast banks' memories still arrive, and the straggler is
     recorded `timed_out=True` / `deadline_hit=True` — the finalized deadline
     semantics (a deadline-abandoned straggler counts, even though it never
     raised a timeout error, which the PR-1 interim per-bank-only form could
     not express).

  2. **Latency is the slowest slot, not the sum.** Three banks each sleeping S
     complete in ~S wall-clock, not ~3S — the whole point of the fan-out.

  3. **The directives slot is dedicated + composes with the A4 cache.** A slow
     directives fetch is abandoned at the deadline (empty directives, no crash)
     while bank memories still inject; a fast directives fetch runs concurrently
     with the banks.

  4. **Env-gated rollback.** `HINDSIGHT_RECALL_PARALLEL=false` (or
     `recallParallel: False`) restores the serial path — `recall_mode="serial"`,
     `deadline_budget_ms=None`, results still merged.

  5. **The `run_parallel` primitive** classifies completed vs deadline-abandoned
     slots correctly and bounds total wait by the shared deadline with daemon
     threads.

Stdlib-only (unittest + threading); runs under
``python3 -m unittest discover tests/`` from ``scripts/``.
"""

import io
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import recall  # noqa: E402
from lib.parallel_recall import run_parallel  # noqa: E402

BARE = "what did we decide about the auth flow last week"


def _memory(text, mem_id=None):
    out = {"text": text, "type": "fact", "mentioned_at": "2026-01-01"}
    if mem_id is not None:
        out["id"] = mem_id
    return out


class _SleepyClient:
    """Fake HindsightClient with per-bank sleep + result control.

    ``bank_sleep``  : {bank_id: seconds} — how long recall() blocks for a bank.
    ``bank_results``: {bank_id: [memory, ...]} — what recall() returns.
    ``directives_sleep`` / ``directives`` — for the directives slot.
    Sleeps are real (threading), so wall-clock timing assertions exercise the
    genuine daemon-thread fan-out rather than a mocked clock.
    """

    def __init__(self, bank_sleep=None, bank_results=None, directives=None,
                 directives_sleep=0.0):
        self._bank_sleep = bank_sleep or {}
        self._bank_results = bank_results or {}
        self._directives = directives or []
        self._directives_sleep = directives_sleep
        self._lock = threading.Lock()
        self.recall_calls = []  # bank_ids, in call order (thread-safe append)

    def list_directives(self, bank_id, active_only=True, timeout=2):
        if self._directives_sleep:
            time.sleep(self._directives_sleep)
        return {"items": list(self._directives)}

    def recall(self, bank_id, query, **kwargs):
        with self._lock:
            self.recall_calls.append(bank_id)
        sleep_s = self._bank_sleep.get(bank_id, 0.0)
        if sleep_s:
            time.sleep(sleep_s)
        return {"results": list(self._bank_results.get(bank_id, []))}


class _RaisingClient(_SleepyClient):
    """A client whose named bank raises a supplied exception."""

    def __init__(self, raise_for=None, **kw):
        super().__init__(**kw)
        self._raise_for = raise_for or {}

    def recall(self, bank_id, query, **kwargs):
        with self._lock:
            self.recall_calls.append(bank_id)
        exc = self._raise_for.get(bank_id)
        if exc is not None:
            raise exc
        return super().recall(bank_id, query, **kwargs)


class _MainHarness(unittest.TestCase):
    """Runs recall.main() with a fake client and an isolated recall log."""

    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="recall-parallel-test-")
        self._prev = os.environ.get("CLAUDE_PLUGIN_DATA")
        os.environ["CLAUDE_PLUGIN_DATA"] = self._tmpdir

    def tearDown(self):
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

    def _run(self, client, config_extra=None, prompt=BARE):
        hook_input = {
            "prompt": prompt,
            "session_id": "test-session",
            "transcript_path": "",
            "cwd": "/tmp",
        }
        config = {
            "autoRecall": True,
            "bankId": "own-bank",
            "recallMaxTokens": 1024,
            "recallBudget": "mid",
            "recallContextTurns": 1,
            "recallMaxQueryChars": 800,
            "recallPromptPreamble": "",
        }
        if config_extra:
            config.update(config_extra)
        stdout = io.StringIO()
        stderr = io.StringIO()
        started = time.monotonic()
        with patch.object(recall, "load_config", return_value=config), patch.object(
            recall, "get_api_url", return_value="http://localhost:18888"
        ), patch.object(recall, "HindsightClient", return_value=client), patch.object(
            recall, "ensure_bank_mission", return_value=None
        ), patch.object(recall, "write_state", return_value=None), patch(
            "sys.stdin", new=io.StringIO(json.dumps(hook_input))
        ), patch("sys.stdout", new=stdout), patch("sys.stderr", new=stderr):
            recall.main()
        elapsed = time.monotonic() - started
        raw = stdout.getvalue()
        context = None
        if raw.strip():
            context = json.loads(raw)["hookSpecificOutput"]["additionalContext"]
        return context, elapsed


class SlowBankCannotBreachCeiling(_MainHarness):
    def test_straggler_bank_abandoned_at_deadline(self):
        # own-bank fast, shared-bank sleeps 3s — far past the 0.6s deadline.
        client = _SleepyClient(
            bank_sleep={"own-bank": 0.0, "shared-bank": 3.0},
            bank_results={"own-bank": [_memory("own hit", "m-own")]},
        )
        context, elapsed = self._run(
            client,
            config_extra={
                "recallAdditionalBanks": ["shared-bank"],
                "recallParallelDeadlineSeconds": 0.6,
            },
        )
        # Returned in ~deadline, NOT ~3s. Generous upper bound absorbs CI jitter
        # while still proving the straggler did not hold the hook open.
        self.assertLess(
            elapsed, 2.0,
            f"recall breached its deadline (took {elapsed:.2f}s with a 3s bank)",
        )
        # The fast bank's memory still injected.
        self.assertIsNotNone(context)
        self.assertIn("own hit", context)
        # Telemetry: parallel mode, straggler timed_out, deadline_hit True.
        e = self._read_log()[0]
        self.assertEqual(e["recall_mode"], "parallel")
        self.assertEqual(e["deadline_budget_ms"], 600)
        timings = {bt["bank_id"]: bt for bt in e["bank_timings"]}
        self.assertFalse(timings["own-bank"]["timed_out"])
        self.assertTrue(timings["shared-bank"]["timed_out"])
        self.assertTrue(e["deadline_hit"])

    def test_bank_timings_own_bank_first_deterministic(self):
        client = _SleepyClient(
            bank_sleep={"own-bank": 0.2, "b1": 0.0, "b2": 0.0},
            bank_results={"own-bank": [_memory("x", "m1")]},
        )
        self._run(
            client,
            config_extra={
                "recallAdditionalBanks": ["b1", "b2"],
                "recallParallelDeadlineSeconds": 5,
            },
        )
        e = self._read_log()[0]
        order = [bt["bank_id"] for bt in e["bank_timings"]]
        # Own bank is slowest yet listed first — order is config order, not
        # completion order.
        self.assertEqual(order, ["own-bank", "b1", "b2"])


class ParallelLatencyIsSlowestSlot(_MainHarness):
    def test_three_banks_run_concurrently(self):
        s = 0.4
        client = _SleepyClient(
            bank_sleep={"own-bank": s, "b1": s, "b2": s},
            bank_results={"own-bank": [_memory("x", "m1")]},
        )
        _, elapsed = self._run(
            client,
            config_extra={
                "recallAdditionalBanks": ["b1", "b2"],
                "recallParallelDeadlineSeconds": 5,
            },
        )
        # Serial would be ~3*s = 1.2s; parallel is ~s. Assert well under 2*s.
        self.assertLess(
            elapsed, 2 * s,
            f"banks did not run concurrently (took {elapsed:.2f}s for 3x{s}s)",
        )


class DirectivesSlotDedicated(_MainHarness):
    def test_slow_directives_abandoned_banks_still_inject(self):
        client = _SleepyClient(
            bank_sleep={"own-bank": 0.0},
            bank_results={"own-bank": [_memory("bank memory", "m1")]},
            directives=[{"id": "d1", "name": "rule", "content": "always X", "priority": 5}],
            directives_sleep=3.0,  # far past the deadline
        )
        context, elapsed = self._run(
            client,
            config_extra={"recallParallelDeadlineSeconds": 0.6},
        )
        self.assertLess(elapsed, 2.0)
        # Bank memory injected despite the directives slot dying.
        self.assertIsNotNone(context)
        self.assertIn("bank memory", context)
        e = self._read_log()[0]
        self.assertTrue(e["directives_timed_out"])
        self.assertEqual(e["directive_count"], 0)
        self.assertTrue(e["deadline_hit"])

    def test_fast_directives_inject_alongside_banks(self):
        client = _SleepyClient(
            bank_sleep={"own-bank": 0.0},
            bank_results={"own-bank": [_memory("bank memory", "m1")]},
            directives=[{"id": "d1", "name": "rule", "content": "always X", "priority": 5}],
            directives_sleep=0.0,
        )
        context, _ = self._run(client, config_extra={"recallParallelDeadlineSeconds": 5})
        self.assertIsNotNone(context)
        self.assertIn("always X", context)
        e = self._read_log()[0]
        self.assertFalse(e["directives_timed_out"])
        self.assertEqual(e["directive_count"], 1)
        self.assertFalse(e["deadline_hit"])


class RaisedTimeoutStillClassified(_MainHarness):
    def test_raised_timeout_marks_deadline_hit(self):
        # A bank that RAISES socket.timeout (fast fail) is timed_out too — the
        # finalized semantics keep the per-request-timeout signal as well as the
        # abandonment signal.
        client = _RaisingClient(
            raise_for={"shared-bank": socket.timeout("read timed out")},
            bank_results={"own-bank": [_memory("x", "m1")]},
        )
        self._run(
            client,
            config_extra={
                "recallAdditionalBanks": ["shared-bank"],
                "recallParallelDeadlineSeconds": 5,
            },
        )
        e = self._read_log()[0]
        timings = {bt["bank_id"]: bt for bt in e["bank_timings"]}
        self.assertTrue(timings["shared-bank"]["timed_out"])
        self.assertFalse(timings["own-bank"]["timed_out"])
        self.assertTrue(e["deadline_hit"])

    def test_non_timeout_error_is_not_deadline_hit(self):
        client = _RaisingClient(
            raise_for={"shared-bank": RuntimeError("HTTP 503 from x: boom")},
            bank_results={"own-bank": [_memory("x", "m1")]},
        )
        self._run(
            client,
            config_extra={
                "recallAdditionalBanks": ["shared-bank"],
                "recallParallelDeadlineSeconds": 5,
            },
        )
        e = self._read_log()[0]
        timings = {bt["bank_id"]: bt for bt in e["bank_timings"]}
        self.assertFalse(timings["shared-bank"]["timed_out"])
        self.assertFalse(e["deadline_hit"])


class SerialRollback(_MainHarness):
    def test_rollback_flag_uses_serial_path(self):
        client = _SleepyClient(
            bank_sleep={"own-bank": 0.0, "shared-bank": 0.0},
            bank_results={
                "own-bank": [_memory("own", "m1")],
                "shared-bank": [_memory("shared", "m2")],
            },
        )
        context, _ = self._run(
            client,
            config_extra={
                "recallAdditionalBanks": ["shared-bank"],
                "recallParallel": False,
            },
        )
        self.assertIsNotNone(context)
        e = self._read_log()[0]
        self.assertEqual(e["recall_mode"], "serial")
        self.assertIsNone(e["deadline_budget_ms"])
        self.assertFalse(e["directives_timed_out"])
        # Both banks were queried and merged.
        self.assertEqual(sorted(e["memory_ids"]), ["m1", "m2"])
        self.assertEqual(sorted(client.recall_calls), ["own-bank", "shared-bank"])


class RunParallelPrimitive(unittest.TestCase):
    def test_completed_vs_abandoned_classification(self):
        results = {"v": None}

        def fast():
            return 42

        def slow():
            time.sleep(2.0)
            return "late"

        started = time.monotonic()
        outcomes = run_parallel({"fast": fast, "slow": slow}, deadline_seconds=0.4)
        elapsed = time.monotonic() - started
        # Bounded by the shared deadline, not the 2s slow task.
        self.assertLess(elapsed, 1.5)
        self.assertTrue(outcomes["fast"].completed)
        self.assertEqual(outcomes["fast"].value, 42)
        self.assertIsNone(outcomes["fast"].error)
        self.assertFalse(outcomes["slow"].completed)
        self.assertIsNone(outcomes["slow"].value)
        # elapsed_ms recorded for both (deadline pin for the abandoned one).
        self.assertIsInstance(outcomes["fast"].elapsed_ms, int)
        self.assertIsInstance(outcomes["slow"].elapsed_ms, int)

    def test_raising_task_surfaces_error_not_raise(self):
        def boom():
            raise ValueError("nope")

        outcomes = run_parallel({"boom": boom}, deadline_seconds=1.0)
        self.assertTrue(outcomes["boom"].completed)
        self.assertIsInstance(outcomes["boom"].error, ValueError)
        self.assertIsNone(outcomes["boom"].value)

    def test_workers_are_daemon_threads(self):
        seen = {"daemon": None}

        def check():
            seen["daemon"] = threading.current_thread().daemon

        run_parallel({"c": check}, deadline_seconds=1.0)
        self.assertTrue(seen["daemon"])

    def test_total_wait_bounded_by_deadline_with_many_slow_slots(self):
        def slow():
            time.sleep(2.0)

        tasks = {f"s{i}": slow for i in range(4)}
        started = time.monotonic()
        run_parallel(tasks, deadline_seconds=0.5)
        elapsed = time.monotonic() - started
        # 4 slow slots cost the deadline ONCE (parallel), not 4x.
        self.assertLess(elapsed, 1.5)


if __name__ == "__main__":
    unittest.main()
