"""Opt-in recipes: browser handoff, gated A2A and reviewed artifact publishing.

Each recipe is a Compose fragment layered over the starter overlay. These
tests hold the isolation rules from docs/sidecars.md for every fragment, keep
each recipe off unless its fragment is layered, and exercise the artifact
origin's review gate directly.
"""
from __future__ import annotations

import hashlib
import http.client
import http.server
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RECIPES = ROOT / "recipes"
OVERLAY = ROOT / "examples" / "overlay-repo"
CONTRACT = ROOT / "contracts" / "plugins.json"
EVIDENCE = ROOT / "docs" / "opt-in-recipes-acceptance.md"
ARTIFACT = RECIPES / "artifact-publishing"
DIGEST_REF = re.compile(r"^[a-z0-9.-]+(?:/[a-z0-9._-]+)+@sha256:[0-9a-f]{64}$")
AGENTS = {"ops", "worker"}
FRAGMENTS = {
    "browser-handoff": RECIPES / "browser-handoff" / "compose.browser-handoff.yaml",
    "agent-to-agent": RECIPES / "a2a" / "compose.a2a.yaml",
    "artifact-publishing": ARTIFACT / "compose.artifact-publishing.yaml",
}
# Which starter agents each recipe may touch. Everyone else stays unchanged.
OPTED_IN = {"browser-handoff": {"ops"}, "agent-to-agent": {"ops", "worker"}, "artifact-publishing": {"ops"}}
UUID_A = "1b4e28ba-2fa1-4d2b-883f-0016d3cca427"
UUID_B = "6fa459ea-ee8a-4ca4-894e-db77e160355e"

try:
    import yaml
    HAVE_YAML = True
except ImportError:  # pragma: no cover - the CI source-tests venv has PyYAML
    HAVE_YAML = False


def _load(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _networks(service: dict) -> set[str]:
    nets = service.get("networks") or []
    return set(nets) if isinstance(nets, list) else set(nets)


class RecipeContractTests(unittest.TestCase):
    def test_every_opt_in_entry_names_a_recipe_with_docs_and_a_fragment(self) -> None:
        opt_in = json.loads(CONTRACT.read_text(encoding="utf-8"))["public_base"]["opt_in"]
        self.assertEqual({o["id"] for o in opt_in}, set(FRAGMENTS))
        for entry in opt_in:
            with self.subTest(recipe=entry["id"]):
                recipe = ROOT / entry["recipe"]
                self.assertTrue((recipe / "README.md").is_file())
                self.assertEqual(FRAGMENTS[entry["id"]].parent, recipe.resolve())
                self.assertTrue(FRAGMENTS[entry["id"]].is_file())

    def test_recipes_are_not_defaults(self) -> None:
        base = json.loads(CONTRACT.read_text(encoding="utf-8"))["public_base"]
        defaults = {d["id"] for d in base["default_set"]}
        self.assertFalse(defaults & set(FRAGMENTS))
        for entry in base["opt_in"]:
            self.assertNotIn("status", entry)

    def test_starter_overlay_mentions_no_recipe(self) -> None:
        # Off unless layered: the starter compose files never reference a
        # recipe's services, networks or variables.
        for name in ("compose.yaml", "compose.sidecars.yaml"):
            text = (OVERLAY / name).read_text(encoding="utf-8")
            for needle in ("ops-browser", "CAMOFOX", "A2A_", r"\ba2a\b", "artifact-origin", "artifacts/", "recipes/"):
                with self.subTest(file=name, needle=needle):
                    self.assertIsNone(re.search(needle, text))

    def test_evidence_records_each_recipe_and_its_limits(self) -> None:
        evidence = EVIDENCE.read_text(encoding="utf-8")
        for heading in ("## Browser handoff", "## A2A", "## Artifact publishing", "## Not proven here"):
            self.assertIn(heading, evidence)
        for recipe in FRAGMENTS.values():
            self.assertIn("opt-in-recipes-acceptance.md", (recipe.parent / "README.md").read_text(encoding="utf-8"))


@unittest.skipUnless(HAVE_YAML, "PyYAML is not installed")
class RecipeIsolationTests(unittest.TestCase):
    def test_every_image_is_pinned_by_digest(self) -> None:
        for recipe, path in FRAGMENTS.items():
            for name, service in _load(path)["services"].items():
                if name in AGENTS:
                    self.assertNotIn("image", service, f"{recipe} must not replace the agent image")
                    continue
                with self.subTest(recipe=recipe, service=name):
                    self.assertRegex(service["image"], DIGEST_REF)

    def test_no_host_network_privilege_socket_or_open_ports(self) -> None:
        for recipe, path in FRAGMENTS.items():
            for name, service in _load(path)["services"].items():
                with self.subTest(recipe=recipe, service=name):
                    self.assertNotIn("network_mode", service)
                    self.assertNotIn(service.get("pid"), ("host",))
                    self.assertNotIn(service.get("ipc"), ("host",))
                    self.assertFalse(service.get("privileged", False))
                    self.assertNotIn("cap_add", service)
                    for volume in service.get("volumes", []):
                        self.assertNotIn("docker.sock", str(volume))
                    for port in service.get("ports", []):
                        self.assertTrue(str(port).startswith("127.0.0.1:"), port)
                    if name in AGENTS:
                        self.assertNotIn("ports", service)

    def test_each_recipe_touches_only_the_agents_that_opt_in(self) -> None:
        for recipe, path in FRAGMENTS.items():
            touched = set(_load(path)["services"]) & AGENTS
            with self.subTest(recipe=recipe):
                self.assertEqual(touched, OPTED_IN[recipe])

    def test_internal_networks_are_joined_only_by_their_consumers(self) -> None:
        expected = {
            "browser-handoff": {"ops-browser": {"ops", "ops-browser"}, "ops-browser-viewer": {"ops-browser", "ops-browser-vnc"}},
            "agent-to-agent": {"a2a": {"ops", "worker"}},
        }
        for recipe, networks in expected.items():
            data = _load(FRAGMENTS[recipe])
            for net, members in networks.items():
                with self.subTest(recipe=recipe, network=net):
                    self.assertIs(data["networks"][net].get("internal"), True)
                    joined = {n for n, s in data["services"].items() if net in _networks(s)}
                    self.assertEqual(joined, members)

    def test_a_published_port_sits_alone_on_its_ingress_network(self) -> None:
        for recipe, path in FRAGMENTS.items():
            data = _load(path)
            for name, service in data["services"].items():
                if not service.get("ports"):
                    continue
                with self.subTest(recipe=recipe, service=name):
                    for net in _networks(service):
                        joined = {n for n, s in data["services"].items() if net in _networks(s)}
                        if not data["networks"][net].get("internal"):
                            self.assertEqual(joined, {name}, f"{net} must hold only the publishing service")

    def test_browser_is_keyed_and_vnc_is_loopback_only(self) -> None:
        data = _load(FRAGMENTS["browser-handoff"])
        browser = data["services"]["ops-browser"]
        self.assertIn("hermes-fleet-camofox@sha256:", browser["image"])
        self.assertEqual(browser["env_file"], [{"path": "./secrets/ops-browser.env", "required": True}])
        self.assertNotIn("ports", browser)
        self.assertNotIn("ops-browser-vnc-ingress", _networks(browser))
        env = browser["environment"]
        self.assertEqual(env["VNC_RFB_BIND"], "127.0.0.1")
        self.assertEqual(env["ENABLE_VNC"], "1")
        for reaper in ("TAB_INACTIVITY_MS", "SESSION_TIMEOUT_MS", "BROWSER_IDLE_TIMEOUT_MS"):
            self.assertEqual(env[reaper], "2147483647")
        for secret in ("CAMOFOX_API_KEY", "CAMOFOX_ACCESS_KEY", "VNC_PASSWORD"):
            self.assertNotIn(secret, env)
        vnc = data["services"]["ops-browser-vnc"]
        self.assertIn("hermes-fleet-tcp-proxy@sha256:", vnc["image"])
        self.assertEqual(vnc["ports"], ["127.0.0.1:${OPS_BROWSER_VNC_PORT:-6080}:6080"])
        self.assertEqual(vnc["environment"]["TARGET"], "ops-browser:6080")
        self.assertIs(vnc["read_only"], True)
        self.assertEqual(vnc["cap_drop"], ["ALL"])
        ops = data["services"]["ops"]
        self.assertEqual(ops["environment"], {"CAMOFOX_URL": "http://ops-browser:9377"})
        self.assertEqual(_networks(ops), {"ops-browser"})

    def test_a2a_trusts_only_named_peers(self) -> None:
        data = _load(FRAGMENTS["agent-to-agent"])
        peers = {"ops": "worker", "worker": "ops"}
        for agent, peer in peers.items():
            env = data["services"][agent]["environment"]
            with self.subTest(agent=agent):
                self.assertEqual(env["A2A_TRUSTED_PEERS"], peer)
                self.assertEqual(env["A2A_ALLOW_ALL_USERS"], "false")
                self.assertEqual(env["A2A_AGENT_NAME"], agent)
                self.assertEqual(env["A2A_PORT"], "9900")
                for secret in ("A2A_PEER_TOKENS", "A2A_BEARER_TOKEN"):
                    self.assertNotIn(secret, env, "tokens belong in the agent's env file")
                self.assertNotIn("ports", data["services"][agent])
        self.assertEqual(set(data["services"]), set(peers))

    def test_artifact_origin_is_read_only_and_out_of_agent_reach(self) -> None:
        data = _load(FRAGMENTS["artifact-publishing"])
        origin = data["services"]["artifact-origin"]
        self.assertEqual(origin["user"], "65534:65534")
        self.assertIs(origin["read_only"], True)
        self.assertEqual(origin["cap_drop"], ["ALL"])
        self.assertIn("no-new-privileges:true", origin["security_opt"])
        self.assertEqual(origin["ports"], ["127.0.0.1:${ARTIFACT_ORIGIN_PORT:-8647}:8647"])
        for volume in origin["volumes"]:
            self.assertTrue(volume.endswith(":ro"), volume)
        # The manifest directory, never the file: a file bind mount would pin
        # the inode that review_artifact.py replaces.
        self.assertIn("./artifacts/review:/review:ro", origin["volumes"])
        ops = data["services"]["ops"]
        self.assertEqual(ops["volumes"], ["./artifacts/outbox/ops:/opt/data/workspace/outbox"])
        self.assertNotIn("networks", ops)
        for volume in ops["volumes"]:
            self.assertNotIn("review", volume)

    @unittest.skipUnless(shutil.which("docker"), "docker compose is not installed")
    def test_docker_compose_config_accepts_each_layered_combination(self) -> None:
        probe = subprocess.run(["docker", "compose", "version"], capture_output=True, text=True, check=False)
        if probe.returncode != 0:
            self.skipTest("docker compose plugin is not available")
        env = dict(os.environ, HERMES_FLEET_IMAGE="ghcr.io/example/hermes-fleet@sha256:" + "0" * 64)
        with tempfile.TemporaryDirectory() as tmp:
            overlay = Path(tmp) / "overlay"
            shutil.copytree(OVERLAY, overlay)
            (overlay / "secrets").mkdir(exist_ok=True)
            (overlay / "secrets" / "ops-browser.env").write_text("", encoding="utf-8")
            combos = [[p] for p in FRAGMENTS.values()] + [list(FRAGMENTS.values())]
            for combo in combos:
                args = ["docker", "compose", "-f", "compose.yaml", "-f", "compose.sidecars.yaml"]
                for path in combo:
                    args += ["-f", str(path)]
                with self.subTest(combo=[p.name for p in combo]):
                    result = subprocess.run(args + ["config", "-q"], cwd=overlay, env=env, capture_output=True,
                                            text=True, check=False, timeout=120)
                    self.assertEqual(result.returncode, 0, result.stderr)


class ArtifactOriginTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.proxy = _module("origin_proxy", ARTIFACT / "origin_proxy.py")
        cls.review = _module("review_artifact", ARTIFACT / "review_artifact.py")
        cls.verify = _module("verify_artifact", ARTIFACT / "verify_artifact.py")

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.outbox = root / "outbox"
        self.outbox.mkdir()
        self.manifest = root / "review" / "reviewed.json"
        (self.outbox / "report.html").write_bytes(b"<h1>reviewed</h1>\n")
        (self.outbox / "draft.html").write_bytes(b"<h1>draft</h1>\n")

    def _approve(self, name: str = "report.html") -> str:
        return self.review.approve(self.outbox, self.manifest, name)

    def _get(self, path: str, method: str = "GET", headers: dict | None = None):
        return self.proxy.resolve(method, path, {k.lower(): v for k, v in (headers or {}).items()},
                                  str(self.outbox), str(self.manifest), self.proxy.DEFAULT_MAX_BYTES)

    def _refused(self, path: str, status: int, method: str = "GET", headers: dict | None = None) -> None:
        with self.assertRaises(self.proxy.Refused) as caught:
            self._get(path, method, headers)
        self.assertEqual(caught.exception.status, status, caught.exception.reason)

    def test_serves_exactly_the_reviewed_bytes(self) -> None:
        key = self._approve()
        status, headers, body = self._get(f"/artifact/{key}/")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"<h1>reviewed</h1>\n")
        self.assertEqual(headers["X-Artifact-SHA256"], hashlib.sha256(body).hexdigest())
        self.assertEqual(headers["Content-Type"], "text/html; charset=utf-8")
        self.assertIn("sandbox", headers["Content-Security-Policy"])
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        status, _, head_body = self._get(f"/artifact/{key}/", method="HEAD")
        self.assertEqual((status, head_body), (200, b""))

    def test_refuses_an_unreviewed_artifact(self) -> None:
        self._approve()
        self._refused(f"/artifact/{UUID_B}/", 404)
        self._refused("/artifact/draft.html/", 404)
        self._refused("/draft.html", 404)

    def test_refuses_an_artifact_changed_after_review(self) -> None:
        key = self._approve()
        (self.outbox / "report.html").write_bytes(b"<h1>swapped</h1>\n\n")
        self._refused(f"/artifact/{key}/", 409)
        (self.outbox / "report.html").write_bytes(b"<h1>SWAPPED</h1>\n")  # same size, other bytes
        self._refused(f"/artifact/{key}/", 409)

    def test_withdrawal_takes_effect_at_once(self) -> None:
        key = self._approve()
        self.assertEqual(self._get(f"/artifact/{key}/")[0], 200)
        self.assertTrue(self.review.withdraw(self.manifest, key))
        self._refused(f"/artifact/{key}/", 404)

    def test_refuses_methods_queries_credentials_bodies_and_odd_paths(self) -> None:
        key = self._approve()
        good = f"/artifact/{key}/"
        self._refused(good, 405, method="POST")
        self._refused(good, 405, method="PUT")
        self._refused(good + "?x=1", 400)
        self._refused(good, 400, headers={"Cookie": "a=b"})
        self._refused(good, 400, headers={"Authorization": "Bearer x"})
        self._refused(good, 400, headers={"Content-Length": "3"})
        self._refused(good, 400, headers={"Transfer-Encoding": "chunked"})
        self._refused(f"/artifact/{key}/%2e%2e/", 400)
        self._refused(f"/artifact/{key}/../", 404)
        self._refused(f"/artifact//{key}/", 400)
        self._refused("http://example.test" + good, 400)
        self._refused(f"/artifact/{key.upper()}/", 404)
        self._refused(f"/artifact/{key}", 404)

    def test_a_missing_or_malformed_manifest_serves_nothing(self) -> None:
        self._refused(f"/artifact/{UUID_A}/", 503)
        self.manifest.parent.mkdir(parents=True)
        for bad in ("not json", json.dumps({"schema_version": 2, "artifacts": {}}),
                    json.dumps({"schema_version": 1, "artifacts": {UUID_A: {"path": "../etc/passwd",
                                                                            "sha256": "0" * 64, "size": 1}}}),
                    json.dumps({"schema_version": 1, "artifacts": {UUID_A: {"path": "/etc/passwd",
                                                                            "sha256": "0" * 64, "size": 1}}}),
                    json.dumps({"schema_version": 1, "artifacts": {"not-a-uuid": {"path": "a", "sha256": "0" * 64,
                                                                                 "size": 1}}})):
            with self.subTest(manifest=bad[:40]):
                self.manifest.write_text(bad, encoding="utf-8")
                self._refused(f"/artifact/{UUID_A}/", 503)

    def test_refuses_a_symlink_swapped_in_after_review(self) -> None:
        key = self._approve()
        secret = Path(self.tmp.name) / "secret.txt"
        secret.write_bytes(b"<h1>reviewed</h1>\n")  # even identical bytes are not served through a link
        (self.outbox / "report.html").unlink()
        (self.outbox / "report.html").symlink_to(secret)
        self._refused(f"/artifact/{key}/", 404)

    def test_refuses_an_artifact_over_the_size_limit(self) -> None:
        key = self._approve()
        with self.assertRaises(self.proxy.Refused) as caught:
            self.proxy.resolve("GET", f"/artifact/{key}/", {}, str(self.outbox), str(self.manifest), 4)
        self.assertEqual(caught.exception.status, 413)

    def test_review_refuses_links_and_paths_outside_the_outbox(self) -> None:
        outside = Path(self.tmp.name) / "outside.txt"
        outside.write_text("x", encoding="utf-8")
        (self.outbox / "link.txt").symlink_to(outside)
        for name in ("link.txt", "../outside.txt", "/etc/passwd", "missing.txt"):
            with self.subTest(name=name), self.assertRaises((SystemExit, ValueError)):
                self._approve(name)
        self.assertFalse(self.manifest.exists())

    def test_verify_requires_exact_200_and_matching_bytes(self) -> None:
        key = self._approve()
        handler = self.proxy.make_handler(str(self.outbox), str(self.manifest), self.proxy.DEFAULT_MAX_BYTES)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        base = f"http://127.0.0.1:{server.server_address[1]}"
        good = hashlib.sha256(b"<h1>reviewed</h1>\n").hexdigest()
        self.assertTrue(self.verify.verify(f"{base}/artifact/{key}/", good).startswith("ok:"))
        self.assertTrue(self.verify.verify(f"{base}/artifact/{key}/", "0" * 64).startswith("failed:"))
        self.assertTrue(self.verify.verify(f"{base}/artifact/{UUID_B}/", good).startswith("failed: HTTP 404"))
        self.assertTrue(self.verify.verify(f"{base}/artifact/{key}/?x", good).startswith("refused"))
        conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=10)
        conn.request("POST", f"/artifact/{key}/", body=b"x")
        self.assertEqual(conn.getresponse().status, 405)
        conn.close()

    def test_verify_refuses_a_redirect(self) -> None:
        class Redirect(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                self.send_response(302)
                self.send_header("Location", "/login")
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, format: str, *args) -> None:  # noqa: A002
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_address[1]}/artifact/{UUID_A}/"
        self.assertEqual(self.verify.verify(url, "0" * 64), "failed: HTTP 302, expected exactly 200")


if __name__ == "__main__":
    unittest.main()
