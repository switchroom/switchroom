#!/usr/bin/env python3
"""Roll a Compose project's agents onto one digest-pinned image, one at a time.

One job: move the selected agent services of one Docker Compose project onto a
single immutable image reference (``...@sha256:<64 hex>``).

Per agent, in order (every non-controller agent first, the controller last):

  1. record the image the running container is on (reference and image ID)
  2. recreate that one service on the target image
     (``docker compose up -d --no-deps --force-recreate --pull never <service>``
     with a temporary override file that sets only that service's ``image``)
  3. wait, with a timeout, until the new container is running on the target
     image ID and its container healthcheck reports ``healthy``
  4. on failure: recreate that agent on its recorded previous image, wait for
     it to be healthy again, write the report and stop the rollout

It never edits the operator's Compose files, never removes containers,
volumes, networks or orphans, never reads or writes secrets, and never starts
an agent that was not running. Dry-run inspects only and prints the plan.

Docker is behind the small ``Docker`` interface so the runner is testable with
a fake; ``CliDocker`` is the only class that runs a process.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Protocol

sys.path.insert(0, str(Path(__file__).resolve().parent))
from image_ref import require_digest_reference  # noqa: E402

SCHEMA = "switchroom-rollout/1"
# Compose service and project names; also refuses anything that could be read
# as a command-line option.
SERVICE_RE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*")
PROJECT_RE = re.compile(r"[a-z0-9][a-z0-9_-]*")
EXIT_OK = 0
EXIT_FAILED = 1
EXIT_REFUSED = 2


class Refused(Exception):
    """A precondition failed before any container was touched."""


# ----------------------------------------------------------------------- docker


class Docker(Protocol):
    """Everything the runner asks of Docker. Tests supply a fake."""

    def services(self) -> dict[str, dict[str, Any]]:
        """Rendered Compose services: {name: {"image": str, "healthcheck": bool | None}}."""
        ...

    def container_id(self, service: str) -> str | None:
        """ID of the project's container for ``service``, or None."""
        ...

    def inspect_container(self, container_id: str) -> dict[str, Any]:
        """{"image_id", "image_ref", "status", "running", "health", "restart_count"}."""
        ...

    def pull(self, image: str) -> None:
        """Pull ``image``; raise RuntimeError on failure."""
        ...

    def image_id(self, image: str) -> str | None:
        """Local image ID for a reference, or None if absent."""
        ...

    def image_has_healthcheck(self, image: str) -> bool:
        """True when the image config declares an enabled HEALTHCHECK."""
        ...

    def repo_digests(self, image_id: str) -> list[str]:
        """Repository digests recorded for a local image ID."""
        ...

    def recreate(self, service: str, image: str) -> tuple[int, str]:
        """Recreate one service on ``image``. Returns (exit code, stderr tail)."""
        ...


def _tail(text: str, limit: int = 600) -> str:
    return (text or "")[-limit:].strip()


def _healthcheck_enabled(test: Any) -> bool:
    if not test:
        return False
    if isinstance(test, list):
        return bool(test) and test[0] != "NONE"
    return str(test).strip().upper() != "NONE"


@dataclass
class CliDocker:
    """The real Docker CLI. Every command is an argv list; nothing goes through a shell."""

    project: str
    files: list[str] = field(default_factory=list)
    project_directory: str | None = None
    run: Callable[..., subprocess.CompletedProcess] = subprocess.run

    def _compose(self, *args: str, override: str | None = None) -> list[str]:
        cmd = ["docker", "compose", "--project-name", self.project]
        if self.project_directory:
            cmd += ["--project-directory", self.project_directory]
        for name in self.files:
            cmd += ["--file", name]
        if override:
            if not self.files:
                raise Refused("an explicit --file is required so the override layers on the right project")
            cmd += ["--file", override]
        return [*cmd, *args]

    def _call(self, cmd: list[str], timeout: int = 120) -> subprocess.CompletedProcess:
        return self.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)

    def services(self) -> dict[str, dict[str, Any]]:
        result = self._call(self._compose("config", "--format", "json"))
        if result.returncode:
            raise Refused(f"docker compose config failed: {_tail(result.stderr)}")
        data = json.loads(result.stdout)
        out: dict[str, dict[str, Any]] = {}
        for name, spec in (data.get("services") or {}).items():
            if not isinstance(spec, dict):
                continue
            health = spec.get("healthcheck")
            declared: bool | None = None
            if isinstance(health, dict):
                if health.get("disable"):
                    declared = False
                elif "test" in health:
                    declared = _healthcheck_enabled(health["test"])
                # else: timing only; the test comes from the image
            out[str(name)] = {"image": spec.get("image"), "healthcheck": declared}
        return out

    def container_id(self, service: str) -> str | None:
        result = self._call(self._compose("ps", "--all", "--quiet", "--", service))
        if result.returncode:
            return None
        ids = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        return ids[0] if len(ids) == 1 else None

    def inspect_container(self, container_id: str) -> dict[str, Any]:
        result = self._call(["docker", "container", "inspect", "--", container_id])
        if result.returncode:
            return {"status": "missing", "running": False}
        record = json.loads(result.stdout)[0]
        state = record.get("State") or {}
        health = state.get("Health") or {}
        return {
            "image_id": record.get("Image"),
            "image_ref": (record.get("Config") or {}).get("Image"),
            "status": state.get("Status"),
            "running": state.get("Running") is True,
            "health": health.get("Status"),
            "restart_count": record.get("RestartCount", 0),
        }

    def pull(self, image: str) -> None:
        result = self._call(["docker", "image", "pull", "--quiet", "--", image], timeout=1800)
        if result.returncode:
            raise RuntimeError(f"docker pull failed: {_tail(result.stderr)}")

    def _image(self, image: str) -> dict[str, Any] | None:
        result = self._call(["docker", "image", "inspect", "--", image], timeout=60)
        if result.returncode:
            return None
        return json.loads(result.stdout)[0]

    def image_id(self, image: str) -> str | None:
        record = self._image(image)
        return record.get("Id") if record else None

    def image_has_healthcheck(self, image: str) -> bool:
        record = self._image(image) or {}
        health = (record.get("Config") or {}).get("Healthcheck") or {}
        return _healthcheck_enabled(health.get("Test"))

    def repo_digests(self, image_id: str) -> list[str]:
        record = self._image(image_id) or {}
        return list(record.get("RepoDigests") or [])

    def recreate(self, service: str, image: str) -> tuple[int, str]:
        # JSON is valid YAML, so the override needs no YAML library. It names
        # only this service's image; every other setting comes from the
        # operator's own files.
        override = {"services": {service: {"image": image}}}
        with tempfile.TemporaryDirectory(prefix="switchroom-rollout.") as directory:
            path = Path(directory) / "override.json"
            path.write_text(json.dumps(override), encoding="utf-8")
            cmd = self._compose(
                "up", "--detach", "--no-deps", "--force-recreate", "--pull", "never", "--", service,
                override=str(path),
            )
            result = self._call(cmd, timeout=600)
        return result.returncode, _tail(result.stderr)


# ------------------------------------------------------------------------ plan


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def validate_service(name: str) -> str:
    if not SERVICE_RE.fullmatch(name):
        raise Refused(f"invalid service name: {name!r}")
    return name


def repository(reference: str) -> str:
    """Repository part of an image reference, without tag or digest."""
    base = reference.split("@", 1)[0]
    last = base.rsplit("/", 1)[-1]
    if ":" in last:
        base = base[: len(base) - len(last)] + last.split(":", 1)[0]
    return base


@dataclass
class Plan:
    image: str
    order: list[str]
    controller: str | None
    current: dict[str, dict[str, Any]]
    skipped: dict[str, str]


def build_plan(docker: Docker, image: str, *, services: list[str] | None, controller: str | None) -> Plan:
    """Validate inputs and choose the order. Read-only."""
    try:
        require_digest_reference(image)
    except ValueError as exc:
        raise Refused(f"target image must be digest-pinned: {exc}") from None
    rendered = docker.services()
    if services:
        for name in services:
            validate_service(name)
        unknown = sorted(set(services) - set(rendered))
        if unknown:
            raise Refused(f"unknown service(s): {', '.join(unknown)}")
        selected = sorted(set(services))
    else:
        target_repo = repository(image)
        selected = sorted(
            name for name, spec in rendered.items()
            if isinstance(spec.get("image"), str) and repository(spec["image"]) == target_repo
        )
    for name in selected:
        validate_service(name)
    if controller is not None:
        validate_service(controller)
        if controller not in selected:
            raise Refused(f"controller {controller!r} is not one of the selected services")
    if not selected:
        raise Refused("no agent services selected; pass --service or use an image from the same repository")

    current: dict[str, dict[str, Any]] = {}
    skipped: dict[str, str] = {}
    for name in selected:
        container = docker.container_id(name)
        state = docker.inspect_container(container) if container else {"status": "missing", "running": False}
        if not state.get("running"):
            skipped[name] = f"not running ({state.get('status')})"
            continue
        current[name] = {"container_id": container, **state}
    order = [name for name in selected if name in current and name != controller]
    if controller in current:
        order.append(controller)
    return Plan(image=image, order=order, controller=controller, current=current, skipped=skipped)


def require_healthchecks(docker: Docker, plan: Plan) -> None:
    """A rollout needs a health signal; refuse rather than guess."""
    rendered = docker.services()
    image_health = docker.image_has_healthcheck(plan.image)
    missing = [
        name for name in plan.order
        if rendered.get(name, {}).get("healthcheck") is False
        or (rendered.get(name, {}).get("healthcheck") is None and not image_health)
    ]
    if missing:
        raise Refused("no container healthcheck for: " + ", ".join(missing)
                      + " (declare one in Compose or in the image)")


def previous_reference(docker: Docker, state: dict[str, Any], target: str) -> str:
    """The most exact reference for what the container runs now.

    Prefer a repository digest of the running image ID from the target's
    repository; otherwise the image ID itself, which Compose accepts and which
    cannot move.
    """
    image_id = state.get("image_id") or ""
    target_repo = repository(target)
    for candidate in docker.repo_digests(image_id) if image_id else []:
        if repository(candidate) == target_repo:
            return candidate
    reference = state.get("image_ref") or ""
    if "@sha256:" in reference:
        return reference
    return image_id or reference


# ---------------------------------------------------------------------- health


@dataclass
class Clock:
    monotonic: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep


def wait_healthy(docker: Docker, service: str, image_id: str, timeout: float, poll: float,
                 clock: Clock) -> dict[str, Any]:
    started = clock.monotonic()
    deadline = started + timeout
    reason = "not checked"
    last: dict[str, Any] = {}
    while True:
        container = docker.container_id(service)
        last = docker.inspect_container(container) if container else {"status": "missing", "running": False}
        status, health = last.get("status"), last.get("health")
        if container is None:
            reason = "no container"
        elif last.get("image_id") != image_id:
            reason = "container is not on the expected image"
        elif status in ("exited", "dead"):
            return {"ok": False, "reason": f"container {status}", "container": last,
                    "seconds": round(clock.monotonic() - started, 3)}
        elif not last.get("running"):
            reason = f"container {status}"
        elif health is None:
            return {"ok": False, "reason": "container has no healthcheck", "container": last,
                    "seconds": round(clock.monotonic() - started, 3)}
        elif health == "unhealthy":
            return {"ok": False, "reason": "healthcheck reported unhealthy", "container": last,
                    "seconds": round(clock.monotonic() - started, 3)}
        elif health == "healthy":
            return {"ok": True, "container": last, "seconds": round(clock.monotonic() - started, 3)}
        else:
            reason = f"health {health}"
        if clock.monotonic() >= deadline:
            return {"ok": False, "reason": f"not healthy after {timeout:g}s: {reason}", "container": last,
                    "seconds": round(clock.monotonic() - started, 3)}
        clock.sleep(poll)


# --------------------------------------------------------------------- rollout


def recreate_and_wait(docker: Docker, service: str, image: str, image_id: str, timeout: float,
                      poll: float, clock: Clock) -> dict[str, Any]:
    record: dict[str, Any] = {"image": image, "image_id": image_id, "started_at": now()}
    try:
        code, stderr = docker.recreate(service, image)
    except Exception as exc:  # noqa: BLE001 - a failed recreate must still be rolled back
        code, stderr = -1, f"{type(exc).__name__}: {exc}"
    record["compose_exit"] = code
    if code:
        record.update(ok=False, reason=f"compose up failed: {stderr}")
    else:
        record.update(wait_healthy(docker, service, image_id, timeout, poll, clock))
    record["finished_at"] = now()
    return record


def rollout(docker: Docker, plan: Plan, *, timeout: float, poll: float, pull: bool,
            clock: Clock | None = None, log: Callable[[str], None] = print) -> dict[str, Any]:
    clock = clock or Clock()
    report: dict[str, Any] = {
        "schema": SCHEMA,
        "status": "running",
        "image": plan.image,
        "controller": plan.controller,
        "order": plan.order,
        "skipped": plan.skipped,
        "started_at": now(),
        "agents": {},
    }
    if pull:
        log(f"pulling {plan.image}")
        docker.pull(plan.image)
    target_id = docker.image_id(plan.image)
    if not target_id:
        raise Refused(f"target image is not available locally: {plan.image}")
    report["image_id"] = target_id
    require_healthchecks(docker, plan)

    previous = {name: {"image": previous_reference(docker, plan.current[name], plan.image),
                       "image_id": plan.current[name].get("image_id")} for name in plan.order}
    report["previous_images"] = previous

    for index, name in enumerate(plan.order, 1):
        if previous[name]["image_id"] == target_id:
            report["agents"][name] = {"ok": True, "already_current": True}
            log(f"{name}: already on target ({index}/{len(plan.order)})")
            continue
        log(f"{name}: recreating ({index}/{len(plan.order)})")
        record = recreate_and_wait(docker, name, plan.image, target_id, timeout, poll, clock)
        report["agents"][name] = record
        if record.get("ok"):
            log(f"{name}: healthy")
            continue
        log(f"{name}: FAILED: {record.get('reason')}; rolling back to {previous[name]['image']}")
        back = previous[name]
        if not back["image"] or not back["image_id"]:
            record["rollback"] = {"ok": False, "reason": "previous image unknown; nothing to roll back to"}
        else:
            record["rollback"] = recreate_and_wait(docker, name, back["image"], back["image_id"],
                                                   timeout, poll, clock)
        rolled = record["rollback"].get("ok")
        log(f"{name}: " + ("rolled back" if rolled else f"rollback FAILED: {record['rollback'].get('reason')}"))
        report.update(status="failed", failed_agent=name, failure_reason=record.get("reason"),
                      rolled_back=bool(rolled),
                      not_started=plan.order[index:], finished_at=now())
        return report
    report.update(status="passed", finished_at=now())
    return report


def write_report(report: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def print_plan(plan: Plan, out: Callable[[str], None] = print) -> None:
    out(f"image:      {plan.image}")
    out(f"controller: {plan.controller or '(none)'}")
    out(f"order:      {' -> '.join(plan.order) or '(nothing to roll)'}")
    for name in plan.order:
        out(f"  {name}: {plan.current[name].get('image_ref') or plan.current[name].get('image_id')} -> {plan.image}")
    for name, why in plan.skipped.items():
        out(f"  skip {name}: {why}")


# ------------------------------------------------------------------------- cli


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Roll Compose agents onto one digest-pinned image, controller last.")
    parser.add_argument("--project", required=True, help="Compose project name")
    parser.add_argument("--file", "-f", action="append", default=[], dest="files",
                        help="Compose file (repeatable, in the same order you pass them to compose)")
    parser.add_argument("--project-directory", help="Compose project directory")
    parser.add_argument("--image", required=True, help="target image, must end in @sha256:<64 hex>")
    parser.add_argument("--service", action="append", dest="services",
                        help="agent service to roll (repeatable); default: services already using the "
                             "target image's repository")
    parser.add_argument("--controller", help="service that rolls last, e.g. the agent that requested the rollout")
    parser.add_argument("--timeout", type=float, default=300.0, help="seconds to wait for healthy (default 300)")
    parser.add_argument("--poll", type=float, default=5.0, help="seconds between health checks (default 5)")
    parser.add_argument("--no-pull", action="store_true", help="the target image is already local")
    parser.add_argument("--report", type=Path, help="JSON report path (default ./switchroom-rollout-<project>-<utc>.json)")
    parser.add_argument("--dry-run", action="store_true", help="inspect and print the plan; change nothing")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None, docker: Docker | None = None, clock: Clock | None = None) -> int:
    args = parse_args(argv)
    try:
        if not PROJECT_RE.fullmatch(args.project):
            raise Refused(f"invalid project name: {args.project!r}")
        docker = docker or CliDocker(args.project, list(args.files), args.project_directory)
        plan = build_plan(docker, args.image, services=args.services, controller=args.controller)
        if args.dry_run:
            print_plan(plan)
            return EXIT_OK
        if not plan.order:
            raise Refused("nothing to roll: no selected agent is running")
        if not args.files and isinstance(docker, CliDocker):
            raise Refused("pass every Compose file with --file so the per-service override layers on them")
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        report_path = args.report or Path(f"switchroom-rollout-{args.project}-{stamp}.json")
        lock_path = report_path.parent / f".switchroom-rollout-{args.project}.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with open(lock_path, "w", encoding="utf-8") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                raise Refused("another rollout for this project is running") from None
            try:
                report = rollout(docker, plan, timeout=args.timeout, poll=args.poll,
                                 pull=not args.no_pull, clock=clock)
            except Refused:
                raise
            except Exception as exc:  # noqa: BLE001 - always leave a report
                report = {"schema": SCHEMA, "status": "aborted", "image": plan.image,
                          "order": plan.order, "failure_reason": f"{type(exc).__name__}: {exc}",
                          "finished_at": now()}
            write_report(report, report_path)
        print(f"rollout {report['status']}; report: {report_path}")
        return EXIT_OK if report["status"] == "passed" else EXIT_FAILED
    except Refused as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return EXIT_REFUSED


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
