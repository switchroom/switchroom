"""The Linear plugin's reach into Core, checked against the real pinned Agent source.

The plugin imports Kanban, gateway and tool internals that no published plugin API
covers (``kanban_db.block_task(..., expected_event_id=)``, ``_owner_process_gone``,
``kanban_owner_recovery.attempt_instance_replaced`` and so on). Most of those imports
sit inside functions or behind ``except ImportError`` fallbacks, so an upstream sync
that renames a symbol or a keyword does not fail at import time: Linear reporting
just degrades. This module derives every such use from the plugin source itself
(no hand-kept list), then asserts each symbol resolves in Core and each call's
keywords and positional count bind to the real signature. A failure names the
symbol and the plugin call site.

It runs in the CI ``runtime (kanban K/3)`` legs through scripts/run-linear-scenarios.py,
which checks out ``switchroom/hermes-agent`` at release/agent-image-manifest.json's
revision and refuses skips. A manifest change selects the full suite, so every
Core pin bump runs it. The Core contract class exists only when HERMES_AGENT_SRC is
at that release revision; elsewhere only the Core-free ``CollectorProof`` runs,
which also runs in source-tests.
"""
from __future__ import annotations

import ast
import asyncio
import importlib
import importlib.util
import inspect
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import types
import unittest
from contextlib import closing
from dataclasses import dataclass
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "linear"
SOURCE = os.environ.get("HERMES_AGENT_SRC")
if SOURCE:
    sys.path.insert(0, SOURCE)


def _release_revision() -> str:
    spec = importlib.util.spec_from_file_location("agent_image_manifest", ROOT / "scripts/read-agent-image-manifest.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.load_manifest(ROOT / "release/agent-image-manifest.json")["revision"]


def _source_revision(source: str) -> str | None:
    try:
        return subprocess.run(["git", "-C", source, "rev-parse", "HEAD"],
                              check=True, capture_output=True, text=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


# The contract is a claim about the Core this plugin ships against: the release manifest pin.
# A checkout at any other revision makes no such claim, so the Core contract class is not defined there at all
# rather than skipped (the scenario runner refuses skips).
RELEASE_CORE = bool(SOURCE) and _source_revision(SOURCE) == _release_revision()


@dataclass(frozen=True)
class Use:
    """One plugin reference to a Core symbol: ``path`` is ``module:attr.attr``."""
    path: str
    site: str
    keywords: tuple[str, ...] = ()
    positional: int | None = None  # None: not a call, or the call forwards *args
    optional: bool = False  # getattr(..., default) probes tolerate absence


def core_roots(source: Path) -> set[str]:
    """Top-level importable names that the Agent checkout provides."""
    roots = {p.name for p in source.iterdir() if p.is_dir() and (p / "__init__.py").exists()}
    roots |= {p.stem for p in source.glob("*.py")}
    return roots


_SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)


def _own_nodes(body):
    """Nodes of one scope, not descending into nested functions (their imports are their own)."""
    pending = list(body)
    while pending:
        node = pending.pop()
        yield node
        if not isinstance(node, _SCOPES):
            pending.extend(ast.iter_child_nodes(node))


def _core_imports(node, roots):
    """(bound name, ``module:attr`` or ``module``) pairs for a Core import statement."""
    if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module \
            and node.module.split(".")[0] in roots:
        return [(alias.asname or alias.name, f"{node.module}:{alias.name}") for alias in node.names]
    if isinstance(node, ast.Import):
        return [(alias.asname or alias.name.split(".")[0], alias.name if alias.asname else alias.name.split(".")[0])
                for alias in node.names if alias.name.split(".")[0] in roots]
    return []


def _join(base: str, attr: str) -> str:
    return base + ("." if ":" in base else ":") + attr


class _Collector(ast.NodeVisitor):
    """Scope-aware walk: imports bind names, then attribute chains and calls are resolved."""

    def __init__(self, rel: str, roots: set[str], attr_aliases: dict[str, str]):
        self.rel, self.roots, self.attr_aliases = rel, roots, attr_aliases
        self.uses: list[Use] = []
        self.scopes: list[dict[str, str]] = []

    def _site(self, node) -> str:
        return f"plugins/linear/{self.rel}:{node.lineno}"

    def _enter(self, node, body):
        scope = {}
        for child in _own_nodes(body):
            for name, path in _core_imports(child, self.roots):
                scope[name] = path
                self.uses.append(Use(path, self._site(child)))
        self.scopes.append(scope)
        self.generic_visit(node)
        self.scopes.pop()

    def visit_Module(self, node):
        self._enter(node, node.body)

    def visit_FunctionDef(self, node):
        self._enter(node, node.body)

    def visit_AsyncFunctionDef(self, node):
        self._enter(node, node.body)

    def _resolve(self, node) -> str | None:
        """Core path of an expression rooted at a bound name or a Core-module attribute alias."""
        if isinstance(node, ast.Name):
            for scope in reversed(self.scopes):
                if node.id in scope:
                    return scope[node.id]
            return None
        if isinstance(node, ast.Attribute):
            base = self._resolve(node.value)
            if base is None:
                return self.attr_aliases.get(node.attr)  # self.kb / adapter.kb -> hermes_cli.kanban_db
            return _join(base, node.attr)
        return None

    def visit_Attribute(self, node):
        resolved = self._resolve(node)
        if resolved is not None and ":" in resolved:
            self.uses.append(Use(resolved, self._site(node)))
        self.generic_visit(node)

    def visit_Call(self, node):
        if isinstance(node.func, ast.Name) and node.func.id == "getattr" and len(node.args) >= 2 \
                and isinstance(node.args[1], ast.Constant) and isinstance(node.args[1].value, str):
            base = self._resolve(node.args[0])
            if base is not None:
                self.uses.append(Use(_join(base, node.args[1].value), self._site(node),
                                     optional=len(node.args) >= 3))
        resolved = self._resolve(node.func)
        if resolved is not None and ":" in resolved:
            star = any(isinstance(arg, ast.Starred) for arg in node.args)
            self.uses.append(Use(resolved, self._site(node),
                                 keywords=tuple(k.arg for k in node.keywords if k.arg is not None),
                                 positional=None if star else len(node.args)))
        self.generic_visit(node)


def _attribute_aliases(trees, roots) -> dict[str, str]:
    """``self.kb, self.kc = kanban_db, kanban_db_connect`` makes ``<x>.kb`` mean that Core module."""
    aliases: dict[str, str] = {}
    for tree in trees.values():
        for func in ast.walk(tree):
            if not isinstance(func, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            local = {name: path.replace(":", ".") for node in _own_nodes(func.body)
                     for name, path in _core_imports(node, roots)}
            for node in _own_nodes(func.body):
                if not isinstance(node, ast.Assign):
                    continue
                for target in node.targets:
                    pairs = (zip(target.elts, node.value.elts)
                             if isinstance(target, ast.Tuple) and isinstance(node.value, ast.Tuple)
                             else [(target, node.value)])
                    for left, right in pairs:
                        if isinstance(left, ast.Attribute) and isinstance(right, ast.Name) and right.id in local:
                            previous = aliases.setdefault(left.attr, local[right.id])
                            if previous != local[right.id]:
                                raise AssertionError(f"attribute alias .{left.attr} names both "
                                                     f"{previous} and {local[right.id]}")
    return aliases


def collect_uses(plugin: Path, roots: set[str]) -> list[Use]:
    trees = {path.name: ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
             for path in sorted(plugin.glob("*.py"))}
    aliases = _attribute_aliases(trees, roots)
    uses: list[Use] = []
    for rel, tree in trees.items():
        collector = _Collector(rel, roots, aliases)
        collector.visit(tree)
        uses.extend(collector.uses)
    return uses


def canonical(path: str) -> str:
    """``hermes_cli:kanban_db.block_task`` -> ``hermes_cli.kanban_db:block_task``."""
    module, _, attrs = path.partition(":")
    parts = attrs.split(".") if attrs else []
    while parts:
        try:
            if importlib.util.find_spec(f"{module}.{parts[0]}") is None:
                break
        except (ImportError, AttributeError, ValueError):
            break
        module = f"{module}.{parts.pop(0)}"
    return module + (":" + ".".join(parts) if parts else "")


def _resolve_object(path: str, importer):
    """``module`` or ``module:attr.attr`` -> object; a module attribute may itself be a submodule."""
    def load(name):
        try:
            return importer(name)
        except KeyError as exc:  # dict-backed fake importers
            raise ModuleNotFoundError(name, name=name) from exc
    module_name, _, attrs = path.partition(":")
    obj, current = load(module_name), module_name
    for part in attrs.split(".") if attrs else ():
        if hasattr(obj, part):
            obj = getattr(obj, part)
        elif isinstance(obj, types.ModuleType):
            try:
                obj = load(f"{current}.{part}")  # ``from hermes_cli import kanban_db``
            except ModuleNotFoundError as exc:
                if exc.name != f"{current}.{part}":
                    raise  # a real dependency failure inside an existing submodule
                raise AttributeError(f"{current} has no attribute {part!r}") from exc
        else:
            raise AttributeError(f"{current} has no attribute {part!r}")
        current = f"{current}.{part}"
    return obj


def violations(uses, importer=importlib.import_module) -> list[str]:
    problems = []
    for use in uses:
        try:
            obj = _resolve_object(use.path, importer)
        except (ImportError, AttributeError) as exc:
            if not use.optional:
                problems.append(f"{use.site}: Core symbol {use.path} is missing ({type(exc).__name__}: {exc})")
            continue
        if use.positional is None and not use.keywords:
            continue
        try:
            signature = inspect.signature(obj)
        except (TypeError, ValueError):
            continue  # no introspectable signature (C builtins); nothing plugin-specific to bind
        try:
            signature.bind_partial(*([object()] * (use.positional or 0)),
                                   **{name: object() for name in use.keywords})
        except TypeError as exc:
            problems.append(f"{use.site}: call to Core {use.path}{signature} rejects the plugin's "
                            f"{use.positional or 0} positional argument(s) and keywords "
                            f"{list(use.keywords)}: {exc}")
    return problems


class CollectorProof(unittest.TestCase):
    """The checker itself must catch a removed symbol and a renamed keyword (no Core needed)."""

    SAMPLE = (
        "class Kanban:\n"
        "    def __init__(self):\n"
        "        from fakecore import kanban_db\n"
        "        self.kb = kanban_db\n"
        "    def stop(self, conn):\n"
        "        return self.kb.block_task(conn, 't', reason='r', expected_event_id=1)\n"
        "def limit():\n"
        "    from fakecore.kanban_db import BLOCK_RECURRENCE_LIMIT\n"
        "    return BLOCK_RECURRENCE_LIMIT\n"
    )

    def fake_core(self):
        kanban_db = types.ModuleType("fakecore.kanban_db")
        def block_task(conn, task_id, *, reason=None, kind=None, expected_run_id=None, expected_event_id=None):
            return True
        kanban_db.block_task = block_task
        kanban_db.BLOCK_RECURRENCE_LIMIT = 3
        package = types.ModuleType("fakecore")
        package.kanban_db = kanban_db
        return kanban_db, {"fakecore": package, "fakecore.kanban_db": kanban_db}.__getitem__

    def scan(self, source: str):
        with tempfile.TemporaryDirectory() as temp:
            Path(temp, "mod.py").write_text(source, encoding="utf-8")
            return collect_uses(Path(temp), {"fakecore"})

    def test_current_fake_core_passes(self):
        _kb, importer = self.fake_core()
        uses = self.scan(self.SAMPLE)
        self.assertIn(Use("fakecore.kanban_db:block_task", "plugins/linear/mod.py:6",
                          ("reason", "expected_event_id"), 2), uses)
        self.assertEqual(violations(uses, importer), [])

    def test_renamed_keyword_names_symbol_and_site(self):
        kanban_db, importer = self.fake_core()
        def block_task(conn, task_id, *, reason=None, kind=None, expected_run_id=None, expected_revision=None):
            return True
        kanban_db.block_task = block_task
        problems = violations(self.scan(self.SAMPLE), importer)
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("plugins/linear/mod.py:6: call to Core fakecore.kanban_db:block_task", problems[0])
        self.assertIn("expected_event_id", problems[0])

    def test_removed_symbol_names_symbol_and_site(self):
        kanban_db, importer = self.fake_core()
        del kanban_db.BLOCK_RECURRENCE_LIMIT
        problems = violations(self.scan(self.SAMPLE), importer)
        self.assertEqual(problems, ["plugins/linear/mod.py:8: Core symbol fakecore.kanban_db:BLOCK_RECURRENCE_LIMIT "
                                    "is missing (AttributeError: fakecore.kanban_db has no attribute "
                                    "'BLOCK_RECURRENCE_LIMIT')"])

    def test_extra_positional_is_refused(self):
        _kb, importer = self.fake_core()
        problems = violations(self.scan(self.SAMPLE.replace("'t', reason", "'t', 'x', reason")), importer)
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("3 positional", problems[0])

    def test_optional_getattr_probe_tolerates_absence(self):
        kanban_db, importer = self.fake_core()
        del kanban_db.BLOCK_RECURRENCE_LIMIT
        source = ("def f(adapter):\n"
                  "    from fakecore import kanban_db\n"
                  "    adapter.kb = kanban_db\n"
                  "    return getattr(adapter.kb, 'BLOCK_RECURRENCE_LIMIT', 1)\n")
        self.assertEqual(violations(self.scan(source), importer), [])


@unittest.skipUnless(SOURCE, "requires explicit official HERMES_AGENT_SRC")
class CoreContractScenarios(unittest.TestCase):
    """The plugin source against the real manifest-pinned Core (release/agent-image-manifest.json)."""

    @classmethod
    def setUpClass(cls):
        cls.source = Path(SOURCE).resolve()
        cls.uses = collect_uses(PLUGIN, core_roots(cls.source))

    def test_core_resolves_from_the_pinned_checkout(self):
        from hermes_cli import kanban_db
        self.assertTrue(Path(kanban_db.__file__).resolve().is_relative_to(self.source))

    def test_derived_uses_cover_the_known_kanban_surface(self):
        """Guard the collector against silently seeing nothing (for example after a plugin refactor)."""
        paths = {canonical(use.path) for use in self.uses}
        for expected in ("hermes_cli.kanban_db:block_task", "hermes_cli.kanban_db:unblock_task",
                         "hermes_cli.kanban_db:add_comment", "hermes_cli.kanban_db:write_txn",
                         "hermes_cli.kanban_db:_require_task", "hermes_cli.kanban_db:create_task",
                         "hermes_cli.kanban_db:complete_task", "hermes_cli.kanban_db:BLOCK_RECURRENCE_LIMIT",
                         "hermes_cli.kanban_db:_pid_alive", "hermes_cli.kanban_db:Run.from_row",
                         "hermes_cli.kanban_db_connect:init_db", "hermes_cli.kanban_db_boards:create_board",
                         "hermes_cli.kanban_db_dispatch:_process_fingerprint",
                         "hermes_cli.kanban_owner_recovery:attempt_instance_replaced",
                         "hermes_cli.kanban_owner_recovery:_owner_process_gone",
                         "hermes_cli.kanban_pr_acceptance:collect_acceptance"):
            self.assertIn(expected, paths)
        keywords = {kw for use in self.uses
                    if canonical(use.path) == "hermes_cli.kanban_db:block_task" for kw in use.keywords}
        self.assertTrue({"reason", "kind", "expected_run_id", "expected_event_id"} <= keywords, keywords)

    def test_every_plugin_core_symbol_and_call_binds(self):
        problems = violations(self.uses)
        self.assertEqual(problems, [], "\n" + "\n".join(problems))

    def test_guarded_control_keywords_are_present(self):
        """bridge.Kanban.guarded_controls refuses activation without these; absence must fail CI, not degrade."""
        from hermes_cli import kanban_db
        for name, required in (("block_task", {"expected_event_id", "expected_run_id", "kind"}),
                               ("unblock_task", {"expected_event_id", "request_id"})):
            parameters = set(inspect.signature(getattr(kanban_db, name)).parameters)
            self.assertTrue(required <= parameters, f"kanban_db.{name} lacks {required - parameters} "
                            "(plugins/linear/bridge.py Kanban.guarded_controls)")

    def test_respawn_guard_pr_link_matches_core(self):
        """bridge._GUARD_PR_URL copies kanban_db_dispatch._RESPAWN_GUARD_PR_URL_RE (bridge.py newest_pr_url)."""
        from hermes_cli.kanban_db_dispatch import _RESPAWN_GUARD_PR_URL_RE
        sys.path.insert(0, str(ROOT / "tests"))
        from linear_fake_api import load_plugin
        load_plugin()
        from hermes_fleet_linear_plugin import bridge
        self.assertEqual((bridge._GUARD_PR_URL.pattern, bridge._GUARD_PR_URL.flags),
                         (_RESPAWN_GUARD_PR_URL_RE.pattern, _RESPAWN_GUARD_PR_URL_RE.flags))

    def test_core_calls_the_kanban_prompt_consumer_hook_with_the_card_the_plugin_reads(self):
        """gateway.session_kanban_prompts.consumer -> adapter.kanban_prompt_consumer(card) (native_input.py)."""
        from gateway import session_kanban_prompts
        seen = []

        class Adapter:
            def kanban_prompt_consumer(self, card):
                seen.append(dict(card))
                return None

        with tempfile.TemporaryDirectory() as temp:
            db = Path(temp, "kanban.db")
            with closing(sqlite3.connect(db)):
                pass
            context = {"board": "default", "task_id": "t_0123abcd", "run_id": 7, "db": str(db)}
            # Core with the process-Stop fence keeps the claim check in session_kanban_stop; Core
            # without it (Stop is the native interrupt) moved it into session_kanban.
            try:
                import gateway.session_kanban_stop as claim_home
            except ImportError:
                import gateway.session_kanban as claim_home
            with patch.object(claim_home, "require_current_claim", lambda conn, ctx: None), \
                    patch("gateway.session_local_recovery.local_adapter_map", lambda authority: {"a": Adapter()}):
                result = asyncio.run(session_kanban_prompts.consumer(object(), context))
        self.assertIsNone(result)
        self.assertEqual(len(seen), 1, "Core no longer calls adapter.kanban_prompt_consumer")
        self.assertTrue({"board", "task_id", "run_id", "db"} <= set(seen[0]), seen[0])

    def _registered_hooks(self, state: Path) -> dict:
        sys.path.insert(0, str(ROOT / "tests"))
        from linear_fake_api import load_plugin
        plugin = load_plugin()

        class Context:
            def __init__(self):
                self.hooks: dict = {}

            def get_config(self, key, default=None):
                return {"enabled": True, "chat_guard": True, "state_database": str(state)}.get(key, default)

            def register_hook(self, name, callback):
                self.hooks.setdefault(name, []).append(callback)

            def __getattr__(self, name):
                if name.startswith("register_") or name == "on_unload":
                    return lambda *args, **kwargs: None
                raise AttributeError(name)

        context = Context()
        # A foreground (non-worker, non-gateway) load: every hook, no reporting service thread.
        with patch.dict(os.environ, {"_HERMES_GATEWAY": "0"}):
            os.environ.pop("HERMES_KANBAN_TASK", None)
            plugin.register(context)
        return context.hooks

    def test_every_hook_the_plugin_registers_is_a_core_hook(self):
        """A hook Core does not know is stored but never fired: a rename would silently drop it."""
        from hermes_cli.plugins import VALID_HOOKS
        with tempfile.TemporaryDirectory() as temp:
            hooks = self._registered_hooks(Path(temp, "state.db"))
        self.assertIn("on_kanban_dispatch_tick", hooks)  # the collector saw the registration path
        self.assertEqual(sorted(set(hooks) - VALID_HOOKS), [])

    def test_core_notifier_names_a_tracked_task_as_its_linked_issue(self):
        """gateway.kanban_watchers_notifier._task_link -> kanban_task_link (chat.task_link).

        A Core without the hook gets no registration and keeps plain titles; a Core with it
        renders [KEY Title](url) for the bound task and nothing for an untracked one.
        """
        from hermes_cli.plugins import VALID_HOOKS, get_plugin_manager
        url = "https://linear.app/acme/issue/HF-123/fix-the-thing"
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp, "state.db")
            hooks = self._registered_hooks(state)
            from hermes_fleet_linear_plugin.bridge import TASK_BODY
            from hermes_fleet_linear_plugin.store import Store
            Store(state).bind_native("issue-uuid-1", "t_tracked", "alpha", "default", at=100)
            if "kanban_task_link" not in VALID_HOOKS:
                self.assertNotIn("kanban_task_link", hooks)
                return
            from gateway.kanban_watchers_notifier import _task_link
            manager = get_plugin_manager()
            saved = {name: list(callbacks) for name, callbacks in manager._hooks.items()}
            manager._hooks["kanban_task_link"] = list(hooks["kanban_task_link"])
            try:
                body = TASK_BODY.format(ident="HF-123", url=url, context="context")
                tracked = types.SimpleNamespace(id="t_tracked", title="HF-123: Fix the thing", body=body)
                untracked = types.SimpleNamespace(id="t_other", title="HF-123: Fix the thing", body=body)
                self.assertEqual(_task_link(tracked, "default"), f"[HF-123 Fix the thing]({url})")
                self.assertIsNone(_task_link(untracked, "default"))
            finally:
                manager._hooks = saved


if SOURCE and not RELEASE_CORE:
    del CoreContractScenarios


if __name__ == "__main__":
    unittest.main()
