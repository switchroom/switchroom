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
import random
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
        self.eval_calls = 0

    async def ping(self):
        return True

    async def get(self, key):
        return self.store.get(key)

    async def set(self, key, value, ex=None):
        self.store[key] = value
        self.set_calls.append((key, value, ex))
        return True

    async def eval(self, *args, **kwargs):
        self.eval_calls += 1
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

    def test_l1_knob_defaults(self):
        # The absolute hard cap ships ACTIVE (45s), but with 45 > MAX_WAIT_S it
        # never fires in normal burst-smoothing => behaviour-neutral by default.
        self.assertEqual(self._default_of("_float_env", "HARD_MAX_WAIT_S"), 45.0)
        self.assertEqual(self._default_of("_float_env", "COOLDOWN_HOLD_CEILING_S"), 60.0)
        self.assertEqual(self._default_of("_float_env", "RELEASE_JITTER_S"), 1.0)
        # Hard cap must be >= MAX_WAIT_S so it can only ever shorten a pathological
        # wait, never a normal one (the neutrality invariant).
        self.assertGreaterEqual(
            self._default_of("_float_env", "HARD_MAX_WAIT_S"),
            self._default_of("_float_env", "MAX_WAIT_S"),
        )
        # The hold-ceiling stays within MAX_COOLDOWN_S (design constraint).
        self.assertLessEqual(
            self._default_of("_float_env", "COOLDOWN_HOLD_CEILING_S"),
            self._default_of("_float_env", "MAX_COOLDOWN_S"),
        )

    def test_cooldown_hold_gate_defaults_off(self):
        # The load-bearing neutrality guard: the cooldown-HOLD regime MUST default
        # OFF so merging + redeploy is behaviour-neutral until we set the env at
        # rollout. Read straight from source so a runner env can't mask a change.
        src = os.path.join(os.path.dirname(__file__), "custom_pacing.py")
        with open(src, "r", encoding="utf-8") as fh:
            source = fh.read()
        self.assertIn('os.getenv("PACE_COOLDOWN_HOLD", "false")', source)


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


# --- Layer 1: cooldown-hold + hard-wait backstop wait-loop behaviour ---------
# These are the load-bearing behavioural tests for the two-regime wait ceiling
# (custom_pacing.py async_pre_call_hook). They drive the real hook with a fake
# Redis that NEVER admits (eval_result=0) and a cooldown parked far in the
# future, then assert the wait terminates in the right regime and — above all —
# that the absolute hard cap can never be exceeded.
_CFG_KNOBS = (
    "ENABLED",
    "MAX_WAIT_S",
    "HARD_MAX_WAIT_S",
    "COOLDOWN_HOLD",
    "COOLDOWN_HOLD_CEILING_S",
    "RELEASE_JITTER_S",
    "POLL_MIN_S",
    "POLL_MAX_S",
)


class _CfgPatchMixin:
    """Snapshot + restore the _Cfg class attributes each test mutates, so the
    live/import-time config is never leaked between tests."""

    def setUp(self):
        super().setUp()
        self._saved_cfg = {k: getattr(custom_pacing._Cfg, k) for k in _CFG_KNOBS}
        # Sane, fast baseline; individual tests override what they exercise.
        custom_pacing._Cfg.ENABLED = True
        custom_pacing._Cfg.POLL_MIN_S = 0.02
        custom_pacing._Cfg.POLL_MAX_S = 0.04
        custom_pacing._Cfg.RELEASE_JITTER_S = 0.05

    def tearDown(self):
        for k, v in self._saved_cfg.items():
            setattr(custom_pacing._Cfg, k, v)
        super().tearDown()

    def _denying_redis_with_future_cooldown(self):
        r = FakeRedis(eval_result=0)  # _try_admit -> always "wait"
        r.store[custom_pacing._COOLDOWN_KEY] = str(time.time() + 999)
        return r

    async def _run_hook(self, pacer, r):
        pacer._redis = r  # bypass _get_redis (no real redis import)
        return await pacer.async_pre_call_hook(None, None, {}, "pass_through_endpoint")


class HardCapInvariantTests(_CfgPatchMixin, unittest.IsolatedAsyncioTestCase):
    async def test_hard_cap_dominates_cooldown_hold(self):
        """LOAD-BEARING: with cooldown-HOLD enabled and a cooldown parked far in
        the future (so the hold branch is fully engaged), the wait MUST fail open
        within HARD_MAX_WAIT_S and NEVER hold to the (much larger) hold ceiling.
        Verified across MANY iterations. If someone bypasses the hard-cap check
        in the hold branch, the loop runs to COOLDOWN_HOLD_CEILING_S instead and
        elapsed blows past the assertion -> this test fails."""
        custom_pacing._Cfg.COOLDOWN_HOLD = True
        custom_pacing._Cfg.HARD_MAX_WAIT_S = 0.5
        custom_pacing._Cfg.COOLDOWN_HOLD_CEILING_S = 3.0  # >> hard cap on purpose
        custom_pacing._Cfg.MAX_WAIT_S = 0.3

        pacer = custom_pacing.FleetPacer()
        r = self._denying_redis_with_future_cooldown()
        t0 = time.time()
        await self._run_hook(pacer, r)
        elapsed = time.time() - t0

        # Bounded by the hard cap (with slack for one final backoff), and clearly
        # BELOW the 3.0s hold ceiling — proving the hard cap, not the ceiling,
        # stopped the wait.
        self.assertLessEqual(elapsed, custom_pacing._Cfg.HARD_MAX_WAIT_S + 0.4)
        self.assertLess(elapsed, custom_pacing._Cfg.COOLDOWN_HOLD_CEILING_S)
        # It actually held (didn't leak at MAX_WAIT_S) and looped many times, so
        # the cap is enforced on EVERY iteration, not just once.
        self.assertGreaterEqual(elapsed, custom_pacing._Cfg.MAX_WAIT_S)
        self.assertGreaterEqual(r.eval_calls, 3)

    async def test_hard_cap_enforced_every_iteration_probe(self):
        """Explicitly assert the cap is re-checked each loop: shrink the hard cap
        below MAX_WAIT_S and confirm the wait ends at the hard cap even though the
        (burst) regime ceiling is larger — only possible if the hard-cap check
        runs first, every iteration."""
        custom_pacing._Cfg.COOLDOWN_HOLD = False
        custom_pacing._Cfg.HARD_MAX_WAIT_S = 0.3
        custom_pacing._Cfg.MAX_WAIT_S = 5.0  # regime ceiling >> hard cap

        pacer = custom_pacing.FleetPacer()
        r = FakeRedis(eval_result=0)
        t0 = time.time()
        await self._run_hook(pacer, r)
        elapsed = time.time() - t0
        self.assertLessEqual(elapsed, custom_pacing._Cfg.HARD_MAX_WAIT_S + 0.4)
        self.assertLess(elapsed, custom_pacing._Cfg.MAX_WAIT_S)
        self.assertGreaterEqual(r.eval_calls, 2)


class CooldownHoldRegimeTests(_CfgPatchMixin, unittest.IsolatedAsyncioTestCase):
    async def test_hold_queues_past_burst_ceiling_when_enabled(self):
        """With cooldown-HOLD ON and a signalled cooldown active, the wait must
        HOLD past the short MAX_WAIT_S burst ceiling (not leak at 12s), bounded by
        COOLDOWN_HOLD_CEILING_S."""
        custom_pacing._Cfg.COOLDOWN_HOLD = True
        custom_pacing._Cfg.MAX_WAIT_S = 0.3
        custom_pacing._Cfg.COOLDOWN_HOLD_CEILING_S = 1.0
        custom_pacing._Cfg.HARD_MAX_WAIT_S = 5.0

        pacer = custom_pacing.FleetPacer()
        r = self._denying_redis_with_future_cooldown()
        t0 = time.time()
        data = await self._run_hook(pacer, r)
        elapsed = time.time() - t0

        # Held well past the 0.3s burst ceiling ...
        self.assertGreater(elapsed, custom_pacing._Cfg.MAX_WAIT_S + 0.2)
        # ... but bounded by the hold ceiling (and the hard cap).
        self.assertLessEqual(elapsed, custom_pacing._Cfg.COOLDOWN_HOLD_CEILING_S + 0.4)
        self.assertLess(elapsed, custom_pacing._Cfg.HARD_MAX_WAIT_S)
        # Fail-open contract preserved: the request still proceeds (data back).
        self.assertIsInstance(data, dict)

    async def test_default_off_leaks_at_burst_ceiling_regression(self):
        """REGRESSION GUARD: with cooldown-HOLD at its default (OFF), behaviour is
        unchanged from today — even during an active cooldown the wait fails open
        at the short MAX_WAIT_S burst ceiling, exactly as pre-L1."""
        custom_pacing._Cfg.COOLDOWN_HOLD = False
        custom_pacing._Cfg.MAX_WAIT_S = 0.3
        custom_pacing._Cfg.COOLDOWN_HOLD_CEILING_S = 60.0
        custom_pacing._Cfg.HARD_MAX_WAIT_S = 45.0

        pacer = custom_pacing.FleetPacer()
        r = self._denying_redis_with_future_cooldown()
        t0 = time.time()
        await self._run_hook(pacer, r)
        elapsed = time.time() - t0

        # Leaks at the burst ceiling, NOT the hold ceiling — i.e. hold is off.
        self.assertLessEqual(elapsed, custom_pacing._Cfg.MAX_WAIT_S + 0.3)


class ReleaseJitterTests(_CfgPatchMixin, unittest.TestCase):
    def test_release_jitter_spreads_admissions(self):
        """Thundering-herd guard: while HOLDING, the backoff adds a bounded
        release-jitter term so queued requests re-admit spread across a window
        instead of stampeding one instant. The burst-smoothing regime keeps the
        original POLL_MIN..POLL_MAX behaviour unchanged."""
        custom_pacing._Cfg.POLL_MIN_S = 0.10
        custom_pacing._Cfg.POLL_MAX_S = 0.40
        custom_pacing._Cfg.RELEASE_JITTER_S = 1.0
        pacer = custom_pacing.FleetPacer()

        random.seed(20260713)
        holding = [pacer._backoff_sleep_s(True) for _ in range(300)]
        burst = [pacer._backoff_sleep_s(False) for _ in range(300)]

        # Burst regime unchanged: strictly within the poll window.
        self.assertTrue(all(0.10 <= x <= 0.40 for x in burst))
        # Hold regime: release jitter pushes some waits beyond the poll ceiling
        # and spreads them across a wide window (no synchronized re-admit).
        self.assertGreater(max(holding), 0.40)
        self.assertGreater(max(holding) - min(holding), 0.40)
        # Not a stampede: the released attempts land on many distinct delays.
        self.assertGreater(len({round(x, 4) for x in holding}), 200)

    def test_release_jitter_zero_is_pure_poll(self):
        """RELEASE_JITTER_S=0 disables the extra term: holding backoff collapses
        back to the plain poll window (escape hatch / neutrality)."""
        custom_pacing._Cfg.POLL_MIN_S = 0.10
        custom_pacing._Cfg.POLL_MAX_S = 0.40
        custom_pacing._Cfg.RELEASE_JITTER_S = 0.0
        pacer = custom_pacing.FleetPacer()
        random.seed(7)
        holding = [pacer._backoff_sleep_s(True) for _ in range(200)]
        self.assertTrue(all(0.10 <= x <= 0.40 for x in holding))


if __name__ == "__main__":
    unittest.main()
