"""PR stage reuse for the Fleet Image publish job (scripts/promote-fleet-image.py)."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/fleet-image.yml"
SCRIPT = ROOT / "scripts/promote-fleet-image.py"

spec = importlib.util.spec_from_file_location("promote_fleet_image", SCRIPT)
promote = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(promote)

REPO = "switchroom/switchroom"
IMAGE = "ghcr.io/switchroom/switchroom"
MAIN = "a" * 40
BEFORE = "b" * 40
HEAD = "c" * 40
TREE = "d" * 40
DIGEST = "sha256:" + "e" * 64
NOW = dt.datetime(2026, 11, 22, 12, tzinfo=dt.timezone.utc)
BUILD_ENV = {name: f"value-{name}" for name in promote.BUILD_ARG_ENV}


def fanal_archive(path: Path, members: dict[str, bytes] | None = None) -> str:
    members = members if members is not None else {"fanal/fanal.db": b"bolt"}
    with tarfile.open(path, "w:gz") as archive:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return hashlib.sha256(path.read_bytes()).hexdigest()


class LocateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        self.cache = self.work / "trivy-cache"
        self.pulls = [{"number": 7, "merge_commit_sha": MAIN, "merged_at": "2026-11-22T10:00:00Z",
                       "base": {"ref": "main"}, "head": {"sha": HEAD, "repo": {"full_name": REPO}}}]
        self.compare = "ahead"
        self.head_tree = TREE
        self.runs = [{"id": 99, "head_sha": HEAD, "event": "pull_request", "path": promote.WORKFLOW_PATH,
                      "head_repository": {"full_name": REPO}, "status": "completed", "conclusion": "success",
                      "created_at": "2026-11-22T09:00:00Z", "html_url": "https://example.invalid/run/99",
                      "run_attempt": 1}]
        self.staged_overrides: dict = {}
        self.fanal_members: dict[str, bytes] | None = None
        env = mock.patch.dict(os.environ, BUILD_ENV)
        env.start()
        self.addCleanup(env.stop)

    def api(self, path: str):
        if path == f"repos/{REPO}/commits/{MAIN}/pulls":
            return self.pulls
        if path == f"repos/{REPO}/compare/{BEFORE}...{HEAD}":
            return {"status": self.compare}
        if path == f"repos/{REPO}/git/commits/{HEAD}":
            return {"tree": {"sha": self.head_tree}}
        if path == f"repos/{REPO}/git/commits/{MAIN}":
            return {"parents": [{"sha": BEFORE}]}
        if path.startswith(f"repos/{REPO}/actions/workflows/{promote.WORKFLOW}/runs?"):
            self.assertIn(f"head_sha={HEAD}", path)
            self.assertIn("event=pull_request", path)
            return {"workflow_runs": self.runs}
        raise AssertionError(path)

    def download(self, repository: str, run_id: int, artifact: str, dest: Path) -> None:
        self.assertEqual((repository, run_id, artifact), (REPO, 99, f"fleet-image-staged-{HEAD}"))
        sha = fanal_archive(dest / promote.FANAL_ARCHIVE, self.fanal_members)
        staged = {"schema_version": 1, "repository": IMAGE, "head_sha": HEAD, "tree": TREE, "run_id": 99,
                  "run_attempt": 1,
                  "build_args": BUILD_ENV, "digest": DIGEST, "immutable_ref": f"{IMAGE}@{DIGEST}",
                  "fanal_sha256": sha, **self.staged_overrides}
        (dest / promote.STAGED_MANIFEST).write_text(json.dumps(staged), encoding="utf-8")

    def args(self, before: str = BEFORE) -> argparse.Namespace:
        return argparse.Namespace(repository=REPO, image_repository=IMAGE, sha=MAIN, before=before, tree=TREE,
                                  trivy_cache_dir=self.cache, workdir=str(self.work), repo_root=ROOT)

    def locate(self, before: str = BEFORE):
        return promote.locate(self.args(before), api=self.api, download=self.download, now=NOW)

    def test_verified_stage_is_reused_and_seeds_trivy_layer_cache(self) -> None:
        outputs = self.locate()
        self.assertEqual(outputs["found"], "true")
        self.assertEqual(outputs["ref"], f"{IMAGE}@{DIGEST}")
        self.assertEqual((self.cache / "fanal/fanal.db").read_bytes(), b"bolt")

    def test_dispatch_without_before_uses_first_parent(self) -> None:
        self.assertEqual(self.locate(before="")["found"], "true")
        self.assertEqual(self.locate(before="0" * 40)["found"], "true")

    def refuses(self, pattern: str) -> None:
        with self.assertRaisesRegex(promote.Refused, pattern):
            self.locate()
        self.assertFalse((self.cache / "fanal").exists())

    def test_refuses_without_exactly_one_merged_pr(self) -> None:
        self.pulls = []
        self.refuses("exactly one PR")

    def test_refuses_fork_pr(self) -> None:
        self.pulls[0]["head"]["repo"]["full_name"] = "someone/switchroom"
        self.refuses("fork")

    def test_refuses_when_pr_head_did_not_contain_previous_main(self) -> None:
        for status in ("behind", "diverged"):
            with self.subTest(status=status):
                self.compare = status
                self.refuses("not an ancestor")

    def test_refuses_tree_mismatch(self) -> None:
        self.head_tree = "f" * 40
        self.refuses("tree")

    def test_refuses_unsuccessful_or_stale_or_foreign_runs(self) -> None:
        cases = (
            ({"conclusion": "failure"}, "failure"),
            ({"status": "in_progress", "conclusion": None}, "in_progress"),
            ({"created_at": "2026-11-18T09:00:00Z"}, "older than"),
            ({"path": ".github/workflows/other.yml"}, "no Fleet Image"),
            ({"head_repository": {"full_name": "someone/switchroom"}}, "no Fleet Image"),
        )
        original = dict(self.runs[0])
        for change, pattern in cases:
            with self.subTest(change=change):
                self.runs = [{**original, **change}]
                self.refuses(pattern)

    def test_newest_run_decides(self) -> None:
        older = dict(self.runs[0])
        self.runs = [older, {**older, "id": 100, "created_at": "2026-11-22T09:30:00Z", "conclusion": "failure"}]
        self.refuses("failure")

    def test_refuses_mismatched_staged_record(self) -> None:
        cases = (
            {"tree": "f" * 40},
            {"head_sha": "f" * 40},
            {"run_id": 98},
            {"run_attempt": 2},
            {"repository": "ghcr.io/other/image"},
            {"build_args": {**BUILD_ENV, "CODEX_VERSION": "0.0.1"}},
            {"schema_version": 2},
            {"immutable_ref": f"{IMAGE}@sha256:{'0' * 64}"},
            {"digest": "latest"},
            {"fanal_sha256": "0" * 64},
        )
        for change in cases:
            with self.subTest(change=change):
                self.staged_overrides = change
                self.refuses(".")

    def test_refuses_unsafe_trivy_cache_archive(self) -> None:
        for members in ({"../evil": b"x"}, {"fanal/../../evil": b"x"}, {"other/fanal.db": b"x"}):
            with self.subTest(members=list(members)):
                self.fanal_members = members
                self.refuses("Trivy cache archive|unexpected path")

    def test_locate_command_fails_open_and_writes_outputs(self) -> None:
        output = self.work / "out"
        args = self.args()
        args.github_output = output
        with mock.patch.object(promote, "locate", side_effect=promote.Refused("no stage\nhere")):
            promote.locate_command(args)
        text = output.read_text(encoding="utf-8")
        self.assertIn("found=false\n", text)
        self.assertIn("reason=no stage here\n", text)


class PruneTests(unittest.TestCase):
    @staticmethod
    def version(vid: int, tags: list, updated: str) -> dict:
        return {"id": vid, "updated_at": updated, "metadata": {"container": {"tags": tags}}}

    def test_only_expired_stage_only_versions_are_deleted(self) -> None:
        old, new = "2026-11-10T00:00:00Z", "2026-11-20T00:00:00Z"
        versions = [
            self.version(1, ["fleet-pr-stage-44968668829-1"], old),
            self.version(2, ["fleet-pr-stage-1-1", "fleet-pr-stage-2-1"], old),
            self.version(3, ["fleet-pr-stage-3-1"], new),
            self.version(4, ["fleet-pr-stage-4-1", "sha-" + "a" * 40], old),
            self.version(5, [], old),
            self.version(6, ["sha256-" + "f" * 64], old),
            self.version(7, ["fleet-stage-123-1"], old),
            self.version(8, ["fleet-pr-stage-x-1"], old),
            self.version(9, ["latest"], old),
        ]
        deleted: list[str] = []
        args = argparse.Namespace(org="switchroom", package="switchroom", max_deletions=100, dry_run=False)
        count = promote.prune(args, api_lines=lambda _path: versions, delete=deleted.append, now=NOW)
        self.assertEqual(count, 2)
        base = "orgs/switchroom/packages/container/switchroom/versions"
        self.assertEqual(deleted, [f"{base}/1", f"{base}/2"])

    def test_one_failed_delete_logs_and_the_prune_continues(self) -> None:
        import contextlib, io
        versions = [self.version(i, [f"fleet-pr-stage-{i}-1"], "2026-11-01T00:00:00Z") for i in range(1, 4)]
        base = "orgs/switchroom/packages/container/switchroom/versions"
        deleted: list[str] = []
        def delete(path: str) -> None:
            if path.endswith("/2"):
                raise promote.Refused("gh api --method DELETE exited 1: HTTP 403")
            deleted.append(path)
        args = argparse.Namespace(org="switchroom", package="switchroom", max_deletions=100, dry_run=False)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(promote.prune(args, api_lines=lambda _path: versions, delete=delete, now=NOW), 2)
        self.assertEqual(deleted, [f"{base}/1", f"{base}/3"])
        self.assertIn("::warning title=Prune delete failed::version 2", out.getvalue())
        self.assertIn("pruned 2 stage-only version(s); 1 delete(s) failed", out.getvalue())

    def test_prune_fails_only_when_every_delete_fails(self) -> None:
        import contextlib, io
        versions = [self.version(i, [f"fleet-pr-stage-{i}-1"], "2026-11-01T00:00:00Z") for i in range(1, 3)]
        def delete(path: str) -> None:
            raise OSError("network down")
        args = argparse.Namespace(org="switchroom", package="switchroom", max_deletions=100, dry_run=False)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(promote.Refused):
            promote.prune(args, api_lines=lambda _path: versions, delete=delete, now=NOW)

    def test_prune_continues_without_deleting_versions_with_missing_or_malformed_ids(self) -> None:
        import contextlib, io
        old = "2026-11-01T00:00:00Z"
        missing = self.version(1, ["fleet-pr-stage-1-1"], old)
        del missing["id"]
        malformed = dict(self.version(2, ["fleet-pr-stage-2-1"], old), id=1.5)
        valid = self.version(3, ["fleet-pr-stage-3-1"], old)
        args = argparse.Namespace(org="switchroom", package="switchroom", max_deletions=1, dry_run=False)
        deleted = []
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(promote.prune(args, api_lines=lambda _: [missing, malformed, valid],
                                           delete=deleted.append, now=NOW), 1)
        self.assertEqual(deleted, ["orgs/switchroom/packages/container/switchroom/versions/3"])
        self.assertEqual(out.getvalue().count("expected a positive integer version ID"), 2)

    def test_malformed_version_metadata_and_timestamps_do_not_block_later_deletions(self) -> None:
        import contextlib, io
        old = "2026-11-01T00:00:00Z"
        missing = self.version(1, ["fleet-pr-stage-1-1"], old)
        del missing["updated_at"]
        versions = [
            missing,
            self.version(2, ["fleet-pr-stage-2-1"], "not a timestamp"),
            self.version(3, ["fleet-pr-stage-3-1"], "2026-11-01T00:00:00"),
            dict(self.version(4, ["fleet-pr-stage-4-1"], old), metadata="bad metadata"),
            dict(self.version(5, ["fleet-pr-stage-5-1"], old), metadata={"container": ["bad container"]}),
            self.version(6, ["fleet-pr-stage-6-1"], old),
        ]
        args = argparse.Namespace(org="switchroom", package="switchroom", max_deletions=1, dry_run=False)
        deleted = []
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(promote.prune(args, api_lines=lambda _: versions, delete=deleted.append, now=NOW), 1)
        self.assertEqual(deleted, ["orgs/switchroom/packages/container/switchroom/versions/6"])
        self.assertEqual(out.getvalue().count("has an invalid updated_at"), 3)

    def test_dry_run_and_cap(self) -> None:
        versions = [self.version(i, [f"fleet-pr-stage-{i}-1"], "2026-11-01T00:00:00Z") for i in range(1, 6)]
        deleted: list[str] = []
        args = argparse.Namespace(org="switchroom", package="switchroom", max_deletions=3, dry_run=True)
        self.assertEqual(promote.prune(args, api_lines=lambda _path: versions, delete=deleted.append, now=NOW), 3)
        self.assertEqual(deleted, [])

    def test_prune_workflow_is_scheduled_least_privilege_and_dispatch_defaults_to_dry_run(self) -> None:
        workflow = yaml.safe_load((ROOT / ".github/workflows/fleet-image-stage-prune.yml").read_text(encoding="utf-8"))
        triggers = workflow[True] if True in workflow else workflow["on"]
        self.assertIn("schedule", triggers)
        self.assertIs(triggers["workflow_dispatch"]["inputs"]["dry_run"]["default"], True)
        self.assertEqual(workflow["permissions"], {"contents": "read"})
        job = workflow["jobs"]["prune"]
        self.assertEqual(job["permissions"], {"contents": "read", "packages": "write"})
        self.assertIn("promote-fleet-image.py prune", job["steps"][-1]["run"])


class StartPushTests(unittest.TestCase):
    def test_tree_mismatch_skips_staging_and_record_refuses(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state"
            args = argparse.Namespace(state=state, head_sha=HEAD, repo_root=ROOT, head_tree="f" * 40,
                                      repository=REPO, docker="false-docker", image="img", staging_image="stage")
            promote.start_push(args)
            self.assertTrue((state / promote.SKIP_FILE).is_file())
            record = argparse.Namespace(state=state, timeout_seconds=1, poll_seconds=0.1)
            with self.assertRaises(SystemExit):
                promote.record(record)


class WorkflowWiringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.jobs = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))["jobs"]

    def steps(self, job: str) -> tuple[list[dict], list[str]]:
        steps = self.jobs[job]["steps"]
        return steps, [step.get("name", "") for step in steps]

    def test_pr_stage_is_best_effort_and_recorded_only_after_every_gate(self) -> None:
        steps, names = self.steps("preflight_bake")
        build = steps[names.index("Build Fleet child without publishing")]
        self.assertEqual(build["with"]["cache-to"], "type=inline")
        start = names.index("Start staging push of the PR candidate")
        record = names.index("Record staged candidate for main")
        upload = names.index("Upload staged candidate record")
        for index in (start, record, upload):
            self.assertIs(steps[index]["continue-on-error"], True)
        self.assertIn("github.event.pull_request.head.repo.full_name == github.repository", steps[start]["if"])
        self.assertIn("fleet-pr-stage-${{ github.run_id }}-${{ github.run_attempt }}", steps[start]["env"]["STAGING_IMAGE"])
        self.assertEqual(steps[record]["if"], "steps.stage_push.outcome == 'success'")
        self.assertEqual(steps[upload]["if"], "steps.stage.outcome == 'success'")
        self.assertEqual(steps[upload]["with"]["name"], "fleet-image-staged-${{ github.event.pull_request.head.sha }}")
        self.assertLess(names.index("Export built candidate and start SBOM generation"), start)
        for gate in ("Scan critical image vulnerabilities", "Enforce critical findings and scoped VEX policy",
                     "Collect SBOM and validate full and compact SPDX 2.3 documents",
                     "Verify inherited runtime and provenance",
                     "Headed Camoufox smoke (UID 1000, fleet seccomp, no-new-privileges)"):
            self.assertLess(names.index(gate), record, gate)
        self.assertLess(record, upload)
        self.assertNotIn("always()", json.dumps([steps[record], steps[upload]]))

    def test_main_reuses_stage_only_as_cache_and_keeps_every_gate(self) -> None:
        steps, names = self.steps("publish")
        locate = names.index("Locate tree-identical PR stage")
        pull = names.index("Pull exact Agent parent and prefetch scan tooling")
        cached = names.index("Build exact publish candidate reusing the PR stage as cache")
        full = names.index("Build and scan exact publish candidate")
        self.assertLess(names.index("Install pinned Trivy"), locate)
        self.assertLess(locate, pull)
        self.assertLess(pull, cached)
        self.assertLess(cached, full)
        self.assertIs(steps[locate]["continue-on-error"], True)
        self.assertIs(steps[cached]["continue-on-error"], True)
        self.assertEqual(steps[cached]["if"], "steps.stage.outputs.found == 'true'")
        self.assertEqual(steps[cached]["with"]["cache-from"], "type=registry,ref=${{ steps.stage.outputs.ref }}")
        self.assertFalse(steps[cached]["with"]["push"])
        self.assertEqual(steps[full]["if"],
                         "steps.stage.outputs.found != 'true' || steps.build_cached.outcome != 'success'")
        for key in ("context", "file", "platforms", "tags", "build-args", "secrets", "load"):
            self.assertEqual(steps[cached]["with"][key], steps[full]["with"][key], key)
        self.assertIn("FLEET_GIT_SHA=${{ github.sha }}", steps[cached]["with"]["build-args"])
        # The staged image is never retagged or promoted: main pushes and attests its own candidate.
        publish_text = json.dumps(steps)
        self.assertNotIn("steps.stage.outputs.ref", publish_text.replace(json.dumps(steps[cached]), "")
                         .replace(json.dumps(steps[pull]), ""))
        for gate in ("Verify exact scanned candidate runtime and provenance", "Scan critical image vulnerabilities",
                     "Revalidate scoped VEX decision before publication", "Verify exact main CI gate",
                     "Verify remote immutable manifest identity", "Attest published digest", "Attest published SBOM"):
            self.assertGreater(names.index(gate), full, gate)

    def test_trivy_cache_lives_outside_the_build_context(self) -> None:
        for job in ("preflight_bake", "publish"):
            steps, names = self.steps(job)
            install = steps[names.index("Install pinned Trivy")]["run"]
            self.assertIn('echo "TRIVY_CACHE_DIR=$RUNNER_TEMP/trivy-cache" >> "$GITHUB_ENV"', install)


if __name__ == "__main__":
    unittest.main()
