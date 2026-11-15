"""Host monitors: ownership audit/repair, memory pressure alert, storage monitor, alert sink.

Everything runs on synthetic directories under a temp dir. Nothing touches the
host's own agents, and no test needs root: owner repairs are recorded through a
stand-in for ``os.chown`` when the suite is not root.
"""
from __future__ import annotations

import ast
import contextlib
import importlib.util
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
KIT = ROOT / "examples" / "overlay-repo" / "ops-kit"


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


alerts = _load("switchroom_alerts", "switchroom_alerts.py")
own = _load("switchroom_ownership_audit", "switchroom-ownership-audit.py")
mem = _load("switchroom_memory_alert", "switchroom-memory-alert.py")
sto = _load("switchroom_storage_monitor", "switchroom-storage-monitor.py")

UID, GID = os.getuid(), os.getgid()
OTHER = UID + 4242  # an owner the synthetic files do not have


def _snapshot(root: Path) -> dict[str, tuple[int, int, int, int]]:
    out = {}
    for path in sorted(root.rglob("*")):
        st = path.lstat()
        out[str(path.relative_to(root))] = (st.st_uid, st.st_gid, stat.S_IMODE(st.st_mode), st.st_ino)
    return out


def _calls(module_path: Path) -> set[str]:
    tree = ast.parse(module_path.read_text(encoding="utf-8"))
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute):
            names.add(node.attr)
            if isinstance(node.value, ast.Name):
                names.add(f"{node.value.id}.{node.attr}")
        elif isinstance(node, ast.Name):
            names.add(node.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                names.add(f"import:{alias.name}")
            if isinstance(node, ast.ImportFrom) and node.module:
                names.add(f"import:{node.module}")
    return names


class SinkTests(unittest.TestCase):
    def test_stdout_is_the_default_sink(self) -> None:
        out = io.StringIO()
        sink = alerts.Sink.from_config({}, source="t", stream=out)
        self.assertEqual(sink.kind, "stdout")
        sink.send("hello", kind="x")
        self.assertIn("hello", out.getvalue())

    def test_webhook_reads_the_url_from_the_named_variable_and_never_prints_it(self) -> None:
        posted = []
        url = "https://hooks.example.invalid/secret-path-7f3a"
        sink = alerts.Sink.from_config({"alert": {"sink": "webhook", "url_env": "MY_HOOK"}}, source="t",
                                       environ={"MY_HOOK": url},
                                       post=lambda u, body, timeout: posted.append((u, json.loads(body))) or 204)
        sink.send("disk is full", kind="storage")
        self.assertEqual(posted[0][0], url)
        self.assertEqual(posted[0][1]["text"], "disk is full")
        self.assertEqual(posted[0][1]["kind"], "storage")

        def boom(u, body, timeout):
            raise OSError(f"connection to {u} refused")

        failing = alerts.Sink("webhook", url_env="MY_HOOK", environ={"MY_HOOK": url}, post=boom)
        with self.assertRaises(alerts.DeliveryError) as caught:
            failing.send("x", kind="y")
        self.assertNotIn("secret-path", str(caught.exception))
        status = alerts.Sink("webhook", url_env="MY_HOOK", environ={"MY_HOOK": url}, post=lambda *a: 500)
        with self.assertRaises(alerts.DeliveryError):
            status.send("x", kind="y")

    def test_webhook_refuses_missing_or_plain_http_urls(self) -> None:
        for env in ({}, {"SWITCHROOM_ALERT_WEBHOOK_URL": "http://hooks.example.invalid/x"},
                    {"SWITCHROOM_ALERT_WEBHOOK_URL": "file:///etc/passwd"}):
            sink = alerts.Sink("webhook", environ=env, post=lambda *a: 200)
            with self.subTest(env=env), self.assertRaises(alerts.DeliveryError):
                sink.send("x", kind="y")
        with self.assertRaises(alerts.ConfigError):
            alerts.Sink("telegram")

    def test_no_monitor_hard_codes_a_chat_service(self) -> None:
        for name in ("switchroom_alerts.py", "switchroom-ownership-audit.py", "switchroom-memory-alert.py",
                     "switchroom-storage-monitor.py"):
            text = (SCRIPTS / name).read_text(encoding="utf-8").lower()
            for service in ("api.telegram", "hooks.slack", "discord.com/api", "chat_id", "bot_token"):
                with self.subTest(script=name, service=service):
                    self.assertNotIn(service, text)


class OwnershipTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.state = self.base / "state"
        (self.state / "home").mkdir(parents=True)
        (self.state / "sessions.db").write_text("db")
        (self.state / ".env").write_text("SYNTHETIC=1")
        os.chmod(self.state / ".env", 0o644)
        (self.state / "home" / "notes.md").write_text("n")
        self.outside = self.base / "outside"
        self.outside.mkdir()
        (self.outside / "victim.txt").write_text("v")
        os.chmod(self.outside / "victim.txt", 0o644)
        (self.state / "link-out").symlink_to(self.outside)
        self.config = {
            "agents": {"ops": {"roots": {"state": str(self.state)}}},
            "ownership": {"enabled": True, "uid": UID, "gid": GID, "private_files": [".env", "home/.env"]},
        }

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_audit_reports_exposed_private_files_and_changes_nothing(self) -> None:
        before = _snapshot(self.base)
        with mock.patch.object(own.os, "chown") as chown, mock.patch.object(own.os, "chmod") as chmod, \
                mock.patch.object(own.os, "fchmod") as fchmod:
            report = own.run_audit(self.config)
        chown.assert_not_called(); chmod.assert_not_called(); fchmod.assert_not_called()
        self.assertEqual(_snapshot(self.base), before)
        self.assertEqual(report["mode"], "report-only")
        self.assertEqual(report["status"], "violations")
        self.assertEqual([(v["relative"], v["kind"]) for v in report["violations"]], [(".env", "mode")])
        # The symlink is audited as a link, never followed into the outside directory.
        self.assertFalse(any("victim" in v["relative"] for v in report["violations"]))

    def test_audit_flags_every_wrong_owner_without_following_symlinks(self) -> None:
        self.config["ownership"]["uid"] = OTHER
        report = own.run_audit(self.config)
        owners = {v["relative"] for v in report["violations"] if v["kind"] == "owner"}
        self.assertEqual(owners, {".", ".env", "home", "home/notes.md", "sessions.db", "link-out"})
        self.assertEqual(next(v for v in report["violations"] if v["relative"] == "link-out")["type"], "symlink")

    def test_missing_root_is_incomplete_not_clean(self) -> None:
        self.config["agents"]["ops"]["roots"]["workspace"] = str(self.base / "absent")
        os.chmod(self.state / ".env", 0o600)
        report = own.run_audit(self.config)
        self.assertEqual(report["status"], "incomplete")

    def test_repair_is_a_dry_run_unless_apply_is_given(self) -> None:
        report = own.run_audit(self.config)
        before = _snapshot(self.base)
        result = own.repair(self.config, report, apply=False)
        self.assertEqual(result["mode"], "repair-dry-run")
        self.assertEqual(result["planned"], [{"path": "ops:state:.env", "kind": "mode"}])
        self.assertEqual(_snapshot(self.base), before)

    def test_repair_touches_only_enumerated_paths(self) -> None:
        report = own.run_audit(self.config)
        # Appears after the audit: not enumerated, so repair must leave it alone.
        (self.state / "home" / ".env").write_text("LATE=1")
        os.chmod(self.state / "home" / ".env", 0o644)
        result = own.repair(self.config, report, apply=True)
        self.assertEqual(result["changed"], [{"path": "ops:state:.env", "kind": "mode"}])
        self.assertEqual(stat.S_IMODE((self.state / ".env").stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.state / "home" / ".env").stat().st_mode), 0o644)
        self.assertEqual(stat.S_IMODE((self.outside / "victim.txt").stat().st_mode), 0o644)
        self.assertEqual(result["status"], "complete")

    def test_repair_owner_uses_lchown_semantics_on_enumerated_paths_only(self) -> None:
        self.config["ownership"]["uid"] = OTHER
        report = own.run_audit(self.config)
        enumerated = {v["relative"] for v in report["violations"]}
        (self.state / "late.txt").write_text("late")
        with mock.patch.object(own.os, "chown") as chown:
            result = own.repair(self.config, report, apply=True)
        touched = set()
        for call in chown.call_args_list:
            self.assertEqual(call.args[1:], (OTHER, GID))
            self.assertIs(call.kwargs["follow_symlinks"], False)
            self.assertIsNotNone(call.kwargs["dir_fd"])
            touched.add(call.args[0])
        self.assertNotIn("late.txt", touched)
        # Creating late.txt changed the root directory after the audit, so the root
        # itself is skipped too: repair acts only on paths exactly as the audit saw them.
        self.assertEqual({p["path"].split(":", 2)[2] for p in result["changed"]}, enumerated - {"."})
        self.assertEqual([s["path"] for s in result["skipped"]], ["ops:state:."])

    def test_repair_refuses_replaced_paths_symlinked_parents_and_tampered_reports(self) -> None:
        self.config["ownership"]["private_files"] = [".env", "home/.env"]
        (self.state / "home" / ".env").write_text("H=1")
        os.chmod(self.state / "home" / ".env", 0o644)
        report = own.run_audit(self.config)
        self.assertEqual({v["relative"] for v in report["violations"]}, {".env", "home/.env"})
        # Replace .env with a new inode, and swap home/ for a symlink to a directory
        # holding a group-readable .env. Neither may be changed.
        (self.state / ".env.new").write_text("NEW=1")
        os.chmod(self.state / ".env.new", 0o644)
        os.replace(self.state / ".env.new", self.state / ".env")
        (self.outside / ".env").write_text("O=1")
        os.chmod(self.outside / ".env", 0o644)
        os.rename(self.state / "home", self.base / "old-home")
        (self.state / "home").symlink_to(self.outside)
        tampered = json.loads(json.dumps(report))
        tampered["violations"].append({**report["violations"][0], "relative": "../outside/victim.txt"})
        tampered["violations"].append({**report["violations"][0], "root": "workspace"})
        result = own.repair(self.config, tampered, apply=True)
        self.assertEqual(result["changed"], [])
        self.assertEqual(result["status"], "incomplete")
        reasons = sorted(s["reason"] for s in result["skipped"])
        self.assertIn("path was replaced since the audit", reasons)
        self.assertTrue(any("without following a symlink" in r for r in reasons))
        self.assertIn("path is not a plain relative path", reasons)
        self.assertIn("agent or root is not in the current config", reasons)
        for path in (self.state / ".env", self.outside / ".env", self.outside / "victim.txt"):
            self.assertEqual(stat.S_IMODE(path.lstat().st_mode), 0o644, path)

    def test_a_path_with_owner_and_mode_findings_gets_both_repairs(self) -> None:
        self.config["ownership"]["uid"] = OTHER
        report = own.run_audit(self.config)
        kinds = [v["kind"] for v in report["violations"] if v["relative"] == ".env"]
        self.assertEqual(kinds, ["owner", "mode"])

        def chown_bumps_ctime(name, uid, gid, *, dir_fd, follow_symlinks):
            # A real chown updates ctime; emulate that without needing root.
            if not os.path.islink(os.path.join(f"/proc/self/fd/{dir_fd}", name)):
                os.chmod(name, stat.S_IMODE(os.stat(name, dir_fd=dir_fd).st_mode), dir_fd=dir_fd)

        with mock.patch.object(own.os, "chown", side_effect=chown_bumps_ctime):
            result = own.repair(self.config, report, apply=True)
        self.assertIn({"path": "ops:state:.env", "kind": "mode"}, result["changed"])
        self.assertEqual(stat.S_IMODE((self.state / ".env").stat().st_mode), 0o600)

    def test_repair_refuses_a_report_for_a_different_owner(self) -> None:
        report = own.run_audit(self.config)
        report["expected"]["uid"] = OTHER
        with self.assertRaises(alerts.ConfigError):
            own.repair(self.config, report, apply=True)

    def test_cli_is_disabled_by_default_and_alerts_to_the_sink(self) -> None:
        cfg = self.base / "monitors.json"
        disabled = json.loads(json.dumps(self.config))
        disabled["ownership"].pop("enabled")
        cfg.write_text(json.dumps(disabled))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(own.main(["audit", "--config", str(cfg)]), 3)
        cfg.write_text(json.dumps(self.config))
        report_path = self.base / "reports" / "latest.json"
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(own.main(["audit", "--config", str(cfg), "--report", str(report_path)]), 1)
        self.assertIn("[switchroom-ownership-audit] ownership:", out.getvalue())
        self.assertIn("Nothing was changed", out.getvalue())
        self.assertEqual(stat.S_IMODE(report_path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.state / ".env").stat().st_mode), 0o644)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(own.main(["repair", "--config", str(cfg), "--report", str(report_path)]), 0)
        self.assertEqual(stat.S_IMODE((self.state / ".env").stat().st_mode), 0o644)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(own.main(["repair", "--config", str(cfg), "--report", str(report_path), "--apply"]), 0)
            self.assertEqual(stat.S_IMODE((self.state / ".env").stat().st_mode), 0o600)
            self.assertEqual(own.main(["audit", "--config", str(cfg)]), 0)


class MemoryAlertTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.proc = self.base / "proc"
        (self.proc / "pressure").mkdir(parents=True)
        self.cg = self.base / "cgroup"
        self.cid = "ab" * 32
        self.scope = self.cg / "system.slice" / f"docker-{self.cid}.scope"
        self.scope.mkdir(parents=True)
        (self.scope / "memory.current").write_text(str(3 * mem.GIB))
        (self.scope / "pids.current").write_text("10")
        (self.scope / "pids.max").write_text("100")
        (self.scope / "pids.events").write_text("max 0\n")
        self.containers = self.base / "containers"
        (self.containers / self.cid).mkdir(parents=True)
        (self.containers / self.cid / "config.v2.json").write_text(json.dumps({"Name": "/example-ops-1"}))
        self.cfg = self.base / "monitors.json"
        self.cfg.write_text(json.dumps({"agents": {"ops": {"roots": {"state": str(self.base)}}},
                                        "memory": {"enabled": True, "state_dir": str(self.base / "state")}}))
        self.clock = [1000.0]
        self.set_sample(available_gib=16)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def set_sample(self, *, available_gib: float, full: float = 0.0, some: float = 0.0, swap_used_gib: float = 0) -> None:
        kb = lambda gib: int(gib * 1024 * 1024)  # noqa: E731
        (self.proc / "meminfo").write_text(
            f"MemTotal: {kb(32)} kB\nMemAvailable: {kb(available_gib)} kB\n"
            f"SwapTotal: {kb(8)} kB\nSwapFree: {kb(8 - swap_used_gib)} kB\n")
        (self.proc / "pressure" / "memory").write_text(
            f"some avg10=0.00 avg60={some:.2f} avg300=0.00 total=1\nfull avg10=0.00 avg60={full:.2f} avg300=0.00 total=1\n")

    def run_check(self, sink) -> int:
        with contextlib.redirect_stdout(io.StringIO()):
            return mem.main(["check", "--config", str(self.cfg)], proc=self.proc, cgroup_root=self.cg,
                            containers=self.containers, now=lambda: self.clock[0], sink=sink)

    def test_sustained_pressure_alerts_once_then_recovers(self) -> None:
        sink = alerts.Sink("stdout", stream=io.StringIO())
        self.set_sample(available_gib=1)
        self.assertEqual(self.run_check(sink), 0)
        self.assertEqual(sink.sent, [])  # not yet sustained
        self.clock[0] += 301
        self.run_check(sink)
        self.assertEqual([p["kind"] for p in sink.sent], ["memory"])
        self.assertIn("example-ops-1", sink.sent[0]["text"])
        self.assertIn("Nothing has been restarted", sink.sent[0]["text"])
        self.clock[0] += 600
        self.run_check(sink)
        self.assertEqual(len(sink.sent), 1)  # inside repeat window
        self.set_sample(available_gib=16)
        self.clock[0] += 60
        self.run_check(sink)
        self.assertEqual([p["kind"] for p in sink.sent], ["memory", "memory-recovered"])

    def test_short_spikes_and_swap_alone_stay_silent(self) -> None:
        sink = alerts.Sink("stdout", stream=io.StringIO())
        self.set_sample(available_gib=1)
        self.run_check(sink)
        self.clock[0] += 120
        self.set_sample(available_gib=16, swap_used_gib=7.5)
        self.run_check(sink)
        self.clock[0] += 400
        self.set_sample(available_gib=1)
        self.run_check(sink)
        self.assertEqual(sink.sent, [])

    def test_psi_full_counts_as_pressure(self) -> None:
        opts = mem.settings({"memory": {}})
        self.assertEqual(mem.pressure_reasons({"available": 10 * mem.GIB, "psi_full_avg60": 6.0,
                                               "psi_some_avg60": 0.0}, opts), ["psi_full"])

    def test_pids_alert_once_per_episode_and_on_new_refusals(self) -> None:
        sink = alerts.Sink("stdout", stream=io.StringIO())
        self.run_check(sink)
        (self.scope / "pids.current").write_text("90")
        self.run_check(sink)
        self.run_check(sink)
        self.assertEqual([p["kind"] for p in sink.sent], ["pids"])
        (self.scope / "pids.events").write_text("max 3\n")
        self.run_check(sink)
        self.assertIn("refused", sink.sent[-1]["text"])

    def test_failed_delivery_retries_and_exits_non_zero(self) -> None:
        def down(*args):
            raise OSError("down")
        sink = alerts.Sink("webhook", environ={"SWITCHROOM_ALERT_WEBHOOK_URL": "https://h.example.invalid/x"}, post=down)
        (self.scope / "pids.current").write_text("95")
        self.assertEqual(self.run_check(sink), 1)
        self.assertFalse((self.base / "state" / "pids.json").exists())

    def test_disabled_by_default(self) -> None:
        self.cfg.write_text(json.dumps({"memory": {}}))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(mem.main(["check", "--config", str(self.cfg)], proc=self.proc), 3)

    def test_report_only_by_construction(self) -> None:
        names = _calls(SCRIPTS / "switchroom-memory-alert.py")
        for forbidden in ("import:subprocess", "import:signal", "os.kill", "os.killpg", "os.system", "os.unlink",
                          "os.remove", "shutil.rmtree", "os.execv", "os.execvp"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, names)


class StorageMonitorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.state = self.base / "ops-state"
        (self.state / "home" / ".cache").mkdir(parents=True)
        (self.state / "sessions").mkdir()
        (self.state / "sessions" / "a.db").write_bytes(b"x" * 4000)
        os.link(self.state / "sessions" / "a.db", self.state / "sessions" / "a-hardlink.db")
        (self.state / "home" / ".cache" / "blob").write_bytes(b"c" * 3000)
        self.outside = self.base / "outside"
        self.outside.mkdir()
        (self.outside / "big").write_bytes(b"o" * 50000)
        (self.state / "link").symlink_to(self.outside)
        self.work = self.base / "worker-state"
        self.work.mkdir()
        (self.work / "notes").write_bytes(b"w" * 100)
        self.config = {
            "agents": {"ops": {"roots": {"state": str(self.state)}},
                       "worker": {"roots": {"state": str(self.work)}},
                       "idle": {"roots": {"state": str(self.base / "absent")}}},
            "storage": {"enabled": True, "agent_warn_bytes": 3500, "cache_warn_bytes": 2000,
                        "cache_paths": {"state": ["home/.cache"]}, "dormant_agents": ["idle"],
                        "filesystem_warn_available_bytes": 1, "filesystem_warn_used_percent": 100},
        }

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_counts_hardlinks_once_skips_symlinks_and_splits_caches(self) -> None:
        report, opts = sto.collect(self.config)
        ops = report["agents"]["ops"]
        self.assertEqual(ops["persistent_bytes"], 4000)
        self.assertEqual(ops["cache_bytes"], 3000)
        self.assertEqual(report["agents"]["idle"], {"status": "dormant"})
        self.assertEqual(report["status"], "complete")
        warnings = sto.warnings(report, opts)
        self.assertTrue(any(w.startswith("ops persistent data") for w in warnings))
        self.assertTrue(any(w.startswith("ops caches") for w in warnings))
        self.assertFalse(any(w.startswith("worker") for w in warnings))

    def test_agent_override_and_missing_root(self) -> None:
        self.config["storage"]["agent_warn_overrides"] = {"ops": 10 ** 9}
        self.config["storage"]["dormant_agents"] = []
        report, opts = sto.collect(self.config)
        warnings = sto.warnings(report, opts)
        self.assertFalse(any(w.startswith("ops persistent") for w in warnings))
        self.assertEqual(report["status"], "incomplete")
        self.assertTrue(any(w.startswith("idle scan incomplete") for w in warnings))

    def test_cli_sends_one_message_and_changes_nothing(self) -> None:
        cfg = self.base / "monitors.json"
        cfg.write_text(json.dumps(self.config))
        before = _snapshot(self.base)
        sink = alerts.Sink("stdout", stream=io.StringIO())
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(sto.main(["check", "--config", str(cfg)], sink=sink), 0)
        self.assertEqual(len(sink.sent), 1)
        self.assertEqual(json.loads(out.getvalue())["mode"], "report-only")
        after = _snapshot(self.base)
        self.assertEqual(after, before)

    def test_disabled_by_default_and_rejects_unknown_settings(self) -> None:
        cfg = self.base / "monitors.json"
        self.config["storage"].pop("enabled")
        cfg.write_text(json.dumps(self.config))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(sto.main(["check", "--config", str(cfg)]), 3)
        self.config["storage"]["delete_caches"] = True
        cfg.write_text(json.dumps(self.config))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(sto.main(["check", "--config", str(cfg)]), 2)

    def test_report_only_by_construction(self) -> None:
        names = _calls(SCRIPTS / "switchroom-storage-monitor.py")
        for forbidden in ("import:subprocess", "unlink", "rmtree", "remove", "rmdir", "truncate", "os.kill",
                          "os.system", "chown", "chmod"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, names)


class OpsKitExampleTests(unittest.TestCase):
    def test_every_monitor_ships_disabled_with_a_stdout_sink(self) -> None:
        config = json.loads((KIT / "monitors.json").read_text(encoding="utf-8"))
        self.assertEqual(config["alert"]["sink"], "stdout")
        for name in ("ownership", "memory", "storage"):
            with self.subTest(monitor=name):
                self.assertIs(config[name]["enabled"], False)
        # The example config is valid for every monitor.
        own.settings(config)
        mem.settings(config)
        sto.settings(config, alerts.agents(config))

    def test_example_timers_only_audit_and_never_repair(self) -> None:
        units = "\n".join(p.read_text(encoding="utf-8") for p in (KIT / "systemd").iterdir())
        units += (KIT / "crontab.example").read_text(encoding="utf-8")
        self.assertNotIn(" repair", units)
        self.assertNotIn("--apply", units)
        for script in ("switchroom-ownership-audit.py audit", "switchroom-memory-alert.py check",
                       "switchroom-storage-monitor.py check"):
            self.assertIn(script, units)

    def test_starter_overlay_compose_does_not_run_the_monitors(self) -> None:
        compose = (ROOT / "examples" / "overlay-repo" / "compose.yaml").read_text(encoding="utf-8")
        for name in ("ownership-audit", "memory-alert", "storage-monitor", "ops-kit"):
            self.assertNotIn(name, compose)


if __name__ == "__main__":
    unittest.main()
