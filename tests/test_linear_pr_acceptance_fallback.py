"""What is left of PR acceptance once native Done is Linear Done (F28, 23 Nov 2026).

PR checks no longer gate a closeout. The plugin still reads a PR through ``gh api`` for the
closing note's state line, and the store still recognises the closeouts an older build left
waiting on PR acceptance, so they can be closed out again as Done.
"""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from linear_fake_api import load_plugin

load_plugin()
from hermes_fleet_linear_plugin import acceptance, bridge  # noqa: E402
from hermes_fleet_linear_plugin.store import Store  # noqa: E402

REPO = "acme/app"
URL = f"https://github.com/{REPO}/pull/7"
SHA = "a" * 40


class GhApiTests(unittest.TestCase):
    def run_with(self, stderr="", returncode=1, stdout="{}"):
        def fake(command, **kwargs):
            self.assertEqual(command[:2], ["gh", "api"])
            if returncode:
                raise subprocess.CalledProcessError(returncode, command, output="", stderr=stderr)
            return subprocess.CompletedProcess(command, 0, stdout=stdout, stderr="")
        with patch.object(acceptance.subprocess, "run", side_effect=fake):
            return acceptance.gh_api("repos/acme/app/pulls/7?x=1")

    def test_permission_refusal_is_denied_without_stderr(self):
        with self.assertRaises(acceptance.Denied) as caught:
            self.run_with("gh: Resource not accessible by personal access token (HTTP 403) token=ghp_SECRET")
        self.assertEqual(caught.exception.status, "403")
        self.assertNotIn("SECRET", str(caught.exception))
        self.assertIn("repos/acme/app/pulls/7", str(caught.exception))

    def test_rate_limit_is_unavailable_not_denied(self):
        with self.assertRaises(acceptance.Unavailable):
            self.run_with("gh: API rate limit exceeded for user (HTTP 403)")

    def test_reply_is_parsed(self):
        self.assertEqual(self.run_with(returncode=0, stdout='{"state": "open"}'), {"state": "open"})


class FakeGitHub:
    def __init__(self, *, state="open", merged=False, runs=None, refuse=()):
        self.pr = {"state": state, "merged": merged, "head": {"sha": SHA}}
        self.runs = runs if runs is not None else [{"status": "completed", "conclusion": "success"}]
        self.refuse = set(refuse)
        self.calls = []

    def __call__(self, endpoint, *, paginate=False):
        self.calls.append(endpoint)
        for prefix in self.refuse:
            if endpoint.startswith(prefix):
                raise acceptance.Denied(f"HTTP 403 on {prefix}", "403")
        if endpoint == f"repos/{REPO}/pulls/7":
            return self.pr
        if endpoint.startswith(f"repos/{REPO}/commits/{SHA}/check-runs"):
            return {"total_count": len(self.runs), "check_runs": self.runs}
        raise AssertionError(endpoint)


class PrStateTests(unittest.TestCase):
    def test_merged_closed_and_open_states(self):
        cases = (
            (FakeGitHub(state="closed", merged=True), "merged"),
            (FakeGitHub(state="closed", merged=False), "closed without merging"),
            (FakeGitHub(), "open, checks passed"),
            (FakeGitHub(runs=[{"status": "completed", "conclusion": "success"},
                              {"status": "completed", "conclusion": "failure"}]), "open, a check failed"),
            (FakeGitHub(runs=[{"status": "in_progress", "conclusion": None}]), "open, checks still running"),
            (FakeGitHub(runs=[]), "open, no checks reported"),
            (FakeGitHub(refuse=[f"repos/{REPO}/commits/"]), "open"),  # the checks read alone is refused
        )
        for github, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(bridge.pr_state(URL, gh=github), expected)

    def test_an_unreadable_pr_or_a_non_pr_link_says_nothing(self):
        self.assertIsNone(bridge.pr_state(URL, gh=FakeGitHub(refuse=["repos/"])))
        self.assertIsNone(bridge.pr_state("https://example.test/findings", gh=FakeGitHub()))

    def test_the_closing_note_names_each_pr_once_with_its_state(self):
        with patch.object(bridge, "pr_state", side_effect=["merged", None]):
            lines = bridge._pr_lines([URL, "https://example.test/x", URL, "https://github.com/acme/app/pull/8"])
        self.assertEqual(lines, f"\n\nPull request: {URL} (merged)\nPull request: https://github.com/acme/app/pull/8")
        self.assertEqual(bridge._pr_lines(["https://example.test/x"]), "")


LEGACY_AUTH_BLOCK = (
    "The work finished, but its pull request could not be verified as ready (https://github.com/acme/app/pull/7: "
    f"auth: GitHub refused the acceptance read (HTTP 403 on repos/acme/app/commits/{SHA}/check-runs) as the "
    "ambient gh login; fix that profile's GitHub credentials/access to the repository, then retry completion.). "
    "The issue stays open until the PR's required checks pass on its latest commit.")
EXPIRED_BLOCK = (f"The work is finished, but its pull request's checks could not be confirmed within 7 days ({URL}): "
                 "GitHub did not answer. The agent has stopped checking. Confirm the checks, then complete the work again.")


class LegacyCloseoutTests(unittest.TestCase):
    """The closeouts an older build left waiting on PR acceptance, found so they settle as Done."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.store = Store(Path(tmp.name) / "state.db")
        self.store.bind_native("issue-1", "t_1", "default", "default", at=0)

    def closeout(self, state, body, *, terminal=True, sent=True, **extra):
        status = {"issue_id": "issue-1", "state": state, "task_id": "t_1", "terminal": terminal,
                  "owner_issue_id": "issue-1", "source_ms": 1_000_000.0, "write_started": False, **extra}
        writes = [("status", status), ("comment", {"issue_id": "issue-1", "task_id": "t_1", "terminal": terminal,
                                                   "owner_issue_id": "issue-1", "body": body})]
        self.assertTrue(self.store.finish("issue-1", writes, at=10))
        if sent:
            with self.store._tx() as db:
                db.execute("UPDATE outbox SET state='sent', payload=json_set(payload,'$.applied',1)")

    def wait_in_review(self):
        self.store.update("issue-1", last_event_id=9)  # the completion event was consumed with the In Review
        self.store.enqueue("status", {"issue_id": "issue-1", "state": "in_review", "task_id": "t_1",
                                      "acceptance_wait": {"event_id": 9, "classification": "auth"}}, at=5)
        return self.store.legacy_closeout("issue-1", "t_1")

    DONE = [("status", {"issue_id": "issue-1", "state": "done", "task_id": "t_1", "terminal": True,
                        "owner_issue_id": "issue-1", "write_started": False})]

    def test_every_pr_refusal_blocked_closeout_is_found_including_final_ones(self):
        # Ken, 23 Nov 2026: all 16 finished-but-Blocked "PR could not be verified" issues settle as Done.
        for body, extra in ((LEGACY_AUTH_BLOCK, {}), (LEGACY_AUTH_BLOCK.replace("auth:", "failure:"), {"acceptance_final": True}),
                            (EXPIRED_BLOCK, {"acceptance_final": True})):
            with self.subTest(body=body[:60], **extra):
                self.setUp()
                self.closeout("blocked", body, **extra)
                self.assertEqual(self.store.legacy_closeout("issue-1", "t_1")["kind"], "blocked")

    def test_other_blocked_closeouts_and_unsent_ones_are_not_legacy(self):
        self.closeout("blocked", "The run ended without evidence (a PR, merge, deploy check or findings link), so this "
                                 "issue stays unfinished.", acceptance_final=True)
        self.assertIsNone(self.store.legacy_closeout("issue-1", "t_1"))
        self.setUp()
        self.closeout("blocked", LEGACY_AUTH_BLOCK, sent=False)
        self.assertIsNone(self.store.legacy_closeout("issue-1", "t_1"))

    def test_an_in_review_wait_is_written_over_once_and_only_while_current(self):
        wait = self.wait_in_review()
        self.assertEqual((wait["kind"], wait["event_id"]), ("in_review", 9))
        self.assertTrue(self.store.finish_legacy_closeout("issue-1", wait, self.DONE, at=30))
        self.assertIsNone(self.store.legacy_closeout("issue-1", "t_1"))  # a pending Done ends it
        self.assertFalse(self.store.finish_legacy_closeout("issue-1", wait, self.DONE, at=31))

    def test_a_done_refused_by_an_older_builds_reverify_does_not_end_it(self):
        wait = self.wait_in_review()
        self.assertTrue(self.store.finish_legacy_closeout("issue-1", wait, self.DONE, at=30))
        with self.store._tx() as db:
            db.execute("UPDATE outbox SET state='failed', attempts=3, payload=json_set(json_set(payload,"
                       "'$.failure_kind','rejected'), '$.last_error', ?) WHERE json_extract(payload,'$.state')='done'",
                       (Store.DELIVERY_REFUSAL + " (https://github.com/acme/app/pull/7: failure: build)",))
        again = self.store.legacy_closeout("issue-1", "t_1")
        self.assertEqual((again["kind"], again["status_id"]), ("in_review", wait["status_id"]))

    def test_a_settled_closeout_is_not_revisited(self):
        wait = self.wait_in_review()
        self.store.settle_legacy_closeout(wait["status_id"])
        self.assertIsNone(self.store.legacy_closeout("issue-1", "t_1"))


if __name__ == "__main__":
    unittest.main()
