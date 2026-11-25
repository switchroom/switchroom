#!/usr/bin/env python3
"""Export the built Fleet candidate once and scan it with Syft and Trivy concurrently.

The workflow used to run the SBOM action and then the Trivy action back to back;
each of them privately re-exported the multi-GB image from the Docker daemon.
This helper exports the image a single time (``export``), binds the archive to
the local image config ID that publication later compares with the remote
manifest, then lets the two independent scanners share it:

* ``start-sbom`` launches Syft detached in its own session, writing the SPDX
  document, a log and an exit-status file. It returns immediately so the
  workflow can run Trivy, the VEX gate, the exact-main CI gate and the staging
  push while Syft is still working.
* ``trivy`` runs Trivy in the foreground against the same archive with the
  vulnerability database that ``prefetch-db`` downloaded earlier in the job.
* ``trivy-remote`` (HF-851 promotion) runs the same CRITICAL scan against an immutable registry
  digest instead of an archive. With the layer cache the PR run staged, only the vulnerability
  match against today's database runs; no multi-GB pull or export.
* ``wait-sbom`` blocks until the detached Syft run has written its status,
  fails closed on any non-zero status, a missing status, an empty document or a
  timeout, and then removes the state directory.

Every subcommand fails closed; nothing here decides policy (that stays with
``verify-trivy-vex.py`` and the SPDX validators).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path
from typing import NoReturn

STATUS_FILE = "sbom.status"
LOG_FILE = "sbom.log"
PID_FILE = "sbom.pid"


def fail(message: str) -> NoReturn:
    print(f"scan-fleet-image: {message}", file=sys.stderr)
    raise SystemExit(1)


def require_tool(name: str) -> str:
    candidate = Path(name)
    if candidate.is_file() and os.access(candidate, os.X_OK):
        return str(candidate)
    path = shutil.which(name)
    if not path:
        fail(f"missing tool {name}")
    return path


def run_checked(args: list[str], *, timeout: float | None = None) -> None:
    print("+ " + " ".join(args), flush=True)
    try:
        result = subprocess.run(args, check=False, timeout=timeout)
    except subprocess.TimeoutExpired:
        fail(f"{args[0]} timed out after {timeout:g}s")
    if result.returncode:
        fail(f"{args[0]} exited {result.returncode}")


# --- export ------------------------------------------------------------------


def image_config_id(docker: str, image: str) -> str:
    result = subprocess.run(
        [docker, "image", "inspect", "--format", "{{.Id}}", image],
        check=False, capture_output=True, text=True, timeout=60,
    )
    image_id = result.stdout.strip()
    if result.returncode or not image_id.startswith("sha256:") or len(image_id) != 71:
        fail(f"could not determine local image config ID for {image}")
    return image_id


def verify_archive_config_id(archive_path: Path, image_id: str) -> None:
    """Require docker-save's manifest to bind the archive to the inspected config."""
    try:
        with tarfile.open(archive_path) as archive:
            member = archive.extractfile("manifest.json")
            if member is None:
                fail("docker archive has no manifest.json")
            manifest = json.load(member)
            expected_config = image_id.removeprefix("sha256:") + ".json"
            if not isinstance(manifest, list) or len(manifest) != 1:
                fail("docker archive must contain exactly one image")
            entry = manifest[0]
            config = entry.get("Config") if isinstance(entry, dict) else None
            if config not in {expected_config, f"blobs/sha256/{image_id.removeprefix('sha256:')}"}:
                fail("docker archive config does not match inspected image ID")
            archive.getmember(config)
    except (OSError, tarfile.TarError, json.JSONDecodeError, KeyError):
        fail("could not validate docker archive config binding")


def export(args: argparse.Namespace) -> None:
    docker = require_tool(args.docker)
    archive: Path = args.archive
    archive.parent.mkdir(parents=True, exist_ok=True)
    archive.unlink(missing_ok=True)
    image_id = image_config_id(docker, args.image)
    started = time.monotonic()
    try:
        run_checked([docker, "image", "save", "--output", str(archive), args.image], timeout=args.timeout_seconds)
        verify_archive_config_id(archive, image_id)
    except BaseException:
        archive.unlink(missing_ok=True)
        raise
    print(
        f"exported {args.image} ({image_id}) to {archive}: {archive.stat().st_size} bytes "
        f"in {time.monotonic() - started:.1f}s",
        flush=True,
    )
    if args.github_output is not None:
        with args.github_output.open("a", encoding="utf-8") as handle:
            handle.write(f"config-id={image_id}\narchive={archive}\n")


# --- syft --------------------------------------------------------------------


def syft_command(syft: str, archive: Path, output: Path) -> list[str]:
    return [syft, "scan", f"docker-archive:{archive}", "-o", f"spdx-json={output}", "--quiet"]


def write_status(state: Path, code: int) -> None:
    tmp = state / (STATUS_FILE + ".tmp")
    tmp.write_text(f"{code}\n", encoding="utf-8")
    os.replace(tmp, state / STATUS_FILE)


def sbom_worker(args: argparse.Namespace) -> None:
    """Internal: run Syft and record its exit status atomically."""
    state: Path = args.state
    code = 1
    try:
        result = subprocess.run(syft_command(args.syft, args.archive, args.output), check=False)
        code = result.returncode
    finally:
        write_status(state, code)
    raise SystemExit(code)


def start_sbom(args: argparse.Namespace) -> None:
    syft = require_tool(args.syft)
    state: Path = args.state
    if not args.archive.is_file():
        fail(f"archive {args.archive} does not exist")
    if state.exists():
        fail(f"SBOM state directory {state} already exists; refusing to start a second run")
    state.mkdir(parents=True)
    args.output.unlink(missing_ok=True)
    log = (state / LOG_FILE).open("wb")
    worker = [
        sys.executable, str(Path(__file__).resolve()), "sbom-worker",
        "--syft", syft, "--archive", str(args.archive), "--output", str(args.output), "--state", str(state),
    ]
    print("+ " + " ".join(worker) + " &", flush=True)
    # A new session with no inherited stdio keeps the step from waiting on the child's pipes,
    # and lets the process survive the end of this workflow step.
    process = subprocess.Popen(worker, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    log.close()
    (state / PID_FILE).write_text(f"{process.pid}\n", encoding="utf-8")
    time.sleep(args.settle_seconds)
    if process.poll() is not None and process.returncode != 0:
        print((state / LOG_FILE).read_text(encoding="utf-8", errors="replace"), file=sys.stderr)
        fail(f"SBOM generation exited {process.returncode} immediately")
    print(f"SBOM generation running detached as pid {process.pid}; state in {state}", flush=True)


def read_status(state: Path) -> int | None:
    path = state / STATUS_FILE
    if not path.is_file():
        return None
    try:
        return int(path.read_text(encoding="utf-8").strip())
    except ValueError:
        return 1


def wait_sbom(args: argparse.Namespace) -> None:
    state: Path = args.state
    if not state.is_dir():
        fail(f"SBOM state directory {state} does not exist; was start-sbom run?")
    deadline = time.monotonic() + args.timeout_seconds
    code = read_status(state)
    while code is None and time.monotonic() < deadline:
        time.sleep(min(args.poll_seconds, max(0.0, deadline - time.monotonic())))
        code = read_status(state)
    log_path = state / LOG_FILE
    if log_path.is_file():
        sys.stdout.write(log_path.read_text(encoding="utf-8", errors="replace"))
        sys.stdout.flush()
    if code is None:
        pid = (state / PID_FILE).read_text(encoding="utf-8").strip() if (state / PID_FILE).is_file() else ""
        if pid:
            try:
                os.killpg(int(pid), 9)
            except (ProcessLookupError, PermissionError, ValueError):
                pass
        fail(f"SBOM generation did not finish within {args.timeout_seconds:g}s")
    if code != 0:
        fail(f"SBOM generation exited {code}")
    output: Path = args.output
    if not output.is_file() or output.stat().st_size == 0:
        fail(f"SBOM generation reported success but {output} is missing or empty")
    try:
        document = json.loads(output.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"SBOM output {output} is not JSON: {exc}")
    if not isinstance(document, dict) or document.get("spdxVersion") != "SPDX-2.3":
        fail(f"SBOM output {output} is not an SPDX 2.3 document")
    shutil.rmtree(state, ignore_errors=True)
    print(f"SBOM ready: {output} ({output.stat().st_size} bytes)", flush=True)


# --- trivy -------------------------------------------------------------------


def trivy_command(trivy: str, archive: Path | None, output: Path, *, timeout: str, image: str | None = None) -> list[str]:
    if (archive is None) == (image is None):
        fail("scan exactly one of an archive or an immutable image reference")
    source = ["--input", str(archive)] if archive is not None else ["--image-src", "remote"]
    return [
        trivy, "image",
        *source,
        "--format", "json",
        "--output", str(output),
        "--scanners", "vuln",
        "--severity", "CRITICAL",
        "--ignore-unfixed",
        "--exit-code", "0",
        "--skip-db-update",
        "--timeout", timeout,
        *([image] if image is not None else []),
    ]


def prefetch_db(args: argparse.Namespace) -> None:
    trivy = require_tool(args.trivy)
    run_checked([trivy, "image", "--download-db-only"], timeout=args.timeout_seconds)


def check_report(args: argparse.Namespace) -> None:
    if not args.output.is_file() or args.output.stat().st_size == 0:
        fail(f"Trivy reported success but {args.output} is missing or empty")
    try:
        report = json.loads(args.output.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"Trivy output {args.output} is not JSON: {exc}")
    if not isinstance(report, dict) or "Results" not in report and "SchemaVersion" not in report:
        fail(f"Trivy output {args.output} is not a Trivy JSON report")


def trivy(args: argparse.Namespace) -> None:
    trivy_bin = require_tool(args.trivy)
    if not args.archive.is_file():
        fail(f"archive {args.archive} does not exist")
    args.output.unlink(missing_ok=True)
    run_checked(trivy_command(trivy_bin, args.archive, args.output, timeout=args.timeout), timeout=args.timeout_seconds)
    check_report(args)


def trivy_remote(args: argparse.Namespace) -> None:
    trivy_bin = require_tool(args.trivy)
    if "@sha256:" not in args.image or len(args.image.rsplit("@sha256:", 1)[1]) != 64:
        fail(f"{args.image} is not an immutable sha256 digest reference")
    args.output.unlink(missing_ok=True)
    run_checked(trivy_command(trivy_bin, None, args.output, timeout=args.timeout, image=args.image),
                timeout=args.timeout_seconds)
    check_report(args)
    artifact = json.loads(args.output.read_text(encoding="utf-8")).get("ArtifactName")
    if artifact != args.image:
        fail(f"Trivy scanned {artifact!r}, not {args.image}")


# --- cli ---------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)

    p = commands.add_parser("export", help="docker save the candidate once, bound to its config ID")
    p.add_argument("--image", required=True)
    p.add_argument("--archive", type=Path, required=True)
    p.add_argument("--docker", default="docker")
    p.add_argument("--timeout-seconds", type=float, default=900)
    p.add_argument("--github-output", type=Path, default=None)
    p.set_defaults(func=export)

    p = commands.add_parser("prefetch-db", help="download the Trivy vulnerability database")
    p.add_argument("--trivy", default="trivy")
    p.add_argument("--timeout-seconds", type=float, default=600)
    p.set_defaults(func=prefetch_db)

    p = commands.add_parser("start-sbom", help="start Syft detached against the archive")
    p.add_argument("--archive", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--state", type=Path, required=True)
    p.add_argument("--syft", default="syft")
    p.add_argument("--settle-seconds", type=float, default=1.0)
    p.set_defaults(func=start_sbom)

    p = commands.add_parser("sbom-worker", help=argparse.SUPPRESS)
    p.add_argument("--archive", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--state", type=Path, required=True)
    p.add_argument("--syft", required=True)
    p.set_defaults(func=sbom_worker)

    p = commands.add_parser("wait-sbom", help="wait for the detached Syft run; fail closed")
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--state", type=Path, required=True)
    p.add_argument("--timeout-seconds", type=float, default=900)
    p.add_argument("--poll-seconds", type=float, default=2.0)
    p.set_defaults(func=wait_sbom)

    p = commands.add_parser("trivy", help="scan the archive for CRITICAL vulnerabilities")
    p.add_argument("--archive", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--trivy", default="trivy")
    p.add_argument("--timeout", default="10m", help="Trivy's own --timeout")
    p.add_argument("--timeout-seconds", type=float, default=900)
    p.set_defaults(func=trivy)

    p = commands.add_parser("trivy-remote", help="scan an immutable registry digest for CRITICAL vulnerabilities")
    p.add_argument("--image", required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--trivy", default="trivy")
    p.add_argument("--timeout", default="10m", help="Trivy's own --timeout")
    p.add_argument("--timeout-seconds", type=float, default=900)
    p.set_defaults(func=trivy_remote)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if getattr(args, "timeout_seconds", 1) <= 0 or getattr(args, "poll_seconds", 1) <= 0:
        fail("timeouts must be positive")
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
