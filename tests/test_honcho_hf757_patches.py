"""HF-757: the baked Honcho plugin moves profiles onto the shipped SDK and stops deriving Kanban briefs."""
from __future__ import annotations

import importlib.util
import logging
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"
SESSION_FIXTURE = FIXTURES / "honcho_plugin_5c7d24b_session_excerpt.py"
INIT_FIXTURE = FIXTURES / "honcho_plugin_5c7d24b_session_init_excerpt.py"
SDK_LOCK = ROOT / "release" / "honcho-sdk-requirements.txt"
# Verbatim dependency block of hermes-plugin-honcho/pyproject.toml at the pinned 5c7d24b3.
PINNED_PYPROJECT = '''[project]
name = "hermes-plugin-honcho"
version = "1.2.0"
dependencies = [
    "honcho-ai>=2.2.0,<3",
    "httpx>=0.27,<1",
]
'''


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


floor = _load("patch_honcho_sdk_floor", "patch-honcho-sdk-floor.py")
observation = _load("patch_honcho_kanban_observation", "patch-honcho-kanban-observation.py")


def _exec(source: str, namespace: dict) -> dict:
    # The excerpts' relative imports need the plugin package; the tests inject those names instead.
    body = "\n".join(line for line in source.splitlines() if not line.lstrip().startswith("from ."))
    exec(compile(body, "honcho_excerpt", "exec"), namespace)
    return namespace


def _config(**overrides):
    """The HonchoClientConfig fields the session init reads, at the plugin's defaults."""
    values = dict(context_tokens=None, write_frequency="async", dialectic_reasoning_level="low",
                  dialectic_dynamic=True, dialectic_max_chars=600, dialectic_max_input_chars=10000,
                  user_observe_me=True, user_observe_others=True, ai_observe_me=True, ai_observe_others=True)
    return SimpleNamespace(**{**values, **overrides})


class _Provider:
    """The pinned provider's session init over the pinned manager's real observation-flag code."""

    def __init__(self, init_source: str):
        manager_class = _exec(SESSION_FIXTURE.read_text(encoding="utf-8"), {})["HonchoSessionManager"]

        class Manager(manager_class):
            def __init__(self, honcho=None, config=None, context_tokens=None, **_runtime):
                super().__init__(config=config)

            def get_or_create(self, key):
                return SimpleNamespace(key=key, messages=[])

        provider_class = _exec(init_source, {"logger": logging.getLogger("hf757"),
                                             "get_honcho_client": lambda cfg: object(),
                                             "HonchoSessionManager": Manager})["HonchoMemoryProvider"]
        self.provider = provider_class()
        self.provider._resolve_session_key = lambda cfg, session_id, **kwargs: session_id

    def manager_for(self, config=None, **init_kwargs):
        self.provider._do_session_init(config or _config(), "s1", **init_kwargs)
        return self.provider._manager


class SdkFloor(unittest.TestCase):
    def test_floor_matches_the_reviewed_sdk_lock(self):
        version = floor.reviewed_version(SDK_LOCK.read_text(encoding="utf-8"))
        patched = floor.patch_pyproject(PINNED_PYPROJECT, version)
        self.assertIn(f'"honcho-ai>={version},<3"', patched)
        self.assertNotIn('"honcho-ai>=2.2.0,<3"', patched)
        self.assertIn('"httpx>=0.27,<1"', patched)

    def test_main_rewrites_the_plugin_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            plugin = Path(tmp)
            (plugin / "pyproject.toml").write_text(PINNED_PYPROJECT, encoding="utf-8")
            lock = plugin / "lock.txt"
            lock.write_text("honcho-ai==2.9.0 \\\n    --hash=sha256:00\n", encoding="utf-8")
            self.assertEqual(floor.main(["x", str(plugin), str(lock)]), 0)
            self.assertIn('"honcho-ai>=2.9.0,<3"', (plugin / "pyproject.toml").read_text(encoding="utf-8"))

    def test_fails_closed_on_unexpected_shapes(self):
        with self.assertRaises(SystemExit):
            floor.reviewed_version("honcho-ai>=2.9.0\n")
        with self.assertRaises(SystemExit):
            floor.patch_pyproject(PINNED_PYPROJECT.replace("honcho-ai>=2.2.0,<3", "honcho-ai"), "2.9.0")
        with self.assertRaises(SystemExit):  # never lower a floor the plugin raised itself
            floor.patch_pyproject(PINNED_PYPROJECT.replace("2.2.0", "3.1.0"), "2.9.0")


class KanbanObservation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pinned = INIT_FIXTURE.read_text(encoding="utf-8")
        cls.patched = observation.patch_source(cls.pinned)

    def test_pinned_plugin_observes_kanban_briefs(self):
        manager = _Provider(self.pinned).manager_for(platform="kanban")
        self.assertEqual(manager._join_observation_flags("s1"), (True, True))

    def test_kanban_session_joins_the_user_peer_unobserved(self):
        manager = _Provider(self.patched).manager_for(platform="kanban", user_id="uid:1000")
        flags = manager._observation_flags("s1")
        self.assertEqual((flags["user_observe_me"], flags["user_observe_others"]), (False, False))
        self.assertEqual(manager._join_observation_flags("s1"), (False, False))

    def test_kanban_session_keeps_the_ai_flags_and_recall_observer(self):
        manager = _Provider(self.patched).manager_for(_config(ai_observe_me=False), platform="kanban")
        flags = manager._observation_flags("s1")
        self.assertEqual((flags["ai_observe_me"], flags["ai_observe_others"]), (False, True))
        self.assertTrue(manager._ai_observes_others(SimpleNamespace(honcho_session_id="s1")))

    def test_other_platforms_keep_configured_observation(self):
        for platform in ("cli", "telegram", "slack", "a2a", None):
            with self.subTest(platform=platform):
                kwargs = {} if platform is None else {"platform": platform}
                manager = _Provider(self.patched).manager_for(**kwargs)
                self.assertEqual(manager._join_observation_flags("s1"), (True, True))

    def test_patch_is_idempotent(self):
        self.assertEqual(observation.patch_source(self.patched), self.patched)

    def test_fails_closed_when_the_pin_moves(self):
        with self.assertRaises(SystemExit):
            observation.patch_source(self.pinned.replace("self._session_key = self._resolve_session_key(", "x = ("))


if __name__ == "__main__":
    unittest.main()
