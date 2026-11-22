"""Starting tracked work from chat finds the team and the issue the person named.

Live re-test 4 Nov 2026 (~00:10Z): "track it in Linear (project Fleet QA)". create_issue
without a team was refused ("needs title and team"), team KEN listed only KEN's projects, a guessed
team returned a raw "Entity not found: Team"; Fleet QA is in team HF. Then "Take over QA-10": QA-10
is the title prefix of HF-622 and status/work_on said "Entity not found: Issue". The refusals logged
reason=?. These run the real chat handler, the scoped API and the fake HTTP Linear.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from linear_fake_api import Clock, FakeLinear, SELF, load_plugin
from test_linear_specialist_authorization import FakeKanban

plugin = load_plugin()
from hermes_fleet_linear_plugin import api as api_module, chat, diag  # noqa: E402
from hermes_fleet_linear_plugin.bridge import Bridge  # noqa: E402
from hermes_fleet_linear_plugin.store import Store  # noqa: E402
from hermes_fleet_linear_plugin.transport import NativeContext  # noqa: E402


def not_found(entity: str) -> dict:
    return {"data": None, "errors": [{"message": f"Entity not found: {entity}",
                                      "extensions": {"code": "INPUT_ERROR", "type": "invalid input"}}]}


class ResolveRemote(FakeLinear):
    """Teams, projects and issue creation as Linear serves them to one app."""

    def __init__(self, clock: Clock) -> None:
        super().__init__(clock)
        self.created: list[dict] = []

    def _team(self, ref: str) -> dict | None:
        return next((team for team in self.teams if ref in (team["id"], team["key"])), None)

    def _apply(self, query, variables):
        if "IdentityBinding" in query:
            return 200, {"data": {"viewer": {"id": SELF}, "organization": {"id": "org-1"}}}
        if query.startswith("query Issue(") and not (self.issues.get(variables["id"]) or any(
                issue["identifier"] == variables["id"] for issue in self.issues.values())):
            return 200, not_found("Issue")  # Linear answers a missing key with an error, not null
        if query.startswith("query Team("):
            team = self._team(variables["id"])
            return (200, {"data": {"team": {"id": team["id"], "key": team["key"]}}}) if team else (200, not_found("Team"))
        if query.startswith("query TeamProjects"):
            team = self._team(variables["id"])
            if team is None:
                return 200, not_found("Team")
            nodes = [{key: project[key] for key in ("id", "name", "completedAt", "canceledAt", "archivedAt")}
                     for project in self.projects if team["id"] in project["team_ids"]]
            return 200, {"data": {"team": {"id": team["id"], "projects": {"nodes": nodes}}}}
        if query.startswith("query Project("):
            project = next((p for p in self.projects if p["id"] == variables["id"]), None)
            return 200, {"data": {"project": project and {
                "id": project["id"], "archivedAt": None,
                "teams": {"nodes": [{"id": team} for team in project["team_ids"]], "pageInfo": {"hasNextPage": False}}}}}
        if "issueCreate" in query:
            data = dict(variables["input"])
            team = self._team(data["teamId"])
            if team is None:
                return 200, not_found("Team")
            self.created.append(data)
            issue = self.add_issue(data["id"], f"{team['key']}-{900 + len(self.created)}", project=data.get("projectId"),
                                   title=data["title"], team=team)
            issue["description"] = data.get("description")
            return 200, {"data": {"issueCreate": {"success": True}}}
        return super()._apply(query, variables)


class ResolveBase(unittest.TestCase):
    def setUp(self) -> None:
        diag.reset()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.clock = Clock()
        self.remote = ResolveRemote(self.clock)
        self.addCleanup(self.remote.close)
        self.remote.add_team("team-ken", "KEN", "Ken")
        self.remote.add_team("team-hf", "HF", "Hermes Fleet")
        self.remote.add_project("proj-personal", "Personal", ["team-ken"])
        self.remote.add_project("proj-fleet-qa", "Fleet QA", ["team-hf"], slug="a1b2c3d4e5f6")
        self.remote.add_project("proj-roadmap-ken", "Roadmap", ["team-ken"])
        self.remote.add_project("proj-roadmap-hf", "Roadmap", ["team-hf"])
        self.remote.add_project("proj-old-qa", "Old QA", ["team-hf"], completed=True)
        self.store = Store(self.home / "state.db")
        self.api = plugin.BoundLinearAPI(lambda: "synthetic", endpoint=self.remote.url, clock=self.clock,
                                         identity={"viewer_id": SELF, "organization_id": "org-1"})
        self.bridge = Bridge(self.store, self.api, FakeKanban(), profile="synthetic", clock=self.clock)
        self.bridge.profile_home = self.home
        self.context = NativeContext(home=str(self.home), profile="synthetic", platform="slack", source="slack",
                                     session_key="chat", session_id="session")
        self.records: list[logging.LogRecord] = []
        handler = logging.Handler(logging.INFO)
        handler.emit = self.records.append
        logger = logging.getLogger(diag.LOGGER_NAME)
        logger.addHandler(handler)
        level = logger.level
        logger.setLevel(logging.INFO)
        self.addCleanup(logger.removeHandler, handler)
        self.addCleanup(logger.setLevel, level)

    def call(self, **args) -> dict:
        return json.loads(chat.handle(self.bridge, args, self.context))

    def create(self, **fields) -> dict:
        return self.call(action="create_issue", id=str(uuid.uuid4()), title="Back up 2 TB cheaply", **fields)

    def requests(self, name: str) -> int:
        return sum(request == name for request in self.remote.requests)

    def result_lines(self) -> list[str]:
        return [line for line in (r.getMessage() for r in self.records) if "action=tool.result" in line]


class ProjectLedTeamTests(ResolveBase):
    def test_project_only_resolves_its_team_and_says_so(self) -> None:
        reply = self.create(project="fleet qa")
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(self.remote.created[-1]["teamId"], "team-hf")
        self.assertEqual(self.remote.created[-1]["projectId"], "proj-fleet-qa")
        self.assertIn("Project 'Fleet QA' is in team HF", reply["message"])
        self.assertEqual(reply["issue"]["team"]["key"], "HF")

    def test_directory_is_cached_not_refetched_per_call(self) -> None:
        for _ in range(3):
            self.assertTrue(self.create(project="Fleet QA")["ok"])
        self.assertEqual(self.requests("query LinearDirectory"), 1)
        self.clock.now += api_module.DIRECTORY_TTL + 1
        self.assertTrue(self.create(project="Fleet QA")["ok"])
        self.assertEqual(self.requests("query LinearDirectory"), 2)

    def test_project_by_url_slug_or_id(self) -> None:
        for project in ("fleet-qa-a1b2c3d4e5f6", "https://linear.app/x/project/fleet-qa-a1b2c3d4e5f6", "proj-fleet-qa"):
            with self.subTest(project=project):
                reply = self.create(project=project)
                self.assertTrue(reply["ok"], reply)
                self.assertEqual(self.remote.created[-1]["projectId"], "proj-fleet-qa")

    def test_wrong_team_with_a_project_elsewhere_resolves_to_the_owner(self) -> None:
        reply = self.create(team="KEN", project="Fleet QA")
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(self.remote.created[-1]["teamId"], "team-hf")
        self.assertIn("is in team HF, not KEN", reply["message"])

    def test_the_named_team_still_wins_when_it_owns_the_project(self) -> None:
        reply = self.create(team="KEN", project="Roadmap")
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(self.remote.created[-1]["projectId"], "proj-roadmap-ken")
        self.assertEqual(self.requests("query LinearDirectory"), 0)  # the team's own list answered
        self.assertNotIn("is in team", reply["message"])

    def test_ambiguous_project_returns_team_project_choices(self) -> None:
        reply = self.create(project="Roadmap")
        self.assertFalse(reply["ok"])
        self.assertEqual(reply["code"], "ambiguous_project")
        self.assertEqual(sorted((c["team"], c["project"]) for c in reply["choices"]),
                         [("HF", "Roadmap"), ("KEN", "Roadmap")])
        self.assertIn("Hermes Fleet (HF) / Roadmap", reply["message"])
        self.assertEqual(self.remote.created, [])

    def test_wrong_team_and_an_ambiguous_project_returns_choices(self) -> None:
        reply = self.create(team="ABC", project="Roadmap")
        self.assertEqual(reply["code"], "ambiguous_project")
        self.assertEqual(self.remote.created, [])

    def test_unknown_team_is_a_plain_refusal_listing_team_keys(self) -> None:
        for fields in ({"team": "QA", "project": "none"}, {"team": "QA"}):
            with self.subTest(fields=fields):
                reply = self.create(**fields)
                self.assertFalse(reply["ok"])
                self.assertEqual(reply["code"], "unknown_team")
                self.assertIn("No Linear team 'QA' is visible to this app", reply["message"])
                self.assertIn("ABC, HF, KEN", reply["message"])
                self.assertNotIn("GraphQL", reply["message"])
                self.assertIn({"team": "HF", "name": "Hermes Fleet", "projects": ["Fleet QA", "Roadmap"]},
                              reply["teams"])
        self.assertEqual(self.remote.created, [])

    def test_unknown_team_with_a_known_project_uses_the_project(self) -> None:
        reply = self.create(team="QA", project="Fleet QA")
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(self.remote.created[-1]["teamId"], "team-hf")
        self.assertIn("no team 'QA' is visible", reply["message"])

    def test_project_none_without_a_team_names_the_team_keys(self) -> None:
        reply = self.create(project="none")
        self.assertEqual(reply["code"], "team_required")
        self.assertIn("ABC, HF, KEN", reply["message"])
        self.assertTrue(self.create(project="none", team="hf")["ok"])
        self.assertEqual(self.remote.created[-1]["teamId"], "team-hf")
        self.assertNotIn("projectId", self.remote.created[-1])

    def test_a_team_named_in_another_case_or_by_name_is_used(self) -> None:
        for team in ("ken", "Ken"):
            with self.subTest(team=team):
                reply = self.create(team=team, project="Roadmap")
                self.assertTrue(reply["ok"], reply)
                self.assertEqual(self.remote.created[-1]["projectId"], "proj-roadmap-ken")

    def test_no_team_and_no_project_lists_teams_with_projects(self) -> None:
        reply = self.create()
        self.assertEqual(reply["code"], "project_required")
        self.assertNotIn("needs title and team", reply["message"])
        self.assertEqual([row["team"] for row in reply["teams"]], ["ABC", "HF", "KEN"])
        self.assertEqual(self.remote.created, [])

    def test_project_nowhere_refuses_with_the_directory_after_one_fresh_read(self) -> None:
        self.assertTrue(self.create(project="Fleet QA")["ok"])
        self.clock.now += api_module.DIRECTORY_MISS_REFRESH + 1
        reply = self.create(project="Fleet Ops")
        self.assertEqual(reply["code"], "project_required")
        self.assertIn("any team this app can see", reply["message"])
        self.assertIn("teams", reply)
        self.assertEqual(self.requests("query LinearDirectory"), 2)
        self.create(project="Fleet Ops")  # a fresh directory is not refetched for a repeat miss
        self.assertEqual(self.requests("query LinearDirectory"), 2)

    def test_a_project_created_seconds_ago_resolves_after_a_miss_refresh(self) -> None:
        self.assertTrue(self.create(project="Fleet QA")["ok"])
        self.remote.add_project("proj-new", "Fleet Ops", ["team-hf"])
        self.clock.now += api_module.DIRECTORY_MISS_REFRESH + 1
        reply = self.create(project="Fleet Ops")
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(self.remote.created[-1]["projectId"], "proj-new")

    def test_finished_projects_do_not_resolve(self) -> None:
        reply = self.create(project="Old QA")
        self.assertEqual(reply["code"], "project_required")

    def test_identity_scope_narrows_the_directory(self) -> None:
        self.api.identity["teams"] = ["KEN"]
        reply = self.create(project="Fleet QA")
        self.assertEqual(reply["code"], "project_required")
        self.assertEqual([row["team"] for row in reply["teams"]], ["KEN"])
        self.assertTrue(self.create(project="Roadmap")["ok"])
        self.assertEqual(self.remote.created[-1]["projectId"], "proj-roadmap-ken")

    def test_parent_supplies_team_and_project(self) -> None:
        self.remote.add_issue("parent-1", "HF-600", project="proj-fleet-qa", team={"id": "team-hf", "key": "HF"})
        reply = self.create(parent="HF-600")
        self.assertTrue(reply["ok"], reply)
        self.assertEqual((self.remote.created[-1]["teamId"], self.remote.created[-1]["projectId"]),
                         ("team-hf", "proj-fleet-qa"))


class DuplicateProjectAcrossTeamsTests(ResolveBase):
    """Live 4 Nov 2026: two active "Fleet QA" projects, in HF (d0bfc6915e80, HF-621..623) and in the
    household team (45b007ad5677, created 2 Nov). No profile has a home team, so nobody guesses."""

    def setUp(self) -> None:
        super().setUp()
        self.remote.projects = [p for p in self.remote.projects if p["id"] != "proj-fleet-qa"]
        self.remote.add_project("proj-fleet-qa-hf", "Fleet QA", ["team-hf"], slug="d0bfc6915e80")
        self.remote.add_team("team-life", "LIFE", "Life")
        self.remote.add_project("proj-fleet-qa-life", "Fleet QA", ["team-life"], slug="45b007ad5677")

    def test_no_team_asks_the_user_by_team_name_and_creates_nothing(self) -> None:
        reply = self.create(project="Fleet QA", start_work=True)
        self.assertFalse(reply["ok"])
        self.assertEqual(reply["code"], "ambiguous_project")
        self.assertEqual(sorted((c["team"], c["team_name"]) for c in reply["choices"]),
                         [("HF", "Hermes Fleet"), ("LIFE", "Life")])
        self.assertIn("Do not guess", reply["message"])
        self.assertIn("clarify", reply["message"])
        self.assertRegex(reply["message"], r'"(Hermes Fleet or Life|Life or Hermes Fleet)\?"')
        self.assertNotIn("do not ask the user", reply["message"].casefold())
        self.assertEqual(self.remote.created, [])

    def test_the_team_the_user_names_picks_its_project(self) -> None:
        for team, project in (("HF", "proj-fleet-qa-hf"), ("LIFE", "proj-fleet-qa-life"), ("hermes fleet", "proj-fleet-qa-hf")):
            with self.subTest(team=team):
                reply = self.create(project="Fleet QA", team=team)
                self.assertTrue(reply["ok"], reply)
                self.assertEqual(self.remote.created[-1]["projectId"], project)

    def test_once_the_household_copy_is_archived_fleet_qa_resolves_to_hf(self) -> None:
        # Live 4 Nov 2026 01:15:28Z: the stray household "Fleet QA" was archived.
        self.remote.projects = [p for p in self.remote.projects if p["id"] != "proj-fleet-qa-life"]
        self.remote.add_project("proj-fleet-qa-life", "Fleet QA", ["team-life"], slug="45b007ad5677", archived=True)
        reply = self.create(project="Fleet QA")
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(self.remote.created[-1]["projectId"], "proj-fleet-qa-hf")
        self.assertIn("is in team HF", reply["message"])
        self.assertEqual(self.create(project="https://linear.app/x/project/fleet-qa-45b007ad5677/overview")["code"],
                         "project_required")  # an archived project is not resolvable even by its URL
        listed = {row["team"]: row["projects"] for row in self.create()["teams"]}
        self.assertEqual(listed["LIFE"], [])

    def test_a_team_owning_neither_still_asks(self) -> None:
        self.assertEqual(self.create(project="Fleet QA", team="KEN")["code"], "ambiguous_project")
        self.assertEqual(self.remote.created, [])

    def test_a_pasted_project_url_is_exact(self) -> None:
        for url in ("https://linear.app/x/project/fleet-qa-45b007ad5677/overview",
                    "https://linear.app/x/project/fleet-qa-d0bfc6915e80/issues/"):
            with self.subTest(url=url):
                self.assertTrue(self.create(project=url)["ok"])
        self.assertEqual([c["projectId"] for c in self.remote.created], ["proj-fleet-qa-life", "proj-fleet-qa-hf"])


class TitleAliasTests(ResolveBase):
    def setUp(self) -> None:
        super().setUp()
        hf = {"id": "team-hf", "key": "HF"}
        self.remote.add_issue("issue-622", "HF-622", title="QA-10: list the 10 most recent commits", team=hf)
        self.remote.add_issue("issue-700", "HF-700", title="QA-100: unrelated", team=hf)
        self.clock.now += 5
        self.remote.add_issue("issue-610", "HF-610", title="QA-11: first take", team=hf)
        self.remote.add_issue("issue-611", "HF-611", title="QA-11 second take", team=hf)

    def test_status_resolves_a_title_prefix_and_names_the_key(self) -> None:
        reply = self.call(action="status", issue="QA-10")
        self.assertTrue(reply["ok"], reply)
        self.assertTrue(reply["message"].startswith("QA-10 is HF-622"))
        self.assertEqual(reply["issue"]["identifier"], "HF-622")
        self.assertEqual(reply["resolved_issue"]["issue"], "HF-622")

    def test_work_on_starts_the_resolved_issue(self) -> None:
        started = []

        def entrust(bridge, issue, record, context):
            started.append(issue["identifier"])
            return {"native": {"status": "ready", "created_from_chat": True}, "routing": "queued"}
        with patch.object(chat, "_entrust", entrust):
            reply = self.call(action="work_on", issue="QA-10")
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(started, ["HF-622"])
        self.assertTrue(reply["message"].startswith("QA-10 is HF-622"))
        self.assertEqual(reply["resolved_issue"]["from"], "QA-10")
        self.assertEqual(reply["issue"]["identifier"], "HF-622")

    def test_a_closed_single_match_is_shown_but_never_started(self) -> None:
        self.remote.set_state("issue-622", "Done")
        started = []
        with patch.object(chat, "_entrust", lambda bridge, issue, *a: started.append(issue) or {}):
            for action in ("work_on", "track", "followup"):
                with self.subTest(action=action):
                    reply = self.call(action=action, issue="QA-10", task_id="t_0a1b2c3d", body="go",
                                      id=str(uuid.uuid4()))
                    self.assertEqual(reply["code"], "alias_closed")
                    self.assertIn("which is Done", reply["message"])
                    self.assertEqual(reply["choices"][0]["state"], "Done")
        self.assertEqual(started, [])
        status = self.call(action="status", issue="QA-10")
        self.assertTrue(status["ok"], status)
        self.assertEqual(status["resolved_issue"]["state"], "Done")

    def test_free_text_is_never_title_searched(self) -> None:
        self.remote.add_issue("issue-login", "HF-650", title="login broken", team={"id": "team-hf", "key": "HF"})
        for action in ("work_on", "track", "followup", "status"):
            with self.subTest(action=action):
                reply = self.call(action=action, issue="login", task_id="t_0a1b2c3d", body="go", id=str(uuid.uuid4()))
                self.assertEqual(reply["code"], "not_found")
        self.assertEqual(self.requests("query IssueTitleSearch"), 0)

    def test_a_cut_off_search_page_never_starts_work(self) -> None:
        for n in range(3):
            self.remote.add_issue(f"issue-x{n}", f"HF-80{n}", title=f"QA-3{n} other", team={"id": "team-hf", "key": "HF"})
        self.clock.now += 60  # the newest update: first on the cut-off page
        self.remote.add_issue("issue-qa3", "HF-803", title="QA-3: the one", team={"id": "team-hf", "key": "HF"})
        with patch.object(api_module, "TITLE_SEARCH_PAGE", 2), patch.object(chat, "_entrust") as entrust:
            reply = self.call(action="work_on", issue="QA-3")
            self.assertEqual(reply["code"], "ambiguous_issue")
            self.assertIn("cut off", reply["message"])
            entrust.assert_not_called()

    def test_an_expected_miss_is_not_logged_as_an_error(self) -> None:
        with self.assertLogs(diag.LOGGER_NAME, level="DEBUG") as logs:
            self.call(action="status", issue="QA-10")
        self.assertFalse([line for line in logs.output if line.startswith("ERROR")])
        self.assertTrue(any("expected miss" in line for line in logs.output))

    def test_ambiguous_alias_returns_choices(self) -> None:
        reply = self.call(action="status", issue="QA-11")
        self.assertFalse(reply["ok"])
        self.assertEqual(reply["code"], "ambiguous_issue")
        self.assertEqual(sorted(choice["issue"] for choice in reply["choices"]), ["HF-610", "HF-611"])
        self.assertEqual({choice["state"] for choice in reply["choices"]}, {"Todo"})
        self.assertIn("clarify", reply["message"])

    def test_no_match_is_a_plain_not_found(self) -> None:
        for ref in ("QA-99", "QA-1"):
            with self.subTest(ref=ref):
                reply = self.call(action="status", issue=ref)
                self.assertEqual(reply["code"], "not_found")
                self.assertNotIn("GraphQL", reply["message"])

    def test_an_unknown_uuid_is_not_found_without_a_title_search(self) -> None:
        reply = self.call(action="status", issue=str(uuid.uuid4()))
        self.assertEqual(reply["code"], "not_found")
        self.assertEqual(self.requests("query IssueTitleSearch"), 0)

    def test_an_exact_key_never_title_searches(self) -> None:
        self.assertTrue(self.call(action="status", issue="HF-622")["ok"])
        self.assertEqual(self.requests("query IssueTitleSearch"), 0)

    def test_content_edits_name_the_key_but_need_it_exactly(self) -> None:
        request_id = str(uuid.uuid4())
        reply = self.call(action="add_comment", issue="QA-10", id=request_id, body="hello")
        self.assertFalse(reply["ok"])
        self.assertEqual(reply["code"], "issue_alias")
        self.assertIn("QA-10 is HF-622", reply["message"])
        self.assertIsNone(self.store.outbox_row(request_id))

    def test_specialist_scope_resolves_exact_keys_only(self) -> None:
        with patch.object(self.api, "specialist_scope", {"all_teams": True}):
            self.assertEqual(self.api.issues_by_title("QA-10"), ([], False))
        self.assertEqual(self.requests("query IssueTitleSearch"), 0)


class RefusalLogTests(ResolveBase):
    def test_every_refusal_logs_its_code_once_per_call(self) -> None:
        self.create(project="Roadmap")
        self.create(project="Roadmap")
        self.create(team="QA")
        self.call(action="status", issue="QA-99")
        self.call(action="status", issue="QA-99")
        self.call(action="create_issue", id=str(uuid.uuid4()))
        lines = self.result_lines()
        reasons = [line.split("reason=")[1].split()[0] for line in lines]
        self.assertEqual(reasons, ["ambiguous_project", "ambiguous_project", "unknown_team", "not_found", "not_found",
                                   "request_refused"])
        self.assertFalse(any(text in line for line in lines for text in ("Back up", "Roadmap", "synthetic-token")))

    def test_a_resolved_alias_logs_the_key(self) -> None:
        self.remote.add_issue("issue-622", "HF-622", title="QA-10: list the 10 most recent commits",
                              team={"id": "team-hf", "key": "HF"})
        with patch.object(chat, "_entrust", lambda *a: {"native": {"status": "ready", "created_from_chat": True},
                                                        "routing": "queued"}):
            self.call(action="work_on", issue="QA-10")
        self.assertIn("issue=HF-622", self.result_lines()[-1])


class DefaultProjectTests(ResolveBase):
    """F29 (turn-waste RCA 22 Nov 2026): 35 of 46 project_required refusals in 14 days were create_issue with a
    team and no project; the retry 8-36s later named the project the agent always files into."""

    def test_a_team_without_project_files_into_the_project_last_used_for_that_team(self) -> None:
        self.assertEqual(self.create(team="HF")["code"], "project_required")  # no history yet: two active projects
        self.assertTrue(self.create(team="HF", project="Fleet QA")["ok"])
        reply = self.create(team="hf")
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(self.remote.created[-1]["projectId"], "proj-fleet-qa")
        self.assertIn("'Fleet QA', the active project this agent last filed", reply["message"])
        self.assertIn("tell the user", reply["message"])
        self.assertEqual(self.create(team="KEN")["code"], "project_required")  # remembered per team only

    def test_the_team_name_given_as_project_uses_that_teams_default(self) -> None:
        self.assertTrue(self.create(team="HF", project="Roadmap")["ok"])
        reply = self.create(project="Hermes Fleet")
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(self.remote.created[-1]["projectId"], "proj-roadmap-hf")

    def test_a_finished_remembered_project_is_not_reused(self) -> None:
        self.assertTrue(self.create(team="HF", project="Fleet QA")["ok"])
        for done in ("proj-fleet-qa", "proj-roadmap-hf"):
            next(p for p in self.remote.projects if p["id"] == done)["completedAt"] = "2026-11-01T00:00:00Z"
        self.remote.add_project("proj-dec", "Fleet Dec", ["team-hf"])
        self.remote.add_project("proj-ops", "Fleet Ops", ["team-hf"])
        self.assertEqual(self.create(team="HF")["code"], "project_required")

    def test_a_team_with_one_active_project_needs_no_project(self) -> None:
        self.remote.add_team("team-solo", "SOLO", "Solo")
        self.remote.add_project("proj-solo", "Solo Work", ["team-solo"])
        reply = self.create(team="SOLO")
        self.assertTrue(reply["ok"])
        self.assertEqual(self.remote.created[-1]["projectId"], "proj-solo")
        self.assertIn("the team's only active project", reply["message"])
        self.assertNotIn("last filed", reply["message"])

    def test_an_unreadable_or_missing_store_only_loses_the_default(self) -> None:
        self.assertTrue(self.create(team="HF", project="Fleet QA")["ok"])
        with patch.object(self.store, "issue_project", side_effect=sqlite3.OperationalError("locked")):
            self.assertEqual(self.create(team="HF")["code"], "project_required")
        self.bridge.store = None
        self.assertEqual(self.create(team="HF")["code"], "project_required")

    def test_project_none_is_not_remembered(self) -> None:
        self.assertTrue(self.create(team="HF", project="none")["ok"])
        self.assertEqual(self.create(team="HF")["code"], "project_required")

    def test_the_schema_states_create_requirements_up_front(self) -> None:
        self.assertIn("create_issue id and title, plus team, project or parent", chat.SCHEMA["description"])
        project = chat.SCHEMA["parameters"]["properties"]["project"]["description"]
        self.assertIn("last filed a new issue into", project)
        self.assertNotIn("If unsure, omit it", project)


if __name__ == "__main__":
    unittest.main()
