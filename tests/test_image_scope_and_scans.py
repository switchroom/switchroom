"""Change scoping and in-job scan concurrency for the Fleet Image workflow."""
from __future__ import annotations

import importlib.util
import io
import json
import os
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/fleet-image.yml"
SCOPE = ROOT / "scripts/fleet-image-change-scope.py"
SCAN = ROOT / "scripts/scan-fleet-image.py"


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def git(cwd: Path, *args: str) -> str:
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
    return subprocess.check_output(["git", *args], cwd=cwd, text=True, env=env).strip()


def commit(cwd: Path, path: str, content: str, message: str) -> str:
    target = cwd / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    git(cwd, "add", "-A")
    git(cwd, "commit", "-q", "-m", message)
    return git(cwd, "rev-parse", "HEAD")


class ChangeScopeDecisionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scope = load(SCOPE, "fleet_image_change_scope")

    def test_docs_and_tests_only_changes_skip_the_bake(self):
        for paths in (["README.md"], ["docs/image-release.md", "tests/test_image_release.py"], [".github/workflows/ci.yml"],
                      ["plugins/model-providers/claude-acp/client.py",
                       "plugins/kokoro-voice/__init__.py", "plugins/readonly-source/__init__.py",
                       "plugins/web/perplexity/provider.py"],
                      ["scripts/verify-public-tree.py", "compose.example.yaml", "examples/operator-managed.yaml"], []):
            with self.subTest(paths=paths):
                run, reason, matched = self.scope.decide("push", "a" * 40, "b" * 40, lambda *_: list(paths))
                self.assertFalse(run, reason)
                self.assertEqual(matched, [])

    def test_image_inputs_run_the_bake_for_push_and_pull_request(self):
        for path in ("Dockerfile", "package-lock.json", "contracts/image.json",
                     "release/agent-image-manifest.json", "release/vex-exceptions.json", ".github/workflows/fleet-image.yml",
                     "scripts/verify-trivy-vex.py", "scripts/scan-fleet-image.py", "scripts/fleet-image-change-scope.py"):
            for event in ("push", "pull_request"):
                with self.subTest(path=path, event=event):
                    run, _, matched = self.scope.decide(event, "a" * 40, "b" * 40, lambda *_: ["README.md", path])
                    self.assertTrue(run)
                    self.assertEqual(matched, [path])

    def test_pin_only_pull_requests_skip_the_bake_but_pushes_still_bake(self):
        pin = ["release/agent-image-manifest.json", "plugins/disk-cleanup/UPSTREAM.json"]
        run, reason, _ = self.scope.decide("pull_request", "a" * 40, "b" * 40, lambda *_: list(pin))
        self.assertFalse(run)
        self.assertIn("pin-only", reason)
        run, _, _ = self.scope.decide("push", "a" * 40, "b" * 40, lambda *_: list(pin))
        self.assertTrue(run)
        for extra in ("Dockerfile", "plugins/disk-cleanup/__init__.py", "plugins/a/b/UPSTREAM.json"):
            with self.subTest(extra=extra):
                run, _, _ = self.scope.decide("pull_request", "a" * 40, "b" * 40, lambda *_: [*pin, extra])
                self.assertTrue(run, extra)
        run, _, _ = self.scope.decide("pull_request", "a" * 40, "b" * 40, lambda *_: list(pin),
                                      lambda path: path != pin[1])
        self.assertTrue(run, "a deleted pin file must not narrow the bake")

    def test_pull_request_diffs_against_the_merge_base_and_push_against_before(self):
        calls = []
        self.scope.decide("pull_request", "base", "head", lambda b, h, m: calls.append((b, h, m)) or [])
        self.scope.decide("push", "before", "sha", lambda b, h, m: calls.append((b, h, m)) or [])
        self.assertEqual(calls, [("base", "head", True), ("before", "sha", False)])

    def test_unknown_ranges_and_dispatches_fail_open(self):
        for event, base, head in (("push", "0" * 40, "b" * 40), ("pull_request", "", "b" * 40), ("push", "a" * 40, "b" * 40)):
            with self.subTest(event=event, base=base):
                run, reason, _ = self.scope.decide(event, base, head, lambda *_: None)
                self.assertTrue(run)
                self.assertIn("failing open", reason)
        run, reason, _ = self.scope.decide("workflow_dispatch", "", "", lambda *_: self.fail("dispatch must not diff"))
        self.assertTrue(run)
        self.assertIn("always bakes", reason)

    def test_git_range_resolution(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            git(repo, "init", "-q", "-b", "main")
            base = commit(repo, "docs/a.md", "a\n", "base")
            docs = commit(repo, "docs/a.md", "b\n", "docs")
            git(repo, "checkout", "-q", "-b", "feature", base)
            feature = commit(repo, "Dockerfile", "FROM scratch\n", "image")
            changed = self.scope.git_changed_paths
            self.assertEqual(changed(base, docs, cwd=repo, merge_base=False), ["docs/a.md"])
            # Three-dot: only the PR side, not main's docs change made after the branch point.
            self.assertEqual(changed(docs, feature, cwd=repo, merge_base=True), ["Dockerfile"])
            self.assertEqual(changed(base, base, cwd=repo, merge_base=False), [])
            self.assertIsNone(changed("0" * 40, feature, cwd=repo, merge_base=False))
            self.assertIsNone(changed("f" * 40, feature, cwd=repo, merge_base=False))
            self.assertIsNone(changed("", feature, cwd=repo, merge_base=False))
            for event, spec, expected in (("push", (base, docs), "false"), ("push", (base, feature), "true"), ("push", ("f" * 40, feature), "true")):
                output = repo / "out"
                output.unlink(missing_ok=True)
                result = subprocess.run(
                    [sys.executable, str(SCOPE), "--event", event, "--base", spec[0], "--head", spec[1],
                     "--repo-root", str(repo), "--github-output", str(output)],
                    text=True, capture_output=True, check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"image={expected}\n", output.read_text(encoding="utf-8"))
                self.assertIn("reason=", output.read_text(encoding="utf-8"))

    def test_input_set_covers_every_dockerfile_copy_and_workflow_reference(self):
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        copies = [line for line in dockerfile.splitlines() if line.startswith("COPY ") and "--from=" not in line]
        self.assertTrue(copies)
        for line in copies:
            sources = [token for token in line.split()[1:-1] if not token.startswith("--")]
            self.assertTrue(sources, line)
            for source in sources:
                with self.subTest(source=source):
                    self.assertTrue(self.scope.is_image_input(source.rstrip("/") + ("/x" if source.endswith("/") else "")), source)
        workflow = WORKFLOW.read_text(encoding="utf-8")
        referenced = set(re.findall(r"(?:scripts|release)/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*", workflow))
        self.assertGreater(len(referenced), 8)
        for path in referenced:
            with self.subTest(path=path):
                self.assertTrue(self.scope.is_image_input(path), path)
        for path in ("Dockerfile", "package.json", "package-lock.json", ".github/workflows/fleet-image.yml", ".dockerignore"):
            self.assertTrue(self.scope.is_image_input(path), path)
        for listed in sorted(self.scope.IMAGE_INPUT_FILES):
            if listed != ".dockerignore":
                self.assertTrue((ROOT / listed).is_file(), f"{listed} is listed as an image input but does not exist")
        for prefix in self.scope.IMAGE_INPUT_PREFIXES:
            self.assertTrue(prefix.endswith("/") and (ROOT / prefix).is_dir(), prefix)
        for path in ("README.md", "docs/image-release.md", "tests/test_image_release.py", ".github/workflows/ci.yml",
                     "scripts/verify-public-tree.py", "scripts/compose.py", "scripts/build-fleet-image.py",
                     "compose.example.yaml", "examples/overlay-repo/fleet-overlay.yaml", "SECURITY.md",
                     "plugins/linear/bridge.py"):
            self.assertFalse(self.scope.is_image_input(path), path)


class ScopedWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import yaml
        cls.text = WORKFLOW.read_text(encoding="utf-8")
        cls.jobs = yaml.safe_load(cls.text)["jobs"]

    def test_scope_job_is_cheap_read_only_and_first(self):
        self.assertEqual(list(self.jobs), ["scope", "preflight_bake", "preflight", "publish"])
        scope = self.jobs["scope"]
        self.assertEqual(scope["permissions"], {"contents": "read"})
        self.assertNotIn("environment", scope)
        self.assertEqual(scope["outputs"]["image"], "${{ steps.scope.outputs.image }}")
        checkout, decide = scope["steps"]
        self.assertEqual(checkout["with"], {"persist-credentials": False, "fetch-depth": 0})
        self.assertIn("scripts/fleet-image-change-scope.py", decide["run"])
        self.assertEqual(decide["env"]["BASE"], "${{ github.event.pull_request.base.sha || github.event.before }}")
        self.assertEqual(decide["env"]["HEAD"], "${{ github.event.pull_request.head.sha || github.sha }}")
        self.assertNotIn("docker", json.dumps(scope))

    def test_bake_and_publish_are_gated_by_scope_and_fail_open(self):
        for name in ("preflight_bake", "publish"):
            with self.subTest(job=name):
                job = self.jobs[name]
                self.assertEqual(job["needs"], "scope")
                condition = job["if"]
                self.assertTrue(condition.startswith("!cancelled() &&"), condition)
                self.assertIn("(needs.scope.outputs.image == 'true' || needs.scope.result == 'failure')", condition)
                self.assertIn("github.repository == 'switchroom/switchroom'", condition)
        self.assertIn("github.ref == 'refs/heads/main'", self.jobs["publish"]["if"])
        self.assertNotIn("paths:", self.text.split("jobs:", 1)[0])
        self.assertNotIn("paths-ignore:", self.text)

    def test_required_preflight_runs_after_scope_and_bake_on_prs(self):
        gate = self.jobs["preflight"]
        self.assertEqual(gate["needs"], ["scope", "preflight_bake"])
        self.assertEqual(gate["permissions"], {"contents": "read"})
        self.assertNotIn("environment", gate)
        self.assertIn("always()", gate["if"])
        self.assertIn("github.event_name == 'pull_request'", gate["if"])
        self.assertIn("github.event.inputs.publish != 'true'", gate["if"])
        self.assertNotIn("github.event_name == 'push'", gate["if"])
        self.assertEqual(len(gate["steps"]), 1)
        step = gate["steps"][0]
        self.assertEqual(step["env"], {
            "SCOPE_RESULT": "${{ needs.scope.result }}",
            "IMAGE": "${{ needs.scope.outputs.image }}",
            "BAKE_RESULT": "${{ needs.preflight_bake.result }}",
        })

    def test_required_preflight_result_truth_table(self):
        gate = self.jobs["preflight"]["steps"][0]
        cases = (
            ("success", "false", "skipped", True),
            ("success", "true", "success", True),
            ("failure", "true", "success", False),
            ("cancelled", "true", "success", False),
            ("skipped", "true", "success", False),
            ("success", "", "skipped", False),
            ("success", "unknown", "skipped", False),
            ("success", "TRUE", "success", False),
            ("success", "true", "failure", False),
            ("success", "true", "cancelled", False),
            ("success", "true", "skipped", False),
            ("success", "true", "", False),
            ("success", "false", "success", False),
            ("success", "false", "failure", False),
        )
        for scope_result, image, bake_result, expected in cases:
            with self.subTest(scope=scope_result, image=image, bake=bake_result):
                result = subprocess.run(
                    ["bash", "-e", "-o", "pipefail", "-c", gate["run"]],
                    env={**os.environ, "SCOPE_RESULT": scope_result, "IMAGE": image, "BAKE_RESULT": bake_result},
                    text=True, capture_output=True, check=False,
                )
                self.assertEqual(result.returncode == 0, expected, result.stdout + result.stderr)

    def test_workflow_conditions_preserve_trusted_event_boundaries(self):
        def applies(job, *, event, publish, scope_result, image, cancelled=False):
            condition = self.jobs[job]["if"]
            values = {
                "needs.scope.outputs.image": image,
                "needs.scope.result": scope_result,
                "github.event.inputs.publish": publish,
                "github.event_name": event,
                "github.repository": "switchroom/switchroom",
                "github.ref": "refs/heads/main",
            }
            condition = condition.replace("!cancelled()", str(not cancelled))
            condition = condition.replace("always()", "True")
            for reference in sorted(values, key=len, reverse=True):
                condition = condition.replace(reference, repr(values[reference]))
            condition = condition.replace("&&", " and ").replace("||", " or ")
            return bool(eval(condition, {"__builtins__": {}}, {}))

        cases = (
            ("pull_request", "", "success", "false", (False, True, False)),
            ("pull_request", "", "success", "true", (True, True, False)),
            ("pull_request", "", "failure", "", (True, True, False)),
            ("pull_request", "", "cancelled", "", (False, True, False)),
            ("pull_request", "", "skipped", "", (False, True, False)),
            ("pull_request", "", "success", "", (False, True, False)),
            ("push", "", "success", "false", (False, False, False)),
            ("push", "", "success", "true", (False, False, True)),
            ("workflow_dispatch", "false", "success", "true", (True, True, False)),
            ("workflow_dispatch", "true", "success", "true", (False, False, True)),
        )
        for event, publish, scope_result, image, expected in cases:
            with self.subTest(event=event, publish=publish, scope=scope_result, image=image):
                actual = tuple(applies(job, event=event, publish=publish, scope_result=scope_result, image=image)
                               for job in ("preflight_bake", "preflight", "publish"))
                self.assertEqual(actual, expected)


class ScanHelperTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scan = load(SCAN, "scan_fleet_image")

    def make_tools(self, directory: Path, *, syft_exit: int = 0, syft_sleep: float = 0.0) -> Path:
        bin_dir = directory / "bin"
        bin_dir.mkdir()
        syft = bin_dir / "syft"
        syft.write_text(
            "#!/bin/bash\n"
            f"sleep {syft_sleep}\n"
            "out=$(printf '%s\\n' \"$@\" | sed -n 's/^spdx-json=//p')\n"
            f"if [ {syft_exit} -ne 0 ]; then echo 'syft failed' >&2; exit {syft_exit}; fi\n"
            "printf '%s\\n' \"$@\" > \"$out.args\"\n"
            "echo '{\"spdxVersion\":\"SPDX-2.3\",\"SPDXID\":\"SPDXRef-DOCUMENT\"}' > \"$out\"\n",
            encoding="utf-8",
        )
        trivy = bin_dir / "trivy"
        trivy.write_text(
            "#!/bin/bash\n"
            "printf '%s\\n' \"$@\" > \"$TRIVY_ARGS\"\n"
            "if [ \"$1 $2\" = 'image --download-db-only' ]; then exit 0; fi\n"
            "out=$(printf '%s\\n' \"$@\" | awk '/^--output$/{getline; print}')\n"
            "echo '{\"SchemaVersion\":2,\"Results\":[]}' > \"$out\"\n",
            encoding="utf-8",
        )
        for tool in (syft, trivy):
            tool.chmod(tool.stat().st_mode | stat.S_IXUSR)
        return bin_dir

    def run_scan(self, *args: str, cwd: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, str(SCAN), *args], cwd=cwd, text=True, capture_output=True, check=False, env={**os.environ, **(env or {})})

    def test_detached_sbom_runs_alongside_trivy_and_is_collected_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            bin_dir = self.make_tools(work)
            archive = work / "candidate.tar"
            archive.write_bytes(b"tar")
            trivy_args = work / "trivy.args"
            start = self.run_scan("start-sbom", "--syft", str(bin_dir / "syft"), "--archive", str(archive),
                                  "--output", "sbom.json", "--state", "state", "--settle-seconds", "0", cwd=work)
            self.assertEqual(start.returncode, 0, start.stderr)
            self.assertTrue((work / "state/sbom.pid").is_file())
            scan = self.run_scan("trivy", "--trivy", str(bin_dir / "trivy"), "--archive", str(archive), "--output", "trivy.json",
                                 cwd=work, env={"TRIVY_ARGS": str(trivy_args)})
            self.assertEqual(scan.returncode, 0, scan.stderr)
            args = trivy_args.read_text(encoding="utf-8").split("\n")
            for flag in ("--input", "--skip-db-update", "--ignore-unfixed", "--severity", "CRITICAL", "--scanners", "vuln"):
                self.assertIn(flag, args)
            self.assertEqual(args[args.index("--exit-code") + 1], "0")
            wait = self.run_scan("wait-sbom", "--output", "sbom.json", "--state", "state", "--timeout-seconds", "20", "--poll-seconds", "0.1", cwd=work)
            self.assertEqual(wait.returncode, 0, wait.stderr)
            self.assertEqual(json.loads((work / "sbom.json").read_text(encoding="utf-8"))["spdxVersion"], "SPDX-2.3")
            self.assertIn(f"docker-archive:{archive}", (work / "sbom.json.args").read_text(encoding="utf-8"))
            self.assertFalse((work / "state").exists())
            again = self.run_scan("wait-sbom", "--output", "sbom.json", "--state", "state", cwd=work)
            self.assertNotEqual(again.returncode, 0)

    def test_sbom_failure_timeout_and_missing_inputs_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            bin_dir = self.make_tools(work, syft_exit=3)
            archive = work / "candidate.tar"
            archive.write_bytes(b"tar")
            start = self.run_scan("start-sbom", "--syft", str(bin_dir / "syft"), "--archive", str(archive),
                                  "--output", "sbom.json", "--state", "state", "--settle-seconds", "0", cwd=work)
            self.assertEqual(start.returncode, 0, start.stderr)
            wait = self.run_scan("wait-sbom", "--output", "sbom.json", "--state", "state", "--timeout-seconds", "20", "--poll-seconds", "0.1", cwd=work)
            self.assertNotEqual(wait.returncode, 0)
            self.assertIn("exited 3", wait.stderr)
            self.assertIn("syft failed", wait.stdout)
            self.assertFalse((work / "sbom.json").exists())
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            bin_dir = self.make_tools(work, syft_sleep=5)
            archive = work / "candidate.tar"
            archive.write_bytes(b"tar")
            start = self.run_scan("start-sbom", "--syft", str(bin_dir / "syft"), "--archive", str(archive),
                                  "--output", "sbom.json", "--state", "state", "--settle-seconds", "0", cwd=work)
            self.assertEqual(start.returncode, 0, start.stderr)
            wait = self.run_scan("wait-sbom", "--output", "sbom.json", "--state", "state", "--timeout-seconds", "0.5", "--poll-seconds", "0.1", cwd=work)
            self.assertNotEqual(wait.returncode, 0)
            self.assertIn("did not finish", wait.stderr)
            missing = self.run_scan("start-sbom", "--syft", str(bin_dir / "syft"), "--archive", str(work / "absent.tar"),
                                    "--output", "sbom.json", "--state", "other", cwd=work)
            self.assertNotEqual(missing.returncode, 0)
            no_trivy_input = self.run_scan("trivy", "--trivy", str(bin_dir / "trivy"), "--archive", str(work / "absent.tar"),
                                           "--output", "trivy.json", cwd=work, env={"TRIVY_ARGS": str(work / "t.args")})
            self.assertNotEqual(no_trivy_input.returncode, 0)

    def test_archive_config_binding(self):
        image_id = "sha256:" + "ab" * 32
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)

            def archive_with(config: str, members: list[str]) -> Path:
                path = work / f"{len(list(work.iterdir()))}.tar"
                with tarfile.open(path, "w") as tar:
                    manifest = json.dumps([{"Config": config, "Layers": []}]).encode()
                    info = tarfile.TarInfo("manifest.json")
                    info.size = len(manifest)
                    tar.addfile(info, io.BytesIO(manifest))
                    for member in members:
                        info = tarfile.TarInfo(member)
                        info.size = 2
                        tar.addfile(info, io.BytesIO(b"{}"))
                return path

            good = archive_with("ab" * 32 + ".json", ["ab" * 32 + ".json"])
            self.scan.verify_archive_config_id(good, image_id)
            oci = archive_with("blobs/sha256/" + "ab" * 32, ["blobs/sha256/" + "ab" * 32])
            self.scan.verify_archive_config_id(oci, image_id)
            for bad in (archive_with("cd" * 32 + ".json", ["cd" * 32 + ".json"]), archive_with("ab" * 32 + ".json", [])):
                with self.assertRaises(SystemExit):
                    self.scan.verify_archive_config_id(bad, image_id)
            with self.assertRaises(SystemExit):
                self.scan.verify_archive_config_id(work / "missing.tar", image_id)

    def test_workflow_runs_scanners_concurrently_and_waits_on_every_background_process(self):
        import yaml
        text = WORKFLOW.read_text(encoding="utf-8")
        jobs = yaml.safe_load(text)["jobs"]
        for name in ("preflight_bake", "publish"):
            with self.subTest(job=name):
                steps = jobs[name]["steps"]
                names = [step.get("name", "") for step in steps]
                runs = "\n".join(step.get("run", "") for step in steps)
                pull = next(step for step in steps if step["name"].startswith("Pull exact Agent parent"))
                started = re.findall(r"& (\w+)=\$!", pull["run"])
                self.assertGreaterEqual(len(started), 3)
                self.assertEqual(sorted(re.findall(r'wait "\$(\w+)"', pull["run"])), sorted(started))
                self.assertIn("scan-fleet-image.py prefetch-db", pull["run"])
                self.assertIn("docker pull \"$AGENT_IMAGE\"", pull["run"])
                self.assertIn("--require-hashes", pull["run"])
                self.assertLess(names.index("Install pinned Trivy"), names.index(pull["name"]))
                self.assertLess(names.index("Set up Python for SPDX schema validation"), names.index(pull["name"]))
                export = next(i for i, step in enumerate(steps) if step.get("id") == "export")
                self.assertIn("scan-fleet-image.py start-sbom", steps[export]["run"])
                self.assertEqual(steps[export]["env"]["SYFT"], "${{ steps.syft.outputs.cmd }}")
                trivy = names.index("Scan critical image vulnerabilities")
                collect = names.index("Collect SBOM and validate full and compact SPDX 2.3 documents")
                self.assertLess(export, trivy)
                self.assertLess(trivy, collect)
                self.assertIn("scan-fleet-image.py wait-sbom", steps[collect]["run"])
                self.assertEqual(runs.count("start-sbom"), 1)
                self.assertEqual(runs.count("wait-sbom"), 1)
                self.assertNotIn("anchore/sbom-action@", json.dumps(steps))
                uses = [step.get("uses", "") for step in steps]
                self.assertFalse(any(u.startswith("anchore/sbom-action/download-syft@") for u in uses))
                for tool in ("Trivy", "Syft"):
                    install = steps[names.index(f"Install pinned {tool}")]
                    self.assertNotIn("uses", install)
                    self.assertRegex(install["env"][f"{tool.upper()}_SHA256"], r"^[0-9a-f]{64}$")
                    self.assertRegex(install["env"][f"{tool.upper()}_ASSET_ID"], r"^[0-9]+$")
                    self.assertEqual(install["env"]["GH_TOKEN"], "${{ github.token }}")
                    self.assertIn("scripts/fetch-pinned-release-asset.sh", install["run"])
                    self.assertIn('sha256sum --check --strict', install["run"])
                syft = steps[names.index("Install pinned Syft")]
                self.assertEqual(syft["id"], "syft")
                self.assertIn('echo "cmd=$dir/syft" >> "$GITHUB_OUTPUT"', syft["run"])
                self.assertLess(names.index("Install pinned Trivy"), trivy)
        self.assertIn("SYFT_VERSION: v1.51.1", text)
        self.assertIn("TRIVY_VERSION: v0.70.0", text)


if __name__ == "__main__":
    unittest.main()
