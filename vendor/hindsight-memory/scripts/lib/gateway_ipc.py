"""Minimal client for the switchroom telegram gateway's unix-socket IPC.

Used by the auto-recall hook to push status updates to the user's Telegram
draft during the silent gap between inbound and the agent's first tool
call. See `update_placeholder` in
`telegram-plugin/gateway/ipc-protocol.ts` for the wire format.

Why a separate, tiny client (instead of importing the existing bridge):
the recall hook is an ephemeral python subprocess invoked by Claude Code
on every UserPromptSubmit. The bridge (telegram-plugin/bridge/) is
TypeScript and lives inside the long-running claude process. Hooks can't
share the bridge connection. Each hook fire opens its own one-shot
unix-socket connection, sends one JSON line, closes. ~5 ms total.

Failure-tolerant by design: every error path returns silently. The
recall hook MUST NOT block on a Telegram UX nice-to-have.
"""

from __future__ import annotations

import json
import os
import re
import socket
from typing import Optional

# Same regex `bin/auto-recall-hook.sh` (now removed) used; mirrors the
# `<channel ...>` wrapper that telegram-plugin emits on inbound. Kept
# permissive — attribute order varies, attributes can be quoted with " or
# (rarely) ' depending on tooling.
_CHANNEL_OPEN_RE = re.compile(
    r"<channel\b[^>]*\bchat_id=[\"']([^\"']+)[\"'][^>]*>",
    re.IGNORECASE,
)


def extract_chat_id_from_prompt(prompt: str) -> Optional[str]:
    """Pull `chat_id` out of a `<channel ...>...</channel>` wrapper.

    Returns None when the prompt isn't channel-wrapped (e.g. interactive
    sessions, non-Telegram channels, or test fixtures). Caller should
    silently skip the IPC update when None — there's no user-visible
    draft to update.
    """
    if not prompt or not isinstance(prompt, str):
        return None
    # Inspect only the first 1 KB — the wrapper is always at the head;
    # anchoring there caps the regex cost regardless of prompt size.
    head = prompt[:1024]
    match = _CHANNEL_OPEN_RE.search(head)
    if not match:
        return None
    chat_id = match.group(1).strip()
    return chat_id or None


# Switchroom PR6a — extract topic context (chat_id + message_thread_id)
# from the `<channel ...>` envelope. message_thread_id is present only
# when the inbound came from a forum topic in a supergroup; for DMs and
# fleet-shared groups it's absent. Topic alias resolution is the
# caller's responsibility (env-injected JSON map of thread_id → alias).
_THREAD_ID_RE = re.compile(
    r"<channel\b[^>]*\bmessage_thread_id=[\"']([^\"']+)[\"']",
    re.IGNORECASE,
)


def extract_topic_from_prompt(
    prompt: str,
) -> tuple[Optional[str], Optional[str]]:
    """Pull (chat_id, message_thread_id) out of the channel envelope.

    Returns ``(None, None)`` when the prompt isn't channel-wrapped.
    Returns ``(chat_id, None)`` for DMs / non-forum chats where
    `message_thread_id` is absent.

    Both values are strings (mirroring the wire format — Telegram
    thread_ids are numeric but we keep them as strings for cache-key
    stability and config-map lookups).
    """
    chat_id = extract_chat_id_from_prompt(prompt)
    if chat_id is None:
        return None, None
    head = prompt[:1024] if isinstance(prompt, str) else ""
    tmatch = _THREAD_ID_RE.search(head)
    thread_id = tmatch.group(1).strip() if tmatch else None
    if thread_id == "":
        thread_id = None
    return chat_id, thread_id


def gateway_socket_path() -> Optional[str]:
    """Resolve the gateway socket path for the current agent.

    Order of resolution:
      1. SWITCHROOM_GATEWAY_SOCKET env var (explicit override).
      2. <agent_dir>/telegram/gateway.sock — the conventional path
         that gateway.ts uses by default.

    Returns None when neither is available; callers no-op on None.
    """
    explicit = os.environ.get("SWITCHROOM_GATEWAY_SOCKET", "").strip()
    if explicit:
        return explicit
    # CLAUDE_PLUGIN_DATA → <agent_dir>/.claude/plugins/data/<plugin>/.
    # Step up four to land at <agent_dir>.
    plugin_data = os.environ.get("CLAUDE_PLUGIN_DATA", "").strip()
    if plugin_data:
        agent_dir = os.path.normpath(os.path.join(plugin_data, "..", "..", "..", ".."))
        candidate = os.path.join(agent_dir, "telegram", "gateway.sock")
        if os.path.exists(candidate):
            return candidate
    return None


def update_placeholder(
    chat_id: str,
    text: str,
    *,
    socket_path: Optional[str] = None,
    timeout_secs: float = 0.25,
) -> bool:
    """Send an `update_placeholder` message to the gateway. Returns True
    on success (message written), False on any failure.

    Failure cases (all silent):
      - No socket path resolvable.
      - Socket connect refused / timeout.
      - Socket write fails (rare).

    Caller should never branch on the return value — it's purely for
    test introspection.
    """
    if not chat_id or not isinstance(chat_id, str):
        return False
    if not text or not isinstance(text, str):
        return False

    path = socket_path or gateway_socket_path()
    if path is None:
        return False

    payload = json.dumps({
        "type": "update_placeholder",
        "chatId": chat_id,
        "text": text,
    }) + "\n"

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout_secs)
    try:
        sock.connect(path)
        sock.sendall(payload.encode("utf-8"))
        return True
    except (FileNotFoundError, ConnectionRefusedError, OSError, socket.timeout):
        return False
    finally:
        try:
            sock.close()
        except OSError:
            pass
