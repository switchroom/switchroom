"""Daily upstream patch test: re-apply a patch series on a newer upstream, then test.

The script runs against a synthetic local upstream (a ``file://`` git repo
built here), so these tests need git but no network. The workflow checks are
static: they prove the job has no way to publish, pin or roll out.
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "switchroom-upstream-patch-test.py"
WORKFLOW = ROOT / ".github" / "workflows" / "upstream-patch-test.yml"
TEMPLATE = ROOT / "examples" / "overlay-repo" / "ops-kit" / "upstream-patch-test.yml"
STARTER_SERIES = ROOT / "examples" / "overlay-repo" / "patches" / "series.json"
SYNTHETIC_SERIES = ROOT / "tests" / "fixtures" / "upstream-patches" / "series.json"

spec = importlib.util.spec_from_file_location("switchroom_upstream_patch_test", SCRIPT)
upt = importlib.util.module_from_spec(spec)
sys.modules["switchroom_upstream_patch_test"] = upt
spec.loader.exec_module(upt)

try:
    import yaml  # type: ignore
except ImportError:  # pragma: no cover - CI has PyYAML
    yaml = None


def _git(repo: Path, *args: str) -> str:
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid", "GIT_CONFIG_NOSYSTEM": "1"}
    return subprocess.run(["git", "-C", str(repo), *args], check=True, text=True, capture_output=True,
                          env=env).stdout


class SyntheticUpstream:
    """An upstream with a base commit and one newer upstream fix on main."""

    def __init__(self, base: Path) -> None:
        self.repo = base / "upstream"
        self.repo.mkdir()
        _git(self.repo, "init", "-q", "-b", "main")
        (self.repo / "app.py").write_text("def greet():\n    return 'hello'\n\n\ndef answer():\n    return 41\n")
        _git(self.repo, "add", ".")
        _git(self.repo, "commit", "-qm", "base")
        self.base = _git(self.repo, "rev-parse", "HEAD").strip()
        # Upstream later fixes answer() itself.
        (self.repo / "app.py").write_text("def greet():\n    return 'hello'\n\n\ndef answer():\n    return 42\n")
        _git(self.repo, "commit", "-qam", "upstream fixes answer")
        self.head = _git(self.repo, "rev-parse", "HEAD").strip()
        self.url = self.repo.resolve().as_uri()

    def patch_from_base(self, edit) -> str:
        """A patch made against the old base, the way an overlay would have made it."""
        _git(self.repo, "checkout", "-q", "--detach", self.base)
        try:
            edit(self.repo)
            _git(self.repo, "add", "-A")
            return _git(self.repo, "diff", "--cached", self.base)
        finally:
            _git(self.repo, "reset", "-q", "--hard")
            _git(self.repo, "clean", "-qfd")
            _git(self.repo, "checkout", "-q", "main")


def _write_series(directory: Path, url: str, patches: list[tuple[str, str]], command: list[str],
                  when: str = "patched") -> Path:
    entries = []
    for index, (patch_id, text) in enumerate(patches, 1):
        name = f"{index:04d}-{patch_id}.patch"
        (directory / name).write_text(text)
        entries.append({"id": patch_id, "file": name})
    path = directory / "series.json"
    path.write_text(json.dumps({"schema": upt.SCHEMA, "upstream": {"repository": url, "ref": "main"},
                                "patches": entries, "tests": {"command": command, "when": when, "timeout_seconds": 60}}))
    return path


class PatchSeriesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.up = SyntheticUpstream(self.base)
        self.series_dir = self.base / "overlay" / "patches"
        self.series_dir.mkdir(parents=True)
        self.add_lib = self.up.patch_from_base(
            lambda r: (r / "lib.py").write_text("def overlay_feature():\n    return 1\n"))
        self.same_as_upstream = self.up.patch_from_base(
            lambda r: (r / "app.py").write_text((r / "app.py").read_text().replace("41", "42")))
        self.conflicts = self.up.patch_from_base(
            lambda r: (r / "app.py").write_text((r / "app.py").read_text().replace("41", "40 + 3")))
        self.ok_test = [sys.executable, "-c",
                        "import lib, sys; sys.exit(0 if lib.overlay_feature() == 1 else 3)"]

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_series(self, patches, command, **kwargs):
        series = upt.load_series(_write_series(self.series_dir, self.up.url, patches, command,
                                               **{k: v for k, v in kwargs.items() if k == "when"}))
        return upt.run(series, **{k: v for k, v in kwargs.items() if k != "when"})

    def test_applies_retires_and_tests_on_the_latest_upstream(self) -> None:
        report = self.run_series([("add-lib", self.add_lib), ("answer-fix", self.same_as_upstream)], self.ok_test)
        self.assertEqual(report["upstream"]["commit"], self.up.head)
        self.assertEqual(report["applied"], ["add-lib"])
        self.assertEqual(report["already_upstream"], ["answer-fix"])
        self.assertEqual(report["failed"], [])
        self.assertEqual(report["tests"]["status"], "passed")
        self.assertEqual(report["status"], "pass")
        self.assertIs(report["deploys"], False)

    def test_tests_run_on_the_patched_tree(self) -> None:
        failing = [sys.executable, "-c", "import sys; sys.exit(7)"]
        report = self.run_series([("add-lib", self.add_lib)], failing)
        self.assertEqual(report["tests"]["status"], "failed")
        self.assertEqual(report["tests"]["exit_code"], 7)
        self.assertEqual(report["status"], "fail")
        # Without the patch the same test cannot pass: lib.py only exists once it is applied.
        unpatched = self.run_series([], self.ok_test, when="always")
        self.assertEqual(unpatched["tests"]["status"], "failed")

    def test_a_conflicting_patch_fails_and_stops_the_series(self) -> None:
        report = self.run_series([("conflict", self.conflicts), ("add-lib", self.add_lib)], self.ok_test)
        self.assertEqual(report["failed"], ["conflict"])
        self.assertEqual(report["not_attempted"], ["add-lib"])
        self.assertEqual(report["tests"]["status"], "skipped")
        self.assertEqual(report["status"], "fail")

    def test_zero_patches_is_a_pass_with_nothing_to_reapply(self) -> None:
        report = self.run_series([], self.ok_test)
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["tests"]["status"], "skipped")
        self.assertEqual(report["tests"]["reason"], "nothing to re-apply")
        self.assertIn("nothing to re-apply", upt.markdown(report))

    def test_exact_commit_overrides_the_branch(self) -> None:
        report = self.run_series([("answer-fix", self.same_as_upstream)], [], commit=self.up.base)
        self.assertEqual(report["upstream"]["commit"], self.up.base)
        self.assertEqual(report["applied"], ["answer-fix"])

    def test_test_command_never_sees_credentials(self) -> None:
        seen = self.base / "env.json"
        dump = [sys.executable, "-c", f"import json, os; open({str(seen)!r}, 'w').write(json.dumps(sorted(os.environ)))"]
        with mock.patch.dict(os.environ, {"FAKE_API_TOKEN": "t0k", "GITHUB_TOKEN": "g", "OPENAI_API_KEY": "k",
                                          "DB_PASSWORD": "p", "HARMLESS_SETTING": "1"}):
            self.run_series([("add-lib", self.add_lib)], dump)
        names = set(json.loads(seen.read_text()))
        self.assertIn("HARMLESS_SETTING", names)
        for name in ("FAKE_API_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY", "DB_PASSWORD"):
            self.assertNotIn(name, names)

    def test_the_upstream_repository_is_never_written(self) -> None:
        refs_before = _git(self.up.repo, "for-each-ref")
        self.run_series([("add-lib", self.add_lib)], self.ok_test)
        self.assertEqual(_git(self.up.repo, "for-each-ref"), refs_before)
        self.assertEqual(_git(self.up.repo, "status", "--porcelain"), "")

    def test_cli_exit_codes_report_and_summary(self) -> None:
        series = _write_series(self.series_dir, self.up.url, [("add-lib", self.add_lib)], self.ok_test)
        report_path, summary = self.base / "r.json", self.base / "summary.md"
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            rc = upt.main(["--series", str(series), "--report", str(report_path), "--summary", str(summary)])
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(report_path.read_text())["applied"], ["add-lib"])
        self.assertIn("never commits, pushes, pins an image", summary.read_text())
        bad = self.series_dir / "bad.json"
        bad.write_text(json.dumps({"schema": upt.SCHEMA, "upstream": {"repository": self.up.url},
                                   "patches": [{"id": "x", "file": "../../etc/passwd"}]}))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(upt.main(["--series", str(bad)]), 2)


class SeriesValidationTests(unittest.TestCase):
    def test_shipped_series_are_valid(self) -> None:
        starter = upt.load_series(STARTER_SERIES)
        self.assertEqual(starter["patches"], [])
        self.assertEqual(starter["repository"], "https://github.com/NousResearch/hermes-agent.git")
        synthetic = upt.load_series(SYNTHETIC_SERIES)
        self.assertEqual([p["id"] for p in synthetic["patches"]], ["add-patch-probe", "stack-on-patch-probe"])
        self.assertTrue(synthetic["tests"]["command"])

    def test_rejects_shell_strings_and_unsafe_upstreams(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "series.json"
            for doc in (
                {"schema": upt.SCHEMA, "upstream": {"repository": "git@github.com:x/y.git"}, "patches": []},
                {"schema": upt.SCHEMA, "upstream": {"repository": "https://example.invalid/x.git", "ref": "a..b"}, "patches": []},
                {"schema": upt.SCHEMA, "upstream": {"repository": "https://example.invalid/x.git"}, "patches": [],
                 "tests": {"command": "pytest -q && curl evil"}},
            ):
                path.write_text(json.dumps(doc))
                with self.subTest(doc=doc), self.assertRaises(upt.SeriesError):
                    upt.load_series(path)

    def test_script_has_no_publishing_git_operations(self) -> None:
        import ast

        tree = ast.parse(SCRIPT.read_text(encoding="utf-8"))
        verbs = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "git":
                strings = [a.value for a in node.args if isinstance(a, ast.Constant) and isinstance(a.value, str)]
                if strings:
                    verbs.add(strings[0])
            if isinstance(node, ast.Assign) and any(getattr(t, "id", "") == "fetch_args" for t in node.targets):
                verbs.add("fetch")
        self.assertIn("apply", verbs)
        self.assertLessEqual(verbs, {"ls-remote", "config", "init", "fetch", "checkout", "rev-parse", "apply"})
        text = SCRIPT.read_text(encoding="utf-8").lower()
        for word in ("docker", "compose.yaml", "switchroom-rollout", "git push"):
            self.assertNotIn(word, text)


class WorkflowCannotDeployTests(unittest.TestCase):
    FORBIDDEN = (
        r"secrets\.", r"\bwrite\b", r"packages:", r"id-token", r"attestations", r"git push", r"\bgh ",
        r"docker", r"compose", r"workflow_call", r"repository_dispatch", r"workflow_run", r"uses: \./",
        r"switchroom-rollout", r"actions/upload-artifact", r"pull_request_target",
    )

    def check(self, path: Path) -> None:
        text = path.read_text(encoding="utf-8")
        body = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
        for pattern in self.FORBIDDEN:
            with self.subTest(path=path.name, pattern=pattern):
                self.assertIsNone(re.search(pattern, body, re.I))
        self.assertIn("switchroom-upstream-patch-test.py", body)
        for line in body.splitlines():
            if "uses:" in line:
                self.assertRegex(line, r"uses: actions/checkout@[0-9a-f]{40}$")
        if yaml is None:
            return
        doc = yaml.safe_load(text)
        triggers = doc.get("on", doc.get(True))
        self.assertEqual(set(triggers), {"schedule", "workflow_dispatch"})
        self.assertEqual(doc["permissions"], {"contents": "read"})
        for job in doc["jobs"].values():
            self.assertEqual(job.get("permissions"), {"contents": "read"})
            for step in job["steps"]:
                if "uses" in step:
                    self.assertIs(step["with"]["persist-credentials"], False)

    def test_public_workflow_is_read_only(self) -> None:
        self.check(WORKFLOW)
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("examples/overlay-repo/patches/series.json", text)
        self.assertIn("tests/fixtures/upstream-patches/series.json", text)

    def test_overlay_template_is_read_only_and_pins_the_script(self) -> None:
        self.check(TEMPLATE)
        text = TEMPLATE.read_text(encoding="utf-8")
        self.assertIn("^[0-9a-f]{40}$", text)
        self.assertIn("patches/series.json", text)
        # Opt-in: the starter overlay does not ship an active workflow.
        self.assertFalse((ROOT / "examples" / "overlay-repo" / ".github").exists())


if __name__ == "__main__":
    unittest.main()
