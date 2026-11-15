"""Rollout runner behaviour, proven against a fake Docker. No container is started."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("switchroom_rollout", ROOT / "scripts/switchroom-rollout.py")
rollout = importlib.util.module_from_spec(SPEC)
sys.modules["switchroom_rollout"] = rollout
SPEC.loader.exec_module(rollout)

REPO = "ghcr.io/example/agent"
OLD = f"{REPO}@sha256:{'a' * 64}"
NEW = f"{REPO}@sha256:{'b' * 64}"
OLD_ID = "sha256:" + "1" * 64
NEW_ID = "sha256:" + "2" * 64
SIDECAR = f"ghcr.io/example/sidecar@sha256:{'c' * 64}"


class FakeClock:
    def __init__(self):
        self.t = 0.0

    def monotonic(self):
        return self.t

    def sleep(self, seconds):
        self.t += seconds
        if self.t > 3600:
            raise AssertionError("health wait ignored its timeout")


class FakeDocker:
    """In-memory Compose project. Records every call in ``events``."""

    def __init__(self, agents=("alpha", "bravo", "charlie"), *, image_health=True, sidecar=True):
        self.events: list[tuple] = []
        self.images = {OLD: OLD_ID, NEW: NEW_ID, OLD_ID: OLD_ID, NEW_ID: NEW_ID}
        self.digests = {OLD_ID: [OLD], NEW_ID: [NEW]}
        self.image_health = image_health
        self.compose = {name: {"image": OLD, "healthcheck": None} for name in agents}
        if sidecar:
            self.compose["sidecar"] = {"image": SIDECAR, "healthcheck": True}
        self.containers = {name: self._container(name, OLD_ID, OLD, "healthy") for name in agents}
        self.health: dict[tuple[str, str], list[str]] = {}
        self.fail_recreate: set[tuple[str, str]] = set()
        self.exit_after_recreate: set[tuple[str, str]] = set()
        # (service, image_id) -> exception raised when a recreated container on it is inspected
        self.raise_on_inspect: dict[tuple[str, str], BaseException] = {}
        # (service, image) -> exception raised by that recreate
        self.raise_on_recreate: dict[tuple[str, str], BaseException] = {}
        self.serial = 0

    @staticmethod
    def _container(name, image_id, ref, health, status="running"):
        return {"id": f"{name}-0", "image_id": image_id, "image_ref": ref, "status": status,
                "running": status == "running", "health": health, "restart_count": 0, "polls": []}

    # Docker interface -------------------------------------------------------
    def services(self):
        return {k: dict(v) for k, v in self.compose.items()}

    def container_id(self, service):
        container = self.containers.get(service)
        return container["id"] if container else None

    def inspect_container(self, container_id):
        for name, container in self.containers.items():
            if container["id"] == container_id:
                self.events.append(("inspect", name))
                failure = self.raise_on_inspect.get((name, container["image_id"]))
                if failure is not None and container["id"] != f"{name}-0":  # recreated containers only
                    raise failure
                if container["polls"]:
                    container["health"] = container["polls"].pop(0) if len(container["polls"]) > 1 else container["polls"][0]
                return {k: container[k] for k in ("image_id", "image_ref", "status", "running", "health", "restart_count")}
        return {"status": "missing", "running": False}

    def pull(self, image):
        self.events.append(("pull", image))

    def image_id(self, image):
        return self.images.get(image)

    def image_has_healthcheck(self, image):
        return self.image_health

    def repo_digests(self, image_id):
        return list(self.digests.get(image_id, []))

    def recreate(self, service, image):
        self.events.append(("recreate", service, image))
        if (service, image) in self.raise_on_recreate:
            raise self.raise_on_recreate[(service, image)]
        if (service, image) in self.fail_recreate:
            return 1, "simulated compose failure"
        self.serial += 1
        image_id = self.images[image]
        status = "exited" if (service, image) in self.exit_after_recreate else "running"
        container = self._container(service, image_id, image, None, status)
        container["id"] = f"{service}-{self.serial}"
        container["polls"] = list(self.health.get((service, image_id), ["starting", "healthy"]))
        self.containers[service] = container
        return 0, ""

    # helpers ---------------------------------------------------------------
    def recreated(self):
        return [(event[1], event[2]) for event in self.events if event[0] == "recreate"]


def run_main(docker, *argv, clock=None):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = rollout.main(["--project", "demo", "--image", NEW, "--poll", "1", *argv],
                            docker=docker, clock=clock or FakeClock())
    return code, out.getvalue(), err.getvalue()


class DigestRefusalTests(unittest.TestCase):
    def test_mutable_or_malformed_references_are_refused_before_any_effect(self):
        for image in (f"{REPO}:latest", REPO, f"{REPO}@sha256:{'b' * 63}",
                      f"{REPO}@sha256:{'B' * 64}", f"{REPO}@sha512:{'b' * 64}", "", f"--rm@sha256:{'b' * 64}"):
            with self.subTest(image=image):
                docker = FakeDocker()
                with tempfile.TemporaryDirectory() as tmp:
                    out, err = io.StringIO(), io.StringIO()
                    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                        code = rollout.main(["--project", "demo", f"--image={image}",
                                             "--report", f"{tmp}/r.json"], docker=docker, clock=FakeClock())
                    self.assertEqual(code, rollout.EXIT_REFUSED)
                    self.assertIn("digest-pinned", err.getvalue())
                    self.assertEqual(docker.events, [])
                    self.assertFalse(Path(tmp, "r.json").exists())

    def test_tag_plus_digest_is_accepted(self):
        docker = FakeDocker()
        plan = rollout.build_plan(docker, f"{REPO}:v1@sha256:{'b' * 64}", services=None, controller=None)
        self.assertEqual(plan.order, ["alpha", "bravo", "charlie"])


class OrderingTests(unittest.TestCase):
    def test_agents_are_sorted_and_the_controller_goes_last(self):
        docker = FakeDocker(agents=("delta", "aaa-controller", "bravo", "alpha"))
        plan = rollout.build_plan(docker, NEW, services=None, controller="aaa-controller")
        self.assertEqual(plan.order, ["alpha", "bravo", "delta", "aaa-controller"])

    def test_default_selection_is_the_target_repository_only(self):
        plan = rollout.build_plan(FakeDocker(), NEW, services=None, controller=None)
        self.assertNotIn("sidecar", plan.order)

    def test_explicit_services_and_unknown_service(self):
        docker = FakeDocker()
        plan = rollout.build_plan(docker, NEW, services=["charlie", "alpha"], controller="charlie")
        self.assertEqual(plan.order, ["alpha", "charlie"])
        with self.assertRaises(rollout.Refused):
            rollout.build_plan(docker, NEW, services=["nope"], controller=None)

    def test_controller_must_be_selected_and_names_are_validated(self):
        with self.assertRaises(rollout.Refused):
            rollout.build_plan(FakeDocker(), NEW, services=None, controller="sidecar")
        with self.assertRaises(rollout.Refused):
            rollout.build_plan(FakeDocker(), NEW, services=["--remove-orphans"], controller=None)

    def test_stopped_agents_are_skipped_not_started(self):
        docker = FakeDocker()
        docker.containers["bravo"].update(status="exited", running=False)
        del docker.containers["charlie"]
        code, _, _ = self._roll(docker)
        self.assertEqual(code, rollout.EXIT_OK)
        self.assertEqual(docker.recreated(), [("alpha", NEW)])
        report = self.report
        self.assertEqual(set(report["skipped"]), {"bravo", "charlie"})

    def test_one_agent_at_a_time(self):
        docker = FakeDocker()
        code, _, _ = self._roll(docker, "--controller", "alpha")
        self.assertEqual(code, rollout.EXIT_OK)
        self.assertEqual([s for s, _ in docker.recreated()], ["bravo", "charlie", "alpha"])
        # Each agent is healthy (inspected after its recreate) before the next one is recreated.
        first = next(i for i, e in enumerate(docker.events) if e[0] == "recreate")
        segments: list[list[tuple]] = []
        for event in docker.events[first:]:
            if event[0] == "recreate":
                segments.append([])
            segments[-1].append(event)
        for segment in segments:
            name = segment[0][1]
            self.assertEqual({e[1] for e in segment}, {name})
            self.assertEqual(segment[-1][0], "inspect")  # its final health poll

    def _roll(self, docker, *argv):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_main(docker, "--report", f"{tmp}/r.json", *argv)
            self.report = json.loads(Path(tmp, "r.json").read_text())
        return result


class HealthAndRollbackTests(unittest.TestCase):
    def roll(self, docker, *argv, clock=None):
        with tempfile.TemporaryDirectory() as tmp:
            code, out, err = run_main(docker, "--report", f"{tmp}/r.json", *argv, clock=clock)
            report = json.loads(Path(tmp, "r.json").read_text())
        return code, report

    def test_success_report(self):
        docker = FakeDocker()
        code, report = self.roll(docker, "--controller", "charlie")
        self.assertEqual(code, rollout.EXIT_OK)
        self.assertEqual(report["schema"], "switchroom-rollout/1")
        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["image_id"], NEW_ID)
        self.assertEqual(report["previous_images"]["alpha"], {"image": OLD, "image_id": OLD_ID})
        self.assertTrue(all(report["agents"][n]["ok"] for n in ("alpha", "bravo", "charlie")))
        self.assertIn(("pull", NEW), docker.events)

    def test_health_timeout_fails_and_rolls_back(self):
        docker = FakeDocker()
        docker.health[("bravo", NEW_ID)] = ["starting"]
        clock = FakeClock()
        code, report = self.roll(docker, "--timeout", "30", clock=clock)
        self.assertEqual(code, rollout.EXIT_FAILED)
        bravo = report["agents"]["bravo"]
        self.assertFalse(bravo["ok"])
        self.assertIn("not healthy after 30s", bravo["reason"])
        self.assertGreaterEqual(bravo["seconds"], 30)
        self.assertTrue(bravo["rollback"]["ok"])

    def test_failed_agent_is_recreated_on_its_recorded_previous_image(self):
        docker = FakeDocker()
        docker.health[("bravo", NEW_ID)] = ["starting", "unhealthy"]
        code, report = self.roll(docker)
        self.assertEqual(code, rollout.EXIT_FAILED)
        self.assertEqual(docker.recreated(), [("alpha", NEW), ("bravo", NEW), ("bravo", OLD)])
        self.assertEqual(docker.containers["bravo"]["image_id"], OLD_ID)
        self.assertEqual(report["failed_agent"], "bravo")
        self.assertTrue(report["rolled_back"])
        self.assertEqual(report["agents"]["bravo"]["rollback"]["image"], OLD)

    def test_previous_image_falls_back_to_the_immutable_image_id(self):
        docker = FakeDocker()
        docker.digests[OLD_ID] = []
        docker.containers["alpha"]["image_ref"] = f"{REPO}:stable"
        docker.health[("alpha", NEW_ID)] = ["unhealthy"]
        code, report = self.roll(docker)
        self.assertEqual(code, rollout.EXIT_FAILED)
        self.assertEqual(docker.recreated()[-1], ("alpha", OLD_ID))
        self.assertTrue(report["rolled_back"])

    def test_rollout_stops_after_a_failure(self):
        docker = FakeDocker()
        docker.exit_after_recreate.add(("bravo", NEW))
        code, report = self.roll(docker, "--controller", "alpha")
        self.assertEqual(code, rollout.EXIT_FAILED)
        self.assertEqual([s for s, _ in docker.recreated()], ["bravo", "bravo"])
        self.assertEqual(report["not_started"], ["charlie", "alpha"])
        self.assertNotIn("charlie", report["agents"])
        self.assertEqual(docker.containers["alpha"]["image_id"], OLD_ID)

    def test_controller_is_never_touched_when_another_agent_fails(self):
        docker = FakeDocker()
        docker.health[("charlie", NEW_ID)] = ["unhealthy"]
        code, report = self.roll(docker, "--controller", "alpha")
        self.assertEqual(code, rollout.EXIT_FAILED)
        self.assertNotIn("alpha", [s for s, _ in docker.recreated()])
        self.assertEqual(report["not_started"], ["alpha"])

    def test_compose_failure_is_rolled_back(self):
        docker = FakeDocker()
        docker.fail_recreate.add(("alpha", NEW))
        code, report = self.roll(docker)
        self.assertEqual(code, rollout.EXIT_FAILED)
        self.assertIn("compose up failed", report["agents"]["alpha"]["reason"])
        self.assertEqual(docker.recreated(), [("alpha", NEW), ("alpha", OLD)])

    def test_failed_rollback_is_reported(self):
        docker = FakeDocker()
        docker.health[("alpha", NEW_ID)] = ["unhealthy"]
        docker.health[("alpha", OLD_ID)] = ["unhealthy"]
        code, report = self.roll(docker)
        self.assertEqual(code, rollout.EXIT_FAILED)
        self.assertFalse(report["rolled_back"])
        self.assertFalse(report["agents"]["alpha"]["rollback"]["ok"])

    def test_docker_error_during_health_wait_is_rolled_back(self):
        # e.g. `docker container inspect` timing out right after bravo moved to NEW.
        for failure in (subprocess.TimeoutExpired(["docker", "container", "inspect"], 30),
                        json.JSONDecodeError("Expecting value", "", 0)):
            with self.subTest(failure=type(failure).__name__):
                docker = FakeDocker()
                docker.raise_on_inspect[("bravo", NEW_ID)] = failure
                code, report = self.roll(docker, "--controller", "alpha")
                self.assertEqual(code, rollout.EXIT_FAILED)
                self.assertEqual(report["status"], "failed")
                self.assertEqual(docker.recreated(), [("bravo", NEW), ("bravo", OLD)])
                self.assertEqual(docker.containers["bravo"]["image_id"], OLD_ID)
                self.assertEqual(docker.containers["alpha"]["image_id"], OLD_ID)
                self.assertEqual(docker.containers["charlie"]["image_id"], OLD_ID)
                self.assertEqual(report["failed_agent"], "bravo")
                self.assertTrue(report["rolled_back"])
                self.assertIn("health wait failed", report["agents"]["bravo"]["reason"])
                self.assertTrue(report["agents"]["bravo"]["rollback"]["ok"])
                self.assertEqual(report["not_started"], ["charlie", "alpha"])
                self.assertNotIn("in_flight", report)

    def test_docker_error_during_rollback_is_reported_not_restored(self):
        for where in ("wait", "recreate"):
            with self.subTest(where=where):
                docker = FakeDocker()
                docker.raise_on_inspect[("alpha", NEW_ID)] = subprocess.TimeoutExpired(["docker"], 30)
                if where == "wait":
                    docker.raise_on_inspect[("alpha", OLD_ID)] = subprocess.TimeoutExpired(["docker"], 30)
                else:
                    docker.raise_on_recreate[("alpha", OLD)] = subprocess.TimeoutExpired(["docker"], 600)
                code, report = self.roll(docker, "--controller", "charlie")
                self.assertEqual(code, rollout.EXIT_FAILED)
                self.assertEqual(report["status"], "failed")
                self.assertFalse(report["rolled_back"])
                self.assertFalse(report["agents"]["alpha"]["rollback"]["ok"])
                self.assertEqual(report["not_started"], ["bravo", "charlie"])
                self.assertEqual([s for s, _ in docker.recreated()], ["alpha", "alpha"])
                self.assertEqual(report["previous_images"]["alpha"], {"image": OLD, "image_id": OLD_ID})

    def test_unexpected_error_mid_rollout_keeps_restore_information(self):
        docker = FakeDocker()
        real = rollout.recreate_and_wait

        def explode(docker_, service, *args, **kwargs):
            if service == "bravo":
                raise RuntimeError("bug")
            return real(docker_, service, *args, **kwargs)

        with mock.patch.object(rollout, "recreate_and_wait", explode):
            code, report = self.roll(docker)
        self.assertEqual(code, rollout.EXIT_FAILED)
        self.assertEqual(report["status"], "aborted")
        self.assertEqual(report["in_flight"], "bravo")
        self.assertEqual(report["previous_images"]["bravo"], {"image": OLD, "image_id": OLD_ID})
        self.assertTrue(report["agents"]["alpha"]["ok"])
        self.assertIn("RuntimeError: bug", report["failure_reason"])

    def test_missing_healthcheck_is_refused_before_any_recreate(self):
        docker = FakeDocker(image_health=False)
        with tempfile.TemporaryDirectory() as tmp:
            code, _, err = run_main(docker, "--report", f"{tmp}/r.json")
        self.assertEqual(code, rollout.EXIT_REFUSED)
        self.assertIn("no container healthcheck", err)
        self.assertEqual(docker.recreated(), [])
        docker.compose["alpha"]["healthcheck"] = True
        docker.compose["bravo"]["healthcheck"] = True
        docker.compose["charlie"]["healthcheck"] = False
        with self.assertRaises(rollout.Refused):
            rollout.require_healthchecks(docker, rollout.build_plan(docker, NEW, services=None, controller=None))

    def test_agent_already_on_target_is_not_recreated(self):
        docker = FakeDocker()
        docker.containers["alpha"].update(image_id=NEW_ID, image_ref=NEW)
        code, report = self.roll(docker)
        self.assertEqual(code, rollout.EXIT_OK)
        self.assertTrue(report["agents"]["alpha"]["already_current"])
        self.assertNotIn("alpha", [s for s, _ in docker.recreated()])


class DryRunTests(unittest.TestCase):
    def test_dry_run_prints_the_plan_and_changes_nothing(self):
        docker = FakeDocker()
        with tempfile.TemporaryDirectory() as tmp:
            code, out, _ = run_main(docker, "--dry-run", "--controller", "alpha", "--report", f"{tmp}/r.json")
            self.assertEqual(list(Path(tmp).iterdir()), [])
        self.assertEqual(code, rollout.EXIT_OK)
        self.assertIn("order:      bravo -> charlie -> alpha", out)
        self.assertEqual({e[0] for e in docker.events}, {"inspect"})

    def test_dry_run_still_refuses_a_mutable_image(self):
        docker = FakeDocker()
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = rollout.main(["--project", "demo", "--image", f"{REPO}:latest", "--dry-run"], docker=docker)
        self.assertEqual(code, rollout.EXIT_REFUSED)
        self.assertEqual(out.getvalue(), "")


class CliDockerCommandTests(unittest.TestCase):
    """The real adapter's argv, captured without executing anything."""

    FORBIDDEN = {"down", "rm", "-v", "--volumes", "--remove-orphans", "volume", "secret", "prune", "kill"}

    def make(self, outputs):
        calls = []

        def run(cmd, **kwargs):
            calls.append((cmd, kwargs))
            if cmd[:3] == ["docker", "compose", "--project-name"] and "up" in cmd:
                override = cmd[cmd.index("up") - 1]
                calls[-1] = (cmd, {**kwargs, "override": json.loads(Path(override).read_text())})
            key = next((k for k in outputs if k in cmd), None)
            return subprocess.CompletedProcess(cmd, 0, outputs.get(key, ""), "")

        return rollout.CliDocker("demo", ["compose.yaml"], run=run), calls

    def test_commands_are_argv_lists_and_never_touch_volumes_or_secrets(self):
        config = json.dumps({"services": {
            "alpha": {"image": OLD, "healthcheck": {"test": ["CMD", "true"]}},
            "bravo": {"image": OLD, "healthcheck": {"disable": True}},
            "charlie": {"image": OLD, "healthcheck": {"interval": "5s"}},
            "delta": {"image": OLD},
        }})
        inspect = json.dumps([{"Image": OLD_ID, "Config": {"Image": OLD},
                               "State": {"Status": "running", "Running": True, "Health": {"Status": "healthy"}}}])
        docker, calls = self.make({"config": config, "ps": "abc123\n", "container": inspect})
        services = docker.services()
        self.assertEqual({k: v["healthcheck"] for k, v in services.items()},
                         {"alpha": True, "bravo": False, "charlie": None, "delta": None})
        self.assertEqual(docker.container_id("alpha"), "abc123")
        self.assertEqual(docker.inspect_container("abc123")["health"], "healthy")
        docker.pull(NEW)
        code, _ = docker.recreate("alpha", NEW)
        self.assertEqual(code, 0)
        for cmd, kwargs in calls:
            self.assertIsInstance(cmd, list)
            self.assertNotIn("shell", kwargs)
            self.assertFalse(self.FORBIDDEN.intersection(cmd), cmd)
            if cmd[1] == "compose":
                self.assertEqual(cmd[:4], ["docker", "compose", "--project-name", "demo"])
        up_cmd, up_kwargs = calls[-1]
        self.assertEqual(up_cmd[-8:], ["up", "--detach", "--no-deps", "--force-recreate",
                                       "--pull", "never", "--", "alpha"])
        self.assertEqual(up_cmd[up_cmd.index("--file") + 1], "compose.yaml")
        self.assertEqual(up_kwargs["override"], {"services": {"alpha": {"image": NEW}}})

    def test_override_requires_explicit_files(self):
        docker = rollout.CliDocker("demo", [], run=lambda *a, **k: None)
        with self.assertRaises(rollout.Refused):
            docker._compose("up", override="x.json")


class RepositoryTests(unittest.TestCase):
    def test_repository_strips_tag_and_digest_but_not_registry_port(self):
        self.assertEqual(rollout.repository(NEW), REPO)
        self.assertEqual(rollout.repository(f"{REPO}:v1"), REPO)
        self.assertEqual(rollout.repository("registry.local:5000/x/agent:v1@sha256:" + "b" * 64),
                         "registry.local:5000/x/agent")


if __name__ == "__main__":
    unittest.main()
