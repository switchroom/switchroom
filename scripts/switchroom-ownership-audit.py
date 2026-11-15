#!/usr/bin/env python3
"""Audit, and on request repair, ownership of each agent's mounted directories.

Agents in the Fleet image run as one container user (UID/GID 1000 by
default). A file left behind by a root shell, a host-side tool or a restore
with the wrong owner can stop an agent from writing its own state. This tool
walks the roots you list for each agent and reports every path whose owner is
not the container user, and every private file (``.env``, ``auth.json`` and
the like) that group or other users can read.

``audit`` (the default action) only reads and reports. ``repair`` is opt-in:
it takes a report that ``audit`` wrote, changes **only the paths that report
enumerates**, and only after re-checking that each one is still the same
inode, inside the same configured root, reached without following a symlink.
Without ``--apply`` it prints what it would change and changes nothing.

Exit codes: 0 clean (or repair complete), 1 violations found / repair
incomplete / a root could not be fully read, 2 config or usage error,
3 disabled in the config.
"""
from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import os
import stat
import sys
from pathlib import Path
from typing import Any

SCHEMA = "switchroom-ownership-audit/1"
MAX_VIOLATIONS = 10000
_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW


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


def settings(config: dict[str, Any]) -> dict[str, Any]:
    own = alerts.section(config, "ownership")
    uid = own.get("uid", 1000)
    gid = own.get("gid", 1000)
    for label, value in (("uid", uid), ("gid", gid)):
        if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value < 2**31:
            raise ConfigError(f"ownership.{label} must be a non-negative integer")
    private = own.get("private_files", [".env", "auth.json"])
    if not isinstance(private, list) or not all(isinstance(p, str) for p in private):
        raise ConfigError("ownership.private_files must be a list of relative paths")
    clean_private = set()
    for item in private:
        parts = tuple(item.split("/"))
        if item.startswith("/") or any(part in ("", ".", "..") for part in parts):
            raise ConfigError(f"ownership.private_files entry must be a plain relative path: {item!r}")
        clean_private.add(parts)
    return {"enabled": own.get("enabled") is True, "uid": uid, "gid": gid, "private": clean_private}


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def audit_root(root: Path, *, uid: int, gid: int, private: set[tuple[str, ...]],
               sink: list[dict[str, Any]], limit: int) -> dict[str, Any]:
    """Walk one root without following symlinks or crossing mounts; append violations."""
    summary: dict[str, Any] = {"path": str(root), "status": "complete", "scanned": 0,
                               "excluded": [], "issues": []}
    try:
        root_stat = root.lstat()
    except FileNotFoundError:
        summary.update(status="missing")
        summary["issues"].append("root does not exist")
        return summary
    except OSError as exc:
        summary.update(status="error")
        summary["issues"].append(f"cannot inspect root: {exc.strerror or exc}")
        return summary
    if stat.S_ISLNK(root_stat.st_mode) or not stat.S_ISDIR(root_stat.st_mode):
        summary.update(status="error")
        summary["issues"].append("root must be a directory, not a symlink")
        return summary
    device = root_stat.st_dev

    def check(relative: tuple[str, ...], st: os.stat_result) -> None:
        summary["scanned"] += 1
        found = []
        if st.st_uid != uid or st.st_gid != gid:
            found.append("owner")
        if relative in private and stat.S_ISREG(st.st_mode) and stat.S_IMODE(st.st_mode) & 0o077:
            found.append("mode")
        for kind in found:
            if len(sink) >= limit:
                summary["truncated"] = True
                return
            sink.append({"relative": "/".join(relative) or ".", "kind": kind,
                         "uid": st.st_uid, "gid": st.st_gid,
                         "mode": f"{stat.S_IMODE(st.st_mode):04o}",
                         "type": "symlink" if stat.S_ISLNK(st.st_mode) else
                                 "directory" if stat.S_ISDIR(st.st_mode) else
                                 "file" if stat.S_ISREG(st.st_mode) else "other",
                         "dev": st.st_dev, "ino": st.st_ino, "ctime_ns": st.st_ctime_ns})

    check((), root_stat)
    stack: list[tuple[str, ...]] = [()]
    while stack:
        relative = stack.pop()
        directory = root.joinpath(*relative)
        try:
            with os.scandir(directory) as entries:
                children = list(entries)
        except FileNotFoundError:
            continue  # removed while we walked
        except OSError as exc:
            summary["status"] = "partial"
            summary["issues"].append(f"cannot read {'/'.join(relative) or '.'}: {exc.strerror or exc}")
            continue
        for entry in sorted(children, key=lambda e: e.name):
            child = relative + (entry.name,)
            try:
                st = entry.stat(follow_symlinks=False)
            except FileNotFoundError:
                continue  # SQLite -wal/-shm and temp files come and go
            except OSError as exc:
                summary["status"] = "partial"
                summary["issues"].append(f"cannot inspect {'/'.join(child)}: {exc.strerror or exc}")
                continue
            if stat.S_ISDIR(st.st_mode) and st.st_dev != device:
                summary["excluded"].append(f"other filesystem: {'/'.join(child)}")
                continue
            check(child, st)
            if stat.S_ISDIR(st.st_mode):
                stack.append(child)
    if summary.get("truncated"):
        summary["status"] = "partial"
        summary["issues"].append(f"stopped recording after {limit} violations; repair and audit again")
    return summary


def run_audit(config: dict[str, Any], *, only: list[str] | None = None,
              limit: int = MAX_VIOLATIONS) -> dict[str, Any]:
    opts = settings(config)
    fleet = alerts.agents(config)
    if only:
        unknown = sorted(set(only) - set(fleet))
        if unknown:
            raise ConfigError(f"unknown agent: {', '.join(unknown)}")
        fleet = {name: fleet[name] for name in only}
    report: dict[str, Any] = {"schema": SCHEMA, "mode": "report-only", "generated_at": _now(),
                              "expected": {"uid": opts["uid"], "gid": opts["gid"]},
                              "private_files": sorted("/".join(p) for p in opts["private"]),
                              "agents": {}, "violations": []}
    for name in sorted(fleet):
        roots = {}
        for label, root in sorted(fleet[name]["roots"].items()):
            found: list[dict[str, Any]] = []
            remaining = max(0, limit - len(report["violations"]))
            roots[label] = audit_root(root, uid=opts["uid"], gid=opts["gid"], private=opts["private"],
                                      sink=found, limit=remaining)
            for item in found:
                report["violations"].append({"agent": name, "root": label, **item})
        report["agents"][name] = {"roots": roots}
    statuses = {r["status"] for a in report["agents"].values() for r in a["roots"].values()}
    if statuses - {"complete"}:
        report["status"] = "incomplete"
    else:
        report["status"] = "violations" if report["violations"] else "clean"
    return report


def _walk_to_parent(root: Path, parts: list[str]) -> int:
    """Open the parent directory of ``root/parts`` without following any symlink."""
    fd = os.open("/", _DIR_FLAGS)
    try:
        for part in [*root.parts[1:], *parts[:-1]]:
            child = os.open(part, _DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def repair(config: dict[str, Any], report: dict[str, Any], *, apply: bool) -> dict[str, Any]:
    """Change only the paths ``report`` enumerates, after re-verifying each one."""
    opts = settings(config)
    fleet = alerts.agents(config)
    if report.get("schema") != SCHEMA or not isinstance(report.get("violations"), list):
        raise ConfigError("not an ownership audit report")
    if report.get("expected") != {"uid": opts["uid"], "gid": opts["gid"]}:
        raise ConfigError("report was written for a different uid/gid than the config")
    result: dict[str, Any] = {"schema": SCHEMA, "mode": "repair" if apply else "repair-dry-run",
                              "generated_at": _now(), "changed": [], "planned": [], "skipped": []}
    # This run's own changes update ctime; remember them so a path with two
    # findings (owner and mode) is still recognised for the second one.
    refreshed: dict[tuple[int, int], int] = {}
    for item in report["violations"]:
        where = f"{item.get('agent')}:{item.get('root')}:{item.get('relative')}"

        def skip(reason: str) -> None:
            result["skipped"].append({"path": where, "kind": item.get("kind"), "reason": reason})

        agent = fleet.get(item.get("agent"))
        root = agent["roots"].get(item.get("root")) if agent else None
        relative = item.get("relative")
        kind = item.get("kind")
        if root is None:
            skip("agent or root is not in the current config")
            continue
        if kind not in ("owner", "mode") or not isinstance(relative, str):
            skip("not a repairable entry")
            continue
        parts = [] if relative == "." else relative.split("/")
        if relative.startswith("/") or any(p in ("", ".", "..") for p in parts):
            skip("path is not a plain relative path")
            continue
        if kind == "mode" and tuple(parts) not in opts["private"]:
            skip("mode repair is only for configured private files")
            continue
        if not apply:
            result["planned"].append({"path": where, "kind": kind})
            continue
        # The root itself is reached from its parent, so no component is followed.
        base, walk = (root, parts) if parts else (root.parent, [root.name])
        parent = None
        try:
            parent = _walk_to_parent(base, walk)
        except OSError as exc:
            skip(f"cannot reach path without following a symlink: {exc.strerror or exc}")
            continue
        try:
            name = walk[-1]
            dir_fd = parent
            try:
                st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
            except OSError as exc:
                skip(f"path is gone: {exc.strerror or exc}")
                continue
            if not parts and stat.S_ISLNK(st.st_mode):
                skip("root became a symlink")
                continue
            # Inode numbers can be reused, so any metadata change since the audit
            # (ctime) also counts as "not the path the audit saw".
            expected_ctime = refreshed.get((st.st_dev, st.st_ino), item.get("ctime_ns"))
            if (st.st_dev, st.st_ino, st.st_ctime_ns) != (item.get("dev"), item.get("ino"), expected_ctime):
                skip("path was replaced since the audit")
                continue
            if kind == "owner":
                if (st.st_uid, st.st_gid) == (opts["uid"], opts["gid"]):
                    skip("already correct")
                    continue
                os.chown(name, opts["uid"], opts["gid"], dir_fd=dir_fd, follow_symlinks=False)
            else:
                if not stat.S_ISREG(st.st_mode):
                    skip("mode repair is only for regular files")
                    continue
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                             dir_fd=dir_fd)
                try:
                    pinned = os.fstat(fd)
                    if (pinned.st_dev, pinned.st_ino) != (st.st_dev, st.st_ino):
                        skip("path was replaced since the audit")
                        continue
                    secure = stat.S_IMODE(pinned.st_mode) & ~0o077
                    if secure == stat.S_IMODE(pinned.st_mode):
                        skip("already correct")
                        continue
                    os.fchmod(fd, secure)
                finally:
                    os.close(fd)
            after = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
            if (after.st_dev, after.st_ino) == (st.st_dev, st.st_ino):
                refreshed[(st.st_dev, st.st_ino)] = after.st_ctime_ns
            result["changed"].append({"path": where, "kind": kind})
        except OSError as exc:
            skip(f"change failed: {exc.strerror or exc}")
        finally:
            if parent is not None:
                os.close(parent)
    already = [s for s in result["skipped"] if s["reason"] == "already correct"]
    result["status"] = "complete" if len(already) == len(result["skipped"]) else "incomplete"
    return result


def _write_private(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(tmp, path)


def alert_text(report: dict[str, Any]) -> str:
    counts: dict[str, int] = {}
    for item in report["violations"]:
        counts[item["agent"]] = counts.get(item["agent"], 0) + 1
    lines = [f"Ownership audit: {report['status']} "
             f"(expected {report['expected']['uid']}:{report['expected']['gid']})."]
    for name in sorted(report["agents"]):
        problems = [f"{label} {root['status']}" for label, root in sorted(report["agents"][name]["roots"].items())
                    if root["status"] != "complete"]
        if counts.get(name) or problems:
            lines.append(f"- {name}: {counts.get(name, 0)} path(s)" + (f"; {', '.join(problems)}" if problems else ""))
    lines.append("Nothing was changed. Review the report, then run `repair --report <file>` to fix only those paths.")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    sub = parser.add_subparsers(dest="cmd")
    a = sub.add_parser("audit", help="report ownership problems (read-only, the default)")
    a.add_argument("--agent", action="append", help="limit to this agent (repeatable)")
    a.add_argument("--report", type=Path, help="write the full JSON report here (0600)")
    r = sub.add_parser("repair", help="fix only the paths an audit report lists")
    r.add_argument("--report", type=Path, required=True, help="report written by audit --report")
    r.add_argument("--apply", action="store_true", help="actually change files (default: dry run)")
    for p in (a, r):
        p.add_argument("--config", type=Path, required=True)
        p.add_argument("--sink", choices=alerts.SINKS, help="override alert.sink")
    args = parser.parse_args(argv)
    if args.cmd is None:
        parser.print_help(sys.stderr)
        return 2
    try:
        config = alerts.load_json(args.config)
        opts = settings(config)
        if not opts["enabled"]:
            print(json.dumps({"result": "disabled", "reason": "ownership.enabled is not true"}))
            return 3
        sink = alerts.Sink.from_config(config, override=args.sink, source="switchroom-ownership-audit")
        if args.cmd == "audit":
            report = run_audit(config, only=args.agent)
            if args.report:
                _write_private(args.report, report)
            summary = {k: report[k] for k in ("schema", "mode", "status", "expected")}
            summary["violations"] = len(report["violations"])
            summary["sample"] = [f"{v['agent']}:{v['root']}:{v['relative']} {v['kind']}"
                                 for v in report["violations"][:20]]
            if report["status"] != "clean":
                try:
                    sink.send(alert_text(report), kind="ownership")
                except alerts.DeliveryError as exc:
                    summary["delivery_error"] = str(exc)
            print(json.dumps(summary, sort_keys=True))
            return 0 if report["status"] == "clean" else 1
        report = alerts.load_json(args.report)
        result = repair(config, report, apply=args.apply)
        print(json.dumps(result, sort_keys=True))
        return 0 if result["status"] == "complete" else 1
    except ConfigError as exc:
        print(json.dumps({"result": "error", "reason": str(exc)}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
