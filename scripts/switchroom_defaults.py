"""Starter-overlay defaults: render an agent config and report each default.

Shared by ``scripts/render-overlay-config.py`` and ``scripts/switchroom-doctor.py``.

Inputs are an overlay ``fleet-config/`` directory (``schema.yaml``,
``defaults.yaml``, ``agents/<name>.yaml``), ``contracts/plugins.json`` and an
environment. The environment is used only as a set of variable *names* that
are set to a non-empty value; values are never read into output. Missing
credentials turn a default off in the rendered config instead of leaving a
config that would fail at agent start.
"""
from __future__ import annotations

import copy
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "contracts" / "plugins.json"
MAX_INPUT_BYTES = 1024 * 1024

SCHEMA_TYPES = {"str", "bool", "int", "list[str]", "list[provider]", "dict"}
DEFAULTS_DOC_KEYS = {"values", "granted_providers", "defaults"}
DEFAULT_ENTRY_KEYS = {"values", "off_values", "requires_env", "plugins", "model", "chain"}
AGENT_REQUIRED_KEYS = {"profile", "role", "apply_mode", "values"}
AGENT_OPTIONAL_KEYS = {"defaults", "granted_providers"}
ENV_NAME = re.compile(r"[A-Z][A-Z0-9_]{0,127}")
ENV_REF = re.compile(r"\$\{(?:env:)?([^}]*)\}")
PROFILE_NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
PROFILE_TOKEN = "{profile}"

# What each configured default needs at runtime, by contract id. The overlay's
# ``requires_env`` must match this table (tests enforce it), so the doctor can
# judge a rendered config without the overlay source.
REQUIREMENTS: dict[str, tuple[str, ...]] = {
    "doctrine-config": (),
    "gateway-per-agent": (),
    "model-roles": (),
    "claude-subscription-directsdk": ("CLAUDE_CONFIG_DIR",),
    "claude-acp-connectors": ("CLAUDE_CONFIG_DIR",),
    "linear": ("LINEAR_TOKEN_FILE", "LINEAR_VIEWER_ID", "LINEAR_ORGANIZATION_ID"),
    "voice": ("HERMES_KOKORO_SIDECAR_URL", "HERMES_KOKORO_SIDECAR_TOKEN"),
    "honcho-memory": ("HONCHO_BASE_URL",),
    "web-search": ("PERPLEXITY_API_KEY",),
}
# Optional file probes for the doctor's --check-files mode: (env var, file
# relative to the directory it names, or "" for the file it names itself).
FILE_PROBES: dict[str, tuple[str, str, str]] = {
    "claude-subscription-directsdk": ("CLAUDE_CONFIG_DIR", ".credentials.json", "no Claude login found in CLAUDE_CONFIG_DIR"),
    "claude-acp-connectors": ("CLAUDE_CONFIG_DIR", ".credentials.json", "no Claude login found in CLAUDE_CONFIG_DIR"),
    "linear": ("LINEAR_TOKEN_FILE", "", "the file named by LINEAR_TOKEN_FILE does not exist"),
}
MODEL_CHAIN_MEMBERS = ("claude-subscription-directsdk", "claude-acp-connectors")
DIRECTSDK_PROVIDER = "claude-subscription-directsdk-experimental"
DEGRADE_TEXT = {
    "disable_and_report": "disabled",
    "drop_from_chain_and_report": "dropped from the model chain",
    "text_only_and_report": "text-only replies",
    "builtin_memory_and_report": "using built-in memory",
    "default_web_backend_and_report": "using the default web backend",
    "use_env_file_and_report": "using the env file",
}


class DefaultsError(ValueError):
    """Invalid overlay, contract or rendered-config input."""


@dataclass
class Decision:
    on: bool
    reason: str = ""

    def line(self, default_id: str) -> str:
        return f"{default_id}: on" if self.on else f"{default_id}: off: {self.reason}"


@dataclass
class Rendered:
    agent: str
    config: dict[str, Any]
    leaves: dict[str, Any]
    decisions: dict[str, Decision]
    provenance: dict[str, str] = field(default_factory=dict)


# ---------------------------------------------------------------- loading

def _yaml():
    try:
        import yaml  # type: ignore
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise DefaultsError("PyYAML is required to read overlay YAML") from exc
    return yaml


def load_yaml(path: Path, label: str | None = None) -> dict[str, Any]:
    yaml = _yaml()
    label = label or str(path)

    # SafeLoader subclass: no Python object tags, plus a duplicate-key refusal.
    class UniqueKeyLoader(yaml.SafeLoader):
        pass

    def construct_mapping(loader, node, deep=False):
        result: dict[Any, Any] = {}
        for key_node, value_node in node.value:
            key = loader.construct_object(key_node, deep=deep)
            if key in result:
                raise DefaultsError(f"{label}: duplicate key {key!r}")
            result[key] = loader.construct_object(value_node, deep=deep)
        return result

    UniqueKeyLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, construct_mapping)
    try:
        if path.is_symlink() or not path.is_file():
            raise DefaultsError(f"{label}: not a regular file")
        raw = path.read_bytes()
        if len(raw) > MAX_INPUT_BYTES:
            raise DefaultsError(f"{label}: larger than {MAX_INPUT_BYTES} bytes")
        value = yaml.load(raw.decode("utf-8"), Loader=UniqueKeyLoader)
    except (OSError, UnicodeError, yaml.YAMLError) as exc:
        raise DefaultsError(f"{label}: unreadable YAML ({type(exc).__name__})") from exc
    if not isinstance(value, dict):
        raise DefaultsError(f"{label}: must contain a mapping")
    return value


def load_contract(path: Path = CONTRACT) -> list[dict[str, Any]]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        entries = document["public_base"]["default_set"]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise DefaultsError(f"{path}: unreadable default-on contract") from exc
    if not isinstance(entries, list) or not all(isinstance(e, dict) and isinstance(e.get("id"), str) for e in entries):
        raise DefaultsError(f"{path}: default_set must be a list of entries with ids")
    return entries


def env_names(environ: Mapping[str, str]) -> frozenset[str]:
    """Names of variables set to a non-empty value. Values are discarded."""
    return frozenset(name for name, value in environ.items() if ENV_NAME.fullmatch(name) and str(value).strip())


def read_env_file(path: Path) -> dict[str, str]:
    """Parse KEY=VALUE lines. Callers must pass the result to env_names only."""
    result: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise DefaultsError(f"{path}: unreadable env file") from exc
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        name, sep, value = line.partition("=")
        name = name.strip()
        if not sep or not ENV_NAME.fullmatch(name):
            raise DefaultsError(f"{path}:{number}: expected NAME=value")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        result[name] = value
    return result


# ------------------------------------------------------------- validation

def _check_type(path: str, value: Any, kind: str) -> None:
    if value is None:
        raise DefaultsError(f"{path}: null is ambiguous; omit the leaf instead")
    ok = {
        "str": lambda v: type(v) is str,
        "bool": lambda v: type(v) is bool,
        "int": lambda v: type(v) is int,
        "list[str]": lambda v: isinstance(v, list) and all(type(i) is str and i for i in v),
        "list[provider]": lambda v: isinstance(v, list) and all(
            isinstance(i, dict) and set(i) == {"provider", "model"}
            and all(type(s) is str and s.strip() for s in i.values()) for i in v),
        "dict": lambda v: isinstance(v, dict) and _no_nulls(v),
    }[kind]
    if not ok(value):
        raise DefaultsError(f"type mismatch at {path}: expected {kind}")


def _no_nulls(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, dict):
        return all(type(k) is str and _no_nulls(v) for k, v in value.items())
    if isinstance(value, list):
        return all(_no_nulls(v) for v in value)
    return True


def _validate_leaves(values: Any, schema: Mapping[str, str], label: str) -> dict[str, Any]:
    if values is None:
        return {}
    if not isinstance(values, dict):
        raise DefaultsError(f"{label}: values must be a mapping")
    for path, value in values.items():
        if type(path) is not str or path not in schema:
            raise DefaultsError(f"{label}: unknown leaf {path!r} (add it to schema.yaml first)")
        _check_type(f"{label}: {path}", value, schema[path])
    return dict(values)


def _env_refs(value: Any) -> set[str]:
    if isinstance(value, str):
        return set(ENV_REF.findall(value))
    if isinstance(value, dict):
        return set().union(*(_env_refs(v) for v in value.values())) if value else set()
    if isinstance(value, list):
        return set().union(*(_env_refs(v) for v in value)) if value else set()
    return set()


def _str_list(value: Any, label: str, pattern: re.Pattern[str] | None = None) -> list[str]:
    if not isinstance(value, list) or any(type(i) is not str or not i for i in value) or len(set(value)) != len(value):
        raise DefaultsError(f"{label}: must be a list of unique non-empty strings")
    if pattern is not None and any(not pattern.fullmatch(i) for i in value):
        raise DefaultsError(f"{label}: contains an invalid name")
    return list(value)


def load_schema(config_dir: Path) -> dict[str, str]:
    doc = load_yaml(config_dir / "schema.yaml", "schema.yaml")
    if set(doc) != {"schema_version", "managed_leaves"} or doc["schema_version"] != 1:
        raise DefaultsError("schema.yaml: expected schema_version 1 and managed_leaves")
    leaves = doc["managed_leaves"]
    if not isinstance(leaves, dict) or not leaves:
        raise DefaultsError("schema.yaml: managed_leaves must be a non-empty mapping")
    for path, kind in leaves.items():
        if type(path) is not str or kind not in SCHEMA_TYPES:
            raise DefaultsError(f"schema.yaml: {path!r} has unsupported type {kind!r}")
    names = sorted(leaves)
    for left, right in zip(names, names[1:]):
        if right.startswith(left + "."):
            raise DefaultsError(f"schema.yaml: {left} and {right} overlap")
    return dict(leaves)


def load_defaults(config_dir: Path, schema: Mapping[str, str], contract: list[dict[str, Any]]) -> dict[str, Any]:
    doc = load_yaml(config_dir / "defaults.yaml", "defaults.yaml")
    if "profile" in doc:
        raise DefaultsError("defaults.yaml: must not set profile")
    if not set(doc) <= DEFAULTS_DOC_KEYS:
        raise DefaultsError(f"defaults.yaml: unknown keys {sorted(set(doc) - DEFAULTS_DOC_KEYS)}")
    shared = _validate_leaves(doc.get("values"), schema, "defaults.yaml values")
    if _env_refs(shared):
        raise DefaultsError("defaults.yaml values: shared leaves must not reference environment variables")
    granted = _str_list(doc.get("granted_providers", []), "defaults.yaml granted_providers")
    contract_ids = [entry["id"] for entry in contract]
    entries = doc.get("defaults", {}) or {}
    if not isinstance(entries, dict):
        raise DefaultsError("defaults.yaml defaults: must be a mapping")
    owned: dict[str, str] = {path: "values" for path in shared}
    parsed: dict[str, dict[str, Any]] = {}
    for default_id, entry in entries.items():
        label = f"defaults.yaml defaults.{default_id}"
        if default_id not in contract_ids:
            raise DefaultsError(f"{label}: not in the reviewed default set")
        if not isinstance(entry, dict) or not set(entry) <= DEFAULT_ENTRY_KEYS:
            raise DefaultsError(f"{label}: unknown keys")
        requires = _str_list(entry.get("requires_env", []), f"{label}.requires_env", ENV_NAME)
        plugins = _str_list(entry.get("plugins", []), f"{label}.plugins")
        values = _validate_leaves(entry.get("values"), schema, f"{label}.values")
        off_values = _validate_leaves(entry.get("off_values"), schema, f"{label}.off_values")
        if not requires and off_values:
            raise DefaultsError(f"{label}: off_values need requires_env")
        stray = _env_refs(values) - set(requires)
        if stray or _env_refs(off_values):
            raise DefaultsError(f"{label}: may only reference its own requires_env variables")
        for path in set(values) | set(off_values):
            if path in owned and owned[path] != default_id:
                raise DefaultsError(f"{label}: {path} is already set by {owned[path]}")
            owned[path] = default_id
        model = entry.get("model")
        if model is not None and (not isinstance(model, dict) or set(model) != {"provider", "model"}
                                  or any(type(v) is not str or not v for v in model.values())):
            raise DefaultsError(f"{label}.model: needs provider and model strings")
        chain = entry.get("chain")
        if chain is not None:
            chain = _str_list(chain, f"{label}.chain")
        parsed[default_id] = {"requires_env": requires, "plugins": plugins, "values": values,
                              "off_values": off_values, "model": model, "chain": chain}
    for default_id, entry in parsed.items():
        for member in entry["chain"] or []:
            if parsed.get(member, {}).get("model") is None:
                raise DefaultsError(f"defaults.yaml defaults.{default_id}.chain: {member} has no model")
    for reserved in ("model.provider", "model.default", "fallback_providers", "plugins.enabled"):
        if reserved in owned:
            raise DefaultsError(f"defaults.yaml: {reserved} is built by the renderer; do not set it here")
    order = {default_id: index for index, default_id in enumerate(contract_ids)}
    return {"values": shared, "granted_providers": granted,
            "defaults": dict(sorted(parsed.items(), key=lambda item: order[item[0]]))}


def load_agent(config_dir: Path, agent: str, schema: Mapping[str, str], defaults: Mapping[str, Any]) -> dict[str, Any]:
    if not PROFILE_NAME.fullmatch(agent):
        raise DefaultsError(f"invalid agent name {agent!r}")
    source = f"agents/{agent}.yaml"
    doc = load_yaml(config_dir / "agents" / f"{agent}.yaml", source)
    keys = set(doc)
    if not AGENT_REQUIRED_KEYS <= keys or not keys <= AGENT_REQUIRED_KEYS | AGENT_OPTIONAL_KEYS:
        raise DefaultsError(f"{source}: needs profile, role, apply_mode and values (optional: defaults, granted_providers)")
    if doc["profile"] != agent:
        raise DefaultsError(f"{source}: profile must be {agent!r}")
    values = _validate_leaves(doc.get("values"), schema, f"{source} values")
    if _env_refs(values):
        raise DefaultsError(f"{source} values: must not reference environment variables")
    opt = doc.get("defaults", {}) or {}
    if not isinstance(opt, dict):
        raise DefaultsError(f"{source} defaults: must map a default id to true or false")
    for default_id, enabled in opt.items():
        if default_id not in defaults["defaults"]:
            raise DefaultsError(f"{source} defaults: {default_id!r} is not configured in defaults.yaml")
        if type(enabled) is not bool:
            raise DefaultsError(f"{source} defaults.{default_id}: must be true or false")
    granted = doc.get("granted_providers")
    if granted is not None:
        granted = _str_list(granted, f"{source} granted_providers")
        extra = set(granted) - set(defaults["granted_providers"])
        if extra:
            raise DefaultsError(f"{source} granted_providers: may only narrow the shared grant, not add {sorted(extra)}")
    return {"values": values, "defaults": dict(opt), "granted_providers": granted, "source": source}


# --------------------------------------------------------------- rendering

def _unflatten(leaves: Mapping[str, Any]) -> dict[str, Any]:
    root: dict[str, Any] = {}
    for path, value in sorted(leaves.items()):
        cursor = root
        parts = path.split(".")
        for part in parts[:-1]:
            nxt = cursor.setdefault(part, {})
            if not isinstance(nxt, dict):
                raise DefaultsError(f"leaf {path} collides with another leaf")
            cursor = nxt
        if parts[-1] in cursor:
            raise DefaultsError(f"leaf {path} collides with another leaf")
        cursor[parts[-1]] = copy.deepcopy(value)
    return root


def _substitute_profile(value: Any, agent: str) -> Any:
    if isinstance(value, str):
        return value.replace(PROFILE_TOKEN, agent)
    if isinstance(value, dict):
        return {k: _substitute_profile(v, agent) for k, v in value.items()}
    if isinstance(value, list):
        return [_substitute_profile(v, agent) for v in value]
    return value


def render(config_dir: Path, agent: str, environ_names: Iterable[str], contract_path: Path = CONTRACT) -> Rendered:
    """Render one agent's managed config leaves for the given set-variable names."""
    names = frozenset(environ_names)
    contract = load_contract(contract_path)
    schema = load_schema(config_dir)
    defaults = load_defaults(config_dir, schema, contract)
    spec = load_agent(config_dir, agent, schema, defaults)
    granted = spec["granted_providers"] if spec["granted_providers"] is not None else defaults["granted_providers"]

    leaves: dict[str, Any] = dict(defaults["values"])
    provenance = {path: "defaults.yaml values" for path in leaves}
    decisions: dict[str, Decision] = {}
    plugins: list[str] = []
    models: dict[str, dict[str, str]] = {}

    for default_id, entry in defaults["defaults"].items():
        if entry["chain"] is not None:
            continue
        missing = [name for name in entry["requires_env"] if name not in names]
        model = entry["model"]
        if spec["defaults"].get(default_id) is False:
            decision = Decision(False, f"turned off in {spec['source']}")
        elif missing:
            decision = Decision(False, f"{', '.join(missing)} not set")
        elif model is not None and model["provider"] not in granted:
            decision = Decision(False, f"provider {model['provider']} is not granted")
        else:
            decision = Decision(True)
        decisions[default_id] = decision
        chosen = entry["values"] if decision.on else entry["off_values"]
        for path, value in chosen.items():
            leaves[path] = copy.deepcopy(value)
            provenance[path] = f"defaults.yaml defaults.{default_id}" + ("" if decision.on else " (off)")
        if decision.on:
            plugins.extend(p for p in entry["plugins"] if p not in plugins)
            if model is not None:
                models[default_id] = model

    for default_id, entry in defaults["defaults"].items():
        if entry["chain"] is None:
            continue
        chain = [models[member] for member in entry["chain"] if member in models]
        # Opting out of model roles hands model selection back to the agent's
        # own values: no main model or fallbacks are rendered.
        opted_out = spec["defaults"].get(default_id) is False
        if chain and not opted_out:
            leaves["model.provider"] = chain[0]["provider"]
            leaves["model.default"] = chain[0]["model"]
            provenance["model.provider"] = provenance["model.default"] = f"defaults.yaml defaults.{default_id}"
            fallbacks = [dict(m) for m in chain[1:]]
            if fallbacks:
                leaves["fallback_providers"] = fallbacks
                provenance["fallback_providers"] = f"defaults.yaml defaults.{default_id}"
        if opted_out:
            decisions[default_id] = Decision(False, f"turned off in {spec['source']}")
        elif not chain:
            decisions[default_id] = Decision(False, "no granted model provider is available")
        else:
            decisions[default_id] = Decision(True)

    if plugins:
        leaves["plugins.enabled"] = plugins
        provenance["plugins.enabled"] = "defaults.yaml defaults"
    for path, value in spec["values"].items():
        leaves[path] = copy.deepcopy(value)
        provenance[path] = spec["source"]

    decisions = {default_id: decisions[default_id] for default_id in defaults["defaults"]}
    leaves = {path: _substitute_profile(value, agent) for path, value in leaves.items()}
    for path, value in leaves.items():
        _check_type(path, value, schema[path])
    unresolved = _env_refs(leaves) - names
    if unresolved:
        raise DefaultsError(f"rendered config references unset variables: {sorted(unresolved)}")
    return Rendered(agent, _unflatten(leaves), leaves, decisions, provenance)


def dump_config(rendered: Rendered) -> str:
    return _yaml().safe_dump(rendered.config, sort_keys=True, default_flow_style=False, allow_unicode=True)


# ------------------------------------------------------------------ doctor

def _get(config: Mapping[str, Any], path: str) -> Any:
    cursor: Any = config
    for part in path.split("."):
        if not isinstance(cursor, dict) or part not in cursor:
            return None
        cursor = cursor[part]
    return cursor


def _plugins(config: Mapping[str, Any]) -> list[str]:
    value = _get(config, "plugins.enabled")
    return [p for p in value if isinstance(p, str)] if isinstance(value, list) else []


def _settings_enabled(config: Mapping[str, Any], plugin: str) -> bool:
    return _get(config, f"plugins.entries.{plugin}.settings.enabled") is True


def configured_on(default_id: str, config: Mapping[str, Any]) -> bool | None:
    """Whether a rendered config turns a default on. None: not a starter-overlay default."""
    plugins = _plugins(config)
    checks = {
        "doctrine-config": lambda: bool(_get(config, "agent.system_prompt"))
        and _get(config, "agent.verify_on_stop") is True
        and _get(config, "approvals.mode") == "smart"
        and all(_get(config, f"approvals.{k}") == "deny" for k in ("cron_mode", "unattended_mode", "single_query_mode"))
        and _get(config, "display.busy_input_mode") == "queue",
        "gateway-per-agent": lambda: _get(config, "gateway.multiplex_profiles") is False,
        "model-roles": lambda: isinstance(_get(config, "model.provider"), str) and bool(_get(config, "model.provider")),
        "claude-subscription-directsdk": lambda: DIRECTSDK_PROVIDER in plugins,
        "claude-acp-connectors": lambda: "claude-acp-provider" in plugins and "claude-account-connectors" in plugins
        and _settings_enabled(config, "claude-account-connectors"),
        "linear": lambda: "linear" in plugins and _settings_enabled(config, "linear"),
        "voice": lambda: "kokoro-voice" in plugins and _get(config, "tts.provider") == "kokoro",
        "honcho-memory": lambda: _get(config, "memory.provider") == "honcho",
        "web-search": lambda: "web-perplexity" in plugins and _get(config, "web.search_backend") == "perplexity",
    }
    check = checks.get(default_id)
    return None if check is None else bool(check())


def _settings_problem(default_id: str, config: Mapping[str, Any]) -> str | None:
    """Why a plugin would refuse the settings of a default that is turned on, or None."""
    if default_id == "linear":
        identity = _get(config, "plugins.entries.linear.settings.identity")
        if not isinstance(identity, dict) or any(
                not isinstance(identity.get(key), str) or not identity[key].strip()
                for key in ("viewer_id", "organization_id")):
            return "plugins.entries.linear.settings.identity needs viewer_id and organization_id"
    return None


def _file_probe_failed(default_id: str, environ: Mapping[str, str]) -> str | None:
    probe = FILE_PROBES.get(default_id)
    if probe is None:
        return None
    name, relative, message = probe
    base = Path(str(environ.get(name, "")))
    target = base / relative if relative else base
    return None if target.is_file() else message


def diagnose(config: Mapping[str, Any], environ: Mapping[str, str], contract_path: Path = CONTRACT,
             *, check_files: bool = False, granted: Iterable[str] | None = None) -> tuple[list[str], list[str]]:
    """Return (one status line per contract default, hard problems).

    Hard problems are contract violations, not degraded defaults.
    """
    if not isinstance(config, dict):
        raise DefaultsError("rendered config must be a mapping")
    names = env_names(environ)
    lines: list[str] = []
    problems: list[str] = []
    for entry in load_contract(contract_path):
        default_id = entry["id"]
        state = configured_on(default_id, config)
        behaviour = (entry.get("degrade") or {}).get("behaviour", "disable_and_report")
        degrade = DEGRADE_TEXT.get(behaviour, "disabled")
        if entry.get("starter_overlay") != "configured" or state is None:
            lines.append(Decision(False, "not configured by the starter overlay yet").line(default_id))
            continue
        missing = [name for name in REQUIREMENTS.get(default_id, ()) if name not in names]
        if default_id == "model-roles":
            if state:
                decision = Decision(True)
            elif not any(set(REQUIREMENTS[member]) <= names for member in MODEL_CHAIN_MEMBERS):
                decision = Decision(False, "no granted model provider is available; Hermes keeps its own model setting")
            else:
                decision = Decision(False, "turned off in this agent's config")
        elif missing:
            decision = Decision(False, f"{degrade}: {', '.join(missing)} not set")
        elif not state:
            decision = Decision(False, "turned off in this agent's config")
        elif settings_problem := _settings_problem(default_id, config):
            decision = Decision(False, f"{degrade}: {settings_problem}")
        elif check_files and (failed := _file_probe_failed(default_id, environ)):
            decision = Decision(False, f"{degrade}: {failed}")
        else:
            decision = Decision(True)
        lines.append(decision.line(default_id))
    if granted is not None:
        allowed = set(granted)
        providers = [_get(config, "model.provider")]
        fallbacks = _get(config, "fallback_providers")
        if isinstance(fallbacks, list):
            providers.extend(item.get("provider") for item in fallbacks if isinstance(item, dict))
        for provider in providers:
            if provider is not None and provider not in allowed:
                problems.append(f"model provider {provider} is not in the granted list")
    if _get(config, "gateway.multiplex_profiles") is True:
        problems.append("gateway.multiplex_profiles is true; each agent must run its own gateway")
    return lines, problems


def environ_from(env_file: Path | None, use_process_env: bool) -> dict[str, str]:
    environ: dict[str, str] = dict(os.environ) if use_process_env else {}
    if env_file is not None:
        environ.update(read_env_file(env_file))
    return environ
