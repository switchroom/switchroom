"""camoufox-desktop: make the official camofox plugin a first-class Bot Desktop browser.

The image runs camofox-browser as a supervised local service (loopback, access key) that opens
Camoufox headed on the Bot Desktop. The official ``camofox`` plugin drives it, but knows nothing of
the desktop. This plugin adds, without patching either:

* a lease fence: while a human holds Take over, the camofox tools and ``browser_vault`` writes are
  refused, so the agent waits instead of typing over the human;
* desktop liveness: a camofox tool call starts the screen when it is down (``bot_desktop.auto_start``)
  and stamps activity, so idle-stop does not close a window the agent is using;
* hand-back: the first turn after the human hands back is told so, and the session's cookies are
  checkpointed then (Camofox only writes them to disk at a checkpoint);
* steering: Camoufox (``browser_*``) is the primary browser; Chromium ``browser_exec`` is the backup
  and the engine for CDP-only work;
* a dock icon that opens or raises the agent's own Camoufox session.

It also points the camofox plugin at the local service: the access key (shared with the service via
``<HERMES_HOME>/camofox-browser/access-key``) and, when the profile sets no identity, one fixed
Camofox ``userId`` so the agent, its crons and the human share one cookie jar.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any, Optional

from . import camoufox_local, dock

logger = logging.getLogger(__name__)

CAMOFOX_TOOLSET = "camofox"
# Fallback when the registry cannot say (the camofox plugin's tool names).
CAMOFOX_TOOLS = frozenset({
    "browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_scroll",
    "browser_back", "browser_press", "browser_get_images", "browser_vision", "browser_console",
    "browser_import_cookies",
})
VAULT_WRITES = frozenset({"fill", "save_login", "enter_code"})

STEERING = (
    "Browsers on this agent's Bot Desktop:\n"
    "- Camoufox is the primary browser. Use the browser_* tools (browser_navigate, browser_snapshot, "
    "browser_click, browser_type, ...) for websites, logins and forms. It is a Firefox build with "
    "fingerprint protection, headed on the Bot Desktop, and its logins persist.\n"
    "- Chromium browser_exec is the backup. Use it only for CDP-only work (cdp(), PDF printing, "
    "browser_dialog), for a Google sign-in, for a flow a skill pins to browser_exec, or when Camoufox "
    "fails. The two browsers do not share logins.\n"
    "- A CAPTCHA or human-verification challenge is for the human: use screen_handoff, never solve it.\n"
    "- When a human holds the screen (Take over), browser tools refuse; end your turn and wait."
)
HANDBACK_NOTE = ("Bot Screen: the human handed control back; you hold the screen again. Re-snapshot "
                 "the page before acting, because it may have changed.")

_lock = threading.Lock()
# session_id -> lease epoch at the moment the session started waiting for the human.
_waiting: dict[str, int] = {}
_dock_state = {"done": False}


def _hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home
        return Path(get_hermes_home())
    except Exception:  # noqa: BLE001 - outside Hermes (tests, the dock launcher)
        return camoufox_local.hermes_home()


def _camofox_cfg() -> dict:
    try:
        from hermes_cli.config import load_config_readonly
        block = ((load_config_readonly() or {}).get("browser") or {}).get("camofox") or {}
        return block if isinstance(block, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def user_id() -> str:
    """The Camofox identity the agent uses, which the dock must open too."""
    configured = str(_camofox_cfg().get("user_id") or "").strip()
    return configured or (os.environ.get("CAMOFOX_USER_ID") or "").strip() or camoufox_local.DEFAULT_USER_ID


def configure_environment(home: Optional[Path] = None) -> None:
    """Point the camofox plugin at the local service (process env; single-profile gateway)."""
    if not (os.environ.get("CAMOFOX_URL") or "").strip():
        return  # no local service in this image; nothing to wire
    if not (os.environ.get("CAMOFOX_API_KEY") or "").strip():
        try:
            os.environ["CAMOFOX_API_KEY"] = camoufox_local.ensure_access_key(home or _hermes_home())
        except Exception as exc:  # noqa: BLE001 - tools then fail with the server's 401, visibly
            logger.warning("camoufox-desktop: access key unavailable: %s", exc)
    cfg = _camofox_cfg()
    if not str(cfg.get("user_id") or "").strip() and not (os.environ.get("CAMOFOX_USER_ID") or "").strip():
        os.environ["CAMOFOX_USER_ID"] = camoufox_local.DEFAULT_USER_ID


def _is_fenced(tool_name: str, args: Any) -> bool:
    if tool_name == "browser_vault":
        return isinstance(args, dict) and str(args.get("action") or "") in VAULT_WRITES
    try:
        from tools.registry import registry
        toolset = registry.get_toolset_for_tool(tool_name)
    except Exception:  # noqa: BLE001
        toolset = None
    if toolset is not None:
        return toolset == CAMOFOX_TOOLSET
    return tool_name in CAMOFOX_TOOLS


def _published_env() -> dict[str, str]:
    try:
        from tools.bot_desktop import runtime
        return runtime.published_env()
    except Exception:  # noqa: BLE001
        return {}


def _maybe_dock(published: Optional[dict[str, str]] = None) -> None:
    if _dock_state["done"]:
        return
    try:
        result = dock.ensure_dock_icon(_hermes_home(), user_id(), published)
    except Exception as exc:  # noqa: BLE001 - a dock icon is never worth failing a tool call
        logger.info("camoufox-desktop: dock icon not added: %s", exc)
        return
    if result in ("present", "added", "added_live"):
        _dock_state["done"] = True
    logger.info("camoufox-desktop: dock icon %s", result)


def pre_tool_call(tool_name: str = "", args: Any = None, session_id: str = "", **_: Any):
    try:
        if tool_name == "screen_handoff" and isinstance(args, dict) and args.get("action") == "link":
            _mark_waiting(session_id)
            return None
        if not _is_fenced(tool_name, args):
            return None
        from tools.bot_desktop import lease, runtime
        _start_desktop_bounded(runtime)
        try:
            lease.assert_agent_may_act()
        except lease.HumanHasControl as exc:
            _mark_waiting(session_id)
            return {"action": "block", "message": json.dumps(
                {"success": False, "code": "human_has_control", "error": str(exc)})}
        runtime.touch_activity()
        _maybe_dock(_published_env())
    except Exception as exc:  # noqa: BLE001 - our bug must not take the browser away
        logger.warning("camoufox-desktop: pre_tool_call: %s", exc)
    return None


# Core runs plugin hooks under plugins.hook_callback_timeout (30 s by default) and fails a tool call
# closed when a hook overruns, so the screen start is waited on for at most this long; the start
# keeps going in the background and the camofox tool waits for the browser itself.
DESKTOP_START_WAIT_SECONDS = 15.0


def _start_desktop_bounded(runtime: Any, wait: Optional[float] = None) -> None:
    def run() -> None:
        try:
            runtime.ensure_started_for_tool()  # start the screen (auto_start) or stamp activity
        except Exception as exc:  # noqa: BLE001 - the tool reports a missing display itself
            logger.info("camoufox-desktop: desktop start skipped: %s", exc)

    worker = threading.Thread(target=run, name="camoufox-desktop-start", daemon=True)
    worker.start()
    worker.join(DESKTOP_START_WAIT_SECONDS if wait is None else wait)
    if worker.is_alive():
        logger.info("camoufox-desktop: desktop still starting; not holding the tool call")


def _mark_waiting(session_id: str) -> None:
    if not session_id:
        return
    try:
        from tools.bot_desktop import lease
        epoch = lease.get().epoch
    except Exception:  # noqa: BLE001
        epoch = -1
    with _lock:
        _waiting.setdefault(session_id, epoch)


def _checkpoint_async() -> None:
    def run() -> None:
        try:
            camoufox_local.Client(key=os.environ.get("CAMOFOX_API_KEY") or None).checkpoint(user_id())
        except Exception as exc:  # noqa: BLE001 - best effort; the shutdown checkpoint still runs
            logger.info("camoufox-desktop: hand-back checkpoint skipped: %s", exc)
    threading.Thread(target=run, name="camoufox-checkpoint", daemon=True).start()


def pre_llm_call(session_id: str = "", **_: Any):
    if not session_id:
        return None
    with _lock:
        since = _waiting.get(session_id)
    if since is None:
        return None
    try:
        from tools.bot_desktop import lease
        now = lease.get()
    except Exception:  # noqa: BLE001
        return None
    if now.holder != lease.AGENT or now.epoch == since:
        return None  # the human still holds it, or nothing has changed yet
    with _lock:
        _waiting.pop(session_id, None)
    if (os.environ.get("CAMOFOX_URL") or "").strip():
        _checkpoint_async()
    return {"context": HANDBACK_NOTE}


def register(ctx) -> None:
    configure_environment()
    ctx.register_hook("pre_tool_call", pre_tool_call)
    ctx.register_hook("pre_llm_call", pre_llm_call)
    if hasattr(ctx, "register_system_prompt_section"):
        try:
            ctx.register_system_prompt_section("camoufox-desktop.browsers", STEERING, position="after_memory")
        except Exception as exc:  # noqa: BLE001 - steering is advisory
            logger.info("camoufox-desktop: steering not registered: %s", exc)
    if (os.environ.get("CAMOFOX_URL") or "").strip() and not _published_env().get("DISPLAY"):
        _maybe_dock(None)  # screen stopped: a direct, cache-free panel edit is safe now


__all__ = ["register", "pre_tool_call", "pre_llm_call", "configure_environment", "user_id"]
