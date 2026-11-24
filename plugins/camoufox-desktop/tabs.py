"""Keep the agent and the human on the same Camoufox tab (HF-826).

camofox-browser registers every ``window.open`` / ``target=_blank`` popup as a managed tab in the
opener's tab group (its session key), but the official camofox plugin tracks one ``tab_id`` per task
and only re-picks it when the server answers 404/410. Without this module a popup, whether the agent's
click or the human's during Take over opened it, leaves the agent on the opener while the page the
person sees is elsewhere, and the popups pile up as orphans.

This module, used by the plugin's ``tool_execution`` middleware and hooks, never edits the vendored
camofox plugin. It reads and updates the plugin's own session entry (``camofox_client._sessions``),
the same way the password scrub already reads it, and talks to the local service over REST:

* popup follow: around the action tools it diffs the session group's tab list and moves the session
  onto a new tab, reporting ``popup_opened`` in the tool result;
* hand-back: the session adopts the tab the human left in front (the window manager's focused
  Camoufox window; page JavaScript cannot tell, Playwright emulates focus), else the group's newest;
* ``browser_tabs``: list, switch and close the agent's own tabs (own userId and session key only);
* keep-alive while a human holds the screen, so the server's idle reaper cannot close the tab under
  them, and closing the session group's untracked tabs when the session ends;
* the empty first snapshot after navigate (the server navigates with ``waitUntil: 'commit'``);
* naming the browser and the live tab in a screen handoff, with the Camoufox tab brought to front.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from . import camoufox_local

logger = logging.getLogger(__name__)

# Tools that can open a tab. A click, key press or script can start a popup; type and navigate
# rarely do, so they get the immediate check only.
ACTION_TOOLS = frozenset({"browser_click", "browser_press", "browser_type", "browser_console", "browser_navigate"})
POPUP_PRONE = frozenset({"browser_click", "browser_press", "browser_console"})
# The server registers a popup from the page's ``popup`` event, which can land just after the click
# route answers, so a popup-prone action polls the tab list this long before saying "no popup".
POPUP_SETTLE_SECONDS = 0.5
POPUP_POLL_SECONDS = 0.1
# Empty first snapshot: poll this long at most, stopping as soon as the page has elements or its
# snapshot has stopped changing (a text-only page has no element refs but settles at once).
SNAPSHOT_WAIT_SECONDS = 10.0
SNAPSHOT_POLL_SECONDS = 0.5
SNAPSHOT_STABLE_READS = 2
# Keep-alive while a human holds the screen. The server reaps a tab after TAB_INACTIVITY_MS (5 min
# by default) without a tool call; a person's clicks and typing are not tool calls.
KEEPALIVE_SECONDS = 60.0
KEEPALIVE_JS = "0"
REASON_MAX = 120

TAB_SWITCH_NOTE = ("The browser tools now act on this tab. Element refs from earlier snapshots no longer apply: "
                   "call browser_snapshot before acting.")

_lock = threading.Lock()
# task_id -> {"user_id", "session_key", "tab_id"}: the last session state seen, kept here because the
# camofox plugin drops its own entry in its session-finalize hook, which may run before ours.
_records: dict[str, dict[str, Any]] = {}
# task_id -> "camoufox" | "chromium": the browser the task used last, for naming a screen handoff.
_last_browser: dict[str, str] = {}
# task_id -> {popup tab_id: opener tab_id} for tabs the agent's own actions opened.
_agent_popups: dict[str, dict[str, str]] = {}
_keepalive = {"started": False}


# ---- the camofox plugin's modules and session ----

def _modules(suffix: str) -> list[Any]:
    return [m for name, m in list(sys.modules.items()) if name.endswith(suffix) and m is not None]


def tracked_session(task_id: Optional[str]) -> Optional[dict[str, Any]]:
    """The camofox plugin's session entry for ``task_id`` (the live dict, so updating its ``tab_id``
    moves the plugin's tools), or None when it has none. Never creates one."""
    for module in _modules("camofox_client"):
        sessions, key_of = getattr(module, "_sessions", None), getattr(module, "_session_key", None)
        if not isinstance(sessions, dict) or not callable(key_of):
            continue
        try:
            session = sessions.get(key_of(task_id or None))
        except Exception:  # noqa: BLE001 - no profile scope here
            continue
        if isinstance(session, dict) and session.get("user_id"):
            return session
    return None


def all_sessions() -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    for module in _modules("camofox_client"):
        sessions = getattr(module, "_sessions", None)
        if isinstance(sessions, dict):
            found.extend(s for s in list(sessions.values()) if isinstance(s, dict) and s.get("user_id"))
    return found


def _session_for_tool(task_id: Optional[str]) -> Optional[dict[str, Any]]:
    """The session for ``browser_tabs``: the tracked one, else the plugin's own get_session (which only
    builds the identity and may adopt this task's existing tab)."""
    session = tracked_session(task_id)
    if session is not None:
        return session
    for module in _modules("camofox_client"):
        get_session = getattr(module, "get_session", None)
        if callable(get_session):
            try:
                session = get_session(task_id or None)
            except Exception as exc:  # noqa: BLE001
                logger.info("camoufox-desktop: camofox session unavailable: %s", exc)
                continue
            if isinstance(session, dict) and session.get("user_id"):
                return session
    return None


def remember(task_id: Optional[str]) -> None:
    session = tracked_session(task_id)
    if session is None:
        return
    with _lock:
        _records[task_id or "default"] = {"user_id": session.get("user_id"),
                                          "session_key": session.get("session_key"),
                                          "tab_id": session.get("tab_id")}


def note_browser(task_id: Optional[str], browser: str) -> None:
    with _lock:
        _last_browser[task_id or "default"] = browser


# ---- REST ----

def _client(timeout: float = 10.0) -> camoufox_local.Client:
    return camoufox_local.Client(key=os.environ.get("CAMOFOX_API_KEY") or None, timeout=timeout)


def _tab_id(tab: dict) -> str:
    return str(tab.get("tabId") or tab.get("id") or "")


def list_tabs(user: str, client: Optional[camoufox_local.Client] = None) -> list[dict]:
    return [t for t in (client or _client()).tabs(user) if _tab_id(t)]


def group_tabs(session: dict[str, Any], tabs: Iterable[dict]) -> list[dict]:
    """The session's own tabs, oldest first: its session key's group, plus the tracked tab wherever it
    is (an adopted tab may sit in another group)."""
    key, tracked = session.get("session_key"), session.get("tab_id")
    return [t for t in tabs if (key and t.get("listItemId") == key) or (tracked and _tab_id(t) == tracked)]


def _quote(tab: str) -> str:
    return urllib.parse.quote(tab, safe="")


def activate(user: str, tab: str, client: Optional[camoufox_local.Client] = None) -> None:
    (client or _client()).request("POST", f"/tabs/{_quote(tab)}/activate", {"userId": user})


def close(user: str, tab: str, client: Optional[camoufox_local.Client] = None) -> None:
    (client or _client()).request("DELETE", f"/tabs/{_quote(tab)}?userId={urllib.parse.quote(user)}")


def evaluate(user: str, tab: str, expression: str, timeout_ms: int,
             client: Optional[camoufox_local.Client] = None) -> Any:
    reply = (client or _client(timeout=timeout_ms / 1000 + 2)).request(
        "POST", f"/tabs/{_quote(tab)}/evaluate", {"userId": user, "expression": expression, "timeoutMs": timeout_ms})
    return reply.get("result") if isinstance(reply, dict) else None


def _human_holds() -> bool:
    try:
        from tools.bot_desktop import lease
        return lease.get().holder == lease.HUMAN
    except Exception:  # noqa: BLE001 - unknown: treat as held, so nothing is closed under a person
        return True


# ---- result helpers ----

def _parse(result: Any) -> Optional[dict]:
    if isinstance(result, dict):
        return dict(result)
    if isinstance(result, str):
        try:
            parsed = json.loads(result)
        except ValueError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def _dump(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False, default=str)


# ---- popup follow ----

def before_action(tool_name: str, task_id: Optional[str]) -> Optional[dict[str, Any]]:
    """The tab ids before an action, or None when there is nothing to follow from (no tab yet, or the
    list failed: the action then runs exactly as without this plugin)."""
    if tool_name not in ACTION_TOOLS:
        return None
    session = tracked_session(task_id)
    if session is None or not session.get("tab_id"):
        return None
    try:
        ids = {_tab_id(t) for t in list_tabs(session["user_id"])}
    except Exception as exc:  # noqa: BLE001
        logger.debug("camoufox-desktop: tab list before %s failed: %s", tool_name, exc)
        return None
    return {"tab_id": session["tab_id"], "ids": ids}


def after_action(tool_name: str, task_id: Optional[str], before: Optional[dict[str, Any]], result: Any,
                 *, sleep: Callable[[float], None] = time.sleep) -> Any:
    """Follow a tab the action opened in this session's group. Never raises."""
    if before is None:
        return result
    try:
        session = tracked_session(task_id)
        if session is None or session.get("tab_id") != before["tab_id"]:
            return result  # the plugin moved the session itself (tab gone): leave its choice alone
        deadline = time.monotonic() + (POPUP_SETTLE_SECONDS if tool_name in POPUP_PRONE else 0.0)
        while True:
            tabs = list_tabs(session["user_id"])
            new = [t for t in tabs if _tab_id(t) not in before["ids"] and _tab_id(t) != before["tab_id"]
                   and t.get("listItemId") == session.get("session_key")]
            if new or time.monotonic() >= deadline:
                break
            sleep(POPUP_POLL_SECONDS)
        if not new:
            return result
        chosen = new[-1]
        session["tab_id"] = _tab_id(chosen)
        with _lock:
            popups = _agent_popups.setdefault(task_id or "default", {})
            for tab in new:
                popups[_tab_id(tab)] = before["tab_id"]
        logger.info("camoufox-desktop: %s opened tab %s; following it from %s", tool_name, session["tab_id"],
                    before["tab_id"])
        info: dict[str, Any] = {"tab_id": session["tab_id"], "url": str(chosen.get("url") or ""),
                                "opener_tab_id": before["tab_id"]}
        if len(new) > 1:
            info["other_new_tab_ids"] = [_tab_id(t) for t in new[:-1]]
        data = _parse(result)
        if data is None:
            return result if not isinstance(result, str) else (
                result + "\n" + _dump({"popup_opened": info, "note": TAB_SWITCH_NOTE}))
        data["popup_opened"] = info
        data["tab_note"] = "A new tab opened. " + TAB_SWITCH_NOTE
        return _dump(data)
    except Exception as exc:  # noqa: BLE001 - following is a bonus; the action's own result stands
        logger.info("camoufox-desktop: popup follow after %s skipped: %s", tool_name, exc)
        return result


# ---- empty first snapshot ----

def _fetch_snapshot() -> Optional[Callable[[dict], tuple[str, int]]]:
    for module in _modules("camofox_tools"):
        fetch = getattr(module, "_fetch_snapshot", None)
        if callable(fetch):
            return fetch
    return None


def settle_snapshot(task_id: Optional[str], result: Any, *, sleep: Callable[[float], None] = time.sleep,
                    budget: float = SNAPSHOT_WAIT_SECONDS) -> Any:
    """When navigate came back with 0 elements, re-read the snapshot until the page renders (elements
    appear, or the snapshot stops changing), for at most ``budget`` seconds. Never raises."""
    try:
        data = _parse(result)
        if data is None or data.get("success") is not True or data.get("element_count") not in (0, None):
            return result
        session, fetch = tracked_session(task_id), _fetch_snapshot()
        if session is None or not session.get("tab_id") or fetch is None:
            return result
        started = time.monotonic()
        previous, stable = str(data.get("snapshot") or ""), 0
        snapshot, count = previous, 0
        while time.monotonic() - started < budget:
            sleep(SNAPSHOT_POLL_SECONDS)
            try:
                snapshot, count = fetch(session)
            except Exception as exc:  # noqa: BLE001 - the tab went away or the server is busy
                logger.debug("camoufox-desktop: snapshot poll stopped: %s", exc)
                break
            if count:
                break
            stable = stable + 1 if snapshot.strip() and snapshot == previous else 0
            if stable >= SNAPSHOT_STABLE_READS:
                break
            previous = snapshot
        if snapshot == data.get("snapshot") and count == (data.get("element_count") or 0):
            return result
        data["snapshot"], data["element_count"] = snapshot, count
        data["snapshot_wait_ms"] = int((time.monotonic() - started) * 1000)
        return _dump(data)
    except Exception as exc:  # noqa: BLE001
        logger.info("camoufox-desktop: snapshot wait skipped: %s", exc)
        return result


# ---- hand-back ----

_WM_NAME = re.compile(r'^_NET_WM_NAME\(UTF8_STRING\) = "(?P<name>(?:[^"\\]|\\.)*)"\s*$', re.M)
_BROWSER_SUFFIX = re.compile(r"\s+[—–-]\s+(?:Camoufox|Mozilla Firefox|Firefox)\s*$")
_WINDOW_IDS = re.compile(r"0x[0-9a-fA-F]+")


def _xprop(env: dict[str, str], *args: str) -> str:
    return subprocess.run(["xprop", *args], env=env, capture_output=True, text=True, timeout=3,
                          check=False).stdout


def front_window_titles() -> list[str]:
    """The page titles of the Camoufox windows on the Bot Desktop, front-most first: the focused
    window, then the rest top-down. A window's title is its selected tab's title plus the browser name.

    Page JavaScript cannot say which tab a person is looking at: Playwright emulates focus, so every
    page reports ``visibilityState`` visible and ``document.hasFocus()`` true. The window manager can."""
    try:
        from tools.bot_desktop import runtime
        published = runtime.published_env()
    except Exception:  # noqa: BLE001
        return []
    if not published.get("DISPLAY") or not shutil.which("xprop"):
        return []
    env = {**os.environ, **{k: v for k, v in published.items() if k in ("DISPLAY", "XAUTHORITY")}}
    root = _xprop(env, "-root", "_NET_ACTIVE_WINDOW", "_NET_CLIENT_LIST_STACKING")
    active = stacking = []
    for line in root.splitlines():
        if line.startswith("_NET_ACTIVE_WINDOW"):
            active = _WINDOW_IDS.findall(line.split("#", 1)[-1])[:1]
        elif line.startswith("_NET_CLIENT_LIST_STACKING"):
            stacking = list(reversed(_WINDOW_IDS.findall(line.split("#", 1)[-1])))
    titles: list[str] = []
    for wid in dict.fromkeys(w for w in [*active, *stacking] if int(w, 16)):
        match = _WM_NAME.search(_xprop(env, "-id", wid, "_NET_WM_NAME"))
        name = match.group("name").replace('\\"', '"').replace("\\\\", "\\") if match else ""
        if _BROWSER_SUFFIX.search(name):
            titles.append(_BROWSER_SUFFIX.sub("", name))
    return titles


def adopt_focused_tab(task_id: Optional[str]) -> Optional[dict[str, Any]]:
    """After a hand-back: move the session onto the tab the human left in front (the focused Camoufox
    window's selected tab), else the newest tab of its group. Returns ``{"url", "tab_id", "switched"}``,
    or None. Never raises."""
    try:
        session = tracked_session(task_id)
        if session is None:
            return None
        own = group_tabs(session, list_tabs(session["user_id"]))
        if not own:
            return None
        tracked = session.get("tab_id")
        keyed = [t for t in own if t.get("listItemId") == session.get("session_key")] or own
        chosen = None
        for title in front_window_titles():
            same = [t for t in own if str(t.get("title") or "") == title]
            if same:  # a title shared by several tabs: the tracked one, else the newest
                chosen = next((t for t in same if _tab_id(t) == tracked), same[-1])
                break
        chosen = chosen or keyed[-1]
        tab = _tab_id(chosen)
        switched = tab != tracked
        session["tab_id"] = tab
        if switched:
            logger.info("camoufox-desktop: hand-back: following the human to tab %s (was %s)", tab, tracked)
        remember(task_id)
        return {"url": str(chosen.get("url") or ""), "tab_id": tab, "switched": switched}
    except Exception as exc:  # noqa: BLE001
        logger.info("camoufox-desktop: hand-back tab adoption skipped: %s", exc)
        return None


# ---- keep-alive and session-end cleanup ----

def keepalive_once() -> str:
    """One tick: while a human holds the screen, touch every tab of the agent's tracked sessions'
    groups so the server's idle reaper leaves them alone. Returns what happened."""
    try:
        from tools.bot_desktop import lease
        if lease.get().holder != lease.HUMAN:
            return "agent"
    except Exception:  # noqa: BLE001
        return "no_lease"
    sessions = all_sessions()
    if not sessions:
        return "no_session"
    client = _client(timeout=5)
    touched = 0
    for user in dict.fromkeys(s["user_id"] for s in sessions):
        mine = [s for s in sessions if s["user_id"] == user]
        keys = {s.get("session_key") for s in mine if s.get("session_key")}
        tracked = {s.get("tab_id") for s in mine if s.get("tab_id")}
        try:
            tabs = list_tabs(user, client)
        except Exception as exc:  # noqa: BLE001
            logger.debug("camoufox-desktop: keep-alive list failed: %s", exc)
            continue
        for tab in tabs:
            if tab.get("listItemId") in keys or _tab_id(tab) in tracked:
                try:
                    evaluate(user, _tab_id(tab), KEEPALIVE_JS, 2000, client)
                    touched += 1
                except Exception:  # noqa: BLE001 - the tab closed meanwhile
                    continue
    return f"kept {touched}"


def keepalive_interval() -> float:
    raw = (os.environ.get("CAMOFOX_KEEPALIVE_SECONDS") or "").strip()
    try:
        return float(raw) if raw else KEEPALIVE_SECONDS
    except ValueError:
        return KEEPALIVE_SECONDS


def start_keepalive() -> None:
    interval = keepalive_interval()
    if interval <= 0 or _keepalive["started"]:
        return
    _keepalive["started"] = True

    def loop() -> None:
        while True:
            time.sleep(interval)
            try:
                keepalive_once()
            except Exception as exc:  # noqa: BLE001 - best effort; next tick
                logger.info("camoufox-desktop: keep-alive skipped: %s", exc)

    threading.Thread(target=loop, name="camoufox-takeover-keepalive", daemon=True).start()


def close_agent_popups(task_id: Optional[str]) -> int:
    """At the end of a turn: close the popups the agent's own actions opened that it no longer uses.
    The tracked tab stays, and so does the tab that opened it (a sign-in popup posts its answer back
    to its opener). Tabs a human opened are left alone. The server's idle reaper is no backstop here:
    the fleet image keeps a quiet tab for hours (``TAB_INACTIVITY_MS``), and a session that reaches its
    tab cap can open no new tab."""
    if _human_holds():
        return 0
    with _lock:
        popups = dict(_agent_popups.get(task_id or "default") or {})
    session = tracked_session(task_id)
    if not popups or session is None:
        return 0
    tracked = session.get("tab_id")
    keep = {tracked, popups.get(tracked or "")}
    closed = 0
    try:
        client = _client()
        live = {_tab_id(t) for t in list_tabs(session["user_id"], client)}
        for tab in popups:
            if tab in keep:
                continue
            if tab in live:
                close(session["user_id"], tab, client)
                closed += 1
            with _lock:
                _agent_popups.get(task_id or "default", {}).pop(tab, None)
    except Exception as exc:  # noqa: BLE001 - the session-end cleanup closes what is left
        logger.info("camoufox-desktop: turn-end popup cleanup stopped: %s", exc)
    if closed:
        logger.info("camoufox-desktop: closed %d agent popup(s) no longer in use", closed)
    return closed


def close_untracked(task_id: Optional[str]) -> int:
    """At session end: close the session group's tabs other than the tracked one (popups the agent
    or a human opened from its pages). Nothing is closed while a human holds the screen."""
    with _lock:
        record = dict(_records.pop(task_id or "default", None) or {})
        _last_browser.pop(task_id or "default", None)
        _agent_popups.pop(task_id or "default", None)
    session = tracked_session(task_id)
    if session is not None:
        record = {"user_id": session.get("user_id"), "session_key": session.get("session_key"),
                  "tab_id": session.get("tab_id")}
    if not record.get("user_id") or not record.get("session_key") or _human_holds():
        return 0
    closed = 0
    try:
        client = _client()
        for tab in list_tabs(record["user_id"], client):
            if tab.get("listItemId") == record["session_key"] and _tab_id(tab) != record.get("tab_id"):
                close(record["user_id"], _tab_id(tab), client)
                closed += 1
    except Exception as exc:  # noqa: BLE001 - the idle reaper closes what is left
        logger.info("camoufox-desktop: session-end tab cleanup stopped: %s", exc)
    if closed:
        logger.info("camoufox-desktop: closed %d untracked tab(s) at session end", closed)
    return closed


# ---- browser_tabs ----

BROWSER_TABS_SCHEMA = {
    "name": "browser_tabs",
    "description": (
        "List, switch or close your own Camoufox tabs (the ones your browser_* tools opened, and popups "
        "opened from them). action=list shows each tab with its URL and which one the browser tools act on; "
        "action=switch moves the browser tools to tab_id and brings it to front; action=close closes tab_id. "
        "A popup a click opens is followed automatically (the click result says popup_opened). Close the "
        "orphan tabs you opened when you are done with them; ask before closing a tab a person may be using."),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["list", "switch", "close"]},
            "tab_id": {"type": "string", "description": "switch/close: a tab_id from action=list."},
        },
        "required": ["action"],
        "additionalProperties": False,
    },
}


def _fail(error: str) -> str:
    return json.dumps({"success": False, "error": error})


def browser_tabs(args: dict, task_id: Optional[str], scrub: Callable[[str, list[tuple[str, str]]], str]) -> str:
    action = str((args or {}).get("action") or "").strip()
    target = str((args or {}).get("tab_id") or "").strip()
    if action not in ("list", "switch", "close"):
        return _fail("unknown action; use list, switch or close")
    if not (os.environ.get("CAMOFOX_URL") or "").strip():
        return _fail("Camoufox is not configured on this agent.")
    session = _session_for_tool(task_id)
    if session is None:
        return _fail("No browser session. Call browser_navigate first.")
    user = session["user_id"]
    try:
        client = _client()
        own = group_tabs(session, list_tabs(user, client))
        ids = [_tab_id(t) for t in own]
        note = None
        if action in ("switch", "close"):
            if not target:
                return _fail(f"{action} needs tab_id (see action=list)")
            if target not in ids:
                return _fail(f"tab {target} is not one of this session's tabs; see action=list")
        if action == "switch":
            session["tab_id"] = target
            try:
                activate(user, target, client)
            except Exception as exc:  # noqa: BLE001 - tracked anyway; the screen just shows another tab
                logger.info("camoufox-desktop: tab activate failed: %s", exc)
            note = TAB_SWITCH_NOTE
        elif action == "close":
            close(user, target, client)
            own = [t for t in own if _tab_id(t) != target]
            if session.get("tab_id") == target:
                keyed = [t for t in own if t.get("listItemId") == session.get("session_key")] or own
                session["tab_id"] = _tab_id(keyed[-1]) if keyed else None
                note = (TAB_SWITCH_NOTE if session["tab_id"] else
                        "That was the last tab; call browser_navigate to open a page.")
        remember(task_id)
        current = session.get("tab_id")
        out: dict[str, Any] = {"success": True, "action": action, "current_tab_id": current,
                               "tabs": [{"tab_id": _tab_id(t), "url": str(t.get("url") or ""),
                                         "title": str(t.get("title") or ""), "current": _tab_id(t) == current}
                                        for t in own]}
        if note:
            out["note"] = note
        return scrub(_dump(out), [(user, _tab_id(t)) for t in own])
    except urllib.error.HTTPError as exc:
        return _fail(f"Camoufox answered HTTP {exc.code} for {action}")
    except Exception as exc:  # noqa: BLE001
        return _fail(f"browser_tabs {action} failed: {type(exc).__name__}")


# ---- screen handoff naming ----

def _short_url(url: str, room: int) -> str:
    parts = urllib.parse.urlsplit(url)
    text = (parts.netloc + parts.path).rstrip("/") if parts.netloc else url
    if len(text) > room:
        text = text[:max(room - 1, 8)] + "…"
    return text


def _chromium_url() -> str:
    """The front page of the bot desktop's Chromium (DevToolsActivePort of its user-data-dir), or ""."""
    try:
        from tools.bot_desktop import browser as bot_browser
        port = (Path(bot_browser.profile_dir()) / "DevToolsActivePort").read_text().split()[0]
        import urllib.request
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:{int(port)}/json/list", timeout=2) as resp:
            targets = json.loads(resp.read() or b"[]")
        for target in targets if isinstance(targets, list) else []:
            url = str((target or {}).get("url") or "")
            if (target or {}).get("type") == "page" and url.startswith(("http://", "https://")):
                return url
    except Exception:  # noqa: BLE001 - naming is best effort
        pass
    return ""


def handoff_view(task_id: Optional[str]) -> Optional[dict[str, str]]:
    """``{"browser", "url"}`` for the browser this task is using, with the Camoufox tab brought to front
    so the person lands on it when they take over. None when neither browser is in use."""
    with _lock:
        last = _last_browser.get(task_id or "default")
    session = tracked_session(task_id)
    if last != "chromium" and session is not None and session.get("tab_id"):
        user, tab = session["user_id"], session["tab_id"]
        url = ""
        try:
            client = _client()
            url = next((str(t.get("url") or "") for t in list_tabs(user, client) if _tab_id(t) == tab), "")
            activate(user, tab, client)
        except Exception as exc:  # noqa: BLE001
            logger.info("camoufox-desktop: handoff tab activate failed: %s", exc)
        return {"browser": "Camoufox", "url": url}
    url = _chromium_url() if (last == "chromium" or session is None) else ""
    if last == "chromium" or url:
        return {"browser": "Chromium", "url": url}
    return None


def handoff_reason(reason: str, view: dict[str, str]) -> str:
    reason = " ".join(str(reason or "").split())
    label = f"in {view['browser']}"
    if view.get("url"):
        room = REASON_MAX - len(reason) - len(label) - 4
        if room < 16:
            reason = reason[:max(REASON_MAX - len(label) - 24, 20)].rstrip()
            room = REASON_MAX - len(reason) - len(label) - 4
        label += f" ({_short_url(view['url'], room)})"
    return f"{reason} {label}".strip() if reason else label[3:]


__all__ = ["ACTION_TOOLS", "BROWSER_TABS_SCHEMA", "adopt_focused_tab", "after_action", "before_action",
           "browser_tabs", "close_untracked", "handoff_reason", "handoff_view", "keepalive_once", "note_browser",
           "remember", "settle_snapshot", "start_keepalive", "tracked_session"]
