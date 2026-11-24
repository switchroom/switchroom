"""A scheduled run's Linear identity comes from the pinned scheduler's own producers, never env or model input."""
from __future__ import annotations

import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

from linear_fake_api import load_plugin

SOURCE = os.environ.get("HERMES_AGENT_SRC")
GUARDED_ROOT = os.environ.get("HERMES_LINEAR_ORIGIN_TEST_ROOT")
if SOURCE and GUARDED_ROOT:
    sys.path.insert(0, SOURCE)
plugin = load_plugin()
from hermes_fleet_linear_plugin import transport

HOST_BOUND = "native host-bound session"
JOB = {"id": "job123", "name": "eod-sweep"}


@unittest.skipUnless(SOURCE and GUARDED_ROOT, "requires the guarded manifest-pinned origin proof entrypoint")
class ScheduledRunContext(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=GUARDED_ROOT)
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        isolated = {"PATH": os.defpath, "HOME": str(self.home), "HERMES_HOME": str(self.home),
                    "HERMES_AGENT_SRC": SOURCE, "HERMES_LINEAR_ORIGIN_TEST_ROOT": GUARDED_ROOT}
        env = patch.dict(os.environ, isolated, clear=True)
        env.start()
        self.addCleanup(env.stop)
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override
        from gateway.session_context import reset_session_vars
        token = set_hermes_home_override(self.home)
        self.addCleanup(reset_hermes_home_override, token)
        reset_session_vars()
        self.addCleanup(reset_session_vars)

    def scope(self):
        """The session bindings of the scheduler's per-run scope (_CronRunScope), through the same
        Core producers. The scope itself imports the terminal tool stack, which this proof's
        isolated venv does not carry; test_scheduler_scope_contract pins what it binds."""
        from gateway.session_context import set_session_vars, clear_session_vars, _VAR_MAP
        tokens = set_session_vars(platform="", chat_id="", chat_name="", async_delivery=False)
        self.addCleanup(clear_session_vars, tokens)
        cron = _VAR_MAP["HERMES_CRON_SESSION"]
        token = cron.set("1")
        self.addCleanup(cron.reset, token)
        return f"cron:{JOB['id']}:exec456"

    def test_scheduler_scope_contract(self):
        """The pinned scheduler binds exactly what scope() reproduces and enters the execution."""
        source = (Path(str(SOURCE)) / "cron" / "scheduler.py").read_text()
        body = source[source.index("class _CronRunScope"):source.index("def _reload_dotenv_and_publish_delivery_target")]
        for needle in ('set_session_vars(\n            platform="",\n            chat_id="",', "async_delivery=False",
                       'self._cron_session_var = _VAR_MAP["HERMES_CRON_SESSION"]',
                       'self._cron_session_token = self._cron_session_var.set("1")',
                       "self.task_id = f\"cron:{job_id}:{execution_id"):
            self.assertIn(needle, body)
        # A scheduled run never binds a chat route (comments may mention one).
        self.assertFalse(re.search(r"^\s*session_key\s*=", body, re.M))
        self.assertIn("return enter_cron_execution(job, execution_id, record or {})", source)

    def execution(self):
        """The scheduler's real cron execution identity for this fire."""
        from cron.execution_identity import enter_cron_execution, exit_cron_execution
        token = enter_cron_execution(JOB, "exec456", {"source": "builtin"})
        self.addCleanup(exit_cron_execution, token)

    def refused(self):
        with self.assertRaises(transport.Unavailable) as caught:
            transport.capture_context()
        return str(caught.exception)

    def test_scheduler_bound_run_is_this_profiles_cron_identity(self):
        task_id = self.scope()
        self.execution()
        context = transport.capture_context()
        self.assertEqual((context.platform, context.source), ("cron", "cron"))
        self.assertEqual(context.session_key, "cron:job123:exec456")
        self.assertEqual(context.session_key, task_id)  # the scheduler's own run id is the provenance
        self.assertEqual(context.session_id, "exec456")
        self.assertEqual(context.profile, "default")
        self.assertEqual(context.home, str(self.home.resolve()))
        self.assertEqual((context.user_id, context.chat_id, context.thread_id), ("", "", ""))
        self.assertFalse(context.delegated_child)
        self.assertTrue(transport.is_cron(context))
        # The bridge's wire validation accepts the same context unchanged.
        self.assertEqual(transport.NativeContext.from_wire(context.to_wire(), self.home, "default"), context)

    def test_cron_session_marker_without_a_won_execution_is_refused(self):
        self.scope()
        self.assertIn(HOST_BOUND, self.refused())

    def test_execution_without_the_scheduler_session_scope_is_refused(self):
        self.execution()
        self.assertIn(HOST_BOUND, self.refused())

    def test_environment_only_cron_identity_is_refused(self):
        self.execution_env = {"HERMES_CRON_SESSION": "1", "HERMES_SESSION_KEY": "cron:job123:exec456",
                              "HERMES_SESSION_PLATFORM": "cron", "HERMES_SESSION_ID": "exec456"}
        with patch.dict(os.environ, self.execution_env):
            self.assertIn(HOST_BOUND, self.refused())

    def test_delegated_child_of_a_scheduled_run_is_refused(self):
        from agent.delegation_context import delegated_child_context
        self.scope()
        self.execution()
        with delegated_child_context():
            self.assertIn(HOST_BOUND, self.refused())

    def test_run_of_another_profile_is_refused(self):
        from gateway.session_context import _VAR_MAP
        self.scope()
        self.execution()
        token = _VAR_MAP["HERMES_SESSION_PROFILE"].set("other")
        self.addCleanup(_VAR_MAP["HERMES_SESSION_PROFILE"].reset, token)
        self.assertIn("another profile", self.refused())

    def test_bound_chat_session_keeps_its_own_identity(self):
        from gateway.session_context import set_session_vars, clear_session_vars
        self.execution()  # a chat turn never becomes a cron identity, even beside an execution
        tokens = set_session_vars(platform="telegram", source="telegram", session_key="agent:main:telegram:dm:1",
                                  session_id="s1", user_id="u1", chat_id="1")
        self.addCleanup(clear_session_vars, tokens)
        context = transport.capture_context()
        self.assertEqual((context.platform, context.session_key), ("telegram", "agent:main:telegram:dm:1"))
        self.assertFalse(transport.is_cron(context))


if __name__ == "__main__":
    unittest.main()
