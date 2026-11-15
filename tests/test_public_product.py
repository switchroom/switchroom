from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _workflow_job(text: str, job: str) -> str:
    marker = f"  {job}:\n"
    start = text.index(marker) + len(marker)
    rest = text[start:]
    nxt = re.search(r"\n  [A-Za-z0-9_-]+:\n", rest)
    return rest[: nxt.start()] if nxt else rest


class PublicProductTests(unittest.TestCase):
    def test_required_public_product_files_exist(self) -> None:
        for relative in (
            "Dockerfile",
            "compose.example.yaml",
            "README.md",
            "SECURITY.md",
            "LICENSE",
            ".github/workflows/ci.yml",
            "contracts/image.json",
            "contracts/config.json",
            "contracts/plugins.json",
            "scripts/verify-public-tree.py",
            "scripts/claude-acp-subscription",
            "scripts/image_ref.py",
            "scripts/verify-agent-image-ref.py",
            "scripts/build-fleet-image.py",
            "scripts/compose.py",
            ".github/workflows/fleet-image.yml",
            "release/agent-image-manifest.json",
            "scripts/read-agent-image-manifest.py",
            "scripts/emit-fleet-image-manifest.py",
            "scripts/compact-spdx-sbom.py",
            "scripts/verify-inherited-runtime-config.py",
            "docs/image-release.md",
            "package.json",
            "package-lock.json",
            "plugins/model-providers/claude-acp/__init__.py",
            "plugins/model-providers/claude-acp/plugin.yaml",
            "plugins/model-providers/claude-acp/client.py",
            "plugins/model-providers/claude-acp/tool_bridge_mcp.py",
            "plugins/model-providers/claude-acp/upstream.json",
            "plugins/web/perplexity/__init__.py",
            "plugins/web/perplexity/plugin.yaml",
            "plugins/web/perplexity/provider.py",
            "plugins/linear/__init__.py",
            "plugins/linear/plugin.yaml",
            "plugins/linear/chat.py",
            "plugins/linear/bridge.py",
            "plugins/kokoro-voice/__init__.py",
            "plugins/kokoro-voice/plugin.yaml",
            "plugins/browser-handoff/__init__.py",
            "plugins/browser-handoff/plugin.yaml",
            "plugins/browser-handoff/policy.py",
            "plugins/readonly-source/__init__.py",
            "plugins/readonly-source/plugin.yaml",
            "scripts/tooling-policy-hook",
            "docs/perplexity.md",
            "docs/overlay-repository.md",
            "AGENTS.md",
        ):
            with self.subTest(relative=relative):
                self.assertTrue((ROOT / relative).is_file())

    def test_repository_has_no_remote_and_clean_history_contract(self) -> None:
        shallow = subprocess.check_output(
            ["git", "rev-parse", "--is-shallow-repository"],
            cwd=ROOT,
            text=True,
        ).strip()
        if shallow == "true":
            self.skipTest("shallow clone cannot assert the clean-history root")
        roots = subprocess.check_output(
            ["git", "rev-list", "--max-parents=0", "HEAD"],
            cwd=ROOT,
            text=True,
        ).split()
        self.assertEqual(roots, ["4dbbe890715aec58a04fd376559a97fa300e9486"])
        git_metadata = ROOT / ".git"
        # GitHub Actions and linked worktrees carry remotes by design.
        if os.environ.get("GITHUB_ACTIONS") or git_metadata.is_file():
            return
        remotes = subprocess.run(
            ["git", "config", "--get-regexp", r"^remote\..*\.url$"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        ).stdout.splitlines()
        if not remotes:
            return
        self.assertEqual(len(remotes), 1)
        _, remote_url = remotes[0].split(maxsplit=1)
        self.assertIn(
            remote_url,
            {
                "https://github.com/mekenthompson/hermes-fleet-public.git",
                "https://github.com/mekenthompson/hermes-fleet.git",
            },
        )

    def test_dockerfile_is_a_minimal_digest_parameterized_child(self) -> None:
        text = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn(
            'org.opencontainers.image.source="https://github.com/mekenthompson/hermes-fleet"',
            text,
        )
        op_image = (
            "docker.io/1password/op@"
            "sha256:b0d7eebcb09bdc9d5862af91533e1851c968d4f969270c906f5da8c574f87e93"
        )
        self.assertEqual(
            re.findall(r"(?m)^FROM\s+(.+)$", text),
            ["${ONEPASSWORD_CLI_IMAGE} AS onepassword_cli", "${AGENT_IMAGE}"],
        )
        self.assertIn(f"ARG ONEPASSWORD_CLI_IMAGE={op_image}", text)
        self.assertIn("ARG AGENT_IMAGE", text)
        self.assertIn(
            "COPY --from=onepassword_cli --chmod=0755 /usr/local/bin/op /usr/local/bin/op",
            text,
        )
        self.assertIn("COPY package.json package-lock.json /opt/coding-clis/", text)
        self.assertIn("npm ci --omit=dev --prefix /opt/coding-clis", text)
        self.assertIn("--ignore-scripts", text)
        self.assertIn("node /opt/coding-clis/node_modules/@anthropic-ai/claude-code/install.cjs", text)
        self.assertIn("/usr/local/bin/claude-agent-acp", text)
        self.assertIn("plugins/model-providers/claude-acp", text)
        self.assertIn("hermes-claude-acp-subscription", text)
        self.assertIn("DISABLE_AUTOUPDATER=1", text)
        self.assertIn("scripts/image_ref.py /opt/hermes-fleet/bin/image_ref.py", text)
        self.assertIn("scripts/verify-agent-image-ref.py /opt/hermes-fleet/bin/verify-agent-image-ref", text)
        self.assertNotRegex(text, r"(?m)^\s*(?:ENTRYPOINT|CMD)\b")
        self.assertIn("USER root", text)
        self.assertRegex(text, r"(?m)^USER 1000:1000$")
        self.assertNotIn("apt-get", text)
        self.assertIn("curl -fsSL", text)
        self.assertNotIn("wget ", text)
        self.assertNotIn("core_runtime_paths", text)

    def test_compose_uses_synthetic_profiles_and_dedicated_networks(self) -> None:
        text = (ROOT / "compose.example.yaml").read_text(encoding="utf-8")
        self.assertIn("operator:", text)
        self.assertIn("worker:", text)
        self.assertIn("operator-network:", text)
        self.assertIn("worker-network:", text)
        self.assertNotIn("network_mode: host", text)
        self.assertNotIn("docker.sock", text)
        self.assertNotIn("privileged: true", text)
        self.assertNotRegex(text, r"(?m)^\s*user:\s*")
        self.assertGreaterEqual(text.count("/opt/data"), 4)

    def test_contracts_are_public_product_contracts(self) -> None:
        image = json.loads((ROOT / "contracts/image.json").read_text())
        config = json.loads((ROOT / "contracts/config.json").read_text())
        plugins = json.loads((ROOT / "contracts/plugins.json").read_text())
        self.assertEqual(image["status"], "public_release_pipeline")
        self.assertEqual(image["images"]["fleet"]["base"], "agent_digest")
        self.assertTrue(image["images"]["agent"]["provenance_required"])
        self.assertEqual(image["runtime"]["network"]["default"], "dedicated_per_profile_bridge")
        self.assertEqual(config["desired_state"]["unknown_key_policy"], "fail_closed")
        self.assertEqual(config["desired_state"]["secret_value_policy"], "reject")
        # Reviewed default set (reference/rfcs/default-on-distribution.md). Only
        # defaults proven in real containers are shipped. A shipped default may
        # cover a component only with the enable guard (its local sidecar
        # configured and reachable, no hosted fallback), and only such a
        # component may be on; tests/test_default_on_contract.py pins the exact
        # list, degrade behaviour and billing.
        self.assertEqual(plugins["public_base"]["policy"], "reviewed_default_set")
        self.assertTrue(all(d["status"] in {"planned", "shipped"} for d in plugins["public_base"]["default_set"]))
        guard = {"sidecar": "configured_and_reachable", "hosted_fallback": False}
        guarded = set()
        for d in plugins["public_base"]["default_set"]:
            if d["status"] == "shipped" and d["covers"]:
                self.assertEqual(d.get("enable_guard"), guard, d["id"])
                guarded.update(d["covers"])
        self.assertTrue(all(item["id"] in guarded for item in plugins["components"] if item["default_enabled"]))
        self.assertTrue(
            all(item["default_role"] in {"default", "opt_in", "off"} for item in plugins["components"])
        )
        contract_text = "\n".join(
            (ROOT / relative).read_text(encoding="utf-8").lower()
            for relative in ("contracts/image.json", "contracts/config.json", "contracts/plugins.json")
        )
        for prohibited in (
            "private_house",
            "runtime_secret_broker",
            "secret-broker",
            "house-policy",
            # Honcho is a reviewed default now; its deployment identity is not.
            "workspace_id",
            "honcho_api_key",
        ):
            with self.subTest(prohibited=prohibited):
                self.assertNotIn(prohibited, contract_text)
        # Honcho may appear only in plugins.json as the upstream-image memory
        # default, never in the image or config contracts.
        for relative in ("contracts/image.json", "contracts/config.json"):
            self.assertNotIn("honcho", (ROOT / relative).read_text(encoding="utf-8").lower())
        honcho = [d for d in plugins["public_base"]["default_set"] if "honcho" in json.dumps(d).lower()]
        self.assertEqual([d["id"] for d in honcho], ["honcho-memory"])
        self.assertIs(honcho[0]["source"]["vendored"], False)
        self.assertEqual(image["publication"]["implementation_state"], "protected_release_workflow")

    def test_tracked_public_text_has_no_household_profile_identities(self) -> None:
        tracked = subprocess.check_output(
            ["git", "ls-files", "-z"],
            cwd=ROOT,
        ).split(b"\0")
        prohibited = (
            "car" + "rie",
            "over" + "lord",
            "klank" + "er",
            "gr" + "unt",
            "cl" + "erk",
            "gym" + "bro",
            "mar" + "ko",
            "law" + "gpt",
            "ag" + "gie",
        )
        for raw_path in tracked:
            if not raw_path:
                continue
            relative = raw_path.decode("utf-8")
            path = ROOT / relative
            if not path.is_file():
                continue
            data = path.read_bytes()
            if b"\0" in data:
                continue
            text = data.decode("utf-8", errors="ignore").lower()
            # Ordinary replay terminology is not a profile identity. Keep the
            # substring guard for all other text, including compound names.
            ordinary_words = r"(?<![a-z])(?:carrier|carriers|carried|carries)(?![a-z])"
            identity = "car" + "rie"
            for spelling in (identity, f"hermes-{identity}", f"profile_{identity}", f"{identity}bot"):
                self.assertIn(identity, re.sub(ordinary_words, "", spelling))
            text = re.sub(ordinary_words, "", text)
            for identity in prohibited:
                with self.subTest(path=relative, identity=identity):
                    self.assertNotIn(identity, text)

    def test_immutable_reference_wrappers_reject_mutable_images(self) -> None:
        digest = "0123456789abcdef" * 4
        good = f"ghcr.io/example/hermes-agent@sha256:{digest}"
        valid = subprocess.run(
            [
                "python3",
                "scripts/build-fleet-image.py",
                "--agent-image",
                good,
                "--tag",
                "hermes-fleet:test",
                "--dry-run",
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(valid.returncode, 0, valid.stderr)
        self.assertIn(f"AGENT_IMAGE={good}", valid.stdout)
        invalid = subprocess.run(
            [
                "python3",
                "scripts/build-fleet-image.py",
                "--agent-image",
                "ghcr.io/example/hermes-agent:latest",
                "--tag",
                "hermes-fleet:test",
                "--dry-run",
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertNotEqual(invalid.returncode, 0)
        deploy = subprocess.run(
            ["python3", "scripts/compose.py", "config"],
            cwd=ROOT,
            env={"HERMES_FLEET_IMAGE": "ghcr.io/example/hermes-fleet:latest"},
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertNotEqual(deploy.returncode, 0)

        immutable = "ghcr.io/example/hermes-fleet@sha256:" + "0" * 64
        override = subprocess.run(
            ["python3", "scripts/compose.py", "--", "-f", "/tmp/override.yaml", "config"],
            cwd=ROOT,
            env={"HERMES_FLEET_IMAGE": immutable},
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertNotEqual(override.returncode, 0)
        self.assertIn("unsupported Compose command", override.stderr)

    def test_wrappers_anchor_docker_to_repository_root(self) -> None:
        immutable = "ghcr.io/example/hermes-agent@sha256:" + "0" * 64
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            capture = temp / "capture"
            docker = temp / "docker"
            docker.write_text("#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"$@\" > \"$CAPTURE\"\n", encoding="utf-8")
            docker.chmod(0o755)
            env = {**os.environ, "PATH": f"{temp}:{os.environ['PATH']}", "CAPTURE": str(capture)}

            build = subprocess.run(
                [
                    "python3",
                    str(ROOT / "scripts/build-fleet-image.py"),
                    "--agent-image",
                    immutable,
                    "--tag",
                    "hermes-fleet:test",
                ],
                cwd=temp,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(build.returncode, 0, build.stderr)
            build_args = capture.read_text(encoding="utf-8").splitlines()
            self.assertEqual(build_args[0], str(ROOT))
            self.assertEqual(build_args[-1], ".")

            env["HERMES_FLEET_IMAGE"] = immutable.replace("hermes-agent", "hermes-fleet")
            compose = subprocess.run(
                ["python3", str(ROOT / "scripts/compose.py"), "config"],
                cwd=temp,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(compose.returncode, 0, compose.stderr)
            compose_args = capture.read_text(encoding="utf-8").splitlines()
            self.assertEqual(compose_args[0], str(ROOT))
            self.assertIn(str(ROOT / "compose.example.yaml"), compose_args)

    def test_public_tree_policy_includes_untracked_files(self) -> None:
        forbidden = ROOT / "auth.json"
        forbidden.write_text("{}\n", encoding="utf-8")
        try:
            result = subprocess.run(
                ["python3", "scripts/verify-public-tree.py"],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("forbidden path: auth.json", result.stdout)
        finally:
            forbidden.unlink(missing_ok=True)

    def test_public_tree_policy_rejects_ignored_env_variants(self) -> None:
        forbidden = ROOT / ".env.production"
        forbidden.write_text("EXAMPLE=value\n", encoding="utf-8")
        try:
            result = subprocess.run(
                ["python3", "scripts/verify-public-tree.py"],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("forbidden path: .env.production", result.stdout)
        finally:
            forbidden.unlink(missing_ok=True)

    def test_public_tree_policy_scans_its_own_source(self) -> None:
        verifier = ROOT / "scripts/verify-public-tree.py"
        original = verifier.read_text(encoding="utf-8")
        marker = "BEGIN " + "PRIVATE KEY"
        verifier.write_text(original + f"\n# {marker}\n", encoding="utf-8")
        try:
            result = subprocess.run(
                ["python3", "scripts/verify-public-tree.py"],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("private key: scripts/verify-public-tree.py", result.stdout)
        finally:
            verifier.write_text(original, encoding="utf-8")

    def test_public_tree_policy_rejects_unexpected_binary(self) -> None:
        binary = ROOT / "artifact.bin"
        binary.write_bytes(b"\xff\xfe\x00\x01")
        try:
            result = subprocess.run(
                ["python3", "scripts/verify-public-tree.py"],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("binary file requires dedicated scanning: artifact.bin", result.stdout)
        finally:
            binary.unlink(missing_ok=True)

    def test_ci_is_source_only_and_pinned(self) -> None:
        text = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        self.assertIn("permissions:\n  contents: read", text)
        self.assertIn("python3 scripts/source-ci.py units", text)
        self.assertIn("scripts/verify-public-tree.py", text)
        self.assertIn("python3 scripts/compose.py config -q", text)
        self.assertNotIn("packages: write", text)
        self.assertNotIn("docker/build-push-action", text)
        for uses in re.findall(r"(?m)^\s*-?\s*uses:\s*([^\s#]+)", text):
            self.assertRegex(uses, r"^[^@]+@[0-9a-f]{40}$")
        source = _workflow_job(text, "source-tests")
        history = _workflow_job(text, "history-root")
        self.assertIn("fetch-depth: 1", source)
        self.assertNotIn("fetch-depth: 0", source)
        self.assertIn("python3 scripts/source-ci.py units", source)
        self.assertIn("fetch-depth: 0", history)
        self.assertIn(
            "tests.test_public_product.PublicProductTests.test_repository_has_no_remote_and_clean_history_contract",
            history,
        )
        self.assertNotIn("unittest discover", history)


if __name__ == "__main__":
    unittest.main()
