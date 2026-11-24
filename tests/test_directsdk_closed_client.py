"""The closed-client downstream patch is retired: the vendored plugin equals upstream (HF-793 follow-up).

Until upstream 0.4.0 a call on a closed ``Client`` raised ``RuntimeError('Claude client is closed')``, which Hermes'
error classifier filed as an unknown error, so the cached closed client was never evicted. The fleet carried
``ClaudeClientClosed(ConnectionError, RuntimeError)`` as a recorded patch. Upstream now leaves running requests
alone on ``Client.close()`` and the client keeps accepting new ones (hermes-official-plugins #378), so the refusal,
and with it the patch, no longer exists. These tests keep it that way: no recorded patch, no marker, no refusal.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "claude-subscription-directsdk"


def _load_directsdk():
    before = set(sys.modules)
    sys.path.insert(0, str(PLUGIN))
    try:
        spec = importlib.util.spec_from_file_location("directsdk_closed_client_under_test", PLUGIN / "directsdk.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(PLUGIN))
        for name in set(sys.modules) - before:
            origin = getattr(sys.modules[name], "__file__", None) or ""
            if origin.startswith(str(PLUGIN)):
                del sys.modules[name]
    return module


class RetiredPatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.upstream = json.loads((PLUGIN / "upstream.json").read_text(encoding="utf-8"))

    def test_no_downstream_patch_is_recorded_and_the_tree_matches_upstream(self) -> None:
        self.assertNotIn("patches", self.upstream)
        self.assertNotIn("upstream_files_sha256", self.upstream)
        vendored = {
            str(path.relative_to(PLUGIN)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in PLUGIN.rglob("*")
            if path.is_file() and path.name != "upstream.json" and "__pycache__" not in path.parts
        }
        self.assertEqual(vendored, self.upstream["files_sha256"])
        tree = "".join(f"{name} {digest}\n" for name, digest in sorted(vendored.items()))
        self.assertEqual(hashlib.sha256(tree.encode("utf-8")).hexdigest(), self.upstream["tree_sha256"])

    def test_no_fleet_patch_marker_remains(self) -> None:
        for path in PLUGIN.rglob("*.py"):
            if "tests" in path.parts:
                continue
            self.assertNotIn("hermes-fleet patch", path.read_text(encoding="utf-8"), path.name)

    def test_a_client_keeps_accepting_calls_after_close(self) -> None:
        sdk = _load_directsdk()
        self.assertFalse(hasattr(sdk, "ClaudeClientClosed"))
        client = sdk.Client(command="/bin/false")
        client.close()
        client.close()
        request = client._register()
        self.assertIn(request, client._requests)


if __name__ == "__main__":
    unittest.main()
