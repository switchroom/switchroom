#!/usr/bin/env python3
"""Report disk use for each agent's directories and the filesystems under them.

Run ``check`` from a daily timer or cron on the Docker host, as a user that can
read every agent's directories (usually root). For each agent it walks the
roots you list, counting each file once even when it is hard-linked, never
following a symlink and never crossing into another mount. Paths you mark as
caches are counted separately, so rebuildable caches do not hide real growth.

It warns when:

* a filesystem holding an agent root is at or above ``filesystem_warn_used_percent``
  or has less than ``filesystem_warn_available_bytes`` free;
* an agent's persistent data (everything except its caches) reaches
  ``agent_warn_bytes`` (or that agent's entry in ``agent_warn_overrides``);
* an agent's caches reach ``cache_warn_bytes``.

It is report-only: it never deletes, moves or compresses anything. Warnings go
to the configured sink as one message; the full JSON report goes to stdout
(and to ``--report`` when given).

Exit codes: 0 scan complete (with or without warnings), 1 a scan was
incomplete or the alert could not be delivered, 2 config error, 3 disabled.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import stat
import sys
import time
from pathlib import Path
from typing import Any

GIB = 1024 ** 3
DEFAULTS: dict[str, Any] = {
    "filesystem_warn_used_percent": 85.0,
    "filesystem_warn_available_bytes": 20 * GIB,
    "agent_warn_bytes": 10 * GIB,
    "agent_warn_overrides": {},
    "cache_warn_bytes": 2 * GIB,
    "cache_paths": {},
    "scan_timeout_seconds": 600,
    "dormant_agents": [],
}
NOTE_LIMIT = 32


def _load_alerts():
    if "switchroom_alerts" in sys.modules:
        return sys.modules["switchroom_alerts"]
    path = Path(__file__).resolve().with_name("switchroom_alerts.py")
    spec = importlib.util.spec_from_file_location("switchroom_alerts", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["switchroom_alerts"] = module
    spec.loader.exec_module(module)
    return module


alerts = _load_alerts()
ConfigError = alerts.ConfigError


def settings(config: dict[str, Any], fleet: dict[str, dict[str, Any]]) -> dict[str, Any]:
    raw = alerts.section(config, "storage")
    unknown = set(raw) - set(DEFAULTS) - {"enabled"}
    if unknown:
        raise ConfigError(f"unknown storage setting: {', '.join(sorted(unknown))}")
    out = {**DEFAULTS, **{k: v for k, v in raw.items() if k != "enabled"}}
    out["enabled"] = raw.get("enabled") is True
    out["filesystem_warn_used_percent"] = alerts.number(
        out["filesystem_warn_used_percent"], "storage.filesystem_warn_used_percent", low=1, high=100)
    for key in ("filesystem_warn_available_bytes", "agent_warn_bytes", "cache_warn_bytes", "scan_timeout_seconds"):
        alerts.positive_int(out[key], f"storage.{key}")
    overrides = out["agent_warn_overrides"]
    if not isinstance(overrides, dict):
        raise ConfigError("storage.agent_warn_overrides must be an object")
    for name, value in overrides.items():
        if name not in fleet:
            raise ConfigError(f"storage.agent_warn_overrides names an unknown agent: {name}")
        alerts.positive_int(value, f"storage.agent_warn_overrides.{name}")
    dormant = out["dormant_agents"]
    if not isinstance(dormant, list) or not all(isinstance(n, str) for n in dormant):
        raise ConfigError("storage.dormant_agents must be a list of agent names")
    if set(dormant) - set(fleet):
        raise ConfigError(f"storage.dormant_agents names an unknown agent: {', '.join(sorted(set(dormant) - set(fleet)))}")
    caches = out["cache_paths"]
    if not isinstance(caches, dict):
        raise ConfigError("storage.cache_paths must be an object of {root label: [relative paths]}")
    labels = {label for agent in fleet.values() for label in agent["roots"]}
    clean: dict[str, set[tuple[str, ...]]] = {}
    for label, items in caches.items():
        if label not in labels:
            raise ConfigError(f"storage.cache_paths names an unknown root label: {label}")
        if not isinstance(items, list) or not all(isinstance(i, str) for i in items):
            raise ConfigError(f"storage.cache_paths.{label} must be a list of relative paths")
        for item in items:
            parts = tuple(item.split("/"))
            if item.startswith("/") or any(p in ("", ".", "..") for p in parts):
                raise ConfigError(f"storage.cache_paths entry must be a plain relative path: {item!r}")
            clean.setdefault(label, set()).add(parts)
    out["cache_paths"] = clean
    return out


class _Notes:
    def __init__(self) -> None:
        self.items: list[str] = []
        self.omitted = 0

    def add(self, item: str) -> None:
        if len(self.items) < NOTE_LIMIT:
            self.items.append(item)
        else:
            self.omitted += 1

    def as_list(self) -> list[str]:
        return self.items + ([f"{self.omitted} more omitted"] if self.omitted else [])


def scan_root(root: Path, *, caches: set[tuple[str, ...]], seen: set[tuple[int, int]],
              deadline: float) -> dict[str, Any]:
    """Count one root. Files under a cache path count as cache bytes."""
    out: dict[str, Any] = {"path": str(root), "status": "complete", "persistent_bytes": 0,
                           "cache_bytes": 0, "allocated_bytes": 0, "files": 0}
    issues, excluded = _Notes(), _Notes()
    try:
        root_stat = root.lstat()
    except FileNotFoundError:
        out["status"] = "missing"
        issues.add("root does not exist")
        out.update(issues=issues.as_list(), excluded=[])
        return out
    except OSError as exc:
        out["status"] = "error"
        issues.add(f"cannot inspect root: {exc.strerror or exc}")
        out.update(issues=issues.as_list(), excluded=[])
        return out
    if stat.S_ISLNK(root_stat.st_mode) or not stat.S_ISDIR(root_stat.st_mode):
        out["status"] = "error"
        issues.add("root must be a directory, not a symlink")
        out.update(issues=issues.as_list(), excluded=[])
        return out
    device = root_stat.st_dev
    dirs_seen = {(root_stat.st_dev, root_stat.st_ino)}
    stack: list[tuple[tuple[str, ...], bool]] = [((), () in caches)]
    while stack:
        if time.monotonic() >= deadline:
            out["status"] = "timeout"
            issues.add("scan time budget exhausted")
            break
        relative, in_cache = stack.pop()
        try:
            with os.scandir(root.joinpath(*relative)) as entries:
                children = list(entries)
        except FileNotFoundError:
            continue
        except OSError as exc:
            out["status"] = "partial"
            issues.add(f"cannot read {'/'.join(relative) or '.'}: {exc.strerror or exc}")
            continue
        for entry in children:
            child = relative + (entry.name,)
            try:
                st = entry.stat(follow_symlinks=False)
            except FileNotFoundError:
                continue  # SQLite -wal/-shm and temp files come and go
            except OSError as exc:
                out["status"] = "partial"
                issues.add(f"cannot inspect {'/'.join(child)}: {exc.strerror or exc}")
                continue
            if stat.S_ISLNK(st.st_mode):
                continue
            if stat.S_ISDIR(st.st_mode):
                identity = (st.st_dev, st.st_ino)
                if st.st_dev != device:
                    excluded.add(f"other filesystem: {'/'.join(child)}")
                elif identity not in dirs_seen:
                    dirs_seen.add(identity)
                    stack.append((child, in_cache or child in caches))
                continue
            if not stat.S_ISREG(st.st_mode):
                continue
            identity = (st.st_dev, st.st_ino)
            if identity in seen:
                continue
            seen.add(identity)
            out["files"] += 1
            out["allocated_bytes"] += st.st_blocks * 512
            out["cache_bytes" if in_cache or child in caches else "persistent_bytes"] += st.st_size
    out.update(issues=issues.as_list(), excluded=excluded.as_list(), device=device)
    return out


def filesystem(path: Path) -> dict[str, Any]:
    try:
        usage = shutil.disk_usage(path)
    except OSError as exc:
        return {"status": "error", "issue": exc.strerror or str(exc)}
    return {"status": "complete", "total_bytes": usage.total, "available_bytes": usage.free,
            "used_percent": round(usage.used * 100 / usage.total, 1) if usage.total else None}


def collect(config: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    fleet = alerts.agents(config)
    opts = settings(config, fleet)
    deadline = time.monotonic() + opts["scan_timeout_seconds"]
    report: dict[str, Any] = {"schema": "switchroom-storage-monitor/1", "mode": "report-only",
                              "agents": {}, "filesystems": {}}
    for name in sorted(fleet):
        if name in opts["dormant_agents"]:
            report["agents"][name] = {"status": "dormant"}
            continue
        seen: set[tuple[int, int]] = set()
        roots = {}
        for label, root in sorted(fleet[name]["roots"].items()):
            roots[label] = scan_root(root, caches=opts["cache_paths"].get(label, set()), seen=seen,
                                     deadline=deadline)
            device = roots[label].pop("device", None)
            if device is not None and str(device) not in report["filesystems"]:
                report["filesystems"][str(device)] = {"example_path": str(root), **filesystem(root)}
        statuses = {r["status"] for r in roots.values()}
        report["agents"][name] = {
            "status": "complete" if statuses == {"complete"} else "incomplete",
            "persistent_bytes": sum(r["persistent_bytes"] for r in roots.values()),
            "cache_bytes": sum(r["cache_bytes"] for r in roots.values()),
            "roots": roots,
        }
    statuses = {a["status"] for a in report["agents"].values()} | {f["status"] for f in report["filesystems"].values()}
    report["status"] = "complete" if statuses <= {"complete", "dormant"} else "incomplete"
    return report, opts


def warnings(report: dict[str, Any], opts: dict[str, Any]) -> list[str]:
    fmt = alerts.format_bytes
    out: list[str] = []
    for fs in report["filesystems"].values():
        if fs["status"] != "complete":
            continue
        where = f"filesystem holding {fs['example_path']}"
        if fs["used_percent"] is not None and fs["used_percent"] >= opts["filesystem_warn_used_percent"]:
            out.append(f"{where} is {fs['used_percent']:.1f}% used (warn at {opts['filesystem_warn_used_percent']:.1f}%)")
        if fs["available_bytes"] < opts["filesystem_warn_available_bytes"]:
            out.append(f"{where} has {fmt(fs['available_bytes'])} free (warn below {fmt(opts['filesystem_warn_available_bytes'])})")
    for name, agent in sorted(report["agents"].items()):
        if agent["status"] == "dormant":
            continue
        limit = opts["agent_warn_overrides"].get(name, opts["agent_warn_bytes"])
        if agent["persistent_bytes"] >= limit:
            out.append(f"{name} persistent data {fmt(agent['persistent_bytes'])} is at or above {fmt(limit)}")
        if agent["cache_bytes"] >= opts["cache_warn_bytes"]:
            out.append(f"{name} caches {fmt(agent['cache_bytes'])} are at or above {fmt(opts['cache_warn_bytes'])}")
        if agent["status"] != "complete":
            bad = [f"{label} {root['status']}" for label, root in sorted(agent["roots"].items()) if root["status"] != "complete"]
            out.append(f"{name} scan incomplete: {', '.join(bad)}")
    return out


def main(argv: list[str] | None = None, *, sink=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("command", choices=("check",))
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--sink", choices=alerts.SINKS, help="override alert.sink")
    parser.add_argument("--report", type=Path, help="also write the JSON report here")
    args = parser.parse_args(argv)
    try:
        config = alerts.load_json(args.config)
        fleet = alerts.agents(config)
        if not settings(config, fleet)["enabled"]:
            print(json.dumps({"result": "disabled", "reason": "storage.enabled is not true"}))
            return 3
        sink = sink or alerts.Sink.from_config(config, override=args.sink, source="switchroom-storage-monitor")
        report, opts = collect(config)
    except ConfigError as exc:
        print(json.dumps({"result": "error", "reason": str(exc)}))
        return 2
    report["warnings"] = warnings(report, opts)
    rc = 0 if report["status"] == "complete" else 1
    if report["warnings"]:
        try:
            sink.send("Storage warning:\n" + "\n".join(f"- {w}" for w in report["warnings"]), kind="storage")
        except alerts.DeliveryError as exc:
            report["delivery_error"] = str(exc)
            rc = 1
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, sort_keys=True))
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
