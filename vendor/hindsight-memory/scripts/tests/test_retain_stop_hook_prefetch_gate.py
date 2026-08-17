"""M4 P-WIRE — retain.py's own Stop-hook entrypoint must not double-retain
when `prefetch.py` (the new Stop-hook entry, hooks/hooks.json) is already
doing a delta retain every turn for this agent.

Outcome asserted: with `memoryPrefetchEnabled` on, `retain.main()` must NOT
reach `run_retain` at all this turn (transport-level: the daemon fake
receives zero retain calls). With the flag off (every agent today, the
default), `retain.main()` is untouched — proven against the SAME assertion
inverted, so a future accidental regression of the gate (always skipping)
would fail this file too.
"""

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import retain  # noqa: E402
from lib.client import HindsightClient  # noqa: E402


class FakeDaemon:
    def __init__(self):
        self.retain_calls = 0

    def retain(self, *a, **kw):
        self.retain_calls += 1
        return {"status": "ok"}


class StopHookPrefetchGateBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hs-m4-stopgate-")
        self.plugin_root = os.path.join(self.tmp, "plugin_root")
        self.home = os.path.join(self.tmp, "home")
        self.data = os.path.join(self.tmp, "data")
        for d in (self.plugin_root, self.home, self.data):
            os.makedirs(d)

        self.transcript_path = os.path.join(self.tmp, "t.jsonl")
        with open(self.transcript_path, "w", encoding="utf-8") as f:
            f.write(json.dumps({"role": "user", "content": "hello", "uuid": "u0"}) + "\n")
            f.write(json.dumps({"role": "assistant", "content": "hi", "uuid": "a0"}) + "\n")

        self.env = mock.patch.dict(os.environ, {
            "CLAUDE_PLUGIN_ROOT": self.plugin_root,
            "CLAUDE_PLUGIN_DATA": self.data,
            "HOME": self.home,
        }, clear=False)
        self.env.start()

        self.daemon = FakeDaemon()
        self._patches = [
            mock.patch.object(HindsightClient, "retain", self.daemon.retain),
            mock.patch("retain.get_api_url", return_value="http://fake"),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self.env.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_settings(self, prefetch_enabled: bool):
        settings = {
            "autoRetain": True,
            "bankId": "test-bank",
            "retainMode": "chunked",
            "retainEveryNTurns": 1,
            "retainOverlapTurns": 0,
            "memoryPrefetchEnabled": prefetch_enabled,
        }
        with open(os.path.join(self.plugin_root, "settings.json"), "w") as f:
            json.dump(settings, f)

    def _run_main(self):
        hook_input = {"session_id": "s1", "transcript_path": self.transcript_path, "cwd": "/tmp"}
        with mock.patch("sys.stdin", io.StringIO(json.dumps(hook_input))):
            retain.main()


class PrefetchEnabledSkipsOwnRetainTests(StopHookPrefetchGateBase):
    def test_flag_on_the_stop_hooks_own_retain_never_fires(self):
        self._write_settings(prefetch_enabled=True)
        self._run_main()
        self.assertEqual(self.daemon.retain_calls, 0,
                          "retain.py's own Stop-hook retain must be skipped when prefetch.py owns retaining")


class PrefetchDisabledIsByteIdenticalTests(StopHookPrefetchGateBase):
    def test_flag_off_the_stop_hooks_own_retain_runs_as_before(self):
        self._write_settings(prefetch_enabled=False)
        self._run_main()
        self.assertEqual(self.daemon.retain_calls, 1,
                          "the default (flag off) path must retain exactly as it did pre-M4")


if __name__ == "__main__":
    unittest.main()
