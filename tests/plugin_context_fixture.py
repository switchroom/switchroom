"""A plugin-context test double that enforces Hermes' real settings-key contract (HF-793).

Why this exists: ``claude-account-connectors`` called ``ctx.get_config('model', ...)`` for months while
its tests passed, because the tests' fake context returned the default for any key. Hermes core
rejects that key (``model`` is a reserved settings root), so ``register()`` raised on a real
gateway and the plugin's tools never loaded. A fake that accepts what core rejects proves nothing.

The contract is core's ``hermes_cli.plugins_state._plugin_relative_segments``:

* the key is a string of dot-separated segments, each matching ``[A-Za-z0-9][A-Za-z0-9_-]{0,127}``;
* no ``/`` or ``\\``;
* the first segment, compared case-insensitively, is not one of
  ``model``, ``plugins``, ``security``, ``settings`` (these are core config roots, so a plugin may
  not use them as the root of its own key).

Violations raise ``ValueError`` (core also logs ``Rejected config path ...``). Values are read from
``plugins.entries.<plugin_id>.settings`` and fall back to the legacy ``config`` subtree, as core's
``PluginContext.get_config`` does.

Validator source, in order of preference:

1. the real function, when ``hermes_cli`` is importable in the test environment (a Hermes checkout
   on ``PYTHONPATH``, or the Agent image). ``VALIDATOR_SOURCE`` then reads ``hermes_cli``;
2. otherwise the faithful copy below, so a plain public checkout (CI) still enforces the contract.

``tests/test_plugin_context_fixture.py`` fails when the copy and the real function disagree, so the
copy cannot silently drift in any environment that has core.
"""

from __future__ import annotations

import re
from typing import Any, Callable, Mapping

# ---- faithful copy of hermes_cli/plugins_state.py (do not "improve"; mirror core) -----------------
_PLUGIN_SETTING_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
_PLUGIN_SETTING_RESERVED_ROOTS = frozenset({"model", "plugins", "security", "settings"})


def _vendored_relative_segments(key: str) -> tuple[str, ...]:
    if not isinstance(key, str):
        raise ValueError("Expected a plugin-relative config key string")
    segments = tuple(key.split("."))
    invalid = not key or "/" in key or "\\" in key or segments[0].lower() in _PLUGIN_SETTING_RESERVED_ROOTS
    if invalid or not all(_PLUGIN_SETTING_SEGMENT_RE.fullmatch(segment) for segment in segments):
        raise ValueError(
            "Expected a plugin-relative config key such as 'endpoint' or "
            "'retry.policy'; global, cross-plugin, and traversal paths are forbidden"
        )
    return segments


# ---- the real validator when core is importable ---------------------------------------------------
def _real_relative_segments() -> Callable[[str], tuple[str, ...]] | None:
    try:
        from hermes_cli.plugins_state import _plugin_relative_segments
    except Exception:  # noqa: BLE001 - any import failure means "core is not in this environment"
        return None
    return _plugin_relative_segments


REAL_RELATIVE_SEGMENTS = _real_relative_segments()
VALIDATOR_SOURCE = "hermes_cli" if REAL_RELATIVE_SEGMENTS is not None else "vendored copy"
plugin_relative_segments: Callable[[str], tuple[str, ...]] = REAL_RELATIVE_SEGMENTS or _vendored_relative_segments

_UNSET = object()


def _nested(root: object, segments: tuple[str, ...], default: Any) -> Any:
    current = root
    for segment in segments:
        if not isinstance(current, Mapping) or segment not in current:
            return default
        current = current[segment]
    return current


class RealContractContext:
    """Stands in for ``PluginContext``: real key validation, recorded tool registrations.

    ``settings`` is the plugin's ``plugins.entries.<id>.settings`` mapping, ``legacy_config`` its old
    ``config`` subtree. ``rejected`` lists every key core would have refused, in call order, so a
    test can assert on it even when the plugin swallowed the error.
    """

    def __init__(self, plugin_id: str, settings: Mapping[str, Any] | None = None,
                 legacy_config: Mapping[str, Any] | None = None) -> None:
        self.plugin_id = plugin_id
        self.settings = dict(settings or {})
        self.legacy_config = dict(legacy_config or {})
        self.rejected: list[Any] = []
        self.tools: dict[str, dict[str, Any]] = {}

    def get_config(self, key: str, default: Any = None) -> Any:
        try:
            segments = plugin_relative_segments(key)
        except ValueError:
            self.rejected.append(key)
            raise
        value = _nested(self.settings, segments, _UNSET)
        if value is not _UNSET:
            return value
        return _nested(self.legacy_config, segments, default)

    def register_tool(self, *, name: str, toolset: str, schema: Mapping[str, Any],
                      handler: Callable[..., Any], **extra: Any) -> None:
        if not name or not toolset or not callable(handler) or not isinstance(schema, Mapping):
            raise ValueError(f"malformed tool registration for {name!r}")
        if name in self.tools:
            raise ValueError(f"tool {name!r} registered twice")
        self.tools[name] = {"toolset": toolset, "schema": dict(schema), "handler": handler, **extra}
