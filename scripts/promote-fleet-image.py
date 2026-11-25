#!/usr/bin/env python3
"""Promote the scanned pull-request Fleet image when main publishes the same tree.

``main`` requires PRs to be up to date, so the tree a merged PR's
``preflight_bake`` built and scanned is the tree main publishes. Since HF-851 the
image is stamped with content identity, not with the main commit: the PR bake
stamps its head commit (``FLEET_GIT_SHA``, OCI revision label) and the git tree
(``FLEET_SOURCE_TREE``, ``hermes-fleet.source-tree``), and the squash-merged main commit
has exactly that tree. Main therefore promotes the exact scanned digest (retag,
fresh Trivy/VEX gate, exact-main CI gate, attestations) instead of rebuilding it.
The PR leaves behind what main needs:

* ``start-push`` (PR, same repository only) refuses unless the checked-out merge
  commit's tree equals the PR head's tree, then tags the scanned candidate (built
  with inline BuildKit cache metadata) with a run/attempt-unique
  ``fleet-pr-stage-*`` ref and pushes it detached, so the push overlaps the scans.
* ``record`` (PR) waits for that push, requires the remote manifest's config to
  equal the scanned archive's config ID, and writes ``staged.json`` plus Trivy's
  layer-analysis cache (``fanal``) into one directory for upload as the
  ``fleet-image-staged-<head sha>`` artifact. The upload step runs only after every
  preflight gate has passed.
* ``locate`` (main) finds the merged PR's newest successful same-repository
  Fleet Image run, requires that main's previous commit is an ancestor of the PR
  head (so the PR run's merge commit had exactly the PR head tree), that the PR
  head tree equals the checked-out main tree, and that the recorded tree, image
  revision, build inputs and scan evidence match. ``--probe`` stops before the
  download (the cheap job that chooses promotion or rebuild); the full form seeds
  Trivy's layer cache and unpacks the staged SBOM and scan evidence.
* ``verify-stage`` (main promotion) reads the staged digest's manifest and config
  from the registry and requires the scanned config digest, the revision and tree
  labels, the image identity, the Agent parent and every pinned tool version.

* ``prune`` (scheduled) deletes registry versions whose every tag is a
  ``fleet-pr-stage-<run>-<attempt>`` ref and that are older than the 7-day
  artifact window (``locate`` already ignores runs older than 72 hours). Versions
  carrying any other tag, and untagged versions (attestations, published
  digests), are never touched.

On promotion main re-runs the CRITICAL Trivy scan against the digest with
today's database, re-checks VEX, waits for green exact-main CI and only then
tags and attests the digest; the runtime and Camoufox checks ran on those exact
bytes in the PR. ``locate`` never fails the job: any doubt prints why and
reports ``found=false``, and main rebuilds (and scans) from scratch.
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

# 2 (HF-851): content identity (image_revision = PR head, tree label) plus the PR's scan evidence.
SCHEMA_VERSION = 2
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
PRUNE_AGE = dt.timedelta(days=7)
STAGE_TAG_RE = re.compile(r"^fleet-pr-stage-[0-9]+-[0-9]+$")
TREE_LABEL = "hermes-fleet.source-tree"
REVISION_LABEL = "org.opencontainers.image.revision"
SOURCE_LABEL = "org.opencontainers.image.source"
BASE_LABEL = "org.opencontainers.image.base.name"
FLEET_SOURCE = "https://github.com/switchroom/switchroom"
# Staged next to staged.json and bound by sha256: the bounded SBOM main attests, the PR's Trivy
# report and its VEX evaluation (binary hash of the candidate's op).
EVIDENCE_FILES = ("fleet-image.attestation.spdx.json", "trivy-image.json", "vex-evaluation.json")
# Environment the Dockerfile stamps from each build input (verify-stage).
ENV_FOR_BUILD_ARG = {
    "AGENT_IMAGE": "HERMES_FLEET_AGENT_IMAGE",
    "ONEPASSWORD_CLI_IMAGE": "HERMES_FLEET_ONEPASSWORD_CLI_IMAGE",
    "CLAUDE_CODE_VERSION": "HERMES_FLEET_CLAUDE_CODE_VERSION",
    "CLAUDE_AGENT_ACP_VERSION": "HERMES_FLEET_CLAUDE_AGENT_ACP_VERSION",
    "CODEX_VERSION": "HERMES_FLEET_CODEX_VERSION",
    "GROK_VERSION": "HERMES_FLEET_GROK_VERSION",
    "CLAUDE_ACP_PLUGIN_SOURCE": "HERMES_FLEET_CLAUDE_ACP_PLUGIN_SOURCE",
    "CLAUDE_ACP_PLUGIN_REVISION": "HERMES_FLEET_CLAUDE_ACP_PLUGIN_REVISION",
}
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
        head_sha = require_sha(args.head_sha, "PR head")
        if args.image_revision != head_sha:
            raise Refused(f"image revision {args.image_revision!r} is not the PR head {head_sha}; not promotable")
        out: Path = args.output_dir
        out.mkdir(parents=True, exist_ok=True)
        evidence: dict[str, str] = {}
        for name in EVIDENCE_FILES:
            source = args.evidence_dir / name
            if not source.is_file() or source.stat().st_size == 0:
                raise Refused(f"scan evidence {source} is missing or empty")
            (out / name).write_bytes(source.read_bytes())
            evidence[name] = sha256_file(out / name)
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
            "head_sha": head_sha,
            "image_revision": head_sha,
            "tree": local_tree(args.repo_root),
            "evidence_sha256": evidence,
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
    if getattr(args, "probe", False):
        listed = api(f"repos/{args.repository}/actions/runs/{run_id}/artifacts?name={artifact}&per_page=10")
        live = [a for a in (listed or {}).get("artifacts", []) if isinstance(a, dict)
                and a.get("name") == artifact and not a.get("expired")]
        if len(live) != 1:
            raise Refused(f"run {run_id} has no single live {artifact} artifact")
        return {"found": "true", "pr": str(pr.get("number", "")), "run-url": str(pr_run.get("html_url", run_id)),
                "head-sha": head_sha, "tree": tree}
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
        "image_revision": head_sha,
        "tree": tree,
        "run_id": run_id,
        "build_args": build_args_from_env(),
    }
    # A re-run attempt that did not itself stage leaves an older attempt's artifact behind;
    # only the attempt that decided the run's conclusion counts.
    expected["run_attempt"] = int(pr_run.get("run_attempt", 0))
    for key, value in expected.items():
        if staged.get(key) != value:
            raise Refused(f"staged {key} {staged.get(key)!r} != expected {value!r}")
    digest = require_digest(staged.get("digest"), "staged digest")
    if staged.get("immutable_ref") != f"{args.image_repository}@{digest}":
        raise Refused("staged immutable_ref does not match its digest")
    config_digest = require_digest(staged.get("config_digest"), "staged config digest")
    recorded = staged.get("evidence_sha256")
    if not isinstance(recorded, dict) or set(recorded) != set(EVIDENCE_FILES):
        raise Refused("staged scan evidence list does not match")
    for name in EVIDENCE_FILES:
        if not (workdir / name).is_file() or sha256_file(workdir / name) != recorded[name]:
            raise Refused(f"staged {name} is missing or does not match its recorded hash")
    fanal_archive = workdir / FANAL_ARCHIVE
    if not fanal_archive.is_file() or sha256_file(fanal_archive) != staged.get("fanal_sha256"):
        raise Refused("staged Trivy cache is missing or does not match its recorded hash")
    safe_extract_fanal(fanal_archive, args.trivy_cache_dir)
    return {
        "found": "true",
        "ref": f"{args.image_repository}@{digest}",
        "digest": digest,
        "config-digest": config_digest,
        "image-revision": head_sha,
        "tree": tree,
        "stage-dir": str(workdir),
        "run-url": str(pr_run.get("html_url", run_id)),
        "pr": str(pr.get("number", "")),
    }


def gh_download(repository: str, run_id: int, artifact: str, dest: Path) -> None:
    run(["gh", "run", "download", str(run_id), "-R", repository, "-n", artifact, "-D", str(dest)], timeout=300)


def locate_command(args: argparse.Namespace) -> None:
    try:
        outputs = locate(args)
        if args.probe:
            print(f"PR #{outputs['pr']} staged a tree-identical candidate in {outputs['run-url']}: promote it", flush=True)
        else:
            print(f"located PR #{outputs['pr']} stage {outputs['ref']} from {outputs['run-url']} (tree "
                  f"{outputs['tree']}, revision {outputs['image-revision']})", flush=True)
    except (Refused, OSError, ValueError, KeyError, TypeError, tarfile.TarError, subprocess.TimeoutExpired) as exc:
        reason = " ".join(str(exc).split())
        outputs = {"found": "false", "reason": reason}
        print(f"::notice title=Full Fleet rebuild::no reusable PR stage ({reason}); building from scratch", flush=True)
    if args.github_output is not None:
        with args.github_output.open("a", encoding="utf-8") as handle:
            for key, value in outputs.items():
                handle.write(f"{key}={value.replace(chr(10), ' ')}\n")


# --- main side: verify-stage ----------------------------------------------------


def inspect_remote(docker: str, ref: str) -> tuple[dict[str, Any], dict[str, Any]]:
    manifest = json.loads(run([docker, "buildx", "imagetools", "inspect", "--raw", ref]))
    config = json.loads(run([docker, "buildx", "imagetools", "inspect", "--format", "{{json .Image}}", ref]))
    if not isinstance(manifest, dict) or not isinstance(config, dict):
        raise Refused(f"{ref} manifest or config is not a JSON object")
    return manifest, config


def verify_stage(args: argparse.Namespace, *, inspect: Callable[[str, str], tuple[dict[str, Any], dict[str, Any]]] = inspect_remote) -> None:
    ref = args.ref
    digest = require_digest(ref.rsplit("@", 1)[1] if "@" in ref else None, "staged reference digest")
    if ref != f"{args.image_repository}@{digest}":
        raise Refused(f"{ref} is not an immutable {args.image_repository} digest")
    manifest, image = inspect(args.docker, ref)
    if manifest.get("mediaType") not in {"application/vnd.oci.image.manifest.v1+json",
                                         "application/vnd.docker.distribution.manifest.v2+json"}:
        raise Refused(f"{ref} is not a single-platform image manifest")
    if (manifest.get("config") or {}).get("digest") != require_digest(args.config_digest, "scanned config"):
        raise Refused(f"{ref} config is not the scanned config {args.config_digest}")
    config = image.get("config") or image.get("Config") or {}
    labels = config.get("Labels") or {}
    env = dict(item.split("=", 1) for item in config.get("Env") or [] if isinstance(item, str) and "=" in item)
    build_args = build_args_from_env()
    expected_labels = {
        REVISION_LABEL: require_sha(args.image_revision, "image revision"),
        TREE_LABEL: require_sha(args.tree, "tree"),
        SOURCE_LABEL: FLEET_SOURCE,
        BASE_LABEL: build_args["AGENT_IMAGE"],
    }
    expected_env = {
        "HERMES_FLEET_GIT_SHA": args.image_revision,
        "HERMES_FLEET_SOURCE_TREE": args.tree,
        "HERMES_FLEET_IMAGE_IDENTITY": args.image_repository,
        **{env_name: build_args[arg] for arg, env_name in ENV_FOR_BUILD_ARG.items()},
    }
    wrong = sorted([k for k, v in expected_labels.items() if labels.get(k) != v]
                   + [k for k, v in expected_env.items() if env.get(k) != v])
    if wrong:
        raise Refused(f"{ref} identity mismatch: {', '.join(wrong)}")
    if config.get("User") != "1000:1000":
        raise Refused(f"{ref} runtime user is {config.get('User')!r}, not 1000:1000")
    print(f"verified staged {ref}: config {args.config_digest}, revision {args.image_revision}, tree {args.tree}", flush=True)


def verify_stage_command(args: argparse.Namespace) -> None:
    try:
        verify_stage(args)
    except Refused as exc:
        fail(str(exc))


# --- prune ------------------------------------------------------------------------


def stage_only(version: dict[str, Any]) -> bool:
    metadata = version.get("metadata")
    container = metadata.get("container") if isinstance(metadata, dict) else None
    tags = container.get("tags") if isinstance(container, dict) else None
    return isinstance(tags, list) and bool(tags) and all(isinstance(tag, str) and STAGE_TAG_RE.fullmatch(tag)
                                                          for tag in tags)


def prunable(versions: list[Any], now: dt.datetime) -> list[dict[str, Any]]:
    targets = []
    for version in versions:
        if not isinstance(version, dict) or not stage_only(version):
            continue
        version_id = version.get("id")
        if type(version_id) is not int or version_id <= 0:
            print(f"::warning title=Prune candidate skipped::version {version_id!r}: "
                  "expected a positive integer version ID", flush=True)
            continue
        try:
            age = now - parse_time(version.get("updated_at"))
        except (Refused, ValueError, TypeError, OverflowError):
            print(f"::warning title=Prune candidate skipped::version {version_id} has an invalid updated_at", flush=True)
            continue
        if age > PRUNE_AGE:
            targets.append(version)
    return targets


def prune(args: argparse.Namespace, *, api_lines: Callable[[str], list[Any]] | None = None,
          delete: Callable[[str], None] | None = None, now: dt.datetime | None = None) -> int:
    now = now or dt.datetime.now(dt.timezone.utc)
    base = f"orgs/{args.org}/packages/container/{args.package}/versions"
    if api_lines is None:
        def api_lines(path: str) -> list[Any]:
            # gh prints jq strings raw. Encode every row as JSON to preserve its type.
            out = run(["gh", "api", "--paginate", path, "--jq", ".[] | @json"], timeout=300)
            return [json.loads(line) for line in out.split("\n") if line.strip()]
    if delete is None:
        def delete(path: str) -> None:
            run(["gh", "api", "--method", "DELETE", path])
    targets = prunable(api_lines(f"{base}?per_page=100"), now)[: args.max_deletions]
    failed = 0
    for version in targets:
        tags = version["metadata"]["container"]["tags"]
        version_id = version["id"]
        if args.dry_run:
            print(f"would delete version {version_id} {tags} (updated {version.get('updated_at')})")
            continue
        try:
            delete(f"{base}/{version_id}")
        except Exception as exc:  # One refused delete must not stop the day's prune.
            failed += 1
            print(f"::warning title=Prune delete failed::version {version_id!r} {tags}: "
                  f"{type(exc).__name__}: {str(exc)[:300]}", flush=True)
            continue
        print(f"deleted version {version_id} {tags} (updated {version.get('updated_at')})")
    done = len(targets) - failed
    print(f"{'would prune' if args.dry_run else 'pruned'} {done} stage-only version(s)"
          + (f"; {failed} delete(s) failed" if failed else ""))
    if targets and failed == len(targets):
        raise Refused(f"every one of {failed} delete(s) failed")
    return done


def prune_command(args: argparse.Namespace) -> None:
    try:
        prune(args)
    except Refused as exc:
        fail(str(exc))


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
    p.add_argument("--image-revision", required=True, help="the FLEET_GIT_SHA the candidate was stamped with")
    p.add_argument("--evidence-dir", type=Path, default=Path("."), help="directory holding the scan evidence files")
    p.add_argument("--output-dir", type=Path, required=True)
    p.add_argument("--repo-root", type=Path, default=Path("."))
    p.add_argument("--docker", default="docker")
    # Bounded so a slow staging push cannot hold the required preflight context; on timeout
    # nothing is staged and main rebuilds.
    p.add_argument("--timeout-seconds", type=float, default=240)
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
    p.add_argument("--probe", action="store_true", help="decide promotability only; no download")
    p.set_defaults(func=locate_command)

    p = commands.add_parser("verify-stage", help="bind a staged digest's registry config to its content identity")
    p.add_argument("--ref", required=True)
    p.add_argument("--image-repository", required=True)
    p.add_argument("--config-digest", required=True)
    p.add_argument("--image-revision", required=True)
    p.add_argument("--tree", required=True)
    p.add_argument("--docker", default="docker")
    p.set_defaults(func=verify_stage_command)

    p = commands.add_parser("prune", help="delete stage-only registry versions older than the artifact window")
    p.add_argument("--org", required=True)
    p.add_argument("--package", required=True)
    p.add_argument("--max-deletions", type=int, default=100)
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=prune_command)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
