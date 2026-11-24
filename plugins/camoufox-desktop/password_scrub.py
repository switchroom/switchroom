"""Keep password-field values out of what the camofox browser tools return to the model.

camofox-browser's accessibility snapshot prints every input's value, password fields included, and
the camofox plugin only scrubs registered vault values and token-like text. A password a human types
during Take over would therefore reach the model on the agent's next snapshot.

After each page-reading camofox tool runs, this module asks the page itself (``/tabs/<id>/evaluate``
on every tab of the agent's Camofox identities) for the values of its password fields: inputs of
``type=password`` and inputs whose ``autocomplete`` names ``current-password`` or ``new-password``,
in the document, its open shadow roots and its same-origin frames. Those values are then removed
from the tool's output and from the stored full-snapshot file the output points at.

It fails closed. When the scan cannot run, every textbox value in a snapshot is masked and a
``browser_console`` result is withheld. When the page has a frame the scan cannot read (another
origin), textbox values inside the snapshot's iframe sections are masked.
"""
from __future__ import annotations

import json
import logging
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from . import camoufox_local

logger = logging.getLogger(__name__)

MASK = "«redacted-password»"
# Tools whose output carries page content (browser_navigate returns a compact snapshot).
PAGE_READ_TOOLS = frozenset({
    "browser_navigate", "browser_snapshot", "browser_console", "browser_vision", "browser_get_images",
})
# A value this long is also removed wherever it appears; a shorter one only where it is a whole
# textbox value or a whole string, so a two-letter password does not shred the rest of the output.
MIN_SUBSTRING = 4
MAX_TABS = 16
EVALUATE_TIMEOUT_MS = 4000
SCAN_BUDGET_SECONDS = 12.0

SCAN_JS = r"""(() => {
  const values = []; const seen = new Set(); let opaque = false;
  const isPassword = (el) => {
    try {
      return String(el.type || '').toLowerCase() === 'password'
        || /(?:^|\s)(?:current|new)-password(?:\s|$)/i.test(el.getAttribute('autocomplete') || '');
    } catch (e) { return false; }
  };
  const visit = (root, depth) => {
    if (!root || depth > 8 || seen.has(root)) return;
    seen.add(root);
    let all;
    try { all = root.querySelectorAll('*'); } catch (e) { opaque = true; return; }
    for (const el of all) {
      const tag = String(el.tagName || '').toUpperCase();
      if (tag === 'INPUT' && isPassword(el) && el.value) values.push(String(el.value));
      if (el.shadowRoot) visit(el.shadowRoot, depth + 1);
      if (tag === 'IFRAME' || tag === 'FRAME') {
        let doc = null;
        try { doc = el.contentDocument; } catch (e) { doc = null; }
        if (doc) visit(doc, depth + 1); else opaque = true;
      }
    }
  };
  visit(document, 0);
  return JSON.stringify({ values, opaque });
})()"""

_FIELD_LINE = re.compile(
    r'^(?P<head>\s*-\s+(?:textbox|searchbox|combobox)\b(?:\s+"(?:[^"\\]|\\.)*")?(?:\s+\[[^\]\n]*\])*:[ \t]+)'
    r'(?P<value>\S.*)$')
_IFRAME_LINE = re.compile(r'^(?P<indent>\s*)-\s+iframe\b.*:\s*$')
_STORED_NOTE = re.compile(r'full snapshot: read_file path="(?P<path>[^"\n]+)" offset=\d+ limit=\d+\]\s*\Z')


class ScanFailed(RuntimeError):
    pass


class Scan:
    def __init__(self, values: Iterable[str] = (), opaque: bool = False, failed: bool = False):
        self.values = sorted({v for v in values if isinstance(v, str) and v}, key=len, reverse=True)
        self.opaque = opaque
        self.failed = failed

    def forms(self) -> list[str]:
        """Each value as it may appear in output: raw, and quoted-and-escaped (the snapshot YAML and
        a JSON-in-a-string both escape quotes, backslashes and control characters that way)."""
        out: set[str] = set()
        for value in self.values:
            out.add(value)
            out.add(json.dumps(value, ensure_ascii=False)[1:-1])
            out.add(json.dumps(value)[1:-1])
        return sorted(out, key=len, reverse=True)


# ---- scan ----

def _camofox_client_sessions() -> list[dict]:
    """The camofox plugin's tracked sessions (its module-level ``_sessions``), whatever namespace the
    plugin loader gave the module; empty when it is not loaded in this process."""
    found: list[dict] = []
    for name, module in list(sys.modules.items()):
        if not name.endswith("camofox_client"):
            continue
        sessions = getattr(module, "_sessions", None)
        if isinstance(sessions, dict):
            found.extend(s for s in list(sessions.values()) if isinstance(s, dict))
    return found


def _targets(client: camoufox_local.Client, user_ids: Iterable[str]) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    users: list[str] = []
    for session in _camofox_client_sessions():
        user, tab = str(session.get("user_id") or ""), str(session.get("tab_id") or "")
        if user and user not in users:
            users.append(user)
        if user and tab:
            pairs.append((user, tab))
    for user in user_ids:
        if user and user not in users:
            users.append(user)
    for user in users:
        for tab in client.tabs(user):  # a listing failure is a scan failure (raises)
            tab_id = str(tab.get("tabId") or tab.get("id") or "")
            if tab_id:
                pairs.append((user, tab_id))
    unique = list(dict.fromkeys(pairs))
    if len(unique) > MAX_TABS:
        raise ScanFailed(f"{len(unique)} tabs open; scanning stops at {MAX_TABS}")
    return unique


def scan(user_ids: Iterable[str], client: Optional[camoufox_local.Client] = None,
         budget: float = SCAN_BUDGET_SECONDS, targets: Optional[Iterable[tuple[str, str]]] = None) -> Scan:
    """The password-field values open in the agent's Camofox tabs. Raises ScanFailed.

    ``targets`` names the exact ``(userId, tabId)`` pairs whose content the tool output can carry
    (the tool's tracked tab). Scanning only those matters beyond speed: the evaluate is a tool call to
    the server, so scanning every tab kept orphan popups from ever idling out (HF-826). Without
    ``targets`` every tab of ``user_ids`` and of the camofox plugin's sessions is scanned."""
    deadline = time.monotonic() + budget
    try:
        client = client or camoufox_local.Client(key=os.environ.get("CAMOFOX_API_KEY") or None,
                                                 timeout=EVALUATE_TIMEOUT_MS / 1000 + 2)
        values: list[str] = []
        opaque = False
        pairs = list(dict.fromkeys(p for p in targets if p[0] and p[1])) if targets is not None else None
        if pairs is not None and len(pairs) > MAX_TABS:
            raise ScanFailed(f"{len(pairs)} tabs open; scanning stops at {MAX_TABS}")
        for user, tab in pairs if pairs is not None else _targets(client, user_ids):
            if time.monotonic() > deadline:
                raise ScanFailed("scan ran out of time")
            try:
                reply = client.request("POST", f"/tabs/{urllib.parse.quote(tab, safe='')}/evaluate",
                                       {"userId": user, "expression": SCAN_JS, "timeoutMs": EVALUATE_TIMEOUT_MS})
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    continue  # the tab closed since it was listed: nothing of it can be shown
                raise
            raw = reply.get("result") if isinstance(reply, dict) else None
            data = json.loads(raw) if isinstance(raw, str) else None
            if not isinstance(data, dict) or not isinstance(data.get("values"), list):
                raise ScanFailed("unexpected scan reply")
            values.extend(v for v in data["values"] if isinstance(v, str))
            opaque = opaque or data.get("opaque") is True
        return Scan(values, opaque)
    except ScanFailed:
        raise
    except Exception as exc:  # noqa: BLE001 - any failure means we do not know the values
        raise ScanFailed(type(exc).__name__) from exc


# ---- scrub ----

def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] == '"':
        try:
            decoded = json.loads(value)
            return decoded if isinstance(decoded, str) else value
        except ValueError:
            return value
    return value


def scrub_snapshot_lines(text: str, scan_: Scan) -> str:
    """Mask a field row's value when it holds a password, every field value when the scan failed,
    and field values inside iframe sections when a frame could not be read."""
    lines = text.split("\n")
    iframe_indent: Optional[int] = None
    for i, line in enumerate(lines):
        indent = len(line) - len(line.lstrip())
        if iframe_indent is not None and line.strip() and indent <= iframe_indent:
            iframe_indent = None
        frame = _IFRAME_LINE.match(line)
        if frame:
            iframe_indent = len(frame.group("indent"))
            continue
        field = _FIELD_LINE.match(line)
        if not field:
            continue
        value = _unquote(field.group("value"))
        if (scan_.failed or (scan_.opaque and iframe_indent is not None)
                or any(v in value or v in field.group("value") for v in scan_.values)):
            lines[i] = field.group("head") + MASK
    return "\n".join(lines)


def scrub_text(text: str, scan_: Scan) -> str:
    text = scrub_snapshot_lines(text, scan_)
    for form in scan_.forms():
        if len(form) >= MIN_SUBSTRING:
            text = text.replace(form, MASK)
    if text.strip() in scan_.values:
        return MASK
    return text


def _walk(value: Any, scan_: Scan, depth: int = 0) -> Any:
    if depth > 40:
        return MASK
    if isinstance(value, str):
        return scrub_text(value, scan_)
    if isinstance(value, list):
        return [_walk(item, scan_, depth + 1) for item in value]
    if isinstance(value, dict):
        return {_walk(k, scan_, depth + 1): _walk(v, scan_, depth + 1) for k, v in value.items()}
    return value


def _stored_snapshot_path(snapshot: str) -> Optional[Path]:
    """The full-snapshot file the camofox plugin stored, from its truncation note (the last line), and
    only inside this profile's ``cache/web`` (the note is page-adjacent text, so never trust a path)."""
    match = _STORED_NOTE.search(snapshot)
    if not match:
        return None
    path = Path(match.group("path"))
    try:
        from hermes_constants import get_hermes_dir
        cache = Path(get_hermes_dir("cache/web", "web_cache")).resolve()
    except Exception:  # noqa: BLE001
        cache = (camoufox_local.hermes_home() / "cache" / "web").resolve()
    candidate = cache / path.name
    if not re.fullmatch(r"[\w.\-]+", path.name) or candidate.is_symlink() or not candidate.is_file():
        return None
    return candidate


def scrub_stored_snapshot(snapshot: str, scan_: Scan) -> None:
    path = _stored_snapshot_path(snapshot)
    if path is None:
        return
    try:
        original = path.read_text(encoding="utf-8")
        cleaned = scrub_text(original, scan_)
        if cleaned == original:
            return
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".scrub-")
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(cleaned)
        os.chmod(tmp, path.stat().st_mode & 0o777)
        os.replace(tmp, path)
    except Exception as exc:  # noqa: BLE001 - could not clean it: do not leave it readable
        logger.warning("camoufox-desktop: stored snapshot not scrubbed (%s); removing it", type(exc).__name__)
        path.unlink(missing_ok=True)


def _snapshots(value: Any) -> list[str]:
    if isinstance(value, dict):
        return [v for k, v in value.items() if k == "snapshot" and isinstance(v, str)]
    return []


def _failed_result(parsed: Any) -> bool:
    return isinstance(parsed, dict) and parsed.get("success") is False and not (
        {"snapshot", "result", "analysis", "images"} & set(parsed))


def scrub_tool_output(tool_name: str, result: Any, scanner: Callable[[], Scan]) -> Any:
    """``result`` with the page's password values removed. Never raises; fails closed."""
    try:
        text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str)
        try:
            parsed: Any = json.loads(text)
        except ValueError:
            parsed = None
        try:
            scan_ = scanner()
        except ScanFailed as exc:
            if _failed_result(parsed):
                return result  # the tool failed too, most likely for the same reason: keep its error
            logger.warning("camoufox-desktop: password-field scan failed (%s); failing closed", exc)
            if tool_name == "browser_console":
                return json.dumps({"success": False, "code": "password_scan_failed",
                                   "error": "browser_console result withheld: could not check the page's "
                                            "password fields. Retry, or use browser_snapshot."})
            scan_ = Scan(failed=True)
        if parsed is None:
            return scrub_text(text, scan_)
        cleaned = _walk(parsed, scan_)
        for snapshot in _snapshots(cleaned):
            scrub_stored_snapshot(snapshot, scan_)
        if cleaned == parsed and isinstance(result, str):
            return result
        return json.dumps(cleaned, ensure_ascii=False)
    except Exception as exc:  # noqa: BLE001 - our bug must not let a password through
        logger.warning("camoufox-desktop: password scrub failed (%s); output withheld", type(exc).__name__)
        return json.dumps({"success": False, "code": "password_scrub_failed",
                           "error": f"{tool_name} output withheld: the password-field scrub failed."})
