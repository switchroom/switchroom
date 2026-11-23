"""A small fake of Linear's GraphQL API over real HTTP, for plugins/linear scenario tests.

It models only what the plugin uses, with the live behaviours recorded in plan phase 0:
client ``id`` on creates (duplicate -> HTTP 200 INPUT_ERROR "conflict on insert of ...";
anything but a canonical UUIDv4 -> HTTP 200 INPUT_ERROR "Argument Validation Error"),
RATELIMITED as HTTP 400 with epoch-millisecond reset headers, and the delegate field.
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SELF = "app-self"
OTHER = {"id": "app-other", "name": "Other Agent"}
STATES = [
    {"id": "st-todo", "name": "Todo", "type": "unstarted"},
    {"id": "st-progress", "name": "In Progress", "type": "started"},
    {"id": "st-blocked", "name": "Blocked", "type": "started"},
    {"id": "st-done", "name": "Done", "type": "completed"},
    {"id": "st-canceled", "name": "Canceled", "type": "canceled"},
    {"id": "st-backlog", "name": "Backlog", "type": "backlog"},
]


def canonical_uuid4(value) -> bool:
    """Linear accepts a client-supplied create id only as a UUIDv4."""
    try:
        parsed = uuid.UUID(str(value))
    except ValueError:
        return False
    return parsed.version == 4 and str(parsed) == value


def _offline_gh() -> None:
    """The closing note reads a PR's state through ``gh`` (F28). Tests that do not fake it get a gh with
    no login, which fails fast and offline (no state line), instead of asking the real GitHub."""
    import os
    import tempfile
    for key in ("GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"):
        os.environ.pop(key, None)
    os.environ["GH_CONFIG_DIR"] = tempfile.mkdtemp(prefix="linear-tests-gh-")


def load_plugin():
    name = "hermes_fleet_linear_plugin"
    if name in sys.modules:
        return sys.modules[name]
    _offline_gh()
    spec = importlib.util.spec_from_file_location(
        name, ROOT / "plugins" / "linear" / "__init__.py", submodule_search_locations=[str(ROOT / "plugins" / "linear")])
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def work_on_reply(created: bool = True) -> str:
    """The linear tool's real work_on reply, built by the plugin's own chat.py reply builders."""
    load_plugin()
    from hermes_fleet_linear_plugin import chat
    native = {"status": "ready", "created_from_chat": created, "admitted": True, "task_id": "t_0a1b2c3d"}
    result = {"native": native, "routing": "queued"}
    return chat._reply(not native.get("not_started_reason"), chat._entrust_message(result),
                       issue={"id": "issue-1", "identifier": "QA-9", "url": "https://linear.app/x/issue/QA-9"},
                       **result)


class Clock:
    def __init__(self, start: float = 1_900_000_000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def iso(self, offset: float = 0.0) -> str:
        return datetime.fromtimestamp(self.now + offset, timezone.utc).isoformat().replace("+00:00", "Z")


class FakeLinear:
    def __init__(self, clock: Clock) -> None:
        self.clock = clock
        self.issues: dict[str, dict] = {}
        self.history: dict[str, list[dict]] = {}  # IssueHistory, oldest first
        self.comments: list[dict] = []
        self.activities: list[dict] = []
        self.project_updates: list[dict] = []
        self.ids: set[str] = set()
        self.sessions: dict[str, str] = {}
        self.requests: list[str] = []
        self.down = False
        self.lose_next_response = False
        self.comment_updates_issue = False
        self.activity_updates_issue = False
        self.rate_limited_until = 0.0
        # The team/project directory (LinearDirectory): teams by id, active and finished projects.
        self.teams: list[dict] = [{"id": "team-1", "key": "ABC", "name": "Alpha"}]
        self.projects: list[dict] = []
        self.lock = threading.Lock()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args) -> None:
                pass

            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                status, headers, payload = fake.handle(body["query"], body.get("variables") or {})
                raw = json.dumps(payload).encode()
                self.send_response(status)
                for key, value in headers.items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}/graphql"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def add_team(self, team_id: str, key: str, name: str) -> dict:
        team = {"id": team_id, "key": key, "name": name}
        self.teams.append(team)
        return team

    def add_project(self, project_id: str, name: str, team_ids: list[str], *, slug: str = "",
                    completed: bool = False, archived: bool = False) -> dict:
        # Archived projects are returned too (with archivedAt), the worst case: the client must drop them.
        project = {"id": project_id, "name": name, "slugId": slug or project_id[-6:], "team_ids": list(team_ids),
                   "completedAt": "2026-10-01T00:00:00Z" if completed else None, "canceledAt": None,
                   "archivedAt": "2026-11-04T01:15:28Z" if archived else None,
                   "updatedAt": self.clock.iso(len(self.projects))}
        self.projects.append(project)
        return project

    def add_issue(self, issue_id: str, identifier: str, *, project: str | None = "proj-1",
                  title: str | None = None, team: dict | None = None) -> dict:
        team = team or {"id": "team-1", "key": "ABC"}
        issue = {"id": issue_id, "identifier": identifier, "title": title or f"Title of {identifier}",
                 "description": "Synthetic issue body", "url": f"https://linear.example/issue/{identifier}",
                 "updatedAt": self.clock.iso(), "delegate": None, "assignee": None, "creator": {"id": "human-1"},
                 "state": dict(STATES[0]),
                 "project": {"id": project} if project else None,
                 "team": {"id": team["id"], "key": team["key"], "states": {"nodes": STATES}}}
        self.issues[issue_id] = issue
        return issue

    def record_history(self, issue_id: str, actor: str | None, before: dict, after: dict) -> None:
        """Linear records who changed state, assignee or delegate, and when."""
        ident = lambda value: (value or {}).get("id")
        self.history.setdefault(issue_id, []).append({
            "createdAt": self.clock.iso(), "actorId": actor,
            "fromStateId": ident(before.get("state")), "toStateId": ident(after.get("state")),
            "fromAssigneeId": ident(before.get("assignee")), "toAssigneeId": ident(after.get("assignee")),
            "fromDelegate": before.get("delegate") and {"id": ident(before["delegate"])},
            "toDelegate": after.get("delegate") and {"id": ident(after["delegate"])}})

    def set_delegate(self, issue_id: str, delegate: dict | None, *, actor: str | None = "human-1") -> None:
        before = dict(self.issues[issue_id])
        self.issues[issue_id]["delegate"] = delegate
        self.issues[issue_id]["updatedAt"] = self.clock.iso()
        self.record_history(issue_id, actor, before, self.issues[issue_id])

    def set_assignee(self, issue_id: str, assignee: dict | None, *, actor: str | None = "human-1") -> None:
        before = dict(self.issues[issue_id])
        self.issues[issue_id]["assignee"] = assignee
        self.issues[issue_id]["updatedAt"] = self.clock.iso()
        self.record_history(issue_id, actor, before, self.issues[issue_id])

    def set_state(self, issue_id: str, name: str, *, actor: str | None = "human-1") -> None:
        before = dict(self.issues[issue_id])
        team = ((self.issues[issue_id].get("team") or {}).get("states") or {}).get("nodes") or []
        self.issues[issue_id]["state"] = dict(next(s for s in [*team, *STATES] if s["name"] == name))
        self.issues[issue_id]["updatedAt"] = self.clock.iso()
        self.record_history(issue_id, actor, before, self.issues[issue_id])

    def touch(self, issue_id: str) -> None:
        """A comment, attachment, label or agent activity: updatedAt moves, routing does not."""
        self.issues[issue_id]["updatedAt"] = self.clock.iso()

    def state(self, issue_id: str) -> str:
        return self.issues[issue_id]["state"]["name"]

    def bodies(self, issue_id: str) -> list[str]:
        return [c["body"] for c in self.comments if c["issueId"] == issue_id] + \
               [a["content"].get("body") or a["content"].get("parameter") or ""
                for a in self.activities if a.get("issueId") == issue_id]

    def handle(self, query: str, variables: dict) -> tuple[int, dict, dict]:
        with self.lock:
            self.requests.append(query.split("(")[0].split("{")[0].strip())
            if self.down:
                return 503, {}, {"errors": [{"message": "service unavailable"}]}
            if self.clock() < self.rate_limited_until:
                reset = str(int(self.rate_limited_until * 1000))
                return 400, {"X-RateLimit-Requests-Remaining": "4999", "X-RateLimit-Requests-Reset": reset}, {
                    "errors": [{"message": "Rate limit exceeded", "extensions": {"code": "RATELIMITED"}}]}
            status, payload = self._apply(query, variables)
            if self.lose_next_response and "mutation" in query:
                self.lose_next_response = False
                return 502, {}, {"errors": [{"message": "bad gateway"}]}
            return status, {"X-RateLimit-Requests-Remaining": "4999"}, payload

    def _apply(self, query: str, variables: dict) -> tuple[int, dict]:
        if "viewer" in query:
            return 200, {"data": {"viewer": {"id": SELF}}}
        if "comment(" in query:
            comment = next((item for item in self.comments if item["id"] == variables["id"]), None)
            return 200, {"data": {"comment": ({"id": comment["id"], "body": comment["body"],
                                              "issue": {"id": comment["issueId"]}, "parent": None,
                                              "user": {"id": SELF}} if comment else None)}}
        if "issueUpdate" in query:
            issue = self.issues[variables["id"]]
            before = dict(issue)
            fields = variables["input"]
            if "stateId" in fields:
                issue["state"] = dict(next(s for s in issue["team"]["states"]["nodes"] if s["id"] == fields["stateId"]))
            if "delegateId" in fields:
                issue["delegate"] = (None if fields["delegateId"] is None else
                                     {"id": SELF, "name": "This Agent"} if fields["delegateId"] == SELF else OTHER)
            if "description" in fields:
                issue["description"] = fields["description"]
            issue["updatedAt"] = self.clock.iso()
            self.record_history(issue["id"], SELF, before, issue)
            return 200, {"data": {"issueUpdate": {"success": True, "issue": json.loads(json.dumps(issue))}}}
        for mutation, store, entity in (("commentCreate", self.comments, "Comment"),
                                        ("agentActivityCreate", self.activities, "AgentActivity"),
                                        ("projectUpdateCreate", self.project_updates, "ProjectUpdate")):
            if mutation in query:
                fields = dict(variables["input"])
                if not canonical_uuid4(fields.get("id")):
                    return 200, {"data": None, "errors": [{
                        "message": "Argument Validation Error",
                        "extensions": {"type": "invalid input", "code": "INPUT_ERROR", "statusCode": 400,
                                       "userPresentableMessage": "id must be a UUID v4."}}]}
                if fields["id"] in self.ids:
                    return 200, {"data": None, "errors": [{
                        "message": f"conflict on insert of {entity}",
                        "extensions": {"type": "invalid input", "code": "INPUT_ERROR", "statusCode": 400,
                                       "userPresentableMessage": f"Entity {entity} with id {fields['id']} already exists."}}]}
                self.ids.add(fields["id"])
                if "agentSessionId" in fields:
                    fields["issueId"] = self.sessions.get(fields["agentSessionId"])
                store.append(fields)
                if ((mutation == "commentCreate" and self.comment_updates_issue) or
                        (mutation == "agentActivityCreate" and self.activity_updates_issue)):
                    self.issues[fields["issueId"]]["updatedAt"] = self.clock.iso()
                return 200, {"data": {mutation: {"success": True}}}
        if query.startswith(("query LinearDirectory ", "query LinearDirectoryProjects")):
            return 200, {"data": self._directory(query, variables)}
        if "query IssueTitleSearch" in query:
            # Linear's startsWithIgnoreCase (or containsIgnoreCase) title filter, newest update first, one page.
            wanted = variables["q"].casefold()
            prefix = "startsWithIgnoreCase" in query
            count = int(re.search(r"issues\(first: (\d+)", query)[1])
            found = sorted((i for i in self.issues.values()
                            if (i["title"].casefold().startswith(wanted) if prefix else wanted in i["title"].casefold())),
                           key=lambda i: i["updatedAt"], reverse=True)
            return 200, {"data": {"issues": {"nodes": [
                {"id": i["id"], "identifier": i["identifier"], "title": i["title"], "updatedAt": i["updatedAt"],
                 "state": {"name": i["state"]["name"], "type": i["state"]["type"]},
                 "team": {"id": i["team"]["id"], "key": i["team"]["key"]}, "project": i.get("project")}
                for i in found[:count]], "pageInfo": {"hasNextPage": len(found) > count}}}}
        if "issues(" in query:
            # Delegated-and-started listing in id order; the cursor is the last node, as in Linear.
            matches = [json.loads(json.dumps(i)) for _, i in sorted(self.issues.items())
                       if (i.get("delegate") or {}).get("id") == variables["delegate"] and i["state"]["type"] == "started"
                       and (not variables.get("after") or i["id"] > variables["after"])]
            count = int(re.search(r"issues\(first: (\d+)", query)[1])
            page, more = matches[:count], len(matches) > count
            return 200, {"data": {"issues": {"nodes": page, "pageInfo": {
                "hasNextPage": more, "endCursor": page[-1]["id"] if page else None}}}}
        if "issue(" in query:
            issue = self.issues.get(variables["id"]) or next(
                (i for i in self.issues.values() if i["identifier"] == variables["id"]), None)
            issue = json.loads(json.dumps(issue)) if issue else None
            if issue and "history(" in query:
                # Linear connections are newest first.
                nodes = list(reversed(self.history.get(issue["id"], [])))
                count = int(re.search(r"history\(first: (\d+)", query)[1])
                start = int((variables or {}).get("after") or 0)
                issue["history"] = {"nodes": nodes[start:start + count],
                                    "pageInfo": {"hasNextPage": len(nodes) > start + count,
                                                 "endCursor": str(start + count)}}
            if issue and "comments(" in query:
                comments = [
                    {"id": c.get("id"), "url": c.get("url"),
                     "body": c["body"], "createdAt": c.get("createdAt", self.clock.iso()),
                     "updatedAt": c.get("updatedAt", c.get("createdAt", self.clock.iso())),
                     "user": {"id": c.get("author_id", SELF), "name": c.get("author", "Pat Example")}}
                    for c in self.comments if c.get("issueId") == issue["id"]]
                # Linear connections are newest first; last selects the old end.
                order = "updatedAt" if "orderBy: updatedAt" in query else "createdAt"
                comments.sort(key=lambda c: c[order], reverse=True)
                total = len(comments)
                page = re.search(r"comments\((first|last): (\d+)", query)
                if page:
                    count = int(page[2])
                    comments = comments[:count] if page[1] == "first" else comments[-count:]
                issue["comments"] = {"nodes": comments, "pageInfo": {"hasNextPage": bool(page and total > count)}}
            if issue and "agentSessions(" in query:
                issue["agentSessions"] = self._agent_sessions(issue["id"], query)
            return 200, {"data": {"issue": issue}}
        return 400, {"errors": [{"message": "unsupported", "extensions": {"code": "INVALID_INPUT"}}]}

    def _directory(self, query: str, variables: dict) -> dict:
        """teams(first: 100) and projects(first: N, after) newest update first, as Linear pages them."""
        ordered = sorted(self.projects, key=lambda p: p["updatedAt"], reverse=True)
        count = int(re.search(r"projects\(first: (\d+)", query)[1])
        start = int(variables.get("after") or 0)
        page = ordered[start:start + count]
        projects = {"nodes": [{**{k: v for k, v in p.items() if k not in ("team_ids", "updatedAt")},
                               "teams": {"nodes": [{"id": t} for t in p["team_ids"]]}} for p in page],
                    "pageInfo": {"hasNextPage": len(ordered) > start + count, "endCursor": str(start + count)}}
        data = {"projects": projects}
        if "teams(first:" in query.split("projects(")[0]:
            data["teams"] = {"nodes": [dict(t) for t in self.teams], "pageInfo": {"hasNextPage": False}}
        return data

    def _agent_sessions(self, issue_id: str, query: str) -> dict:
        """Issue.agentSessions { activities }: sessions by latest activity, activities newest first.

        Activities may carry createdAt/updatedAt, ephemeral, user_id/user_name and app (the
        session's appUser); a created activity defaults to this app."""
        kinds = re.search(r"type: \{ in: \[([^\]]*)\] \}", query)
        kinds = set(re.findall(r'"(\w+)"', kinds[1])) if kinds else None
        sessions: dict[str, list[dict]] = {}
        for item in self.activities:
            if item.get("issueId") == issue_id:
                sessions.setdefault(item["agentSessionId"], []).append(item)
        ordered = sorted(sessions.items(), key=lambda entry: max(a.get("createdAt", "") for a in entry[1]), reverse=True)
        session_count = int(re.search(r"agentSessions\(first: (\d+)", query)[1])
        activity_count = int(re.search(r"activities\(first: (\d+)", query)[1])
        nodes = []
        for session_id, items in ordered[:session_count]:
            items = sorted((a for a in items if kinds is None or a["content"].get("type") in kinds),
                           key=lambda a: a.get("createdAt", ""), reverse=True)
            app = items[0].get("app", {"id": SELF, "name": "This Agent"}) if items else {"id": SELF, "name": "This Agent"}
            nodes.append({"id": session_id, "appUser": app, "activities": {
                "nodes": [{"id": a["id"], "createdAt": a.get("createdAt", self.clock.iso()),
                           "updatedAt": a.get("updatedAt", a.get("createdAt", self.clock.iso())),
                           "ephemeral": bool(a.get("ephemeral")),
                           "user": {"id": a.get("user_id", app["id"]), "name": a.get("user_name", app["name"])},
                           "content": {"__typename": "AgentActivity%sContent" % a["content"]["type"].capitalize(),
                                       **a["content"]}} for a in items[:activity_count]],
                "pageInfo": {"hasNextPage": len(items) > activity_count}}})
        return {"nodes": nodes, "pageInfo": {"hasNextPage": len(ordered) > session_count}}

    def session_event(self, action: str, issue_id: str, session_id: str, *, body: str = "", signal: str | None = None,
                      creator: str = "human-1", activity_id: str = "act-1", at: float = 0.0) -> dict:
        """An AgentSessionEvent shaped like the phase 0 captures (issue has no updatedAt)."""
        self.sessions[session_id] = issue_id
        issue = self.issues[issue_id]
        event = {"type": "AgentSessionEvent", "action": action, "createdAt": self.clock.iso(at),
                 "webhookTimestamp": int((self.clock() + at) * 1000),
                 "agentSession": {"id": session_id, "creatorId": creator, "createdAt": self.clock.iso(at),
                                  "issue": {k: issue[k] for k in ("id", "identifier", "title", "description", "url")}},
                 "promptContext": f"<issue identifier=\"{issue['identifier']}\">{issue['title']}</issue>"}
        if action == "prompted":
            event["agentActivity"] = {"id": activity_id, "createdAt": self.clock.iso(at),
                                      "content": {"type": "prompt", "body": body or "stop"},
                                      "user": {"id": "human-1", "name": "Pat Example"}}
            if signal:
                event["agentActivity"]["signal"] = signal
        return event
