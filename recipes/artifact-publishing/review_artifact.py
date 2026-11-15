#!/usr/bin/env python3
"""Approve or withdraw an artifact for the origin proxy.

Run by the human reviewer, on the host, after reading the file. It records the
file's SHA-256 and size under a fresh UUID in the reviewed manifest, so the
origin serves exactly the bytes that were reviewed and refuses the file if it
changes afterwards. The agent never mounts the manifest, so it cannot approve
its own work.

  review_artifact.py approve --outbox artifacts/outbox/ops \
      --manifest artifacts/review/reviewed.json report.html
  review_artifact.py withdraw --manifest artifacts/review/reviewed.json <uuid>
  review_artifact.py list --manifest artifacts/review/reviewed.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import tempfile
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from origin_proxy import MANIFEST_SCHEMA, UUID, load_manifest, safe_relative  # noqa: E402


def read_manifest(path: Path) -> dict:
    if not path.exists():
        return {"schema_version": MANIFEST_SCHEMA, "artifacts": {}}
    load_manifest(str(path))  # refuse to extend a manifest the origin would reject
    return json.loads(path.read_text(encoding="utf-8"))


def write_manifest(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".reviewed.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    load_manifest(str(path))


def approve(outbox: Path, manifest: Path, name: str) -> str:
    relative = safe_relative(name)
    target = outbox / relative
    if target.is_symlink() or not target.is_file():
        raise SystemExit(f"refusing {relative}: not a regular file in the outbox")
    resolved = target.resolve()
    if outbox.resolve() not in resolved.parents:
        raise SystemExit(f"refusing {relative}: outside the outbox")
    data = target.read_bytes()
    data_manifest = read_manifest(manifest)
    key = str(uuid.uuid4())
    data_manifest["artifacts"][key] = {
        "path": relative,
        "sha256": hashlib.sha256(data).hexdigest(),
        "size": len(data),
    }
    write_manifest(manifest, data_manifest)
    return key


def withdraw(manifest: Path, key: str) -> bool:
    data = read_manifest(manifest)
    removed = data["artifacts"].pop(key, None) is not None
    if removed:
        write_manifest(manifest, data)
    return removed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Approve or withdraw a reviewed artifact.")
    sub = parser.add_subparsers(dest="command", required=True)
    a = sub.add_parser("approve")
    a.add_argument("--outbox", required=True, type=Path)
    a.add_argument("--manifest", required=True, type=Path)
    a.add_argument("path", help="file path relative to the outbox")
    w = sub.add_parser("withdraw")
    w.add_argument("--manifest", required=True, type=Path)
    w.add_argument("uuid")
    ls = sub.add_parser("list")
    ls.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args(argv)
    if args.command == "approve":
        key = approve(args.outbox, args.manifest, args.path)
        print(f"/artifact/{key}/")
    elif args.command == "withdraw":
        import re
        if not re.fullmatch(UUID, args.uuid):
            raise SystemExit("not a canonical lowercase UUID")
        print("withdrawn" if withdraw(args.manifest, args.uuid) else "not found")
    else:
        for key, entry in sorted(read_manifest(args.manifest)["artifacts"].items()):
            print(f"{key}  {entry['sha256'][:12]}  {entry['size']:>9}  {entry['path']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
