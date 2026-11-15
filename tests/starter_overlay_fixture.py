"""A synthetic agent-container file layout for the starter overlay's readiness checks.

``full_container_root`` lays out, under a temporary directory, everything the
starter defaults look for with ``--check-files``: the mounted plugins, the
shared skill pack inside HERMES_HOME/skills, the op binary and a 1Password
mapping, a Claude login, the Linear token file and one coding-CLI login, and on
request Hermes' own ChatGPT or SuperGrok login in HERMES_HOME/auth.json. Every
file is synthetic and empty of real credentials. ``healthy_voice`` stands in
for a voice sidecar that answers.
"""
from __future__ import annotations

import json
from pathlib import Path

HERMES_HOME = "/opt/data"
SKILL_PACK = "/opt/data/skills/switchroom-shared"
PLUGINS = (("opt/hermes/plugins", "security-guidance"), ("opt/hermes/plugins", "disk-cleanup"),
           ("opt/data/plugins", "quota"), ("opt/data/plugins", "hermes-session-reset-policy"))
# The shape Claude Code writes on login; the values are placeholders.
CLAUDE_LOGIN = {"claudeAiOauth": {"accessToken": "synthetic-access", "refreshToken": "synthetic-refresh",
                                  "expiresAt": 0, "scopes": ["user:inference"]}}
# Hermes core's subscription providers (hermes_cli/auth_codex.py, auth_xai.py).
PLAN_PROVIDERS = {"chatgpt": "openai-codex", "grok": "xai-oauth"}


def auth_store(plans=(), *, pooled=(), api_keys=()) -> dict:
    """An auth.json shaped like Hermes writes it. ``plans`` get a provider-state
    OAuth login, ``pooled`` an OAuth credential-pool entry (``hermes auth add``),
    ``api_keys`` an API-key pool entry, which is never a plan login."""
    store: dict = {"version": 1, "providers": {}, "credential_pool": {}}
    for plan in plans:
        store["providers"][PLAN_PROVIDERS[plan]] = {
            "tokens": {"access_token": f"synthetic-{plan}-access", "refresh_token": f"synthetic-{plan}-refresh"},
            "last_refresh": "2026-01-01T00:00:00Z", "auth_mode": "chatgpt" if plan == "chatgpt" else "oauth_device_code"}
    for plan in pooled:
        store["credential_pool"].setdefault(PLAN_PROVIDERS[plan], []).append({
            "id": f"pool-{plan}", "source": "manual:device_code", "auth_type": "oauth",
            "access_token": f"synthetic-{plan}-pool-access", "refresh_token": f"synthetic-{plan}-pool-refresh"})
    for plan in api_keys:
        store["credential_pool"].setdefault(PLAN_PROVIDERS[plan], []).append({
            "id": f"key-{plan}", "source": "manual:api_key", "auth_type": "api_key",
            "access_token": f"synthetic-{plan}-api-key"})
    return store


def healthy_voice(url: str) -> None:
    """A voice probe for tests whose sidecar is up: the speech sidecar answers."""
    return None


def unreachable_voice(url: str) -> str:
    """A voice probe for tests whose sidecar does not answer."""
    return "the voice sidecar named by HERMES_KOKORO_SIDECAR_URL does not answer (URLError)"


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def full_container_root(base: Path, env: dict, *, plugins: bool = True, skills: bool = True, op: bool = True,
                        mapping: dict | None = None, claude_login: bool = True, linear_token: bool = True,
                        cli_login: bool = True, plans=(), pooled=(), api_keys=()) -> Path:
    root = Path(base) / "root"
    root.mkdir(parents=True, exist_ok=True)
    if plugins:
        for directory, name in PLUGINS:
            write(root / directory / name / "plugin.yaml", f"name: {name}\n")
    if skills:
        write(root / SKILL_PACK.lstrip("/") / "example-skill" / "SKILL.md", "---\nname: example-skill\n---\n")
    if op:
        write(root / "usr/local/bin/op", "")
    write(root / HERMES_HOME.lstrip("/") / "config.yaml", json.dumps(
        {"secrets": {"onepassword": {"enabled": True, "env": dict(mapping or {})}}}) + "\n")
    if claude_login and env.get("CLAUDE_CONFIG_DIR"):
        write(root / env["CLAUDE_CONFIG_DIR"].lstrip("/") / ".credentials.json", json.dumps(CLAUDE_LOGIN))
    if linear_token and env.get("LINEAR_TOKEN_FILE"):
        write(root / env["LINEAR_TOKEN_FILE"].lstrip("/"), "synthetic-token\n")
    if cli_login:
        home = env.get("HOME") or f"{HERMES_HOME}/home"
        write(root / home.lstrip("/") / ".codex" / "auth.json", "{}")
    if plans or pooled or api_keys:
        write(root / HERMES_HOME.lstrip("/") / "auth.json",
              json.dumps(auth_store(plans, pooled=pooled, api_keys=api_keys)))
    return root
