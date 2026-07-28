"""Two drains of one queue must never run at once — whoever the caller is.

Lives under ``scripts/tests/`` because that is the only python test directory
CI discovers (``ci-tests-python.yml`` runs ``python3 -m unittest discover
tests/`` with ``working-directory: vendor/hindsight-memory/scripts``).

WHY THIS IS LOAD-BEARING. Retain extraction on this fleet is served by 4
shared LLM lanes and a single entry measured 85-280s, so two drains walking
the same queue is not a tidiness problem: it is the same ~168s of a scarce
fleet-wide resource, spent twice, for one memory. The queue has three
independent drain paths and NONE of them is in a position to serialise the
others:

* ``session_start.py`` imports ``drain`` and calls it in-process at every
  session boot, with no lock of its own;
* the ``hindsight-drain`` sidecar (``profiles/_base/start.sh.hbs``) ticks on
  a timer inside the same container;
* ``switchroom doctor`` documents an out-of-band ``docker exec …
  drain_pending.py --backlog`` for operators clearing a backlog.

An agent booting a session while the sidecar is mid-backlog is the ordinary
case, not a corner. So the lock is taken inside ``drain()`` — the one
function all three go through — and these tests pin that it holds for the
in-process caller AND for a genuinely separate process running the CLI.

Every test here fails if ``_exclusive_drain`` is removed from ``drain()``:
the work happens twice instead of being skipped.
"""

import fcntl
import io
import os
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from contextlib import contextmanager, redirect_stderr

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import drain_pending  # noqa: E402
import lib.pending as pending  # noqa: E402

from tests.test_pending_drops import (  # noqa: E402
    CONFIG,
    _QueueTempDirMixin,
    _cd_doc,
    _payload,
)


@contextmanager
def _held_by_someone_else(path):
    """Hold the drain lock on a SEPARATE open file description.

    ``flock`` locks belong to the open file description, not to the process,
    so a second ``open()`` of the same file contends with this one exactly as
    another process would (flock(2): "these file descriptors are treated
    independently"). That keeps the test deterministic — no sleeps, no race
    with a child's startup — and the CLI case below covers a real process.
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


class DrainLockTest(_QueueTempDirMixin, unittest.TestCase):
    ENV_KEYS = _QueueTempDirMixin.ENV_KEYS + ("HINDSIGHT_DRAIN_LOCK",)

    def setUp(self):
        super().setUp()
        self.posted = []
        self.presence_checks = []

    def _seed(self, n=3):
        for i in range(n):
            pending.enqueue(_payload(content=f"c{i}", doc=_cd_doc(i)), RuntimeError("x"))

    def _record_post(self, entry, timeout):
        self.posted.append(entry["content"])

    def _record_presence(self, entry, timeout=30):
        self.presence_checks.append(entry["content"])
        return True

    def _drain(self, **kw):
        with unittest.mock.patch.object(
            drain_pending, "_retry_one", self._record_post
        ):
            with unittest.mock.patch.object(
                drain_pending, "_document_state", self._record_presence
            ):
                with redirect_stderr(io.StringIO()) as err:
                    summary = drain_pending.drain(CONFIG, **kw)
        return summary, err.getvalue()

    # ── the lock sits beside the queue it protects ────────────────────

    def test_the_lock_lives_next_to_the_queue_it_protects(self):
        """One lock per queue, so ``HINDSIGHT_PENDING_DIR`` moves both."""
        self.assertEqual(
            drain_pending._drain_lock_path(),
            os.path.join(self._tmp, "drain-pending.lock"),
        )

    def test_the_production_path_is_the_agent_hindsight_dir(self):
        """What the sidecar and the doctor recovery command actually share."""
        os.environ.pop("HINDSIGHT_PENDING_DIR")
        with unittest.mock.patch.dict(os.environ, {"HOME": "/state/agent/home"}):
            self.assertEqual(
                drain_pending._drain_lock_path(),
                "/state/agent/home/.hindsight/drain-pending.lock",
            )

    def test_it_is_not_the_path_the_interim_host_cron_wraps(self):
        """Deliberate: same path would make that wrapper starve this drain.

        The interim host stopgap runs ``docker exec … flock -n
        $HOME/.hindsight/drain.lock python3 drain_pending.py --backlog``. If
        this module locked THAT path, the wrapper would already hold it and
        the drain it just launched would skip every time — a silent no-op for
        as long as both exist.
        """
        self.assertNotIn("/drain.lock", drain_pending._drain_lock_path())

    # ── the in-process caller (SessionStart) ──────────────────────────

    def test_the_in_hook_drain_does_nothing_while_another_drain_holds_it(self):
        """``session_start.py`` calls this exact function, with no lock."""
        self._seed(3)

        with _held_by_someone_else(drain_pending._drain_lock_path()):
            summary, err = self._drain()

        self.assertEqual(self.posted, [], "no entry may be re-POSTed by a 2nd drain")
        self.assertEqual(
            self.presence_checks, [], "not even a free GET: the run did not happen"
        )
        self.assertTrue(summary["skipped_locked"])
        self.assertEqual(summary["drained"], 0)
        self.assertEqual(summary["reconciled"], 0)
        self.assertEqual(pending.count(), 3, "the queue is untouched")
        self.assertIn("another drain holds", err)

    def test_the_backlog_drain_does_nothing_while_another_drain_holds_it(self):
        """The sidecar's mode. Phase 1 is free, but it is not idempotent-free:
        two reconcilers race on the same archive move."""
        self._seed(3)

        with _held_by_someone_else(drain_pending._drain_lock_path()):
            summary, _ = self._drain(backlog=True)

        self.assertEqual(self.posted, [])
        self.assertEqual(self.presence_checks, [])
        self.assertTrue(summary["skipped_locked"])
        self.assertEqual(pending.count(), 3)

    def test_the_skip_is_the_lock_and_not_an_unconditional_refusal(self):
        """Guard rail: a drain that always skipped would pass the tests above
        and drain nothing in production, which is the bug the whole PR is
        about. Same queue, same call, lock free → the work happens."""
        self._seed(3)

        # `phase="drain"` so the free reconcile pass does not retire the
        # entries before phase 2 can post them — the assertion here is that
        # the EXPENSIVE work runs when the lock is free.
        summary, _ = self._drain(backlog=True, phase="drain")

        self.assertEqual(sorted(self.posted), ["c0", "c1", "c2"])
        self.assertFalse(summary["skipped_locked"])
        self.assertEqual(pending.count(), 0)

    def test_the_lock_is_released_when_the_run_finishes(self):
        """Not a one-shot: the next tick, 900s later, must still get in."""
        self._seed(1)
        self._drain(backlog=True)

        # If the previous run leaked its fd, this acquisition raises.
        with _held_by_someone_else(drain_pending._drain_lock_path()):
            pass

    def test_an_unopenable_lock_still_drains(self):
        """A read-only ``.hindsight/`` must not silently disable memory replay.

        Losing serialisation costs duplicated LLM work; losing the drain costs
        the memory itself. The cheaper failure wins, loudly.
        """
        self._seed(1)
        os.environ["HINDSIGHT_DRAIN_LOCK"] = os.path.join(
            self._tmp, "no-such-dir", "x", "drain-pending.lock"
        )
        with unittest.mock.patch.object(
            drain_pending.os, "makedirs", side_effect=PermissionError("read-only")
        ):
            summary, err = self._drain(backlog=True)

        self.assertEqual(self.posted, ["c0"], "the drain must still run")
        self.assertFalse(summary["skipped_locked"])
        self.assertIn("WITHOUT serialisation", err)

    # ── a genuinely separate process (the doctor recovery command) ────

    def test_the_cli_a_separate_process_runs_also_skips(self):
        """``switchroom doctor`` tells operators to run this by hand, with no
        ``flock``. Before the lock moved into this module, doing that while
        the sidecar ticked meant two processes on one queue."""
        self._seed(2)
        env = dict(os.environ)
        env["HINDSIGHT_PENDING_DIR"] = self._dir
        env["HOME"] = self._tmp

        with _held_by_someone_else(drain_pending._drain_lock_path()):
            proc = subprocess.run(
                [
                    sys.executable,
                    os.path.join(SCRIPTS_DIR, "drain_pending.py"),
                    "--backlog",
                ],
                capture_output=True,
                text=True,
                timeout=60,
                env=env,
            )

        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("another drain holds", proc.stderr)
        self.assertEqual(
            pending.count(), 2, "a second process must not touch the queue"
        )
        # And nothing was posted: the entries point at 127.0.0.1:9, so a run
        # that had NOT skipped would have recorded attempts against them.
        for _path, entry in pending.iter_entries():
            self.assertEqual(int(entry.get("attempt_count", 0)), 1)


class SessionStartUsesTheLockedEntryPointTest(unittest.TestCase):
    """The hook must not acquire a private, unlocked path into the queue.

    ``session_start.py`` does ``from drain_pending import drain as
    drain_pending_retains``. If it ever imported an impl helper instead (or a
    future refactor moved the work out from under the lock) the serialisation
    guarantee would silently regress for the one caller that runs on every
    single session boot.
    """

    def test_session_start_imports_the_locked_public_drain(self):
        with open(
            os.path.join(SCRIPTS_DIR, "session_start.py"), encoding="utf-8"
        ) as f:
            src = f.read()
        self.assertIn("from drain_pending import drain as drain_pending_retains", src)
        self.assertNotIn("_drain_inhook_impl", src)
        self.assertNotIn("_drain_backlog_impl", src)

    def test_the_public_drain_is_what_takes_the_lock(self):
        """Executable half of the check above: calling ``drain`` — the symbol
        session_start binds — is what consults the lock."""
        seen = []
        real = drain_pending._exclusive_drain

        def spy():
            seen.append(True)
            return real()

        # A throwaway queue dir, so neither the empty queue nor the lock file
        # this creates lands in the repo checkout.
        with tempfile.TemporaryDirectory() as tmp:
            env = {"HINDSIGHT_PENDING_DIR": os.path.join(tmp, "pending-retains")}
            with unittest.mock.patch.dict(os.environ, env):
                with unittest.mock.patch.object(
                    drain_pending, "_exclusive_drain", spy
                ):
                    with redirect_stderr(io.StringIO()):
                        drain_pending.drain(CONFIG)
        self.assertEqual(seen, [True], "drain() must consult the lock every call")


if __name__ == "__main__":
    unittest.main()
