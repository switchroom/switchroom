"""HF-748: tool replies carry a ready-made linked name for every issue and project.

The plain [text](url) form is checked against the Telegram and Slack adapters when the
pinned Agent source is available; Telegram shows only the text of [text](<url>).
"""
from __future__ import annotations

import json
import os
import sys
import unittest

from linear_fake_api import load_plugin

load_plugin()
from hermes_fleet_linear_plugin import chat  # noqa: E402
from hermes_fleet_linear_plugin.bridge import PLAN_HEADING, plan_comment, plan_section, plan_split  # noqa: E402

ISSUE_URL = "https://linear.app/example/issue/HF-744/linear-plugin-cpu-fix"
PROJECT_URL = "https://linear.app/example/project/hermes-durable-work-0a1b2c3d"


class MarkdownLinkTests(unittest.TestCase):
    def test_issue_and_project_links(self):
        self.assertEqual(chat.markdown_link({"identifier": "HF-744", "title": "Linear plugin CPU fix", "url": ISSUE_URL}),
                         f"[HF-744 Linear plugin CPU fix]({ISSUE_URL})")
        self.assertEqual(chat.markdown_link({"identifier": "HF-744", "url": ISSUE_URL}), f"[HF-744]({ISSUE_URL})")
        self.assertEqual(chat.markdown_link({"id": "p1", "name": "Hermes [durable] work", "url": PROJECT_URL}),
                         f"[Hermes (durable) work]({PROJECT_URL})")
        title = "Fix [beta]   reporting\nnow"
        self.assertEqual(chat.markdown_link({"identifier": "HF-1", "title": title, "url": ISSUE_URL}),
                         f"[HF-1 Fix (beta) reporting now]({ISSUE_URL})")
        for item in ({"identifier": "HF-1", "url": "http://insecure"}, {"identifier": "HF-1", "url": ISSUE_URL + ")"},
                     {"identifier": "HF-1"}, {"name": "No project path", "url": ISSUE_URL}, "HF-1", None):
            self.assertIsNone(chat.markdown_link(item))

    def test_replies_add_links_without_changing_other_fields(self):
        issue = {"id": "i1", "identifier": "HF-744", "title": "Linear plugin CPU fix", "url": ISSUE_URL,
                 "project": {"id": "p1", "name": "Durable work", "url": PROJECT_URL},
                 "children": [{"id": "i2", "identifier": "HF-745", "title": "Release", "url": ISSUE_URL + "-2"}]}
        reply = json.loads(chat._reply(True, "ok", issue=issue, choices=[chat._choice(
            {"identifier": "HF-746", "title": "Probe", "url": ISSUE_URL + "-3", "state": {"name": "Todo"}})]))
        self.assertEqual(reply["issue"]["markdown_link"], f"[HF-744 Linear plugin CPU fix]({ISSUE_URL})")
        self.assertEqual(reply["issue"]["project"]["markdown_link"], f"[Durable work]({PROJECT_URL})")
        self.assertEqual(reply["issue"]["children"][0]["markdown_link"], f"[HF-745 Release]({ISSUE_URL}-2)")
        self.assertEqual(reply["choices"][0]["markdown_link"], f"[HF-746 Probe]({ISSUE_URL}-3)")
        for key, value in issue.items():
            if key not in ("project", "children"):
                self.assertEqual(reply["issue"][key], value)
        self.assertEqual(chat._choice({"identifier": "HF-9", "title": "No url", "state": {}}).get("markdown_link"), None)
        ref = chat._issue_ref({"id": "i1", "identifier": "HF-744", "title": "Linear plugin CPU fix", "url": ISSUE_URL})
        self.assertEqual(json.loads(chat._reply(True, "ok", issue=ref))["issue"]["markdown_link"],
                         f"[HF-744 Linear plugin CPU fix]({ISSUE_URL})")

    def test_tool_guidance_asks_for_linked_names_and_milestone_comments(self):
        description = chat.SCHEMA["description"]
        for phrase in ("markdown_link", "Telegram, Slack, Desktop", "never a bare key or bare URL",
                       "only when the stage changes", "40 to 100 words"):
            self.assertIn(phrase, description)


class PlanSectionTests(unittest.TestCase):
    def test_plan_section_shape(self):
        section = f"{PLAN_HEADING}\nStatus: waiting on review\n\n- [x] Plan\n- [ ] Merge"
        self.assertEqual(plan_section("  " + section.replace("\n", "\r\n") + "\n\n"), section)
        for body in ("## Plan and progress\nStatus: x", f"{PLAN_HEADING}\n", f"Intro\n{section}",
                     f"{section}\n\n{PLAN_HEADING}\n- [ ] again", "x" * 9000, None):
            self.assertEqual(plan_section(body), "", body)
        self.assertEqual(plan_comment(section), "**Plan and progress**\n\nStatus: waiting on review\n\n- [x] Plan\n- [ ] Merge")

    def test_linear_stored_section_still_reads_as_ours(self):
        # Shape Linear stored for a live plan section (2026-11-19): blank lines after the heading
        # and before the list, [X] for a ticked item and <url> link destinations.
        from hermes_fleet_linear_plugin.api import markdown_matches
        sent = (f"{PLAN_HEADING}\nStatus: live; waiting on review.\n- [x] Merged in [repo#1](https://github.example/pr/1)\n"
                "- [ ] Live check")
        stored = (f"{PLAN_HEADING}\n\nStatus: live; waiting on review.\n\n- [X] Merged in [repo#1](<https://github.example/pr/1>)\n"
                  "- [ ] Live check")
        self.assertTrue(markdown_matches(stored, sent))
        self.assertTrue(markdown_matches(sent, sent.replace("review.\n-", "review.\n\n-")))
        for changed in (stored.replace("- [ ] Live", "- [x] Live"), stored.replace("review.", "Sam."),
                        stored.replace("\n\n- [X]", "\n\n  - [X]"), stored.replace("Status: live; waiting on review.\n\n", "")):
            self.assertFalse(markdown_matches(changed, sent), changed)
        # Only a paragraph followed by a list loses its blank line; other blocks keep theirs.
        for expected in ("- a\n\n- b", "- a\n  more\n\n- b", "```\ncode\n```\n\n- b", "> quote\n\n- b",
                         "Text\n\n2. second", "Text\n\nMore text", "| a |\n\n- b"):
            self.assertFalse(markdown_matches(expected.replace("\n\n", "\n"), expected), expected)

    def test_split_finds_the_last_heading_outside_code(self):
        human = f"Outcome\n\n```\n{PLAN_HEADING}\n```\n"
        section = f"{PLAN_HEADING}\nStatus: x\n- [ ] a"
        self.assertEqual(plan_split(human), (human, None))
        self.assertEqual(plan_split(human + "\n" + section), (human + "\n", section))
        self.assertEqual(plan_split(section), ("", section))
        self.assertEqual(plan_split(None), ("", None))


SOURCE = os.environ.get("HERMES_AGENT_SRC", "")


@unittest.skipUnless(SOURCE, "HERMES_AGENT_SRC is not set; adapter rendering is checked with the pinned Agent")
class ChatRenderingTests(unittest.TestCase):
    """The ready-made link renders as linked text on Telegram and Slack."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, SOURCE)

    def adapter(self, module, name):
        try:
            imported = __import__(module, fromlist=[name])
        except ImportError as exc:
            self.skipTest(f"{module} unavailable: {exc}")
        cls = getattr(imported, name)
        return cls.__new__(cls)

    def test_slack_and_telegram_render_the_link(self):
        link = chat.markdown_link({"identifier": "HF-744", "title": "Linear plugin CPU fix", "url": ISSUE_URL})
        slack = self.adapter("plugins.platforms.slack.adapter", "SlackAdapter").format_message(f"See {link} now")
        self.assertEqual(slack, f"See <{ISSUE_URL}|HF-744 Linear plugin CPU fix> now")
        telegram = self.adapter("plugins.platforms.telegram.adapter", "TelegramAdapter").format_message(f"See {link}")
        self.assertIn(f"]({ISSUE_URL})", telegram)
        angle = self.adapter("plugins.platforms.telegram.adapter", "TelegramAdapter").format_message(
            f"See [HF-744 Linear plugin CPU fix](<{ISSUE_URL}>)")
        self.assertNotIn(ISSUE_URL, angle)  # Why the ready-made link never uses the angle-bracket form.


if __name__ == "__main__":
    unittest.main()
