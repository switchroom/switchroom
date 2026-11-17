from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/pr-auto-update.yml"
APP_TOKEN = "${{ steps.app-token.outputs.token }}"


def step(text: str, name: str) -> str:
    """The body of the named step up to the next step."""
    marker = f"      - name: {name}\n"
    body = text.split(marker, 1)[1]
    following = body.find("\n      - name: ")
    return body if following < 0 else body[:following]


class PrAutoUpdateWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.text = WORKFLOW.read_text(encoding="utf-8")

    def test_runs_after_main_moves_with_a_schedule_fallback_and_no_pr_trigger(self) -> None:
        on = self.text.split("\non:\n", 1)[1].split("\npermissions:", 1)[0]
        self.assertIn("  push:\n    branches: [main]\n", on)
        self.assertIn("  schedule:\n", on)
        self.assertRegex(on, r'cron: "\*/(5|10|15) \* \* \* \*"')
        for trigger in ("pull_request", "pull_request_target", "workflow_run:"):
            self.assertNotIn(trigger, on)
        self.assertIn("if: github.repository == 'switchroom/switchroom'", self.text)

    def test_one_sweep_at_a_time(self) -> None:
        self.assertIn("concurrency:\n", self.text)
        self.assertIn("  group: pr-auto-update\n", self.text)
        self.assertIn("  cancel-in-progress: false\n", self.text)

    def test_github_token_has_no_permissions(self) -> None:
        self.assertIn("\npermissions: {}\n", self.text)
        self.assertIn("    permissions: {}\n", self.text)
        # GITHUB_TOKEN grants are bare keys; the App's own scopes are permission-* inputs.
        for grant in ("contents", "pull-requests", "packages", "id-token", "actions", "attestations"):
            self.assertNotRegex(self.text, rf"(?m)^\s+{grant}:", grant)
        self.assertNotIn("write-all", self.text)
        self.assertNotIn("GITHUB_TOKEN:", self.text)
        self.assertNotIn("github.token", self.text)
        self.assertNotIn("actions/checkout", self.text)

    def test_app_token_is_this_repository_only_with_least_privilege(self) -> None:
        mint = step(self.text, "Mint a release bot token scoped to switchroom/switchroom")
        self.assertIn("id: app-token", mint)
        self.assertRegex(mint, r"uses: actions/create-github-app-token@[0-9a-f]{40}")
        self.assertIn("client-id: ${{ vars.RELEASE_BOT_APP_ID }}", mint)
        self.assertIn("private-key: ${{ secrets.RELEASE_BOT_PRIVATE_KEY }}", mint)
        self.assertIn("owner: switchroom", mint)
        self.assertIn("repositories: switchroom\n", mint)
        self.assertNotIn("hermes-fleet-private", mint)
        self.assertIn("permission-contents: write", mint)
        self.assertIn("permission-pull-requests: write", mint)
        self.assertIn("permission-workflows: write", mint)
        # Exactly these App scopes, no more: any new permission-* input must be a deliberate change here.
        self.assertEqual(
            set(re.findall(r"(?m)^\s+(permission-[a-z-]+:.*?)\s*$", mint)),
            {"permission-contents: write", "permission-pull-requests: write", "permission-workflows: write"},
        )
        self.assertEqual(len(re.findall(r"(?m)^\s+permission-", mint)), 3)
        self.assertNotIn("skip-token-revoke", self.text)
        # The token flows to one sink: gh's environment in the update step.
        self.assertEqual(self.text.count(APP_TOKEN), 1)
        self.assertIn(f"GH_TOKEN: {APP_TOKEN}", step(self.text, "Update behind auto-merge PRs"))

    def test_only_same_repo_auto_merge_prs_that_are_behind_are_updated_without_force(self) -> None:
        run = step(self.text, "Update behind auto-merge PRs")
        self.assertIn("--base main", run)
        self.assertIn(".autoMergeRequest != null", run)
        self.assertIn("(.isCrossRepository | not)", run)
        self.assertIn('[ "$mergeable" = "CONFLICTING" ]', run)
        self.assertIn("::warning title=PR auto-update skipped::", run)
        self.assertIn('[ "$state" != "BEHIND" ]', run)
        self.assertIn('pulls/$number/update-branch', run)
        self.assertIn('expected_head_sha="$head"', run)
        self.assertIn("-X PUT", run)
        for forbidden in ("git push", "--force", "rebase", "gh pr merge", "--admin"):
            self.assertNotIn(forbidden, re.sub(r"(?m)^\s*#.*$", "", run), forbidden)


if __name__ == "__main__":
    unittest.main()
