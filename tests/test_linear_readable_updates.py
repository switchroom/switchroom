"""Linear text reads like a colleague's update: words, Markdown and line breaks survive."""
from __future__ import annotations

import ast
import re
import unittest
from pathlib import Path

from linear_fake_api import load_plugin

plugin = load_plugin()
from hermes_fleet_linear_plugin import bridge as bridge_module
from hermes_fleet_linear_plugin.bridge import (HELD_NOTICE, TASK_BODY, _block_message, _done_body,
                                               _followup_notice, _plain_notice, _project_summary)

# Words that belong in native Kanban history and logs, never in a Linear comment.
INTERNAL = re.compile(r"(?i)\b(?:native|reconcil\w*|admission|admit\w*|executor|binding|completion contract|"
                      r"inspect\w*|ordering|run-scoped|increment|authoritative|exact head|worker/effect|effects?)\b")


class ReadableSummaryTests(unittest.TestCase):
    def test_review_example_survives_intact(self):
        text = "CI/CD passed.\n\nNext: read/write split, and/or deploy."
        self.assertEqual(_project_summary(text, 1500), text)

    def test_ordinary_slashes_urls_and_commands_are_not_paths(self):
        text = "Merged https://github.com/acme/app/pull/12 after /status; 24/7 w/o input/output loss."
        self.assertEqual(_project_summary(text), text)

    def test_real_local_paths_are_masked_and_punctuation_kept(self):
        text = ("Logs: /opt/data/runs/42/out.log, ~/repo/notes.md and ./build/a.txt; "
                "see ../shared/x and file:///tmp/report.html. Also C:\\Users\\ops\\x.txt.")
        out = _project_summary(text, 1500)
        for path in ("/opt/data", "~/repo", "file://", "C:\\Users"):
            self.assertNotIn(path, out)
        # Names people can use, never a bracketed placeholder; relative paths stay as written.
        self.assertEqual(out, "Logs: `out.log`, `notes.md` and `./build/a.txt`; see `../shared/x` and "
                              "`report.html`. Also `x.txt`.")

    def test_secrets_are_still_redacted(self):
        out = _project_summary("Used token=abc123 and ghp_ABCDEF123 to push.")
        self.assertNotIn("abc123", out)
        self.assertNotIn("ghp_", out)
        self.assertIn("[redacted]", out)

    def test_markdown_lists_and_code_keep_their_shape(self):
        text = "**Delivered**\n\n- one\n  - nested   \n\n\n\n```\ncode\n```"
        self.assertEqual(_project_summary(text, 1500), "**Delivered**\n\n- one\n  - nested\n\n```\ncode\n```")

    def test_trim_stops_at_a_sentence_or_word_never_mid_word(self):
        sentences = "The deploy finished cleanly. " * 20
        out = _project_summary(sentences, 100)
        self.assertLessEqual(len(out), 100)
        self.assertTrue(out.endswith("cleanly."))
        words = "alpha beta gamma delta " * 30
        out = _project_summary(words, 50)
        self.assertTrue(out.endswith("\u2026"))
        self.assertTrue(all(word in {"alpha", "beta", "gamma", "delta"} for word in out[:-1].split()))
        paragraphs = "First paragraph is complete.\n\n" + "Second paragraph keeps going " * 10
        self.assertEqual(_project_summary(paragraphs, 60), "First paragraph is complete.")

    def test_one_line_for_project_update_lines(self):
        self.assertEqual(_project_summary("CI/CD passed.\n\nNext: deploy.", one_line=True),
                         "CI/CD passed. Next: deploy.")


    def test_api_routes_and_url_paths_are_not_local_artifacts(self):
        text = "Added /api/v1/x and GET /v2/users/42/orders; the /graphql/admin route now checks scopes."
        self.assertEqual(_project_summary(text, 1500), text)

    def test_filesystem_paths_are_still_masked(self):
        for path, shown in (("/opt/data/x", "`x`"), ("/home/ken/repo/a.py", "`a.py`"), ("/tmp/build/out", "`out`"),
                            ("/var/log/app.log", "`app.log`"), ("/private/report.md", "`report.md`"),
                            ("/srv/app/config", "`config`"), ("/reports/q3/summary.csv", "`summary.csv`"),
                            ("/home/ken", "a local folder"), ("/opt/data/workspace", "the workspace")):
            with self.subTest(path=path):
                self.assertEqual(_project_summary(f"See {path} now.", 1500), f"See {shown} now.")

    def test_closing_note_keeps_full_paths_and_slash_words(self):
        # HF-823: a Done note named `/opt/hermes/plugins/linear/plugin.yaml` as `plugin.yaml`.
        text = ("Read `/opt/hermes/plugins/linear/plugin.yaml` and /opt/data/workspace/repo/a.py; "
                "CI/CD and read/write stay as written, see [the log](/var/log/app.log).")
        self.assertEqual(_project_summary(text, 1500, keep_paths=True),
                         "Read `/opt/hermes/plugins/linear/plugin.yaml` and /opt/data/workspace/repo/a.py; "
                         "CI/CD and read/write stay as written, see the log (`/var/log/app.log`).")
        # Secrets are still redacted; only the path masking is off.
        self.assertEqual(_project_summary("Token ghp_abc123 in /opt/x/y.py.", 1500, keep_paths=True),
                         "Token [redacted] in /opt/x/y.py.")
        body = _done_body(_project_summary("Changed `/opt/hermes/plugins/linear/plugin.yaml`.", 4000, keep_paths=True), [])
        self.assertEqual(body, "Done. Changed `/opt/hermes/plugins/linear/plugin.yaml`.")

    def test_trim_never_leaves_a_code_fence_open(self):
        text = "Summary first.\n\n```python\n" + "".join(f"line_{n} = {n}\n" for n in range(80)) + "```\n\nAfter."
        for limit in (60, 120, 300, 700):
            with self.subTest(limit=limit):
                out = _project_summary(text, limit)
                self.assertLessEqual(len(out), limit)
                fences = [line for line in out.splitlines() if line.lstrip().startswith("```")]
                self.assertEqual(len(fences) % 2, 0, out)


class DoneBodyTests(unittest.TestCase):
    PR = "https://github.com/acme/app/pull/12"

    def test_structured_summary_starts_on_its_own_paragraph(self):
        body = _done_body("**Delivered**\n\nFixed the export.", [])
        self.assertEqual(body, "Done.\n\n**Delivered**\n\nFixed the export.")
        self.assertNotIn("Done. **", body)

    def test_one_line_summary_stays_one_sentence_and_lists_evidence_once(self):
        self.assertEqual(_done_body("Fixed the export.", [self.PR]), f"Done. Fixed the export.\n\nEvidence: {self.PR}")
        self.assertEqual(_done_body("", [self.PR]), f"Done.\n\nEvidence: {self.PR}")
        self.assertEqual(_done_body("", []), "Done.")

    def test_worker_evidence_section_is_not_repeated(self):
        summary = f"**Delivered**\n\nFixed it.\n\n**Evidence**\n\n- {self.PR} merged, CI green\n\n**Remaining**\n\nNothing"
        body = _done_body(summary, [self.PR])
        self.assertEqual(len(re.findall(r"(?i)evidence", body)), 1, body)
        self.assertEqual(body.count(self.PR), 1)
        other = "https://deploy.example/check/9"
        body = _done_body(summary, [self.PR, other])
        self.assertEqual(len(re.findall(r"(?i)evidence", body)), 1, body)
        self.assertIn(other, body)
        self.assertEqual(body.count(self.PR), 1)

    def test_link_already_in_a_plain_summary_is_not_repeated(self):
        body = _done_body(f"Merged {self.PR} after review.", [self.PR])
        self.assertEqual(body, f"Done. Merged {self.PR} after review.")


class PlainNoticeTests(unittest.TestCase):
    def test_internal_text_is_replaced_by_a_plain_sentence(self):
        raw = "Native task explicitly references a different or ambiguous issue; instruction or reporting link held for inspection"
        self.assertEqual(_plain_notice(raw), HELD_NOTICE)
        self.assertIsNone(INTERNAL.search(HELD_NOTICE))
        plain = "Not starting: this issue is closed or assigned to someone else."
        self.assertEqual(_plain_notice(plain), plain)

    def test_every_literal_decline_reads_like_a_colleague(self):
        """Every hard-coded reply to a Linear session (decline, Stop, existing work, keepalive) is plain."""
        tree = ast.parse(Path(bridge_module.__file__).read_text())
        texts = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and getattr(node.func, "attr", "") in ("_decline", "_progress_activity"):
                for arg in node.args[2:]:
                    for part in ast.walk(arg):
                        if isinstance(part, ast.Constant) and isinstance(part.value, str) and len(part.value) > 3:
                            texts.append(part.value)
        self.assertGreater(len(texts), 20)
        leaked = [text for text in texts if INTERNAL.search(text)]
        self.assertEqual(leaked, [])

    def test_followup_outcomes_are_plain(self):
        for result in ({"status": "running", "message": "Instruction saved on the existing native task."},
                       {"status": "running", "message": "Instruction already saved on the existing native task."},
                       {"status": "done", "message": "Work has ended. Review history or explicitly create a new native increment."},
                       {"status": "blocked", "message": "Work is stopped or waiting. Use an authorized native task control to resume; no automatic resume was attempted."},
                       {"status": "running", "message": "Follow-up ordering is stale or unverifiable. Inspect native task history and send a current native instruction."},
                       {"status": "running", "message": "something new"}):
            with self.subTest(result=result["message"]):
                text = _followup_notice(result)
                self.assertIsNone(INTERNAL.search(text), text)
                self.assertTrue(text.endswith("."))
        self.assertIn("passed", _followup_notice({"status": "running", "message": "Instruction saved on the existing native task."}))


class PlainBlockerTests(unittest.TestCase):
    RAW = "pid 1591346 exited with code 130 [owner admission settled interrupted]"

    def test_runtime_blocks_hide_raw_errors(self):
        for kind in ("transient", "capability"):
            for status in ("blocked", "triage"):
                with self.subTest(kind=kind, status=status):
                    _, body = _block_message({"kind": kind, "reason": self.RAW}, status)
                    for leaked in ("pid", "1591346", "exit", "admission", "native", "reconcil"):
                        self.assertNotIn(leaked, body)
                    self.assertTrue(body.startswith("Paused "))

    def test_human_blocks_say_what_is_needed_from_whom(self):
        kind, body = _block_message({"kind": "needs_input", "reason": "Which region?\nUse /opt/data/x"}, "blocked")
        self.assertEqual(kind, "elicitation")
        # The path is the operator's detail; the reader gets the question.
        self.assertEqual(body, "**Waiting on you**\n\nWhich region?\n\n**Next:** once this is answered, "
                               "ask the agent to resume and it continues the same task.")
        _, body = _block_message({"kind": "dependency", "reason": ""}, "blocked")
        self.assertEqual(body, "**Waiting for a dependency**\n\nEarlier work must finish first.\n\n"
                               "**Next:** work continues when it is done.")

    def test_blockers_keep_commands_shas_and_code_off_the_issue(self):
        from hermes_fleet_linear_plugin.bridge import BLOCKER_FALLBACK, _human_reason
        reason = ("Sam needs to approve the scoped rollout because the parked agents are on an older image. "
                  "Run `host-root host -- sudo -n /opt/x/launch.sh` now. Merged at 8ecc939e1efd.\n"
                  "```\nsystemctl restart hermes\n```\nThe reviewer passed `fix-branch`.")
        self.assertEqual(_human_reason(reason), "Sam needs to approve the scoped rollout because the parked agents "
                                                "are on an older image. The reviewer passed `fix-branch`.")
        self.assertEqual(_human_reason(reason, limit=1), "Sam needs to approve the scoped rollout because the "
                                                         "parked agents are on an older image.")
        for command in ("sudo -n systemctl restart x", "Run: docker compose up -d", "$ hermes kanban show t_1",
                        "Approve 0123abcd4567.", "Use --force-recreate"):
            self.assertEqual(_human_reason(command), "", command)
        _, body = _block_message({"kind": "needs_input", "reason": "sudo -n systemctl restart hermes"}, "blocked")
        self.assertEqual(body, f"**Waiting on you**\n\n{BLOCKER_FALLBACK}\n\n**Next:** once this is answered, "
                               "ask the agent to resume and it continues the same task.")
        _, body = _block_message({"kind": "needs_input", "reason": ""}, "blocked")
        self.assertTrue(body.startswith("**Waiting on you**\n\nThe agent needs a decision."))


class WorkerPromptTests(unittest.TestCase):
    def test_workers_are_told_to_publish_checkpoints_and_a_closing_summary(self):
        self.assertIn("kanban_comment", TASK_BODY)
        self.assertIn("human_checkpoint=true", TASK_BODY)
        self.assertIn("request_id", TASK_BODY)
        for section in ("**Delivered**", "**Evidence**", "**Remaining**"):
            self.assertIn(section, TASK_BODY)
        TASK_BODY.format(ident="ABC-1", url="https://linear.app/x/issue/ABC-1", context="")

    def test_workers_get_the_plan_section_milestone_shape_and_link_rules(self):
        from hermes_fleet_linear_plugin.bridge import PLAN_HEADING
        for phrase in (f'"{PLAN_HEADING}"', "WITHOUT human_checkpoint", "only when the stage changes",
                       "**What happened:**", "**Why:**", "**Next:**", "40 to 100 words", "commit SHAs",
                       "linked text", "How we got here"):
            self.assertIn(phrase, TASK_BODY)
        self.assertNotIn("Started", TASK_BODY)


if __name__ == "__main__":
    unittest.main()
