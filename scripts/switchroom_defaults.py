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
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

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
    "secrets-connect": ("OP_CONNECT_HOST", "OP_CONNECT_TOKEN"),
    "coding-clis": (),
    "model-roles": (),
    "claude-subscription-directsdk": ("CLAUDE_CONFIG_DIR",),
    "claude-acp-connectors": ("CLAUDE_CONFIG_DIR",),
    "linear": ("LINEAR_TOKEN_FILE", "LINEAR_VIEWER_ID", "LINEAR_ORGANIZATION_ID"),
    "voice": ("HERMES_KOKORO_SIDECAR_URL", "HERMES_KOKORO_SIDECAR_TOKEN"),
    "honcho-memory": ("HONCHO_BASE_URL",),
    "web-search": ("PERPLEXITY_API_KEY",),
    "quota": (),
    "session-reset-policy": (),
    "security-guidance": (),
    "disk-cleanup": (),
    "shared-skill-pack": (),
}
# Overlay-only declarations live under one top-level key Hermes treats as
# internal (a leading underscore) and never reads.
CONNECT_DEFAULT = "secrets-connect"
SECRETS_SOURCE_LEAF = "_switchroom.secrets_source"
CONNECT_PROVIDES_LEAF = "_switchroom.connect_provides"
CODING_CLIS_LEAF = "_switchroom.coding_clis"
CONNECT_SOURCE = "onepassword_connect"
ENV_FILE_SOURCE = "env_file"
# Coding CLIs installed in the Fleet image (package.json), and where each keeps its
# login file: inside the directory a variable names when that variable is set,
# else at a HOME-relative path. A login file is evidence, not proof, of a
# working login.
CODING_CLI_LOGINS: dict[str, tuple[str | None, str, str]] = {
    "claude": ("CLAUDE_CONFIG_DIR", ".credentials.json", ".claude/.credentials.json"),
    "codex": ("CODEX_HOME", "auth.json", ".codex/auth.json"),
    "grok": (None, "", ".grok/auth.json"),
    "opencode": ("XDG_DATA_HOME", "opencode/auth.json", ".local/share/opencode/auth.json"),
}
BUNDLED_PLUGINS = "/opt/hermes/plugins"
OP_BINARY = "/usr/local/bin/op"
DISK_CLEANUP_MODE = "report_only"
DISK_CLEANUP_MANUAL_DELETE = "plugins.config.disk-cleanup.allow_manual_delete"
SESSION_RESET_MODES = frozenset({"idle", "daily", "both"})
# Plugin each default needs on disk inside the container, for --check-files:
# (directory the plugin lives in, relative to "bundled" or "user" plugins).
PLUGIN_PROBES: dict[str, tuple[str, str]] = {
    "quota": ("user", "quota"),
    "session-reset-policy": ("user", "hermes-session-reset-policy"),
    "security-guidance": ("bundled", "security-guidance"),
    "disk-cleanup": ("bundled", "disk-cleanup"),
}
# Defaults whose credential is a file inside the agent container: (env var,
# file relative to the directory it names or "" for the file it names itself,
# reason when it is missing, what it is). A variable naming the place is not a
# login, so these render on only when the file was actually seen; without
# file access (a render on the host) they render off.
LOGIN_PROBES: dict[str, tuple[str, str, str, str]] = {
    "claude-subscription-directsdk": ("CLAUDE_CONFIG_DIR", ".credentials.json",
                                      "no Claude login found in CLAUDE_CONFIG_DIR", "the Claude login"),
    "claude-acp-connectors": ("CLAUDE_CONFIG_DIR", ".credentials.json",
                              "no Claude login found in CLAUDE_CONFIG_DIR", "the Claude login"),
    "linear": ("LINEAR_TOKEN_FILE", "", "the file named by LINEAR_TOKEN_FILE does not exist", "the Linear token file"),
}
# Why a credential file that does exist is still not usable, by default id.
LOGIN_EMPTY = {"linear": "the file named by LINEAR_TOKEN_FILE is empty"}
LOGIN_TOO_LARGE = {"linear": "the file named by LINEAR_TOKEN_FILE is too large to be a token"}
CHECK_FILES_HINT = "run with --check-files where the agent's files are visible (inside its container)"
MAX_LOGIN_BYTES = 1024 * 1024
MODEL_CHAIN_MEMBERS = ("claude-subscription-directsdk", "claude-acp-connectors")
DIRECTSDK_PROVIDER = "claude-subscription-directsdk-experimental"
# Main-model provider -> the default that turns it on.
MODEL_PROVIDER_DEFAULTS = {DIRECTSDK_PROVIDER: "claude-subscription-directsdk", "claude-acp": "claude-acp-connectors"}
NO_MODEL_PROVIDER = "no granted model provider is available; Hermes keeps its own model setting"
# Where the shared skill pack is mounted. Hermes searches HERMES_HOME/skills
# recursively and reads skills.external_dirs only from the agent's own
# config.yaml (agent/skill_utils.py), never from the managed layer, so the pack
# lives inside the agent's own skills directory.
SKILL_PACK_LEAF = "_switchroom.skill_pack"
DEFAULT_SKILL_PACK = "/opt/data/skills/switchroom-shared"
# Directories Hermes skips while walking a skills root (agent/skill_utils.py).
SKILL_WALK_EXCLUDED = frozenset({
    ".git", ".github", ".hub", ".archive", ".curator_backups", ".locks", ".venv", "venv", "node_modules",
    "site-packages", "__pycache__", ".tox", ".nox", ".pytest_cache", ".mypy_cache", ".ruff_cache"})
# Voice is on only when its speech sidecar answers, and only the agent's own
# network can see it (inside its container, --check-files). These are the
# health routes the kokoro-voice plugin uses: a URL ending in /v1 names an
# OpenAI-compatible server (the CPU Kokoro-FastAPI build, speech only) that
# answers {"status": "healthy"} on /health; the Fleet GPU sidecar answers
# {"ok": true, "tts": true, ...} on /healthz.
VOICE_URL_VAR = "HERMES_KOKORO_SIDECAR_URL"
VOICE_PROBE_TIMEOUT = 3.0
VOICE_STT_PROVIDER = "kokoro_sidecar"
VOICE_UNCHECKED = "the voice sidecar was not checked"
# The contract guard a default must carry before a component it covers may be
# on: its local sidecar is configured and reachable, and nothing falls back to
# a hosted service.
ENABLE_GUARD = {"sidecar": "configured_and_reachable", "hosted_fallback": False}
# Hermes text-to-speech engines that send text to a hosted service. With voice
# off none of them may be the configured engine, and an unset tts.provider
# means Hermes' own default, edge, which is hosted.
HOSTED_TTS = frozenset({"edge", "elevenlabs", "openai", "nous", "minimax", "xai", "mistral", "gemini", "deepinfra"})
HERMES_DEFAULT_TTS = "edge"
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
    # False when the decision is "off" only because a file could not be looked at.
    checked: bool = True

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

def _yaml_backend() -> tuple[str, Any]:
    """PyYAML when installed, else ruamel.yaml, which the Hermes image ships.

    The Hermes image has no PyYAML, so the setup check run inside an agent
    container reads YAML with the same library Hermes itself uses.
    """
    try:
        import yaml  # type: ignore
        return "pyyaml", yaml
    except ImportError:
        pass
    try:
        import ruamel.yaml  # type: ignore
        return "ruamel", ruamel.yaml
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise DefaultsError("reading YAML needs PyYAML or ruamel.yaml (the Hermes image ships ruamel.yaml)") from exc


def _parse_yaml(text: str, label: str) -> Any:
    kind, module = _yaml_backend()
    if kind == "ruamel":
        # Safe, pure loader; duplicate keys raise. YAML 1.1 matches PyYAML and Hermes.
        loader = module.YAML(typ="safe", pure=True)
        loader.version = (1, 1)
        try:
            return loader.load(text)
        except module.constructor.DuplicateKeyError as exc:
            raise DefaultsError(f"{label}: duplicate key") from exc
        except module.YAMLError as exc:
            raise DefaultsError(f"{label}: unreadable YAML ({type(exc).__name__})") from exc

    # SafeLoader subclass: no Python object tags, plus a duplicate-key refusal.
    class UniqueKeyLoader(module.SafeLoader):
        pass

    def construct_mapping(loader, node, deep=False):
        result: dict[Any, Any] = {}
        for key_node, value_node in node.value:
            key = loader.construct_object(key_node, deep=deep)
            if key in result:
                raise DefaultsError(f"{label}: duplicate key {key!r}")
            result[key] = loader.construct_object(value_node, deep=deep)
        return result

    UniqueKeyLoader.add_constructor(module.resolver.BaseResolver.DEFAULT_MAPPING_TAG, construct_mapping)
    try:
        return module.load(text, Loader=UniqueKeyLoader)
    except module.YAMLError as exc:
        raise DefaultsError(f"{label}: unreadable YAML ({type(exc).__name__})") from exc


def load_yaml(path: Path, label: str | None = None) -> dict[str, Any]:
    label = label or str(path)
    try:
        if path.is_symlink() or not path.is_file():
            raise DefaultsError(f"{label}: not a regular file")
        raw = path.read_bytes()
        if len(raw) > MAX_INPUT_BYTES:
            raise DefaultsError(f"{label}: larger than {MAX_INPUT_BYTES} bytes")
        value = _parse_yaml(raw.decode("utf-8"), label)
    except (OSError, UnicodeError) as exc:
        raise DefaultsError(f"{label}: unreadable YAML ({type(exc).__name__})") from exc
    if not isinstance(value, dict):
        raise DefaultsError(f"{label}: must contain a mapping")
    return value


def _sorted_tree(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _sorted_tree(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [_sorted_tree(item) for item in value]
    return value


def dump_yaml(document: Mapping[str, Any]) -> str:
    kind, module = _yaml_backend()
    if kind == "pyyaml":
        return module.safe_dump(dict(document), sort_keys=True, default_flow_style=False, allow_unicode=True)
    import io
    dumper = module.YAML(typ="safe", pure=True)
    dumper.default_flow_style = False
    dumper.allow_unicode = True
    dumper.width = 4096
    stream = io.StringIO()
    dumper.dump(_sorted_tree(dict(document)), stream)
    return stream.getvalue()


def load_contract(path: Path = CONTRACT) -> list[dict[str, Any]]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        entries = document["public_base"]["default_set"]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise DefaultsError(f"{path}: unreadable default-on contract") from exc
    if not isinstance(entries, list) or not all(isinstance(e, dict) and isinstance(e.get("id"), str) for e in entries):
        raise DefaultsError(f"{path}: default_set must be a list of entries with ids")
    if problems := component_default_problems(document):
        raise DefaultsError(f"{path}: {problems[0]}")
    return entries


def component_default_problems(document: Any) -> list[str]:
    """The contract rule for components that are on (``default_enabled``).

    A component may be on only when a ``shipped`` default covers it and every
    shipped default covering it carries :data:`ENABLE_GUARD`: its local
    sidecar must be configured and reachable before it turns on, and nothing
    falls back to a hosted service. ``default_enabled`` is the truthful "on
    today" bit, so a component a guarded shipped default covers must say
    ``true``, and every other component ``false``.
    """
    problems: list[str] = []
    base = document.get("public_base") if isinstance(document, dict) else None
    defaults = base.get("default_set") if isinstance(base, dict) else None
    components = document.get("components", []) if isinstance(document, dict) else None
    if not isinstance(defaults, list) or not isinstance(components, list):
        return problems
    covering: dict[str, list[dict[str, Any]]] = {}
    for entry in defaults:
        if isinstance(entry, dict) and entry.get("status") == "shipped":
            for cid in entry.get("covers") or []:
                covering.setdefault(cid, []).append(entry)
    for component in components:
        if not isinstance(component, dict):
            continue
        cid = str(component.get("id"))
        owners = covering.get(cid, [])
        unguarded = [str(e.get("id")) for e in owners if e.get("enable_guard") != ENABLE_GUARD]
        if not owners:
            if component.get("default_enabled") is not False:
                problems.append(f"component {cid} is default_enabled but no shipped default covers it")
        elif unguarded:
            problems.append(f"component {cid} is covered by shipped default {', '.join(unguarded)} without "
                            "the enable guard (sidecar configured_and_reachable, no hosted fallback)")
        elif component.get("default_enabled") is not True:
            problems.append(f"component {cid} is covered by a guarded shipped default but default_enabled is not true")
    return problems


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
        if CONNECT_PROVIDES_LEAF in off_values or (CONNECT_PROVIDES_LEAF in values and default_id != CONNECT_DEFAULT):
            raise DefaultsError(f"{label}: only {CONNECT_DEFAULT} may set {CONNECT_PROVIDES_LEAF}")
        if CONNECT_PROVIDES_LEAF in values:
            provided = values[CONNECT_PROVIDES_LEAF]
            if any(not ENV_NAME.fullmatch(name) for name in provided) or set(provided) & set(requires):
                raise DefaultsError(f"{label}: {CONNECT_PROVIDES_LEAF} must list other variable names")
        if CODING_CLIS_LEAF in values and not set(values[CODING_CLIS_LEAF]) <= set(CODING_CLI_LOGINS):
            raise DefaultsError(f"{label}: {CODING_CLIS_LEAF} may only name {sorted(CODING_CLI_LOGINS)}")
        chain = entry.get("chain")
        if chain is not None:
            chain = _str_list(chain, f"{label}.chain")
        parsed[default_id] = {"requires_env": requires, "plugins": plugins, "values": values,
                              "off_values": off_values, "model": model, "chain": chain}
    for default_id, entry in parsed.items():
        for member in entry["chain"] or []:
            if parsed.get(member, {}).get("model") is None:
                raise DefaultsError(f"defaults.yaml defaults.{default_id}.chain: {member} has no model")
    if CONNECT_PROVIDES_LEAF in shared or SECRETS_SOURCE_LEAF in shared:
        raise DefaultsError(f"defaults.yaml values: {CONNECT_DEFAULT} owns the secret-source leaves")
    for reserved in ("model.provider", "model.default", "fallback_providers", "plugins.enabled"):
        if reserved in owned:
            raise DefaultsError(f"defaults.yaml: {reserved} is built by the renderer; do not set it here")
    order = {default_id: index for index, default_id in enumerate(contract_ids)}
    # The shared defaults must never opt every agent into manual deletion;
    # only one agent's own file may set it, and the setup check warns.
    for label, leaves in [("values", shared)] + [
            (f"defaults.{default_id}.{kind}", entry[kind])
            for default_id, entry in parsed.items() for kind in ("values", "off_values")]:
        if manual_delete_allowed(_unflatten(leaves)):
            raise DefaultsError(f"defaults.yaml {label}: {DISK_CLEANUP_MANUAL_DELETE} may only be set "
                                "in one agent's own file")
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
    if CONNECT_PROVIDES_LEAF in values or SECRETS_SOURCE_LEAF in values:
        raise DefaultsError(f"{source} values: {CONNECT_DEFAULT} owns the secret-source leaves")
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


def render(config_dir: Path, agent: str, environ_names: Iterable[str], contract_path: Path = CONTRACT, *,
           environ: Mapping[str, str] | None = None, paths: "ContainerPaths | None" = None) -> Rendered:
    """Render one agent's managed config leaves for the given set-variable names.

    Each default goes through :func:`readiness`, the same check the setup check
    uses. ``paths`` gives access to the agent container's files (``--check-files``);
    ``environ`` supplies the values of the path variables those checks read.
    Without ``paths`` a default whose credential is a file (a Claude login, the
    Linear token file) renders off, because a variable naming it is not a login.
    """
    names = frozenset(environ_names)
    environ = dict(environ or {})
    contract = load_contract(contract_path)
    schema = load_schema(config_dir)
    defaults = load_defaults(config_dir, schema, contract)
    spec = load_agent(config_dir, agent, schema, defaults)
    granted = spec["granted_providers"] if spec["granted_providers"] is not None else defaults["granted_providers"]

    def ready(default_id: str, entry: Mapping[str, Any], known: frozenset[str]) -> Decision:
        values = entry["values"]
        return readiness(default_id, known, environ=environ, paths=paths,
                         requires=entry["requires_env"],
                         connect_provides=values.get(CONNECT_PROVIDES_LEAF, []),
                         coding_clis=values.get(CODING_CLIS_LEAF, []),
                         skill_pack=values.get(SKILL_PACK_LEAF))

    # Variables 1Password Connect supplies at start count as set while Connect
    # itself is on, so the defaults that need them are rendered on.
    connect = defaults["defaults"].get(CONNECT_DEFAULT)
    if (connect is not None and spec["defaults"].get(CONNECT_DEFAULT) is not False
            and ready(CONNECT_DEFAULT, connect, names).on):
        names = names | frozenset(connect["values"].get(CONNECT_PROVIDES_LEAF, []))

    leaves: dict[str, Any] = dict(defaults["values"])
    provenance = {path: "defaults.yaml values" for path in leaves}
    decisions: dict[str, Decision] = {}
    plugins: list[str] = []
    models: dict[str, dict[str, str]] = {}

    for default_id, entry in defaults["defaults"].items():
        if entry["chain"] is not None:
            continue
        model = entry["model"]
        if spec["defaults"].get(default_id) is False:
            decision = Decision(False, f"turned off in {spec['source']}")
        elif not (decision := ready(default_id, entry, names)).on:
            pass
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
            decisions[default_id] = Decision(False, NO_MODEL_PROVIDER)
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
    config = _unflatten(leaves)
    for problem in (disk_cleanup_problem(config), hosted_speech_problem(config)):
        if problem:
            raise DefaultsError(problem)
    return Rendered(agent, config, leaves, decisions, provenance)


def dump_config(rendered: Rendered) -> str:
    return dump_yaml(rendered.config)


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
        "secrets-connect": lambda: _get(config, SECRETS_SOURCE_LEAF) == CONNECT_SOURCE,
        "coding-clis": lambda: bool(_coding_clis(config)),
        "model-roles": lambda: isinstance(_get(config, "model.provider"), str) and bool(_get(config, "model.provider")),
        "claude-subscription-directsdk": lambda: DIRECTSDK_PROVIDER in plugins,
        "claude-acp-connectors": lambda: "claude-acp-provider" in plugins and "claude-account-connectors" in plugins
        and _settings_enabled(config, "claude-account-connectors"),
        "linear": lambda: "linear" in plugins and _settings_enabled(config, "linear"),
        "voice": lambda: "kokoro-voice" in plugins and _get(config, "tts.provider") == "kokoro",
        "honcho-memory": lambda: _get(config, "memory.provider") == "honcho",
        "web-search": lambda: "web-perplexity" in plugins and _get(config, "web.search_backend") == "perplexity",
        "quota": lambda: "quota" in plugins,
        "session-reset-policy": lambda: "hermes-session-reset-policy" in plugins,
        "security-guidance": lambda: "security-guidance" in plugins,
        "disk-cleanup": lambda: "disk-cleanup" in plugins,
        "shared-skill-pack": lambda: _skill_pack(config) is not None,
    }
    check = checks.get(default_id)
    return None if check is None else bool(check())


def _coding_clis(config: Mapping[str, Any]) -> list[str]:
    value = _get(config, CODING_CLIS_LEAF)
    return [c for c in value if isinstance(c, str)] if isinstance(value, list) else []


def _skill_pack(config: Mapping[str, Any]) -> str | None:
    value = _get(config, SKILL_PACK_LEAF)
    return value if isinstance(value, str) and value else None


def _connect_provides(config: Mapping[str, Any]) -> list[str]:
    value = _get(config, CONNECT_PROVIDES_LEAF)
    return [n for n in value if isinstance(n, str) and ENV_NAME.fullmatch(n)] if isinstance(value, list) else []


def disk_cleanup_problem(config: Mapping[str, Any]) -> str | None:
    """A problem when disk-cleanup is on but could delete files at session end.

    The plugin treats a missing setting as its historical ``cleanup`` mode, so
    the starter overlay must always render ``report_only`` next to it.
    """
    if "disk-cleanup" not in _plugins(config):
        return None
    if _get(config, "plugins.config.disk-cleanup.session_end_mode") != DISK_CLEANUP_MODE:
        return ("disk-cleanup is on without plugins.config.disk-cleanup.session_end_mode: report_only; "
                "it would delete files at session end")
    return None


def manual_delete_allowed(config: Mapping[str, Any]) -> bool:
    """Whether a config lets chat users run the deleting /disk-cleanup quick and deep.

    The Fleet copy of the plugin refuses them in report_only unless this is
    exactly true (plugins/disk-cleanup/UPSTREAM.json, manual-delete-guard).
    """
    return _get(config, DISK_CLEANUP_MANUAL_DELETE) is True


def hosted_speech_problem(config: Mapping[str, Any]) -> str | None:
    """A problem when voice is off but Hermes could still speak through a hosted service.

    Off means text-only: no text_to_speech tool for the model and no engine
    that sends text out. Hermes' own default engine, edge, is hosted, and it
    synthesises with whatever ``tts.provider`` names when a voice reply is
    asked for, so voice off must name a local engine and disable the tts
    toolset. Only checked when the config has the starter's voice setting.

    Voice on means the local sidecar only: transcription, unless turned off,
    must name the sidecar's own provider, so Hermes never picks a hosted one.
    The CPU Kokoro server has no transcription and reports it unavailable;
    that is the end of it, not a fallback.
    """
    if configured_on("voice", config):
        stt = _get(config, "stt.provider")
        if _get(config, "stt.enabled") is not False and stt != VOICE_STT_PROVIDER:
            shown = stt if isinstance(stt, str) and stt.strip() else "unset"
            return (f"voice is on but stt.provider is {shown}, not {VOICE_STT_PROVIDER}; "
                    "transcription could fall back to a hosted service")
        return None
    if _get(config, "stt.enabled") is not False:
        return None
    provider = _get(config, "tts.provider")
    engine = provider.strip().lower() if isinstance(provider, str) and provider.strip() else HERMES_DEFAULT_TTS
    if engine in HOSTED_TTS:
        shown = provider if isinstance(provider, str) and provider.strip() else f"unset (Hermes uses {HERMES_DEFAULT_TTS})"
        return f"voice is off but tts.provider is {shown}, a hosted speech service"
    disabled = _get(config, "agent.disabled_toolsets")
    if not isinstance(disabled, list) or "tts" not in disabled:
        return "voice is off but the tts toolset is not in agent.disabled_toolsets"
    return None


def _settings_problem(default_id: str, config: Mapping[str, Any], hermes_home: str) -> str | None:
    """Why a plugin would refuse, or silently ignore, the settings of a default that is on."""
    if default_id == "linear":
        identity = _get(config, "plugins.entries.linear.settings.identity")
        if not isinstance(identity, dict) or any(
                not isinstance(identity.get(key), str) or not identity[key].strip()
                for key in ("viewer_id", "organization_id")):
            return "plugins.entries.linear.settings.identity needs viewer_id and organization_id"
    if default_id == "session-reset-policy":
        # The plugin skips a policy it cannot read instead of failing, which
        # would leave it loaded but never resetting.
        policy = _get(config, "session_reset")
        if not isinstance(policy, dict) or policy.get("mode") not in SESSION_RESET_MODES:
            return "session_reset.mode must be idle, daily or both"
        minutes = policy.get("idle_minutes")
        if policy["mode"] in ("idle", "both") and (
                type(minutes) not in (int, float) or isinstance(minutes, bool) or minutes <= 0):
            return "session_reset.idle_minutes must be a positive number"
        hour = policy.get("at_hour")
        if policy["mode"] in ("daily", "both") and (type(hour) is not int or not 0 <= hour <= 23):
            return "session_reset.at_hour must be an hour from 0 to 23"
    if default_id == "shared-skill-pack":
        return _skill_pack_location_problem(_skill_pack(config), hermes_home)
    if default_id == "coding-clis":
        unknown = sorted(set(_coding_clis(config)) - set(CODING_CLI_LOGINS))
        if unknown:
            return f"no login check for {', '.join(unknown)}"
    return None


@dataclass
class ContainerPaths:
    """Where the readiness checks look inside the agent container (``--check-files``).

    ``root`` prefixes every absolute path, so tests can point it at a
    temporary directory laid out like the container.
    """

    root: Path = Path("/")
    hermes_home: str = "/opt/data"
    # How the voice sidecar is asked whether it answers: given its URL, None
    # when it is healthy, else why not. Default: a real HTTP health request.
    voice_probe: Callable[[str], str | None] | None = None

    def at(self, path: str | Path) -> Path:
        return self.root / str(path).lstrip("/")

    def plugin_dir(self, where: str, name: str) -> Path:
        base = BUNDLED_PLUGINS if where == "bundled" else f"{self.hermes_home}/plugins"
        return self.at(f"{base}/{name}")


def _hermes_skills_dir(hermes_home: str) -> str:
    return f"{hermes_home.rstrip('/')}/skills"


def _skill_pack_location_problem(pack: str | None, hermes_home: str) -> str | None:
    """Hermes finds a skill only under HERMES_HOME/skills (or external_dirs in the agent's own config.yaml)."""
    if pack is None:
        return f"{SKILL_PACK_LEAF} is not set"
    root = _hermes_skills_dir(hermes_home)
    normal = os.path.normpath(pack)
    if not pack.startswith("/") or normal == root or not normal.startswith(root + "/"):
        return f"{pack} is outside {root}, where Hermes looks for skills"
    return None


def discovered_skills(paths: ContainerPaths, directory: str) -> list[Path]:
    """SKILL.md files Hermes' own walk of its skills root finds under ``directory``.

    Mirrors ``agent.skill_utils.iter_skill_index_files`` over HERMES_HOME/skills:
    symlinks followed, excluded directories and a skill's support directories
    pruned. A pack mounted anywhere else is not found.
    """
    root = paths.at(_hermes_skills_dir(paths.hermes_home))
    target = paths.at(directory)
    found: list[Path] = []
    for current, dirs, files in os.walk(root, followlinks=True):
        has_skill = "SKILL.md" in files
        dirs[:] = [d for d in dirs if d not in SKILL_WALK_EXCLUDED
                   and not (has_skill and d in ("references", "templates", "assets", "scripts"))]
        if has_skill:
            path = Path(current) / "SKILL.md"
            if target == path.parent or target in path.parents:
                found.append(path)
    return sorted(found)


def claude_login_present(target: Path) -> bool:
    """Whether ``target`` is a real Claude Code login. Contents are never printed.

    A login is the OAuth record Claude Code keeps in ``.credentials.json``
    with an access or refresh token; an empty, oversized or placeholder file
    is not one. The ONE check behind both Claude defaults and
    ``coding-clis.claude``.
    """
    try:
        if not target.is_file():
            return False
        size = target.stat().st_size
        if size == 0 or size > MAX_LOGIN_BYTES:
            return False
        record = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        return False
    oauth = record.get("claudeAiOauth") if isinstance(record, dict) else None
    return isinstance(oauth, dict) and any(
        isinstance(oauth.get(key), str) and oauth[key].strip() for key in ("accessToken", "refreshToken"))


def _login_problem(default_id: str, environ: Mapping[str, str], paths: ContainerPaths) -> str | None:
    """Why the login file a default needs is not usable, or None. Contents are never printed.

    A Claude login must pass :func:`claude_login_present`. The Linear token
    file must exist and be non-empty; an empty file is reported as empty.
    """
    name, relative, absent, _ = LOGIN_PROBES[default_id]
    raw = str(environ.get(name, "")).strip()
    if not raw:
        return absent
    target = paths.at(Path(raw) / relative if relative else raw)
    if relative == ".credentials.json":
        return None if claude_login_present(target) else absent
    try:
        if not target.is_file():
            return absent
        size = target.stat().st_size
    except OSError:
        return absent
    if size == 0:
        return LOGIN_EMPTY.get(default_id, absent)
    if size > MAX_LOGIN_BYTES:
        return LOGIN_TOO_LARGE.get(default_id, absent)
    return None


def voice_health_url(url: str) -> str:
    """The health route the kokoro-voice plugin itself reads for this sidecar URL."""
    base = url.strip().rstrip("/")
    if urllib.parse.urlparse(base).path.rstrip("/").endswith("/v1"):
        return base[: -len("/v1")] + "/health"
    return base + "/healthz"


def probe_voice_sidecar(url: str, timeout: float = VOICE_PROBE_TIMEOUT) -> str | None:
    """None when the speech sidecar at ``url`` answers healthy for speech, else why not.

    Like every other reason, it names the variable, never its value. No token
    is sent: both health routes are open, as the kokoro-voice plugin expects.
    """
    parsed = urllib.parse.urlparse(url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        return f"{VOICE_URL_VAR} is not an http(s) host URL"
    # Straight to the sidecar on the agent's own network, never through a proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(voice_health_url(url), timeout=timeout) as response:
            body = json.loads(response.read(64 * 1024).decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, UnicodeError) as exc:
        return f"the voice sidecar named by {VOICE_URL_VAR} does not answer ({type(exc).__name__})"
    healthy = isinstance(body, dict) and (
        body.get("status") == "healthy" or (body.get("ok") is True and body.get("tts") is True))
    return None if healthy else f"the voice sidecar named by {VOICE_URL_VAR} is not healthy for speech"


def _skills_dir_problem(paths: ContainerPaths) -> str | None:
    """The agent must keep write access to its own skills directory.

    A read-only pack mounted inside it must not cost the agent its own
    skills: if Docker created the mount point's parent, it is root's and
    ``skill_manage`` fails. Checked as the user running the check, which
    inside the agent container is the agent user.
    """
    skills = _hermes_skills_dir(paths.hermes_home)
    target = paths.at(skills)
    try:
        info = target.stat()
    except OSError:
        return None
    if os.access(target, os.W_OK | os.X_OK):
        return None
    return (f"the agent cannot write {skills} (owned by uid {info.st_uid}), so it cannot save its own skills; "
            "create the pack's mount point as the agent user before it starts (the overlay's skills-init)")


def _connect_probe_failed(provides: Iterable[str], paths: ContainerPaths) -> str | None:
    """Connect needs the op binary and a mapping for every variable it should supply.

    Hermes reads ``secrets.onepassword`` only from the agent's own config.yaml,
    so that is the file checked. Mapped references are never printed.
    """
    if not paths.at(OP_BINARY).is_file():
        return f"the op CLI is not at {OP_BINARY}"
    user_config = paths.at(f"{paths.hermes_home}/config.yaml")
    try:
        document = load_yaml(user_config, "agent config.yaml")
    except DefaultsError:
        document = {}
    onepassword = _get(document, "secrets.onepassword")
    if not isinstance(onepassword, dict) or onepassword.get("enabled") is not True:
        return "secrets.onepassword is not enabled in the agent's own config.yaml"
    mapped = onepassword.get("env") if isinstance(onepassword.get("env"), dict) else {}
    unmapped = [name for name in provides if not isinstance(mapped.get(name), str) or not mapped[name].strip()]
    if unmapped:
        return f"no 1Password reference mapped for {', '.join(unmapped)}"
    return None


def _cli_login(cli: str, environ: Mapping[str, str], paths: ContainerPaths) -> bool:
    variable, inside, home_relative = CODING_CLI_LOGINS[cli]
    directory = str(environ.get(variable, "")).strip() if variable else ""
    if directory:
        target = paths.at(Path(directory) / inside)
    else:
        home = str(environ.get("HOME", "")).strip() or f"{paths.hermes_home}/home"
        target = paths.at(Path(home) / home_relative)
    if cli == "claude":
        # The same real-login check the Claude defaults use: a 0-byte or
        # placeholder file is not a login.
        return claude_login_present(target)
    return target.is_file()


def readiness(default_id: str, names: Iterable[str], *, environ: Mapping[str, str] | None = None,
              paths: ContainerPaths | None = None, requires: Iterable[str] | None = None,
              connect_provides: Iterable[str] = (), coding_clis: Iterable[str] = (),
              skill_pack: str | None = None) -> Decision:
    """Whether a default's prerequisites are in place: the ONE check behind both
    the renderer's on/off choice and the setup check's line.

    ``names`` are the variables set to a non-empty value. ``paths`` is access to
    the agent container's files; ``None`` means the files cannot be seen (a
    render on the host). Then a default whose credential is a file is off,
    unchecked, and the mounts are not looked at. Opt-outs, grants and the
    rendered settings are the callers' business.
    """
    names = frozenset(names)
    environ = environ or {}
    required = tuple(REQUIREMENTS.get(default_id, ()) if requires is None else requires)
    missing = [name for name in required if name not in names]
    if missing:
        return Decision(False, f"{', '.join(missing)} not set")
    hermes_home = paths.hermes_home if paths is not None else "/opt/data"
    if (default_id == "shared-skill-pack" and skill_pack is not None
            and (problem := _skill_pack_location_problem(skill_pack, hermes_home))):
        return Decision(False, problem)
    if default_id in LOGIN_PROBES:
        _, _, absent, what = LOGIN_PROBES[default_id]
        if paths is None:
            return Decision(False, f"{what} was not checked; {CHECK_FILES_HINT}", checked=False)
        if problem := _login_problem(default_id, environ, paths):
            return Decision(False, problem)
    if default_id == "voice":
        # Configured is not enough: voice is on only when the local sidecar
        # answers, seen from the agent's own network. A render that cannot
        # look (on the host) leaves voice off, text-only, never hosted.
        if paths is None:
            return Decision(False, f"{VOICE_UNCHECKED}; {CHECK_FILES_HINT}", checked=False)
        ask = paths.voice_probe or probe_voice_sidecar
        if problem := ask(str(environ.get(VOICE_URL_VAR, ""))):
            return Decision(False, problem)
    if paths is None:
        return Decision(True)
    probe = PLUGIN_PROBES.get(default_id)
    if probe is not None:
        where, name = probe
        if not (paths.plugin_dir(where, name) / "plugin.yaml").is_file():
            base = BUNDLED_PLUGINS if where == "bundled" else f"{paths.hermes_home}/plugins"
            return Decision(False, f"plugin {name} is not present at {base}/{name}")
    if default_id == "shared-skill-pack":
        # A config rendered with the pack off no longer names it: look where the starter mounts it.
        pack = skill_pack or DEFAULT_SKILL_PACK
        if not discovered_skills(paths, pack):
            return Decision(False, f"Hermes finds no skills in {pack}; mount the pinned skill pack there")
        if problem := _skills_dir_problem(paths):
            return Decision(False, problem)
    if default_id == CONNECT_DEFAULT and (failed := _connect_probe_failed(connect_provides, paths)):
        return Decision(False, failed)
    if default_id == "coding-clis":
        clis = [c for c in coding_clis if c in CODING_CLI_LOGINS]
        if not any(_cli_login(cli, environ, paths) for cli in clis):
            return Decision(False, "no coding CLI login found")
    return Decision(True)


def _model_roles_line(config: Mapping[str, Any], decisions: Mapping[str, Decision], degrade: str) -> Decision:
    """model-roles is on only when the main provider Hermes will use is itself on."""
    members_on = [member for member in MODEL_CHAIN_MEMBERS if decisions.get(member, Decision(False)).on]
    main = _get(config, "model.provider")
    if not members_on:
        return Decision(False, NO_MODEL_PROVIDER)
    if not isinstance(main, str) or not main:
        return Decision(False, "turned off in this agent's config")
    owner = MODEL_PROVIDER_DEFAULTS.get(main)
    if owner is None:
        return Decision(False, "turned off in this agent's config")
    if owner not in members_on:
        return Decision(False, f"{degrade}: the main provider {main} is off ({owner})")
    return Decision(True)


def diagnose(config: Mapping[str, Any], environ: Mapping[str, str], contract_path: Path = CONTRACT,
             *, check_files: bool = False, granted: Iterable[str] | None = None,
             paths: ContainerPaths | None = None) -> tuple[list[str], list[str]]:
    """Return (one status line per contract default, hard problems).

    Every line comes from :func:`readiness`, the same check the renderer used,
    given the same evidence: without ``check_files`` the files are not looked
    at. Hard problems are contract violations, not degraded defaults. With
    ``check_files`` the coding-clis line is followed by one line per CLI.
    """
    if not isinstance(config, dict):
        raise DefaultsError("rendered config must be a mapping")
    paths = paths or ContainerPaths()
    evidence = paths if check_files else None
    names = env_names(environ)
    lines: list[str] = []
    problems: list[str] = []

    def ready(default_id: str, known: frozenset[str]) -> Decision:
        return readiness(default_id, known, environ=environ, paths=evidence,
                         connect_provides=_connect_provides(config), coding_clis=_coding_clis(config),
                         skill_pack=_skill_pack(config))

    if configured_on(CONNECT_DEFAULT, config) and ready(CONNECT_DEFAULT, names).on:
        names = names | frozenset(_connect_provides(config))
    entries = load_contract(contract_path)
    decisions: dict[str, Decision] = {}
    extras: dict[str, list[str]] = {}
    for entry in entries:
        default_id = entry["id"]
        state = configured_on(default_id, config)
        behaviour = (entry.get("degrade") or {}).get("behaviour", "disable_and_report")
        degrade = DEGRADE_TEXT.get(behaviour, "disabled")
        if entry.get("starter_overlay") != "configured" or state is None or default_id == "model-roles":
            continue
        extra: list[str] = []
        prepared = ready(default_id, names)
        if not prepared.on and not (state and not prepared.checked):
            decision = Decision(False, f"{degrade}: {prepared.reason}")
        elif not state:
            prefix = f"{degrade}: " if default_id == CONNECT_DEFAULT else ""
            decision = Decision(False, f"{prefix}turned off in this agent's config")
        elif settings_problem := _settings_problem(default_id, config, paths.hermes_home):
            decision = Decision(False, f"{degrade}: {settings_problem}")
        elif default_id == "coding-clis" and check_files:
            for cli in _coding_clis(config):
                ok = _cli_login(cli, environ, paths)
                extra.append(Decision(ok, f"{degrade}: no {cli} login found").line(f"coding-clis.{cli}"))
            decision = Decision(True)
        else:
            # On. Without --check-files a file-backed default rendered on is
            # trusted: the renderer only turns one on after seeing its file.
            decision = Decision(True)
        if default_id == "disk-cleanup" and state and manual_delete_allowed(config):
            extra.append(f"warning: disk-cleanup: {DISK_CLEANUP_MANUAL_DELETE} is true; any allowed chat "
                         "user can run /disk-cleanup quick or deep, which delete tracked files")
        decisions[default_id] = decision
        extras[default_id] = extra
    for entry in entries:
        default_id = entry["id"]
        state = configured_on(default_id, config)
        if entry.get("starter_overlay") != "configured" or state is None:
            lines.append(Decision(False, "not configured by the starter overlay yet").line(default_id))
            continue
        if default_id == "model-roles":
            behaviour = (entry.get("degrade") or {}).get("behaviour", "disable_and_report")
            decisions[default_id] = _model_roles_line(config, decisions, DEGRADE_TEXT.get(behaviour, "disabled"))
        lines.append(decisions[default_id].line(default_id))
        lines.extend(extras.get(default_id, []))
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
    if cleanup := disk_cleanup_problem(config):
        problems.append(cleanup)
    if speech := hosted_speech_problem(config):
        problems.append(speech)
    if isinstance(_get(config, "skills.external_dirs"), list):
        problems.append("skills.external_dirs is set in the managed config, which Hermes never reads for skills; "
                        f"mount the pack under {_hermes_skills_dir(paths.hermes_home)} instead")
    return lines, problems


def environ_from(env_file: Path | None, use_process_env: bool) -> dict[str, str]:
    environ: dict[str, str] = dict(os.environ) if use_process_env else {}
    if env_file is not None:
        environ.update(read_env_file(env_file))
    return environ
