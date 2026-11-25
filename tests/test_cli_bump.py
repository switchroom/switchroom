"""CLI bump bot (HF-851): channel policy, group split, pin rewriting and the workflow contract. Offline."""
import importlib.util
import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("cli_bump", ROOT / "scripts/cli-bump.py")
bump = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bump)

OLD_OP = "b" * 64
NEW_OP = "c" * 64


def found(**over):
    base = {
        "claude-code": {"version": "2.1.326", "integrity": "sha512-NEWCC", "native_integrity": "sha512-NEWNATIVE"},
        "claude-agent-acp": {"version": "0.113.0", "integrity": "sha512-NEWACP"},
        "codex": {"version": "0.173.0", "integrity": "sha512-NEWCODEX"},
        "grok": {"version": "1.0.93", "integrity": "sha512-NEWGROK"},
        "opencode": {"version": "1.19.7", "integrity": "x"},
        "gh": {"version": "2.106.0", "sha256": "d" * 64, "asset_id": "999"},
        "op": {"version": "2.43.0", "digest": "sha256:" + NEW_OP},
    }
    base.update(over)
    return base


def have(**over):
    base = {"claude-code": "2.1.325", "claude-agent-acp": "0.112.0", "codex": "0.172.0", "grok": "1.0.92",
            "opencode": "1.19.6", "gh": "2.105.0", "op": "2.42.0"}
    base.update(over)
    return base


class PlanTests(unittest.TestCase):
    def test_groups_split_claude_from_the_rest(self):
        auto = bump.plan(have(), found(), "auto")
        review = bump.plan(have(), found(), "review")
        self.assertEqual([c["tool"] for c in auto], ["codex", "gh", "grok", "op", "opencode"])
        self.assertEqual([c["tool"] for c in review], ["claude-agent-acp", "claude-code"])

    def test_never_downgrades_or_repeats(self):
        self.assertEqual(bump.plan(have(codex="0.173.0"), found(), "auto")[0]["tool"], "gh")
        newer = have(codex="0.180.0", grok="1.0.93", opencode="1.19.7", gh="2.106.0", op="2.43.0")
        self.assertEqual(bump.plan(newer, found(), "auto"), [])

    def test_version_compare_is_numeric(self):
        self.assertEqual(bump.plan(have(codex="0.99.0"), {"codex": {"version": "0.100.0"}}, "auto")[0]["to"], "0.100.0")

    def test_claude_code_uses_stable_not_latest_and_rejects_prerelease(self):
        self.assertEqual(bump.NPM_TOOLS["claude-code"][1], "stable")
        calls = []
        bump.get_json = lambda url, token=None: calls.append(url) or {"dist-tags": {"stable": "2.1.1-beta.1"}}
        with self.assertRaises(SystemExit):
            bump.npm_latest("@anthropic-ai/claude-code", "stable")


class ApplyTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, True)
        for rel in bump.TEXT_FILES + ["package.json"]:
            (self.dir / rel).parent.mkdir(parents=True, exist_ok=True)
        (self.dir / "package.json").write_text(json.dumps({"dependencies": {
            "@agentclientprotocol/claude-agent-acp": "0.112.0", "@anthropic-ai/claude-code": "2.1.325",
            "@openai/codex": "0.172.0", "@xai-official/grok": "1.0.92", "opencode-ai": "1.19.6"}}))
        (self.dir / "Dockerfile").write_text(
            f"ARG ONEPASSWORD_CLI_IMAGE=docker.io/1password/op@sha256:{OLD_OP}\nARG GH_VERSION=2.105.0\n"
            f"ARG GH_LINUX_AMD64_SHA256={'a' * 64}\nARG GH_LINUX_AMD64_ASSET_ID=111\nARG CLAUDE_CODE_VERSION=2.1.325\n"
            f"ARG CODEX_VERSION=0.172.0\nRUN test \"$(/usr/local/bin/op --version)\" = \"2.42.0\"\n")
        (self.dir / ".github/workflows/fleet-image.yml").write_text(
            f'  CODEX_VERSION: "0.172.0"\n  CLAUDE_AGENT_ACP_VERSION: "0.112.0"\n  GROK_VERSION: "1.0.92"\n  CLAUDE_CODE_VERSION: "2.1.325"\n  op: docker.io/1password/op@sha256:{OLD_OP}\n'
            '  assert gh == "2.105.0"\n  assert op == "2.42.0"\n')
        (self.dir / "tests/test_image_release.py").write_text(
            'CLAUDE_CODE_VERSION = "2.1.325"\nCLAUDE_CODE_INTEGRITY = "sha512-OLDCC"\nCLAUDE_CODE_LINUX_X64_INTEGRITY = "sha512-OLDNATIVE"\n'
            'CODEX_VERSION = "0.172.0"\nCODEX_INTEGRITY = "sha512-OLDCODEX"\n'
            'GROK_INTEGRITY = "sha512-OLDGROK"\nCLAUDE_AGENT_ACP_INTEGRITY = "sha512-OLDACP"\n')
        (self.dir / "docs/image-release.md").write_text("Claude Code 2.1.325 sha512-OLDCC; keep 12.1.3250 and 2.1.3251 alone.\n")

    def run_group(self, group):
        changes = bump.plan(have(), found(), group)
        bump.apply(self.dir, changes)
        bump.verify(self.dir, changes)
        return changes

    def test_auto_group_rewrites_only_non_claude_pins(self):
        self.run_group("auto")
        docker = (self.dir / "Dockerfile").read_text()
        self.assertIn("ARG CODEX_VERSION=0.173.0", docker)
        self.assertIn("ARG GH_VERSION=2.106.0", docker)
        self.assertIn(f"ARG GH_LINUX_AMD64_SHA256={'d' * 64}", docker)
        self.assertIn("ASSET_ID=999", docker)
        self.assertIn(f"op@sha256:{NEW_OP}", docker)
        self.assertIn('"2.43.0"', docker)
        self.assertIn("ARG CLAUDE_CODE_VERSION=2.1.325", docker)
        self.assertNotIn(OLD_OP, (self.dir / ".github/workflows/fleet-image.yml").read_text())
        self.assertEqual(json.loads((self.dir / "package.json").read_text())["dependencies"]["@anthropic-ai/claude-code"], "2.1.325")
        self.assertIn('CODEX_INTEGRITY = "sha512-NEWCODEX"', (self.dir / "tests/test_image_release.py").read_text())

    def test_review_group_swaps_both_integrities_and_leaves_the_reviewed_gate_alone(self):
        self.run_group("review")
        tests = (self.dir / "tests/test_image_release.py").read_text()
        self.assertIn('CLAUDE_CODE_INTEGRITY = "sha512-NEWCC"', tests)
        self.assertIn('CLAUDE_CODE_LINUX_X64_INTEGRITY = "sha512-NEWNATIVE"', tests)
        self.assertIn("Claude Code 2.1.326 sha512-NEWCC", (self.dir / "docs/image-release.md").read_text())
        self.assertIn("12.1.3250 and 2.1.3251", (self.dir / "docs/image-release.md").read_text())
        self.assertFalse((self.dir / "plugins").exists())  # the script never creates or edits the claude-acp reviewed constants

    def test_body_marks_claude_for_review_and_auto_for_automerge(self):
        review = bump.body(bump.plan(have(), found(), "review"))
        auto = bump.body(bump.plan(have(), found(), "auto"))
        self.assertIn("needs-native-tool-review", review)
        self.assertIn("never auto-merged", review)
        self.assertIn("auto-merge is armed", auto)
        self.assertNotIn("needs-native-tool-review", auto)


class WorkflowContractTests(unittest.TestCase):
    text = (ROOT / ".github/workflows/cli-bump.yml").read_text()

    def test_claude_group_is_never_auto_merged(self):
        merges = re.findall(r"gh pr merge[^\n]*", self.text)
        self.assertEqual(len(merges), 1)
        self.assertIn('if [ "$GROUP" = auto ]', self.text.split(merges[0])[0].rsplit("\n", 2)[-2])
        self.assertNotIn("gh pr review", self.text)
        self.assertNotIn("--approve", self.text)
        self.assertNotIn("--admin", self.text)

    def test_runs_on_a_schedule_with_a_scoped_app_token_and_no_default_permissions(self):
        self.assertIn("schedule:", self.text)
        self.assertIn("permissions: {}", self.text)
        self.assertIn("create-github-app-token@", self.text)
        self.assertIn("github.repository == 'switchroom/switchroom'", self.text)
        self.assertEqual(set(re.findall(r"group: \[([^\]]+)\]", self.text)), {"auto, review"})

    def test_existing_bot_branch_is_updated_with_an_explicit_lease(self):
        # A bare --force-with-lease has no tracking ref after a main-only checkout and is rejected as stale info.
        self.assertNotRegex(self.text, r'--force-with-lease origin')
        self.assertIn('git ls-remote origin "refs/heads/$branch"', self.text)
        self.assertIn('--force-with-lease="refs/heads/$branch:${remote_head}"', self.text)

    def test_token_requests_only_scopes_the_installation_grants(self):
        # Asking for any scope the release bot installation lacks fails the token mint (422). checks/statuses/actions
        # read were tried and are not granted.
        perms = dict(re.findall(r"permission-([a-z-]+): (read|write)", self.text))
        self.assertEqual(perms, {"contents": "write", "pull-requests": "write", "workflows": "write"})

    def test_actions_are_pinned_to_commits(self):
        for use in re.findall(r"(?m)^\s*(?:- )?uses: (\S+)", self.text):
            self.assertRegex(use, r"@[0-9a-f]{40}$")


if __name__ == "__main__":
    unittest.main()
