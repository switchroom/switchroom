"""Readability leaks from the guided acceptance run (3 Nov 2026), as exact strings.

HF-612's closing note and Fleet QA project update, the HF-616/HF-617 session replies and
comments: no bracketed placeholders, task ids, board names, run numbers or fence vocabulary,
with line breaks, lists, code, links and ordinary prose kept as written.
"""
from __future__ import annotations

from contextlib import contextmanager, nullcontext
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
import uuid

from linear_fake_api import load_plugin, Clock, SELF

load_plugin()
from hermes_fleet_linear_plugin import bridge as bridge_module, chat, native_input
from hermes_fleet_linear_plugin.api import LinearAPI
from hermes_fleet_linear_plugin.bridge import (INTERNAL_ONLY_REPLY, _block_message, _project_line,
                                               _project_summary, _readable, _update_line)
from hermes_fleet_linear_plugin.transport import NativeContext
from test_linear_content_actions import ContentRemote
from test_linear_specialist_authorization import (Authority, Bridge, FakeKanban, Store, ISSUE, SESSION,
                                                  USER, VIEWER)

# HF-612's worker summary as Atlas wrote it (the workspace path is the agent's real root).
HF_612_RAW = """Top 5 largest files in Atlas workspace (/opt/data/workspace), measured 2026-11-03 with `find -type f -printf '%s'` sorted by size:

1. 1642.4 MiB: `rescuezilla-usb/rescuezilla-2.6.2-64bit.resolute.iso`
2. 1330.1 MiB: `review-182/.git/objects/pack/pack-bd7d3271….pack`
3. 1320.6 MiB: `linear-active-agent/.git/objects/pack/pack-b0a06244….pack`
4. 1319.8 MiB: `review-198-b/repo/.git/objects/pack/pack-249961dc….pack`
5. 1319.7 MiB: `review-199-c/r/.git/objects/pack/pack-95eaee05….pack`

Workspace total: 91G across ~3.77M files. Items 2-5 are near-identical git packs from stale review clones; a cleanup candidate (not done, out of scope)."""
HF_612_READABLE = HF_612_RAW.replace(" (/opt/data/workspace)", "")
HF_612_LIST = HF_612_READABLE.split("\n\nWorkspace total")[0]

HF_616_START = ("I started HF-616. It's running as native task **t_d8c47a32** on the `atlas-linear-v1` board, "
                "and that worker does the work, not this chat. Before starting it I checked the board and found "
                "nothing already open for this issue.\n\nWhat happens next:\n"
                "- The worker posts a checkpoint every 2 minutes for 10 minutes.\n- It ends with a summary.")
HF_616_STOP = ("I've stopped HF-616. Task t_d8c47a32 is now **blocked**: the worker exited and nothing is running.\n\n"
               "- **Done before the stop:** checkpoints for minutes 0, 2, 4 and 6.")
HF_617_START = ("HF-617 is running. Native task **t_bd03a4f7** (run 34) is live on the `atlas-linear-v1` board, "
                "and the issue has moved from Backlog to In Progress.\n\nI checked first: nothing else on the "
                "board was running, ready or queued, so this is the only task for the issue.")
HF_617_TAKEOVER = ("**Takeover by Rowan pending.** Sam asked Rowan to take over HF-617 on 2026-11-03.\n\n"
                   "- Atlas's task t_bd03a4f7 is stopped (native Stop event 340). No worker is live.\n"
                   "- The replacement is **held**: `inspect-cleanup` returns `quiescence_proven: false` "
                   "(`native_admission_not_settled`). Run 34's admission is still `unknown` because the gateway "
                   "restarted at 21:15:57Z, during the run.\n"
                   "- Only the minute-0 checkpoint landed.\n\n"
                   "**Next:** Atlas is looking for a supported way to settle the admission. Once quiescence is "
                   "proven, Rowan starts a fresh 10-minute run under its own task and becomes the delegate.")
LEAKS = ("t_d8c47a32", "t_bd03a4f7", "atlas-linear-v1", "run 34", "Run 34", "fence", "quiescence",
         "admission", "[local artifact]", "/opt/data", "Stop event")


class WorkspacePathTests(unittest.TestCase):
    def test_hf_612_closing_summary_names_the_workspace_in_words(self):
        self.assertEqual(_project_summary(HF_612_RAW, 4000), HF_612_READABLE)

    def test_workspace_root_in_a_code_span_reads_as_words(self):
        self.assertEqual(_project_summary("The five largest files in `/opt/data/workspace`:", 4000),
                         "The five largest files in the workspace:")
        self.assertEqual(_project_summary("Wrote /opt/data/workspace/review-182/notes.md today.", 4000),
                         "Wrote `review-182/notes.md` today.")

    def test_paths_inside_code_stay_code_without_the_machine_prefix(self):
        self.assertEqual(_project_summary("Ran `find /opt/data/workspace -type f | sort`.", 4000),
                         "Ran `find workspace -type f | sort`.")
        self.assertEqual(_project_summary("```\ncat /var/log/app.log\n```", 4000), "```\ncat app.log\n```")

    def test_asides_and_links_stay_readable(self):
        self.assertEqual(_project_summary("Results are in the workspace (/opt/data/workspace).", 4000),
                         "Results are in the workspace.")
        self.assertEqual(_project_summary("See (/opt/data/workspace).", 4000), "See (the workspace).")
        self.assertEqual(_project_summary("Open [the report](/opt/data/out/report.md) for details.", 4000),
                         "Open the report (`report.md`) for details.")
        self.assertEqual(_project_summary("Open [the PR](https://github.com/acme/app/pull/12).", 4000),
                         "Open [the PR](https://github.com/acme/app/pull/12).")

    def test_a_file_in_parentheses_keeps_its_name(self):
        self.assertEqual(_project_summary("Saved the report (/opt/data/out/report.md).", 4000),
                         "Saved the report (`report.md`).")

    def test_home_folders_never_name_the_machine(self):
        self.assertEqual(_project_summary("Cloned into /home/ken today.", 4000), "Cloned into a local folder today.")


class ProjectUpdateTests(unittest.TestCase):
    def test_hf_612_project_update_keeps_its_list(self):
        self.assertEqual("Agent update\n\n" + _update_line("HF-612", _project_line(HF_612_READABLE, [])),
                         "Agent update\n\n- HF-612: Done.\n\n" +
                         "\n".join(f"  {line}" if line else "" for line in HF_612_READABLE.split("\n")))

    def test_long_update_trims_at_a_list_item_never_mid_list(self):
        with patch.object(bridge_module, "PROJECT_LINE_LIMIT", 400):
            line = _project_line(HF_612_READABLE, [])
        self.assertEqual(line, "Done.\n\n" + HF_612_LIST.rsplit("\n5.", 1)[0] + "\n\nThe full summary is on the issue.")
        self.assertNotRegex(line, r"\s\d\.$")

    def test_single_line_update_is_unchanged(self):
        self.assertEqual(_update_line("HF-1", "Done. Fixed the export."), "- HF-1: Done. Fixed the export.")
        pr = "https://github.com/acme/app/pull/12"
        self.assertEqual(_update_line("HF-1", _project_line("Fixed the export.", [pr])),
                         f"- HF-1: Done. Fixed the export.\n\n  Evidence: {pr}")

    def test_project_update_hides_linears_progress_diff_and_keeps_health(self):
        sent = []
        api = LinearAPI(lambda: "synthetic")
        api.graphql = lambda query, variables=None: sent.append(variables) or {"projectUpdateCreate": {"success": True}}
        api.create_project_update(str(uuid.uuid4()), "project-1", "Agent update\n\n- HF-612: Done.")
        self.assertIs(sent[0]["input"]["isDiffHidden"], True)
        self.assertNotIn("health", sent[0]["input"])  # A person's "at risk" is never overridden.
        self.assertEqual(sent[0]["input"]["body"], "Agent update\n\n- HF-612: Done.")


class RecordingAuthority(Authority):
    def __init__(self):
        super().__init__()
        self.inputs = []

    def transport(self, url, body, headers):
        payload = json.loads(body)
        if payload["query"].lstrip().startswith("mutation"):
            self.inputs.append((payload["query"], (payload.get("variables") or {}).get("input") or {}))
        return super().transport(url, body, headers)


class FinishedThroughTheBridgeTests(unittest.TestCase):
    """HF-612 end to end: the real capture, outbox and scoped sender."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.authority = RecordingAuthority()
        self.authority.issues[ISSUE]["delegate"] = {"id": VIEWER}
        self.authority.issues[ISSUE]["assignee"] = {"id": USER}
        self.store = Store(Path(directory.name) / "linear.db")
        self.kanban = FakeKanban()
        self.task = self.kanban.create(title="OPS-1: list the 5 largest files", body="List them.",
                                       completion_contract="local-only")
        self.kanban.histories[self.task.id] = [SimpleNamespace(id=1, kind="created", created_at=1800000000,
                                                               run_id=None, payload={})]
        self.bridge = Bridge(self.store, self.authority.api(), self.kanban, profile="synthetic",
                             clock=lambda: 1800000000)
        self.bridge.track(ISSUE, self.task.id, requester_session=SESSION)

    def sent(self):
        return {query.split("{")[1].split("(")[0].strip(): fields for query, fields in self.authority.inputs}

    def test_closing_note_and_project_update_read_like_a_colleague(self):
        self.task.status, self.task.result = "done", HF_612_RAW
        self.kanban.histories[self.task.id].append(SimpleNamespace(id=2, kind="completed", created_at=1800000001,
                                                                   run_id=1, payload={"summary": HF_612_RAW}))
        self.bridge._finished(self.store.get(ISSUE), event_id=2)
        self.bridge.flush()
        update = self.sent()["projectUpdateCreate"]
        self.assertEqual(update["body"], "Agent update\n\n" + _update_line("OPS-1", "Done.\n\n" + HF_612_READABLE))
        self.assertIn("\n  2. 1330.1 MiB", update["body"])
        self.assertIs(update["isDiffHidden"], True)
        self.assertNotIn("health", update)
        closing = self.sent()["commentCreate"]
        self.assertEqual(closing["body"], "Done.\n\n" + HF_612_READABLE)
        self.assertNotIn("parentId", closing)
        receipt = self.authority.comment_records[closing["id"]]
        self.assertIsNone(receipt["parent"])
        self.assertEqual(receipt["user"]["id"], VIEWER)
        self.assertEqual(self.sent()["agentActivityCreate"]["content"]["body"],
                         "Completed. The result and checks are in the issue comment.")
        mutations = self.authority.mutations
        self.assertLess(next(i for i, query in enumerate(mutations) if "commentCreate" in query),
                        next(i for i, query in enumerate(mutations) if "agentActivityCreate" in query))

    def test_a_genuine_summary_about_internal_files_still_completes(self):
        summary = "Renamed `native_input.py` to `native_relay.py`; tests pass."
        self.task.status, self.task.result = "done", summary
        self.kanban.histories[self.task.id].append(SimpleNamespace(id=2, kind="completed", created_at=1800000001,
                                                                   run_id=1, payload={"summary": summary}))
        self.bridge._finished(self.store.get(ISSUE), event_id=2)
        self.assertTrue(any(row["kind"] == "status" and row["payload"].get("state") == "done"
                            for row in self.store.pending()))

    def test_worker_checkpoint_is_cleaned(self):
        body = ("**Minute 0:** The run has started on task t_bd03a4f7 (run 34). I'll post a checkpoint every "
                "2 minutes. No blockers.")
        self.bridge._task_event(self.store.get(ISSUE), SimpleNamespace(
            id=3, kind="checkpoint", payload={"body": body, "request_id": "checkpoint-0"}, created_at=3),
            "running", {})
        posted = [row["payload"] for row in self.store.pending() if row["kind"] in ("activity", "comment")]
        texts = [payload.get("body") or payload["content"].get("body") for payload in posted]
        self.assertIn("**Minute 0:** I'll post a checkpoint every 2 minutes. No blockers.", texts)


class SessionReplyTests(unittest.TestCase):
    def test_hf_616_started_reply(self):
        self.assertEqual(_readable(HF_616_START),
                         "I started HF-616. Before starting it I checked the board and found nothing already open "
                         "for this issue.\n\nWhat happens next:\n"
                         "- The worker posts a checkpoint every 2 minutes for 10 minutes.\n- It ends with a summary.")

    def test_hf_616_stopped_reply(self):
        self.assertEqual(_readable(HF_616_STOP),
                         "I've stopped HF-616. The task is now **blocked**: the worker exited and nothing is running."
                         "\n\n- **Done before the stop:** checkpoints for minutes 0, 2, 4 and 6.")

    def test_hf_617_running_reply(self):
        self.assertEqual(_readable(HF_617_START),
                         "HF-617 is running. The task is live, and the issue has moved from Backlog to In Progress."
                         "\n\nI checked first: nothing else on the board was running, ready or queued, so this is "
                         "the only task for the issue.")

    def test_hf_617_takeover_comment(self):
        self.assertEqual(_readable(HF_617_TAKEOVER),
                         "**Takeover by Rowan pending.** Sam asked Rowan to take over HF-617 on 2026-11-03.\n\n"
                         "- Atlas's task is stopped. No worker is live.\n"
                         "- Only the minute-0 checkpoint landed.")

    def test_no_leak_survives_any_observed_text(self):
        for text in (HF_616_START, HF_616_STOP, HF_617_START, HF_617_TAKEOVER):
            out = _readable(text)
            for leak in LEAKS:
                self.assertNotIn(leak, out)
            self.assertEqual(_readable(out), out)  # Deterministic and stable on retry.

    def test_only_internal_text_becomes_empty(self):
        self.assertEqual(_readable("Run 35 refused by the previous-execution fence."), "")


class NonRegressionTests(unittest.TestCase):
    """Ordinary prose, code and links pass through byte for byte."""

    UNCHANGED = (
        "CI/CD passed.\n\nNext: read/write split, and/or deploy.",
        "Merged https://github.com/acme/app/pull/12 after /status; 24/7 w/o input/output loss.",
        "Run `make test` then `git push`. See [the PR](https://github.com/acme/app/pull/12).",
        "I'll run 5 checks on the worker before the deploy.",
        "The tests passed on run 2.",
        "Use a code fence for the snippet; the fence keeps formatting.",
        "University admission rules changed, so the form has a new field.",
        "The task is blocked on review. Next: address the comments.",
        "- one\n  - nested\n\n1. first\n2. second",
        "Renamed `native_input.py` to `native_relay.py` and added tests.",
        "Fixed the `worker_lost` and `gave_up` handling so restarts recover.",
        "The system is quiescent now.",
        "The board approved the admission policy for next term.",
        "We need a fence between the worker nodes.",
        "Run 3 failed after a restart of the database; I re-ran it.",
        "Mr. Smith on run 4, the task lost power.",
    )

    def test_plain_text_is_returned_unchanged(self):
        for text in self.UNCHANGED:
            with self.subTest(text=text):
                self.assertEqual(_readable(text), text)
                self.assertEqual(_project_summary(text, 4000), text)

    def test_code_keeps_every_character_when_a_line_changes(self):
        text = ("Task t_d8c47a32 ran `a  b` and `x ,y`. Run 34 lost to a gateway restart.\n\n"
                "```\na = 1\n\n\n\nb = 2\n```")
        self.assertEqual(_readable(text), "The task ran `a  b` and `x ,y`.\n\n```\na = 1\n\n\n\nb = 2\n```")

    def test_code_blocks_the_user_asked_for_are_untouched(self):
        text = ("Here is the command:\n\n```sh\nhermes kanban show t_d8c47a32 --board atlas-linear-v1\n"
                "# run 34 hit the previous-execution fence\n```")
        self.assertEqual(_readable(text), text)

    def test_only_the_internal_sentence_changes_in_a_mixed_line(self):
        self.assertEqual(_readable("Merged https://github.com/acme/app/pull/12 and CI is green. "
                                   "Run 34 lost to a gateway restart."),
                         "Merged https://github.com/acme/app/pull/12 and CI is green.")


    def test_a_sentence_ending_in_a_link_is_kept_apart_from_an_internal_one(self):
        self.assertEqual(_readable("See https://github.com/acme/app/pull/12. Run 34 lost to a gateway restart."),
                         "See https://github.com/acme/app/pull/12.")


class BlockerWordingTests(unittest.TestCase):
    def test_hf_616_stop_reads_as_a_stop_not_a_question(self):
        kind, body = _block_message({"kind": "needs_input", "reason":
                                     "Stopped by Sam from Linear (HF-616). Do not resume unless Sam asks."}, "blocked")
        self.assertEqual((kind, body), ("response", "Stopped by Sam from Linear (HF-616). It stays stopped until "
                                                    "Sam asks the agent to resume."))

    def test_hf_617_handoff_drops_run_numbers_and_the_fence(self):
        kind, body = _block_message({"kind": "needs_input", "reason": (
            "Handed off: Sam asked Rowan to take over HF-617 (fresh 10-minute run). Keep this task stopped; do not "
            "resume. Run 34 lost to a gateway restart, run 35 refused by the previous-execution fence.")}, "blocked")
        self.assertEqual((kind, body), ("response", "Handed off: Sam asked Rowan to take over HF-617 (fresh 10-minute "
                                                    "run). It stays stopped until someone asks the agent to resume."))

    def test_a_request_that_starts_with_stopped_still_waits_on_the_person(self):
        kind, body = _block_message({"kind": "needs_input", "reason":
                                     "Stopped at the login page; I need the staging account name from Sam."}, "blocked")
        self.assertEqual((kind, body), ("elicitation", "**Waiting on you**\n\nStopped at the login page; I need the "
                                                       "staging account name from Sam.\n\n**Next:** once this is "
                                                       "answered, ask the agent to resume and it continues the same task."))

    def test_a_real_question_still_waits_on_the_person(self):
        kind, body = _block_message({"kind": "needs_input", "reason": "Stopped at login: which account should I use?"},
                                    "blocked")
        self.assertEqual(kind, "elicitation")
        self.assertTrue(body.startswith("**Waiting on you**\n\nStopped at login: which account should I use?"))


class FakeReplyBridge:
    profile = "synthetic"

    def __init__(self):
        self.queued = []
        self.api = SimpleNamespace(requester_session=lambda *a, **k: nullcontext(),
                                   agent_session=lambda session_id: {"issue": {"id": ISSUE}})
        self.store = SimpleNamespace(enqueue=lambda kind, payload, at: self.queued.append(payload) or payload["id"],
                                     get=lambda issue_id: None,
                                     newer_conversation_input_open=lambda *args: False)  # No other live input/work.

    def _effect_issue(self, issue_id):
        return {"id": issue_id}

    @staticmethod
    def clock():
        return 1800000000.0


class PostedThroughThePluginTests(unittest.TestCase):
    def test_session_reply_is_cleaned_before_it_is_queued(self):
        bridge = FakeReplyBridge()
        first = native_input.queue_reply(bridge, ISSUE, SESSION, "activity-1", HF_617_START)
        again = native_input.queue_reply(bridge, ISSUE, SESSION, "activity-1", HF_617_START)
        self.assertEqual(first, again)  # A retry keeps the same remote create identity.
        self.assertEqual(bridge.queued[0]["content"]["body"], _readable(HF_617_START))
        native_input.queue_reply(bridge, ISSUE, SESSION, "activity-2", "Run 35 refused by the previous-execution fence.")
        self.assertEqual(bridge.queued[-1]["content"]["body"], INTERNAL_ONLY_REPLY)

    def test_reply_identity_is_the_providers_text(self):
        bridge = FakeReplyBridge()
        native_input.queue_reply(bridge, ISSUE, SESSION, "activity-1", HF_617_START)
        import hashlib
        expected = bridge_module.stable_uuid4("native-reply", "synthetic", ISSUE, SESSION, "activity-1",
                                              hashlib.sha256(HF_617_START.encode()).hexdigest())
        self.assertEqual(bridge.queued[0]["id"], expected)  # Same id as a row queued before the filter.

    def test_session_prompt_asks_for_colleague_replies(self):
        projected = native_input.NativeInput("org", ISSUE, SESSION, USER, "activity-1", "hi", 1.0,
                                             source="delegation")
        context = projected.channel_context()
        self.assertIn(native_input.READER_NOTE, context)
        for phrase in ("task ids", "board names", "run numbers"):
            self.assertIn(phrase, native_input.READER_NOTE)
            self.assertIn(phrase, bridge_module.TASK_BODY)

    def test_linear_tool_comment_is_cleaned(self):
        with tempfile.TemporaryDirectory() as directory:
            clock = Clock()
            remote = ContentRemote(clock)
            self.addCleanup(remote.close)
            remote.add_issue("issue-1", "ABC-1", project=None)
            remote.set_delegate("issue-1", {"id": SELF})
            store = Store(Path(directory) / "state.db")
            store.put("issue-1", "chat", "chat")
            bridge = Bridge(store, LinearAPI(lambda: "synthetic", endpoint=remote.url), SimpleNamespace(),
                            profile="alpha", clock=clock)
            bridge.profile_home = Path(directory)
            context = NativeContext(home=directory, session_key="chat", session_id="session", profile="alpha",
                                    platform="slack", source="slack")
            request_id = str(uuid.uuid4())
            args = {"action": "add_comment", "issue": "ABC-1", "id": request_id, "body": HF_617_TAKEOVER}
            with patch.object(bridge, "flush"):
                self.assertTrue(json.loads(chat.handle(bridge, args, context))["ok"])
                self.assertTrue(json.loads(chat.handle(bridge, args, context))["ok"])  # Same id, same content.
                # A comment queued before the filter shipped keeps its body on a same-id retry.
                old = {**args, "id": str(uuid.uuid4())}
                with patch.object(bridge_module, "_readable", lambda text: text):
                    self.assertTrue(json.loads(chat.handle(bridge, old, context))["ok"])
                self.assertTrue(json.loads(chat.handle(bridge, old, context))["ok"])
            self.assertTrue(bridge._send(store.outbox_row(request_id)))
            self.assertEqual([c["body"] for c in remote.comments], [_readable(HF_617_TAKEOVER)])


if __name__ == "__main__":
    unittest.main()
