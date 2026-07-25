"""A partial plugin rollout must fail LOUDLY, not silently (#3599 R4-Lc).

The deploy hazard this pins is not a bug in any one file. The plugin tree
ships as loose files under ``scripts/``, and #3599 REMOVED a symbol
(``lib.pending.delete_entry``) whose only importer was ``drain_pending``.
So a rollout that lands the new ``lib/pending.py`` beside an old
``drain_pending.py`` — an interrupted copy, a hand-patched file, a
``.bak`` restored over one half — makes ``session_start.py``'s

    from drain_pending import drain

raise ``ImportError``. That used to be caught by a bare ``except
Exception`` and written to ``debug_log``, which is OFF by default: the
whole pending-retains drain would stop, on every boot, and say nothing.
Turns queue up forever, and the only downstream signal is ``switchroom
doctor`` reporting a growing backlog — which names the queue, not the
cause.

These tests live under ``scripts/tests/`` because that is the ONLY python
test directory CI discovers (``ci-tests-python.yml:63-64`` runs
``python3 -m unittest discover tests/`` from ``vendor/hindsight-memory/
scripts``).
"""

import io
import os
import sys
import types
import unittest
import unittest.mock
from contextlib import redirect_stderr

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import session_start  # noqa: E402


class _Client:
    """Stand-in for HindsightClient — reachable, no network."""

    def __init__(self, *_a, **_kw):
        pass

    def health_check(self, timeout=5, retries=3):
        return True


class VersionSkewIsLoudTest(unittest.TestCase):
    """Every import-level skew in the tree reaches stderr."""

    CONFIG = {"autoRetain": True, "autoRecall": True}

    def _run_main(self, broken: str):
        """Run ``session_start.main()`` with ``broken`` importable but
        missing the name the hook imports from it — exactly the shape a
        half-rolled-out tree produces."""
        stub = types.ModuleType(broken)  # module exists, symbol does not
        with unittest.mock.patch.dict(sys.modules, {broken: stub}):
            with unittest.mock.patch.object(
                session_start, "load_config", lambda: dict(self.CONFIG)
            ):
                with unittest.mock.patch.object(
                    session_start,
                    "get_api_url",
                    lambda cfg, debug_fn=None, allow_daemon_start=True: (
                        "http://127.0.0.1:9/none"
                    ),
                ):
                    with unittest.mock.patch.object(
                        session_start, "HindsightClient", _Client
                    ):
                        with unittest.mock.patch.object(
                            sys, "stdin", io.StringIO("{}")
                        ):
                            with redirect_stderr(io.StringIO()) as err:
                                session_start.main()
        return err.getvalue()

    def test_a_half_rolled_out_tree_says_the_drain_is_disabled(self):
        out = self._run_main("drain_pending")
        self.assertIn(session_start.SKEW_MARKER, out)
        self.assertIn("drain_pending", out)
        self.assertIn(
            "Queued retains will NOT be replayed",
            out,
            "the operator must be told what the skew COSTS, not just that "
            "an import failed",
        )
        self.assertIn("Re-deploy the plugin tree WHOLE", out, "and how to fix it")

    def test_the_same_guard_covers_boot_reconciliation(self):
        """``reconcile_tail`` is the other half of the #3244 durability
        machinery and is imported the same way, so it fails the same way."""
        out = self._run_main("reconcile_tail")
        self.assertIn(session_start.SKEW_MARKER, out)
        self.assertIn("reconcile_tail", out)
        self.assertIn("Un-committed turns will NOT be recovered", out)

    def test_a_skew_does_not_take_session_start_down(self):
        """Loud, but never fatal: SessionStart still completes. A hook that
        crashes on a skew trades a silent drain outage for a broken boot."""
        self._run_main("drain_pending")  # no exception escapes _run_main

    def test_a_healthy_tree_prints_no_skew_warning(self):
        """The control case. Without it the assertions above are satisfied
        by a warning that fires unconditionally."""
        with unittest.mock.patch.object(
            session_start, "load_config", lambda: dict(self.CONFIG)
        ):
            with unittest.mock.patch.object(
                session_start,
                "get_api_url",
                lambda cfg, debug_fn=None, allow_daemon_start=True: (
                    "http://127.0.0.1:9/none"
                ),
            ):
                with unittest.mock.patch.object(
                    session_start, "HindsightClient", _Client
                ):
                    with unittest.mock.patch.object(sys, "stdin", io.StringIO("{}")):
                        with redirect_stderr(io.StringIO()) as err:
                            session_start.main()
        self.assertNotIn(session_start.SKEW_MARKER, err.getvalue())

    def test_a_runtime_error_is_still_swallowed_quietly(self):
        """Only SKEW is loud. A transient drain failure stays best-effort —
        making every upstream hiccup print would train operators to ignore
        the line that matters.
        """
        import drain_pending

        def boom(_config):
            raise RuntimeError("upstream on fire")

        with unittest.mock.patch.object(drain_pending, "drain", boom):
            with unittest.mock.patch.object(
                session_start, "load_config", lambda: dict(self.CONFIG)
            ):
                with unittest.mock.patch.object(
                    session_start,
                    "get_api_url",
                    lambda cfg, debug_fn=None, allow_daemon_start=True: (
                        "http://127.0.0.1:9/none"
                    ),
                ):
                    with unittest.mock.patch.object(
                        session_start, "HindsightClient", _Client
                    ):
                        with unittest.mock.patch.object(
                            sys, "stdin", io.StringIO("{}")
                        ):
                            with redirect_stderr(io.StringIO()) as err:
                                session_start.main()
        self.assertNotIn(session_start.SKEW_MARKER, err.getvalue())


class RemovedSymbolIsNotImportedTest(unittest.TestCase):
    """The skew guard is the safety net; this is the thing it nets.

    ``delete_entry`` is gone from ``lib.pending`` (#3599 R3-M1). If any
    module in this tree imports it again, every agent running a mixed tree
    loses its drain — so the absence is asserted from the importer side too,
    not only from the module side.
    """

    def test_no_script_in_the_tree_imports_delete_entry(self):
        # Parsed, not grepped: several docstrings discuss the removal by
        # name, and a substring match would fail on the prose that explains
        # why the symbol is gone.
        import ast

        offenders = []
        for root, _dirs, files in os.walk(SCRIPTS_DIR):
            if os.path.basename(root) in ("tests", "__pycache__"):
                continue
            for f in files:
                if not f.endswith(".py"):
                    continue
                p = os.path.join(root, f)
                with open(p, encoding="utf-8") as fh:
                    tree = ast.parse(fh.read(), filename=p)
                rel = os.path.relpath(p, SCRIPTS_DIR)
                for node in ast.walk(tree):
                    if isinstance(node, ast.ImportFrom) and any(
                        a.name == "delete_entry" for a in node.names
                    ):
                        offenders.append(rel)
                    elif (
                        isinstance(node, ast.Attribute)
                        and node.attr == "delete_entry"
                    ):
                        offenders.append(rel)
        self.assertEqual(
            offenders,
            [],
            "delete_entry was removed; re-introducing an import of it "
            "breaks every partially-rolled-out agent",
        )


if __name__ == "__main__":
    unittest.main()
