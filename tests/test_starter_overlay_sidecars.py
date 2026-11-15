"""Starter overlay wiring: pinned vendor sources, read-only mounts and sidecars.

compose.yaml mounts every plugin the starter overlay turns on from vendor/,
which scripts/fetch-overlay-vendor.py fills at the commits vendor.lock.json
pins. compose.sidecars.yaml adds Kokoro, Honcho and optional 1Password Connect
under the isolation rules in docs/sidecars.md.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OVERLAY = ROOT / "examples" / "overlay-repo"
CONTRACT = ROOT / "contracts" / "plugins.json"
LOCK = OVERLAY / "vendor.lock.json"
FETCH = ROOT / "scripts" / "fetch-overlay-vendor.py"
DIGEST_REF = re.compile(r"^[a-z0-9.-]+(?:/[a-z0-9._-]+)+@sha256:[0-9a-f]{64}$")
SIDECARS = {"voice", "honcho", "honcho-tiktoken", "honcho-db", "onepassword-connect-api", "onepassword-connect-sync",
            "linear-receiver", "linear-inbox-init"}
# The only published port: the Linear webhook receiver, on loopback, for a tunnel or reverse proxy.
RECEIVER_PORTS = ["127.0.0.1:${LINEAR_RECEIVER_PORT:-8646}:8646"]
RECEIVER_NETWORK = "linear-receiver-ingress"
AGENTS = {"ops", "worker"}
# Plugins the Fleet image itself ships, so the overlay need not mount them.
IN_IMAGE = {"security-guidance"}
# Plugin key -> where compose must mount it read-only.
PLUGIN_TARGETS = {
    "linear": "/opt/hermes/plugins/linear",
    "kokoro-voice": "/opt/hermes/plugins/kokoro-voice",
    "web-perplexity": "/opt/hermes/plugins/web/perplexity",
    "claude-acp-provider": "/opt/hermes/plugins/model-providers/claude-acp",
    "claude-subscription-directsdk-experimental": "/opt/hermes/plugins/model-providers/claude-subscription-directsdk",
    "claude-account-connectors": "/opt/hermes/plugins/claude-account-connectors",
    "disk-cleanup": "/opt/hermes/plugins/disk-cleanup",
    "quota": "/opt/data/plugins/quota",
    "hermes-session-reset-policy": "/opt/data/plugins/hermes-session-reset-policy",
}
FULL_ENV = {
    "CLAUDE_CONFIG_DIR": "/opt/data/.claude", "LINEAR_TOKEN_FILE": "/opt/data/secrets/linear-token",
    "LINEAR_VIEWER_ID": "v", "LINEAR_ORGANIZATION_ID": "o", "HERMES_KOKORO_SIDECAR_URL": "http://voice:8880/v1",
    "HERMES_KOKORO_SIDECAR_TOKEN": "t", "HONCHO_BASE_URL": "http://honcho:8000", "PERPLEXITY_API_KEY": "k",
    "OP_CONNECT_HOST": "http://onepassword-connect-api:8080", "OP_CONNECT_TOKEN": "t",
}

try:
    import yaml
    HAVE_YAML = True
except ImportError:  # pragma: no cover - the CI source-tests venv has PyYAML
    HAVE_YAML = False


def _fixture_module():
    spec = importlib.util.spec_from_file_location("starter_overlay_fixture", ROOT / "tests" / "starter_overlay_fixture.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _fetch_module():
    spec = importlib.util.spec_from_file_location("fetch_overlay_vendor", FETCH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _defaults_module():
    spec = importlib.util.spec_from_file_location("switchroom_defaults", ROOT / "scripts" / "switchroom_defaults.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("switchroom_defaults", module)
    spec.loader.exec_module(module)
    return module


def _binds(service: dict) -> list[tuple[str, str, str]]:
    out = []
    for volume in service.get("volumes", []):
        parts = volume.split(":")
        if parts[0].startswith("."):
            out.append((parts[0], parts[1], parts[2] if len(parts) > 2 else ""))
    return out


class VendorLockTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fetch = _fetch_module()
        self.entries = self.fetch.load_lock(LOCK)

    def test_every_entry_is_pinned_and_licensed(self) -> None:
        by_name = {e["name"]: e for e in self.entries}
        self.assertEqual(set(by_name), {"hermes-fleet", "hermes-quota-plugin", "hermes-session-reset-policy"})
        # The Fleet checkout follows the image, so skills and Fleet plugins
        # come from the same release as the image.
        self.assertEqual(by_name["hermes-fleet"]["commit"], "image_revision")
        for name in ("hermes-quota-plugin", "hermes-session-reset-policy"):
            self.assertRegex(by_name[name]["commit"], r"^[0-9a-f]{40}$")
            self.assertEqual(by_name[name]["license"], "MIT")

    def test_contract_sources_match_the_lock(self) -> None:
        defaults = {d["id"]: d for d in json.loads(CONTRACT.read_text(encoding="utf-8"))["public_base"]["default_set"]}
        for entry in self.entries:
            for default_id in entry["provides"]:
                source = defaults[default_id].get("source", {})
                if source.get("distribution") == "overlay_pinned_commit":
                    self.assertEqual(source["commit"], entry["commit"], default_id)
                    self.assertEqual(source["license"], entry["license"], default_id)
                    self.assertEqual(source["repository"] + ".git", entry["repository"], default_id)
        for default_id in ("quota", "session-reset-policy"):
            self.assertEqual(defaults[default_id]["source"]["distribution"], "overlay_pinned_commit")
            self.assertIs(defaults[default_id]["source"]["vendored"], False)

    def test_lock_rejects_moving_or_unsafe_pins(self) -> None:
        base = json.loads(LOCK.read_text(encoding="utf-8"))
        cases = {
            "branch": ("commit", "main"),
            "short sha": ("commit", "41fea5a"),
            "outside vendor": ("path", "../elsewhere"),
            "plain http": ("repository", "http://example.test/repo.git"),
            "no licence": ("license", ""),
        }
        for label, (key, value) in cases.items():
            with self.subTest(case=label), tempfile.TemporaryDirectory() as tmp:
                doc = json.loads(json.dumps(base))
                doc["entries"][1][key] = value
                path = Path(tmp) / "vendor.lock.json"
                path.write_text(json.dumps(doc), encoding="utf-8")
                with self.assertRaises(self.fetch.VendorError):
                    self.fetch.load_lock(path)

    def test_fleet_entry_needs_the_image_revision(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copy(LOCK, Path(tmp) / "vendor.lock.json")
            result = subprocess.run([sys.executable, str(FETCH), "--overlay", tmp, "--check"],
                                    text=True, capture_output=True, check=False, timeout=60)
        self.assertEqual(result.returncode, 1)
        self.assertIn("needs --fleet-revision", result.stderr)


@unittest.skipUnless(shutil.which("git"), "git is required")
class FetchCheckoutTests(unittest.TestCase):
    """ensure() against a local repository instead of the network."""

    def setUp(self) -> None:
        self.fetch = _fetch_module()
        self.tmp = tempfile.TemporaryDirectory()
        self.upstream = Path(self.tmp.name) / "upstream"
        self.upstream.mkdir()
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.test",
                   GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.test")
        for args in (["init", "-q"], ["config", "uploadpack.allowAnySHA1InWant", "true"]):
            subprocess.run(["git", *args], cwd=self.upstream, check=True, env=env)
        (self.upstream / "plugin.yaml").write_text("name: first\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=self.upstream, check=True, env=env)
        subprocess.run(["git", "commit", "-qm", "one"], cwd=self.upstream, check=True, env=env)
        self.first = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.upstream, text=True).strip()
        (self.upstream / "plugin.yaml").write_text("name: second\n", encoding="utf-8")
        subprocess.run(["git", "commit", "-qam", "two"], cwd=self.upstream, check=True, env=env)
        self.overlay = Path(self.tmp.name) / "overlay"
        self.overlay.mkdir()
        self.entry = {"name": "example", "path": "vendor/example", "repository": self.upstream.as_uri()}

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_checks_out_exactly_the_pinned_commit(self) -> None:
        # The pin is not the branch tip: an older commit must still be what lands.
        self.assertIn("fetched", self.fetch.ensure(self.entry, self.overlay, self.first))
        target = self.overlay / "vendor/example"
        self.assertEqual((target / "plugin.yaml").read_text(encoding="utf-8"), "name: first\n")
        self.assertIn("already", self.fetch.ensure(self.entry, self.overlay, self.first))

    def test_refuses_a_checkout_at_another_commit_or_with_changes(self) -> None:
        self.fetch.ensure(self.entry, self.overlay, self.first)
        target = self.overlay / "vendor/example"
        (target / "plugin.yaml").write_text("name: edited\n", encoding="utf-8")
        with self.assertRaisesRegex(self.fetch.VendorError, "local changes"):
            self.fetch.ensure(self.entry, self.overlay, self.first)
        with self.assertRaisesRegex(self.fetch.VendorError, "not the pinned"):
            self.fetch.ensure(self.entry, self.overlay, "0" * 40)

    def test_a_failed_fetch_leaves_nothing_behind(self) -> None:
        with self.assertRaises(self.fetch.VendorError):
            self.fetch.ensure(self.entry, self.overlay, "f" * 40)
        self.assertFalse((self.overlay / "vendor/example").exists())


@unittest.skipUnless(HAVE_YAML, "PyYAML is required for compose YAML")
class StarterComposeMountTests(unittest.TestCase):
    def setUp(self) -> None:
        self.compose = _load(OVERLAY / "compose.yaml")
        self.sd = _defaults_module()

    def test_every_enabled_plugin_is_mounted_read_only_for_each_agent(self) -> None:
        lock_paths = {e["path"] for e in json.loads(LOCK.read_text(encoding="utf-8"))["entries"]}
        for agent in AGENTS:
            with self.subTest(agent=agent):
                # Rendered where every login is visible, so every plugin is on.
                fixture = _fixture_module()
                with tempfile.TemporaryDirectory() as tmp:
                    paths = self.sd.ContainerPaths(root=fixture.full_container_root(Path(tmp), FULL_ENV),
                                                   voice_probe=fixture.healthy_voice)
                    rendered = self.sd.render(OVERLAY / "fleet-config", agent, self.sd.env_names(FULL_ENV), CONTRACT,
                                              environ=FULL_ENV, paths=paths)
                self.assertIn("claude-subscription-directsdk-experimental", rendered.leaves["plugins.enabled"])
                binds = _binds(self.compose["services"][agent])
                targets = {target: (source, mode) for source, target, mode in binds}
                for plugin in rendered.leaves["plugins.enabled"]:
                    if plugin in IN_IMAGE:
                        continue
                    self.assertIn(PLUGIN_TARGETS[plugin], targets, plugin)
                self.assertIn(rendered.leaves["_switchroom.skill_pack"], targets)
                for source, target, mode in binds:
                    self.assertEqual(mode, "ro", target)
                    if source.startswith("./vendor/"):
                        self.assertTrue(any(source[2:].startswith(p) for p in lock_paths), source)

    def test_agents_read_their_env_file_without_requiring_it(self) -> None:
        for agent in AGENTS:
            env_files = self.compose["services"][agent]["env_file"]
            self.assertEqual(env_files, [{"path": f"./secrets/{agent}.env", "required": False}])

    def test_vendor_checkouts_stay_out_of_git(self) -> None:
        ignored = (OVERLAY / ".gitignore").read_text(encoding="utf-8").split()
        self.assertIn("vendor/", ignored)
        self.assertIn("secrets/", ignored)


@unittest.skipUnless(HAVE_YAML, "PyYAML is required for compose YAML")
class SidecarComposeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.text = (OVERLAY / "compose.sidecars.yaml").read_text(encoding="utf-8")
        self.compose = yaml.safe_load(self.text)
        self.services = self.compose["services"]
        self.networks = self.compose["networks"]

    def image(self, name: str) -> str:
        image = self.services[name]["image"]
        match = re.fullmatch(r"\$\{[A-Z_]+:-([^}]+)\}", image)
        return match.group(1) if match else image

    def test_every_sidecar_image_is_pinned_by_digest(self) -> None:
        self.assertEqual(set(self.services) - AGENTS, SIDECARS)
        for name in SIDECARS:
            with self.subTest(sidecar=name):
                self.assertRegex(self.image(name), DIGEST_REF)
        self.assertNotIn(":latest", self.text)

    def test_no_host_network_privilege_socket_or_extra_published_ports(self) -> None:
        self.assertNotIn("docker.sock", self.text)
        allowed = {
            # One loopback port for the Linear webhook receiver.
            "linear-receiver": {"ports": RECEIVER_PORTS},
            # A one-shot with no network that only chowns new inbox volumes.
            "linear-inbox-init": {"network_mode": "none", "cap_add": ["CHOWN"]},
        }
        for name, service in self.services.items():
            with self.subTest(service=name):
                for key in ("ports", "network_mode", "privileged", "cap_add", "pid", "ipc", "devices"):
                    if key in allowed.get(name, {}):
                        self.assertEqual(service[key], allowed[name][key])
                    else:
                        self.assertNotIn(key, service)

    def test_linear_receiver_is_unprivileged_and_reads_only_what_it_needs(self) -> None:
        receiver, init = self.services["linear-receiver"], self.services["linear-inbox-init"]
        for service in (receiver, init):
            self.assertEqual(service["cap_drop"], ["ALL"])
            self.assertIn("no-new-privileges:true", service["security_opt"])
            self.assertIs(service["read_only"], True)
        self.assertEqual(receiver["user"], "1000:1000")
        # Off means the process exits 0; on-failure keeps it down until reconfigured.
        self.assertEqual(receiver["restart"], "on-failure")
        self.assertEqual(receiver["env_file"], [{"path": "./secrets/linear-receiver.env", "required": False}])
        self.assertEqual(receiver["networks"], [RECEIVER_NETWORK])
        binds = {target: (source, mode) for source, target, mode in _binds(receiver)}
        self.assertEqual(binds, {"/app": ("./vendor/hermes-fleet/sidecars/linear-receiver", "ro"),
                                 "/config/linear-receiver.json": ("./linear-receiver.json", "ro")})
        self.assertTrue((OVERLAY / "linear-receiver.json").is_file())
        self.assertTrue((ROOT / "sidecars" / "linear-receiver" / "receiver.py").is_file())
        # Each agent reads only its own inbox, at the plugin's default path; the
        # receiver and the init step see exactly those volumes and nothing of the agents' state.
        inboxes = {f"{agent}-linear-inbox:/inbox/{agent}" for agent in AGENTS}
        for service in (receiver, init):
            named = {v for v in service["volumes"] if not v.startswith(".")}
            self.assertEqual(named, inboxes)
        for agent in AGENTS:
            self.assertEqual(self.services[agent]["volumes"], [f"{agent}-linear-inbox:/opt/data/workspace/linear"])
            self.assertNotIn(RECEIVER_NETWORK, self.services[agent]["networks"])

    def test_each_sidecar_network_is_internal_and_joined_only_by_its_consumers(self) -> None:
        egress = {n for n in self.networks if n.endswith("-egress")}
        for name, network in self.networks.items():
            with self.subTest(network=name):
                self.assertIs(network.get("internal", False), name not in egress | {RECEIVER_NETWORK})
        members: dict[str, set[str]] = {}
        for name, service in self.services.items():
            for network in service.get("networks", []):
                members.setdefault(network, set()).add(name)
        self.assertEqual(members["voice"], {"voice", "ops"})
        self.assertEqual(members["honcho"], {"honcho", "ops", "worker"})
        self.assertEqual(members["honcho-db"], {"honcho", "honcho-db"})
        self.assertEqual(members["onepassword"], {"onepassword-connect-api", "ops", "worker"})
        self.assertEqual(members[RECEIVER_NETWORK], {"linear-receiver"})
        for network in egress:
            self.assertFalse(members[network] & AGENTS, network)
        # Honcho gets no egress, so it cannot reach a model provider at all.
        self.assertFalse(any(n in egress for n in self.services["honcho"]["networks"]))

    def test_worker_opts_out_of_voice_and_stays_off_its_network(self) -> None:
        worker = (OVERLAY / "fleet-config" / "agents" / "worker.yaml").read_text(encoding="utf-8")
        self.assertRegex(worker, r"(?m)^  voice: false$")
        self.assertNotIn("voice", self.services["worker"]["networks"])

    def test_kokoro_defaults_to_cpu(self) -> None:
        voice = self.services["voice"]
        # The upstream CPU build: no CUDA runtime in the image at all.
        self.assertIn("ghcr.io/remsky/kokoro-fastapi-cpu@sha256:", voice["image"])
        self.assertNotIn("gpus", voice)
        self.assertNotIn("deploy", voice)
        self.assertIn("GPU variant (optional)", self.text)

    def test_honcho_model_features_stay_off_without_a_granted_provider(self) -> None:
        honcho = self.services["honcho"]
        self.assertIn("ghcr.io/plastic-labs/honcho@sha256:", honcho["image"])
        env = honcho["environment"]
        for flag in ("DERIVER_ENABLED", "SUMMARY_ENABLED", "DREAM_ENABLED", "PEER_CARD_ENABLED", "EMBED_MESSAGES"):
            self.assertEqual(env[flag], "false", flag)
        self.assertFalse([k for k in env if k.startswith("LLM_") or k.endswith("_API_KEY")])
        self.assertIn("provider the operator granted", self.text)
        self.assertFalse((ROOT / "sidecars" / "honcho").exists())

    def test_onepassword_connect_is_optional_and_reads_its_credentials_read_only(self) -> None:
        for name in ("onepassword-connect-api", "onepassword-connect-sync"):
            service = self.services[name]
            self.assertEqual(service["profiles"], ["onepassword"])
            self.assertIn("./secrets/1password-credentials.json:/home/opuser/.op/1password-credentials.json:ro",
                          service["volumes"])

    def test_docs_describe_the_same_rules(self) -> None:
        docs = (ROOT / "docs" / "sidecars.md").read_text(encoding="utf-8")
        for phrase in ("examples/overlay-repo/compose.sidecars.yaml", "CPU", "AGPL-3.0", "granted",
                       "internal", "1Password Connect", "docker compose -f compose.yaml -f compose.sidecars.yaml"):
            self.assertIn(phrase, docs)

    @unittest.skipUnless(shutil.which("docker"), "docker compose is not installed")
    def test_docker_compose_config_accepts_the_layered_files(self) -> None:
        probe = subprocess.run(["docker", "compose", "version"], capture_output=True, text=True, check=False)
        if probe.returncode != 0:
            self.skipTest("docker compose plugin is not available")
        env = dict(os.environ, HERMES_FLEET_IMAGE="ghcr.io/example/hermes-fleet@sha256:" + "0" * 64)
        for extra in ([], ["--profile", "onepassword"]):
            with self.subTest(profiles=extra):
                result = subprocess.run(
                    ["docker", "compose", "-f", "compose.yaml", "-f", "compose.sidecars.yaml", *extra, "config", "-q"],
                    cwd=OVERLAY, env=env, capture_output=True, text=True, check=False, timeout=120)
                self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
