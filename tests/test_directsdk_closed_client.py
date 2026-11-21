"""A closed DirectSDK client raises a transport error, and that downstream delta is recorded (HF-793).

After ``Client.close()`` the vendored plugin raised ``RuntimeError('Claude client is closed')``. Core's
error classifier files a plain ``RuntimeError`` as an unknown error with no ``transport`` context, so the
auxiliary ladder never fell back and the cached (closed) client was never evicted: every later call
failed the same way. ``ClaudeClientClosed(ConnectionError, RuntimeError)`` classifies as a connection
failure, which both falls back and evicts. It is a recorded, removable patch in ``upstream.json``.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "claude-subscription-directsdk"
PATCH_ID = "closed-client-transport-error"


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _load_directsdk():
    """Import directsdk.py by path; its sibling imports need the plugin directory on sys.path only briefly."""
    before = set(sys.modules)
    sys.path.insert(0, str(PLUGIN))
    try:
        spec = importlib.util.spec_from_file_location("directsdk_closed_client_under_test", PLUGIN / "directsdk.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(PLUGIN))
        # Generic sibling names (admission, model_catalog, ...) must not leak into other tests.
        for name in set(sys.modules) - before:
            origin = getattr(sys.modules[name], "__file__", None) or ""
            if origin.startswith(str(PLUGIN)):
                del sys.modules[name]
    return module


def _strip_fleet_patch(text: str, patch_id: str) -> str:
    """The file as upstream shipped it: drop the marked block (and blank lines after it), restore the raise."""
    marker = re.escape(f"hermes-fleet patch: {patch_id}")
    block = re.compile(rf"^[^\n]*{marker}\n.*?^[^\n]*end {marker}[^\n]*\n\n*", re.S | re.M)
    stripped, count = block.subn("", text, count=1)
    if count != 1:
        raise AssertionError(f"no {patch_id} block")
    line = re.compile(rf"raise ClaudeClientClosed\('Claude client is closed'\)  # {marker}\n")
    restored, count = line.subn("raise RuntimeError('Claude client is closed')\n", stripped)
    if count != 1:
        raise AssertionError(f"no {patch_id} raise line")
    return restored


class RecordedDeltaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.upstream = json.loads((PLUGIN / "upstream.json").read_text(encoding="utf-8"))

    def test_the_patch_is_recorded_as_an_upstream_candidate(self) -> None:
        patches = {patch["id"]: patch for patch in self.upstream["patches"]}
        self.assertEqual(sorted(patches), [PATCH_ID])
        self.assertEqual(patches[PATCH_ID]["files"], ["directsdk.py"])
        self.assertIs(patches[PATCH_ID]["upstream_candidate"], True)
        self.assertEqual(self.upstream["source_revision"], "ab348e1d8d8691f56000875420bc3b29349a902b")

    def test_only_the_recorded_file_differs_and_removing_the_patch_restores_upstream_bytes(self) -> None:
        patched = {name for patch in self.upstream["patches"] for name in patch["files"]}
        self.assertEqual(set(self.upstream["upstream_files_sha256"]), patched)
        for name, original in self.upstream["upstream_files_sha256"].items():
            with self.subTest(file=name):
                current = (PLUGIN / name).read_bytes()
                self.assertEqual(_sha256(current), self.upstream["files_sha256"][name])
                self.assertNotEqual(_sha256(current), original)
                restored = _strip_fleet_patch(current.decode("utf-8"), PATCH_ID)
                self.assertEqual(_sha256(restored.encode("utf-8")), original)

    def test_the_patch_is_documented_where_operators_read_about_the_plugin(self) -> None:
        text = (ROOT / "docs" / "claude-subscription-directsdk.md").read_text(encoding="utf-8")
        self.assertIn(PATCH_ID, text)
        self.assertNotIn("preserved unmodified", text)


class ClosedClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.sdk = _load_directsdk()

    def closed_client(self):
        client = self.sdk.Client(command="/bin/false")
        client.close()
        return client

    def test_a_call_on_a_closed_client_raises_a_connection_error_with_the_old_message(self) -> None:
        client = self.closed_client()
        calls = {
            "register": client._register,
            "create": lambda: client.chat.completions.create(model="sonnet", messages=[{"role": "user", "content": "hi"}]),
            "create_stream": lambda: client.chat.completions.create(
                model="sonnet", messages=[{"role": "user", "content": "hi"}], stream=True),
        }
        for name, call in calls.items():
            with self.subTest(call=name):
                with self.assertRaises(self.sdk.ClaudeClientClosed) as caught:
                    call()
                self.assertIsInstance(caught.exception, ConnectionError)
                self.assertIsInstance(caught.exception, RuntimeError)  # callers of the old type still catch it
                self.assertEqual(str(caught.exception), "Claude client is closed")

    def test_an_open_client_still_registers_and_close_is_idempotent(self) -> None:
        client = self.sdk.Client(command="/bin/false")
        request = client._register()
        self.assertIn(request, client._requests)
        client.close()
        client.close()
        with self.assertRaises(self.sdk.ClaudeClientClosed):
            client._register()

    def test_the_cause_is_not_confused_with_an_upstream_or_login_failure(self) -> None:
        self.assertFalse(issubclass(self.sdk.ClaudeClientClosed, self.sdk.ClaudeAPIError))
        self.assertFalse(hasattr(self.sdk.ClaudeClientClosed, "status_code"))  # no HTTP status to mis-route on


@unittest.skipUnless(importlib.util.find_spec("agent") is not None
                     and importlib.util.find_spec("agent.auxiliary_error_policy") is not None,
                     "Hermes core (agent.auxiliary_error_policy) is not importable here")
class CoreClassificationTests(unittest.TestCase):
    """With core present: the closed-client error is a transport failure, so the ladder falls back and evicts."""

    PROVIDER = "claude-subscription-directsdk-experimental"

    @classmethod
    def setUpClass(cls) -> None:
        cls.sdk = _load_directsdk()
        from agent import auxiliary_error_policy
        cls.policy = auxiliary_error_policy

    def failure(self, error):
        verdict = self.policy.classify_attempt(error, self.PROVIDER, None, "sonnet", None)
        return verdict, self.policy.Failure(error, verdict, False, None)

    def test_closed_client_error_classifies_as_a_connection_failure_that_falls_back(self) -> None:
        client = self.sdk.Client(command="/bin/false")
        client.close()
        try:
            client._register()
        except Exception as exc:  # noqa: BLE001 - the error is the subject
            error = exc
        else:
            self.fail("closed client accepted a call")
        verdict, failure = self.failure(error)
        self.assertEqual(verdict.error_context.get("transport"), "connection")
        self.assertEqual(self.policy.fallback_label(failure), "connection error")
        self.assertTrue(self.policy.ladder_accepts(failure))

    def test_the_old_plain_runtime_error_did_not(self) -> None:
        """Documents the bug this patch fixes, against whatever core is installed."""
        verdict, failure = self.failure(RuntimeError("Claude client is closed"))
        if verdict.error_context.get("transport") == "connection":
            self.skipTest("core now classifies the plain RuntimeError as transport: the patch may be removable")
        self.assertIsNone(self.policy.fallback_label(failure))


if __name__ == "__main__":
    unittest.main()
