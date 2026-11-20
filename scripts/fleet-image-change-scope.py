#!/usr/bin/env python3
"""Decide whether a workflow event touched the Fleet image input set.

The Fleet Image workflow bakes, scans and (on main) publishes a container image.
A commit that only changes documentation, tests, or tooling the image never
consumes cannot change the published bytes, so the workflow skips the bake for
it. The image input set is the closed list below: everything the Dockerfile
COPYs, the Dockerfile itself, every script and policy file the workflow
invokes, and the workflow file. ``tests/test_image_release.py`` cross-checks the
list against the Dockerfile and workflow so it cannot drift silently.

The decision fails open: whenever the changed range cannot be determined (new
branch, unknown base commit, force push, git failure) or the event is a manual
dispatch, the answer is "run".
"""
from __future__ import annotations

import argparse
import subprocess
from collections.abc import Callable, Iterable
from pathlib import Path

NULL_SHA = "0" * 40

# Exact files that shape the image or the release transaction.
IMAGE_INPUT_FILES: frozenset[str] = frozenset(
    {
        ".dockerignore",
        ".github/workflows/fleet-image.yml",
        "Dockerfile",
        "package-lock.json",
        "package.json",
        "release/agent-image-manifest.json",
        "release/honcho-requirements.in",
        "release/honcho-requirements.txt",
        "release/honcho-sdk-requirements.txt",
        "scripts/patch-honcho-core-imports.py",
        "scripts/patch-honcho-gateway-turn-filter.py",
        "scripts/patch-honcho-kanban-observation.py",
        "scripts/patch-honcho-sdk-floor.py",
        "scripts/verify-honcho-plugin-core-seams.py",
        "scripts/verify-honcho-runtime.py",
        "release/spdx-2.3-schema.json",
        "release/spdx-validation-requirements.txt",
        "release/vex-exceptions.json",
        "scripts/claude-acp-subscription",
        "scripts/tooling-policy-hook",
        "scripts/compact-spdx-sbom.py",
        "scripts/emit-fleet-image-manifest.py",
        "scripts/extract-pushed-image-digest.py",
        "scripts/fetch-pinned-release-asset.sh",
        "scripts/fleet-image-change-scope.py",
        "scripts/image_ref.py",
        "scripts/read-agent-image-manifest.py",
        "scripts/scan-fleet-image.py",
        "scripts/validate-spdx-schema.py",
        "scripts/verify-agent-image-ref.py",
        "scripts/verify-exact-main-ci.py",
        "scripts/verify-inherited-runtime-config.py",
        "scripts/verify-trivy-vex.py",
    }
)

# Directories the Dockerfile copies wholesale.
IMAGE_INPUT_PREFIXES: tuple[str, ...] = (
    "contracts/",
)


def is_image_input(path: str) -> bool:
    return path in IMAGE_INPUT_FILES or any(path.startswith(prefix) for prefix in IMAGE_INPUT_PREFIXES)


def image_inputs(paths: Iterable[str]) -> list[str]:
    return sorted({path for path in paths if is_image_input(path)})


def git_changed_paths(base: str, head: str, *, cwd: Path, merge_base: bool) -> list[str] | None:
    """Changed paths between two commits, or ``None`` when git cannot say."""
    if not base or not head or base == NULL_SHA or head == NULL_SHA:
        return None
    for commit in (base, head):
        probe = subprocess.run(["git", "cat-file", "-e", f"{commit}^{{commit}}"], cwd=cwd, capture_output=True, check=False)
        if probe.returncode:
            return None
    spec = f"{base}...{head}" if merge_base else f"{base}..{head}"
    result = subprocess.run(
        ["git", "diff", "--name-only", "--no-renames", spec],
        cwd=cwd, text=True, capture_output=True, check=False,
    )
    if result.returncode:
        return None
    return [line for line in result.stdout.splitlines() if line]


def decide(
    event: str, base: str, head: str, changed: Callable[[str, str, bool], list[str] | None],
) -> tuple[bool, str, list[str]]:
    """Return (run_image_jobs, reason, matched_inputs); unknown ranges fail open."""
    if event == "pull_request":
        paths = changed(base, head, True)
    elif event == "push":
        paths = changed(base, head, False)
    else:
        return True, f"{event or 'unknown'} event always bakes the image", []
    if paths is None:
        return True, f"changed range {base[:12] or '?'}..{head[:12] or '?'} cannot be determined; failing open", []
    matched = image_inputs(paths)
    if matched:
        return True, f"{len(matched)} of {len(paths)} changed path(s) are Fleet image inputs", matched
    return False, f"none of the {len(paths)} changed path(s) are Fleet image inputs", []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--event", required=True, help="github.event_name")
    parser.add_argument("--base", default="", help="pull_request base sha or push event.before")
    parser.add_argument("--head", default="", help="pull_request head sha or push sha")
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--github-output", type=Path, default=None)
    args = parser.parse_args()

    def changed(base: str, head: str, merge_base: bool) -> list[str] | None:
        return git_changed_paths(base, head, cwd=args.repo_root, merge_base=merge_base)

    try:
        run, reason, matched = decide(args.event, args.base, args.head, changed)
    except Exception as exc:  # noqa: BLE001 - scoping must never block a bake
        run, reason, matched = True, f"scope script failed ({exc}); failing open", []
    print(f"fleet image scope: {'run' if run else 'skip'} ({reason})")
    for path in matched:
        print(f"  input: {path}")
    if args.github_output is not None:
        with args.github_output.open("a", encoding="utf-8") as handle:
            handle.write(f"image={'true' if run else 'false'}\n")
            handle.write(f"reason={reason}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
