"""PR acceptance when the gateway's GitHub login may not read the Checks API.

A fine-grained token without checks:read is refused at check-runs (HTTP 403)
but can read pull requests and Actions. Those cases are proved from exact-head
Actions jobs with the safeguards of hermes-agent #133 / a3faa265; anything the
fallback cannot decide stays unverified, never accepted. The store recognises
which closeouts wait on GitHub rather than on a person.
"""
from __future__ import annotations

import json
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
OTHER_SHA = "b" * 40


def denied_receipt(sha: str = SHA, required=None) -> dict:
    """Core b81aa0b0's receipt when check-runs answers 403 to the ambient login."""
    return {"ok": False, "classification": "auth", "head_sha": sha, "pr_url": URL, "checks": [],
            "required": required if required is not None else [{"context": "Backend Pytest", "app_id": 15368}],
            "recovery": "Fix required failures, rerun infrastructure checks or wait, then retry completion.",
            "detail": (f"GitHub refused the acceptance read (HTTP 403 on repos/{REPO}/commits/{sha}/check-runs) "
                       "as the ambient gh login; fix that profile's GitHub credentials/access to the repository, "
                       "then retry completion.")}


class FakeGitHub:
    """Endpoint -> reply for the reads the fallback makes; anything else is a 404."""

    def __init__(self, *, merged=True, state="closed", head_sha=SHA, head_repo=REPO, base="main",
                 event="pull_request", run_repo=REPO, run_sha=SHA, path=".github/workflows/ci.yml",
                 jobs=(("Backend Pytest", "completed", "success"),), on_base=True):
        self.calls: list[str] = []
        self.pr = {"state": state, "merged": merged, "head": {"sha": head_sha, "ref": "fix/x", "repo": {"full_name": head_repo}},
                   "base": {"ref": base}}
        self.runs = [{"id": 11, "head_sha": run_sha, "event": event, "path": path, "run_attempt": 1,
                      "head_repository": {"full_name": run_repo}}]
        self.jobs = [{"id": 100 + n, "name": name, "status": status, "conclusion": conclusion, "run_attempt": 1,
                      "head_sha": run_sha, "html_url": f"https://github.com/{REPO}/actions/runs/11/job/{100 + n}"}
                     for n, (name, status, conclusion) in enumerate(jobs)]
        self.on_base = on_base
        self.after_reread = None  # a PR state for the final re-read only
        self.refuse: dict[str, Exception] = {}

    def __call__(self, endpoint: str, *, paginate: bool = False):
        self.calls.append(endpoint)
        for prefix, exc in self.refuse.items():
            if endpoint.startswith(prefix):
                raise exc
        if endpoint == f"repos/{REPO}/pulls/7":
            if self.after_reread is not None and self.calls.count(endpoint) > 1:
                return self.after_reread
            return self.pr
        if endpoint.startswith(f"repos/{REPO}/actions/runs?head_sha="):
            return [{"total_count": len(self.runs), "workflow_runs": self.runs}]
        if endpoint.startswith(f"repos/{REPO}/actions/runs/11/jobs"):
            return [{"total_count": len(self.jobs), "jobs": self.jobs}]
        if endpoint.startswith(f"repos/{REPO}/contents/") and self.on_base:
            return {"type": "file", "path": endpoint.split("/contents/")[1].split("?")[0]}
        raise acceptance.Denied(f"HTTP 404 on {endpoint.split('?')[0]}", "404")


class ActionsFallbackTests(unittest.TestCase):
    def settle(self, github, receipt=None):
        return acceptance.settle(receipt or denied_receipt(), URL, gh=github)

    def test_refused_checks_read_is_proved_from_exact_head_actions_jobs(self):
        github = FakeGitHub()
        receipt = self.settle(github)
        self.assertIs(receipt["ok"], True)
        self.assertEqual(receipt["classification"], "success")
        self.assertEqual(receipt["head_sha"], SHA)
        self.assertEqual(receipt["evidence_source"], "actions")
        self.assertNotIn("detail", receipt)
        self.assertEqual(receipt["checks"][0]["workflow"], ".github/workflows/ci.yml")
        # PR read, runs, base-branch workflow, jobs, then the final PR re-read.
        self.assertEqual(github.calls[0], f"repos/{REPO}/pulls/7")
        self.assertEqual(github.calls[-1], f"repos/{REPO}/pulls/7")
        self.assertTrue(any("/contents/.github/workflows/ci.yml?ref=main" in call for call in github.calls))

    def test_open_pr_with_passing_checks_is_accepted_too(self):
        self.assertIs(self.settle(FakeGitHub(state="open", merged=False))["ok"], True)

    def test_every_required_job_must_pass(self):
        required = [{"context": "Backend Pytest", "app_id": 15368}, {"context": "Lint", "app_id": 15368}]
        receipt = self.settle(FakeGitHub(), denied_receipt(required=required))
        self.assertFalse(receipt["ok"])
        self.assertEqual(receipt["classification"], "missing")
        self.assertFalse(acceptance.unverified(receipt))

    def test_failed_job_is_a_definite_failure(self):
        receipt = self.settle(FakeGitHub(jobs=(("Backend Pytest", "completed", "failure"),)))
        self.assertFalse(receipt["ok"])
        self.assertEqual(receipt["classification"], "failure")
        self.assertFalse(acceptance.unverified(receipt))
        self.assertIn("Backend Pytest", bridge.acceptance_cause(receipt, URL))

    def test_skipped_job_is_a_definite_answer_not_a_read_failure(self):
        receipt = self.settle(FakeGitHub(jobs=(("Backend Pytest", "completed", "skipped"),)))
        self.assertEqual(receipt["classification"], "infra")
        self.assertFalse(acceptance.unverified(receipt))

    def test_running_job_is_unverified(self):
        receipt = self.settle(FakeGitHub(jobs=(("Backend Pytest", "in_progress", None),)))
        self.assertFalse(receipt["ok"])
        self.assertEqual(receipt["classification"], "pending")
        self.assertTrue(acceptance.unverified(receipt))

    def assert_definite(self, receipt, words):
        """Refused for good: never accepted, and not mistaken for GitHub not answering."""
        self.assertFalse(receipt["ok"])
        self.assertEqual(receipt["classification"], "unprovable")
        self.assertFalse(acceptance.unverified(receipt))
        self.assertIn(words, receipt["detail"])
        self.assertNotIn("HTTP", receipt["detail"])

    def test_fork_head_is_refused_for_good(self):
        self.assert_definite(self.settle(FakeGitHub(head_repo="mallory/app")), "comes from a fork")

    def test_fork_run_on_the_same_sha_is_not_evidence(self):
        self.assert_definite(self.settle(FakeGitHub(run_repo="mallory/app")), "not trusted evidence")

    def test_run_on_another_sha_is_not_evidence(self):
        receipt = self.settle(FakeGitHub(run_sha=OTHER_SHA))
        self.assertFalse(receipt["ok"])
        self.assertFalse(acceptance.unverified(receipt))

    def test_pr_head_moved_from_the_recorded_head_is_asked_again(self):
        receipt = self.settle(FakeGitHub(head_sha=OTHER_SHA))
        self.assertFalse(receipt["ok"])
        self.assertEqual(receipt["classification"], "pending")
        self.assertTrue(acceptance.unverified(receipt))

    def test_head_moved_during_collection_is_asked_again_never_accepted(self):
        github = FakeGitHub(state="open", merged=False)
        github.after_reread = {**github.pr, "head": {**github.pr["head"], "sha": OTHER_SHA}}
        receipt = self.settle(github)
        self.assertFalse(receipt["ok"])
        self.assertEqual(receipt["classification"], "pending")

    def test_closed_without_merge_is_refused(self):
        receipt = self.settle(FakeGitHub(state="closed", merged=False))
        self.assertEqual(receipt["classification"], "closed")
        self.assertFalse(acceptance.unverified(receipt))

    def test_dispatch_only_runs_are_untrusted(self):
        self.assert_definite(self.settle(FakeGitHub(event="workflow_dispatch")), "not trusted evidence")

    def test_open_pr_without_any_run_yet_is_pending_not_missing(self):
        github = FakeGitHub(state="open", merged=False)
        github.runs = []
        receipt = self.settle(github)
        self.assertEqual(receipt["classification"], "pending")
        self.assertTrue(acceptance.unverified(receipt))
        github = FakeGitHub(state="open", merged=False)
        github.runs[0]["status"] = "in_progress"
        github.jobs = []
        self.assertEqual(self.settle(github)["classification"], "pending")

    def test_merged_pr_whose_completed_runs_lack_the_job_is_missing(self):
        github = FakeGitHub(state="open", merged=False)
        github.runs[0]["status"] = "completed"
        github.jobs = []
        receipt = self.settle(github)
        self.assertEqual(receipt["classification"], "missing")
        self.assertFalse(acceptance.unverified(receipt))
        github = FakeGitHub()
        github.runs = []
        self.assertEqual(self.settle(github)["classification"], "missing")

    def test_only_the_latest_attempt_of_a_rerun_counts(self):
        github = FakeGitHub(jobs=(("Backend Pytest", "completed", "failure"),))
        github.runs[0]["run_attempt"] = 2
        github.jobs[0]["run_attempt"] = 1  # the failed first attempt
        github.jobs.append({**github.jobs[0], "id": 200, "conclusion": "success", "run_attempt": 2})
        self.assertIs(self.settle(github)["ok"], True)
        github.jobs[1]["conclusion"] = "failure"
        github.jobs[0]["conclusion"] = "success"
        self.assertEqual(self.settle(github)["classification"], "failure")

    def test_same_job_name_in_two_workflows_must_pass_in_both(self):
        # As core does for check runs: each workflow's newest run counts, and all of them must pass.
        for older, newer, expected in (("failure", "success", "failure"), ("success", "failure", "failure"),
                                       ("success", "success", "success")):
            with self.subTest(older=older, newer=newer):
                github = FakeGitHub()
                github.runs.append({**github.runs[0], "id": 12, "path": ".github/workflows/other.yml"})
                github.jobs[0]["conclusion"] = older
                jobs12 = [{**github.jobs[0], "id": 300, "conclusion": newer}]
                original = github.__call__

                def reply(endpoint, *, paginate=False, original=original, jobs12=jobs12, github=github):
                    if endpoint.startswith(f"repos/{REPO}/actions/runs?head_sha="):
                        return [{"total_count": 2, "workflow_runs": github.runs}]
                    if endpoint.startswith(f"repos/{REPO}/actions/runs/12/jobs"):
                        return [{"total_count": 1, "jobs": jobs12}]
                    return original(endpoint, paginate=paginate)
                self.assertEqual(acceptance.settle(denied_receipt(), URL, gh=reply)["classification"], expected)

    def test_every_run_of_one_workflow_must_pass(self):
        # As core reads the latest check run of every workflow run: a push run and a pull_request run
        # of the same file both count, so an older failing run is not hidden by a newer passing one.
        for older, newer, expected in (("failure", "success", "failure"), ("success", "failure", "failure"),
                                       ("success", "success", "success")):
            with self.subTest(older=older, newer=newer):
                github = FakeGitHub()
                github.runs.append({**github.runs[0], "id": 12})  # the same workflow, run again (a new push event)
                github.jobs[0]["conclusion"] = older
                jobs12 = [{**github.jobs[0], "id": 300, "conclusion": newer}]
                original = github.__call__

                def reply(endpoint, *, paginate=False, original=original, jobs12=jobs12, github=github):
                    if endpoint.startswith(f"repos/{REPO}/actions/runs?head_sha="):
                        return [{"total_count": 2, "workflow_runs": github.runs}]
                    if endpoint.startswith(f"repos/{REPO}/actions/runs/12/jobs"):
                        return [{"total_count": 1, "jobs": jobs12}]
                    return original(endpoint, paginate=paginate)
                self.assertEqual(acceptance.settle(denied_receipt(), URL, gh=reply)["classification"], expected)

    def with_second_run(self, run, job):
        """A FakeGitHub whose head also has run 12 with one job, next to the passing pull_request run."""
        github = FakeGitHub()
        github.runs.append({**github.runs[0], "id": 12, **run})
        original = github.__call__

        def reply(endpoint, *, paginate=False):
            if endpoint.startswith(f"repos/{REPO}/actions/runs?head_sha="):
                return [{"total_count": 2, "workflow_runs": github.runs}]
            if endpoint.startswith(f"repos/{REPO}/actions/runs/12/jobs"):
                github.calls.append(endpoint)
                return [{"total_count": 1, "jobs": [{**github.jobs[0], "id": 500, **job}]}]
            return original(endpoint, paginate=paginate)
        return reply

    def test_a_failing_manual_run_refuses_despite_a_passing_pull_request_run(self):
        receipt = acceptance.settle(denied_receipt(), URL, gh=self.with_second_run(
            {"event": "workflow_dispatch"}, {"conclusion": "failure"}))
        self.assertFalse(receipt["ok"])
        self.assertEqual(receipt["classification"], "failure")
        self.assertFalse(acceptance.unverified(receipt))

    def test_an_unfinished_manual_run_is_pending(self):
        receipt = acceptance.settle(denied_receipt(), URL, gh=self.with_second_run(
            {"event": "workflow_dispatch", "status": "in_progress"}, {"status": "in_progress", "conclusion": None}))
        self.assertFalse(receipt["ok"])
        self.assertEqual(receipt["classification"], "pending")
        self.assertTrue(acceptance.unverified(receipt))

    def test_a_failing_run_from_another_repository_on_the_same_sha_refuses(self):
        receipt = acceptance.settle(denied_receipt(), URL, gh=self.with_second_run(
            {"head_repository": {"full_name": "mallory/app"}}, {"conclusion": "failure"}))
        self.assertFalse(receipt["ok"])
        self.assertEqual(receipt["classification"], "failure")

    def test_a_failing_run_of_a_workflow_not_on_base_refuses(self):
        github = FakeGitHub()
        github.runs.append({**github.runs[0], "id": 12, "path": ".github/workflows/added-by-pr.yml"})
        original = github.__call__

        def reply(endpoint, *, paginate=False):
            if endpoint.startswith(f"repos/{REPO}/actions/runs?head_sha="):
                return [{"total_count": 2, "workflow_runs": github.runs}]
            if endpoint.startswith(f"repos/{REPO}/actions/runs/12/jobs"):
                return [{"total_count": 1, "jobs": [{**github.jobs[0], "id": 501, "conclusion": "failure"}]}]
            if "/contents/.github/workflows/added-by-pr.yml" in endpoint:
                raise acceptance.Denied("HTTP 404 on contents", "404")
            return original(endpoint, paginate=paginate)
        self.assertEqual(acceptance.settle(denied_receipt(), URL, gh=reply)["classification"], "failure")

    def test_a_passing_manual_run_alone_is_still_not_enough(self):
        github = FakeGitHub(event="workflow_dispatch")
        receipt = self.settle(github)
        self.assertFalse(receipt["ok"])
        self.assertEqual(receipt["classification"], "unprovable")
        receipt = acceptance.settle(denied_receipt(), URL, gh=self.with_second_run(
            {"event": "workflow_dispatch"}, {"conclusion": "success"}))
        self.assertIs(receipt["ok"], True)  # it neither counts nor refuses next to a trusted pass

    def test_pull_request_target_is_ignored_as_evidence(self):
        receipt = self.settle(FakeGitHub(event="pull_request_target"))
        self.assertFalse(receipt["ok"])

    def test_required_job_only_from_a_workflow_missing_on_base_is_refused_for_good(self):
        self.assert_definite(self.settle(FakeGitHub(on_base=False)), "not on the base branch")

    def test_an_unrelated_new_workflow_in_the_pr_does_not_block(self):
        github = FakeGitHub()
        github.runs.append({**github.runs[0], "id": 12, "path": ".github/workflows/new-in-this-pr.yml"})
        original = github.__call__

        def reply(endpoint, *, paginate=False):
            if endpoint.startswith(f"repos/{REPO}/actions/runs?head_sha="):
                return [{"total_count": 2, "workflow_runs": github.runs}]
            if endpoint.startswith(f"repos/{REPO}/actions/runs/12/jobs"):
                return [{"total_count": 1, "jobs": [{**github.jobs[0], "id": 400, "name": "Docs preview"}]}]
            if "/contents/.github/workflows/new-in-this-pr.yml" in endpoint:
                raise acceptance.Denied("HTTP 404 on contents", "404")
            return original(endpoint, paginate=paginate)
        receipt = acceptance.settle(denied_receipt(), URL, gh=reply)
        self.assertIs(receipt["ok"], True)
        self.assertFalse(any("new-in-this-pr" in call for call in github.calls))

    def test_unpinned_or_third_party_requirement_is_refused_for_good(self):
        for app_id in (None, -1, 999):
            with self.subTest(app_id=app_id):
                github = FakeGitHub()
                receipt = self.settle(github, denied_receipt(required=[{"context": "Backend Pytest", "app_id": app_id}]))
                self.assert_definite(receipt, "not GitHub Actions jobs")
                self.assertEqual(github.calls, [])

    def test_refused_actions_read_is_undecided(self):
        github = FakeGitHub()
        github.refuse[f"repos/{REPO}/actions/runs?"] = acceptance.Denied("HTTP 403 on actions/runs", "403")
        receipt = self.settle(github)
        self.assertFalse(receipt["ok"])
        self.assertEqual(receipt["classification"], "auth")
        self.assertTrue(acceptance.unverified(receipt))

    def test_unavailable_github_is_undecided(self):
        github = FakeGitHub()
        github.refuse[f"repos/{REPO}/actions/runs/11/jobs"] = acceptance.Unavailable("GitHub rate limit on jobs")
        receipt = self.settle(github)
        self.assertEqual(receipt["classification"], "infra")
        self.assertTrue(acceptance.unverified(receipt))

    def test_incomplete_pagination_is_undecided(self):
        github = FakeGitHub()
        original = github.__call__

        def short(endpoint, *, paginate=False):
            reply = original(endpoint, paginate=paginate)
            if "/jobs" in endpoint:
                return [{"total_count": 5, "jobs": reply[0]["jobs"]}]
            return reply
        receipt = acceptance.settle(denied_receipt(), URL, gh=short)
        self.assertFalse(receipt["ok"])
        self.assertTrue(acceptance.unverified(receipt))

    def test_other_refusals_do_not_open_the_fallback(self):
        github = FakeGitHub(state="open", merged=False)  # an open PR: no merge to accept either
        for detail in ("GitHub refused the acceptance read (HTTP 404 on graphql acme/app) as the ambient gh login",
                       f"GitHub refused the acceptance read (HTTP 403 on repos/{REPO}/commits/{SHA}/statuses)",
                       f"GitHub refused the acceptance read (HTTP 403 on repos/other/app/commits/{SHA}/check-runs)",
                       f"GitHub refused the acceptance read (HTTP 403 on repos/{REPO}/commits/{OTHER_SHA}/check-runs)"):
            with self.subTest(detail=detail):
                receipt = {**denied_receipt(), "detail": detail}
                self.assertFalse(acceptance.checks_read_denied(receipt, URL))
                settled = acceptance.settle(receipt, URL, gh=github)
                self.assertFalse(settled["ok"])
                self.assertNotEqual(settled.get("evidence_source"), "actions")

    def test_unverified_core_receipt_is_told_apart_from_a_closed_pr(self):
        receipt = {"ok": False, "classification": "infra", "head_sha": None, "checks": [],
                   "detail": "GitHub acceptance evidence unavailable or incomplete; check gh authentication/API access and retry."}
        self.assertEqual(acceptance.settle(receipt, URL, gh=FakeGitHub(state="closed", merged=False))["classification"], "closed")
        self.assertEqual(acceptance.settle(receipt, URL, gh=FakeGitHub(state="open", merged=False))["classification"], "infra")
        self.assertEqual(acceptance.settle(receipt, URL, gh=FakeGitHub())["classification"], "success")  # merged

    def test_merged_pr_with_unreadable_checks_is_accepted_on_its_merge(self):
        # F28 (RCA 22 Nov 2026): 18 waits sat In Review for up to 4 days on merged PRs whose checks core
        # could not read (GraphQL refused). GitHub merges only once required checks pass: accept the merge.
        receipt = {"ok": False, "classification": "infra", "head_sha": None, "checks": [],
                   "detail": "GitHub acceptance evidence unavailable or incomplete; check gh authentication/API access and retry."}
        merged = acceptance.settle(receipt, URL, gh=FakeGitHub())
        self.assertIs(merged["pr_merged"], True)
        self.assertIs(merged["ok"], True)
        self.assertEqual((merged["head_sha"], merged["evidence_source"]), (SHA, "merged"))
        self.assertFalse(acceptance.unverified(merged))
        for head in (None, "short", {"sha": "not-a-sha"}):  # no readable head: unverified, nothing to wait for
            github = FakeGitHub()
            github.pr["head"] = head if not isinstance(head, dict) else head
            headless = acceptance.settle(receipt, URL, gh=github)
            self.assertIs(headless["pr_merged"], True)
            self.assertIs(headless["ok"], False)
            self.assertTrue(acceptance.unverified(headless))
        failed = {**receipt, "classification": "failure", "head_sha": SHA}  # a definite verdict is never overridden
        self.assertEqual(acceptance.settle(failed, URL, gh=FakeGitHub()), failed)
        for github in (FakeGitHub(state="open", merged=False), FakeGitHub(state="closed", merged=False),
                       FakeGitHub(state="closed", merged=1)):
            self.assertNotIn("pr_merged", acceptance.settle(receipt, URL, gh=github))
        github = FakeGitHub()
        github.refuse["repos/"] = acceptance.Unavailable("GitHub did not answer")
        self.assertEqual(acceptance.settle(receipt, URL, gh=github), receipt)

    def test_accepted_and_definite_core_receipts_pass_through_untouched(self):
        github = FakeGitHub()
        for receipt in ({"ok": True, "classification": "success", "head_sha": SHA},
                        {"ok": False, "classification": "failure", "head_sha": SHA},
                        {"ok": False, "classification": "missing", "head_sha": None}):
            self.assertIs(acceptance.settle(receipt, URL, gh=github), receipt)
        self.assertEqual(github.calls, [])


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


class BridgeAcceptanceTests(unittest.TestCase):
    def test_pr_acceptance_completes_core_receipt_from_actions(self):
        import sys
        import types
        core = types.ModuleType("hermes_cli.kanban_pr_acceptance")
        core.collect_acceptance = lambda contract, published: denied_receipt()
        package = sys.modules.get("hermes_cli") or types.ModuleType("hermes_cli")
        with patch.dict(sys.modules, {"hermes_cli": package, "hermes_cli.kanban_pr_acceptance": core}), \
                patch.object(acceptance, "gh_api", FakeGitHub()):
            receipt = bridge.pr_acceptance(URL)
        self.assertIs(receipt["ok"], True)

    def test_accepted_evidence_reports_whether_github_answered(self):
        cases = ((denied_receipt(), "auth"), ({"ok": False, "classification": "failure", "head_sha": SHA}, ""),
                 ({"ok": False, "classification": "pending", "head_sha": SHA, "checks": []}, "pending"))
        for receipt, expected in cases:
            with self.subTest(expected=expected), patch.object(bridge, "pr_acceptance", return_value=receipt):
                waiting, failures = [], []
                self.assertFalse(bridge.Bridge.accepted_evidence(object(), [URL], failures=failures, unverified=waiting))
                self.assertEqual(waiting, [(URL, expected, SHA)])

    def test_refusal_on_linear_has_no_internal_labels(self):
        causes = [bridge.acceptance_cause({"ok": False, "classification": "unprovable", "evidence_source": "actions",
                                           "detail": "the pull request comes from a fork"}, URL),
                  bridge.acceptance_cause({"ok": False, "classification": "infra", "evidence_source": "actions",
                                           "checks": [{"name": "Backend Pytest", "classification": "infra",
                                                       "conclusion": "cancelled"}]}, URL)]
        for cause in causes:
            with self.subTest(cause=cause):
                for where in ("kanban", "chat"):
                    text = bridge.acceptance_refusal([cause], where=where)
                    self.assertIn(URL, text)
                    for label in ("unprovable:", "infra:", "auth:", "source actions", "infra (conclusion"):
                        self.assertNotIn(label, text)
        text = bridge.acceptance_refusal([causes[1]], where="kanban")
        self.assertIn("required check Backend Pytest ended as cancelled", text)
        self.assertIn("comes from a fork", bridge.acceptance_refusal([causes[0]], where="kanban"))
        delivery = bridge.acceptance_refusal([causes[0]], where="delivery")
        self.assertTrue(delivery.startswith(acceptance.DELIVERY_REFUSAL))

    def test_waiting_sentence_is_plain_and_promises_only_what_happens(self):
        for cls in ("auth", "infra", "pending"):
            text = bridge.acceptance_waiting(URL, cls)
            self.assertIn(URL, text)
            self.assertIn("In Review", text)
            self.assertIn("checks again by itself", text)
            self.assertIn("moves to Done", text)
            self.assertIn("Blocked if one fails", text)
            self.assertNotIn("HTTP", text)
            self.assertNotIn("check-runs", text)


# Live text of the Blocked closeouts written by plugin f4665ce8 (LIFE-584 and peers), PR and SHA replaced.
LEGACY_AUTH_BLOCK = (
    "The work finished, but its pull request could not be verified as ready (https://github.com/acme/app/pull/7: "
    f"auth: GitHub refused the acceptance read (HTTP 403 on repos/acme/app/commits/{SHA}/check-runs) as the "
    "ambient gh login; fix that profile's GitHub credentials/access to the repository, then retry completion.). "
    "The issue stays open until the PR's required checks pass on its latest commit.")


class StoredCloseoutTests(unittest.TestCase):
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

    def test_auth_blocked_closeout_is_rechecked(self):
        self.closeout("blocked", LEGACY_AUTH_BLOCK)
        wait = self.store.acceptance_recheck("issue-1", "t_1")
        self.assertEqual((wait["kind"], wait["source_ms"], wait["url"], wait["classification"], wait["head_sha"]),
                         ("blocked", 1_000_000.0, URL, "auth", SHA))

    def test_a_done_that_failed_to_deliver_does_not_end_the_wait(self):
        self.store.update("issue-1", last_event_id=9)  # the completion event was consumed with the In Review
        self.store.enqueue("status", {"issue_id": "issue-1", "state": "in_review", "task_id": "t_1",
                                      "acceptance_wait": {"event_id": 9, "classification": "auth"}}, at=5)
        wait = self.store.acceptance_recheck("issue-1", "t_1")
        done = [("status", {"issue_id": "issue-1", "state": "done", "task_id": "t_1", "terminal": True,
                            "owner_issue_id": "issue-1", "write_started": False})]
        self.assertTrue(self.store.finish_acceptance_recheck("issue-1", wait, done, at=30))
        self.assertIsNone(self.store.acceptance_recheck("issue-1", "t_1"))  # pending Done: wait is over
        with self.store._tx() as db:  # the send-time re-verify refused it (GitHub's answer changed)
            db.execute("UPDATE outbox SET state='failed', attempts=3, payload=json_set(json_set(payload,"
                       "'$.failure_kind','rejected'), '$.last_error', ?) WHERE json_extract(payload,'$.state')='done'",
                       (acceptance.DELIVERY_REFUSAL + " (https://github.com/acme/app/pull/7: failure: build)",))
        again = self.store.acceptance_recheck("issue-1", "t_1")
        self.assertEqual((again["kind"], again["status_id"]), ("in_review", wait["status_id"]))
        self.assertTrue(self.store.finish_acceptance_recheck("issue-1", again, done, at=40))
        with self.store._tx() as db:
            db.execute("UPDATE outbox SET state='sent' WHERE state='pending' AND json_extract(payload,'$.state')='done'")
        self.assertIsNone(self.store.acceptance_recheck("issue-1", "t_1"))  # a delivered Done is final

    def test_a_done_linear_refused_ends_the_wait(self):
        # Review round 2 blocker: only the send-time acceptance refusal reopens a wait.
        self.store.update("issue-1", last_event_id=9)
        self.store.enqueue("status", {"issue_id": "issue-1", "state": "in_review", "task_id": "t_1",
                                      "acceptance_wait": {"event_id": 9, "classification": "auth"}}, at=5)
        wait = self.store.acceptance_recheck("issue-1", "t_1")
        done = [("status", {"issue_id": "issue-1", "state": "done", "task_id": "t_1", "terminal": True,
                            "owner_issue_id": "issue-1", "write_started": False})]
        self.assertTrue(self.store.finish_acceptance_recheck("issue-1", wait, done, at=30))
        for error in ("Linear issueUpdate rejected the mutation", None):
            with self.subTest(error=error), self.store._tx() as db:
                db.execute("UPDATE outbox SET state='failed', attempts=1, payload=json_set(json_set(payload,"
                           "'$.failure_kind','rejected'), '$.last_error', ?) WHERE json_extract(payload,'$.state')='done'",
                           (error,))
            self.assertIsNone(self.store.acceptance_recheck("issue-1", "t_1"))

    def test_a_settled_wait_is_not_rechecked(self):
        self.store.enqueue("status", {"issue_id": "issue-1", "state": "in_review", "task_id": "t_1",
                                      "acceptance_wait": {"event_id": 9, "classification": "auth"}}, at=5)
        wait = self.store.acceptance_recheck("issue-1", "t_1")
        self.store.settle_acceptance_recheck(wait["status_id"])
        self.assertIsNone(self.store.acceptance_recheck("issue-1", "t_1"))

    def test_this_builds_blocked_closeouts_are_final_even_with_matching_text(self):
        cancelled = LEGACY_AUTH_BLOCK.replace("pull/7: auth: GitHub refused", "pull/7: infra: required check Backend "
                                              "Pytest: infra (conclusion cancelled); GitHub refused")
        self.closeout("blocked", cancelled)
        self.assertIsNotNone(self.store.acceptance_recheck("issue-1", "t_1"))  # an older build's row qualifies
        self.setUp()
        self.closeout("blocked", cancelled, acceptance_final=True)
        self.assertIsNone(self.store.acceptance_recheck("issue-1", "t_1"))

    def test_infra_and_pending_blocked_closeouts_are_rechecked(self):
        for cls in ("infra", "pending"):
            with self.subTest(cls=cls):
                self.setUp()
                self.closeout("blocked", LEGACY_AUTH_BLOCK.replace("pull/7: auth:", f"pull/7: {cls}:"))
                self.assertIsNotNone(self.store.acceptance_recheck("issue-1", "t_1"))

    def test_real_failures_and_other_blocks_are_not_rechecked(self):
        for body in (LEGACY_AUTH_BLOCK.replace("pull/7: auth:", "pull/7: failure:"),
                     LEGACY_AUTH_BLOCK.replace("pull/7: auth:", "pull/7: stale:"),
                     "The run ended without evidence (a PR, merge, deploy check or findings link), so this issue stays unfinished.",
                     "Kanban task archived without accepted completion evidence. Work remains unfinished."):
            with self.subTest(body=body[:60]):
                self.setUp()
                self.closeout("blocked", body)
                self.assertIsNone(self.store.acceptance_recheck("issue-1", "t_1"))

    def test_unsent_or_settled_or_superseded_blocked_closeouts_are_not_rechecked(self):
        self.closeout("blocked", LEGACY_AUTH_BLOCK, sent=False)
        self.assertIsNone(self.store.acceptance_recheck("issue-1", "t_1"))
        with self.store._tx() as db:
            db.execute("UPDATE outbox SET state='sent'")
        wait = self.store.acceptance_recheck("issue-1", "t_1")
        self.store.settle_acceptance_recheck(wait["status_id"])
        self.assertIsNone(self.store.acceptance_recheck("issue-1", "t_1"))
        self.setUp()
        self.closeout("blocked", LEGACY_AUTH_BLOCK)
        self.store.enqueue("status", {"issue_id": "issue-1", "state": "todo", "task_id": "t_1"}, at=20)
        self.assertIsNone(self.store.acceptance_recheck("issue-1", "t_1"))

    def test_in_review_wait_names_its_event_and_ends_at_a_done_closeout(self):
        self.store.enqueue("status", {"issue_id": "issue-1", "state": "in_review", "task_id": "t_1",
                                      "acceptance_wait": {"event_id": 9, "classification": "auth"}}, at=5)
        wait = self.store.acceptance_recheck("issue-1", "t_1")
        self.assertEqual((wait["kind"], wait["event_id"]), ("in_review", 9))
        self.assertIsNone(self.store.acceptance_recheck("issue-1", "t_2"))
        # An ordinary In Review (review requested, unverified stage) is not waiting on GitHub.
        self.store.enqueue("status", {"issue_id": "issue-1", "state": "in_review", "task_id": "t_1"}, at=6)
        self.assertIsNone(self.store.acceptance_recheck("issue-1", "t_1"))

    def test_rechecked_closeout_is_written_once_and_only_while_current(self):
        self.closeout("blocked", LEGACY_AUTH_BLOCK)
        wait = self.store.acceptance_recheck("issue-1", "t_1")
        done = [("status", {"issue_id": "issue-1", "state": "done", "task_id": "t_1", "terminal": True,
                            "owner_issue_id": "issue-1"})]
        self.assertFalse(self.store.finish_acceptance_recheck("issue-1", {**wait, "status_id": "other"}, done, at=30))
        self.assertTrue(self.store.finish_acceptance_recheck("issue-1", wait, done, at=30))
        self.assertFalse(self.store.finish_acceptance_recheck("issue-1", wait, done, at=31))
        self.assertIsNone(self.store.acceptance_recheck("issue-1", "t_1"))
        states = [row["payload"]["state"] for row in self.store.pending()]
        self.assertEqual(states, ["done"])


if __name__ == "__main__":
    unittest.main()
