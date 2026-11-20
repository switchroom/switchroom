#!/usr/bin/env python3
"""Stop Honcho deriving the user side of Kanban-dispatched sessions (HF-757).

A Kanban worker's "user" turns are the dispatcher's task brief, not a person
talking. The pinned plugin joins that session's user peer with the configured
``user_observe_me`` / ``user_observe_others`` (normally true), and a session-level
``SessionPeerConfig`` wins over any peer-level ``observe_me=false`` on the server
(``get_effective_observe_me``). The deriver then spends calls on the brief and
logs "zero observations".

The managed Kanban worker builds its agent with ``platform="kanban"`` (the policy
source), and that reaches ``MemoryProvider.initialize`` and the deferred
``_do_session_init`` kwargs. This script patches ``_do_session_init`` so a Kanban
session's manager starts with both user observation flags false, before the
session is created. They flow into ``add_peers`` and author joins exactly like
configured values. Messages are still saved, so session context and search keep
working, and the AI peer's flags are untouched, so the recall observer choice
does not change. Cron is already skipped by the plugin itself.

Fails closed when the pinned plugin no longer has the expected anchor.
"""
from __future__ import annotations

import sys
from pathlib import Path

MARKER = 'if kwargs.get("platform") == "kanban":'

_ANCHOR = (
    '            runtime_user_peer_name_alt=kwargs.get("user_id_alt") or None,\n'
    "        )\n"
    "        self._session_key = self._resolve_session_key(cfg, session_id, **kwargs)\n"
)
_PATCHED = (
    '            runtime_user_peer_name_alt=kwargs.get("user_id_alt") or None,\n'
    "        )\n"
    f"        {MARKER}\n"
    "            # HF-757: a Kanban run's user turns are the dispatcher's brief, not a person. Keep them\n"
    "            # saved (context, search) but never derive a representation from or for that peer.\n"
    "            self._manager._user_observe_me = self._manager._user_observe_others = False\n"
    "        self._session_key = self._resolve_session_key(cfg, session_id, **kwargs)\n"
)


def patch_source(source: str) -> str:
    if MARKER in source:
        return source  # already patched
    if source.count(_ANCHOR) != 1:
        raise SystemExit("honcho plugin: expected _do_session_init manager anchor not found once; review the pin")
    return source.replace(_ANCHOR, _PATCHED, 1)


def main(argv: list[str]) -> int:
    path = Path(argv[1] if len(argv) > 1 else "/opt/hermes/plugins/memory/honcho/__init__.py")
    path.write_text(patch_source(path.read_text(encoding="utf-8")), encoding="utf-8")
    print(f"patched {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
