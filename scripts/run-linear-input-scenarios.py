#!/usr/bin/env python3
"""Guarded native input seam proof; no gateway bootstrap, model or live account."""
from __future__ import annotations

import argparse
import json
import os
from importlib import util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def _scenario_runner():
    """Reuse run-linear-scenarios.py's K/N parser and round-robin slicer (one definition)."""
    spec = util.spec_from_file_location("linear_scenario_runner", ROOT / "scripts/run-linear-scenarios.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load the scenario runner")
    module = util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent-source", type=Path, required=True)
    parser.add_argument("--expected-revision", help="Explicit immutable candidate Core revision; default is the release manifest pin")
    parser.add_argument("--shard", help="K/N: run only the K-th of N round-robin test slices (CI parallelism)")
    args = parser.parse_args()
    runner = _scenario_runner()
    try:
        shard = runner.parse_shard(args.shard)
    except ValueError as exc:
        parser.error(str(exc))
    source = args.agent_source.resolve(strict=True)
    manifest = json.loads((ROOT / "release/agent-image-manifest.json").read_text())
    actual = subprocess.run(["git", "-C", str(source), "rev-parse", "HEAD"],
                            check=True, capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(["git", "-C", str(source), "status", "--porcelain"],
                           check=True, capture_output=True, text=True).stdout.strip()
    expected = args.expected_revision or manifest["revision"]
    if actual != expected or dirty:
        parser.error("Use the clean native source at the exact expected revision")
    real_home = Path.home()
    with tempfile.TemporaryDirectory(prefix="linear-native-input-proof-") as temporary:
        home = Path(temporary)
        os.environ.clear()
        os.environ.update(PATH=os.defpath, HOME=str(home), USERPROFILE=str(home), HERMES_HOME=str(home),
            XDG_CONFIG_HOME=str(home / "xdg-config"), XDG_CACHE_HOME=str(home / "xdg-cache"),
            CLAUDE_CONFIG_DIR=str(home / ".claude"), GH_CONFIG_DIR=str(home / ".config/gh"),
            TMPDIR=str(home), TZ="UTC", LANG="C.UTF-8", PYTHONDONTWRITEBYTECODE="1",
            HERMES_AGENT_SRC=str(source), HERMES_LINEAR_INPUT_TEST_ROOT=str(home))
        sys.dont_write_bytecode = True
        tempfile.tempdir = str(home)
        sys.path.insert(0, str(ROOT / "tests"))
        from linear_native_input_guard import Guard
        guard = Guard(home, real_home)
        guard.install()

        class NoGatewayBootstrap:
            def find_spec(self, fullname, path=None, target=None):
                if fullname in {"gateway.run", "run_agent"}:
                    guard.deny("gateway/model bootstrap import: " + fullname)
                return None

        sys.meta_path.insert(0, NoGatewayBootstrap())
        sys.path.insert(0, str(source))
        from hermes_cli import version_info
        version_info._cached_version_info = version_info.VersionInfo("fixture", "fixture", 0, actual, None, "ci")
        suite = runner.select_shard(unittest.defaultTestLoader.discover(
            str(ROOT / "tests"), pattern="test_linear_native_*seam.py"), shard)
        if not suite.countTestCases():
            print("Native input proof selected zero tests", file=sys.stderr)
            return 1
        result = unittest.TextTestRunner(verbosity=2, failfast=True).run(suite)
        if guard.violations:
            print("Forbidden operations attempted: " + json.dumps(guard.violations), file=sys.stderr)
        from linear_core_capabilities import unexpected_skips
        unexpected = unexpected_skips(result.skipped, actual)
        if result.skipped and not unexpected:
            print(f"Historical Core {actual}: producer-metadata qualifications={len(result.skipped)}", file=sys.stderr)
        return 0 if result.wasSuccessful() and not unexpected and not guard.violations else 1


if __name__ == "__main__":
    raise SystemExit(main())
