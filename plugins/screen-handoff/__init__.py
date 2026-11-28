"""Native Bot Screen handoff over the profile's public Webapp URL.

Upstream Hermes already owns the screen (Xvnc/Xfce per profile), the viewer (the gateway-served
Webapp's Screen pane), single-use display tickets and the human/agent control lease. This plugin
adds only the two pieces upstream leaves to the operator:

* ``screen_handoff`` tool (registered into the ``browser`` toolset, so it exists exactly where the
  browser does): ``link`` returns the profile's Webapp URL (``webapp.public_url``) and starts the
  screen if needed, ``status`` reports who holds control, ``take_back`` returns control to the agent.
* ``post_gateway_admission`` hook: when an authorized messaging-platform message reaches this
  profile while a human still holds the lease, control returns to the agent. The human's viewer stays
  connected and drops to watching. The hook runs after the gateway's own authorization, inside the
  routed profile scope, and never for local Desktop/Webapp turns (upstream does not fire it there),
  so chatting in the Webapp while holding control does not revoke it.

Nothing here touches tickets, the RFB bridge or sign-in. Disabling the plugin restores upstream
behaviour exactly.
"""
from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

PLUGIN_ID = "screen-handoff"
TOOL_NAME = "screen_handoff"
TAKE_BACK_REASON = "agent took back control: a new message arrived while a human held the screen"

_SCHEMA = {
    "name": TOOL_NAME,
    "description": (
        "Hand the bot's live screen (its headed browser and desktop) to the user and get it back. "
        "Use action=link when a step needs the human (login, 2FA, CAPTCHA, payment, consent): it starts "
        "the screen if needed and returns the URL to send the user. They open it, choose Take over, finish "
        "the step and choose Hand back. Then end your turn and wait for them to tell you to continue; never "
        "ask for passwords or codes in chat. action=status reports whether the screen runs and who holds "
        "control. action=take_back returns control to you; use it only when the user says they are done "
        "or asks you to continue (a new user message already takes control back automatically)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["link", "status", "take_back"]},
            "reason": {
                "type": "string",
                "description": "link only: one short line shown to the user on the screen, e.g. 'Sign in to the supplier portal'.",
            },
        },
        "required": ["action"],
        "additionalProperties": False,
    },
}


def _config() -> dict:
    try:
        from hermes_cli.config import load_config_readonly
        return load_config_readonly() or {}
    except Exception:  # noqa: BLE001 - config errors are reported by the gateway itself
        return {}


def _plugin_settings(cfg: dict) -> dict:
    plugins = cfg.get("plugins") if isinstance(cfg.get("plugins"), dict) else {}
    section = (plugins.get("config") or {}).get(PLUGIN_ID) if isinstance(plugins.get("config"), dict) else None
    return section if isinstance(section, dict) else {}


def public_url(cfg: dict | None = None) -> str:
    """The URL a person opens: ``plugins.config.screen-handoff.url`` when set, else ``webapp.public_url``."""
    cfg = _config() if cfg is None else cfg
    url = str(_plugin_settings(cfg).get("url") or "").strip()
    if not url:
        webapp = cfg.get("webapp") if isinstance(cfg.get("webapp"), dict) else {}
        url = str(webapp.get("public_url") or "").strip()
    if not url.startswith("https://"):
        return ""
    return url.rstrip("/") + "/"


def auto_take_back_enabled(cfg: dict | None = None) -> bool:
    cfg = _config() if cfg is None else cfg
    value = _plugin_settings(cfg).get("auto_take_back", True)
    return value is not False


def _lease_view() -> dict[str, Any]:
    from tools.bot_desktop import lease as _lease
    current = _lease.get()
    return {"holder": current.holder, "since": current.since, "reason": current.reason, "epoch": current.epoch}


def _running() -> bool:
    try:
        from tools.bot_desktop import runtime as _runtime
        return bool(_runtime.is_running())
    except Exception:  # noqa: BLE001 - status probe only
        return False


def _ok(**fields: Any) -> str:
    return json.dumps({"ok": True, **fields})


def _fail(error: str, **fields: Any) -> str:
    return json.dumps({"ok": False, "error": error, **fields})


def take_back(reason: str = "") -> dict[str, Any]:
    """Return control to the agent unconditionally; report whether anything changed."""
    from tools.bot_desktop import lease as _lease
    before = _lease.get()
    if before.holder != _lease.HUMAN:
        return {"changed": False, "holder": before.holder}
    after = _lease.release(None, unless_human=False)
    changed = after.holder == _lease.AGENT and after.epoch != before.epoch
    if changed:
        logger.info("screen-handoff: control returned to the agent (%s)", reason or "explicit")
    return {"changed": changed, "holder": after.holder}


def handle_tool(args: dict, **_: Any) -> str:
    action = str((args or {}).get("action") or "").strip()
    if action == "status":
        return _ok(running=_running(), lease=_lease_view(), url=public_url() or None)
    if action == "take_back":
        return _ok(**take_back("tool"))
    if action != "link":
        return _fail("unknown action; use link, status or take_back")
    url = public_url()
    if not url:
        return _fail("no public screen URL configured for this agent (webapp.public_url); "
                     "tell the user to open this agent's Screen in Hermes Desktop instead")
    started = False
    if not _running():
        try:
            from tools.bot_desktop import runtime as _runtime
            _runtime.start()
            started = True
        except Exception as exc:  # noqa: BLE001 - report, still hand out the URL: the pane offers Start itself
            return _ok(url=url, running=False, start_error=str(exc)[:300], lease=_lease_view(),
                       instructions=_instructions(url, args))
    return _ok(url=url, running=True, started=started, lease=_lease_view(), instructions=_instructions(url, args))


def _opens_screen_page(url: str) -> bool:
    """True when the configured URL points at a screen-only page (a path ending in ``/screen``)."""
    from urllib.parse import urlsplit
    return urlsplit(url).path.rstrip("/").endswith("/screen")


def _instructions(url: str, args: dict) -> str:
    reason = str((args or {}).get("reason") or "").strip()
    step = f" to {reason[:120]}" if reason else ""
    if _opens_screen_page(url):
        return (f"Send the user this link: {url} . It opens this bot's screen. They sign in if asked, tap "
                f"Take over{step}, then Hand back. End your turn now and wait; replying to you also hands "
                f"control back.")
    return (f"Send the user this link: {url} . They sign in if asked, open this bot's Screen (Bots, then "
            f"the bot), choose Take over{step}, then Hand back. End your turn now and wait; replying to you "
            f"also hands control back.")


def on_post_gateway_admission(**kwargs: Any) -> None:
    """Take control back when an authorized messaging-platform message arrives. Never handles the message."""
    try:
        if not auto_take_back_enabled():
            return
        result = take_back(TAKE_BACK_REASON)
        if result.get("changed"):
            logger.info("screen-handoff: auto take-back on %s message %s",
                        kwargs.get("platform") or "?", kwargs.get("message_id") or "?")
    except Exception as exc:  # noqa: BLE001 - a hook must never block the turn
        logger.warning("screen-handoff: auto take-back failed: %s", exc)
    return


def register(ctx: Any) -> None:
    ctx.register_tool(name=TOOL_NAME, toolset="browser", schema=_SCHEMA, handler=handle_tool,
                      description=_SCHEMA["description"], emoji="🖥️")
    ctx.register_hook("post_gateway_admission", on_post_gateway_admission)
