#!/usr/bin/env python3
"""Emit a deterministic Agent-to-Fleet-to-House image handoff."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

REPOSITORY_RE = re.compile(r"^ghcr\.io/[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$")
REVISION_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
AGENT_KEYS = {"schema_version", "repository", "revision", "digest", "immutable_ref"}


def require(value: object, pattern: re.Pattern[str], label: str) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise SystemExit(f"invalid {label}")
    return value


def image_identity(repository: object, revision: object, digest: object) -> dict[str, str]:
    checked_repository = require(repository, REPOSITORY_RE, "repository")
    checked_revision = require(revision, REVISION_RE, "revision")
    checked_digest = require(digest, DIGEST_RE, "digest")
    return {
        "repository": checked_repository,
        "revision": checked_revision,
        "digest": checked_digest,
        "immutable_ref": f"{checked_repository}@{checked_digest}",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--digest", required=True)
    parser.add_argument("--agent-manifest", type=Path, required=True)
    # HF-851 content identity: the source tree (image label ai.switchroom.tree) and, for a promoted
    # PR image, the tree-identical commit its revision label names. `revision` stays the main commit.
    parser.add_argument("--tree", default="")
    parser.add_argument("--image-revision", default="")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    agent_data = json.loads(args.agent_manifest.read_text(encoding="utf-8"))
    if not isinstance(agent_data, dict) or set(agent_data) != AGENT_KEYS or agent_data.get("schema_version") != 1:
        raise SystemExit("invalid Agent handoff manifest")
    agent = image_identity(agent_data.get("repository"), agent_data.get("revision"), agent_data.get("digest"))
    if agent_data.get("immutable_ref") != agent["immutable_ref"]:
        raise SystemExit("Agent immutable_ref mismatch")
    fleet = image_identity(args.repository, args.revision, args.digest)
    fleet["source_repository"] = "https://github.com/switchroom/switchroom"
    if args.tree:
        fleet["tree"] = require(args.tree, REVISION_RE, "tree")
    if args.image_revision:
        if not args.tree:
            raise SystemExit("--image-revision needs --tree")
        fleet["image_revision"] = require(args.image_revision, REVISION_RE, "image revision")
    manifest = {
        "schema_version": 1,
        "agent": agent,
        "fleet": fleet,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
