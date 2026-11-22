#!/usr/bin/env python3
"""Reuse a scanned pull-request Fleet bake when main publishes the same tree.

``main`` requires PRs to be up to date, so the tree a merged PR's
``preflight_bake`` built and scanned is the tree the main ``publish`` job builds
again. The image cannot simply be retagged: the last layers stamp the exact Fleet
commit (``FLEET_GIT_SHA``: OCI revision label, environment, provenance marker),
and a PR bake only knows its test-merge commit. Instead the PR leaves behind
what main needs to rebuild cheaply:

* ``start-push`` (PR, same repository only) refuses unless the checked-out merge
  commit's tree equals the PR head's tree, then tags the scanned candidate (built
  with inline BuildKit cache metadata) with a run/attempt-unique
  ``fleet-pr-stage-*`` ref and pushes it detached, so the push overlaps the scans.
* ``record`` (PR) waits for that push, requires the remote manifest's config to
  equal the scanned archive's config ID, and writes ``staged.json`` plus Trivy's
  layer-analysis cache (``fanal``) into one directory for upload as the
  ``fleet-image-staged-<head sha>`` artifact. The upload step runs only after every
  preflight gate has passed.
* ``locate`` (main publish) finds the merged PR's newest successful same-repository
  Fleet Image run, requires that main's previous commit is an ancestor of the PR
  head (so the PR run's merge commit had exactly the PR head tree), that the PR
  head tree equals the checked-out main tree, and that the recorded tree and build
  inputs match. It then seeds Trivy's layer cache and reports the staged digest
  for ``cache-from``.

Main still builds, runtime-checks, exports, Trivy/VEX-scans, SBOMs, pushes and
attests its own candidate; the staged image is only build cache, and the seeded
Trivy cache only skips re-analysing layers whose content digests (diff IDs) are
unchanged. ``locate`` never fails the job: any doubt prints why and reports
``found=false``, and main rebuilds from scratch.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, NoReturn

SCHEMA_VERSION = 1
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
PUSH_DIGEST_RE = re.compile(r"(?m)^[^\r\n]*:\s+digest:\s*(sha256:[0-9a-f]{64})\s+size:\s*\d+\s*$")
STATUS_FILE = "push.status"
LOG_FILE = "push.log"
SKIP_FILE = "skipped"
STAGED_MANIFEST = "staged.json"
FANAL_ARCHIVE = "trivy-fanal.tgz"
ARTIFACT_PREFIX = "fleet-image-staged-"
WORKFLOW = "fleet-image.yml"
WORKFLOW_PATH = ".github/workflows/fleet-image.yml"
MAX_AGE = dt.timedelta(hours=72)
# Build inputs that live in the workflow env rather than in a tracked file. The tree
# check already binds them (the workflow file is part of the tree); recording them
# lets the promotion compare the values it would pass with the ones the PR used.
BUILD_ARG_ENV = (
    "AGENT_IMAGE",
    "ONEPASSWORD_CLI_IMAGE",
    "CLAUDE_CODE_VERSION",
    "CLAUDE_AGENT_ACP_VERSION",
    "CODEX_VERSION",
    "GROK_VERSION",
    "CLAUDE_ACP_PLUGIN_SOURCE",
    "CLAUDE_ACP_PLUGIN_REVISION",
)


class Refused(Exception):
    """A reuse precondition does not hold; fall back to a full rebuild."""


def fail(message: str) -> NoReturn:
    print(f"promote-fleet-image: {message}", file=sys.stderr)
    raise SystemExit(1)


def run(args: list[str], *, timeout: float = 120) -> str:
    result = subprocess.run(args, check=False, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise Refused(f"{' '.join(args[:3])} exited {result.returncode}: {result.stderr.strip()[:500]}")
    return result.stdout


def require_sha(value: Any, what: str) -> str:
    if not isinstance(value, str) or not SHA_RE.fullmatch(value):
        raise Refused(f"{what} {value!r} is not a 40-hex commit SHA")
    return value


def require_digest(value: Any, what: str) -> str:
    if not isinstance(value, str) or not DIGEST_RE.fullmatch(value):
        raise Refused(f"{what} {value!r} is not a sha256 digest")
    return value


def local_tree(repo: Path) -> str:
    return require_sha(run(["git", "-C", str(repo), "rev-parse", "HEAD^{tree}"]).strip(), "checked-out tree")


def gh_json(path: str) -> Any:
    return json.loads(run(["gh", "api", path]))


def build_args_from_env() -> dict[str, str]:
    values = {name: os.environ.get(name, "") for name in BUILD_ARG_ENV}
    missing = [name for name, value in values.items() if not value]
    if missing:
        raise Refused(f"missing build input environment: {', '.join(missing)}")
    return values


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# --- PR side: start-push / record ------------------------------------------------


def start_push(args: argparse.Namespace) -> None:
    state: Path = args.state
    if state.exists():
        fail(f"staging state {state} already exists")
    state.mkdir(parents=True)
    try:
        require_sha(args.head_sha, "PR head")
        tree = local_tree(args.repo_root)
        head_tree = args.head_tree or require_sha(
            gh_json(f"repos/{args.repository}/git/commits/{args.head_sha}").get("tree", {}).get("sha"), "PR head tree")
        if tree != head_tree:
            raise Refused(f"merge commit tree {tree} != PR head tree {head_tree} (branch behind main)")
        run([args.docker, "tag", args.image, args.staging_image])
    except Refused as exc:
        (state / SKIP_FILE).write_text(f"{exc}\n", encoding="utf-8")
        print(f"::notice title=PR candidate not staged::{exc}; main will rebuild this image from scratch.")
        return
    log = (state / LOG_FILE).open("wb")
    worker = [sys.executable, str(Path(__file__).resolve()), "push-worker",
              "--docker", args.docker, "--staging-image", args.staging_image, "--state", str(state)]
    process = subprocess.Popen(worker, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                               start_new_session=True)
    log.close()
    print(f"staging push of {args.staging_image} running detached as pid {process.pid}", flush=True)


def push_worker(args: argparse.Namespace) -> None:
    code = 1
    try:
        code = subprocess.run([args.docker, "push", args.staging_image], check=False).returncode
    finally:
        tmp = args.state / (STATUS_FILE + ".tmp")
        tmp.write_text(f"{code}\n", encoding="utf-8")
        os.replace(tmp, args.state / STATUS_FILE)
    raise SystemExit(code)


def wait_push(state: Path, timeout: float, poll: float) -> str:
    deadline = time.monotonic() + timeout
    status = state / STATUS_FILE
    while not status.is_file() and time.monotonic() < deadline:
        time.sleep(poll)
    if not status.is_file():
        raise Refused(f"staging push did not finish within {timeout:g}s")
    log = (state / LOG_FILE).read_text(encoding="utf-8", errors="replace") if (state / LOG_FILE).is_file() else ""
    sys.stdout.write(log)
    if status.read_text(encoding="utf-8").strip() != "0":
        raise Refused("staging push failed")
    matches = PUSH_DIGEST_RE.findall(log)
    if len(matches) != 1:
        raise Refused(f"expected exactly one Docker push summary digest, found {len(matches)}")
    return matches[0]


def remote_config_digest(docker: str, ref: str) -> str:
    manifest = json.loads(run([docker, "buildx", "imagetools", "inspect", "--raw", ref]))
    digest = (manifest.get("config") or {}).get("digest") if isinstance(manifest, dict) else None
    return require_digest(digest, f"remote config of {ref}")


def record(args: argparse.Namespace) -> None:
    state: Path = args.state
    try:
        if (state / SKIP_FILE).is_file():
            raise Refused("candidate was not staged: " + (state / SKIP_FILE).read_text(encoding="utf-8").strip())
        digest = wait_push(state, args.timeout_seconds, args.poll_seconds)
        config_id = require_digest(args.config_id, "scanned config ID")
        immutable = f"{args.repository}@{digest}"
        remote = remote_config_digest(args.docker, immutable)
        if remote != config_id:
            raise Refused(f"remote config {remote} of {immutable} does not match the scanned config {config_id}")
        fanal = args.trivy_cache_dir / "fanal"
        if not fanal.is_dir():
            raise Refused(f"Trivy layer cache {fanal} does not exist")
        out: Path = args.output_dir
        out.mkdir(parents=True, exist_ok=True)
        with tarfile.open(out / FANAL_ARCHIVE, "w:gz") as archive:
            archive.add(fanal, arcname="fanal")
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "repository": args.repository,
            "staging_image": args.staging_image,
            "digest": digest,
            "immutable_ref": immutable,
            "config_digest": config_id,
            "source_sha": require_sha(args.source_sha, "built commit"),
            "head_sha": require_sha(args.head_sha, "PR head"),
            "tree": local_tree(args.repo_root),
            "build_args": build_args_from_env(),
            "run_id": int(args.run_id),
            "run_attempt": int(args.run_attempt),
            "fanal_sha256": sha256_file(out / FANAL_ARCHIVE),
        }
    except Refused as exc:
        fail(str(exc))
    (out / STAGED_MANIFEST).write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"staged {immutable} (config {config_id}, tree {manifest['tree']}) as build cache for main", flush=True)


# --- main side: locate -----------------------------------------------------------


def parse_time(value: Any) -> dt.datetime:
    if not isinstance(value, str):
        raise Refused(f"timestamp {value!r} is not a string")
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def merged_pull_request(repository: str, sha: str, api: Callable[[str], Any]) -> dict[str, Any]:
    pulls = api(f"repos/{repository}/commits/{sha}/pulls")
    matches = [p for p in pulls if isinstance(p, dict) and p.get("merge_commit_sha") == sha and p.get("merged_at")
               and (p.get("base") or {}).get("ref") == "main"]
    if len(matches) != 1:
        raise Refused(f"{sha[:12]} is not the merge commit of exactly one PR into main ({len(matches)} found)")
    pr = matches[0]
    head = pr.get("head") or {}
    if (head.get("repo") or {}).get("full_name") != repository:
        raise Refused(f"PR #{pr.get('number')} is from a fork; forks cannot stage")
    return pr


def newest_successful_run(repository: str, head_sha: str, api: Callable[[str], Any],
                          now: dt.datetime) -> dict[str, Any]:
    payload = api(f"repos/{repository}/actions/workflows/{WORKFLOW}/runs"
                  f"?event=pull_request&head_sha={head_sha}&per_page=50")
    runs = [r for r in payload.get("workflow_runs", []) if isinstance(r, dict)
            and r.get("head_sha") == head_sha and r.get("event") == "pull_request"
            and r.get("path") == WORKFLOW_PATH
            and (r.get("head_repository") or {}).get("full_name") == repository]
    if not runs:
        raise Refused(f"no Fleet Image pull_request run for PR head {head_sha[:12]}")
    newest = max(runs, key=lambda r: (str(r.get("created_at", "")), int(r.get("id", 0))))
    if newest.get("status") != "completed" or newest.get("conclusion") != "success":
        raise Refused(f"newest PR run {newest.get('html_url')} is {newest.get('status')}/{newest.get('conclusion')}")
    if now - parse_time(newest.get("created_at")) > MAX_AGE:
        raise Refused(f"PR run {newest.get('html_url')} is older than {MAX_AGE}")
    return newest


def safe_extract_fanal(archive_path: Path, cache_dir: Path) -> None:
    with tarfile.open(archive_path, "r:gz") as archive:
        members = archive.getmembers()
        for member in members:
            parts = Path(member.name).parts
            if not parts or parts[0] != "fanal" or ".." in parts or Path(member.name).is_absolute():
                raise Refused(f"unexpected path {member.name!r} in Trivy cache archive")
            if not (member.isfile() or member.isdir()):
                raise Refused(f"Trivy cache archive member {member.name!r} is not a file or directory")
        cache_dir.mkdir(parents=True, exist_ok=True)
        archive.extractall(cache_dir, members=members, filter="data")


def locate(args: argparse.Namespace, *, api: Callable[[str], Any] = gh_json,
           download: Callable[[str, int, str, Path], None] | None = None,
           now: dt.datetime | None = None) -> dict[str, str]:
    now = now or dt.datetime.now(dt.timezone.utc)
    sha = require_sha(args.sha, "main commit")
    tree = args.tree or local_tree(args.repo_root)
    before = args.before if args.before and args.before != "0" * 40 else ""
    if not before:
        parents = api(f"repos/{args.repository}/git/commits/{sha}").get("parents") or []
        before = (parents[0] or {}).get("sha", "") if parents else ""
    require_sha(before, "previous main commit")
    pr = merged_pull_request(args.repository, sha, api)
    head_sha = require_sha((pr.get("head") or {}).get("sha"), "PR head")
    # The PR run built refs/pull/N/merge. That merge has exactly the PR head tree when
    # main's previous commit (and so every older base, main being linear) is in the head.
    status = api(f"repos/{args.repository}/compare/{before}...{head_sha}").get("status")
    if status not in {"ahead", "identical"}:
        raise Refused(f"previous main {before[:12]} is not an ancestor of PR head {head_sha[:12]} ({status})")
    head_tree = require_sha(api(f"repos/{args.repository}/git/commits/{head_sha}").get("tree", {}).get("sha"),
                            "PR head tree")
    if head_tree != tree:
        raise Refused(f"PR head tree {head_tree} != main tree {tree}")
    pr_run = newest_successful_run(args.repository, head_sha, api, now)
    run_id = int(pr_run["id"])
    artifact = ARTIFACT_PREFIX + head_sha
    workdir = Path(tempfile.mkdtemp(prefix="fleet-stage-", dir=args.workdir))
    (download or gh_download)(args.repository, run_id, artifact, workdir)
    staged_path = workdir / STAGED_MANIFEST
    if not staged_path.is_file():
        raise Refused(f"artifact {artifact} of run {run_id} has no {STAGED_MANIFEST}")
    staged = json.loads(staged_path.read_text(encoding="utf-8"))
    expected = {
        "schema_version": SCHEMA_VERSION,
        "repository": args.image_repository,
        "head_sha": head_sha,
        "tree": tree,
        "run_id": run_id,
        "build_args": build_args_from_env(),
    }
    for key, value in expected.items():
        if staged.get(key) != value:
            raise Refused(f"staged {key} {staged.get(key)!r} != expected {value!r}")
    digest = require_digest(staged.get("digest"), "staged digest")
    if staged.get("immutable_ref") != f"{args.image_repository}@{digest}":
        raise Refused("staged immutable_ref does not match its digest")
    fanal_archive = workdir / FANAL_ARCHIVE
    if not fanal_archive.is_file() or sha256_file(fanal_archive) != staged.get("fanal_sha256"):
        raise Refused("staged Trivy cache is missing or does not match its recorded hash")
    safe_extract_fanal(fanal_archive, args.trivy_cache_dir)
    return {
        "found": "true",
        "ref": f"{args.image_repository}@{digest}",
        "run-url": str(pr_run.get("html_url", run_id)),
        "pr": str(pr.get("number", "")),
    }


def gh_download(repository: str, run_id: int, artifact: str, dest: Path) -> None:
    run(["gh", "run", "download", str(run_id), "-R", repository, "-n", artifact, "-D", str(dest)], timeout=300)


def locate_command(args: argparse.Namespace) -> None:
    try:
        outputs = locate(args)
        print(f"reusing PR #{outputs['pr']} stage {outputs['ref']} from {outputs['run-url']} as build and "
              "Trivy layer cache; main still builds, scans and attests its own candidate", flush=True)
    except (Refused, OSError, ValueError, KeyError, TypeError, tarfile.TarError, subprocess.TimeoutExpired) as exc:
        reason = " ".join(str(exc).split())
        outputs = {"found": "false", "reason": reason}
        print(f"::notice title=Full Fleet rebuild::no reusable PR stage ({reason}); building from scratch", flush=True)
    if args.github_output is not None:
        with args.github_output.open("a", encoding="utf-8") as handle:
            for key, value in outputs.items():
                handle.write(f"{key}={value.replace(chr(10), ' ')}\n")


# --- cli -------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)

    p = commands.add_parser("start-push", help="tag and push the PR candidate detached, if the trees match")
    p.add_argument("--image", required=True)
    p.add_argument("--staging-image", required=True)
    p.add_argument("--repository", required=True, help="GitHub owner/name, for the head-tree lookup")
    p.add_argument("--head-sha", required=True)
    p.add_argument("--head-tree", default="", help=argparse.SUPPRESS)
    p.add_argument("--state", type=Path, required=True)
    p.add_argument("--repo-root", type=Path, default=Path("."))
    p.add_argument("--docker", default="docker")
    p.set_defaults(func=start_push)

    p = commands.add_parser("push-worker", help=argparse.SUPPRESS)
    p.add_argument("--staging-image", required=True)
    p.add_argument("--state", type=Path, required=True)
    p.add_argument("--docker", default="docker")
    p.set_defaults(func=push_worker)

    p = commands.add_parser("record", help="bind the pushed staging digest and package the Trivy layer cache")
    p.add_argument("--state", type=Path, required=True)
    p.add_argument("--repository", required=True, help="image repository, e.g. ghcr.io/switchroom/switchroom")
    p.add_argument("--staging-image", required=True)
    p.add_argument("--config-id", required=True)
    p.add_argument("--source-sha", required=True)
    p.add_argument("--head-sha", required=True)
    p.add_argument("--run-id", required=True)
    p.add_argument("--run-attempt", required=True)
    p.add_argument("--trivy-cache-dir", type=Path, required=True)
    p.add_argument("--output-dir", type=Path, required=True)
    p.add_argument("--repo-root", type=Path, default=Path("."))
    p.add_argument("--docker", default="docker")
    p.add_argument("--timeout-seconds", type=float, default=900)
    p.add_argument("--poll-seconds", type=float, default=2.0)
    p.set_defaults(func=record)

    p = commands.add_parser("locate", help="find a reusable tree-identical PR stage for this main commit")
    p.add_argument("--repository", required=True, help="GitHub owner/name")
    p.add_argument("--image-repository", required=True)
    p.add_argument("--sha", required=True)
    p.add_argument("--before", default="", help="push event's previous main commit; defaults to the first parent")
    p.add_argument("--tree", default="", help=argparse.SUPPRESS)
    p.add_argument("--trivy-cache-dir", type=Path, required=True)
    p.add_argument("--workdir", default=None)
    p.add_argument("--repo-root", type=Path, default=Path("."))
    p.add_argument("--github-output", type=Path, default=None)
    p.set_defaults(func=locate_command)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
