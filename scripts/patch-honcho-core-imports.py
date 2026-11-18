#!/usr/bin/env python3
"""Point the pinned Honcho plugin at the Agent core's current homes for two names.

Nous main replaced the session store with the persistence interface and moved the
shared message rules into ``session_rules.turns``. The pinned plastic-labs plugin
(and its latest upstream revision) still imports the old locations:

- ``agent.skill_commands.extract_user_instruction_from_skill_message`` now lives in
  ``session_rules.turns`` with the same signature.
- ``hermes_state_common.TITLE_SOURCE_DERIVED`` / ``TITLE_SOURCE_LLM`` are gone; the
  public contract is ``persistence.conversation.sessions.TitleSource``. The Agent
  passes the provider ``session_title_source`` as the enum's string value, so the
  plugin keeps comparing strings.

Each replacement is exact and the script fails closed when the expected line is
missing, so a plugin pin that already changed these imports stops the bake for review
instead of being patched blindly. Drop this script once upstream ships the same fix.
"""
from __future__ import annotations

import sys
from pathlib import Path

REPLACEMENTS = {
    "__init__.py": (
        "from agent.skill_commands import extract_user_instruction_from_skill_message\n",
        "from session_rules.turns import extract_user_instruction_from_skill_message\n",
    ),
    "client.py": (
        "from hermes_state_common import TITLE_SOURCE_DERIVED, TITLE_SOURCE_LLM\n",
        "from persistence.conversation.sessions import TitleSource\n"
        "TITLE_SOURCE_DERIVED, TITLE_SOURCE_LLM = TitleSource.DERIVED.value, TitleSource.LLM.value\n",
    ),
}


def patch(plugin_dir: Path) -> None:
    for name, (old, new) in REPLACEMENTS.items():
        path = plugin_dir / name
        text = path.read_text(encoding="utf-8")
        if text.count(old) != 1:
            raise SystemExit(f"{path}: expected exactly one {old.strip()!r}; review the Honcho plugin pin")
        path.write_text(text.replace(old, new), encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: patch-honcho-core-imports.py <honcho-plugin-dir>")
    patch(Path(sys.argv[1]))
