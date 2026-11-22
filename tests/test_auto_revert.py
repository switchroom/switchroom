"""Auto-revert decisions and workflow shape: only a red fast-lane merge over a green parent reverts."""
import importlib.util
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/auto-revert.py"
WORKFLOW = ROOT / ".github/workflows/auto-revert.yml"


def load():
    spec = importlib.util.spec_from_file_location("auto_revert", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(run_id, sha="a" * 40, conclusion="failure", created="2026-11-22T01:00:00Z", status="completed"):
    return {"id": run_id, "head_sha": sha, "event": "push", "head_branch": "main",
            "path": ".github/workflows/ci.yml", "conclusion": conclusion, "status": status,
            "created_at": created}


class DecideTests(unittest.TestCase):
    def setUp(self):
        self.module = load()
        self.red = run(2)
        self.base = dict(run=self.red, runs_for_sha=[self.red],
                         parent_runs=[run(1, sha="b" * 40, conclusion="success", created="2026-11-22T00:00:00Z")],
                         newer_main_runs=[], plan={"deferred_on_pr": ["linear"]}, revert_exists=False)

    def decide(self, **override):
        return self.module.decide(**{**self.base, **override})[0]

    def test_red_fast_lane_merge_over_green_parent_reverts(self):
        self.assertEqual(self.decide(), "revert")

    def test_fully_gated_merge_is_only_reported(self):
        for plan in ({}, {"deferred_on_pr": []}, None):
            with self.subTest(plan=plan):
                self.assertEqual(self.decide(plan=plan), "report")

    def test_red_or_unknown_parent_never_stacks_a_revert(self):
        for parent in ([], [run(1, sha="b" * 40, conclusion="failure")],
                       [run(1, sha="b" * 40, conclusion=None, status="in_progress")]):
            with self.subTest(parent=parent):
                self.assertEqual(self.decide(parent_runs=parent), "report")

    def test_superseded_fixed_or_already_handled_does_nothing(self):
        self.assertEqual(self.decide(runs_for_sha=[self.red, run(3, created="2026-11-22T02:00:00Z")]), "none")
        self.assertEqual(self.decide(newer_main_runs=[run(4, sha="c" * 40, conclusion="success")]), "none")
        self.assertEqual(self.decide(revert_exists=True), "none")
        self.assertEqual(self.decide(run=dict(self.red, conclusion="cancelled")), "none")

    def test_newer_red_runs_do_not_suppress_the_revert(self):
        self.assertEqual(self.decide(newer_main_runs=[run(4, sha="c" * 40)]), "revert")


class WorkflowShapeTests(unittest.TestCase):
    def test_trigger_scope_permissions_and_pins(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn('workflows: ["CI"]', text)
        self.assertIn("github.event.workflow_run.conclusion == 'failure'", text)
        self.assertIn("github.event.workflow_run.event == 'push'", text)
        self.assertIn("github.event.workflow_run.head_branch == 'main'", text)
        self.assertIn("permissions:\n  contents: read", text)
        # The job token never writes code; only the App token (for the revert branch) does.
        self.assertNotRegex(text, r"(?m)^\s+contents: write")
        self.assertIn("gh pr merge --auto --squash", text)
        self.assertNotIn("--force", text)
        self.assertNotIn("--admin", text)
        self.assertIn("if: steps.decide.outputs.action == 'revert'", text)
        for uses in re.findall(r"(?m)^\s*-?\s*uses:\s*([^\s#]+)", text):
            self.assertRegex(uses, r"^[^@]+@[0-9a-f]{40}$")
        # Event data reaches shell only through env, never interpolated into a run script.
        for script in re.findall(r"(?ms)^ {8}run: \|\n(.*?)(?=^ {6}- |\Z)", text):
            self.assertNotIn("${{", script)


if __name__ == "__main__":
    unittest.main()
