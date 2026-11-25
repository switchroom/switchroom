from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github/workflows"
HANDOFF = WORKFLOWS / "release-handoff.yml"
FLEET_IMAGE = WORKFLOWS / "fleet-image.yml"
DOC = ROOT / "docs/image-release.md"

HEAD_SHA = "${{ github.event.workflow_run.head_sha }}"
RUN_ID = "${{ github.event.workflow_run.id }}"
APP_TOKEN = "${{ steps.app-token.outputs.token }}"


def job_header(text: str) -> str:
    """Everything between the stage-a job key and its first step."""
    return text.split("\n  stage-a:\n", 1)[1].split("\n    steps:\n", 1)[0]


def step(text: str, name: str) -> str:
    """The body of the named step up to the next step."""
    marker = f"      - name: {name}\n"
    body = text.split(marker, 1)[1]
    following = body.find("\n      - name: ")
    return body if following < 0 else body[:following]


class ReleaseHandoffWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.text = HANDOFF.read_text(encoding="utf-8")

    def test_triggers_only_on_completed_fleet_image_runs_of_main(self) -> None:
        self.assertIn(
            'on:\n  workflow_run:\n    workflows: ["Fleet Image"]\n    types: [completed]\n    branches: [main]\n',
            self.text,
        )
        self.assertEqual(self.text.count("\non:\n"), 1)
        for trigger in ("push:", "pull_request:", "workflow_dispatch:", "schedule:", "repository_dispatch:"):
            self.assertNotIn(trigger, self.text)
        self.assertEqual("name: Fleet Image\n", FLEET_IMAGE.read_text(encoding="utf-8").splitlines(keepends=True)[0])
        header = job_header(self.text)
        self.assertIn("github.event.workflow_run.conclusion == 'success'", header)
        self.assertIn("github.event.workflow_run.head_branch == 'main'", header)
        self.assertIn("github.event.workflow_run.event != 'pull_request'", header)
        self.assertIn("github.event.workflow_run.head_repository.full_name == github.repository", header)
        self.assertIn("github.repository == 'switchroom/switchroom'", header)
        self.assertIn("group: release-handoff-stage-a", self.text)
        self.assertIn("cancel-in-progress: false", self.text)

    def test_only_consumes_the_triggering_runs_artifact_bound_to_its_head_sha(self) -> None:
        upload = FLEET_IMAGE.read_text(encoding="utf-8")
        self.assertIn("name: fleet-image-handoff-${{ github.sha }}\n          path: fleet-image-handoff.json", upload)
        download = step(self.text, "Download the handoff manifest of the published commit")
        self.assertIn(f"name: fleet-image-handoff-{HEAD_SHA}", download)
        self.assertIn(f"run-id: {RUN_ID}", download)
        self.assertIn("github-token: ${{ github.token }}", download)
        self.assertIn("HANDOFF_ARTIFACT: fleet-image-handoff-${{ github.event.workflow_run.head_sha }}", self.text)
        self.assertIn("HANDOFF_FILE: ${{ github.workspace }}/handoff/fleet-image-handoff.json", self.text)
        bind = step(self.text, "Bind the handoff to the published head_sha")
        self.assertIn('if revision != expected:', bind)
        self.assertIn('os.environ["FLEET_SHA"]', bind)
        self.assertIn("https://github.com/switchroom/switchroom", bind)
        # github.sha is main's HEAD under workflow_run, never the published commit: it must not be used.
        self.assertNotIn("github.sha", self.text)
        self.assertNotIn("github.ref", self.text)
        for forbidden in ("docker", "build-push-action", "ghcr.io", "login-action", "attest"):
            self.assertNotIn(forbidden, self.text)

    def test_missing_artifact_is_a_notice_not_a_failure(self) -> None:
        locate = step(self.text, "Locate the triggering run's handoff artifact")
        self.assertIn("id: locate", locate)
        self.assertIn("GH_TOKEN: ${{ github.token }}", locate)
        self.assertIn('select(.expired | not)', locate)
        self.assertIn('grep -Fxq "$HANDOFF_ARTIFACT"', locate)
        self.assertIn('echo "present=false" >> "$GITHUB_OUTPUT"', locate)
        self.assertIn("::notice title=Stage A handoff skipped::", locate)
        self.assertIn("exit 0", locate)
        self.assertNotIn("continue-on-error", self.text)
        steps = re.findall(r"(?m)^      - name: (.+)$", self.text)
        self.assertEqual(steps[0], "Locate the triggering run's handoff artifact")
        for name in steps[1:]:
            self.assertIn("if: steps.locate.outputs.present == 'true'", step(self.text, name), name)

    def test_app_token_is_scoped_to_the_private_repository_only(self) -> None:
        mint = step(self.text, "Mint a release bot token scoped to hermes-fleet-private")
        self.assertIn("id: app-token", mint)
        self.assertIn("uses: actions/create-github-app-token@", mint)
        self.assertIn("client-id: ${{ vars.RELEASE_BOT_APP_ID }}", mint)
        self.assertIn("private-key: ${{ secrets.RELEASE_BOT_PRIVATE_KEY }}", mint)
        self.assertIn("owner: mekenthompson", mint)
        self.assertIn("repositories: hermes-fleet-private", mint)
        self.assertNotIn("repositories: hermes-fleet\n", mint)
        self.assertNotIn("hermes-agent", mint)
        # The token flows to exactly two sinks: the private checkout and gh's environment.
        self.assertEqual(self.text.count(APP_TOKEN), 2)
        checkout = step(self.text, "Check out the private release conductor")
        self.assertIn("repository: mekenthompson/hermes-fleet-private", checkout)
        self.assertIn("ref: main", checkout)
        self.assertIn(f"token: {APP_TOKEN}", checkout)
        self.assertIn("persist-credentials: false", checkout)
        self.assertIn("path: private", checkout)
        run = step(self.text, "Commit Stage A to private main")
        self.assertIn(f"GH_TOKEN: {APP_TOKEN}", run)
        self.assertNotIn("echo", run)
        self.assertNotIn("git config", self.text)
        self.assertNotIn("skip-token-revoke", self.text)

    def test_conductor_is_invoked_from_the_private_checkout_with_the_downloaded_handoff(self) -> None:
        run = step(self.text, "Commit Stage A to private main")
        self.assertIn("working-directory: private", run)
        self.assertIn("python3 scripts/release-conductor.py", run)
        # Global options precede the stage subcommand (argparse subparsers take no options).
        invocation = run.split("python3 scripts/release-conductor.py", 1)[1]
        for option in (
            '--workdir "$RUNNER_TEMP/conductor"',
            '--state "$RUNNER_TEMP/state.json"',
            '--fleet-handoff "$HANDOFF_FILE"',
        ):
            self.assertLess(invocation.index(option), invocation.index('"${stage[@]}"'), option)
        # HF-851 single workflow: Stage A is committed to private main; a conductor without that
        # stage falls back to the auto-merged Stage A PR (flags still before the stage name).
        selection = run.split("python3 scripts/release-conductor.py", 1)[0]
        self.assertIn("stage=(private-stage-a-commit)", selection)
        self.assertIn("stage=(--auto-merge private-stage-a-pr)", selection)
        self.assertIn("""grep -q '"private-stage-a-commit"' scripts/release-conductor.py""", selection)
        self.assertNotIn("--dry-run", invocation)
        self.assertNotIn("--core-commit", invocation)
        self.assertNotIn("run-all", invocation)

    def test_least_privilege_and_no_registry_write(self) -> None:
        self.assertIn("\npermissions:\n  contents: read\n", self.text)
        header = job_header(self.text)
        self.assertIn("permissions:\n      actions: read\n      contents: read\n", header)
        self.assertNotIn("packages:", self.text)
        self.assertNotIn("id-token:", self.text)
        self.assertNotIn("attestations:", self.text)
        self.assertNotIn("pull-requests:", self.text)
        self.assertNotIn("contents: write", self.text)
        self.assertNotIn("environment:", self.text)
        self.assertNotIn("write-all", self.text)
        self.assertNotIn("GITHUB_TOKEN", self.text)

    def test_release_bot_secret_is_referenced_only_by_handoffs_and_every_action_is_sha_pinned(self) -> None:
        workflows = sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml"))
        pin_handoff = WORKFLOWS / "plugin-pin-handoff.yml"
        pr_auto_update = WORKFLOWS / "pr-auto-update.yml"
        # The auto-revert bot pushes its revert branch with the App so the revert PR's CI runs.
        auto_revert = WORKFLOWS / "auto-revert.yml"
        # The CLI bump bot (HF-851) opens its PRs with the App so their CI runs (a GITHUB_TOKEN PR runs none).
        cli_bump = WORKFLOWS / "cli-bump.yml"
        allowed = {HANDOFF, pin_handoff, pr_auto_update, auto_revert, cli_bump}
        self.assertIn(auto_revert, workflows)
        self.assertIn(cli_bump, workflows)
        self.assertIn(HANDOFF, workflows)
        self.assertIn(pin_handoff, workflows)
        self.assertIn(pr_auto_update, workflows)
        for path in workflows:
            text = path.read_text(encoding="utf-8")
            if path in allowed:
                self.assertEqual(text.count("secrets."), 1, path)
                self.assertEqual(text.count("secrets.RELEASE_BOT_PRIVATE_KEY"), 1, path)
            else:
                self.assertNotIn("secrets.", text, path)
                self.assertNotIn("RELEASE_BOT", text, path)
            for uses in re.findall(r"(?m)^\s*-?\s*uses:\s*([^\s#]+)", text):
                self.assertRegex(uses, r"^[^@]+@[0-9a-f]{40}$", path)

    def test_plugin_pin_handoff_starts_after_green_main_ci(self) -> None:
        # Starting on the push raced CI, so the opener's green-CI guard always refused.
        text = (WORKFLOWS / "plugin-pin-handoff.yml").read_text(encoding="utf-8")
        on = text.split("\non:\n", 1)[1].split("\npermissions:", 1)[0]
        self.assertIn("workflow_run:", on)
        self.assertIn('workflows: ["CI"]', on)
        self.assertIn("types: [completed]", on)
        self.assertIn("branches: [main]", on)
        self.assertNotIn("push:", on)
        self.assertIn("github.event.workflow_run.conclusion == 'success'", text)
        self.assertIn("github.event.workflow_run.event == 'push'", text)
        self.assertIn("github.event.workflow_run.head_branch == 'main'", text)
        self.assertIn(f"ref: {HEAD_SHA}", text)
        self.assertIn(f"PUBLIC_SHA: {HEAD_SHA}", text)
        self.assertIn('--public-sha "$PUBLIC_SHA"', text)
        self.assertNotIn("github.sha", text)

    def test_documentation_describes_the_private_handoff(self) -> None:
        doc = DOC.read_text(encoding="utf-8")
        self.assertIn("## Private Stage A handoff", doc)
        section = doc.split("## Private Stage A handoff", 1)[1].split("\n## ", 1)[0]
        for phrase in (
            ".github/workflows/release-handoff.yml",
            "workflow_run",
            "hermes-release-bot",
            "hermes-fleet-private",
            "release-conductor.py",
            "private-stage-a-pr",
            "--auto-merge",
            "RELEASE_BOT_PRIVATE_KEY",
            "RELEASE_BOT_APP_ID",
            "head_sha",
            "nous-drift-baseline.json",
        ):
            self.assertIn(phrase, section, phrase)


if __name__ == "__main__":
    unittest.main()
