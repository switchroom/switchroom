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
* a periodic checkpoint while the screen is in use: stopping the Bot Desktop (idle-stop, a crash)
  takes Camoufox down with its display, without the shutdown checkpoint, so recent logins would
  otherwise be lost;
* steering: Camoufox (``browser_*``) is the primary browser; Chromium ``browser_exec`` is the backup
  and the engine for CDP-only work;
* a dock icon that opens or raises the agent's own Camoufox session;
* password fields: what the page-reading camofox tools return to the model never carries a password
  field's value, whoever typed it (``password_scrub``; the snapshot prints every input's value).

It also points the camofox plugin at the local service: the access key (shared with the service via
``<HERMES_HOME>/camofox-browser/access-key``) and, when the profile sets no identity, one fixed
Camofox ``userId`` so the agent, its crons and the human share one cookie jar.
"""
from __future__ import annotations

import fcntl
import json
import logging
import os
import threading
import time
import urllib.error
from pathlib import Path
from typing import Any, Optional

from . import camoufox_local, dock, password_scrub

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
    return _is_camofox_tool(tool_name)


def _is_camofox_tool(tool_name: str) -> bool:
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
    except Exception as exc:  # noqa: BLE001 - no Bot Desktop support here: nobody can take over
        logger.warning("camoufox-desktop: pre_tool_call: %s", exc)
        return None
    try:
        started = time.monotonic()
        screen_was_up = bool(_published_env().get("DISPLAY"))
        _start_desktop_bounded(runtime)
        if not screen_was_up:
            _wait_for_service(started + SERVICE_WAIT_SECONDS)
        _retry_access_key()
    except Exception as exc:  # noqa: BLE001 - liveness helpers must not take the browser away
        logger.warning("camoufox-desktop: pre_tool_call: %s", exc)
    try:
        lease.assert_agent_may_act()
    except lease.HumanHasControl as exc:
        _mark_waiting(session_id)
        return _block("human_has_control", str(exc))
    except Exception as exc:  # noqa: BLE001 - fail closed: the agent must not type over a human
        logger.warning("camoufox-desktop: lease check failed: %s", exc)
        return _block("screen_control_unknown",
                      f"Could not confirm that the agent holds the Bot Desktop ({exc}); not acting. "
                      "Use browser_exec, or ask the human to check the Bot Screen.")
    try:
        runtime.touch_activity()
        _maybe_dock(_published_env())
    except Exception as exc:  # noqa: BLE001 - our bug must not take the browser away
        logger.warning("camoufox-desktop: pre_tool_call: %s", exc)
    return None


def _block(code: str, error: str) -> dict:
    return {"action": "block", "message": json.dumps({"success": False, "code": code, "error": error})}


def _retry_access_key() -> None:
    """Pick up the access key if it could not be read at register time (the service repairs an
    empty or short key on its next start); the camofox plugin reads the env on every request."""
    if (os.environ.get("CAMOFOX_URL") or "").strip() and not (os.environ.get("CAMOFOX_API_KEY") or "").strip():
        configure_environment()


# Core runs plugin hooks under plugins.hook_callback_timeout (30 s by default) and fails a tool call
# closed when a hook overruns, so the screen start is waited on for at most this long; the start
# keeps going in the background and the camofox tool waits for the browser itself.
DESKTOP_START_WAIT_SECONDS = 15.0
# The service starts its server only once the screen's X display is up, so after starting the
# screen the hook also waits for the server to answer, up to this long from the hook's start.
SERVICE_WAIT_SECONDS = 20.0


def _wait_for_service(deadline: float) -> bool:
    if not (os.environ.get("CAMOFOX_URL") or "").strip() or not _published_env().get("DISPLAY"):
        return False
    client = camoufox_local.Client(key=os.environ.get("CAMOFOX_API_KEY") or "")
    while True:
        if client.healthy():
            return True
        if time.monotonic() >= deadline:
            logger.info("camoufox-desktop: camofox-browser not answering yet; the tool will retry")
            return False
        time.sleep(0.5)


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


# Periodic checkpoint. Camofox writes cookies to disk only at a checkpoint, and a Bot Desktop stop
# (idle-stop, a crash, a manual stop) takes Camoufox down with its X display before any shutdown
# checkpoint can run. So while the screen is in use, checkpoint every CHECKPOINT_SECONDS; idle-stop
# comes long after the last use (bot_desktop.idle_stop_minutes), so the last state is on disk by then.
CHECKPOINT_SECONDS = 300.0
_checkpointer = {"started": False}


def checkpoint_interval() -> float:
    raw = (os.environ.get("CAMOFOX_CHECKPOINT_SECONDS") or "").strip()
    try:
        return float(raw) if raw else CHECKPOINT_SECONDS
    except ValueError:
        return CHECKPOINT_SECONDS


def checkpoint_due(activity_mtime: Optional[float], now: float, interval: float) -> bool:
    """True while the screen was used recently: for two intervals after the last activity stamp, so
    a call still running at one tick (the stamp is taken when it starts) is caught by the next."""
    return activity_mtime is not None and now - activity_mtime <= 2 * interval


def _activity_mtime(home: Path) -> Optional[float]:
    try:
        return (home / "bot-desktop" / "activity").stat().st_mtime
    except OSError:
        return None


def periodic_checkpoint_once(home: Path, now: Optional[float] = None) -> str:
    """One checkpoint tick; returns what happened, for logs and tests."""
    if not _published_env().get("DISPLAY"):
        return "screen_down"
    if not checkpoint_due(_activity_mtime(home), time.time() if now is None else now, checkpoint_interval()):
        return "idle"
    client = camoufox_local.Client(key=os.environ.get("CAMOFOX_API_KEY") or None, timeout=60)
    try:
        client.checkpoint(user_id())
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return "no_session"  # the agent's session is not open: nothing in memory to lose
        raise
    return "checkpointed"


def _start_checkpointer(home: Path) -> None:
    interval = checkpoint_interval()
    if interval <= 0 or _checkpointer["started"]:
        return
    # One checkpointer per profile: the gateway, the dashboard and one-off CLI runs all load plugins.
    lock_path = camoufox_local.state_dir(home) / ".checkpointer.lock"
    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    except OSError as exc:
        logger.info("camoufox-desktop: periodic checkpoint off: %s", exc)
        return
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)  # another process of this profile already checkpoints
        return
    _checkpointer["started"] = True  # the lock fd stays open for the life of the process

    def loop() -> None:
        while True:
            time.sleep(interval)
            try:
                result = periodic_checkpoint_once(home)
                if result == "checkpointed":
                    logger.debug("camoufox-desktop: periodic checkpoint written")
            except Exception as exc:  # noqa: BLE001 - best effort; try again next tick
                logger.info("camoufox-desktop: periodic checkpoint skipped: %s", exc)

    threading.Thread(target=loop, name="camoufox-checkpointer", daemon=True).start()


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


def _scrubs(tool_name: str) -> bool:
    return (tool_name in password_scrub.PAGE_READ_TOOLS and _is_camofox_tool(tool_name)
            and bool((os.environ.get("CAMOFOX_URL") or "").strip()))


def _scan() -> password_scrub.Scan:
    return password_scrub.scan([user_id()])


def scrub_passwords(tool_name: str = "", next_call: Any = None, **_: Any) -> Any:
    """``tool_execution`` middleware: run the tool, then take password-field values out of its output.
    Middleware wraps the dispatch itself, so unlike a ``transform_tool_result`` hook it has no
    callback timeout to fail open on and no other plugin's result can win over it."""
    result = next_call()  # a tool failure propagates unchanged
    if not _scrubs(tool_name):
        return result
    return password_scrub.scrub_tool_output(tool_name, result, _scan)


def transform_tool_result(tool_name: str = "", result: Any = None, **_: Any) -> Optional[str]:
    """Fallback for a core without ``tool_execution`` middleware."""
    if not _scrubs(tool_name):
        return None
    cleaned = password_scrub.scrub_tool_output(tool_name, result, _scan)
    return cleaned if isinstance(cleaned, str) else json.dumps(cleaned, ensure_ascii=False, default=str)


def _middleware_supported(ctx) -> bool:
    if not hasattr(ctx, "register_middleware"):
        return False
    try:
        from hermes_cli.middleware import VALID_MIDDLEWARE
        return "tool_execution" in VALID_MIDDLEWARE
    except Exception:  # noqa: BLE001 - an older core
        return False


def register(ctx) -> None:
    configure_environment()
    ctx.register_hook("pre_tool_call", pre_tool_call)
    ctx.register_hook("pre_llm_call", pre_llm_call)
    if _middleware_supported(ctx):
        ctx.register_middleware("tool_execution", scrub_passwords)
    else:
        ctx.register_hook("transform_tool_result", transform_tool_result)
    if hasattr(ctx, "register_system_prompt_section"):
        try:
            ctx.register_system_prompt_section("camoufox-desktop.browsers", STEERING, position="after_memory")
        except Exception as exc:  # noqa: BLE001 - steering is advisory
            logger.info("camoufox-desktop: steering not registered: %s", exc)
    if (os.environ.get("CAMOFOX_URL") or "").strip():
        if not _published_env().get("DISPLAY"):
            _maybe_dock(None)  # screen stopped: a direct, cache-free panel edit is safe now
        _start_checkpointer(_hermes_home())


__all__ = ["register", "pre_tool_call", "pre_llm_call", "configure_environment", "user_id", "scrub_passwords",
           "transform_tool_result"]
