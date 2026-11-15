#!/usr/bin/env python3
"""Check that every agent reads only its own 1Password secret references.

Input is a secret-reference map (schema ``switchroom-secret-references/1``,
see ``examples/overlay-repo/ops-kit/secret-reference-map.schema.json``) that
says, for each agent, which vaults it owns and which environment variable is
filled from which vault item. Optionally it also reads each agent's own
Hermes ``config.yaml`` and compares the live ``secrets.onepassword.env``
mapping with the map.

It reports:

* ``cross-agent``: an agent reads from a vault another agent owns, and the
  item is not listed under ``shared`` for that agent;
* ``unowned-vault``: an agent reads from a vault nobody owns and nothing shares;
* ``vault-owned-twice``: two agents claim the same vault;
* ``literal-value``: a config maps a variable to something that is not a
  secret reference (very likely a pasted secret);
* ``unmapped``, ``mismatch``, ``missing``: the config and the map disagree.

It **never resolves a reference and never prints a value**. It does not run
``op``, does not open a network connection and does not read a secret store.
Findings name the agent, the variable and the vault, nothing else; a literal
value found in a config is reported by variable name only.

Exit codes: 0 no findings, 1 findings, 2 config or usage error.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

SCHEMA = "switchroom-secret-references/1"
AGENT_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
ENV_RE = re.compile(r"^[A-Z_][A-Z0-9_]{0,127}$")
SEGMENT_RE = re.compile(r"^[^/\s\x00-\x1f\x7f](?:[^/\x00-\x1f\x7f]*[^/\s\x00-\x1f\x7f])?$")
# Built from parts so this file never contains a literal reference prefix.
REFERENCE_SCHEME = "o" + "p" + "://"


class MapError(ValueError):
    pass


def _segment(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SEGMENT_RE.fullmatch(value) or len(value) > 200:
        raise MapError(f"{label} must be a non-empty name without '/' or control characters")
    return value


def load_map(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise MapError(f"cannot read {path}: {exc.strerror or exc}") from exc
    except json.JSONDecodeError as exc:
        raise MapError(f"{path} is not valid JSON: {exc.msg}") from exc
    if not isinstance(data, dict) or data.get("schema") != SCHEMA:
        raise MapError(f"schema must be {SCHEMA}")
    unknown = set(data) - {"schema", "agents", "shared", "description"}
    if unknown:
        raise MapError(f"unknown top-level key: {', '.join(sorted(unknown))}")
    agents = data.get("agents")
    if not isinstance(agents, dict) or not agents:
        raise MapError("agents must be a non-empty object")
    clean: dict[str, Any] = {"agents": {}, "shared": []}
    for name, detail in agents.items():
        if not AGENT_RE.fullmatch(str(name)) or not isinstance(detail, dict):
            raise MapError(f"invalid agent entry: {name!r}")
        vaults = detail.get("vaults", [])
        if not isinstance(vaults, list):
            raise MapError(f"agents.{name}.vaults must be a list")
        refs = detail.get("references", {})
        if not isinstance(refs, dict):
            raise MapError(f"agents.{name}.references must be an object")
        clean_refs = {}
        for env, ref in refs.items():
            if not ENV_RE.fullmatch(str(env)):
                raise MapError(f"agents.{name}.references has an invalid variable name: {env!r}")
            if not isinstance(ref, dict) or set(ref) - {"vault", "item", "section", "field"}:
                raise MapError(f"agents.{name}.references.{env} must be {{vault, item, [section], field}}")
            parsed = {"vault": _segment(ref.get("vault"), f"agents.{name}.references.{env}.vault"),
                      "item": _segment(ref.get("item"), f"agents.{name}.references.{env}.item"),
                      "field": _segment(ref.get("field"), f"agents.{name}.references.{env}.field")}
            if "section" in ref:
                parsed["section"] = _segment(ref["section"], f"agents.{name}.references.{env}.section")
            clean_refs[env] = parsed
        clean["agents"][name] = {
            "vaults": [_segment(v, f"agents.{name}.vaults[]") for v in vaults],
            "references": clean_refs,
        }
    shared = data.get("shared", [])
    if not isinstance(shared, list):
        raise MapError("shared must be a list")
    for index, entry in enumerate(shared):
        if not isinstance(entry, dict) or set(entry) - {"vault", "item", "readers", "reason"}:
            raise MapError(f"shared[{index}] must be {{vault, item, readers, [reason]}}")
        readers = entry.get("readers")
        if not isinstance(readers, list) or len(readers) < 2 or len(set(readers)) != len(readers):
            raise MapError(f"shared[{index}].readers must list at least two distinct agents")
        missing = [r for r in readers if r not in clean["agents"]]
        if missing:
            raise MapError(f"shared[{index}].readers names an unknown agent: {', '.join(map(str, missing))}")
        clean["shared"].append({"vault": _segment(entry.get("vault"), f"shared[{index}].vault"),
                                "item": _segment(entry.get("item"), f"shared[{index}].item"),
                                "readers": list(readers)})
    return clean


def parse_reference(value: Any) -> dict[str, str] | None:
    """Split a reference string into parts without resolving it. None if it is not one."""
    if not isinstance(value, str) or not value.startswith(REFERENCE_SCHEME):
        return None
    body = value[len(REFERENCE_SCHEME):].split("?", 1)[0]
    parts = body.split("/")
    if len(parts) not in (3, 4) or not all(SEGMENT_RE.fullmatch(p) for p in parts):
        return None
    ref = {"vault": parts[0], "item": parts[1], "field": parts[-1]}
    if len(parts) == 4:
        ref["section"] = parts[2]
    return ref


def _owners(secret_map: dict[str, Any]) -> dict[str, list[str]]:
    owners: dict[str, list[str]] = {}
    for name, detail in secret_map["agents"].items():
        for vault in detail["vaults"]:
            owners.setdefault(vault, []).append(name)
    return owners


def _access(secret_map: dict[str, Any], owners: dict[str, list[str]], agent: str, env: str,
            ref: dict[str, str], source: str) -> dict[str, Any] | None:
    owned_by = owners.get(ref["vault"], [])
    if agent in owned_by:
        return None
    for entry in secret_map["shared"]:
        if entry["vault"] == ref["vault"] and entry["item"] == ref["item"] and agent in entry["readers"]:
            return None
    finding = {"agent": agent, "env": env, "vault": ref["vault"], "source": source}
    if owned_by:
        return {**finding, "kind": "cross-agent", "owner": ",".join(sorted(owned_by))}
    return {**finding, "kind": "unowned-vault"}


def audit_map(secret_map: dict[str, Any]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    owners = _owners(secret_map)
    for vault, names in sorted(owners.items()):
        if len(names) > 1:
            findings.append({"kind": "vault-owned-twice", "vault": vault, "agents": sorted(names)})
    for agent, detail in sorted(secret_map["agents"].items()):
        for env, ref in sorted(detail["references"].items()):
            finding = _access(secret_map, owners, agent, env, ref, "map")
            if finding:
                findings.append(finding)
    return findings


def _load_config(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if path.suffix == ".json":
        data = json.loads(text)
    else:
        try:
            import yaml  # type: ignore
            data = yaml.safe_load(text)
        except ImportError:
            try:
                from ruamel.yaml import YAML  # type: ignore
            except ImportError as exc:
                raise MapError("reading config.yaml needs PyYAML or ruamel.yaml") from exc
            data = YAML(typ="safe").load(text)
    return data if isinstance(data, dict) else {}


def audit_config(secret_map: dict[str, Any], agent: str, config: dict[str, Any]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    owners = _owners(secret_map)
    expected = secret_map["agents"][agent]["references"]
    secrets = config.get("secrets") if isinstance(config.get("secrets"), dict) else {}
    onepassword = secrets.get("onepassword") if isinstance(secrets.get("onepassword"), dict) else {}
    env = onepassword.get("env") if isinstance(onepassword.get("env"), dict) else {}
    for name in sorted(env, key=str):
        value = env[name]
        ref = parse_reference(value)
        if ref is None:
            # Report the variable only. The value may be a pasted secret.
            findings.append({"agent": agent, "env": str(name), "kind": "literal-value", "source": "config"})
            continue
        if name not in expected:
            findings.append({"agent": agent, "env": name, "kind": "unmapped", "vault": ref["vault"], "source": "config"})
        elif ref != expected[name]:
            findings.append({"agent": agent, "env": name, "kind": "mismatch", "vault": ref["vault"], "source": "config"})
        finding = _access(secret_map, owners, agent, name, ref, "config")
        if finding:
            findings.append(finding)
    for name in sorted(set(expected) - set(env)):
        findings.append({"agent": agent, "env": name, "kind": "missing", "source": "config"})
    return findings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument("--map", type=Path, required=True, help="secret-reference map (JSON)")
    parser.add_argument("--agent-config", action="append", default=[], metavar="AGENT=PATH",
                        help="also compare this agent's own Hermes config.yaml (repeatable)")
    args = parser.parse_args(argv)
    try:
        secret_map = load_map(args.map)
        findings = audit_map(secret_map)
        checked = []
        for raw in args.agent_config:
            agent, sep, path = raw.partition("=")
            if not sep or agent not in secret_map["agents"] or not path:
                raise MapError(f"--agent-config must be AGENT=PATH for an agent in the map: {agent or raw!r}")
            try:
                config = _load_config(Path(path))
            except (OSError, ValueError) as exc:
                raise MapError(f"cannot read the config for {agent}: {type(exc).__name__}") from None
            findings.extend(audit_config(secret_map, agent, config))
            checked.append(agent)
    except MapError as exc:
        print(json.dumps({"result": "error", "reason": str(exc)}))
        return 2
    print(json.dumps({"schema": "switchroom-secret-reference-audit/1",
                      "status": "ok" if not findings else "findings",
                      "agents": sorted(secret_map["agents"]), "configs_checked": sorted(checked),
                      "resolved_values": 0, "findings": findings}, indent=2, sort_keys=True))
    return 0 if not findings else 1


if __name__ == "__main__":
    raise SystemExit(main())
