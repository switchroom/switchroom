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


def test_job(step="Unit tests", conclusion="failure"):
    return {"name": "source-tests", "conclusion": conclusion,
            "steps": [{"name": "Set up job", "conclusion": "success"}, {"name": step, "conclusion": conclusion}]}


class DecideTests(unittest.TestCase):
    def setUp(self):
        self.module = load()
        self.red = run(2)
        self.base = dict(run=self.red, newer_main_runs=[], jobs=[test_job()],
                         streak=[{"sha": "a" * 40, "message": "feat(linear): tidy\n", "reverted": False}],
                         plan={"deferred_on_pr": ["linear"]})

    def decide(self, **override):
        return self.module.decide(**{**self.base, **override})[0]

    def test_red_fast_lane_culprit_with_test_failure_reverts(self):
        self.assertEqual(self.decide(), "revert")
        for step in ("Real Agent Kanban scenarios", "Guarded native input against release Core",
                     "Real native worker journeys", "Enforce selected work"):
            self.assertEqual(self.decide(jobs=[test_job(step)]), "revert", step)

    def test_fully_gated_culprit_is_only_reported(self):
        for plan in ({}, {"deferred_on_pr": []}, None):
            with self.subTest(plan=plan):
                self.assertEqual(self.decide(plan=plan), "report")

    def test_infrastructure_failures_are_only_reported(self):
        for jobs in ([test_job("Run actions/checkout@x")], [test_job("Prepare real Agent test environment")],
                     [test_job(), {"name": "runtime (input 1/3)", "conclusion": "failure", "steps": []}], []):
            with self.subTest(jobs=jobs):
                self.assertEqual(self.decide(jobs=jobs), "report")

    def test_pending_or_green_newer_main_run_defers_or_drops(self):
        self.assertEqual(self.decide(newer_main_runs=[run(3, sha="c" * 40, conclusion=None, status="in_progress")]), "none")
        self.assertEqual(self.decide(newer_main_runs=[run(3, sha="c" * 40, conclusion=None, status="queued")]), "none")
        self.assertEqual(self.decide(newer_main_runs=[run(4, sha="c" * 40, conclusion="success")]), "none")
        # A newer completed red run does not hide the culprit: the streak still starts at it.
        self.assertEqual(self.decide(newer_main_runs=[run(4, sha="c" * 40)]), "revert")

    def test_reverts_are_never_reverted_and_reverted_culprits_are_skipped(self):
        for message in ('Revert "feat(linear): tidy"\n', "Revert abc: main CI went red\n",
                        "fix\n\nThis reverts commit " + "b" * 40 + ".\n"):
            with self.subTest(message=message):
                streak = [{"sha": "a" * 40, "message": message, "reverted": False}]
                self.assertEqual(self.decide(streak=streak), "report")
        self.assertEqual(self.decide(streak=[{"sha": "a" * 40, "message": "x", "reverted": True}]), "none")

    def test_unwalkable_streak_or_other_conclusions_do_not_revert(self):
        self.assertEqual(self.decide(streak=None), "report")
        self.assertEqual(self.decide(streak=[]), "report")
        self.assertEqual(self.decide(run=dict(self.red, conclusion="cancelled")), "none")

    def test_newest_state_and_test_step_classification(self):
        self.assertEqual(self.module.newest_state([]), "absent")
        self.assertEqual(self.module.newest_state([run(1, conclusion="success"), run(2, created="2026-11-23T00:00:00Z")]), "red")
        self.assertEqual(self.module.newest_state([run(1, conclusion=None, status="queued")]), "pending")
        self.assertEqual(self.module.newest_state([run(1, conclusion="success")]), "green")


class RedStreakTests(unittest.TestCase):
    def test_walks_back_to_the_first_red_commit_and_sees_prior_reverts(self):
        import subprocess, tempfile
        module = load()
        with tempfile.TemporaryDirectory() as tmp:
            def git(*args):
                return subprocess.check_output(["git", "-C", tmp, *args], text=True).strip()
            git("init", "-q")
            shas = []
            for name in ("green", "culprit", "later"):
                Path(tmp, name).write_text(name)
                git("add", "-A")
                git("-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", name)
                shas.append(git("rev-parse", "HEAD"))
            git("update-ref", "refs/remotes/origin/main", "HEAD")
            module.ROOT = Path(tmp)
            states = {shas[0]: "green", shas[1]: "red", shas[2]: "red"}
            streak = module.red_streak("x/y", shas[2], states.get)
            self.assertEqual([c["sha"] for c in streak], [shas[1], shas[2]])
            self.assertEqual(streak[0]["message"].strip(), "culprit")
            self.assertFalse(streak[0]["reverted"])
            states[shas[1]] = "pending"
            self.assertIsNone(module.red_streak("x/y", shas[2], states.get))
            states.update({shas[1]: "red", shas[0]: "red"})
            self.assertIsNone(module.red_streak("x/y", shas[2], states.get))  # no green parent in reach
            states[shas[0]] = "green"
            Path(tmp, "culprit").unlink()
            git("add", "-A")
            git("-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm",
                f"Revert culprit\n\nThis reverts commit {shas[1]}.")
            git("update-ref", "refs/remotes/origin/main", "HEAD")
            self.assertTrue(module.red_streak("x/y", shas[2], states.get)[0]["reverted"])


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
        self.assertIn("if: always() && steps.decide.outputs.action != '' && steps.decide.outputs.action != 'none'", text)
        for uses in re.findall(r"(?m)^\s*-?\s*uses:\s*([^\s#]+)", text):
            self.assertRegex(uses, r"^[^@]+@[0-9a-f]{40}$")
        # Event data reaches shell only through env, never interpolated into a run script.
        for script in re.findall(r"(?ms)^ {8}run: \|\n(.*?)(?=^ {6}- |\Z)", text):
            self.assertNotIn("${{", script)


if __name__ == "__main__":
    unittest.main()
