"""SessionStart Mode-1 reachability gate before drain (#1094 item 1).

get_api_url() returns a configured external ``hindsightApiUrl`` WITHOUT
probing it. Before this fix, session_start would then drain the
pending-retains queue against a down external server, bumping attempt
counters on otherwise-healthy entries until the stall guard tripped.
The fix probes via ``HindsightClient.health_check()`` first and skips
the drain when the external server is unreachable.
"""

import io
import json
import os
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts"))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)


def _seed_entry(pending_dir: str, document_id: str = "doc-x", attempt: int = 1) -> str:
    os.makedirs(pending_dir, mode=0o700, exist_ok=True)
    ts_ms = int(time.time() * 1000)
    path = os.path.join(pending_dir, f"{ts_ms}-{document_id}.json")
    payload = {
        "schema": 1,
        "api_url": "http://fake-host:9077",
        "api_token": None,
        "bank_id": "bank-1",
        "content": "user: hi\nassistant: hi back",
        "document_id": document_id,
        "context": "claude-code",
        "metadata": {},
        "tags": None,
        "failed_at": "2026-05-12T00:00:00Z",
        "error_class": "URLError",
        "error_message": "Connection refused",
        "attempt_count": attempt,
    }
    with open(path, "w") as f:
        json.dump(payload, f)
    return path


class SessionStartDrainGateTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="hindsight-session-start-test-")
        self._plugin_root = os.path.join(self._tmp, "plugin_root")
        self._pending = os.path.join(self._tmp, "pending-retains")
        self._home = os.path.join(self._tmp, "home")
        os.makedirs(self._plugin_root)
        os.makedirs(self._home)

        settings = {
            "autoRecall": True,
            "autoRetain": True,
            "hindsightApiUrl": "http://fake-host:9077",  # Mode 1
            "bankId": "test-bank",
        }
        with open(os.path.join(self._plugin_root, "settings.json"), "w") as f:
            json.dump(settings, f)

        self._env = patch.dict(
            os.environ,
            {
                "CLAUDE_PLUGIN_ROOT": self._plugin_root,
                "HINDSIGHT_PENDING_DIR": self._pending,
                "HOME": self._home,
            },
            clear=False,
        )
        self._env.start()
        for k in list(os.environ):
            if k.startswith("HINDSIGHT_") and k != "HINDSIGHT_PENDING_DIR":
                os.environ.pop(k, None)
        for n in ("session_start", "drain_pending", "lib.pending", "lib.client"):
            sys.modules.pop(n, None)

    def tearDown(self):
        self._env.stop()
        import shutil

        shutil.rmtree(self._tmp, ignore_errors=True)
        for n in ("session_start", "drain_pending", "lib.pending", "lib.client"):
            sys.modules.pop(n, None)

    def _run(self):
        stdin_data = io.StringIO(json.dumps({"source": "startup"}))
        import session_start as mod

        with patch("sys.stdin", stdin_data):
            mod.main()

    def test_mode1_down_server_skips_drain_no_attempt_bump(self):
        path = _seed_entry(self._pending, attempt=1)

        with (
            patch("lib.client.HindsightClient.health_check", return_value=False),
            patch("drain_pending.drain") as drained,
        ):
            self._run()

        drained.assert_not_called()
        # Attempt counter must be untouched.
        with open(path) as f:
            self.assertEqual(json.load(f)["attempt_count"], 1)

    def test_mode1_down_probe_is_single_attempt_no_retry_sleeps(self):
        # #3059 review finding: against a HUNG external server the
        # default 3-retry health_check costs ~10s (3 timeouts + 2*2s
        # sleeps) inside the 5s SessionStart hook. The gate must issue
        # exactly ONE probe attempt and never sleep between retries.
        _seed_entry(self._pending, attempt=1)

        calls = {"urlopen": 0}

        def hang_timeout(*a, **kw):
            calls["urlopen"] += 1
            raise TimeoutError("simulated hung server")

        started = time.monotonic()
        with (
            patch("urllib.request.urlopen", side_effect=hang_timeout),
            patch(
                "time.sleep",
                side_effect=AssertionError("gate must not sleep between retries"),
            ),
            patch("drain_pending.drain") as drained,
        ):
            self._run()
        elapsed = time.monotonic() - started

        self.assertEqual(calls["urlopen"], 1)
        drained.assert_not_called()
        # No real network, no retry sleeps -> effectively instant.
        self.assertLess(elapsed, 3.0)

    def test_mode1_healthy_server_runs_drain(self):
        _seed_entry(self._pending, attempt=1)

        with (
            patch("lib.client.HindsightClient.health_check", return_value=True),
            patch("drain_pending.drain", return_value={}) as drained,
        ):
            self._run()

        drained.assert_called_once()


if __name__ == "__main__":
    unittest.main()
