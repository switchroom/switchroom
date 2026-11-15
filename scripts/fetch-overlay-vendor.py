#!/usr/bin/env python3
"""Fetch the starter overlay's pinned sources into its vendor/ directory.

Reads an overlay's vendor.lock.json and checks out each entry at exactly the
commit it pins. The Fleet repository entry pins ``image_revision``: pass the
revision of the image you run (its ``org.opencontainers.image.revision``
label) as --fleet-revision, so the skill pack and Fleet plugins match the
image.

An existing checkout is accepted only when it is already at the pinned commit
with no local changes; anything else is an error, never an overwrite. No
credentials are read or written. Exit 0 when every entry is in place, 1 when
an entry is wrong, 2 for unreadable input.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

COMMIT = re.compile(r"[0-9a-f]{40}")
IMAGE_REVISION = "image_revision"
ENTRY_KEYS = {"name", "path", "repository", "commit", "license", "provides"}
OPTIONAL_KEYS = {"upstream", "note"}


class VendorError(ValueError):
    """Invalid lock file or checkout."""


def load_lock(path: Path) -> list[dict]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise VendorError(f"{path}: unreadable lock file") from exc
    if not isinstance(document, dict) or document.get("schema_version") != 1 or not isinstance(document.get("entries"), list):
        raise VendorError(f"{path}: expected schema_version 1 and an entries list")
    seen: set[str] = set()
    for entry in document["entries"]:
        if not isinstance(entry, dict) or not ENTRY_KEYS <= set(entry) or not set(entry) <= ENTRY_KEYS | OPTIONAL_KEYS:
            raise VendorError(f"{path}: each entry needs {sorted(ENTRY_KEYS)}")
        relative = Path(entry["path"])
        if relative.is_absolute() or ".." in relative.parts or relative.parts[:1] != ("vendor",):
            raise VendorError(f"{path}: {entry['name']}: path must stay under vendor/")
        if not str(entry["repository"]).startswith("https://"):
            raise VendorError(f"{path}: {entry['name']}: repository must be an https URL")
        if entry["commit"] != IMAGE_REVISION and not COMMIT.fullmatch(str(entry["commit"])):
            raise VendorError(f"{path}: {entry['name']}: commit must be a full 40-character SHA")
        if not entry["license"]:
            raise VendorError(f"{path}: {entry['name']}: license is required")
        if entry["name"] in seen:
            raise VendorError(f"{path}: duplicate entry {entry['name']}")
        seen.add(entry["name"])
    return document["entries"]


def git(*args: str, cwd: Path | None = None) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, text=True, capture_output=True, check=False, timeout=600)
    if result.returncode != 0:
        raise VendorError(f"git {args[0]} failed: {result.stderr.strip()[:300]}")
    return result.stdout.strip()


def ensure(entry: dict, overlay: Path, commit: str) -> str:
    target = overlay / entry["path"]
    if target.exists():
        if not (target / ".git").exists():
            raise VendorError(f"{entry['name']}: {target} exists but is not a git checkout")
        head = git("rev-parse", "HEAD", cwd=target)
        if head != commit:
            raise VendorError(f"{entry['name']}: {target} is at {head}, not the pinned {commit}")
        if git("status", "--porcelain", cwd=target):
            raise VendorError(f"{entry['name']}: {target} has local changes")
        return f"{entry['name']}: already at {commit}"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.mkdir()
    try:
        git("init", "--quiet", cwd=target)
        git("remote", "add", "origin", entry["repository"], cwd=target)
        git("fetch", "--quiet", "--depth", "1", "origin", commit, cwd=target)
        git("checkout", "--quiet", "--detach", "FETCH_HEAD", cwd=target)
        head = git("rev-parse", "HEAD", cwd=target)
        if head != commit:
            raise VendorError(f"{entry['name']}: fetched {head}, expected {commit}")
    except BaseException:
        # Leave nothing half-fetched behind for the next run or a mount.
        shutil.rmtree(target, ignore_errors=True)
        raise
    return f"{entry['name']}: fetched {commit}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--overlay", type=Path, required=True, help="the overlay repository directory")
    parser.add_argument("--lock", type=Path, help="lock file (default: <overlay>/vendor.lock.json)")
    parser.add_argument("--fleet-revision", help="40-character revision of the Fleet image you run")
    parser.add_argument("--check", action="store_true", help="only verify existing checkouts; fetch nothing")
    args = parser.parse_args(argv)
    try:
        entries = load_lock(args.lock or args.overlay / "vendor.lock.json")
    except VendorError as exc:
        print(f"fetch-overlay-vendor: {exc}", file=sys.stderr)
        return 2
    failed = False
    for entry in entries:
        commit = entry["commit"]
        if commit == IMAGE_REVISION:
            commit = args.fleet_revision or ""
            if not COMMIT.fullmatch(commit):
                print(f"{entry['name']}: needs --fleet-revision, the image's 40-character revision", file=sys.stderr)
                failed = True
                continue
        try:
            if args.check and not (args.overlay / entry["path"]).exists():
                raise VendorError(f"{entry['name']}: not fetched")
            print(ensure(entry, args.overlay, commit))
        except (VendorError, OSError, subprocess.TimeoutExpired) as exc:
            print(f"{exc}", file=sys.stderr)
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
