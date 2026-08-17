"""Memory v2 M5 — Surface B: orientation-at-boot (hook wiring).

End-to-end tests for orientation.py's run() — the SessionStart hook entry.
Every assertion is an OUTCOME (what reached stdout / whether a refresh was
requested / that boot was never blocked), not a call-path spy, so reverting the
fix it guards turns the test RED (carve-M5 §8 tautology-guard discipline).

Coverage:
  T2  DARK by default: memoryOrientationEnabled off is a HARD no-op — no
      stdout, no bank resolve, no network call (the red-team kill switch).
  T2  Every failure path (server unreachable, no model, read error, empty
      payload, degraded/undated model) degrades to a VISIBLE cold notice AND
      enqueues a refresh AND never raises — boot is never blocked.
  T3  A stale (1.5x-3x) model is injected WITH a visible prefix; a fresh model
      is injected plainly; a degraded (>3x) model is NOT injected.
  T4  Matcher-less re-fire: a "compact" SessionStart produces the SAME output
      as "startup" (the free post-compaction re-seat — E-88).
  main() always exits 0 (a non-zero SessionStart hook BLOCKS the turn).

Stdlib-only.
"""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from unittest import mock

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import orientation  # noqa: E402


def _iso_hours_ago(hours):
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()


class _FakeClient:
    """Stand-in for HindsightClient. Records the OUTCOME the hook depends on:
    which bank was read, and returns scripted list/get responses (or raises)."""

    def __init__(self, models=None, model_full=None, list_raises=None, get_raises=None):
        self._models = models if models is not None else {"items": []}
        self._full = model_full
        self._list_raises = list_raises
        self._get_raises = get_raises
        self.listed_bank = None
        self.got = None

    def list_mental_models(self, bank_id, timeout=5):
        self.listed_bank = bank_id
        if self._list_raises:
            raise self._list_raises
        return self._models

    def get_mental_model(self, bank_id, model_id, detail="full", timeout=5):
        self.got = (bank_id, model_id)
        if self._get_raises:
            raise self._get_raises
        return self._full


def _run(config, hook_input=None, client=None, api_raises=None):
    """Drive orientation.run() with patched I/O; return (stdout_str, client)."""
    hook_input = hook_input or {"source": "startup"}
    buf = io.StringIO()
    with mock.patch.object(orientation, "derive_bank_id", return_value="klanker"), \
         mock.patch.object(orientation, "HindsightClient", return_value=client):
        if api_raises is not None:
            api_ctx = mock.patch.object(orientation, "get_api_url", side_effect=api_raises)
        else:
            api_ctx = mock.patch.object(
                orientation, "get_api_url", return_value="http://127.0.0.1:18888"
            )
        with api_ctx, redirect_stdout(buf):
            orientation.run(hook_input, config)
    return buf.getvalue(), client


def _emitted_context(stdout_str):
    """Parse the additionalContext out of the hook's stdout envelope, or None."""
    stdout_str = stdout_str.strip()
    if not stdout_str:
        return None
    payload = json.loads(stdout_str)
    return payload["hookSpecificOutput"]["additionalContext"]


class _RefreshSpyMixin:
    """Point HINDSIGHT_STATE_DIR at a tmpdir so enqueue_refresh's JSONL marker is
    inspectable — the OUTCOME 'a refresh was requested' without a live scheduler."""

    def setUp(self):
        self._tmp = tempfile.mkdtemp()
        self._env = mock.patch.dict(os.environ, {"HINDSIGHT_STATE_DIR": self._tmp})
        self._env.start()

    def tearDown(self):
        self._env.stop()
        import shutil
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _refresh_requested(self):
        marker = os.path.join(self._tmp, "orientation-refresh-pending.jsonl")
        if not os.path.exists(marker):
            return False
        with open(marker) as f:
            return any(line.strip() for line in f)


ENABLED = {"memoryOrientationEnabled": True, "memoryOrientationCadenceHours": 48}


class TestDarkByDefault(_RefreshSpyMixin, unittest.TestCase):
    """T2 — the kill switch. Off (the default) is a hard, silent no-op."""

    def test_disabled_emits_nothing_and_never_touches_client(self):
        client = _FakeClient()
        # A client whose methods would blow up if called — proves no I/O happens.
        client.list_mental_models = mock.Mock(side_effect=AssertionError("must not read"))
        stdout, _ = _run({"memoryOrientationEnabled": False}, client=client)
        self.assertEqual(stdout.strip(), "")
        self.assertFalse(self._refresh_requested())

    def test_absent_flag_defaults_to_off(self):
        # A stripped/absent value must fail to OFF (fail-safe).
        client = _FakeClient()
        client.list_mental_models = mock.Mock(side_effect=AssertionError("must not read"))
        stdout, _ = _run({}, client=client)
        self.assertEqual(stdout.strip(), "")


class TestColdPaths(_RefreshSpyMixin, unittest.TestCase):
    """T2 — every failure degrades to a visible cold notice + refresh, never a block."""

    def _assert_cold(self, stdout):
        ctx = _emitted_context(stdout)
        self.assertIsNotNone(ctx)
        self.assertIn("not yet built or refreshed", ctx)
        self.assertTrue(self._refresh_requested())

    def test_server_unreachable(self):
        stdout, _ = _run(ENABLED, client=None, api_raises=RuntimeError("no daemon"))
        self._assert_cold(stdout)

    def test_no_model_named_orientation(self):
        client = _FakeClient(models={"items": [{"id": "x", "name": "something-else"}]})
        stdout, _ = _run(ENABLED, client=client)
        self._assert_cold(stdout)

    def test_list_models_raises(self):
        client = _FakeClient(list_raises=TimeoutError("read timed out"))
        stdout, _ = _run(ENABLED, client=client)
        self._assert_cold(stdout)

    def test_model_read_raises(self):
        client = _FakeClient(
            models={"items": [{"id": "m1", "name": "orientation"}]},
            get_raises=TimeoutError("read timed out"),
        )
        stdout, _ = _run(ENABLED, client=client)
        self._assert_cold(stdout)

    def test_empty_content(self):
        client = _FakeClient(
            models={"items": [{"id": "m1", "name": "orientation"}]},
            model_full={"content": "   ", "last_refreshed_at": _iso_hours_ago(1)},
        )
        stdout, _ = _run(ENABLED, client=client)
        self._assert_cold(stdout)

    def test_degraded_model_not_injected(self):
        # Refreshed 200h ago at cadence 48 -> >3x -> degraded -> cold, never
        # presented stale-as-fresh.
        client = _FakeClient(
            models={"items": [{"id": "m1", "name": "orientation"}]},
            model_full={"content": "# Real\nbody", "last_refreshed_at": _iso_hours_ago(200)},
        )
        stdout, _ = _run(ENABLED, client=client)
        self._assert_cold(stdout)

    def test_undated_model_not_injected(self):
        client = _FakeClient(
            models={"items": [{"id": "m1", "name": "orientation"}]},
            model_full={"content": "# Real\nbody", "last_refreshed_at": None},
        )
        stdout, _ = _run(ENABLED, client=client)
        self._assert_cold(stdout)


class TestInjectPaths(_RefreshSpyMixin, unittest.TestCase):
    """T3 — usable models are injected; fresh plainly, stale with a prefix."""

    def test_fresh_model_injected_plainly(self):
        client = _FakeClient(
            models={"items": [{"id": "m1", "name": "orientation"}]},
            model_full={"content": "# Brief\nthe orientation body",
                        "last_refreshed_at": _iso_hours_ago(2)},
        )
        stdout, _ = _run(ENABLED, client=client)
        ctx = _emitted_context(stdout)
        self.assertIn("the orientation body", ctx)
        self.assertNotIn("may be stale", ctx)
        # A usable inject does NOT request a refresh.
        self.assertFalse(self._refresh_requested())
        # It read the agent's OWN bank.
        self.assertEqual(client.listed_bank, "klanker")

    def test_stale_model_injected_with_prefix(self):
        # 100h ago at cadence 48 -> 1.5x(72) < 100 < 3x(144) -> stale.
        client = _FakeClient(
            models={"items": [{"id": "m1", "name": "orientation"}]},
            model_full={"content": "# Brief\nthe orientation body",
                        "last_refreshed_at": _iso_hours_ago(100)},
        )
        stdout, _ = _run(ENABLED, client=client)
        ctx = _emitted_context(stdout)
        self.assertIn("the orientation body", ctx)
        self.assertIn("may be stale", ctx)


class TestCompactionReSeat(_RefreshSpyMixin, unittest.TestCase):
    """T4 — matcher-less: a compaction SessionStart re-seats identically to startup."""

    def _model(self):
        return {"items": [{"id": "m1", "name": "orientation"}]}, {
            "content": "# Brief\nbody text", "last_refreshed_at": _iso_hours_ago(2)
        }

    def test_compact_source_matches_startup_source(self):
        models, full = self._model()
        out_start, _ = _run(ENABLED, hook_input={"source": "startup"},
                            client=_FakeClient(models=models, model_full=full))
        out_compact, _ = _run(ENABLED, hook_input={"source": "compact"},
                             client=_FakeClient(models=models, model_full=full))
        self.assertEqual(_emitted_context(out_start), _emitted_context(out_compact))
        self.assertIn("body text", _emitted_context(out_compact))


class TestNeverBlocksBoot(unittest.TestCase):
    """The script must exit 0 on every path — a non-zero SessionStart hook BLOCKS
    the turn in Claude Code. Driven as a real subprocess (the actual __main__
    guard), because that guard is exactly what turns an internal raise into a
    clean exit; an in-process patch of sys.exit could never catch a regression
    where the guard itself is removed."""

    def _run_script(self, env_extra, stdin_text="{}"):
        import subprocess
        env = dict(os.environ)
        env.update(env_extra)
        script = os.path.join(SCRIPTS_DIR, "orientation.py")
        proc = subprocess.run(
            [sys.executable, script],
            input=stdin_text, capture_output=True, text=True, env=env, timeout=20,
        )
        return proc

    def test_disabled_exits_zero_silent(self):
        proc = self._run_script({"HINDSIGHT_ORIENTATION_ENABLED": "false"})
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "")

    def test_enabled_but_server_unreachable_exits_zero_with_cold_notice(self):
        # Point at a closed port: the read fails, but boot must NOT block — exit
        # 0 and a visible cold notice on stdout, never a hang or non-zero.
        with tempfile.TemporaryDirectory() as tmp:
            proc = self._run_script({
                "HINDSIGHT_ORIENTATION_ENABLED": "true",
                "HINDSIGHT_API_URL": "http://127.0.0.1:9",  # discard port, refused
                "HINDSIGHT_STATE_DIR": tmp,
            })
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("not yet built or refreshed", proc.stdout)


if __name__ == "__main__":
    unittest.main()
