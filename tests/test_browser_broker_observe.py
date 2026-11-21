"""Browser broker: agent Observe keeps the session open; the viewer follows the server mode.

These broker-only cases moved here when the sidecar-era browser-handoff plugin was retired.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SIDECAR = ROOT / "sidecars" / "browser-broker"


def load_session_policy():
    if str(SIDECAR) not in sys.path:
        sys.path.insert(0, str(SIDECAR))
    import session_policy as policy

    return policy


class AgentObserveCurrentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.policy = load_session_policy()
        self.env = {
            "PUBLIC_ORIGIN": "https://handoff.example",
            "PUBLIC_BASE": "https://handoff.example",
        }
        principal = self.policy.AccessPrincipal(
            principal_id="p1",
            access_email="user@example.com",
            routes=(("telegram", "1", None),),
            agents=("sample",),
            browser_workspaces=("default",),
        )
        self.invocation = self.policy.Invocation(
            profile="sample",
            platform="telegram",
            user_id="1",
            chat_id="1",
            thread_id="",
            chat_type="dm",
        )
        self.observed = []

        def on_observe(agent, workspace, session_id):
            self.observed.append((agent, workspace, session_id))
            return "checkpointed"

        with mock.patch.dict("os.environ", self.env, clear=False):
            self.broker = self.policy.HandoffBroker(
                [principal],
                clock=lambda: 1_000.0,
                ttl_seconds=900,
                configured_agent="sample",
                on_observe=on_observe,
            )

    def test_observe_current_keeps_session_active_and_unblocks_automation(self) -> None:
        with mock.patch.dict("os.environ", self.env, clear=False):
            minted = self.broker.mint(self.invocation)
            status = self.broker.observe_current(self.invocation)
        self.assertEqual(status["session_id"], minted.session_id)
        self.assertNotIn(status["state"], {"ended", "expired", "revoked", "none"})
        self.assertEqual(status["mode"], "observe")
        self.assertFalse(status["automation_blocked"])
        self.assertEqual(self.observed, [("sample", "default", minted.session_id)])
        with mock.patch.dict("os.environ", self.env, clear=False):
            still = self.broker.status(self.invocation)
        self.assertNotIn(still["state"], {"ended", "expired", "revoked", "none"})
        self.assertEqual(still["mode"], "observe")

    def test_observe_current_does_not_end_the_session(self) -> None:
        with mock.patch.dict("os.environ", self.env, clear=False):
            self.broker.mint(self.invocation)
            self.broker.observe_current(self.invocation)
            self.assertNotEqual(self.broker.status(self.invocation)["state"], "ended")


class ViewerForcedObserveCopyTests(unittest.TestCase):
    def test_viewer_polls_server_mode(self) -> None:
        sys.path.insert(0, str(SIDECAR))
        import ux

        self.assertIn('"/mode"', ux.VIEWER_JS)
        self.assertIn("applyServerMode", ux.VIEWER_JS)
        self.assertIn("watch", ux.viewer_page("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", agent_id="sample").lower())

    def test_default_workspace_mode_route_uses_bare_action_name(self) -> None:
        """UUID_RE nests the slash; group(4) is 'mode', not '/mode'.

        GET /<agent>/<uuid>/mode must match that existing default-resource ABI
        or the viewer poll proxies into Camofox instead of forcing Observe.
        """
        import re

        source = (SIDECAR / "origin.py").read_text(encoding="utf-8")
        uuid_re = re.search(r"^UUID_RE = re\.compile\(\s*r\"([^\"]+)\"", source, re.M)
        workspace_re = re.search(r"^WORKSPACE_UUID_RE = re\.compile\(\s*r\"([^\"]+)\"", source, re.M)
        self.assertIsNotNone(uuid_re)
        self.assertIsNotNone(workspace_re)
        assert uuid_re is not None and workspace_re is not None
        uuid_pat = re.compile(uuid_re.group(1))
        workspace_pat = re.compile(workspace_re.group(1))
        sid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        match = uuid_pat.match(f"/sample/{sid}/mode")
        self.assertIsNotNone(match)
        self.assertEqual(match.group(3), "/mode")
        self.assertEqual(match.group(4), "mode")
        workspace = workspace_pat.match(f"/sample/default/{sid}/mode")
        self.assertIsNotNone(workspace)
        self.assertEqual(workspace.group(4), "/mode")
        self.assertEqual(workspace.group(5), "mode")


if __name__ == "__main__":
    unittest.main()
