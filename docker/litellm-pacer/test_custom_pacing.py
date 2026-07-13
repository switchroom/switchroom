"""Unit tests for the fleet LLM pacer's pure decision logic (custom_pacing.py).

These pin the *behaviour-neutral* contract of the vendored pacer without a live
LiteLLM proxy or a real Redis. They cover the four decision surfaces called out
for P0 of the pacer-durable-fix:

  * ADMIT      — _try_admit maps the atomic Lua verdict (1/0) to admit/wait.
  * FAIL-OPEN  — any Redis error on the admit path proceeds (returns True), so
                 the pacer can never wedge the fleet.
  * COOLDOWN   — the adaptive 429 cooldown is extend-only, capped at
                 MAX_COOLDOWN_S, and fires only on a real 429 signal.
  * RETRY-AFTER — _parse_retry_after reads the header off the common exception
                 shapes and degrades to None (never raises).

custom_pacing.py imports `litellm` at module top (it is a LiteLLM CustomLogger
callback). To keep this test pure-stdlib — no pip install, matching the
ci-tests-python lane — we inject lightweight stubs for the two litellm imports
into sys.modules BEFORE importing the module under test. The vendored file is
NOT modified in any way; these stubs only satisfy its import statements.

Run: python3 -m unittest discover -s docker/litellm-pacer -p 'test_*.py'
"""

from __future__ import annotations

import importlib
import os
import sys
import time
import types
import unittest


# --- Stub the top-level `litellm` imports so the module imports cleanly -------
# custom_pacing.py does:
#   from litellm._logging import verbose_proxy_logger
#   from litellm.integrations.custom_logger import CustomLogger
# Neither is exercised by the pure-logic paths under test; a no-op logger and a
# trivial base class are enough. We only install stubs if litellm is absent, so
# a CI image that happens to have real litellm still uses it.
def _install_litellm_stubs() -> None:
    if "litellm" in sys.modules:  # real litellm present — leave it be
        return

    litellm = types.ModuleType("litellm")

    logging_mod = types.ModuleType("litellm._logging")

    class _SilentLogger:
        def warning(self, *a, **k):  # noqa: D401 - stub
            pass

        def debug(self, *a, **k):
            pass

    logging_mod.verbose_proxy_logger = _SilentLogger()

    integrations_mod = types.ModuleType("litellm.integrations")
    custom_logger_mod = types.ModuleType("litellm.integrations.custom_logger")

    class CustomLogger:  # minimal stand-in for the ABC the pacer subclasses
        def __init__(self, *a, **k):
            pass

    custom_logger_mod.CustomLogger = CustomLogger

    litellm._logging = logging_mod
    litellm.integrations = integrations_mod
    integrations_mod.custom_logger = custom_logger_mod

    sys.modules["litellm"] = litellm
    sys.modules["litellm._logging"] = logging_mod
    sys.modules["litellm.integrations"] = integrations_mod
    sys.modules["litellm.integrations.custom_logger"] = custom_logger_mod


_install_litellm_stubs()

# Import the module under test (same directory; ci runs with -s on this dir).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
custom_pacing = importlib.import_module("custom_pacing")


# --- Async fake Redis --------------------------------------------------------
class FakeRedis:
    """Minimal async Redis double. Backs a plain dict; `eval` returns a preset
    verdict or raises a preset error to exercise the fail-open path."""

    def __init__(self, eval_result=1, eval_raises=None):
        self.store: dict = {}
        self.eval_result = eval_result
        self.eval_raises = eval_raises
        self.set_calls: list = []

    async def ping(self):
        return True

    async def get(self, key):
        return self.store.get(key)

    async def set(self, key, value, ex=None):
        self.store[key] = value
        self.set_calls.append((key, value, ex))
        return True

    async def eval(self, *args, **kwargs):
        if self.eval_raises is not None:
            raise self.eval_raises
        return self.eval_result

    async def zrem(self, *args, **kwargs):
        return 0


# --- Retry-After parsing (pure static method) --------------------------------
class ParseRetryAfterTests(unittest.TestCase):
    def _exc(self, **attrs):
        e = types.SimpleNamespace()
        for k, v in attrs.items():
            setattr(e, k, v)
        return e

    def test_headers_lowercase(self):
        exc = self._exc(headers={"retry-after": "7"})
        self.assertEqual(custom_pacing.FleetPacer._parse_retry_after(exc), 7.0)

    def test_headers_titlecase(self):
        exc = self._exc(headers={"Retry-After": "3"})
        self.assertEqual(custom_pacing.FleetPacer._parse_retry_after(exc), 3.0)

    def test_response_headers_fallback(self):
        exc = self._exc(response=types.SimpleNamespace(headers={"retry-after": "9"}))
        self.assertEqual(custom_pacing.FleetPacer._parse_retry_after(exc), 9.0)

    def test_missing_returns_none(self):
        self.assertIsNone(custom_pacing.FleetPacer._parse_retry_after(self._exc()))

    def test_non_numeric_degrades_to_none(self):
        exc = self._exc(headers={"retry-after": "soon"})
        self.assertIsNone(custom_pacing.FleetPacer._parse_retry_after(exc))


# --- Env parsing helpers (pure, fail-safe) -----------------------------------
class EnvHelperTests(unittest.TestCase):
    ENV_KEY = "PACE_TEST_ENV_HELPER"

    def tearDown(self):
        os.environ.pop(self.ENV_KEY, None)

    def test_int_valid(self):
        os.environ[self.ENV_KEY] = "42"
        self.assertEqual(custom_pacing._int_env(self.ENV_KEY, 8), 42)

    def test_int_invalid_falls_back(self):
        os.environ[self.ENV_KEY] = "not-an-int"
        self.assertEqual(custom_pacing._int_env(self.ENV_KEY, 8), 8)

    def test_int_missing_uses_default(self):
        self.assertEqual(custom_pacing._int_env(self.ENV_KEY, 8), 8)

    def test_float_valid(self):
        os.environ[self.ENV_KEY] = "1.5"
        self.assertEqual(custom_pacing._float_env(self.ENV_KEY, 20.0), 1.5)

    def test_float_invalid_falls_back(self):
        os.environ[self.ENV_KEY] = "nope"
        self.assertEqual(custom_pacing._float_env(self.ENV_KEY, 20.0), 20.0)


# --- Code-default invariant (P0 must not change defaults) ---------------------
class CodeDefaultTests(unittest.TestCase):
    """P0 is behaviour-neutral: the vendored file must keep its 8/60/4/20 code
    defaults. Live deployments override these via env (16/90/6/12) — that stays
    the deployment's job, not the repo copy's. This test fails loudly if a
    future edit silently changes a code default. It reads defaults straight from
    the source so it is unaffected by any PACE_* env set in the test runner."""

    def _default_of(self, func_name, arg_name):
        import ast

        src = os.path.join(os.path.dirname(__file__), "custom_pacing.py")
        with open(src, "r", encoding="utf-8") as fh:
            tree = ast.parse(fh.read())
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for t in node.targets:
                    if isinstance(t, ast.Name) and t.id == arg_name:
                        call = node.value
                        if isinstance(call, ast.Call) and len(call.args) >= 2:
                            return ast.literal_eval(call.args[1])
        raise AssertionError(f"{arg_name} default not found")

    def test_code_defaults_unchanged(self):
        self.assertEqual(self._default_of("_int_env", "MAX_CONCURRENCY"), 8)
        self.assertEqual(self._default_of("_int_env", "MAX_RPM"), 60)
        self.assertEqual(self._default_of("_int_env", "MAX_RPS"), 4)
        self.assertEqual(self._default_of("_float_env", "MAX_WAIT_S"), 20.0)
        self.assertEqual(self._default_of("_float_env", "MAX_COOLDOWN_S"), 60.0)
        self.assertEqual(self._default_of("_int_env", "LEASE_TTL_S"), 300)


# --- Admission + fail-open ----------------------------------------------------
class AdmitTests(unittest.IsolatedAsyncioTestCase):
    async def test_admit_when_lua_grants(self):
        pacer = custom_pacing.FleetPacer()
        r = FakeRedis(eval_result=1)
        self.assertTrue(await pacer._try_admit(r, "pace-1"))

    async def test_wait_when_lua_denies(self):
        pacer = custom_pacing.FleetPacer()
        r = FakeRedis(eval_result=0)
        self.assertFalse(await pacer._try_admit(r, "pace-1"))

    async def test_fail_open_on_redis_error(self):
        # A Redis error on the admit path must ADMIT (fail open) so the pacer
        # can never make the fleet worse than no pacer at all.
        pacer = custom_pacing.FleetPacer()
        r = FakeRedis(eval_raises=RuntimeError("redis down"))
        self.assertTrue(await pacer._try_admit(r, "pace-1"))


# --- Cooldown remaining (clamp math) -----------------------------------------
class CooldownRemainingTests(unittest.IsolatedAsyncioTestCase):
    async def test_future_cooldown_reported(self):
        pacer = custom_pacing.FleetPacer()
        r = FakeRedis()
        r.store[custom_pacing._COOLDOWN_KEY] = str(time.time() + 30)
        remaining = await pacer._cooldown_remaining(r)
        self.assertTrue(25 <= remaining <= 30)

    async def test_clamped_to_max_cooldown(self):
        pacer = custom_pacing.FleetPacer()
        r = FakeRedis()
        r.store[custom_pacing._COOLDOWN_KEY] = str(time.time() + 999)
        remaining = await pacer._cooldown_remaining(r)
        self.assertEqual(remaining, custom_pacing._Cfg.MAX_COOLDOWN_S)

    async def test_absent_key_is_zero(self):
        pacer = custom_pacing.FleetPacer()
        self.assertEqual(await pacer._cooldown_remaining(FakeRedis()), 0.0)

    async def test_past_cooldown_is_zero(self):
        pacer = custom_pacing.FleetPacer()
        r = FakeRedis()
        r.store[custom_pacing._COOLDOWN_KEY] = str(time.time() - 10)
        self.assertEqual(await pacer._cooldown_remaining(r), 0.0)


# --- Adaptive 429 cooldown (extend-only, capped, 429-gated) -------------------
class FailureHookCooldownTests(unittest.IsolatedAsyncioTestCase):
    def _pacer_with(self, fake):
        pacer = custom_pacing.FleetPacer()
        pacer._redis = fake  # bypass _get_redis (no real redis import)
        return pacer

    async def test_429_by_status_sets_default_cooldown(self):
        r = FakeRedis()
        pacer = self._pacer_with(r)
        exc = types.SimpleNamespace(status_code=429, message="slow down")
        before = time.time()
        await pacer.async_post_call_failure_hook({}, exc, None)
        self.assertIn(custom_pacing._COOLDOWN_KEY, r.store)
        parked = float(r.store[custom_pacing._COOLDOWN_KEY])
        # default cooldown is 5s when no Retry-After present
        self.assertTrue(before + 4 <= parked <= before + 6.5)

    async def test_429_by_message_sets_cooldown(self):
        r = FakeRedis()
        pacer = self._pacer_with(r)
        exc = types.SimpleNamespace(
            status_code=None, message="would exceed your account rate limit"
        )
        await pacer.async_post_call_failure_hook({}, exc, None)
        self.assertIn(custom_pacing._COOLDOWN_KEY, r.store)

    async def test_non_429_sets_no_cooldown(self):
        r = FakeRedis()
        pacer = self._pacer_with(r)
        exc = types.SimpleNamespace(status_code=500, message="internal error")
        await pacer.async_post_call_failure_hook({}, exc, None)
        self.assertNotIn(custom_pacing._COOLDOWN_KEY, r.store)

    async def test_retry_after_capped_at_max_cooldown(self):
        r = FakeRedis()
        pacer = self._pacer_with(r)
        # Retry-After far above MAX_COOLDOWN_S must be clamped to the cap.
        exc = types.SimpleNamespace(
            status_code=429, message="rate_limit_error", headers={"retry-after": "999"}
        )
        before = time.time()
        await pacer.async_post_call_failure_hook({}, exc, None)
        parked = float(r.store[custom_pacing._COOLDOWN_KEY])
        cap = custom_pacing._Cfg.MAX_COOLDOWN_S
        self.assertTrue(before + cap - 1 <= parked <= before + cap + 1)

    async def test_cooldown_is_extend_only(self):
        # A shorter incoming cooldown must NOT shorten an existing longer one.
        r = FakeRedis()
        pacer = self._pacer_with(r)
        long_until = time.time() + 50
        r.store[custom_pacing._COOLDOWN_KEY] = str(long_until)
        exc = types.SimpleNamespace(
            status_code=429, message="rate_limit_error", headers={"retry-after": "5"}
        )
        await pacer.async_post_call_failure_hook({}, exc, None)
        parked = float(r.store[custom_pacing._COOLDOWN_KEY])
        self.assertEqual(parked, long_until)  # unchanged — never shortened


if __name__ == "__main__":
    unittest.main()
