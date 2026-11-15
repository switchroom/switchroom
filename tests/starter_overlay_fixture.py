"""A synthetic agent-container file layout for the starter overlay's readiness checks.

``full_container_root`` lays out, under a temporary directory, everything the
starter defaults look for with ``--check-files``: the mounted plugins, the
shared skill pack inside HERMES_HOME/skills, the op binary and a 1Password
mapping, a Claude login, the Linear token file and one coding-CLI login. Every
file is synthetic and empty of real credentials.
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


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def full_container_root(base: Path, env: dict, *, plugins: bool = True, skills: bool = True, op: bool = True,
                        mapping: dict | None = None, claude_login: bool = True, linear_token: bool = True,
                        cli_login: bool = True) -> Path:
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
    return root
