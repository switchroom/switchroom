from __future__ import annotations

import json
import re
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_SOURCE_URL = "https://github.com/switchroom/switchroom"
DOCKERFILE = ROOT / "Dockerfile"
PACKAGE = ROOT / "package.json"
PLUGINS_CONTRACT = ROOT / "contracts" / "plugins.json"
SCOPE = ROOT / "scripts" / "fleet-image-change-scope.py"
VERIFY = ROOT / "scripts" / "verify-public-tree.py"
WORKFLOW = ROOT / ".github" / "workflows" / "fleet-image.yml"
GH_VERSION = "2.105.0"
GH_LINUX_AMD64_SHA256 = (
    "79e7ab5db738c48777b696e374f8b428f0647debfb424f44d2f426370407fe2f"
)
HONCHO_AI_VERSION = "2.9.0"
EXTRA_CLIS = {
    "@openai/codex": "0.172.0",
    "@xai-official/grok": "1.0.92",
    "opencode-ai": "1.19.5",
}


def _split(name: str) -> str:
    return "".join(name)


class PublicFattenContractTests(unittest.TestCase):
    def test_dockerfile_installs_pinned_github_cli(self) -> None:
        text = DOCKERFILE.read_text(encoding="utf-8")
        self.assertIn(f"ARG GH_VERSION={GH_VERSION}", text)
        self.assertIn(f"ARG GH_LINUX_AMD64_SHA256={GH_LINUX_AMD64_SHA256}", text)
        self.assertIn("gh_${GH_VERSION}_linux_amd64.tar.gz", text)
        self.assertIn(
            "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${archive}",
            text,
        )
        self.assertIn("curl -fsSL", text)
        # REST asset API first, release URL second; the pinned sha256 decides whether the
        # API route counts and is checked again unconditionally after either route.
        self.assertIn("ARG GH_LINUX_AMD64_ASSET_ID=761188566", text)
        self.assertIn("https://api.github.com/repos/cli/cli/releases/assets/${GH_LINUX_AMD64_ASSET_ID}", text)
        self.assertLess(text.index("api.github.com/repos/cli/cli"), text.index("github.com/cli/cli/releases/download"))
        self.assertEqual(text.count('"${GH_LINUX_AMD64_SHA256}" "/tmp/${archive}" | sha256sum -c -'), 2)
        gh_step = text[text.index("RUN --mount=type=secret,id=github_token"):text.index("Honcho tooling")]
        # The token is an optional BuildKit secret for this step only: never an ARG/ENV,
        # never echoed (xtrace starts after the curl config is written), removed before
        # the step ends, and not forwarded to the release-download fallback.
        self.assertIn("RUN --mount=type=secret,id=github_token,required=false set -eu;", text)
        self.assertNotRegex(text, r"(?m)^(ARG|ENV) .*TOKEN")
        self.assertLess(gh_step.index("/run/secrets/github_token"), gh_step.index("set -x"))
        self.assertIn("(umask 077;", gh_step)
        self.assertLess(gh_step.index("rm -f /tmp/gh-api-auth.curl"), gh_step.index("releases/download"))
        fallback = gh_step[gh_step.index('if [ "$api_ok" != 1 ]'):]
        self.assertNotIn("curl_auth", fallback)
        workflow = (ROOT / ".github/workflows/fleet-image.yml").read_text(encoding="utf-8")
        # One BuildKit secret per build step: preflight, the cached publish build and its fallback.
        self.assertEqual(workflow.count("github_token=${{ github.token }}"), 3)
        self.assertEqual(workflow.count("uses: docker/build-push-action@"), 3)
        self.assertNotIn("GITHUB_TOKEN=", workflow.split("build-args:", 1)[1].split("secrets:", 1)[0])
        self.assertIn('test "$(gh --version | awk \'NR==1{print $3}\')" = "${GH_VERSION}"', text)
        self.assertNotIn("4c5f90f0198e28652d2c111e5c529e2a9901a7b2f20808b1cbd3a64d2a93a8d6", text)

    def test_dockerfile_rebinds_hermes_to_uid_1000(self) -> None:
        text = DOCKERFILE.read_text(encoding="utf-8")
        self.assertIn("usermod -u 1000 -g 1000 hermes", text)
        self.assertIn("groupmod -g 1000 hermes", text)
        self.assertRegex(text, r"(?m)^USER 1000:1000$")

    def test_dockerfile_installs_pinned_honcho_without_workspace_ids(self) -> None:
        text = DOCKERFILE.read_text(encoding="utf-8")
        self.assertIn('facts["packages"]["uv"]["entry"]', text)
        self.assertIn("--no-deps --require-hashes", text)
        self.assertNotIn("\n    && uv export ", text)
        self.assertIn("verify-honcho-runtime.py", text)
        self.assertIn("5c7d24b32d275bce38daedbe81feaebc31393587", text)
        self.assertIn("62193f2f98d8ae53b4fd7aab4162d312a918f27cdb214b1d7146884812c7b2d0", text)
        self.assertIn("/opt/hermes/plugins/memory/honcho", text)
        # The OCI source label names the public product repository; nothing else may.
        lowered = text.lower().replace(PUBLIC_SOURCE_URL, "")
        for token in ("workspace_id", "switchroom", "kenthompson.com.au"):
            self.assertNotIn(token, lowered)

    def test_package_json_pins_extra_coding_clis(self) -> None:
        package = json.loads(PACKAGE.read_text(encoding="utf-8"))
        for name, version in EXTRA_CLIS.items():
            with self.subTest(name=name):
                self.assertEqual(package["dependencies"][name], version)

    def test_acp_version_check_keeps_shell_single_quoted_node(self) -> None:
        text = DOCKERFILE.read_text(encoding="utf-8")
        self.assertIn(
            "node -p 'require(\"/opt/coding-clis/node_modules/"
            "@agentclientprotocol/claude-agent-acp/package.json\").version'",
            text,
        )
        self.assertNotIn(
            r'require(\"/opt/coding-clis/node_modules/'
            r'@agentclientprotocol/claude-agent-acp/package.json\")',
            text,
        )

    def test_image_scope_excludes_plugin_only_changes(self) -> None:
        text = SCOPE.read_text(encoding="utf-8")
        self.assertNotIn('"plugins/web/perplexity/"', text)
        self.assertIn('"contracts/"', text)
        self.assertNotIn("webkite", text.lower())

    def test_release_workflow_proves_fattened_runtime(self) -> None:
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertGreaterEqual(text.count('assert pwd.getpwnam("hermes").pw_uid == 1000'), 2)
        self.assertGreaterEqual(text.count('assert subprocess.check_output(["gh", "--version"]'), 2)
        self.assertGreaterEqual(text.count(f'assert metadata.version("honcho-ai") == "{HONCHO_AI_VERSION}"'), 2)
        self.assertGreaterEqual(text.count('assert shutil.which("codex")'), 2)
        self.assertGreaterEqual(text.count('assert shutil.which("grok")'), 2)
        self.assertGreaterEqual(text.count('assert subprocess.check_output(["/usr/local/bin/codex", "--version"]'), 2)
        self.assertGreaterEqual(text.count('assert subprocess.check_output(["/usr/local/bin/grok", "--version"]'), 2)
        self.assertGreaterEqual(text.count('assert shutil.which("opencode")'), 2)
        self.assertNotIn("webkite", text.lower())

    def test_fatten_inputs_keep_household_state_out(self) -> None:
        tracked = []
        for relative in (
            "Dockerfile",
            "package.json",
            "contracts/plugins.json",
            "README.md",
            "AGENTS.md",
        ):
            path = ROOT / relative
            self.assertTrue(path.is_file(), relative)
            tracked.append(path.read_text(encoding="utf-8").lower())
        blob = "\n".join(tracked)
        # Switchroom is the public product name (reference/rfcs/switchroom-positioning.md).
        # Deployment identifiers under that name stay out.
        for token in (
            "browser.switchroom",
            "switchroom-ai",
            "switchroom-config",
            "switchroom-artifacts",
            "switchroom.ai/artifact",
            "melbourne",
            "o" + "p://",
            "au.com.kenthompson",
            _split("klank") + "er",
            _split("over") + "lord",
            _split("car") + "rie",
        ):
            self.assertNotIn(token, blob)
        self.assertFalse((ROOT / "plugins/linear-agent/linear-agents.json").exists())
        self.assertNotRegex(
            DOCKERFILE.read_text(encoding="utf-8"),
            r"(?m)^\s*COPY\s+.*linear-agents\.json",
        )
        # package.json and the plugin contract are machine inputs, not prose: the
        # bare product name has no reason to be there, so keep the strict check.
        for relative in ("package.json", "contracts/plugins.json"):
            with self.subTest(path=relative):
                self.assertNotIn(
                    "switch" + "room", (ROOT / relative).read_text(encoding="utf-8").lower()
                )
        contract = json.loads(PLUGINS_CONTRACT.read_text(encoding="utf-8"))
        # Honcho is a reviewed default (upstream image by digest); its source and
        # deployment identity stay out of the contract.
        honcho = [
            d for d in contract["public_base"]["default_set"] if "honcho" in json.dumps(d).lower()
        ]
        self.assertEqual([d["id"] for d in honcho], ["honcho-memory"])
        self.assertIs(honcho[0]["source"]["vendored"], False)
        self.assertNotIn("honcho", json.dumps(contract["components"]).lower())
        for token in ("workspace_id", "honcho_api_key"):
            self.assertNotIn(token, json.dumps(contract).lower())
        # A component is on only under a shipped default carrying the enable
        # guard (local sidecar configured and reachable, no hosted fallback);
        # Honcho covers no component. Honcho is shipped: the shipped compose
        # started it in real containers (docs/starter-overlay-acceptance.md,
        # rerun after the real-boot fixes).
        guard = {"sidecar": "configured_and_reachable", "hosted_fallback": False}
        guarded = {cid for d in contract["public_base"]["default_set"]
                   if d["status"] == "shipped" and d.get("enable_guard") == guard for cid in d["covers"]}
        self.assertTrue(all(item["id"] in guarded for item in contract["components"] if item["default_enabled"]))
        self.assertEqual(honcho[0]["covers"], [])
        self.assertEqual(honcho[0]["status"], "shipped")

    def test_inherited_runtime_keeps_entrypoint_and_requires_uid_1000(self) -> None:
        text = (ROOT / "scripts/verify-inherited-runtime-config.py").read_text(
            encoding="utf-8"
        )
        self.assertIn('if field == ".Config.User":', text)
        self.assertIn('if current != "1000:1000":', text)
        self.assertIn(".Config.Entrypoint", text)
        self.assertIn(".Config.Cmd", text)
        self.assertIn("if parent != current:", text)


class InheritedRuntimeBehaviorTests(unittest.TestCase):
    def _module(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location(
            "verify_inherited_runtime_config",
            ROOT / "scripts/verify-inherited-runtime-config.py",
        )
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        return module

    def test_uid_1000_passes_when_entrypoint_and_cmd_match(self) -> None:
        module = self._module()
        values = {
            ("agent", ".Config.User"): "root",
            ("child", ".Config.User"): "1000:1000",
            ("agent", ".Config.Entrypoint"): ["/opt/hermes/bin/hermes"],
            ("child", ".Config.Entrypoint"): ["/opt/hermes/bin/hermes"],
            ("agent", ".Config.Cmd"): None,
            ("child", ".Config.Cmd"): None,
        }

        def inspect(image: str, field: str):
            return values[(image, field)]

        module.inspect = inspect  # type: ignore[method-assign]
        with mock.patch.dict(
            "os.environ", {"AGENT_IMAGE": "agent", "TEST_IMAGE": "child"}, clear=False
        ):
            self.assertEqual(module.main(), 0)

    def test_parent_user_equality_is_not_required(self) -> None:
        module = self._module()
        values = {
            ("agent", ".Config.User"): "root",
            ("child", ".Config.User"): "root",
            ("agent", ".Config.Entrypoint"): ["/opt/hermes/bin/hermes"],
            ("child", ".Config.Entrypoint"): ["/opt/hermes/bin/hermes"],
            ("agent", ".Config.Cmd"): None,
            ("child", ".Config.Cmd"): None,
        }

        def inspect(image: str, field: str):
            return values[(image, field)]

        module.inspect = inspect  # type: ignore[method-assign]
        with mock.patch.dict(
            "os.environ", {"AGENT_IMAGE": "agent", "TEST_IMAGE": "child"}, clear=False
        ):
            with self.assertRaises(SystemExit) as raised:
                module.main()
            self.assertIn("1000:1000", str(raised.exception))

    def test_entrypoint_mismatch_still_fails(self) -> None:
        module = self._module()
        values = {
            ("agent", ".Config.User"): "root",
            ("child", ".Config.User"): "1000:1000",
            ("agent", ".Config.Entrypoint"): ["/opt/hermes/bin/hermes"],
            ("child", ".Config.Entrypoint"): ["/bin/sh"],
            ("agent", ".Config.Cmd"): None,
            ("child", ".Config.Cmd"): None,
        }

        def inspect(image: str, field: str):
            return values[(image, field)]

        module.inspect = inspect  # type: ignore[method-assign]
        with mock.patch.dict(
            "os.environ", {"AGENT_IMAGE": "agent", "TEST_IMAGE": "child"}, clear=False
        ):
            with self.assertRaises(SystemExit) as raised:
                module.main()
            self.assertIn("Entrypoint", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
