"""Behavioral contract for the dedicated, fail-closed Linear scenario lane."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "scripts/run-linear-scenarios.py"


class LinearScenarioLaneTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.source = self.root / "agent"
        self.source.mkdir()
        subprocess.run(["git", "init", "-q", str(self.source)], check=True)
        (self.source / "fixture.txt").write_text("Agent fixture\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(self.source), "add", "fixture.txt"], check=True)
        subprocess.run(
            ["git", "-C", str(self.source), "-c", "user.name=Fixture",
             "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], check=True,
        )
        self.revision = subprocess.check_output(
            ["git", "-C", str(self.source), "rev-parse", "HEAD"], text=True,
        ).strip()
        self.manifest = self.root / "manifest.json"
        self.write_manifest(self.revision)
        self.tests = self.root / "tests"
        self.tests.mkdir()

    def write_manifest(self, revision):
        digest = "sha256:" + "a" * 64
        self.manifest.write_text(json.dumps({
            "schema_version": 1,
            "repository": "ghcr.io/example/hermes-agent",
            "revision": revision,
            "digest": digest,
            "immutable_ref": "ghcr.io/example/hermes-agent@" + digest,
        }), encoding="utf-8")

    def run_lane(self, env=None):
        return subprocess.run(
            [sys.executable, str(RUNNER), "--manifest", str(self.manifest),
             "--agent-source", str(self.source), "--tests-dir", str(self.tests)],
            cwd=ROOT, capture_output=True, text=True, check=False, env=env,
        )

    def test_dirty_source_fails_before_tests(self):
        (self.tests / "test_linear_kanban_scenarios.py").write_text(
            "import unittest\nclass Scenario(unittest.TestCase):\n"
            "    def test_core(self): pass\n", encoding="utf-8",
        )
        for path in (self.source / "fixture.txt", self.source / "untracked.py"):
            with self.subTest(path=path.name):
                path.write_text("modified source\n", encoding="utf-8")
                try:
                    result = self.run_lane()
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("dirty", result.stderr)
                finally:
                    if path.name == "fixture.txt":
                        path.write_text("Agent fixture\n", encoding="utf-8")
                    else:
                        path.unlink()

    def test_lane_isolates_inherited_profile_and_credentials(self):
        live_home = self.root / "live-home"
        live_home.mkdir()
        (self.tests / "test_linear_kanban_scenarios.py").write_text(
            "import os, pathlib, unittest\n"
            "class Scenario(unittest.TestCase):\n"
            "    def test_core(self):\n"
            "        self.assertNotEqual(os.environ['HOME'], " + repr(str(live_home)) + ")\n"
            "        self.assertNotIn('HERMES_PROFILE', os.environ)\n"
            "        self.assertNotIn('OPENAI_API_KEY', os.environ)\n"
            "        self.assertTrue(pathlib.Path(os.environ['HERMES_HOME']).is_dir())\n"
            "        pathlib.Path(os.environ['HERMES_HOME'], 'scenario-write').write_text('isolated')\n",
            encoding="utf-8",
        )
        env = {**os.environ, "HOME": str(live_home), "HERMES_HOME": str(live_home),
               "HERMES_PROFILE": "synthetic-live", "OPENAI_API_KEY": "synthetic-not-secret"}
        result = self.run_lane(env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(live_home.iterdir()), [])

    def test_missing_source_fails(self):
        self.source.rename(self.root / "missing")
        result = self.run_lane()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Agent source", result.stderr)

    def test_wrong_revision_fails_before_tests(self):
        self.write_manifest("b" * 40)
        result = self.run_lane()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("revision", result.stderr)

    def test_empty_suite_fails(self):
        result = self.run_lane()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("zero tests", result.stderr)

    def test_skipped_core_import_fails(self):
        (self.tests / "test_linear_kanban_scenarios.py").write_text(
            "import unittest\n"
            "class Scenario(unittest.TestCase):\n"
            "    @unittest.skip('core import failed')\n"
            "    def test_core(self): pass\n", encoding="utf-8",
        )
        result = self.run_lane()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("skipped=1", result.stderr)

    def test_import_failure_fails(self):
        (self.tests / "test_linear_kanban_scenarios.py").write_text(
            "raise ImportError('broken core import')\n", encoding="utf-8",
        )
        result = self.run_lane()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("broken core import", result.stderr)

    def test_executed_suite_passes(self):
        (self.tests / "test_linear_kanban_scenarios.py").write_text(
            "import unittest\n"
            "class Scenario(unittest.TestCase):\n"
            "    def test_core(self): self.assertTrue(True)\n", encoding="utf-8",
        )
        result = self.run_lane()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Ran 1 test", result.stderr)

    def test_shards_are_disjoint_and_cover_every_test(self):
        body = "import unittest\nclass Scenario(unittest.TestCase):\n" + "".join(
            f"    def test_{i}(self): print('ran-{i}')\n" for i in range(7))
        (self.tests / "test_linear_a_scenarios.py").write_text(body, encoding="utf-8")
        (self.tests / "test_linear_b_scenarios.py").write_text(body, encoding="utf-8")
        ran = []
        for index in (1, 2, 3):
            result = subprocess.run(
                [sys.executable, str(RUNNER), "--manifest", str(self.manifest), "--agent-source",
                 str(self.source), "--tests-dir", str(self.tests), "--shard", f"{index}/3"],
                cwd=ROOT, capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(f"Shard {index}/3:", result.stderr)
            ran += [line for line in result.stderr.splitlines() if line.endswith("... ok")]
        self.assertEqual(len(ran), 14)
        self.assertEqual(len(set(ran)), 14)

    def test_invalid_shard_is_refused(self):
        for spec in ("0/3", "4/3", "1", "a/b"):
            with self.subTest(spec=spec):
                result = subprocess.run(
                    [sys.executable, str(RUNNER), "--manifest", str(self.manifest), "--agent-source",
                     str(self.source), "--tests-dir", str(self.tests), "--shard", spec],
                    cwd=ROOT, capture_output=True, text=True, check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("shard", result.stderr)

    def test_input_runner_shards_with_the_shared_slicer_and_refuses_invalid_specs(self):
        runner = ROOT / "scripts/run-linear-input-scenarios.py"
        self.assertIn('runner.select_shard(', runner.read_text(encoding="utf-8"))
        for spec in ("0/3", "4/3", "1", "a/b"):
            with self.subTest(spec=spec):
                result = subprocess.run(
                    [sys.executable, "-I", str(runner), "--agent-source", str(self.source), "--shard", spec],
                    cwd=ROOT, capture_output=True, text=True, check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("shard", result.stderr)

    def test_runtime_matrix_shards_input_and_lists_longest_legs_first(self):
        workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        runtime = workflow.split("  runtime:\n", 1)[1].split("\n  history-root:", 1)[0]
        legs = [line.strip() for line in runtime.splitlines() if line.strip().startswith("- {lane:")]
        self.assertEqual(legs[:3], ["- {lane: input, shard: 1/3}", "- {lane: input, shard: 2/3}",
                                    "- {lane: input, shard: 3/3}"])
        self.assertEqual(legs[-1], "- {lane: native, shard: ''}")
        self.assertIn("input) selected=\"$INPUT\" ;;", runtime)
        self.assertIn('run-linear-input-scenarios.py \\\n            --agent-source "$GITHUB_WORKSPACE/agent-source" --shard "$SHARD"', runtime)
        self.assertIn("if: matrix.lane == 'input' && needs.selection.outputs.input == 'true'", runtime)

    def test_ci_provisions_manifest_revision_and_runs_separately(self):
        workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        source_job = workflow.split("  runtime:\n", 1)[1].split("\n  history-root:", 1)[0]
        self.assertIn("scripts/read-agent-image-manifest.py", source_job)
        self.assertIn("ref: ${{ steps.agent.outputs.AGENT_REVISION }}", source_job)
        self.assertIn("scripts/run-linear-scenarios.py", source_job)
        self.assertIn("HERMES_AGENT_SRC", source_job)
        policy_job = workflow.split("  source-tests:\n", 1)[1].split("\n  runtime:", 1)[0]
        self.assertIn("scripts/verify-public-tree.py", policy_job)


class HistoricalCoreQualificationTests(unittest.TestCase):
    def run_skip(self, revision, *, reason=None, identity=None, capability=False):
        import contextlib
        import importlib.util
        import io
        from unittest.mock import patch
        import linear_core_capabilities as capabilities
        spec = importlib.util.spec_from_file_location("scenario_qualification_runner", RUNNER)
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        class Scenario(unittest.TestCase):
            def id(self):
                return identity or next(iter(capabilities.STATUS_METADATA_TESTS))
            def runTest(self):
                self.skipTest(reason or capabilities.STATUS_METADATA_REASON)
        with patch.object(capabilities, "status_metadata_available", return_value=capability), \
                patch.object(runner.unittest.defaultTestLoader, "discover", return_value=unittest.TestSuite([Scenario()])), \
                contextlib.redirect_stderr(io.StringIO()):
            return runner.run_suite(ROOT / "tests", revision=revision)

    def test_only_the_two_exact_historical_pins_qualify_named_absent_capability(self):
        from linear_core_capabilities import HISTORICAL_STATUS_CORES
        for revision in HISTORICAL_STATUS_CORES:
            with self.subTest(revision=revision):
                self.assertEqual(self.run_skip(revision), 0)

    def test_release_and_unknown_revisions_cannot_skip_feature_coverage(self):
        release = json.loads((ROOT / "release/agent-image-manifest.json").read_text())["revision"]
        for revision in (release, "f" * 40, None):
            with self.subTest(revision=revision):
                self.assertEqual(self.run_skip(revision), 1)

    def test_historical_pin_does_not_qualify_arbitrary_skips_or_present_capability(self):
        from linear_core_capabilities import HISTORICAL_STATUS_CORES
        revision = next(iter(HISTORICAL_STATUS_CORES))
        self.assertEqual(self.run_skip(revision, reason="unrelated unavailable feature"), 1)
        self.assertEqual(self.run_skip(revision, identity="other.Scenario.test_hidden"), 1)
        self.assertEqual(self.run_skip(revision, capability=True), 1)


if __name__ == "__main__":
    unittest.main()
