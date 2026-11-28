"""XDG_RUNTIME_DIR ownership in the Fleet image (HF-856).

The agent image bakes /tmp/hermes-runtime root:root 0700 and chowns it in a root start hook. This image
starts as UID 1000, so the hook cannot chown and the Bot Desktop fails on its allocation lock. These are
source checks plus the verifier's own logic; scripts/verify-runtime-dir.py runs in the candidate image
in both Fleet Image bake jobs.
"""
from __future__ import annotations

import contextlib
import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = (ROOT / "Dockerfile").read_text(encoding="utf-8")
WORKFLOW = (ROOT / ".github" / "workflows" / "fleet-image.yml").read_text(encoding="utf-8")
VERIFIER = ROOT / "scripts" / "verify-runtime-dir.py"


def load_verifier():
    spec = importlib.util.spec_from_file_location("verify_runtime_dir", VERIFIER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DockerfileTests(unittest.TestCase):
    def test_runtime_dir_is_baked_for_the_runtime_uid_after_the_last_root_step(self):
        final_user = DOCKERFILE.rindex("\nUSER 1000:1000")
        self.assertEqual(DOCKERFILE.count("\nUSER "), DOCKERFILE.count("\nUSER root") + 1)
        install = DOCKERFILE.index("install -d -o 1000 -g 1000 -m 0700 /tmp/hermes-runtime")
        # No RUN after the fix and before the switch to UID 1000 can re-create it as root.
        self.assertNotIn("\nRUN ", DOCKERFILE[install:final_user])
        self.assertGreater(install, DOCKERFILE.rindex("\nUSER root"))
        block = DOCKERFILE[DOCKERFILE.rindex("\nRUN ", 0, install):final_user]
        for token in (
            'test "${XDG_RUNTIME_DIR:-}" = /tmp/hermes-runtime',
            "rm -rf /tmp/hermes-runtime/dbus-1",
            "test \"$(stat -c '%u:%g:%a' /tmp/hermes-runtime)\" = 1000:1000:700",
        ):
            with self.subTest(token=token):
                self.assertIn(token, block)
        # Symlink refused both before the install and after the cleanup.
        self.assertEqual(block.count("test ! -L /tmp/hermes-runtime"), 2)
        self.assertLess(block.index("test ! -L /tmp/hermes-runtime"), block.index("install -d"))
        self.assertGreater(block.rindex("test ! -L /tmp/hermes-runtime"), block.index("rm -rf /tmp/hermes-runtime/dbus-1"))

    def test_verifier_is_baked_and_run_by_both_bake_jobs(self):
        self.assertIn("COPY --chmod=0755 scripts/verify-runtime-dir.py /opt/hermes-fleet/bin/verify-runtime-dir.py",
                      DOCKERFILE)
        # Default image user (no --user override): the check is about what the gateway runs as.
        self.assertEqual(WORKFLOW.count(
            'docker run --rm --network none --entrypoint python3 "$TEST_IMAGE" '
            '/opt/hermes-fleet/bin/verify-runtime-dir.py\n'), 2)


class CheckDirTests(unittest.TestCase):
    def setUp(self):
        self.verifier = load_verifier()
        self.tmp = Path(tempfile.mkdtemp(prefix="runtime-dir-test-"))
        self.uid, self.gid = os.getuid(), os.getgid()
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        for path in sorted(self.tmp.rglob("*"), reverse=True):
            if path.is_symlink() or path.is_file():
                path.unlink()
            else:
                path.chmod(0o700)
                path.rmdir()
        self.tmp.rmdir()

    def make(self, mode=0o700):
        path = self.tmp / "hermes-runtime"
        path.mkdir()
        path.chmod(mode)
        return path

    def test_private_owned_directory_passes(self):
        self.assertEqual(self.verifier.check_dir(self.make(), self.uid, self.gid), [])

    def test_wrong_owner_is_named(self):
        problems = self.verifier.check_dir(self.make(), self.uid + 1, self.gid)
        self.assertEqual(len(problems), 1)
        self.assertIn(f"expected {self.uid + 1}:{self.gid}", problems[0])

    def test_open_mode_is_named(self):
        problems = self.verifier.check_dir(self.make(0o755), self.uid, self.gid)
        self.assertEqual(problems, [f"{self.tmp / 'hermes-runtime'} has mode 755, expected 700"])

    def test_symlink_is_refused(self):
        target = self.make()
        link = self.tmp / "link"
        link.symlink_to(target)
        self.assertEqual(self.verifier.check_dir(link, self.uid, self.gid), [f"{link} is a symlink"])

    def test_missing_and_non_directory_are_refused(self):
        self.assertEqual(self.verifier.check_dir(self.tmp / "absent", self.uid, self.gid),
                         [f"{self.tmp / 'absent'} does not exist"])
        file = self.tmp / "file"
        file.write_text("x")
        self.assertEqual(self.verifier.check_dir(file, self.uid, self.gid), [f"{file} is not a directory"])

    def test_stale_dbus_state_is_named(self):
        path = self.make()
        (path / "dbus-1").mkdir()
        problems = self.verifier.check_dir(path, self.uid, self.gid)
        self.assertEqual(problems, [f"{path}/dbus-1 is left over from the build"])


class AllocLockTests(unittest.TestCase):
    """check_alloc_lock against a stand-in Bot Desktop runtime that takes its lock like the real one."""

    def setUp(self):
        self.verifier = load_verifier()
        self.dir = Path(tempfile.mkdtemp(prefix="runtime-dir-lock-"))
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        for path in self.dir.iterdir():
            path.unlink()
        self.dir.rmdir()

    def fake_modules(self, *, lock_dir=None, start=None):
        runtime = types.ModuleType("tools.bot_desktop.runtime")
        resources = types.ModuleType("tools.bot_desktop.resources")
        runtime._ALLOC_LOCK = (lock_dir or self.dir) / "hermes-bot-desktop-alloc.lock"
        resources.memory_blocker = lambda *a, **k: "Not enough free memory"

        @contextlib.contextmanager
        def flocked(path):
            with open(path, "a+", encoding="utf-8") as fh:
                yield fh

        def real_like_start(*, wait_seconds):
            if resources.memory_blocker() is not None:
                raise RuntimeError(resources.memory_blocker())
            with flocked(runtime._ALLOC_LOCK):
                runtime._pick_display()
            raise AssertionError("unreachable in the verifier")

        runtime.start = start or real_like_start
        package = types.ModuleType("tools.bot_desktop")
        package.runtime, package.resources = runtime, resources
        tools = types.ModuleType("tools")
        tools.bot_desktop = package
        return {"tools": tools, "tools.bot_desktop": package,
                "tools.bot_desktop.runtime": runtime, "tools.bot_desktop.resources": resources}

    def run_check(self, modules):
        with mock.patch.dict(sys.modules, modules):
            self.verifier.check_alloc_lock(self.dir)

    def test_lock_taken_in_runtime_dir_passes(self):
        self.run_check(self.fake_modules())
        self.assertTrue((self.dir / "hermes-bot-desktop-alloc.lock").is_file())

    def test_permission_error_on_the_lock_fails(self):
        def denied(*, wait_seconds):
            raise PermissionError(13, "Permission denied", str(self.dir / "hermes-bot-desktop-alloc.lock"))
        with self.assertRaises(SystemExit), mock.patch("sys.stderr"):
            self.run_check(self.fake_modules(start=denied))

    def test_lock_outside_runtime_dir_fails(self):
        with self.assertRaises(SystemExit), mock.patch("sys.stderr"):
            self.run_check(self.fake_modules(lock_dir=Path(tempfile.gettempdir())))

    def test_start_that_never_reaches_the_lock_fails(self):
        def quiet(*, wait_seconds):
            return None
        with self.assertRaises(SystemExit), mock.patch("sys.stderr"):
            self.run_check(self.fake_modules(start=quiet))


if __name__ == "__main__":
    unittest.main()
