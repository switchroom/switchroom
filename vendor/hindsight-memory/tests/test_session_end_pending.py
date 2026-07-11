"""End-to-end tests for the session_end pending-queue path (#1071).

Covers:
  - retain success → queue stays empty, exit 0
  - retain failure → exactly one entry written, payload faithful, exit non-zero
  - daemon stop still runs even when retain fails
"""

import importlib
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts"))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)


class FakeHTTPResponse:
    """Minimal urlopen() stand-in (mirror of conftest.FakeHTTPResponse —
    inlined so this module is importable under plain unittest)."""

    def __init__(self, data: dict, status: int = 200):
        self.status = status
        self._data = json.dumps(data).encode()

    def read(self):
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def _make_transcript(path: str) -> None:
    """Minimal Claude-Code-format transcript that triggers a real retain."""
    rows = [
        {"type": "user", "message": {"role": "user", "content": "tell me a story"}},
        {"type": "assistant", "message": {"role": "assistant", "content": "Once upon a time..."}},
    ]
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


class SessionEndPendingTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="hindsight-session-end-test-")
        self._plugin_root = os.path.join(self._tmp, "plugin_root")
        self._plugin_data = os.path.join(self._tmp, "plugin_data")
        self._pending = os.path.join(self._tmp, "pending-retains")
        self._home = os.path.join(self._tmp, "home")
        os.makedirs(self._plugin_root)
        os.makedirs(self._plugin_data)
        os.makedirs(self._home)

        # Settings — point at a fake URL the test can intercept.
        settings = {
            "autoRecall": False,
            "autoRetain": True,
            "retainEveryNTurns": 1,
            "hindsightApiUrl": "http://fake-host:9077",
            "bankId": "test-bank",
        }
        with open(os.path.join(self._plugin_root, "settings.json"), "w") as f:
            json.dump(settings, f)

        # Transcript that triggers retain.
        self._transcript = os.path.join(self._tmp, "transcript.jsonl")
        _make_transcript(self._transcript)

        # Env setup.
        self._env_patcher = patch.dict(
            os.environ,
            {
                "CLAUDE_PLUGIN_ROOT": self._plugin_root,
                "CLAUDE_PLUGIN_DATA": self._plugin_data,
                "HINDSIGHT_PENDING_DIR": self._pending,
                "HOME": self._home,
            },
            clear=False,
        )
        self._env_patcher.start()
        # Strip any host HINDSIGHT_* env that would override settings.json.
        for k in list(os.environ):
            if k.startswith("HINDSIGHT_") and k not in (
                "HINDSIGHT_PENDING_DIR",
            ):
                os.environ.pop(k, None)

    def tearDown(self):
        self._env_patcher.stop()
        import shutil

        shutil.rmtree(self._tmp, ignore_errors=True)

    def _run_session_end(self, urlopen_side_effect):
        """Invoke session_end.main() with the given urlopen side-effect.

        Returns ``(exit_code, captured_stderr)``.
        """
        hook_input = {
            "session_id": "sess-1",
            "transcript_path": self._transcript,
            "cwd": self._home,
            "reason": "end",
        }
        stdin_data = io.StringIO(json.dumps(hook_input))
        stderr_capture = io.StringIO()

        # Force a fresh import — module-level state in session_end /
        # retain / lib.* shouldn't leak between tests.
        for mod_name in ("session_end", "retain", "lib.pending", "lib.daemon"):
            sys.modules.pop(mod_name, None)

        import session_end as session_end_mod  # noqa: WPS433

        with (
            patch("sys.stdin", stdin_data),
            patch("sys.stderr", stderr_capture),
            patch("urllib.request.urlopen", side_effect=urlopen_side_effect),
            # daemon.stop_daemon is a no-op when we never started one,
            # but stub it for hermetic-ness.
            patch("session_end.stop_daemon", return_value=None),
        ):
            exit_code = session_end_mod.main()
        return exit_code, stderr_capture.getvalue()

    def test_successful_retain_leaves_queue_empty_and_exits_ok(self):
        ok_response = FakeHTTPResponse({"items": [{"id": "abc"}]})
        exit_code, _ = self._run_session_end(lambda *a, **kw: ok_response)
        self.assertEqual(exit_code, 0)
        # Queue should be empty (dir may not even exist)
        if os.path.isdir(self._pending):
            self.assertEqual([], os.listdir(self._pending))

    def test_retain_http_failure_enqueues_payload_and_exits_nonzero(self):
        # Raise an HTTPError on POST so retain.run_retain catches it
        # and returns status=failed with payload.
        def boom(*a, **kw):
            raise urllib.error.URLError("Connection refused")

        exit_code, stderr = self._run_session_end(boom)
        # exit 1 == EXIT_QUEUED in session_end.py
        self.assertEqual(exit_code, 1)
        self.assertIn("queued to pending-retains", stderr)

        # One entry in the queue
        names = [n for n in os.listdir(self._pending) if n.endswith(".json")]
        self.assertEqual(len(names), 1)

        with open(os.path.join(self._pending, names[0])) as f:
            entry = json.load(f)
        self.assertEqual(entry["bank_id"], "test-bank")
        self.assertEqual(entry["api_url"], "http://fake-host:9077")
        self.assertIn("Once upon a time", entry["content"])
        self.assertEqual(entry["attempt_count"], 1)
        # error_class derives from the original urllib.error.URLError
        self.assertIn("URLError", entry["error_class"])

    def test_retain_failure_without_payload_exits_dropped_not_queued(self):
        # #1094 item 5: when run_retain reports failed but has NO payload
        # to queue (failure before a payload was built), nothing lands in
        # pending-retains — so the exit code must be EXIT_DROPPED (2),
        # not EXIT_QUEUED (1), which would falsely claim it was queued.
        hook_input = {
            "session_id": "sess-1",
            "transcript_path": self._transcript,
            "cwd": self._home,
            "reason": "end",
        }
        stdin_data = io.StringIO(json.dumps(hook_input))
        stderr_capture = io.StringIO()

        for mod_name in ("session_end", "retain", "lib.pending", "lib.daemon"):
            sys.modules.pop(mod_name, None)

        import session_end as session_end_mod  # noqa: WPS433

        def fake_run_retain(hook_input, force=False):
            return {"status": "failed", "error": RuntimeError("url unresolved"), "payload": None}

        with (
            patch("sys.stdin", stdin_data),
            patch("sys.stderr", stderr_capture),
            patch("retain.run_retain", side_effect=fake_run_retain),
            patch("session_end.stop_daemon", return_value=None),
        ):
            exit_code = session_end_mod.main()

        self.assertEqual(exit_code, session_end_mod.EXIT_DROPPED)
        self.assertEqual(exit_code, 2)
        # Nothing should have been written to the queue.
        if os.path.isdir(self._pending):
            self.assertEqual(
                [n for n in os.listdir(self._pending) if n.endswith(".json")], []
            )

    def test_retain_failure_still_runs_daemon_stop(self):
        def boom(*a, **kw):
            raise urllib.error.URLError("nope")

        # If session_end short-circuits before stop_daemon, this test
        # catches the regression. We assert via a spy.
        hook_input = {
            "session_id": "sess-1",
            "transcript_path": self._transcript,
            "cwd": self._home,
            "reason": "end",
        }
        stdin_data = io.StringIO(json.dumps(hook_input))
        stderr_capture = io.StringIO()

        for mod_name in ("session_end", "retain", "lib.pending", "lib.daemon"):
            sys.modules.pop(mod_name, None)

        import session_end as session_end_mod  # noqa: WPS433

        call_log = {"stop_called": 0}

        def fake_stop(config, debug_fn=None):
            call_log["stop_called"] += 1

        with (
            patch("sys.stdin", stdin_data),
            patch("sys.stderr", stderr_capture),
            patch("urllib.request.urlopen", side_effect=boom),
            patch("session_end.stop_daemon", side_effect=fake_stop),
        ):
            session_end_mod.main()

        self.assertEqual(call_log["stop_called"], 1)


if __name__ == "__main__":
    unittest.main()
