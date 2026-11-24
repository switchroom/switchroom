"""Default-disabled Linear integration: Linear records work; profile Kanban executes it. Settings are in README.md."""
from __future__ import annotations

import asyncio
import contextvars
import hashlib
import logging
import os
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable
from . import api as api_module, chat, ops, waits
from .api import ENDPOINT, LinearAPI, LinearError, RateLimited, backoff_delay
from .bridge import Bridge, Kanban, file_signature, validate_activation_cutoff_ms, validate_ingress_profile
from .oauth import ReauthorizationRequired, token_provider
from .store import Store
from . import diag

log = logging.getLogger(diag.LOGGER_NAME)
SETTINGS = ("identity", "credentials", "states", "team_states", "completion_contracts", "quiet_minutes", "recheck_minutes",
            "api_url", "board", "ingress_database", "ingress_profile", "state_database", "tick_seconds", "activation_cutoff_ms",
            "specialist_scope", "takeover", "workspace_projects")
IDENTITY_TTL = 600.0  # seconds a verified credential->actor/workspace binding is reused for reads
HISTORY_CURSOR_TTL = 600.0
def rate_limit_path(state_database: Any, home: Path) -> Path:
    """The one pause/budget file per profile. Every client of this profile's Linear app user
    (reporting service, chat tools, skills, cron) must pass it so they share Linear's hourly budget."""
    return Path(str(state_database or home / "linear" / "state.db") + ".rate-limit.json")
class BoundLinearAPI(LinearAPI):
    """Bind credentials to an actor/workspace and, optionally, a bounded specialist scope."""

    SCOPE_KEYS = {"allowed_team_ids", "allowed_project_ids", "allowed_requester_ids"}
    ALL_SCOPE_KEYS = {"all_teams", "all_projects", "allowed_requester_ids"}
    def __init__(self, token, *, identity, specialist_scope=None, **kwargs):
        if not isinstance(identity, dict) or any(
                not isinstance(identity.get(k), str) or not identity[k].strip()
                for k in ("viewer_id", "organization_id")):
            raise ValueError("linear: identity needs viewer_id and organization_id")
        for key in ("teams", "projects"):
            if key in identity and (not isinstance(identity[key], list) or not identity[key] or
                                    any(not isinstance(v, str) or not v.strip() for v in identity[key])):
                raise ValueError(f"linear: identity.{key} must be a nonempty list of IDs or keys")
        self.identity = {k: list(v) if isinstance(v, list) else v for k, v in identity.items()}
        self.specialist_scope = self._validate_specialist_scope(specialist_scope)
        self._graphql_permit = threading.local()
        self._binding: tuple[str, float] | None = None  # (sha256 of a verified credential, verified until)
        self._history_cursors: dict[tuple[str, str], float] = {}
        super().__init__(token, **kwargs)
    @classmethod
    def _validate_specialist_scope(cls, scope):
        if scope is None: return None
        if not isinstance(scope, dict) or not (set(scope) in (cls.SCOPE_KEYS, cls.ALL_SCOPE_KEYS) or
                ("requester_basis" in scope and set(scope) - {"requester_basis"} in (cls.SCOPE_KEYS, cls.ALL_SCOPE_KEYS))):
            raise ValueError("linear: specialist_scope requires exact team/project/requester lists or explicit all_teams/all_projects with a requester list")
        basis = scope.get("requester_basis", "issue_creator")
        if basis not in ("issue_creator", "agent_session"):
            raise ValueError("linear: specialist_scope.requester_basis must be issue_creator or agent_session")
        scope = {key: value for key, value in scope.items() if key != "requester_basis"}
        result = {}
        if set(scope) == cls.ALL_SCOPE_KEYS:
            if scope["all_teams"] is not True or scope["all_projects"] is not True:
                raise ValueError("linear: all_teams and all_projects must both be explicitly true")
            result = {"all_teams": True, "all_projects": True}
        for key in sorted(cls.SCOPE_KEYS):
            if key not in scope: continue
            values = scope.get(key)
            if (not isinstance(values, list) or not values or
                    any(not isinstance(value, str) or not value or value != value.strip() for value in values) or
                    len(set(values)) != len(values)):
                raise ValueError(f"linear: specialist_scope.{key} must be a nonempty list of unique exact IDs")
            result[key] = list(values)
        if basis == "agent_session":
            result["requester_basis"] = basis
        return result
    @contextmanager
    def _scope(self, **values):
        prior = {key: getattr(self._graphql_permit, key, 0 if key == "depth" else None) for key in values}
        try:
            for key, value in values.items(): setattr(self._graphql_permit, key, value)
            yield
        finally:
            for key, value in prior.items(): setattr(self._graphql_permit, key, value)
    def _permit_specialist_operation(self, issue_ids=None, *, session_id=None, project_id=None):
        values = {"depth": getattr(self._graphql_permit, "depth", 0) + 1}
        for key, value in (("issue_targets", tuple(issue_ids) if issue_ids is not None else None),
                           ("target_session", session_id), ("target_project", project_id)):
            if value is not None: values[key] = value
        return self._scope(**values)
    def requester_session(self, session_id, *, activity_id=None):
        """Bind provider coordinates, never a human identity or cached authorization.

        A later Activity is re-read on every session authorization. The original
        session creator remains unchanged, including an unknown creator.
        """
        if activity_id is not None:
            pairs = ([(session_id.get(issue), activity) for issue, activity in activity_id.items()]
                     if isinstance(session_id, dict) and isinstance(activity_id, dict) else [(session_id, activity_id)])
            if not pairs or any(not isinstance(session, str) or not session
                    or not isinstance(activity, str) or not activity or activity == session
                    for session, activity in pairs):
                raise ValueError("An Activity binding needs distinct exact session and Activity IDs")
        return self._scope(requester_session_id=session_id if session_id is not None else {},
                           requester_activity=(session_id, activity_id) if activity_id else None)
    def verify_identity(self):
        self._verified_credential(self.token)
    def _credential_rejected(self):
        self._binding = None
    def _verified_credential(self, provider, *, mutation=False):
        """Prove the credential belongs to the configured actor and workspace.

        Reads reuse a proof for the same credential (keyed on its hash, never stored) for
        IDENTITY_TTL; a new token, a 401 or the TTL forces a fresh check. Mutations always
        re-check. Without this every read cost two requests and halved the hourly budget."""
        prefetched = None
        if not mutation and self._binding is not None:
            try:
                prefetched = provider()
            except Exception as exc:  # noqa: BLE001 - credential providers may include secrets in errors
                log.error("linear: credentials unavailable")
                if isinstance(exc, ReauthorizationRequired):
                    raise LinearError("Linear credentials unavailable") from exc
                raise LinearError("Linear credentials unavailable") from None
            digest, until = self._binding
            if (hashlib.sha256(prefetched.encode()).hexdigest() == digest and self.clock() < until):
                return provider, prefetched
        credential = None
        def capture():
            nonlocal credential, prefetched
            if prefetched is not None:
                credential, prefetched = prefetched, None
            else:
                credential = provider()
            return credential
        def invalidate():
            nonlocal provider
            provider.invalidate()
            provider = self.token
        capture.invalidate = invalidate if callable(getattr(provider, "invalidate", None)) else None
        identity = super()._graphql("query IdentityBinding { viewer { id } organization { id } }",
                                    token_provider=capture)
        if any(not isinstance(identity.get(field), dict) or
               identity[field].get("id") != self.identity[expected]
               for field, expected in (("viewer", "viewer_id"), ("organization", "organization_id"))):
            self._binding = None
            raise LinearError("Linear actor/workspace does not match configured identity", retryable=False)
        if isinstance(credential, str):
            self._binding = (hashlib.sha256(credential.encode()).hexdigest(), self.clock() + IDENTITY_TTL)
        return provider, credential
    def graphql(self, query, variables=None):
        if self.specialist_scope is not None and not getattr(self._graphql_permit, "depth", 0):
            raise LinearError("Arbitrary Linear GraphQL is disabled by specialist_scope", retryable=False)
        def verify(provider):
            result = self._verified_credential(provider, mutation=query.lstrip().startswith("mutation"))
            if (query.lstrip().startswith("mutation") and self.specialist_scope is not None and
                    self.specialist_scope.get("requester_basis") == "agent_session"):
                targets = getattr(self._graphql_permit, "issue_targets", ())
                if not targets: raise LinearError("Specialist mutation has no issue authority", retryable=False)
                project = getattr(self._graphql_permit, "target_project", None)
                for issue_id in targets:
                    issue = self._mutation_issue(issue_id)
                    if project is not None and (issue.get("project") or {}).get("id") != project:
                        raise LinearError("Project update target changed specialist scope", retryable=False)
                target_session = getattr(self._graphql_permit, "target_session", None)
                if target_session is not None and self.agent_session(target_session)["issue"]["id"] not in targets:
                    raise LinearError("Agent Activity target changed specialist scope", retryable=False)
            return result
        return super()._graphql(query, variables, verify_credential=verify)
    def viewer_id(self) -> str:
        self.verify_identity()
        return str(self.identity["viewer_id"])
    def _check_issue(self, issue):
        if self.specialist_scope is None:
            return
        if (not isinstance(issue, dict) or not isinstance(issue.get("id"), str) or not issue["id"].strip()):
            raise LinearError("Linear issue authorization response is malformed", retryable=False)
        team, project, creator = issue.get("team"), issue.get("project"), issue.get("creator")
        requester_ok = isinstance(creator, dict) and creator.get("id") in self.specialist_scope["allowed_requester_ids"]
        if self.specialist_scope.get("requester_basis") == "agent_session":
            session_id = getattr(self._graphql_permit, "requester_session_id", None)
            bound_effect = isinstance(session_id, dict)
            if bound_effect: session_id = session_id.get(issue["id"])
            fallback = session_id is None and not bound_effect
            activity_id = None
            if fallback:
                resolver = getattr(self, "requester_session_for_issue", None)
                session_id = resolver(issue["id"]) if callable(resolver) else None
                activity_resolver = getattr(self, "requester_activity_for_issue", None)
                activity_id = activity_resolver(issue["id"]) if callable(activity_resolver) else None
            if not isinstance(session_id, str) or not session_id:
                raise LinearError("Linear specialist authorization needs a bound requester session")
            try:
                if fallback:
                    with self.requester_session(session_id, activity_id=activity_id):
                        session = self.agent_session(session_id)
                else:
                    session = self.agent_session(session_id)
            except LinearError as exc:
                raise LinearError(str(exc), retryable=exc.retryable, authoritative_issue_id=issue["id"]) from exc
            requester_ok = session["issue"]["id"] == issue["id"]
        if (not isinstance(team, dict) or not isinstance(team.get("id"), str) or not team["id"] or
                (not self.specialist_scope.get("all_teams") and team["id"] not in self.specialist_scope["allowed_team_ids"]) or
                (not self.specialist_scope.get("all_projects") and
                 (not isinstance(project, dict) or project.get("id") not in self.specialist_scope["allowed_project_ids"])) or
                (self.specialist_scope.get("all_projects") and project is not None and
                 (not isinstance(project, dict) or not isinstance(project.get("id"), str) or not project["id"])) or
                not requester_ok):
            raise LinearError("Linear issue is outside configured specialist scope", retryable=False, authoritative_issue_id=issue.get("id"))
    def issue(self, ref):
        with self._permit_specialist_operation():
            issue = super().issue(ref)
        return self._scoped(issue, ref)
    def _scoped(self, issue, ref):
        if ref not in (issue.get("id"), issue.get("identifier")):
            raise LinearError("Linear issue resolution does not match the requested ref")
        team = issue.get("team") or {}
        if self.identity.get("teams") and not {team.get("id"), team.get("key")} & set(self.identity["teams"]):
            raise LinearError("Linear issue team is outside configured scope", retryable=False, authoritative_issue_id=issue.get("id"))
        if self.identity.get("projects") and (issue.get("project") or {}).get("id") not in self.identity["projects"]:
            raise LinearError("Linear issue project is outside configured scope", retryable=False, authoritative_issue_id=issue.get("id"))
        self._check_issue(issue)
        return issue
    def routing_history(self, issue_id, limit=50, after=None):
        """Issue routing history page, scoped like any issue read. A later page whose cursor came from
        a scoped page of the same issue moments ago asks only for history, not the full issue again."""
        now = self.clock()
        self._history_cursors = {key: at for key, at in self._history_cursors.items() if now - at < HISTORY_CURSOR_TTL}
        lean = after is not None and (issue_id, after) in self._history_cursors
        with self._permit_specialist_operation():
            issue, nodes, cursor = super()._routing_history(
                issue_id, max(limit, api_module.LEAN_HISTORY_PAGE) if lean else limit, after, lean=lean)
        if not lean:
            self._scoped(issue, issue_id)
        elif not isinstance(issue, dict) or issue.get("id") != issue_id:
            raise LinearError("Linear issue resolution does not match the requested ref")
        if cursor is not None:
            self._history_cursors[(issue_id, cursor)] = now
        return nodes, cursor
    def delegated_started_issues(self, delegate_id, *, after=None, limit=50):
        """Listing only; every issue is re-read through issue() (scoped) before any effect."""
        with self._permit_specialist_operation():
            return super().delegated_started_issues(delegate_id, after=after, limit=limit)
    def issue_thread(self, issue_id, limit=50):
        """Issue and comments in one read, scoped like any issue read. Under specialist_scope only allowed
        requesters and this app are passed on, so a refused requester's words never reach the worker."""
        with self._permit_specialist_operation():
            issue, comments = super().issue_with_thread(issue_id, limit)
        return self._scoped_comments(issue, issue_id, comments)
    def issue_progress(self, issue_id, limit=20):
        """Recent updates for status only, with the same issue/author authorization as threads.

        The same read carries the issue's user-visible Agent Session activities (``activities``
        is None when Linear did not return them), filtered by the same author rule as comments."""
        with self._permit_specialist_operation():
            issue, comments = super().issue_with_thread(issue_id, limit, progress=True, activities=True)
        comments = self._scoped_comments(issue, issue_id, comments)
        page = (issue.get("comments") or {}).get("pageInfo") or {}
        result = {"comments": comments, "history_complete": page.get("hasNextPage") is False, "activities": None}
        read = self.agent_activities(issue)
        if read is not None:
            result.update(activities=self._allowed_authors(read[0]), activities_complete=read[1])
        return result
    def _scoped_comments(self, issue, issue_id, comments):
        self._scoped(issue, issue_id)
        return self._allowed_authors(comments)
    def _allowed_authors(self, items):
        if self.specialist_scope is not None:
            allowed = set(self.specialist_scope["allowed_requester_ids"]) | {self.viewer_id()}
            items = [item for item in items if item.get("user_id") in allowed]
        return items
    def _mutation_issue(self, issue_id):
        issue = self.issue(issue_id)
        if not isinstance(issue_id, str) or not issue_id.strip() or issue.get("id") != issue_id:
            raise LinearError("Linear issue authorization does not match mutation target", retryable=False)
        return issue
    def agent_session(self, session_id):
        query = ("query AgentSessionAuthorization($id: String!) { agentSession(id: $id) "
                 "{ id creator { id } appUser { id } issue { id } } }")
        with self._permit_specialist_operation():
            session = self.graphql(query, {"id": session_id}).get("agentSession")
        if not isinstance(session, dict) or session.get("id") != session_id:
            raise LinearError("Linear Agent Session could not be authoritatively resolved", retryable=False)
        if not isinstance(session.get("appUser"), dict) or session["appUser"].get("id") != self.identity["viewer_id"]:
            raise LinearError("Linear Agent Session belongs to another app", retryable=False)
        issue = session.get("issue")
        creator = session.get("creator")
        creator_id = creator.get("id") if isinstance(creator, dict) else None
        activity_binding = getattr(self._graphql_permit, "requester_activity", None)
        if activity_binding:
            bound_session, bound_activity = activity_binding
            if isinstance(bound_session, dict):
                issue_id = issue.get("id") if isinstance(issue, dict) else None
                bound_session, bound_activity = bound_session.get(issue_id), bound_activity.get(issue_id)
            if bound_session == session_id and bound_activity:
                activity = self._agent_activity_actor(bound_activity, session_id)
                creator_id = activity["user"]["id"]  # authorization actor only; never rewrite creator
        if not isinstance(issue, dict) or not isinstance(issue.get("id"), str) or not issue["id"].strip():
            raise LinearError("Linear Agent Session requester or issue is outside specialist scope", retryable=False)
        if self.specialist_scope is None:
            if creator is not None and (not isinstance(creator_id, str) or not creator_id):
                raise LinearError("Linear Agent Session requester could not be resolved", retryable=False)
            self.issue(issue["id"])
            return session
        if (self.specialist_scope.get("requester_basis") != "agent_session" and creator is None and
                isinstance(session.get("appUser"), dict) and session["appUser"].get("id") == self.identity["viewer_id"]):
            # Automatic delegation sessions have no creator. Admit only this
            # app's authoritative session on an authorized creator's issue.
            self.issue(issue["id"])
            return session
        if self.specialist_scope.get("requester_basis") == "agent_session":
            if (creator_id not in self.specialist_scope["allowed_requester_ids"] or
                    not isinstance(session.get("appUser"), dict) or
                    session["appUser"].get("id") != self.identity["viewer_id"]):
                raise LinearError("Linear Agent Session requester is outside specialist scope", retryable=False)
            return session
        if not isinstance(creator_id, str) or creator_id not in (
                self.identity["viewer_id"], *self.specialist_scope["allowed_requester_ids"]):
            raise LinearError("Linear Agent Session requester is outside specialist scope", retryable=False,
                              authoritative_issue_id=issue["id"])
        return session
    def agent_activity(self, activity_id, session_id):
        activity = self._agent_activity_actor(activity_id, session_id)
        if self.specialist_scope is None:
            self.agent_session(session_id)  # current app and issue/workspace restrictions
        return activity
    def _agent_activity_actor(self, activity_id, session_id):
        query = ("query AgentActivityAuthorization($id: String!) { agentActivity(id: $id) "
                 "{ id user { id } agentSession { id } } }")
        with self._permit_specialist_operation():
            activity = self.graphql(query, {"id": activity_id}).get("agentActivity")
        user = activity.get("user") if isinstance(activity, dict) else None
        session = activity.get("agentSession") if isinstance(activity, dict) else None
        user_id = user.get("id") if isinstance(user, dict) else None
        if (not isinstance(activity, dict) or activity.get("id") != activity_id or
                not isinstance(session, dict) or session.get("id") != session_id):
            raise LinearError("Linear Agent Activity could not be authoritatively resolved", retryable=False)
        if not isinstance(user_id, str) or not user_id or user_id == self.identity["viewer_id"]:
            raise LinearError("Linear Agent Activity has no verified human actor", retryable=False,
                              authoritative_session_id=session_id)
        if self.specialist_scope is not None and user_id not in self.specialist_scope["allowed_requester_ids"]:
            raise LinearError("Linear Agent Activity actor is outside specialist scope", retryable=False, authoritative_session_id=session_id)
        return activity
    def update_issue(self, issue_id, fields):
        if self.specialist_scope is not None:
            issue = self._mutation_issue(issue_id)
            if (not isinstance(fields, dict) or set(fields) - {"stateId", "delegateId", "description"} or
                    ("delegateId" in fields and fields["delegateId"] != self.identity["viewer_id"]) or
                    ("stateId" in fields and fields["stateId"] not in {
                        item.get("id") for item in ((issue.get("team") or {}).get("states") or {}).get("nodes") or []
                    })):
                raise LinearError("Linear issue update exceeds specialist scope", retryable=False)
        elif self.identity.get("teams") or self.identity.get("projects"):
            self._mutation_issue(issue_id)
        with self._permit_specialist_operation([issue_id]):
            return super().update_issue(issue_id, fields)
    def question_precedes_answer(self, question_id, answer_id, session_id, actor_id, *, question_actor_id=None):
        with self._permit_specialist_operation():
            return super().question_precedes_answer(question_id, answer_id, session_id, actor_id,
                                                   question_actor_id=question_actor_id)

    def create_comment(self, client_id, issue_id, body):
        if self.specialist_scope is not None or self.identity.get("teams") or self.identity.get("projects"):
            self._mutation_issue(issue_id)
        with self._permit_specialist_operation([issue_id]):
            return super().create_comment(client_id, issue_id, body)
    def verify_comment(self, comment_id, issue_id, body):
        self._mutation_issue(issue_id)
        with self._permit_specialist_operation():
            return super().verify_comment(comment_id, issue_id, body)
    def verify_completion_comment(self, comment_id, issue_id, body):
        self._mutation_issue(issue_id)
        with self._permit_specialist_operation():
            return super().verify_completion_comment(comment_id, issue_id, body)
    def outbound_activity(self, activity_id, session_id, issue_id):
        self._mutation_issue(issue_id)
        with self._permit_specialist_operation():
            return super().outbound_activity(activity_id, session_id, issue_id)

    def create_activity(self, client_id, session_id, content, *, issue_id=None, ephemeral=False, **signal):
        if self.specialist_scope is not None:
            if not isinstance(issue_id, str) or not issue_id:
                raise LinearError("Specialist Agent Activity requires its owning issue id", retryable=False)
            session = self.agent_session(session_id)
            if session["issue"]["id"] != issue_id:
                raise LinearError("Agent Activity session does not belong to the authorized issue", retryable=False)
            self._mutation_issue(issue_id)
        with self._permit_specialist_operation([issue_id], session_id=session_id):
            return super().create_activity(client_id, session_id, content, ephemeral=ephemeral, **signal)

    def create_project_update(self, client_id, project_id, body, *, issue_ids=None):
        if self.specialist_scope is not None:
            if not isinstance(issue_ids, list) or not issue_ids:
                raise LinearError("Specialist project update requires its owning issue ids", retryable=False)
            if not self.specialist_scope.get("all_projects") and project_id not in self.specialist_scope["allowed_project_ids"]:
                raise LinearError("Linear project is outside configured specialist scope", retryable=False)
            for issue_id in issue_ids:
                if (self._mutation_issue(issue_id).get("project") or {}).get("id") != project_id:
                    raise LinearError("Project update issue is outside configured specialist scope", retryable=False)
        elif self.identity.get("projects") and project_id not in self.identity["projects"]:
            raise LinearError("Linear project is outside configured scope", retryable=False)
        with self._permit_specialist_operation(issue_ids, project_id=project_id):
            return super().create_project_update(client_id, project_id, body)

    def create_issue(self, client_id, team_id, title, *, description=None, project_id=None, parent_id=None):
        if self.specialist_scope is not None:
            raise LinearError("Issue creation is outside specialist scope", retryable=False)
        self.viewer_id()
        team = self._scoped_team(team_id)
        if self.identity.get("projects") and project_id not in self.identity["projects"]:
            raise LinearError("Linear project is outside configured scope", retryable=False)
        if project_id:
            project = self.graphql(
                "query Project($id: String!) { project(id: $id) { id archivedAt teams { nodes { id } pageInfo { hasNextPage } } } }",
                {"id": project_id}).get("project")
            connection = (project or {}).get("teams") if isinstance(project, dict) else None
            nodes = connection.get("nodes") if isinstance(connection, dict) else None
            page = connection.get("pageInfo") if isinstance(connection, dict) else None
            team_ids = {node.get("id") for node in nodes if isinstance(node, dict)} if isinstance(nodes, list) else set()
            if (not isinstance(project, dict) or project.get("id") != project_id or project.get("archivedAt") is not None
                    or not isinstance(page, dict) or page.get("hasNextPage") is not False or team["id"] not in team_ids):
                raise LinearError("Linear project does not belong to the selected team", retryable=False)
        if parent_id:
            parent_id = self.issue(parent_id)["id"]
        return super().create_issue(client_id, team["id"], title, description=description,
                                    project_id=project_id, parent_id=parent_id)

    def issue_labels(self, issue_id):
        # Read only, for an issue this app was just handed and has already read in scope.
        with self._permit_specialist_operation():
            return super().issue_labels(issue_id)

    def team_projects(self, team_id):
        if self.specialist_scope is not None:
            raise LinearError("Issue creation is outside specialist scope", retryable=False)
        projects = super().team_projects(self._scoped_team(team_id)["id"])
        allowed = self.identity.get("projects")
        return [project for project in projects if not allowed or project["id"] in allowed]

    def workspace_directory(self, **kwargs):
        """The teams and active projects this app can see, narrowed to identity.teams/projects."""
        if self.specialist_scope is not None:
            raise LinearError("Issue creation is outside specialist scope", retryable=False)
        directory = super().workspace_directory(**kwargs)
        teams_allowed, projects_allowed = set(self.identity.get("teams") or ()), set(self.identity.get("projects") or ())
        teams = [team for team in directory["teams"] if not teams_allowed or {team["id"], team["key"]} & teams_allowed]
        visible = {team["id"] for team in teams}
        projects = []
        for project in directory["projects"]:
            team_ids = [team_id for team_id in project["team_ids"] if team_id in visible]
            if team_ids and (not projects_allowed or project["id"] in projects_allowed):
                projects.append({**project, "team_ids": team_ids})
        return {**directory, "teams": teams, "projects": projects}

    def issues_by_title(self, text):
        """Title matches inside identity scope; none under specialist scope (exact keys only there)."""
        if self.specialist_scope is not None:
            return [], False
        teams_allowed, projects_allowed = set(self.identity.get("teams") or ()), set(self.identity.get("projects") or ())
        issues, more = super().issues_by_title(text)
        return [issue for issue in issues
                if (not teams_allowed or {(issue.get("team") or {}).get("id"), (issue.get("team") or {}).get("key")} & teams_allowed)
                and (not projects_allowed or (issue.get("project") or {}).get("id") in projects_allowed)], more

    def create_project(self, client_id, name, team_ids, *, description=None):
        if self.specialist_scope is not None:
            raise LinearError("Project creation is outside specialist scope", retryable=False)
        self.viewer_id()
        resolved = [self._scoped_team(team_id)["id"] for team_id in team_ids]
        return super().create_project(client_id, name, resolved, description=description)

    def _scoped_team(self, team_id):
        team = self.graphql("query Team($id: String!) { team(id: $id) { id key } }", {"id": team_id}).get("team")
        if (not isinstance(team, dict) or not team.get("id") or
                (self.identity.get("teams") and not {team.get("id"), team.get("key")} & set(self.identity["teams"]))):
            raise LinearError("Linear team is outside configured scope", retryable=False)
        return team

    def link_issue(self, issue_id, related_issue_id, relation):
        if self.specialist_scope is not None:
            raise LinearError("Issue linking is outside specialist scope", retryable=False)
        self.viewer_id()
        left, right = self.issue(issue_id), self.issue(related_issue_id)
        return super().link_issue(left["id"], right["id"], relation)

def _handled(running: dict, reply: Any) -> Any:
    """A tool call may have queued Linear writes: wake the loop so an idle wait does not delay them."""
    loop, wake = running.get("loop"), running.get("wake")
    if loop is not None and wake is not None:
        try:
            loop.call_soon_threadsafe(wake.set)
        except RuntimeError:
            pass
    return reply


IDLE_TICK_MAX_S = 15.0  # an idle service ticks at least this often; webhooks and board writes wake it at once
WATCH_POLL_S = 0.25


def idle_wait(tick_s: float, idle: int) -> float:
    """The wait after a tick: tick_seconds while busy, doubling per idle tick up to IDLE_TICK_MAX_S."""
    return max(tick_s, min(IDLE_TICK_MAX_S, tick_s * 2 ** min(idle, 8)))


async def _wait_for_change(wake: asyncio.Event, timeout: float, watched: Callable[[], tuple | None],
                           baseline: tuple | None, *, board_gap: float = 0.0) -> None:
    """Sleep until ``timeout``, a native hint (``wake``) or a write to a watched file.

    ``watched()`` is (webhook inbox signature, board signatures). A webhook ends the wait at once; a
    board write (a worker's progress) only once ``board_gap`` has passed, so a busy worker never makes
    the loop tick faster than tick_seconds."""
    started = time.monotonic()
    deadline = started + timeout
    while not wake.is_set():
        left = deadline - time.monotonic()
        if left <= 0:
            return
        try:
            await asyncio.wait_for(wake.wait(), timeout=min(WATCH_POLL_S, left))
            return
        except asyncio.TimeoutError:
            pass
        now = None if baseline is None else watched()
        if now is None or baseline is None:
            continue
        if now[0] != baseline[0] or (now[1] != baseline[1] and time.monotonic() - started >= board_gap):
            return


async def _reporting_loop(ctx: Any, home: Path, stop_requested: threading.Event, running: dict) -> None:
    from . import transport
    settings = {key: ctx.get_config(key) for key in SETTINGS if ctx.get_config(key) is not None}
    validate_activation_cutoff_ms(settings.get("activation_cutoff_ms"))
    validate_ingress_profile(settings.get("ingress_profile"))
    api = BoundLinearAPI(lambda: "", identity=settings.get("identity"),
                         specialist_scope=settings.get("specialist_scope"),
                         rate_limit_path=rate_limit_path(settings.get("state_database"), home),
                         endpoint=settings.get("api_url") or ENDPOINT)
    api.token = token_provider(settings, home)
    failures = 0
    while not stop_requested.is_set():
        try:
            await asyncio.to_thread(api.viewer_id)
            if api.clock() < api.paused_until:
                raise RateLimited(api.paused_until)
            break
        except RateLimited as exc:
            await asyncio.sleep(min(0.25, max(0.01, exc.until - api.clock())))
        except LinearError as exc:
            if not exc.retryable:
                raise
            failures += 1
            # Capped exponential backoff with jitter: a revoked app or a Linear outage must not
            # spend the hourly budget (or hammer the token endpoint) every couple of seconds.
            reauthorize = isinstance(getattr(exc, "__cause__", None), ReauthorizationRequired)
            delay = backoff_delay(failures + (8 if reauthorize else 0),
                                  base=max(1.0, float(settings.get("tick_seconds", 2))), cap=300.0)
            diag.warn("service.start", "retry", "auth_unavailable" if reauthorize else "identity_unavailable",
                      next_s=delay, attempt=failures)
            retry_until = time.monotonic() + delay
            while not stop_requested.is_set() and time.monotonic() < retry_until:
                await asyncio.sleep(min(0.25, max(0.01, retry_until - time.monotonic())))
    if stop_requested.is_set():
        return
    from hermes_cli.profiles import get_active_profile_name
    profile_name = Kanban.resolve_executor_profile(get_active_profile_name(), home)
    bridge = Bridge(Store(settings.get("state_database") or home / "linear" / "state.db"), api,
                    await asyncio.to_thread(Kanban, settings.get("board"), profile=profile_name,
                                            profile_home=home), profile=profile_name,
                    settings=settings)
    bridge.profile_home = home
    await asyncio.to_thread(diag.service_start, bridge.store, float(settings.get("tick_seconds", 2)), bridge.recheck_every)
    if running.get("native_requested"):
        from .native_input import route_delivery, committed_conversation_state
        bridge.native_ingress = lambda delivery: route_delivery(running, delivery)
        bridge.native_conversation_state = lambda payload: committed_conversation_state(
            running.get("native_adapter"), bridge, payload)
    ingress = Path(settings.get("ingress_database") or home / "workspace" / "linear" / "ingress.db")
    server = None
    try:
        waiting_since = logged_at = None
        while server is None and not stop_requested.is_set():
            try:
                server = transport.Server(home, profile_name, lambda args, context: _handled(running, chat.handle(bridge, args, context)))
            except transport.Unavailable as exc:
                if str(exc) != transport.OWNED:
                    raise
                # During a gateway replace the old owner is still listening (possibly too busy to
                # accept): wait for it to exit, visibly, instead of crashing or giving up.
                now = time.monotonic()
                waiting_since = now if waiting_since is None else waiting_since
                if logged_at is None or now - logged_at >= 60:
                    logged_at = now
                    diag.warn("service.start", "retry", "socket_owned", waited_s=int(now - waiting_since))
                await asyncio.sleep(0.25)
        if server is None:
            return
        running.update(bridge=bridge, loop=asyncio.get_running_loop(), wake=asyncio.Event())
        recovered, idle = False, 0
        tick_s = float(settings.get("tick_seconds", 2))
        def watched() -> tuple | None:
            """(webhook inbox, native boards) file signatures."""
            try:
                return file_signature(ingress), tuple(file_signature(path) for path in bridge.watch_paths())
            except Exception:  # noqa: BLE001 - no watch only means the timed tick
                return None
        while not stop_requested.is_set():
            running["wake"].clear()
            busy = True
            baseline = watched()  # before the tick: a change during it wakes the next one at once
            try:
                if not recovered:
                    await asyncio.to_thread(bridge.recover, ingress)
                    recovered = True
                busy = await asyncio.to_thread(bridge.tick, ingress) is not False  # tick ends with its own flush
            except Exception as exc:  # one bad remote delivery must not stop native execution
                baseline = None
                diag.evt("service.tick", "failed", "tick_exception", level=logging.ERROR, exc_info=True, exc=type(exc).__name__)
            idle = 0 if busy else idle + 1
            await _wait_for_change(running["wake"], idle_wait(tick_s, idle), watched, baseline, board_gap=tick_s)
    finally:
        running.clear()
        if server is not None:
            await asyncio.to_thread(server.close)



def register(ctx: Any) -> None:
    if ctx.get_config("enabled", False) is not True:
        return
    from . import transport
    running: dict[str, Any] = {}
    if hasattr(ctx, "register_platform"):
        from .native_input import register_platform
        register_platform(ctx, running)

    def active_home():
        from hermes_constants import get_hermes_home
        return Path(get_hermes_home()).resolve(strict=True)

    def tool(args: dict[str, Any] | None = None, **_: Any) -> str:
        try:
            args = args or {}
            if args.get("action") == "work_reference":
                if set(args) != {"action"}:
                    raise transport.Unavailable("Native work references accept no identity, session or task selectors.")
                from . import work
                return chat._reply(True, "Current dispatcher work reference; original requester unknown, no permission granted.",
                                   **work.current(work.capture_context(), origin_settings()))
            context = transport.capture_context(track=args.get("action") == "track", board=args.get("board"))
            bridge = running.get("bridge")
            if bridge is not None:
                return _handled(running, chat.handle(bridge, args, context))
            return transport.chat_request(Path(context.home), args, context)
        except transport.Unavailable as exc:
            return chat._reply(False, str(exc), code="context_or_service_unavailable")
        except transport.Uncertain as exc:
            return chat._reply(False, str(exc), code="delivery_uncertain")

    # The official PluginContext API does not accept an invocation-context injection flag.
    try:
        from tools.registry import no_cache_check_fn
    except ImportError:
        no_cache_check_fn = lambda check: check
    # Discovery precedes native policy binding. Evaluate the launch role when
    # tools are selected, bypassing the registry's availability TTL cache.
    ctx.register_tool(name="linear", toolset="linear", schema=chat.SCHEMA, handler=tool,
                      check_fn=no_cache_check_fn(chat.coordinator_inventory), description=chat.SCHEMA["description"])
    ctx.register_tool(name="linear_work_reference", toolset="linear", schema=chat.WORK_SCHEMA, handler=tool,
                      check_fn=no_cache_check_fn(chat.native_work_inventory), description=chat.WORK_SCHEMA["description"])

    def paths() -> tuple[Path, Path, str]:
        from hermes_cli.profiles import get_active_profile_name
        home = active_home()
        return (Path(ctx.get_config("state_database") or home / "linear" / "state.db"),
                Path(ctx.get_config("ingress_database") or home / "workspace" / "linear" / "ingress.db"),
                validate_ingress_profile(ctx.get_config("ingress_profile")) or
                get_active_profile_name() or "default")
    def origin_settings():
        return {key: ctx.get_config(key) for key in ("identity", "specialist_scope")}
    if hasattr(ctx, "register_cli_command"):
        ctx.register_cli_command("linear", "Show and resolve held Linear reporting", ops.setup,
                                 lambda args: ops.run(args, *paths(), origin_settings=origin_settings()))
    if hasattr(ctx, "register_command") and not ctx.get_config("specialist_scope"):
        ctx.register_command("linear-status", lambda raw_args="": ops.report(ops.stuck(*paths(), boards=ops.native_boards,
                                                                                   board_names=ops.native_board_names)),
                             description="Show held Linear reporting and reconciliation")

    def native_hint(**_: Any) -> None:
        # Lifecycle callbacks run near native writers/dispatchers. Only schedule a wake;
        # the service reads durable history later, without either database lock held.
        loop, wake = running.get("loop"), running.get("wake")
        if loop is not None and wake is not None:
            try:
                loop.call_soon_threadsafe(wake.set)
            except RuntimeError:
                pass
    for event in ("on_kanban_worker_spawned", "on_kanban_worker_exited", "on_kanban_worker_stale_claim",
                  "on_kanban_task_updated", "on_kanban_dispatch_tick"):
        ctx.register_hook(event, native_hint)
    # Kanban chat pings name a tracked task as its linked Linear issue (Core kanban_task_link).
    chat.register_task_link(ctx, lambda: paths()[0])
    # A worker's CI / issue / delivery wait this bridge resumes is quiet board state (Core kanban_wait_claim).
    waits.register_wait_claim(ctx)

    stop_requested = threading.Event()

    # Official upstream has on_unload/spawn_task, not the fork's profile-service API.
    # gateway.run stamps this startup hint; it is never authorization. Detached native
    # workers and API-only plugin discovery never start another reporting service.
    if os.environ.get("_HERMES_GATEWAY") != "1" or os.environ.get("HERMES_KANBAN_TASK"):
        return
    home = active_home()
    scope = contextvars.copy_context()
    def serve() -> None:
        try:
            asyncio.run(_reporting_loop(ctx, home, stop_requested, running))
        except transport.Unavailable:
            log.info("linear: another profile reporting service already owns the socket")
        except Exception as exc:
            if stop_requested.is_set() or (isinstance(exc, RuntimeError) and "after shutdown" in str(exc)):
                diag.evt("service.stop", "stopped", "shutdown", exc=type(exc).__name__)  # normal gateway shutdown race
            else:
                diag.evt("service.stop", "failed", "crash", level=logging.ERROR, exc_info=True, exc=type(exc).__name__)
        else:
            diag.evt("service.stop", "stopped", "shutdown")
    thread = threading.Thread(target=lambda: scope.run(serve), name="linear-reporting", daemon=True)
    def close() -> None:
        stop_requested.set()
        native_hint()
        if thread.is_alive():
            thread.join(timeout=5)
    ctx.on_unload(close)
    thread.start()
