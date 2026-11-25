#!/usr/bin/env python3
"""ACP session/new must hydrate claude.ai connectors without native Bash/Write."""
from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "model-providers" / "claude-acp"
CALENDAR_ALLOW = "mcp__claude_ai_Google_Calendar__list_*"
WILDCARD = "mcp__claude_ai_*"


def load_client():
    spec = importlib.util.spec_from_file_location("claude_acp_client", PLUGIN / "client.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ConnectorHydrationTests(unittest.TestCase):
    def test_every_sdk_input_and_live_alias_is_denied(self) -> None:
        client = load_client()
        fixture = (ROOT / "tests/fixtures/claude-tool-inputs.txt").read_text()
        self.assertIn(client._REVIEWED_SDK_TOOLS_SHA256, fixture)
        union = re.search(r"export type ToolInputSchemas\s*=([^;]+);", fixture)
        assert union is not None
        declared = set(re.findall(r"\b([A-Za-z]+)Input\b", union.group(1)))
        self.assertGreater(len(declared), 40)
        aliases = {"Edit", "Read", "Write", "Task", "Skill", "ToolSearch",
                   "DesignSync", "ListAgents", "SendMessage", "ShareOnboardingGuide",
                   "AppifactRepl", "FetchInboxMessage", "SubagentHandback",
                   "AgentOutput", "ArtifactCheck", "ArtifactComments", "ArtifactData",
                   "BashOutput", "Design", "EndConversation", "ExitPlanModeV2",
                   "ListConnectors", "OfferChromeSetup", "PowerShell", "PublishPlugin",
                   "SearchMcpRegistry", "SendFile", "SendUserFile", "SuggestConnectors",
                   "WaitForMcpServers", "SubscribePR", "SendToProject", "SendToProjectContext",
            "ReadWidgetContext", "WrapUp", "CrossSessionMessage",
                   "PlaceHookTranscript", "ReadSessionRepo", "RunModFs",
                   "GetGoal", "SetGoal", "PauseGoal", "RunModFsRange", "WorkspaceDiffForRemote"}
        with tempfile.TemporaryDirectory() as tmp:
            options = client.claude_code_session_options(set(), tmp)
        self.assertEqual(
            (declared | aliases) - set(options["disallowedTools"]),
            {"ToolSearch"},
        )

    def test_create_rejects_unreviewed_runtime_before_any_spawn(self) -> None:
        client = load_client()
        with patch.object(client, "assert_reviewed_claude_code_version", side_effect=RuntimeError("runtime drift")) as guard:
            with patch.object(client.subprocess, "Popen") as spawn:
                instance = client.ClaudeACPClient()
                with self.assertRaisesRegex(RuntimeError, "runtime drift"):
                    instance.chat.completions.create(messages=[{"role": "user", "content": "hello"}])
                guard.assert_called_once()
                self.assertGreater(guard.call_args.kwargs["timeout"], 0)
                spawn.assert_not_called()

    def test_installed_sdk_union_matches_reviewed_fixture_when_present(self) -> None:
        client = load_client()
        self.assertEqual(
            client._CLAUDE_SDK_TOOLS,
            Path("/opt/coding-clis/node_modules/@anthropic-ai/claude-code/sdk-tools.d.ts"),
        )
        node_modules = Path(os.environ.get("CLAUDE_REVIEW_NODE_MODULES", str(ROOT / "node_modules")))
        sdk_tools = node_modules / "@anthropic-ai/claude-code/sdk-tools.d.ts"
        if not sdk_tools.exists():
            sdk_tools = client._CLAUDE_SDK_TOOLS
        if not sdk_tools.exists():
            self.skipTest("installed SDK checked in the image environment")
        source = sdk_tools.read_text()
        fixture = (ROOT / "tests/fixtures/claude-tool-inputs.txt").read_text()
        pattern = r"export type ToolInputSchemas\s*=([^;]+);"
        source_union = re.search(pattern, source)
        fixture_union = re.search(pattern, fixture)
        assert source_union is not None and fixture_union is not None
        self.assertEqual(source_union.group(0), fixture_union.group(0))
        self.assertEqual(hashlib.sha256(sdk_tools.read_bytes()).hexdigest(), client._REVIEWED_SDK_TOOLS_SHA256)

    def test_reviewed_claude_code_version_guard_fails_closed(self) -> None:
        client = load_client()
        with tempfile.TemporaryDirectory() as tmp:
            package = Path(tmp, "package.json")
            executable = Path(tmp, "claude")
            sdk_tools = Path(tmp, "sdk-tools.d.ts")
            executable.write_text("#!/bin/sh\nprintf '2.1.326 (Claude Code)\\n'\n", encoding="utf-8")
            sdk_tools.write_text("export type ToolInputSchemas = BashInput;\n", encoding="utf-8")
            os.chmod(executable, 0o700)
            executable_sha256 = hashlib.sha256(executable.read_bytes()).hexdigest()
            sdk_tools_sha256 = hashlib.sha256(sdk_tools.read_bytes()).hexdigest()
            def verify() -> str:
                return client.assert_reviewed_claude_code_version(
                    package,
                    executable,
                    sdk_tools,
                    executable_sha256=executable_sha256,
                    sdk_tools_sha256=sdk_tools_sha256,
                )
            package.write_text(json.dumps({"version": "2.1.326"}), encoding="utf-8")
            self.assertEqual(verify(), "2.1.326")

            package.write_text(json.dumps({"version": "2.1.279"}), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "review the native tool deny set"):
                verify()

            package.write_text(json.dumps({"version": "2.1.326"}), encoding="utf-8")
            executable.write_text("#!/bin/sh\nprintf '2.1.279 (Claude Code)\\n'\n", encoding="utf-8")
            executable_sha256 = hashlib.sha256(executable.read_bytes()).hexdigest()
            with self.assertRaisesRegex(RuntimeError, "launched Claude Code executable"):
                verify()

            executable.write_text("#!/bin/sh\nprintf '2.1.326 (Claude Code)\\n'\n# drift\n", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "artifact hash mismatch"):
                verify()

            package.unlink()
            with self.assertRaisesRegex(RuntimeError, "cannot verify"):
                verify()

    def test_connector_allow_tools_reads_specific_rules_not_wildcard(self) -> None:
        client = load_client()
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "settings.json").write_text(json.dumps({
                "permissions": {
                    "allow": [
                        CALENDAR_ALLOW,
                        WILDCARD,
                        "Bash",
                        "mcp__hermes_bridge__probe_tool",
                    ],
                    "deny": [
                        "mcp__claude_ai_Slack__write_*",
                        WILDCARD,
                        "Write",
                    ],
                }
            }), encoding="utf-8")
            rules = client.connector_allow_tools(tmp)
            allow, deny = client.connector_tool_policy(tmp)
        self.assertEqual(rules, [CALENDAR_ALLOW])
        self.assertEqual(allow, [CALENDAR_ALLOW])
        self.assertEqual(deny, ["mcp__claude_ai_Slack__write_*", WILDCARD])
        self.assertNotIn(WILDCARD, rules)

    def test_connector_allow_tools_missing_settings_are_empty(self) -> None:
        client = load_client()
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(client.connector_allow_tools(tmp), [])

    def test_session_options_keep_native_tools_off_and_union_connector_allows(self) -> None:
        client = load_client()
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "settings.json").write_text(json.dumps({
                "permissions": {
                    "allow": [CALENDAR_ALLOW, WILDCARD],
                    "deny": ["mcp__claude_ai_Slack__write_*"],
                }
            }), encoding="utf-8")
            options = client.claude_code_session_options({"probe_tool"}, tmp)
        self.assertEqual(options["tools"], {"type": "preset", "preset": "claude_code"})
        self.assertIs(options["allowDangerouslySkipPermissions"], False)
        denied = options["disallowedTools"]
        expected_native = {
            "Agent", "AppifactRepl", "Artifact", "AskUserQuestion", "Bash", "ClaudeDesign",
            "FetchInboxMessage", "SubagentHandback",
            "CronCreate", "CronDelete", "CronList", "DesignSync", "Edit",
            "EnterPlanMode", "EnterWorktree", "ExitPlanMode", "ExitWorktree",
            "FileEdit", "FileRead", "FileWrite",
            "Glob", "Grep", "ListAgents", "ListMcpResources", "Mcp", "Monitor",
            "NotebookEdit", "Projects", "ProposeGoal", "ProposeSkills",
            "PushNotification", "Read", "ReadMcpResource", "ReadMcpResourceDir",
            "ReadNotifications", "RefreshMcpTools", "RemoteTrigger", "REPL",
            "ReportFindings", "ScheduleWakeup", "SendFeedback", "SendMessage",
            "ShareOnboardingGuide", "ShowOnboardingRolePicker", "Skill", "Task",
            "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop",
            "TaskUpdate", "TodoWrite", "WebFetch", "WebSearch", "Workflow", "Write",
            "AgentOutput", "ArtifactCheck", "ArtifactComments", "ArtifactData",
            "BashOutput", "Design", "EndConversation", "ExitPlanModeV2",
            "ListConnectors", "OfferChromeSetup", "PowerShell", "PublishPlugin",
            "SearchMcpRegistry", "SendFile", "SendUserFile", "SuggestConnectors",
            "WaitForMcpServers", "SubscribePR", "SendToProject", "SendToProjectContext",
            "ReadWidgetContext", "WrapUp", "CrossSessionMessage",
            "PlaceHookTranscript", "ReadSessionRepo", "RunModFs",
            "GetGoal", "SetGoal", "PauseGoal", "RunModFsRange", "WorkspaceDiffForRemote",
        }
        self.assertEqual(set(denied[:-1]), expected_native)
        self.assertEqual(denied[-1], "mcp__claude_ai_Slack__write_*")
        self.assertNotIn("ToolSearch", denied)
        allowed = options["allowedTools"]
        self.assertEqual(
            allowed,
            [
                "mcp__hermes_bridge__probe_tool",
                "ToolSearch",
                CALENDAR_ALLOW,
            ],
        )
        self.assertNotIn(WILDCARD, allowed)
        self.assertNotIn("disableClaudeAiConnectors", options["settings"])

    def test_permission_response_selects_adapter_reject_option(self) -> None:
        client = load_client()
        reply = client.permission_response({
            "options": [
                {"optionId": "allow-once", "name": "Yes", "kind": "allow_once"},
                {"optionId": "reject", "name": "No", "kind": "reject_once"},
            ]
        })
        self.assertEqual(reply, {"outcome": {"outcome": "selected", "optionId": "reject"}})

    def test_permission_response_without_reject_option_cancels(self) -> None:
        client = load_client()
        reply = client.permission_response({"options": [{"optionId": "allow-once", "kind": "allow_once"}]})
        self.assertEqual(reply, {"outcome": {"outcome": "cancelled"}})


if __name__ == "__main__":
    unittest.main()
