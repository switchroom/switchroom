#!/usr/bin/env python3
"""Run the mounted origin proof with isolation and I/O denial installed before native imports."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent-source", type=Path, required=True)
    parser.add_argument("--expected-revision", help="Explicit immutable candidate Core revision; default is the release manifest pin")
    parser.add_argument("--shard", help="K/N: run only the K-th of N round-robin test slices (CI parallelism)")
    args = parser.parse_args()
    shard = None
    if args.shard:
        index, _, total = args.shard.partition("/")
        if not (index.isdigit() and total.isdigit() and 1 <= int(index) <= int(total)):
            parser.error("invalid --shard; expected K/N with 1 <= K <= N")
        shard = int(index), int(total)
    source = args.agent_source.resolve(strict=True)
    manifest = json.loads((ROOT / "release/agent-image-manifest.json").read_text())
    actual = subprocess.run(["git", "-C", str(source), "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(["git", "-C", str(source), "status", "--porcelain"], check=True, capture_output=True, text=True).stdout.strip()
    if actual != (args.expected_revision or manifest["revision"]) or dirty:
        parser.error("Use the clean native source at the exact expected revision")
    real_home = Path.home()
    with tempfile.TemporaryDirectory(prefix="linear-origin-proof-") as temporary:
        home = Path(temporary)
        os.environ.clear()
        os.environ.update(PATH=os.defpath, HOME=str(home), USERPROFILE=str(home), HERMES_HOME=str(home),
            XDG_CONFIG_HOME=str(home / "xdg-config"), XDG_CACHE_HOME=str(home / "xdg-cache"),
            CLAUDE_CONFIG_DIR=str(home / ".claude"), GH_CONFIG_DIR=str(home / ".config/gh"),
            TMPDIR=str(home), TZ="UTC", LANG="C.UTF-8", PYTHONDONTWRITEBYTECODE="1",
            HERMES_AGENT_SRC=str(source), HERMES_LINEAR_ORIGIN_TEST_ROOT=str(home))
        sys.dont_write_bytecode = True
        tempfile.tempdir = str(home)
        sys.path.insert(0, str(ROOT / "tests"))
        from linear_origin_guard import Guard
        guard = Guard(home, real_home)
        guard.install()
        class NoGatewayBootstrap:
            def find_spec(self, fullname, path=None, target=None):
                if fullname in {"gateway.run", "run_agent"}:
                    guard.deny("gateway/model bootstrap import: " + fullname)
                return None
        sys.meta_path.insert(0, NoGatewayBootstrap())
        # Core's Telegram dm_threads key derivation resolves a live runner through
        # `from gateway.run import _gateway_runner_ref` when a source has no adapter ref. The proof
        # runs no gateway, so that lookup's honest answer is "no runner" (Core's own import-time
        # default, `lambda: None`). Seed exactly that one name as a stub module instead of allowing
        # the real gateway.run, whose import is the model/gateway bootstrap this guard forbids.
        # sys.modules hits never reach the finder above, so every other gateway.run name still fails.
        import types
        gateway_run_stub = types.ModuleType("gateway.run")
        gateway_run_stub._gateway_runner_ref = lambda: None
        sys.modules["gateway.run"] = gateway_run_stub
        # Packaged Hermes carries build provenance; a source checkout would probe git while
        # importing provider declarations. Use the already verified immutable fixture identity.
        sys.path.insert(0, str(source))
        # Newer Core bootstraps start a detached scratch-prune child process once per process. The
        # proof's homes are fresh and their scratch empty, so mark this process already pruned; a
        # Core without the flag ignores the attribute.
        import hermes_constants
        hermes_constants._scratch_pruned_once = True
        from hermes_cli import version_info
        version_info._cached_version_info = version_info.VersionInfo("fixture", "fixture", 0, actual, None, "ci")
        suite = unittest.defaultTestLoader.discover(str(ROOT / "tests"), pattern="test_linear_origin*_native.py")
        if shard is not None:
            # Round-robin individual tests in discovery order: every test lands in exactly one slice.
            def flatten(items):
                for item in items:
                    if isinstance(item, unittest.TestSuite):
                        yield from flatten(item)
                    else:
                        yield item
            tests = list(flatten(suite))
            suite = unittest.TestSuite(t for i, t in enumerate(tests) if i % shard[1] == shard[0] - 1)
            print(f"Shard {shard[0]}/{shard[1]}: {suite.countTestCases()} of {len(tests)} tests", file=sys.stderr, flush=True)
            if not suite.countTestCases():
                print("Origin proof shard selected zero tests", file=sys.stderr)
                return 1
        result = unittest.TextTestRunner(verbosity=2, failfast=True).run(suite)
        # A caught guard refusal is still a failed proof: it must never become green by fallback.
        if guard.violations:
            print("Forbidden operations attempted: " + json.dumps(guard.violations), file=sys.stderr)
        return 0 if result.wasSuccessful() and not result.skipped and not guard.violations else 1


if __name__ == "__main__":
    raise SystemExit(main())
