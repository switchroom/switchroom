#!/usr/bin/env python3
"""Run the real Agent-backed Linear scenarios, failing on absent or skipped proof."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from importlib import util


ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "scripts/read-agent-image-manifest.py"


def expected_revision(manifest: Path) -> str:
    spec = util.spec_from_file_location("agent_image_manifest", VALIDATOR)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load Agent manifest validator")
    module = util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.load_manifest(manifest)["revision"]


def parse_shard(spec: str | None) -> tuple[int, int] | None:
    """`K/N` selects the K-th of N disjoint, jointly exhaustive slices; None runs everything."""
    if not spec:
        return None
    index, _, total = spec.partition("/")
    if not (index.isdigit() and total.isdigit() and 1 <= int(index) <= int(total)):
        raise ValueError(f"invalid shard {spec!r}; expected K/N with 1 <= K <= N")
    return int(index), int(total)


def flatten(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from flatten(item)
        else:
            yield item


def select_shard(suite, shard: tuple[int, int] | None):
    """Round-robin individual tests in discovery order so slices stay balanced across modules.

    Every discovered test (including import-failure placeholders) lands in exactly one slice.
    """
    if shard is None:
        return suite
    index, total = shard
    tests = list(flatten(suite))
    picked = unittest.TestSuite(t for i, t in enumerate(tests) if i % total == index - 1)
    print(f"Shard {index}/{total}: {picked.countTestCases()} of {len(tests)} tests", file=sys.stderr, flush=True)
    return picked


def run(agent_source: Path, manifest: Path, tests_dir: Path, pattern: str = "test_linear_*scenarios.py",
        shard: tuple[int, int] | None = None) -> int:
    if not agent_source.is_dir():
        print(f"Agent source missing: {agent_source}", file=sys.stderr)
        return 1
    try:
        actual = subprocess.run(
            ["git", "-C", str(agent_source), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        expected = expected_revision(manifest)
        dirty = subprocess.run(
            ["git", "-C", str(agent_source), "status", "--porcelain", "--untracked-files=normal"],
            check=True, capture_output=True, text=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError, ValueError) as exc:
        print(f"Agent source revision unavailable: {exc}", file=sys.stderr)
        return 1
    if actual != expected:
        print(f"Agent source revision mismatch: expected {expected}, got {actual}", file=sys.stderr)
        return 1

    if dirty.strip():
        print("Agent source is dirty; use a clean manifest-pinned checkout", file=sys.stderr)
        return 1

    inherited = dict(os.environ)
    with tempfile.TemporaryDirectory(prefix="linear-scenario-run-") as home:
        isolated = {
            "PATH": os.defpath, "HOME": home, "HERMES_HOME": home,
            "XDG_CONFIG_HOME": home, "XDG_CACHE_HOME": home,
            "TMPDIR": home, "TZ": "UTC", "LANG": "C.UTF-8",
            "HERMES_AGENT_SRC": str(agent_source.resolve()),
        }
        try:
            os.environ.clear()
            os.environ.update(isolated)
            return run_suite(tests_dir, pattern, shard, revision=actual)
        finally:
            os.environ.clear()
            os.environ.update(inherited)


QUARANTINE = ROOT / "tests/ci-quarantine.json"
SUMMARY = os.environ.get("GITHUB_STEP_SUMMARY")  # Read before the run isolates the environment.
# JSON lines of retried quarantine ids; CI uploads it as an artifact so retries outlive the run's annotations.
RETRIES_LOG = os.environ.get("LINEAR_QUARANTINE_RETRIES")


def quarantined(path: Path = QUARANTINE) -> dict[str, str]:
    """Known-flaky test ids (unittest id) -> tracking note. Empty once every fix has landed."""
    if not path.is_file():
        return {}
    entries = json.loads(path.read_text(encoding="utf-8"))["tests"]
    return {entry["id"]: entry["tracking"] for entry in entries}


def retry_quarantined(result: unittest.TestResult, known: dict[str, str]) -> bool:
    """Re-run, once and visibly, failures that are all quarantined; True if all then pass.

    Any non-quarantined failure, error or unexpected success fails at once. The retries log
    records every ID in the retry batch. If all retries pass, each ID also gets a warning
    annotation and a job-summary line.
    """
    ids = [test.id() for test, _ in (*result.failures, *result.errors)]
    if not ids or result.unexpectedSuccesses or any(test_id not in known for test_id in ids):
        return False
    rerun = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromName(test_id) for test_id in ids)
    retried = unittest.TextTestRunner(verbosity=2).run(rerun)
    if RETRIES_LOG:
        retry_log = Path(RETRIES_LOG)
        retry_log.parent.mkdir(parents=True, exist_ok=True)
        with retry_log.open("a", encoding="utf-8") as stream:
            for test_id in ids:
                stream.write(json.dumps({"id": test_id, "tracking": known[test_id]}) + "\n")
    if not retried.wasSuccessful() or retried.skipped:
        return False
    for test_id in ids:
        print(f"::warning title=Quarantined flake retried::{test_id} failed once and passed on retry ({known[test_id]})",
              flush=True)
        if SUMMARY:
            with open(SUMMARY, "a", encoding="utf-8") as stream:
                stream.write(f"- quarantined flake retried: `{test_id}` ({known[test_id]})\n")
    return True


def run_suite(tests_dir: Path, pattern: str = "test_linear_*scenarios.py",
              shard: tuple[int, int] | None = None, *, revision: str | None = None,
              quarantine: Path = QUARANTINE) -> int:
    suite = select_shard(unittest.defaultTestLoader.discover(
        start_dir=str(tests_dir), pattern=pattern,
    ), shard)
    if suite.countTestCases() == 0:
        print("Linear scenario suite has zero tests", file=sys.stderr)
        return 1
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    passed = result.wasSuccessful() or retry_quarantined(result, quarantined(quarantine))
    if result.skipped:
        sys.path.insert(0, str(ROOT / "tests"))
        from linear_core_capabilities import unexpected_skips
        if unexpected_skips(result.skipped, revision):
            print(f"Linear scenario suite skipped={len(result.skipped)}; required lane failed", file=sys.stderr)
            return 1
        print(f"Historical Core {revision}: producer-metadata qualifications={len(result.skipped)}", file=sys.stderr)
    return 0 if passed else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent-source", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, default=ROOT / "release/agent-image-manifest.json")
    parser.add_argument("--tests-dir", type=Path, default=ROOT / "tests")
    parser.add_argument("--pattern", default="test_linear_*scenarios.py")
    parser.add_argument("--shard", help="K/N: run only the K-th of N round-robin test slices (CI parallelism)")
    args = parser.parse_args()
    try:
        shard = parse_shard(args.shard)
    except ValueError as exc:
        parser.error(str(exc))
    return run(args.agent_source, args.manifest, args.tests_dir, args.pattern, shard)


if __name__ == "__main__":
    raise SystemExit(main())
