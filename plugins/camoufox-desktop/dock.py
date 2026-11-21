"""Add a Camoufox icon to the Bot Desktop dock, once, in the profile's persistent Xfce config.

Core's launcher seeds the dock a single time (``xfce4-panel.xml`` is never regenerated) and has no
extension point, so this writes its own launcher directory and registers it in the panel:

* screen stopped: edit ``xfce4-panel.xml`` directly (xfconfd is not running, nothing caches it);
* screen running: go through ``xfconf-query`` on the screen's own D-Bus session, so xfconfd stores
  the change instead of overwriting a file edit on exit, then ask the panel to restart.

Idempotent: a panel that already lists our launcher is left alone, and a human who removed or moved
the icon keeps their layout as long as ``launcher-<id>/camoufox.desktop`` is still referenced.
"""
from __future__ import annotations

import logging
import os
import re
import shlex
import subprocess
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

PLUGIN_ID = 23
DESKTOP_FILE = "camoufox.desktop"
DOCK_PANEL = "panel-2"
BIN = Path(__file__).resolve().parent / "bin" / "camoufox-open"


def _xdg_config(home: Path) -> Path:
    return home / "bot-desktop" / "xdg"


def panel_xml(home: Path) -> Path:
    return _xdg_config(home) / "xfce4" / "xfconf" / "xfce-perchannel-xml" / "xfce4-panel.xml"


def launcher_dir(home: Path) -> Path:
    return _xdg_config(home) / "xfce4" / "panel" / f"launcher-{PLUGIN_ID}"


def desktop_entry(user_id: str, python: str = "python3") -> str:
    exec_line = " ".join(shlex.quote(part) for part in (python, str(BIN), "--user", user_id))
    return (
        "[Desktop Entry]\nVersion=1.0\nType=Application\nName=Camoufox\n"
        "Comment=Open this agent's Camoufox browser session\n"
        f"Icon=camoufox\nExec={exec_line}\nTerminal=false\nStartupNotify=false\n"
    )


def write_launcher(home: Path, user_id: str) -> Path:
    path = launcher_dir(home) / DESKTOP_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    text = desktop_entry(user_id)
    if not path.exists() or path.read_text(encoding="utf-8") != text:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    return path


def panel_has_launcher(xml: str) -> bool:
    return f'name="plugin-{PLUGIN_ID}"' in xml


_PLUGIN_IDS = re.compile(
    r'(<property name="' + DOCK_PANEL + r'" type="empty">.*?<property name="plugin-ids" type="array">)(.*?)(</property>)',
    re.S)
_PLUGINS_END = re.compile(r'(<property name="plugins" type="empty">.*?)(\n\s*</property>\s*\n</channel>)', re.S)


def add_to_panel_xml(xml: str) -> Optional[str]:
    """``xml`` with our launcher appended to the dock, or None when the layout is not one we recognise."""
    if panel_has_launcher(xml):
        return xml
    ids = _PLUGIN_IDS.search(xml)
    plugins = _PLUGINS_END.search(xml)
    if not ids or not plugins:
        return None
    entry = (f'<property name="plugin-{PLUGIN_ID}" type="string" value="launcher"><property name="items" '
             f'type="array"><value type="string" value="{DESKTOP_FILE}"/></property></property>')
    xml = xml[:ids.end(2)] + f'<value type="int" value="{PLUGIN_ID}"/>' + xml[ids.end(2):]
    plugins = _PLUGINS_END.search(xml)
    if plugins is None:
        return None
    return xml[:plugins.end(1)] + "\n    " + entry + xml[plugins.end(1):]


def _xfconf(env: dict[str, str], *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["xfconf-query", "-c", "xfce4-panel", *args], env=env, capture_output=True,
                          text=True, timeout=10, check=False)


def _add_live(published: dict[str, str]) -> bool:
    env = {**os.environ, **published}
    current = _xfconf(env, "-p", f"/panels/{DOCK_PANEL}/plugin-ids")
    if current.returncode != 0:
        return False
    ids = [line.strip() for line in current.stdout.splitlines() if line.strip().isdigit()]
    if str(PLUGIN_ID) in ids:
        return True
    steps = [
        ("-p", f"/plugins/plugin-{PLUGIN_ID}", "-n", "-t", "string", "-s", "launcher"),
        ("-p", f"/plugins/plugin-{PLUGIN_ID}/items", "-n", "-a", "-t", "string", "-s", DESKTOP_FILE),
        ("-p", f"/panels/{DOCK_PANEL}/plugin-ids", "-n", "-a",
         *[part for i in [*ids, str(PLUGIN_ID)] for part in ("-t", "int", "-s", i)]),
    ]
    for step in steps:
        if _xfconf(env, *step).returncode != 0:
            return False
    subprocess.run(["xfce4-panel", "-r"], env=env, capture_output=True, timeout=15, check=False)
    return True


def ensure_dock_icon(home: Path, user_id: str, published: Optional[dict[str, str]] = None) -> str:
    """Make sure the dock shows the Camoufox icon. Returns what happened, for logs and tests."""
    xml_path = panel_xml(home)
    if not xml_path.exists():
        return "not_seeded"  # core seeds the panel on first screen start; retried on next tool use
    write_launcher(home, user_id)
    xml = xml_path.read_text(encoding="utf-8")
    if panel_has_launcher(xml):
        return "present"
    if published and published.get("DISPLAY"):
        return "added_live" if _add_live(published) else "live_failed"
    updated = add_to_panel_xml(xml)
    if updated is None:
        return "unrecognised_layout"
    tmp = xml_path.with_suffix(".tmp")
    tmp.write_text(updated, encoding="utf-8")
    os.replace(tmp, xml_path)
    return "added"
