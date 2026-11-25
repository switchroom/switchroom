"""Coding work in a product repo gets its own project worktree; everything else stays in scratch.

Real upstream Kanban and projects, a real git repo with a remote, and a synthetic Linear. The
``workspace_projects`` setting maps a Linear label to a Hermes project; a chat start may name
the project with ``repo``. Native creation then anchors the task to ``<repo>/.worktrees/<id>``
on branch ``<slug>/<id>-<title>``, and native completion removes that worktree once it is clean.
"""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

import test_linear_chat_entrust_scenarios as entrust
from test_linear_chat_entrust_scenarios import CORE, ChatAuthority, ISSUE, NEW_ISSUE, VIEWER, now_iso

if CORE is None:
    from hermes_cli import kanban_db as kb


class Harness(unittest.TestCase):
    """The chat-entrust scenario fixture (real Kanban, synthetic Linear) without rerunning its tests."""
    setUp = entrust.ChatEntrustScenarios.setUp
    ask, create, tasks, flush = (getattr(entrust.ChatEntrustScenarios, name) for name in ("ask", "create", "tasks", "flush"))
    session_event = entrust.ChatEntrustScenarios.session_event
    human_delegation = entrust.ChatEntrustScenarios.human_delegation


TEAM_LABELS = [{"id": "label-shop", "name": "Storefront", "isGroup": False},
               {"id": "label-bug", "name": "Bug", "isGroup": False},
               {"id": "label-area", "name": "Area", "isGroup": True}]


class LabelAuthority(ChatAuthority):
    def __init__(self):
        super().__init__()
        self.labels: dict[str, list[str]] = {}

    def transport(self, url, body, headers):
        import json
        payload = json.loads(body)
        if "query TeamLabels(" in payload["query"]:
            self.requests.append(payload["query"])
            return 200, {}, json.dumps({"data": {"team": {"id": payload["variables"]["id"], "labels": {
                "nodes": TEAM_LABELS, "pageInfo": {"hasNextPage": False}}}}}).encode()
        if "issueCreate" in payload["query"]:
            fields = payload["variables"]["input"]
            reply = super().transport(url, body, headers)
            names = {label["id"]: label["name"] for label in TEAM_LABELS}
            if fields["id"] not in self.labels:  # a replay keeps the first create's labels
                self.labels[fields["id"]] = [names[label_id] for label_id in fields.get("labelIds", [])]
                self.issues[fields["id"]]["labels"] = {"nodes": [{"id": i} for i in fields.get("labelIds", [])]}
            return reply
        if "query IssueLabels(" in payload["query"]:
            self.requests.append(payload["query"])
            issue_id = (payload.get("variables") or {})["id"]
            nodes = [{"name": name} for name in self.labels.get(issue_id, [])]
            return 200, {}, json.dumps({"data": {"issue": {"id": issue_id, "labels": {"nodes": nodes}}}}).encode()
        return super().transport(url, body, headers)


def git(*args, cwd):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


@unittest.skipIf(CORE is not None, f"native upstream source unavailable ({CORE})")
class WorkspaceProjectScenarios(Harness):
    def setUp(self):
        super().setUp()
        self.authority = LabelAuthority()
        from hermes_fleet_linear_plugin.bridge import Bridge
        from hermes_fleet_linear_plugin.store import Store
        self.bridge = Bridge(Store(self.home / "linear.db"), self.authority.api(scope=None), self.board, profile="default",
                             settings={"workspace_projects": {"Storefront": "shop", "camofox": "missing-project"}})
        self.bridge.profile_home = self.home
        origin = self.home / "origin.git"
        self.repo = self.home / "canonical" / "shop"
        git("init", "-q", "--bare", "-b", "main", str(origin), cwd=self.home)
        git("clone", "-q", str(origin), str(self.repo), cwd=self.home)
        for key, value in (("user.email", "ci@example.invalid"), ("user.name", "CI")):
            git("config", key, value, cwd=self.repo)
        (self.repo / "README.md").write_text("synthetic\n")
        git("add", "README.md", cwd=self.repo)
        git("commit", "-q", "-m", "init", cwd=self.repo)
        git("push", "-q", "origin", "HEAD:main", cwd=self.repo)
        from hermes_cli import projects_db
        with projects_db.connect_closing() as conn:
            self.project_id = projects_db.create_project(conn, name="Shop", folders=[str(self.repo)], slug="shop")

    def label(self, issue_id, *names):
        self.authority.labels[issue_id] = list(names)

    def task(self, task_id):
        with self.board.conn() as conn:
            return kb.get_task(conn, task_id)

    def label_reads(self):
        return [query for query in self.authority.requests if "query IssueLabels(" in query]

    def assert_project_worktree(self, task_id):
        task = self.task(task_id)
        self.assertEqual(task.project_id, self.project_id)
        self.assertEqual(task.workspace_kind, "worktree")
        self.assertEqual(Path(task.workspace_path), self.repo / ".worktrees" / task_id)
        self.assertTrue(task.branch_name.startswith(f"shop/{task_id}-"), task.branch_name)  # native: slug/id-title
        self.assertIn("own git worktree and branch of the shop project", task.body)
        return task

    def test_human_delegation_of_a_labelled_issue_runs_in_a_project_worktree_removed_on_completion(self):
        self.label(ISSUE, "Bug", "storefront")  # matched ignoring case
        self.authority.issues[ISSUE]["delegate"] = {"id": VIEWER}
        self.authority.issues[ISSUE]["updatedAt"] = now_iso()
        self.assertTrue(self.human_delegation(ISSUE, "session-1"))
        [task_id] = self.tasks()
        task = self.assert_project_worktree(task_id)
        # Dispatch materializes the worktree on its deterministic branch.
        from hermes_cli import kanban_db_workspace as kbw
        workspace = kbw.resolve_workspace(task)
        self.assertEqual(workspace, self.repo / ".worktrees" / task_id)
        self.assertEqual(git("branch", "--show-current", cwd=workspace), task.branch_name)
        self.assertIn(str(workspace), git("worktree", "list", cwd=self.repo))
        # A clean, pushed worktree is removed when the task finishes; the canonical clone stays.
        with self.board.conn() as conn:
            self.assertTrue(kb.complete_task(conn, task_id, result="done"))
        self.assertFalse(workspace.exists())
        self.assertNotIn(str(workspace), git("worktree", "list", cwd=self.repo))
        self.assertTrue((self.repo / "README.md").exists())

    def test_unlabelled_or_ambiguous_issues_stay_in_scratch(self):
        self.label(ISSUE, "Bug", "Storefront", "camofox")  # two different projects: no guess
        self.authority.issues[ISSUE]["delegate"] = {"id": VIEWER}
        self.authority.issues[ISSUE]["updatedAt"] = now_iso()
        self.assertTrue(self.human_delegation(ISSUE, "session-1"))
        [task_id] = self.tasks()
        task = self.task(task_id)
        self.assertEqual((task.workspace_kind, task.project_id, task.branch_name), ("scratch", None, None))
        self.assertNotIn("own git worktree", task.body)

    def test_a_label_naming_an_unknown_project_falls_back_to_scratch(self):
        self.label(ISSUE, "camofox")
        reply = self.ask({"action": "work_on", "issue": ISSUE})
        self.assertTrue(reply["ok"], reply)
        task = self.task(reply["native"]["task_id"])
        self.assertEqual((task.workspace_kind, task.project_id), ("scratch", None))

    def test_chat_start_naming_the_repo_gets_a_project_worktree(self):
        reply = self.create(start_work=True, repo="shop")
        self.assertTrue(reply["ok"], reply)
        self.assert_project_worktree(reply["native"]["task_id"])

    def test_chat_work_on_follows_the_issue_label(self):
        self.label(ISSUE, "storefront")
        reply = self.ask({"action": "work_on", "issue": ISSUE})
        self.assertTrue(reply["ok"], reply)
        self.assert_project_worktree(reply["native"]["task_id"])

    def test_an_unknown_repo_or_repo_on_a_record_is_refused_before_any_write(self):
        for args in ({"action": "create_issue", "id": NEW_ISSUE, "title": "x", "team": "OPS", "start_work": True,
                      "repo": "elsewhere"},
                     {"action": "create_issue", "id": NEW_ISSUE, "title": "x", "team": "OPS", "repo": "shop"},
                     {"action": "work_on", "issue": ISSUE, "record_done": True, "summary": "Done.", "repo": "shop"},
                     {"action": "work_on", "issue": ISSUE, "repo": "missing"}):
            with self.subTest(args=args):
                reply = self.ask(args)
                self.assertFalse(reply["ok"], reply)
        self.assertNotIn(NEW_ISSUE, self.authority.issues)
        self.assertEqual(self.tasks(), [])
        self.assertFalse(any("issueCreate" in query for query in self.authority.mutations))

    def test_agent_filed_create_with_its_product_label_runs_in_the_project_worktree(self):
        reply = self.create(start_work=True, labels=["storefront", "BUG", "Storefront"])  # case and repeats folded
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(self.authority.labels[NEW_ISSUE], ["Storefront", "Bug"])
        self.assertEqual(len([query for query in self.authority.mutations if "issueCreate" in query]), 1)
        task = self.assert_project_worktree(reply["native"]["task_id"])
        from hermes_cli import kanban_db_workspace as kbw
        workspace = kbw.resolve_workspace(task)
        with self.board.conn() as conn:
            self.assertTrue(kb.complete_task(conn, task.id, result="done"))
        self.assertFalse(workspace.exists())

    def test_create_with_a_label_only_files_it_labelled(self):
        reply = self.create(labels=["Bug"])
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(self.authority.labels[NEW_ISSUE], ["Bug"])
        self.assertEqual(self.tasks(), [])

    def test_unknown_group_or_malformed_labels_are_refused_and_nothing_is_created(self):
        for labels, unknown in ((["storefront", "no-such-label"], ["no-such-label"]), (["Area"], ["Area"])):
            with self.subTest(labels=labels):
                reply = self.create(start_work=True, labels=labels)
                self.assertFalse(reply["ok"], reply)
                self.assertEqual(reply["code"], "unknown_label")
                self.assertEqual(reply["unknown"], unknown)
                self.assertIn("never created", reply["message"])
                self.assertEqual(reply["labels"], ["Bug", "Storefront"])
        for labels in ("storefront", [""], [3]):
            with self.subTest(labels=labels):
                reply = self.create(start_work=True, labels=labels)
                self.assertFalse(reply["ok"], reply)
        self.assertNotIn(NEW_ISSUE, self.authority.issues)
        self.assertEqual(self.tasks(), [])
        self.assertFalse(any("issueCreate" in query or "LabelCreate" in query for query in self.authority.mutations))

    def test_a_name_shared_by_two_labels_is_refused_without_a_guess(self):
        TEAM_LABELS.append({"id": "label-bug-2", "name": "bug", "isGroup": False})  # e.g. children of two groups
        self.addCleanup(TEAM_LABELS.pop)
        reply = self.create(labels=["Bug"])
        self.assertFalse(reply["ok"], reply)
        self.assertEqual((reply["code"], reply["ambiguous"], reply["unknown"]), ("unknown_label", ["Bug"], []))
        self.assertNotIn(NEW_ISSUE, self.authority.issues)

    def test_create_without_labels_reads_no_team_labels(self):
        reply = self.create()
        self.assertTrue(reply["ok"], reply)
        self.assertFalse(any("TeamLabels" in query for query in self.authority.requests))

    def test_record_done_never_gets_a_worktree(self):
        self.label(ISSUE, "storefront")
        reply = self.ask({"action": "work_on", "issue": ISSUE, "record_done": True, "summary": "Done in chat."})
        self.assertTrue(reply["ok"], reply)
        task = self.task(reply["native"]["task_id"])
        self.assertEqual((task.workspace_kind, task.project_id), ("scratch", None))


@unittest.skipIf(CORE is not None, f"native upstream source unavailable ({CORE})")
class WithoutWorkspaceProjects(Harness):
    """The setting is opt-in: without it nothing reads labels and every task stays in scratch."""

    def test_no_label_read_and_scratch(self):
        reply = self.ask({"action": "work_on", "issue": ISSUE})
        self.assertTrue(reply["ok"], reply)
        task_id = reply["native"]["task_id"]
        with self.board.conn() as conn:
            task = kb.get_task(conn, task_id)
        self.assertEqual((task.workspace_kind, task.project_id), ("scratch", None))
        self.assertFalse(any("IssueLabels" in query for query in self.authority.requests))

    def test_repo_is_refused_when_no_projects_are_configured(self):
        reply = self.ask({"action": "work_on", "issue": ISSUE, "repo": "shop"})
        self.assertFalse(reply["ok"], reply)
        self.assertIn("none configured", reply["message"])
        self.assertEqual(self.tasks(), [])


if __name__ == "__main__":
    unittest.main()
