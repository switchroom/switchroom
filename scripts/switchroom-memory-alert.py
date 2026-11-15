#!/usr/bin/env python3
"""Report sustained host memory pressure and container task-limit trouble.

Run ``check`` once a minute (a systemd timer or cron) as root on the Docker
host. It samples ``/proc/meminfo`` and memory pressure (PSI,
``/proc/pressure/memory``) and sends one alert to the configured sink only when
the host has been under *real* pressure for ``sustain_seconds``:

* ``MemAvailable`` below ``low_available_bytes``, or
* PSI ``full avg60`` at or above ``psi_full_avg60``, or
* PSI ``some avg60`` at or above ``psi_some_avg60``.

Swap use alone never alerts: idle pages parked in swap are normal. While the
pressure lasts it repeats at most every ``repeat_seconds``; when it clears
after an alert it sends one short "recovered" note. One good sample resets the
clock, so short spikes stay silent.

The same run compares each Docker container's ``pids.current`` with its
``pids.max`` and alerts once per episode when a container passes
``pids_warn_ratio`` of its limit, or when the kernel refused a new task.

It is report-only: it never restarts, kills or reconfigures anything. Alerts
carry numbers and container names only.

Exit codes: 0 ok, 1 a check or a delivery failed, 2 config error, 3 disabled.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Callable

GIB = 1024 ** 3
DEFAULTS: dict[str, Any] = {
    "low_available_bytes": 4 * GIB,
    "psi_full_avg60": 5.0,
    "psi_some_avg60": 20.0,
    "sustain_seconds": 300,
    "repeat_seconds": 6 * 3600,
    "pids_warn_ratio": 0.8,
    "top_users": 5,
    "state_dir": "/var/lib/switchroom-monitors/memory",
}
PROC = Path("/proc")
CGROUP_ROOT = Path("/sys/fs/cgroup")
DOCKER_CONTAINERS = Path("/var/lib/docker/containers")


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
    raw = alerts.section(config, "memory")
    unknown = set(raw) - set(DEFAULTS) - {"enabled"}
    if unknown:
        raise ConfigError(f"unknown memory setting: {', '.join(sorted(unknown))}")
    out = {**DEFAULTS, **{k: v for k, v in raw.items() if k != "enabled"}}
    out["enabled"] = raw.get("enabled") is True
    for key in ("low_available_bytes", "sustain_seconds", "repeat_seconds", "top_users"):
        alerts.positive_int(out[key], f"memory.{key}")
    out["psi_full_avg60"] = alerts.number(out["psi_full_avg60"], "memory.psi_full_avg60", high=100)
    out["psi_some_avg60"] = alerts.number(out["psi_some_avg60"], "memory.psi_some_avg60", high=100)
    out["pids_warn_ratio"] = alerts.number(out["pids_warn_ratio"], "memory.pids_warn_ratio", high=1)
    if not isinstance(out["state_dir"], str) or not out["state_dir"].startswith("/"):
        raise ConfigError("memory.state_dir must be an absolute path")
    out["state_dir"] = Path(out["state_dir"])
    return out


# ------------------------------------------------------------------ sampling

def read_meminfo(text: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for line in text.splitlines():
        key, _, rest = line.partition(":")
        parts = rest.split()
        if parts and parts[0].isdigit():
            out[key.strip()] = int(parts[0]) * (1024 if parts[1:] == ["kB"] else 1)
    return out


def read_psi(text: str) -> dict[str, float]:
    out: dict[str, float] = {}
    for line in text.splitlines():
        parts = line.split()
        if not parts or parts[0] not in ("some", "full"):
            continue
        for item in parts[1:]:
            key, _, value = item.partition("=")
            if key.startswith("avg"):
                out[f"{parts[0]}_{key}"] = float(value)
    return out


def sample(proc: Path = PROC) -> dict[str, Any]:
    mem = read_meminfo((proc / "meminfo").read_text())
    try:
        psi = read_psi((proc / "pressure" / "memory").read_text())
    except OSError:
        psi = {}  # kernels without PSI: MemAvailable still works
    return {
        "available": mem.get("MemAvailable", 0),
        "total": mem.get("MemTotal", 0),
        "swap_used": mem.get("SwapTotal", 0) - mem.get("SwapFree", 0),
        "swap_total": mem.get("SwapTotal", 0),
        "psi_some_avg60": psi.get("some_avg60", 0.0),
        "psi_full_avg60": psi.get("full_avg60", 0.0),
        "psi_available": bool(psi),
    }


def pressure_reasons(s: dict[str, Any], opts: dict[str, Any]) -> list[str]:
    """Why this sample counts as real pressure. Swap use is deliberately not a reason."""
    why = []
    if s["available"] < opts["low_available_bytes"]:
        why.append("low_available")
    if s["psi_full_avg60"] >= opts["psi_full_avg60"]:
        why.append("psi_full")
    if s["psi_some_avg60"] >= opts["psi_some_avg60"]:
        why.append("psi_some")
    return why


def container_name(cid: str, containers: Path = DOCKER_CONTAINERS) -> str:
    try:
        cfg = json.loads((containers / cid / "config.v2.json").read_text())
        name = re.sub(r"[^\w.-]", "", str(cfg.get("Name") or "").lstrip("/"))[:60]
    except (OSError, ValueError, AttributeError):
        name = ""
    return name or f"container {cid[:12]}"


def _scopes(root: Path):
    system = root / "system.slice"
    if not system.is_dir():
        return
    for path in sorted(system.iterdir()):
        match = re.fullmatch(r"docker-([0-9a-f]{64})\.scope", path.name)
        if match:
            yield match.group(1), path


def top_users(root: Path = CGROUP_ROOT, containers: Path = DOCKER_CONTAINERS, n: int = 5) -> list[tuple[str, int]]:
    def usage(path: Path) -> int:
        total = 0
        for name in ("memory.current", "memory.swap.current"):
            try:
                total += int((path / name).read_text())
            except (OSError, ValueError):
                pass
        return total

    rows = [(container_name(cid, containers), usage(path)) for cid, path in _scopes(root)]
    users = root / "user.slice"
    if users.is_dir():
        for path in users.iterdir():
            match = re.fullmatch(r"user-(\d+)\.slice", path.name)
            if match:
                rows.append((f"login session uid {match.group(1)}", usage(path)))
    rows.sort(key=lambda row: -row[1])
    return rows[:n]


# ------------------------------------------------------------------ messages

def _gib(value: int) -> str:
    return f"{value / GIB:.1f} GiB"


def alert_text(s: dict[str, Any], minutes: int, users: list[tuple[str, int]]) -> str:
    lines = [f"The host is short of memory and has been for about {minutes} min.",
             f"Available: {_gib(s['available'])} of {_gib(s['total'])}. "
             f"Memory stalls (last minute): {s['psi_some_avg60']:.0f}% some, {s['psi_full_avg60']:.0f}% full. "
             f"Swap used: {_gib(s['swap_used'])} of {_gib(s['swap_total'])}."]
    if users:
        lines.append("Biggest users: " + ", ".join(f"{name} {_gib(b)}" for name, b in users) + ".")
    lines.append("Nothing has been restarted.")
    return "\n".join(lines)


def recovered_text(s: dict[str, Any], minutes: int) -> str:
    return (f"Host memory has recovered after about {minutes} min: {_gib(s['available'])} available, "
            f"stalls {s['psi_some_avg60']:.0f}% some / {s['psi_full_avg60']:.0f}% full.")


# ------------------------------------------------------------------ state machine

def decide(state: dict[str, Any], s: dict[str, Any], now: float, opts: dict[str, Any]) -> tuple[dict[str, Any], str | None]:
    """Return (new state, 'alert' | 'recovered' | None)."""
    state = dict(state)
    why = pressure_reasons(s, opts)
    if why:
        state.setdefault("since", now)
        state["reasons"] = why
        if now - state["since"] < opts["sustain_seconds"]:
            return state, None
        last = state.get("alerted_at")
        if last is None or now - last >= opts["repeat_seconds"]:
            return state, "alert"
        return state, None
    new: dict[str, Any] = {"last_clear": now}
    if state.get("alerted_at") is not None:
        new["recovered_from"] = state.get("since")
        return new, "recovered"
    return new, None


def load_state(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = path.with_name("." + path.name + ".tmp")
    fd = os.open(tmp, os.O_CREAT | os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(state, handle, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def check_memory(opts: dict[str, Any], sink, *, proc: Path = PROC, cgroup_root: Path = CGROUP_ROOT,
                 containers: Path = DOCKER_CONTAINERS, now: Callable[[], float] = time.time) -> dict[str, Any]:
    path = opts["state_dir"] / "state.json"
    s = sample(proc)
    t = now()
    new, kind = decide(load_state(path), s, t, opts)
    if kind == "alert":
        minutes = max(1, round((t - new["since"]) / 60))
        sink.send(alert_text(s, minutes, top_users(cgroup_root, containers, opts["top_users"])), kind="memory")
        new["alerted_at"] = t  # only after delivery, so a failed send retries next run
    elif kind == "recovered":
        minutes = max(1, round((t - (new.get("recovered_from") or t)) / 60))
        try:
            sink.send(recovered_text(s, minutes), kind="memory-recovered")
        except alerts.DeliveryError:
            pass  # the alert already went out; a lost note is not worth a retry loop
    new["last_sample"] = {k: s[k] for k in ("available", "swap_used", "psi_some_avg60", "psi_full_avg60")}
    save_state(path, new)
    return {"pressure": pressure_reasons(s, opts), "sent": kind, "psi_available": s["psi_available"]}


# ------------------------------------------------------------------ pids limit

def _read_int(path: Path) -> int | None:
    try:
        return int(path.read_text().strip())
    except (OSError, ValueError):
        return None  # missing, unreadable, or "max" (unlimited)


def _refused(scope: Path) -> int:
    try:
        for line in (scope / "pids.events").read_text().splitlines():
            key, _, value = line.partition(" ")
            if key == "max":
                return int(value)
    except (OSError, ValueError):
        pass
    return 0


def sample_pids(root: Path = CGROUP_ROOT, containers: Path = DOCKER_CONTAINERS) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for cid, path in _scopes(root):
        current, limit = _read_int(path / "pids.current"), _read_int(path / "pids.max")
        if current is None or not limit:
            continue
        out[cid] = {"name": container_name(cid, containers), "current": current, "limit": limit,
                    "refused": _refused(path)}
    return out


def decide_pids(prev: dict[str, Any], samples: dict[str, dict[str, Any]], ratio: float) -> tuple[dict[str, Any], list[str]]:
    new: dict[str, Any] = {}
    messages: list[str] = []
    for cid, s in samples.items():
        old = prev.get(cid) if isinstance(prev.get(cid), dict) else {}
        over = s["current"] > ratio * s["limit"]
        seen = old.get("refused", s["refused"])  # first sighting is a baseline, not an alert
        if over and not old.get("over"):
            messages.append(f"{s['name']} is using {s['current']} of {s['limit']} tasks "
                            f"({100 * s['current'] // s['limit']}% of pids.max); new threads fail at the limit.")
        if s["refused"] > seen:
            messages.append(f"{s['name']}: the kernel refused a new task at pids.max={s['limit']} "
                            f"({s['refused'] - seen} refusal(s) since the last check).")
        new[cid] = {"over": over, "refused": s["refused"]}
    return new, messages


def check_pids(opts: dict[str, Any], sink, *, cgroup_root: Path = CGROUP_ROOT,
               containers: Path = DOCKER_CONTAINERS) -> dict[str, Any]:
    path = opts["state_dir"] / "pids.json"
    new, messages = decide_pids(load_state(path), sample_pids(cgroup_root, containers), opts["pids_warn_ratio"])
    failed = False
    if messages:
        try:
            sink.send("Container task limit warning:\n" + "\n".join(messages), kind="pids")
        except alerts.DeliveryError:
            failed = True
    if not failed:  # keep the old state on a failed send so the warning retries
        save_state(path, new)
    return {"pids_warnings": len(messages), "delivery_failed": failed}


def main(argv: list[str] | None = None, *, proc: Path = PROC, cgroup_root: Path = CGROUP_ROOT,
         containers: Path = DOCKER_CONTAINERS, now: Callable[[], float] = time.time, sink=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("command", choices=("check", "status"))
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--sink", choices=alerts.SINKS, help="override alert.sink")
    args = parser.parse_args(argv)
    os.umask(0o077)
    try:
        config = alerts.load_json(args.config)
        opts = settings(config)
        if args.command == "status":
            s = sample(proc)
            print(json.dumps({"sample": s, "pressure": pressure_reasons(s, opts)}, sort_keys=True))
            return 0
        if not opts["enabled"]:
            print(json.dumps({"result": "disabled", "reason": "memory.enabled is not true"}))
            return 3
        sink = sink or alerts.Sink.from_config(config, override=args.sink, source="switchroom-memory-alert")
    except ConfigError as exc:
        print(json.dumps({"result": "error", "reason": str(exc)}))
        return 2
    rc = 0
    checks = (lambda: check_memory(opts, sink, proc=proc, cgroup_root=cgroup_root, containers=containers, now=now),
              lambda: check_pids(opts, sink, cgroup_root=cgroup_root, containers=containers))
    for name, fn in zip(("memory", "pids"), checks):  # independent: one failing must not hide the other
        try:
            result = fn()
            print(json.dumps({"check": name, **result}, sort_keys=True), flush=True)
            if result.get("delivery_failed"):
                rc = 1
        except Exception as exc:  # noqa: BLE001 - one short reason for the journal
            print(json.dumps({"check": name, "result": "error", "reason": f"{type(exc).__name__}: {str(exc)[:160]}"}),
                  flush=True)
            rc = 1
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
