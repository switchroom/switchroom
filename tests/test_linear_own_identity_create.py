"""Own-app issue and project creation. Transport is fake; no credentials."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from linear_fake_api import load_plugin

plugin = load_plugin()
from hermes_fleet_linear_plugin import BoundLinearAPI, chat
from hermes_fleet_linear_plugin.api import LinearAPI, LinearError

CLIENT = "0b8f5a7e-3c1d-4e2f-9a6b-7c8d9e0f1a2b"


def _ok(data: dict) -> tuple[int, dict, bytes]:
    return 200, {}, json.dumps({"data": data}).encode()


class OwnIdentityCreateTests(unittest.TestCase):
    def test_issue_create_nulls_assignee_and_delegate_and_reads_them_back(self) -> None:
        seen = []

        def transport(url, body, headers):
            payload = json.loads(body)
            query, variables = payload["query"], payload["variables"]
            if "issueCreate" in query:
                seen.append(variables["input"])
                return _ok({"issueCreate": {"success": True}})
            if "CreatedIssue" in query:
                created = seen[-1]
                return _ok({"issue": {
                    "id": created["id"], "identifier": "OPS-1", "title": created["title"], "url": "https://linear.app/x",
                    "team": {"id": created["teamId"], "key": "OPS"}, "project": None, "parent": None,
                    "assignee": None, "delegate": None}})
            raise AssertionError(query)

        created = LinearAPI(lambda: "synthetic", transport=transport).create_issue(CLIENT, "team-1", "Reconcile")
        self.assertEqual(seen[0]["assigneeId"], None)
        self.assertEqual(seen[0]["delegateId"], None)
        self.assertEqual(created["identifier"], "OPS-1")

    def test_issue_readback_reports_a_delegate_it_did_not_set(self) -> None:
        # The create sent delegateId null. A delegate on readback came from elsewhere (a Linear
        # rule or a person); the issue exists, so it is reported rather than refused into a retry.
        def transport(url, body, headers):
            query = json.loads(body)["query"]
            if "issueCreate" in query:
                return _ok({"issueCreate": {"success": True}})
            if "CreatedIssue" in query:
                return _ok({"issue": {
                    "id": CLIENT, "identifier": "OPS-1", "title": "Reconcile", "url": "u",
                    "team": {"id": "team-1", "key": "OPS"}, "project": None, "parent": None,
                    "assignee": None, "delegate": {"id": "someone"}}})
            raise AssertionError(query)

        created = LinearAPI(lambda: "synthetic", transport=transport).create_issue(CLIENT, "team-1", "Reconcile")
        self.assertEqual((created["id"], created["readback_differences"]), (CLIENT, ["delegate"]))

    def test_issue_create_sends_label_ids_and_reads_them_back(self) -> None:
        seen, stored = [], {}

        def transport(url, body, headers):
            payload = json.loads(body)
            query, variables = payload["query"], payload["variables"]
            if "issueCreate" in query:
                seen.append(variables["input"])
                return _ok({"issueCreate": {"success": True}})
            if "CreatedIssue" in query:
                self.assertIn("labels(first: 50)", query)
                return _ok({"issue": {
                    "id": CLIENT, "identifier": "OPS-1", "title": "Reconcile", "url": "u",
                    "team": {"id": "team-1", "key": "OPS"}, "project": None, "parent": None,
                    "assignee": None, "delegate": None, "labels": {"nodes": [{"id": i} for i in stored["ids"]]}}})
            raise AssertionError(query)

        api = LinearAPI(lambda: "synthetic", transport=transport)
        stored["ids"] = ["label-1"]
        created = api.create_issue(CLIENT, "team-1", "Reconcile", label_ids=["label-1"])
        self.assertEqual(seen[-1]["labelIds"], ["label-1"])
        self.assertNotIn("readback_differences", created)
        stored["ids"] = []  # a Linear rule or person removed it: reported, never refused into a retry
        created = api.create_issue(CLIENT, "team-1", "Reconcile", label_ids=["label-1"])
        self.assertEqual(created["readback_differences"], ["labels"])

    def test_issue_create_without_labels_sends_and_reads_none(self) -> None:
        def transport(url, body, headers):
            payload = json.loads(body)
            query, variables = payload["query"], payload["variables"]
            if "issueCreate" in query:
                self.assertNotIn("labelIds", variables["input"])
                return _ok({"issueCreate": {"success": True}})
            if "CreatedIssue" in query:
                self.assertNotIn("labels", query)
                return _ok({"issue": {
                    "id": CLIENT, "identifier": "OPS-1", "title": "Reconcile", "url": "u",
                    "team": {"id": "team-1", "key": "OPS"}, "project": None, "parent": None,
                    "assignee": None, "delegate": None}})
            raise AssertionError(query)

        for labels in (None, []):
            with self.subTest(labels=labels):
                created = LinearAPI(lambda: "synthetic", transport=transport).create_issue(
                    CLIENT, "team-1", "Reconcile", label_ids=labels)
                self.assertNotIn("readback_differences", created)

    def test_bound_team_labels_read_the_scoped_team_and_skip_groups(self) -> None:
        def transport(url, body, headers):
            payload = json.loads(body)
            query, variables = payload["query"], payload["variables"]
            if "IdentityBinding" in query:
                return _ok({"viewer": {"id": "app-a"}, "organization": {"id": "org-a"}})
            if query.lstrip().startswith("query Team("):
                return _ok({"team": {"id": "team-1" if variables["id"] == "OPS" else "team-other",
                                     "key": variables["id"]}})
            if "TeamLabels" in query:
                self.assertEqual(variables["id"], "team-1")
                return _ok({"team": {"id": "team-1", "labels": {"nodes": [
                    {"id": "l-1", "name": "shop", "isGroup": False},
                    {"id": "l-2", "name": "Area", "isGroup": True}], "pageInfo": {"hasNextPage": False}}}})
            raise AssertionError(query)

        identity = {"viewer_id": "app-a", "organization_id": "org-a", "teams": ["OPS"]}
        client = BoundLinearAPI(lambda: "synthetic", identity=identity, transport=transport)
        self.assertEqual(client.team_labels("OPS"), ([{"id": "l-1", "name": "shop"}], False))
        with self.assertRaises(LinearError):
            client.team_labels("OTHER")
        from test_linear_specialist_authorization import SCOPE
        scoped = BoundLinearAPI(lambda: "synthetic", identity=identity, specialist_scope=SCOPE, transport=transport)
        with self.assertRaises(LinearError):
            scoped.team_labels("OPS")

    def test_project_create_nulls_lead_and_reads_it_back(self) -> None:
        seen = []

        def transport(url, body, headers):
            payload = json.loads(body)
            query, variables = payload["query"], payload["variables"]
            if "projectCreate" in query:
                seen.append(variables["input"])
                return _ok({"projectCreate": {"success": True}})
            if "CreatedProject" in query:
                return _ok({"project": {
                    "id": CLIENT, "name": "Kept", "url": "https://linear.app/project",
                    "teams": {"nodes": [{"id": "team-1", "key": "OPS"}]}, "lead": None}})
            raise AssertionError(query)

        created = LinearAPI(lambda: "synthetic", transport=transport).create_project(CLIENT, "Kept", ["team-1"])
        self.assertEqual(seen[0]["leadId"], None)
        self.assertNotIn("assigneeId", seen[0])
        self.assertEqual(created["name"], "Kept")

    def test_bound_create_refuses_foreign_team_before_mutation(self) -> None:
        calls = []

        def transport(url, body, headers):
            query = json.loads(body)["query"]
            calls.append(query)
            if "IdentityBinding" in query:
                return _ok({"viewer": {"id": "app-a"}, "organization": {"id": "org-a"}})
            if query.lstrip().startswith("query Team"):
                return _ok({"team": {"id": "team-other", "key": "OTHER"}})
            raise AssertionError(query)

        client = BoundLinearAPI(lambda: "synthetic", identity={"viewer_id": "app-a", "organization_id": "org-a", "teams": ["OPS"]}, transport=transport)
        with self.assertRaises(LinearError):
            client.create_issue(CLIENT, "OTHER", "Reconcile")
        self.assertFalse(any("mutation" in query for query in calls))

    def test_bound_create_refuses_project_outside_selected_team_before_mutation(self) -> None:
        calls = []

        def transport(url, body, headers):
            payload = json.loads(body)
            query, variables = payload["query"], payload["variables"]
            calls.append(query)
            if "IdentityBinding" in query:
                return _ok({"viewer": {"id": "app-a"}, "organization": {"id": "org-a"}})
            if query.lstrip().startswith("query Team"):
                return _ok({"team": {"id": "team-1", "key": "OPS"}})
            if query.lstrip().startswith("query Project"):
                self.assertEqual(variables["id"], "project-foreign")
                return _ok({"project": {"id": "project-foreign", "archivedAt": None,
                                        "teams": {"nodes": [{"id": "team-other"}], "pageInfo": {"hasNextPage": False}}}})
            raise AssertionError(query)

        client = BoundLinearAPI(lambda: "synthetic", identity={
            "viewer_id": "app-a", "organization_id": "org-a", "teams": ["OPS"], "projects": ["project-foreign"]},
            transport=transport)
        with self.assertRaises(LinearError):
            client.create_issue(CLIENT, "OPS", "Reconcile", project_id="project-foreign")
        self.assertTrue(any(query.lstrip().startswith("query Project") for query in calls))
        self.assertFalse(any(query.lstrip().startswith("mutation") for query in calls))

    def test_bound_project_hint_lists_only_scoped_active_projects_of_a_scoped_team(self) -> None:
        def transport(url, body, headers):
            payload = json.loads(body)
            query, variables = payload["query"], payload["variables"]
            if "IdentityBinding" in query:
                return _ok({"viewer": {"id": "app-a"}, "organization": {"id": "org-a"}})
            if query.lstrip().startswith("query Team("):
                return _ok({"team": {"id": "team-1" if variables["id"] == "OPS" else "team-other",
                                     "key": variables["id"]}})
            if "TeamProjects" in query:
                self.assertEqual(variables["id"], "team-1")
                return _ok({"team": {"id": "team-1", "projects": {"nodes": [
                    {"id": "p-in", "name": "In scope", "completedAt": None, "canceledAt": None, "archivedAt": None},
                    {"id": "p-out", "name": "Out of scope", "completedAt": None, "canceledAt": None, "archivedAt": None},
                    {"id": "p-old", "name": "Finished", "completedAt": None, "canceledAt": "2026-10-01", "archivedAt": None}]}}})
            raise AssertionError(query)

        client = BoundLinearAPI(lambda: "synthetic", identity={
            "viewer_id": "app-a", "organization_id": "org-a", "teams": ["OPS"], "projects": ["p-in", "p-old"]},
            transport=transport)
        self.assertEqual(client.team_projects("OPS"), [{"id": "p-in", "name": "In scope"}])
        with self.assertRaises(LinearError):
            client.team_projects("OTHER")

    def test_bound_create_refuses_foreign_parent_before_mutation(self) -> None:
        calls = []

        def transport(url, body, headers):
            payload = json.loads(body)
            query, variables = payload["query"], payload["variables"]
            calls.append(query)
            if "IdentityBinding" in query:
                return _ok({"viewer": {"id": "app-a"}, "organization": {"id": "org-a"}})
            if query.lstrip().startswith("query Team"):
                return _ok({"team": {"id": "team-1", "key": "OPS"}})
            if "query Issue(" in query:
                return _ok({"issue": {"id": variables["id"], "identifier": variables["id"],
                                      "team": {"id": "OTHER", "key": "OTHER"}, "project": None}})
            raise AssertionError(query)

        client = BoundLinearAPI(lambda: "synthetic", identity={
            "viewer_id": "app-a", "organization_id": "org-a", "teams": ["OPS"]}, transport=transport)
        with self.assertRaises(LinearError):
            client.create_issue(CLIENT, "OPS", "Reconcile", parent_id="OTHER-9")
        self.assertFalse(any(query.lstrip().startswith("mutation") for query in calls))

    def test_bound_link_refuses_foreign_issue_before_mutation(self) -> None:
        calls = []

        def transport(url, body, headers):
            payload = json.loads(body)
            query, variables = payload["query"], payload["variables"]
            calls.append(query)
            if "IdentityBinding" in query:
                return _ok({"viewer": {"id": "app-a"}, "organization": {"id": "org-a"}})
            if "query Issue(" in query:
                key = "OPS" if variables["id"] == "OPS-1" else "OTHER"
                return _ok({"issue": {"id": variables["id"], "identifier": variables["id"], "team": {"id": key, "key": key}, "project": None}})
            raise AssertionError(query)

        client = BoundLinearAPI(lambda: "synthetic", identity={"viewer_id": "app-a", "organization_id": "org-a", "teams": ["OPS"]}, transport=transport)
        with self.assertRaises(LinearError):
            client.link_issue("OPS-1", "OTHER-2", "blocks")
        self.assertFalse(any(query.lstrip().startswith("mutation") for query in calls))

    def test_authoritative_agent_session_wrong_app_is_refused_for_all_scopes(self):
        from test_linear_specialist_authorization import Authority, SESSION, SCOPE
        authority = Authority()
        authority.sessions[SESSION]['appUser'] = {'id': 'foreign-app'}
        for scope in (None, SCOPE, {**SCOPE, 'requester_basis': 'agent_session'}):
            with self.subTest(scope=scope), self.assertRaises(LinearError):
                authority.api(scope=scope).agent_session(SESSION)
        self.assertEqual(authority.mutations, [])

    def test_chat_create_does_not_require_an_existing_issue_or_start_tracking(self) -> None:
        self.assertEqual(chat.SCHEMA["parameters"]["required"], ["action"])
        self.assertIn("create_issue", chat.SCHEMA["parameters"]["properties"]["action"]["enum"])
        self.assertIn("create_project", chat.SCHEMA["parameters"]["properties"]["action"]["enum"])
        self.assertIn("link_issue", chat.SCHEMA["parameters"]["properties"]["action"]["enum"])

        from hermes_fleet_linear_plugin.transport import NativeContext
        context = NativeContext(home=str(Path.cwd()), profile="alpha", platform="telegram", source="telegram",
                                session_key="chat", session_id="chat-id")

        class API:
            def create_issue(self, *args, **kwargs):
                return {"identifier": "OPS-9", "url": "https://linear.app/issue/OPS-9"}

            def issue(self, *args, **kwargs):
                raise AssertionError("create must not look up or track an issue")

        class Bridge:
            api, profile, profile_home = API(), "alpha", Path.cwd()

            def chat_profile_matches(self, profile, platform=""):
                return profile == self.profile

            def status(self, *args, **kwargs):
                raise AssertionError("create must not track")

        reply = json.loads(chat.handle(Bridge(), {"action": "create_issue", "id": CLIENT, "title": "Reconcile", "team": "OPS", "project": "none"}, context))
        self.assertTrue(reply["ok"])
        self.assertIn("undelegated", reply["message"])


if __name__ == "__main__":
    unittest.main()
