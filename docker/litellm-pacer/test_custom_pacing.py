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

import asyncio
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

        # The lease-release patch installers log at .error (litellm layout
        # drift) and .info (patch installed) at IMPORT time. A stub missing
        # either would raise AttributeError during `import custom_pacing` —
        # which is exactly the failure mode the installers' _safe() wrappers
        # exist to contain, so the stub must be complete enough that these
        # tests exercise the real path rather than the swallow.
        def error(self, *a, **k):
            pass

        def info(self, *a, **k):
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
        self.zrem_calls: list = []
        # Token-budget round trips (reconciliation + fail-open recording).
        self.hincrby_calls: list = []
        self.expire_calls: list = []

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
        # Records every lease-release round trip so the release tests can
        # assert BOTH that a release happened and that it happened once.
        self.zrem_calls.append(args)
        return 0

    async def hincrby(self, key, field, amount):
        self.hincrby_calls.append((key, field, int(amount)))
        h = self.store.get(key)
        if not isinstance(h, dict):
            h = {}
            self.store[key] = h
        h[str(field)] = int(h.get(str(field), 0)) + int(amount)
        return h[str(field)]

    async def expire(self, key, ttl):
        self.expire_calls.append((key, ttl))
        return True


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
                        # Walk the whole RHS so we still find the inner
                        # _int_env/_float_env default even when it is wrapped in a
                        # clamp call (e.g. _clamp_hard_max_wait(_float_env(...))).
                        for sub in ast.walk(node.value):
                            if (
                                isinstance(sub, ast.Call)
                                and isinstance(sub.func, ast.Name)
                                and sub.func.id == func_name
                                and len(sub.args) >= 2
                            ):
                                return ast.literal_eval(sub.args[1])
        raise AssertionError(f"{arg_name} default not found")

    def test_code_defaults_unchanged(self):
        self.assertEqual(self._default_of("_int_env", "MAX_CONCURRENCY"), 8)
        self.assertEqual(self._default_of("_int_env", "MAX_RPM"), 60)
        self.assertEqual(self._default_of("_int_env", "MAX_RPS"), 4)
        self.assertEqual(self._default_of("_float_env", "MAX_WAIT_S"), 20.0)
        self.assertEqual(self._default_of("_float_env", "MAX_COOLDOWN_S"), 60.0)
        self.assertEqual(self._default_of("_int_env", "LEASE_TTL_S"), 300)

    def test_token_pacing_code_defaults(self):
        # PACE_MAX_TPM ships DISABLED (0) so the whole token predicate is inert
        # until the deployment sets the env at rollout — behaviour-neutral merge.
        self.assertEqual(self._default_of("_int_env", "MAX_TPM"), 0)
        self.assertEqual(self._default_of("_int_env", "TPM_OUTPUT_RESERVE"), 2048)
        self.assertEqual(self._default_of("_float_env", "TPM_CHARS_PER_TOKEN"), 4.0)
        self.assertEqual(self._default_of("_float_env", "TPM_EST_MULT"), 1.0)
        self.assertEqual(self._default_of("_float_env", "TPM_CACHE_READ_WEIGHT"), 1.0)

    def test_max_tpm_clamped_non_negative(self):
        # max(0, …) guards against a negative env inverting the gate; assert the
        # source actually wraps the env read in max(0, …).
        src = os.path.join(os.path.dirname(__file__), "custom_pacing.py")
        with open(src, "r", encoding="utf-8") as fh:
            source = fh.read()
        self.assertIn('max(0, _int_env("PACE_MAX_TPM", 0))', source)

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


# --- Runtime config clamps (deterministic controls) --------------------------
class ConfigClampTests(unittest.TestCase):
    """The two guard invariants are enforced at config LOAD by runtime clamps in
    _Cfg, not merely asserted in tests — so a deploy-time env misconfig can't
    silently defeat them. These drive REAL env overrides + module reload and
    assert the RESOLVED _Cfg values, so each would fail if its clamp were removed.
    """

    _ENV = (
        "PACE_MAX_WAIT_S",
        "PACE_HARD_MAX_WAIT_S",
        "PACE_MAX_COOLDOWN_S",
        "PACE_COOLDOWN_HOLD_CEILING_S",
    )

    def _reload_with(self, **env):
        for k in self._ENV:
            os.environ.pop(k, None)
        for k, v in env.items():
            os.environ[k] = str(v)
        importlib.reload(custom_pacing)
        return custom_pacing._Cfg

    def tearDown(self):
        # Restore clean code defaults for every downstream test.
        for k in self._ENV:
            os.environ.pop(k, None)
        importlib.reload(custom_pacing)

    def test_hard_cap_raised_to_max_wait_on_misconfig(self):
        # Misconfig: hard cap set BELOW the burst-smoothing ceiling. The clamp
        # raises it so the hard cap can never shorten a normal, benign wait.
        cfg = self._reload_with(PACE_MAX_WAIT_S=30, PACE_HARD_MAX_WAIT_S=10)
        self.assertGreaterEqual(cfg.HARD_MAX_WAIT_S, cfg.MAX_WAIT_S)
        self.assertEqual(cfg.HARD_MAX_WAIT_S, 30.0)

    def test_hard_cap_capped_below_watchdog_on_misconfig(self):
        # Misconfig: hard cap set ABOVE the 300s silence watchdog. The clamp caps
        # it under the watchdog so a hold can never look like a hang.
        cfg = self._reload_with(PACE_HARD_MAX_WAIT_S=400)
        self.assertLessEqual(
            cfg.HARD_MAX_WAIT_S, custom_pacing._PACE_WATCHDOG_SAFE_CEILING_S
        )
        self.assertEqual(cfg.HARD_MAX_WAIT_S, 280.0)
        self.assertLess(cfg.HARD_MAX_WAIT_S, 300.0)

    def test_hold_ceiling_capped_to_max_cooldown_on_misconfig(self):
        # Misconfig: hold ceiling set ABOVE the max cooldown that can be parked.
        # The clamp lowers it to MAX_COOLDOWN_S.
        cfg = self._reload_with(
            PACE_COOLDOWN_HOLD_CEILING_S=120, PACE_MAX_COOLDOWN_S=60
        )
        self.assertLessEqual(cfg.COOLDOWN_HOLD_CEILING_S, cfg.MAX_COOLDOWN_S)
        self.assertEqual(cfg.COOLDOWN_HOLD_CEILING_S, 60.0)

    def test_sane_config_passes_through_unclamped(self):
        # A valid operating point is untouched by the clamps (no false positives).
        cfg = self._reload_with(
            PACE_MAX_WAIT_S=12,
            PACE_HARD_MAX_WAIT_S=45,
            PACE_MAX_COOLDOWN_S=60,
            PACE_COOLDOWN_HOLD_CEILING_S=60,
        )
        self.assertEqual(cfg.HARD_MAX_WAIT_S, 45.0)
        self.assertEqual(cfg.COOLDOWN_HOLD_CEILING_S, 60.0)

    def test_clamp_helpers_are_pure(self):
        # Direct unit coverage of the clamp functions (deterministic; fails if the
        # min/max bounds are dropped).
        self.assertEqual(custom_pacing._clamp_hard_max_wait(10, 30, 280), 30)
        self.assertEqual(custom_pacing._clamp_hard_max_wait(400, 20, 280), 280)
        self.assertEqual(custom_pacing._clamp_hard_max_wait(45, 20, 280), 45)
        self.assertEqual(custom_pacing._clamp_hold_ceiling(120, 60), 60)
        self.assertEqual(custom_pacing._clamp_hold_ceiling(30, 60), 30)


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


# --- Router-path gating (H3: pacer must gate the /v1/messages router path) ---
# The pacer historically paced only the /anthropic PASSTHROUGH path
# (call_type "pass_through_endpoint"). Live litellm v1.91.0 routes /v1/messages
# traffic through the ROUTER with call_type "anthropic_messages", which was
# left UNPACED — reopening the burst-storm H3 for the aliases agents use. These
# tests pin the corrected gate: an explicit paced-GROUP allowlist, NOT a
# "claude-*" prefix heuristic (which is wrong both ways — see custom_pacing.py).
class RouterGatePureTests(unittest.TestCase):
    """Pure decision surface: _should_pace / _group_is_paced. No redis."""

    def setUp(self):
        self.pacer = custom_pacing.FleetPacer()

    def _pace(self, call_type, model=None):
        data = {} if model is None else {"model": model}
        return self.pacer._should_pace(call_type, data)

    def test_passthrough_always_paced_no_group(self):
        # Existing behaviour preserved: passthrough is paced with no model group.
        self.assertTrue(self._pace("pass_through_endpoint"))

    def test_router_sonnet_alias_paced(self):
        # Live subscription-Claude alias (config line 146) — MUST be paced even
        # though it does NOT match a "claude-*" prefix.
        self.assertTrue(self._pace("anthropic_messages", "sonnet"))

    def test_router_fable_alias_paced(self):
        # Live subscription-Claude alias (config line 158) — MUST be paced.
        self.assertTrue(self._pace("anthropic_messages", "fable"))

    def test_router_claude_group_paced(self):
        self.assertTrue(self._pace("anthropic_messages", "claude-opus-4-5"))
        self.assertTrue(self._pace("anthropic_messages", "claude-sonnet-4-5"))

    def test_router_openrouter_claude_group_not_paced(self):
        # "claude-sonnet-5-openrouter" (config line 309) MATCHES a claude-*
        # prefix but is OpenRouter — must NOT be held by the Anthropic cooldown.
        self.assertFalse(self._pace("anthropic_messages", "claude-sonnet-5-openrouter"))

    def test_router_non_claude_openrouter_not_paced(self):
        self.assertFalse(self._pace("anthropic_messages", "gpt-5-openrouter"))
        self.assertFalse(self._pace("anthropic_messages", "kimi-k2-openrouter"))

    def test_router_unknown_group_not_paced(self):
        # Can't attribute an out-of-allowlist / missing group to the fleet
        # Anthropic account -> do not pace.
        self.assertFalse(self._pace("anthropic_messages", "some-random-group"))
        self.assertFalse(self._pace("anthropic_messages"))

    def test_disabled_call_type_not_paced(self):
        self.assertFalse(self._pace("acompletion", "claude-opus-4-5"))

    def test_default_call_types_cover_both_paths(self):
        # Regression: the vendored defaults must include BOTH the passthrough
        # and the router call types (read from source so runner env can't mask).
        src = os.path.join(os.path.dirname(__file__), "custom_pacing.py")
        with open(src, "r", encoding="utf-8") as fh:
            source = fh.read()
        self.assertIn("pass_through_endpoint,anthropic_messages", source)


class RouterGateHookTests(_CfgPatchMixin, unittest.IsolatedAsyncioTestCase):
    """Drive the real async_pre_call_hook to prove the gate actually engages /
    bypasses the wait loop for router traffic. A paced request hits redis
    (eval_calls>0); a no-op request never touches it (eval_calls==0)."""

    async def _run(self, r, call_type, model=None):
        pacer = custom_pacing.FleetPacer()
        pacer._redis = r  # bypass _get_redis
        data = {} if model is None else {"model": model}
        custom_pacing._Cfg.MAX_WAIT_S = 0.15
        custom_pacing._Cfg.HARD_MAX_WAIT_S = 0.2
        custom_pacing._Cfg.COOLDOWN_HOLD = False
        return await pacer.async_pre_call_hook(None, None, data, call_type)

    async def test_router_sonnet_enters_pacer(self):
        r = FakeRedis(eval_result=0)  # deny -> forces the wait loop
        await self._run(r, "anthropic_messages", "sonnet")
        self.assertGreaterEqual(r.eval_calls, 1)

    async def test_router_openrouter_is_noop(self):
        r = FakeRedis(eval_result=0)
        data_back = await self._run(r, "anthropic_messages", "claude-sonnet-5-openrouter")
        self.assertEqual(r.eval_calls, 0)  # never entered the pacer
        self.assertIsInstance(data_back, dict)

    async def test_passthrough_still_paced(self):
        r = FakeRedis(eval_result=0)
        await self._run(r, "pass_through_endpoint")
        self.assertGreaterEqual(r.eval_calls, 1)


class RouterCooldownHoldsTests(_CfgPatchMixin, unittest.IsolatedAsyncioTestCase):
    """LOAD-BEARING H3 fix: a fleet cooldown SET by a router-path 429 must now
    HOLD a subsequent router-path admission. Pre-fix the router pre_call was a
    no-op, so the cooldown (though set) never gated router traffic."""

    async def test_router_429_cooldown_holds_router_admission(self):
        custom_pacing._Cfg.COOLDOWN_HOLD = True
        custom_pacing._Cfg.MAX_WAIT_S = 0.2
        custom_pacing._Cfg.COOLDOWN_HOLD_CEILING_S = 1.0
        custom_pacing._Cfg.HARD_MAX_WAIT_S = 5.0

        pacer = custom_pacing.FleetPacer()
        r = FakeRedis(eval_result=0)  # never admit -> exercise the hold
        pacer._redis = r

        # A router-path (anthropic_messages) request 429s and parks the fleet
        # cooldown (failure hook is ungated on call_type — it always sets it).
        exc = types.SimpleNamespace(
            status_code=429, message="would exceed your account rate limit"
        )
        await pacer.async_post_call_failure_hook(
            {"model": "sonnet"}, exc, None
        )
        self.assertIn(custom_pacing._COOLDOWN_KEY, r.store)

        # A subsequent router-path admission for a paced group must HOLD past
        # the short burst ceiling because it now honours that cooldown.
        t0 = time.time()
        await pacer.async_pre_call_hook(None, None, {"model": "sonnet"}, "anthropic_messages")
        elapsed = time.time() - t0
        self.assertGreater(elapsed, custom_pacing._Cfg.MAX_WAIT_S + 0.15)
        self.assertLessEqual(
            elapsed, custom_pacing._Cfg.COOLDOWN_HOLD_CEILING_S + 0.4
        )


# --- Lease release on the passthrough path -----------------------------------
#
# THE BUG THESE GUARD (switchroom#3549): a lease taken in the pre-call hook was
# only ever released by `async_post_call_success_hook` /
# `async_post_call_failure_hook`. Neither fires on the passthrough STREAMING
# path (litellm returns a StreamingResponse before any post hook), and the one
# non-streaming call site is nested under a guardrails condition that is false
# with no passthrough guardrails configured. So on the /anthropic passthrough
# route — the route the entire fleet uses — every lease leaked and only expired
# by LEASE_TTL_S. Concurrency drifted to a standstill under sustained load, and
# the live mitigation was to raise PACE_MAX_CONCURRENCY 16 -> 64, which bought
# headroom without fixing the leak.
#
# These are CORRECTNESS tests, not latency tests: the assertion is that a lease
# is actually released on every terminal outcome, and released at most once.


def _fake_logging_obj(pace_id=None):
    """Stand-in for LiteLLMLoggingObj: an object the pacer can pin an attribute
    to, carrying the `model_call_details` dict litellm really has."""

    class _LObj:
        pass

    lobj = _LObj()
    lobj.model_call_details = {}
    if pace_id is not None:
        setattr(lobj, custom_pacing._PACE_ATTR, pace_id)
    return lobj


class StashAndExtractPaceIdTests(unittest.TestCase):
    """The lease id must survive to a terminal path. `data["metadata"]` alone
    does not: litellm's `_init_kwargs_for_pass_through_endpoint` pops every key
    in `all_litellm_params` (which includes "metadata") off the parsed body
    before the upstream call. The logging object is the durable carrier."""

    def test_stash_pins_the_id_on_metadata_and_the_logging_obj(self):
        lobj = _fake_logging_obj()
        data = {"litellm_logging_obj": lobj}
        custom_pacing.FleetPacer._stash_pace_id(data, "pace-1")

        self.assertEqual(data["metadata"][custom_pacing._PACE_ATTR], "pace-1")
        self.assertEqual(getattr(lobj, custom_pacing._PACE_ATTR), "pace-1")
        self.assertEqual(lobj.model_call_details[custom_pacing._PACE_ATTR], "pace-1")

    def test_id_is_recoverable_after_metadata_is_popped(self):
        """The regression in one assertion: simulate litellm stripping
        `metadata` off the body, and require the id still be found."""
        lobj = _fake_logging_obj()
        data = {"litellm_logging_obj": lobj}
        custom_pacing.FleetPacer._stash_pace_id(data, "pace-2")

        data.pop("metadata")  # what _init_kwargs_for_pass_through_endpoint does

        pacer = custom_pacing.FleetPacer()
        self.assertEqual(pacer._extract_pace_id(data), "pace-2")

    def test_extract_reads_litellm_params_metadata(self):
        """The failure path re-attaches metadata under litellm_params."""
        pacer = custom_pacing.FleetPacer()
        data = {"litellm_params": {"metadata": {custom_pacing._PACE_ATTR: "pace-3"}}}
        self.assertEqual(pacer._extract_pace_id(data), "pace-3")

    def test_extract_never_raises_on_junk(self):
        pacer = custom_pacing.FleetPacer()
        for junk in (None, "", 42, [], {"metadata": "not-a-dict"}, {"litellm_params": 7}):
            self.assertIsNone(pacer._extract_pace_id(junk))

    def test_stash_never_raises_on_junk(self):
        for junk in (None, "", 42, []):
            custom_pacing.FleetPacer._stash_pace_id(junk, "pace-x")  # must not raise


class ReleaseIdempotencyTests(unittest.IsolatedAsyncioTestCase):
    """Several terminal paths can fire for one request (streaming wrapper,
    success handler, failure hook). Releasing twice must not double-free a
    future lease that reuses the id, and must not cost a Redis round trip."""

    async def test_release_issues_one_zrem(self):
        pacer = custom_pacing.FleetPacer()
        r = FakeRedis()
        pacer._redis = r
        await pacer._release("pace-a")
        self.assertEqual(len(r.zrem_calls), 1)
        self.assertIn("pace-a", r.zrem_calls[0])

    async def test_repeat_release_is_a_no_op(self):
        pacer = custom_pacing.FleetPacer()
        r = FakeRedis()
        pacer._redis = r
        for _ in range(5):
            await pacer._release("pace-a")
        self.assertEqual(len(r.zrem_calls), 1)

    async def test_release_of_empty_id_is_a_no_op(self):
        pacer = custom_pacing.FleetPacer()
        r = FakeRedis()
        pacer._redis = r
        await pacer._release(None)
        await pacer._release("")
        self.assertEqual(r.zrem_calls, [])

    async def test_release_survives_a_redis_error(self):
        """Release must never propagate — a throwing Redis on the teardown path
        would surface as an error mid-stream."""

        class _BoomRedis(FakeRedis):
            async def zrem(self, *a, **k):
                raise RuntimeError("redis down")

        pacer = custom_pacing.FleetPacer()
        pacer._redis = _BoomRedis()
        await pacer._release("pace-a")  # must not raise

    async def test_released_lru_stays_bounded(self):
        """The idempotency cache must not grow without bound in a long-lived
        proxy worker."""
        pacer = custom_pacing.FleetPacer()
        pacer._redis = FakeRedis()
        for i in range(custom_pacing._RELEASED_LRU_MAX + 250):
            await pacer._release(f"pace-{i}")
        self.assertLessEqual(
            len(pacer._released), custom_pacing._RELEASED_LRU_MAX
        )

    async def test_release_soon_actually_releases(self):
        pacer = custom_pacing.FleetPacer()
        r = FakeRedis()
        pacer._redis = r
        pacer._release_soon("pace-b")
        # Fire-and-forget: yield to the loop so the scheduled task runs.
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertEqual(len(r.zrem_calls), 1)

    async def test_release_soon_keeps_a_strong_ref(self):
        """Without a strong ref the loop can GC the task mid-flight and the
        release silently never happens (falling back to the TTL)."""
        pacer = custom_pacing.FleetPacer()
        pacer._redis = FakeRedis()
        pacer._release_soon("pace-c")
        self.assertEqual(len(pacer._pending_tasks), 1)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertEqual(len(pacer._pending_tasks), 0)  # discarded when done

    def test_release_soon_outside_a_loop_does_not_raise(self):
        """Sync context, no running loop: degrade to the TTL backstop, quietly."""
        pacer = custom_pacing.FleetPacer()
        pacer._redis = FakeRedis()
        pacer._release_soon("pace-d")  # must not raise


class StreamingReleasePatchTests(unittest.IsolatedAsyncioTestCase):
    """Installs the streaming patch against a fake
    PassThroughStreamingHandler and asserts the lease is released on EVERY way
    a stream can end: normal completion, client disconnect, upstream error."""

    def setUp(self):
        self._saved = {
            k: v for k, v in sys.modules.items()
            if k.startswith("litellm.proxy.pass_through_endpoints")
        }
        self.chunks_seen = []

        handler_mod = types.ModuleType(
            "litellm.proxy.pass_through_endpoints.streaming_handler"
        )
        outer = self

        class PassThroughStreamingHandler:
            @staticmethod
            async def chunk_processor(*args, **kwargs):
                mode = kwargs.get("_test_mode", "ok")
                for i in range(3):
                    if mode == "raise" and i == 1:
                        raise RuntimeError("upstream blew up")
                    outer.chunks_seen.append(i)
                    yield i

        handler_mod.PassThroughStreamingHandler = PassThroughStreamingHandler
        self.handler_cls = PassThroughStreamingHandler

        pkg = types.ModuleType("litellm.proxy.pass_through_endpoints")
        proxy = sys.modules.get("litellm.proxy") or types.ModuleType("litellm.proxy")
        sys.modules["litellm.proxy"] = proxy
        sys.modules["litellm.proxy.pass_through_endpoints"] = pkg
        sys.modules[
            "litellm.proxy.pass_through_endpoints.streaming_handler"
        ] = handler_mod

        self.assertTrue(custom_pacing._install_streaming_release_patch())

        self.pacer = custom_pacing.pacer_instance
        self.redis = FakeRedis()
        self._saved_redis = self.pacer._redis
        self._saved_released = self.pacer._released
        self.pacer._redis = self.redis
        self.pacer._released = type(self.pacer._released)()

    def tearDown(self):
        self.pacer._redis = self._saved_redis
        self.pacer._released = self._saved_released
        for k in list(sys.modules):
            if k.startswith("litellm.proxy.pass_through_endpoints"):
                del sys.modules[k]
        sys.modules.update(self._saved)

    async def _drain(self, gen, stop_after=None):
        n = 0
        async for _ in gen:
            n += 1
            if stop_after is not None and n >= stop_after:
                break
        return n

    async def _settle(self):
        # _release_soon schedules; give the loop turns to run it.
        for _ in range(5):
            await asyncio.sleep(0)

    async def test_lease_released_on_normal_stream_completion(self):
        lobj = _fake_logging_obj("pace-stream-ok")
        gen = self.handler_cls.chunk_processor(litellm_logging_obj=lobj)
        await self._drain(gen)
        await self._settle()
        self.assertEqual(len(self.redis.zrem_calls), 1)
        self.assertIn("pace-stream-ok", self.redis.zrem_calls[0])

    async def test_lease_released_on_client_disconnect(self):
        """Abandoning the generator mid-stream throws GeneratorExit into the
        wrapper's finally. This is the dominant real-world case — a user
        stopping a long completion — and the one the TTL used to paper over."""
        lobj = _fake_logging_obj("pace-stream-disconnect")
        gen = self.handler_cls.chunk_processor(litellm_logging_obj=lobj)
        await self._drain(gen, stop_after=1)
        await gen.aclose()
        await self._settle()
        self.assertEqual(len(self.redis.zrem_calls), 1)
        self.assertIn("pace-stream-disconnect", self.redis.zrem_calls[0])

    async def test_lease_released_when_the_stream_raises(self):
        lobj = _fake_logging_obj("pace-stream-boom")
        gen = self.handler_cls.chunk_processor(
            litellm_logging_obj=lobj, _test_mode="raise"
        )
        with self.assertRaises(RuntimeError):
            await self._drain(gen)
        await self._settle()
        self.assertEqual(len(self.redis.zrem_calls), 1)

    async def test_chunks_still_flow_through_the_wrapper(self):
        """The patch must be transparent: same chunks, same order."""
        lobj = _fake_logging_obj("pace-stream-passthru")
        gen = self.handler_cls.chunk_processor(litellm_logging_obj=lobj)
        out = []
        async for c in gen:
            out.append(c)
        self.assertEqual(out, [0, 1, 2])

    async def test_id_recovered_from_the_request_body_when_the_lobj_is_bare(self):
        lobj = _fake_logging_obj()  # no pinned attribute
        body = {"metadata": {custom_pacing._PACE_ATTR: "pace-from-body"}}
        gen = self.handler_cls.chunk_processor(
            litellm_logging_obj=lobj, request_body=body
        )
        await self._drain(gen)
        await self._settle()
        self.assertIn("pace-from-body", self.redis.zrem_calls[0])

    async def test_no_lease_id_means_no_release_call(self):
        gen = self.handler_cls.chunk_processor(litellm_logging_obj=_fake_logging_obj())
        await self._drain(gen)
        await self._settle()
        self.assertEqual(self.redis.zrem_calls, [])

    def test_patch_is_not_installed_twice(self):
        """Module re-import must not stack wrappers (each layer would release
        again and the chunk path would nest)."""
        first = self.handler_cls.chunk_processor
        self.assertTrue(custom_pacing._install_streaming_release_patch())
        self.assertIs(self.handler_cls.chunk_processor, first)


class NonStreamingReleasePatchTests(unittest.IsolatedAsyncioTestCase):
    """The non-streaming passthrough success hook is nested under
    `if response_body is not None and guardrails_to_run:` — false for us — so
    these leases leaked too. We wrap the one unconditional success handler."""

    def setUp(self):
        self._saved = {
            k: v for k, v in sys.modules.items()
            if k.startswith("litellm.proxy.pass_through_endpoints")
        }
        self.calls = []
        outer = self

        mod = types.ModuleType(
            "litellm.proxy.pass_through_endpoints.success_handler"
        )

        class PassThroughEndpointLogging:
            async def pass_through_async_success_handler(self, *args, **kwargs):
                outer.calls.append(kwargs)
                if kwargs.get("_test_mode") == "raise":
                    raise RuntimeError("handler blew up")
                return "handled"

        mod.PassThroughEndpointLogging = PassThroughEndpointLogging
        self.cls = PassThroughEndpointLogging

        pkg = types.ModuleType("litellm.proxy.pass_through_endpoints")
        proxy = sys.modules.get("litellm.proxy") or types.ModuleType("litellm.proxy")
        sys.modules["litellm.proxy"] = proxy
        sys.modules["litellm.proxy.pass_through_endpoints"] = pkg
        sys.modules["litellm.proxy.pass_through_endpoints.success_handler"] = mod

        self.assertTrue(custom_pacing._install_nonstreaming_release_patch())

        self.pacer = custom_pacing.pacer_instance
        self.redis = FakeRedis()
        self._saved_redis = self.pacer._redis
        self._saved_released = self.pacer._released
        self.pacer._redis = self.redis
        self.pacer._released = type(self.pacer._released)()

    def tearDown(self):
        self.pacer._redis = self._saved_redis
        self.pacer._released = self._saved_released
        for k in list(sys.modules):
            if k.startswith("litellm.proxy.pass_through_endpoints"):
                del sys.modules[k]
        sys.modules.update(self._saved)

    async def test_lease_released_on_success(self):
        inst = self.cls()
        out = await inst.pass_through_async_success_handler(
            logging_obj=_fake_logging_obj("pace-ns-ok")
        )
        self.assertEqual(out, "handled")  # return value preserved
        self.assertEqual(len(self.redis.zrem_calls), 1)
        self.assertIn("pace-ns-ok", self.redis.zrem_calls[0])

    async def test_lease_released_when_the_handler_raises(self):
        inst = self.cls()
        with self.assertRaises(RuntimeError):
            await inst.pass_through_async_success_handler(
                logging_obj=_fake_logging_obj("pace-ns-boom"), _test_mode="raise"
            )
        self.assertEqual(len(self.redis.zrem_calls), 1)

    async def test_the_wrapped_handler_still_receives_its_kwargs(self):
        inst = self.cls()
        lobj = _fake_logging_obj("pace-ns-args")
        await inst.pass_through_async_success_handler(logging_obj=lobj, url="/x")
        self.assertEqual(self.calls[0]["url"], "/x")
        self.assertIs(self.calls[0]["logging_obj"], lobj)

    def test_patch_is_not_installed_twice(self):
        first = self.cls.pass_through_async_success_handler
        self.assertTrue(custom_pacing._install_nonstreaming_release_patch())
        self.assertIs(self.cls.pass_through_async_success_handler, first)


class PatchInstallFailOpenTests(unittest.TestCase):
    """This module is imported by the proxy at startup. A litellm layout change
    must degrade to the TTL backstop, never take the proxy down."""

    def _without_passthrough_modules(self):
        saved = {
            k: v for k, v in sys.modules.items()
            if k.startswith("litellm.proxy.pass_through_endpoints")
        }
        for k in saved:
            del sys.modules[k]
        # Block re-import: a bare ModuleType with no submodules makes the
        # `from ... import` raise, which is the drift case.
        return saved

    def _restore(self, saved):
        for k in list(sys.modules):
            if k.startswith("litellm.proxy.pass_through_endpoints"):
                del sys.modules[k]
        sys.modules.update(saved)

    def test_streaming_installer_returns_false_when_litellm_is_absent(self):
        saved = self._without_passthrough_modules()
        try:
            self.assertFalse(custom_pacing._install_streaming_release_patch())
        finally:
            self._restore(saved)

    def test_nonstreaming_installer_returns_false_when_litellm_is_absent(self):
        saved = self._without_passthrough_modules()
        try:
            self.assertFalse(custom_pacing._install_nonstreaming_release_patch())
        finally:
            self._restore(saved)

    def test_safe_wrappers_swallow_everything(self):
        """Total-ness is the load-bearing property: even a logger without
        .error (an older litellm) must not escape as an import-time crash."""
        saved_logger = custom_pacing.verbose_proxy_logger

        class _BrokenLogger:
            def __getattr__(self, name):
                raise AttributeError(name)

        custom_pacing.verbose_proxy_logger = _BrokenLogger()
        saved = self._without_passthrough_modules()
        try:
            self.assertFalse(custom_pacing._install_streaming_release_patch_safe())
            self.assertFalse(custom_pacing._install_nonstreaming_release_patch_safe())
        finally:
            self._restore(saved)
            custom_pacing.verbose_proxy_logger = saved_logger


# =============================================================================
# Token-aware pacing (PACE_MAX_TPM) — estimator, usage accounting, gating,
# reconciliation, and a real-Redis Lua budget exercise.
# =============================================================================


class _TpmCfgMixin:
    """Pin the token-estimator knobs to known values (and enable the budget) so
    the estimate/usage/reconcile tests are deterministic regardless of any PACE_*
    env set in the runner. Snapshot + restore around each test."""

    _TPM_KNOBS = (
        "MAX_TPM",
        "TPM_OUTPUT_RESERVE",
        "TPM_CHARS_PER_TOKEN",
        "TPM_EST_MULT",
        "TPM_CACHE_READ_WEIGHT",
    )

    def setUp(self):
        super().setUp()
        self._saved_tpm = {k: getattr(custom_pacing._Cfg, k) for k in self._TPM_KNOBS}
        custom_pacing._Cfg.MAX_TPM = 1_200_000
        custom_pacing._Cfg.TPM_OUTPUT_RESERVE = 2048
        custom_pacing._Cfg.TPM_CHARS_PER_TOKEN = 4.0
        custom_pacing._Cfg.TPM_EST_MULT = 1.0
        custom_pacing._Cfg.TPM_CACHE_READ_WEIGHT = 1.0

    def tearDown(self):
        for k, v in self._saved_tpm.items():
            setattr(custom_pacing._Cfg, k, v)
        super().tearDown()


class EstimateTokensTests(_TpmCfgMixin, unittest.TestCase):
    """Outcome tests for the cheap char-count estimator. With CHARS_PER_TOKEN=4,
    RESERVE=2048, EST_MULT=1: est = int(chars/4) + min(max_tokens or 2048, 2048)."""

    def _est(self, data):
        return custom_pacing._estimate_tokens(data)

    def test_string_content(self):
        # 40 input chars -> 10 input tokens; +2048 output reserve.
        data = {"messages": [{"role": "user", "content": "x" * 40}]}
        self.assertEqual(self._est(data), 10 + 2048)

    def test_block_content_text_and_image(self):
        # text block counts its text length (40); an image block counts a flat
        # ~1600 tokens -> int(1600 * 4) = 6400 chars. (40 + 6400) / 4 = 1610
        # input tokens; +2048 output reserve.
        data = {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "x" * 40},
                        {"type": "image", "source": {"type": "base64", "data": "zz"}},
                    ],
                }
            ]
        }
        img_chars = int(1600 * 4)
        self.assertEqual(self._est(data), (40 + img_chars) // 4 + 2048)
        # Guard: the image alone must contribute ~1600 tokens, not the old ~400.
        self.assertGreater(self._est(data), (40 // 4) + 1500 + 2048)

    def test_system_and_tools_add_to_estimate(self):
        base = {"messages": [{"role": "user", "content": "x" * 40}]}
        with_system = {**base, "system": "y" * 400}
        with_tools = {**base, "tools": [{"name": "t", "description": "d" * 400}]}
        self.assertGreater(self._est(with_system), self._est(base))
        self.assertGreater(self._est(with_tools), self._est(base))
        # System as a block list is also counted.
        with_system_blocks = {**base, "system": [{"type": "text", "text": "y" * 400}]}
        self.assertGreater(self._est(with_system_blocks), self._est(base))

    def test_max_tokens_capped_by_reserve(self):
        small = {"messages": [{"role": "user", "content": "x" * 40}]}
        # A huge max_tokens is capped at RESERVE (2048), not trusted verbatim.
        capped = {**small, "max_tokens": 999999}
        self.assertEqual(self._est(capped), 10 + 2048)
        # A small max_tokens reserves only that much.
        tiny = {**small, "max_tokens": 100}
        self.assertEqual(self._est(tiny), 10 + 100)

    def test_est_mult_scaling(self):
        data = {"messages": [{"role": "user", "content": "x" * 40}]}
        base = self._est(data)
        custom_pacing._Cfg.TPM_EST_MULT = 2.0
        self.assertEqual(self._est(data), int(base * 2.0))

    def test_garbage_returns_zero_never_raises(self):
        for junk in (
            None,
            42,
            "not-a-dict",
            [],
            {"max_tokens": "abc", "messages": [{"role": "user", "content": "hi"}]},
        ):
            self.assertEqual(self._est(junk), 0)

    def test_chars_per_token_zero_does_not_divide_by_zero(self):
        # A misconfigured 0 ratio must not blow up (would be ZeroDivisionError);
        # the estimator falls back to 4.0 rather than returning 0/raising.
        custom_pacing._Cfg.TPM_CHARS_PER_TOKEN = 0.0
        data = {"messages": [{"role": "user", "content": "x" * 40}]}
        self.assertEqual(self._est(data), 10 + 2048)


class UsageActualTokensTests(_TpmCfgMixin, unittest.TestCase):
    def _actual(self, usage):
        return custom_pacing._usage_actual_tokens(usage)

    def test_full_anthropic_usage(self):
        usage = {
            "input_tokens": 1000,
            "output_tokens": 500,
            "cache_creation_input_tokens": 200,
            "cache_read_input_tokens": 4000,
        }
        # weight 1.0: 1000 + 200 + 500 + 4000 = 5700
        self.assertEqual(self._actual(usage), 5700)

    def test_cache_read_weight_zero_vs_one(self):
        usage = {
            "input_tokens": 1000,
            "output_tokens": 500,
            "cache_creation_input_tokens": 200,
            "cache_read_input_tokens": 4000,
        }
        custom_pacing._Cfg.TPM_CACHE_READ_WEIGHT = 1.0
        weighted = self._actual(usage)
        custom_pacing._Cfg.TPM_CACHE_READ_WEIGHT = 0.0
        discounted = self._actual(usage)
        self.assertEqual(weighted, 5700)
        self.assertEqual(discounted, 1700)  # cache reads no longer counted
        self.assertLess(discounted, weighted)

    def test_openai_style_keys(self):
        self.assertEqual(
            self._actual({"prompt_tokens": 100, "completion_tokens": 50}), 150
        )

    def test_missing_fields_partial_not_raise(self):
        # Only some fields present -> partial sum, never a raise.
        self.assertEqual(self._actual({"input_tokens": 100}), 100)
        self.assertEqual(self._actual({"output_tokens": 50}), 50)

    def test_no_recognised_field_returns_none(self):
        self.assertIsNone(self._actual({}))
        self.assertIsNone(self._actual({"nonsense": 5}))

    def test_non_dict_and_junk_return_none_never_raise(self):
        for junk in (None, "x", 7, [], {"input_tokens": "not-a-number"}):
            self.assertIsNone(self._actual(junk))


class TokenBucketTests(unittest.TestCase):
    def test_bucket_floors_to_10s(self):
        self.assertEqual(custom_pacing._token_bucket(1700000000.0), 1700000000)
        self.assertEqual(custom_pacing._token_bucket(1700000009.9), 1700000000)
        self.assertEqual(custom_pacing._token_bucket(1700000010.0), 1700000010)

    def test_bucket_never_raises(self):
        # NaN and non-numeric input degrade to 0 rather than raising.
        self.assertEqual(custom_pacing._token_bucket(float("nan")), 0)
        self.assertEqual(custom_pacing._token_bucket("junk"), 0)


class TokenAdmitSignatureTests(unittest.IsolatedAsyncioTestCase):
    """The admit Lua now takes 5 keys + maxtpm + est. Assert _try_admit threads
    them, and that the fail-open + verdict contract is unchanged."""

    def setUp(self):
        self._saved = custom_pacing._Cfg.MAX_TPM

    def tearDown(self):
        custom_pacing._Cfg.MAX_TPM = self._saved

    async def test_threads_est_and_maxtpm_and_five_keys(self):
        captured = {}

        class CapRedis(FakeRedis):
            async def eval(self, *args, **kwargs):
                captured["args"] = args
                return 1

        custom_pacing._Cfg.MAX_TPM = 1234
        pacer = custom_pacing.FleetPacer()
        self.assertTrue(await pacer._try_admit(CapRedis(), "pace-1", 777))
        args = captured["args"]
        # args[0] = LUA source, args[1] = numkeys.
        self.assertEqual(args[1], 5)
        self.assertIn(custom_pacing._TOKENS_KEY, args)
        self.assertIn(custom_pacing._TPM_DENIED_KEY, args)
        self.assertIn("1234", args)  # maxtpm ARGV
        self.assertIn("777", args)  # est ARGV

    async def test_default_est_is_zero_and_still_admits(self):
        # Called with the default est (0) — the disabled path — still admits on a
        # granting verdict.
        pacer = custom_pacing.FleetPacer()
        self.assertTrue(await pacer._try_admit(FakeRedis(eval_result=1), "p"))

    async def test_fail_open_on_redis_error_with_est(self):
        pacer = custom_pacing.FleetPacer()
        r = FakeRedis(eval_raises=RuntimeError("redis down"))
        self.assertTrue(await pacer._try_admit(r, "p", 5000))


class TokenEnvGatingTests(_CfgPatchMixin, unittest.IsolatedAsyncioTestCase):
    """When PACE_MAX_TPM is disabled the estimator must never be consulted on the
    admit path, and admission still flows via the stubbed Lua verdict."""

    def setUp(self):
        super().setUp()
        self._saved_est = custom_pacing._estimate_tokens
        self._saved_tpm = custom_pacing._Cfg.MAX_TPM
        self._est_calls = []

        def _recording_est(data):
            self._est_calls.append(data)
            return 4242

        custom_pacing._estimate_tokens = _recording_est
        custom_pacing._Cfg.MAX_WAIT_S = 0.15
        custom_pacing._Cfg.HARD_MAX_WAIT_S = 0.2
        custom_pacing._Cfg.COOLDOWN_HOLD = False

    def tearDown(self):
        custom_pacing._estimate_tokens = self._saved_est
        custom_pacing._Cfg.MAX_TPM = self._saved_tpm
        super().tearDown()

    async def test_estimator_not_consulted_when_disabled(self):
        custom_pacing._Cfg.MAX_TPM = 0
        pacer = custom_pacing.FleetPacer()
        r = FakeRedis(eval_result=1)  # admit immediately
        pacer._redis = r
        data = await pacer.async_pre_call_hook(None, None, {}, "pass_through_endpoint")
        self.assertEqual(self._est_calls, [])  # never called
        self.assertIsInstance(data, dict)
        self.assertGreaterEqual(r.eval_calls, 1)  # still admitted via verdict

    async def test_estimator_consulted_when_enabled(self):
        custom_pacing._Cfg.MAX_TPM = 1_000_000
        pacer = custom_pacing.FleetPacer()
        r = FakeRedis(eval_result=1)
        pacer._redis = r
        await pacer.async_pre_call_hook(None, None, {"messages": []}, "pass_through_endpoint")
        self.assertEqual(len(self._est_calls), 1)


class RecordEstFailOpenTests(_TpmCfgMixin, unittest.IsolatedAsyncioTestCase):
    async def test_books_estimate_when_enabled(self):
        pacer = custom_pacing.FleetPacer()
        r = FakeRedis()
        await pacer._record_est_fail_open(r, 500)
        self.assertEqual(len(r.hincrby_calls), 1)
        self.assertEqual(r.hincrby_calls[0][0], custom_pacing._TOKENS_KEY)
        self.assertEqual(r.hincrby_calls[0][2], 500)
        self.assertEqual(len(r.expire_calls), 1)

    async def test_noop_when_disabled(self):
        custom_pacing._Cfg.MAX_TPM = 0
        pacer = custom_pacing.FleetPacer()
        r = FakeRedis()
        await pacer._record_est_fail_open(r, 500)
        self.assertEqual(r.hincrby_calls, [])

    async def test_noop_when_zero_estimate(self):
        pacer = custom_pacing.FleetPacer()
        r = FakeRedis()
        await pacer._record_est_fail_open(r, 0)
        self.assertEqual(r.hincrby_calls, [])

    async def test_swallows_raising_redis(self):
        class Boom(FakeRedis):
            async def hincrby(self, *a, **k):
                raise RuntimeError("redis down")

        pacer = custom_pacing.FleetPacer()
        await pacer._record_est_fail_open(Boom(), 500)  # must not raise


class ReconcileTokensTests(_TpmCfgMixin, unittest.IsolatedAsyncioTestCase):
    def _pacer(self, r):
        pacer = custom_pacing.FleetPacer()
        pacer._redis = r  # bypass _get_redis
        return pacer

    async def test_positive_delta_booked_to_current_bucket(self):
        r = FakeRedis()
        pacer = self._pacer(r)
        await pacer._reconcile_tokens(100, 150)
        self.assertEqual(len(r.hincrby_calls), 1)
        self.assertEqual(r.hincrby_calls[0][2], 50)  # actual - est

    async def test_negative_delta_allowed(self):
        r = FakeRedis()
        pacer = self._pacer(r)
        await pacer._reconcile_tokens(200, 50)
        self.assertEqual(r.hincrby_calls[0][2], -150)

    async def test_noop_when_equal(self):
        r = FakeRedis()
        pacer = self._pacer(r)
        await pacer._reconcile_tokens(100, 100)
        self.assertEqual(r.hincrby_calls, [])

    async def test_noop_when_disabled(self):
        custom_pacing._Cfg.MAX_TPM = 0
        r = FakeRedis()
        pacer = self._pacer(r)
        await pacer._reconcile_tokens(100, 200)
        self.assertEqual(r.hincrby_calls, [])

    async def test_noop_when_either_missing(self):
        r = FakeRedis()
        pacer = self._pacer(r)
        await pacer._reconcile_tokens(None, 200)
        await pacer._reconcile_tokens(100, None)
        self.assertEqual(r.hincrby_calls, [])

    async def test_swallows_raising_redis(self):
        class Boom(FakeRedis):
            async def hincrby(self, *a, **k):
                raise RuntimeError("redis down")

        pacer = self._pacer(Boom())
        await pacer._reconcile_tokens(100, 200)  # must not raise


class TokenStashExtractTests(_TpmCfgMixin, unittest.TestCase):
    def test_stash_pins_est_on_all_carriers(self):
        lobj = _fake_logging_obj()
        data = {"litellm_logging_obj": lobj}
        custom_pacing.FleetPacer._stash_pace_id(data, "pace-1", 4242)
        self.assertEqual(data["metadata"][custom_pacing._PACE_TOK_ATTR], 4242)
        self.assertEqual(getattr(lobj, custom_pacing._PACE_TOK_ATTR), 4242)
        self.assertEqual(lobj.model_call_details[custom_pacing._PACE_TOK_ATTR], 4242)

    def test_stash_without_est_pins_no_token_attr(self):
        # Back-compat: the 2-arg form (est defaults to 0) pins only the lease id.
        data = {}
        custom_pacing.FleetPacer._stash_pace_id(data, "pace-1")
        self.assertNotIn(custom_pacing._PACE_TOK_ATTR, data.get("metadata", {}))

    def test_extract_est_from_metadata(self):
        pacer = custom_pacing.FleetPacer()
        data = {"metadata": {custom_pacing._PACE_TOK_ATTR: 999}}
        self.assertEqual(pacer._extract_tok_est(data), 999)

    def test_extract_est_from_litellm_params(self):
        pacer = custom_pacing.FleetPacer()
        data = {"litellm_params": {"metadata": {custom_pacing._PACE_TOK_ATTR: 777}}}
        self.assertEqual(pacer._extract_tok_est(data), 777)

    def test_extract_est_recovered_after_metadata_popped(self):
        lobj = _fake_logging_obj()
        data = {"litellm_logging_obj": lobj}
        custom_pacing.FleetPacer._stash_pace_id(data, "pace-1", 4242)
        data.pop("metadata")  # what _init_kwargs_for_pass_through_endpoint does
        pacer = custom_pacing.FleetPacer()
        self.assertEqual(pacer._extract_tok_est(data), 4242)

    def test_extract_est_never_raises_on_junk(self):
        pacer = custom_pacing.FleetPacer()
        for junk in (None, "", 42, [], {"metadata": "not-a-dict"}):
            self.assertIsNone(pacer._extract_tok_est(junk))


class SuccessHookReconcileTests(_TpmCfgMixin, unittest.IsolatedAsyncioTestCase):
    """The router success hook reconciles the budget from estimate to actual."""

    async def test_router_success_reconciles(self):
        pacer = custom_pacing.FleetPacer()
        r = FakeRedis()
        pacer._redis = r
        data = {"metadata": {custom_pacing._PACE_TOK_ATTR: 1000}}
        response = types.SimpleNamespace(
            usage={"input_tokens": 1200, "output_tokens": 300}
        )
        await pacer.async_post_call_success_hook(data, None, response)
        # actual = 1500, est = 1000 -> delta +500
        self.assertEqual(len(r.hincrby_calls), 1)
        self.assertEqual(r.hincrby_calls[0][2], 500)

    async def test_router_success_noop_when_disabled(self):
        custom_pacing._Cfg.MAX_TPM = 0
        pacer = custom_pacing.FleetPacer()
        r = FakeRedis()
        pacer._redis = r
        data = {"metadata": {custom_pacing._PACE_TOK_ATTR: 1000}}
        response = types.SimpleNamespace(usage={"input_tokens": 1200})
        await pacer.async_post_call_success_hook(data, None, response)
        self.assertEqual(r.hincrby_calls, [])


# --- Real-Redis Lua budget exercise (gated; CI's pure-stdlib lane skips it) ---
# The rest of the suite stubs the eval verdict, so it can NOT catch a broken
# budget script. This class runs the ACTUAL _ADMIT_LUA against a real Redis to
# prove the token predicate admits/denies correctly. Run locally with a
# throwaway redis:  docker run --rm -d -p 6379:6379 redis
#   PACE_TEST_REDIS_URL=redis://127.0.0.1:6379/15 \
#     python3 -m unittest discover -s docker/litellm-pacer -p 'test_*.py'
@unittest.skipUnless(
    os.getenv("PACE_TEST_REDIS_URL"),
    "set PACE_TEST_REDIS_URL to a THROWAWAY redis to run the real-Lua budget test",
)
class RealRedisTokenBudgetTests(unittest.TestCase):
    BIG = 10**9  # concurrency/RPM/RPS so high only the TOKEN gate can deny

    @classmethod
    def setUpClass(cls):
        import redis  # local-only; never imported on the pure-stdlib CI lane

        cls.client = redis.Redis.from_url(
            os.environ["PACE_TEST_REDIS_URL"], decode_responses=True
        )
        cls.client.ping()

    def setUp(self):
        # Only ever touch OUR keys — never flushdb a shared instance.
        self._keys = [
            custom_pacing._INFLIGHT_KEY,
            custom_pacing._RECENT_KEY,
            custom_pacing._COOLDOWN_KEY,
            custom_pacing._TOKENS_KEY,
            custom_pacing._TPM_DENIED_KEY,
        ]
        self.client.delete(*self._keys)

    def tearDown(self):
        self.client.delete(*self._keys)

    def _admit(self, est, maxtpm, now=None):
        now = time.time() if now is None else now
        res = self.client.eval(
            custom_pacing._ADMIT_LUA,
            5,
            custom_pacing._INFLIGHT_KEY,
            custom_pacing._RECENT_KEY,
            custom_pacing._COOLDOWN_KEY,
            custom_pacing._TOKENS_KEY,
            custom_pacing._TPM_DENIED_KEY,
            repr(now),
            str(self.BIG),
            str(self.BIG),
            str(self.BIG),
            "300",
            "pid-" + str(random.random()),
            "ruid-" + str(random.random()),
            str(maxtpm),
            str(int(est)),
        )
        return int(res)

    def _token_sum(self):
        h = self.client.hgetall(custom_pacing._TOKENS_KEY)
        return sum(int(v) for v in h.values())

    def test_burst_admitted_until_budget_then_denied(self):
        # MAX_TPM=1000, E=300: 3 admits (0,300,600 -> sums 300,600,900), 4th
        # would be 900+300=1200 > 1000 -> denied.
        now = time.time()
        verdicts = [self._admit(300, 1000, now=now) for _ in range(4)]
        self.assertEqual(verdicts, [1, 1, 1, 0])
        self.assertEqual(self._token_sum(), 900)  # denied req not recorded
        # The observability counter caught exactly the one token denial.
        self.assertEqual(int(self.client.get(custom_pacing._TPM_DENIED_KEY)), 1)

    def test_budget_frees_after_buckets_age(self):
        now = time.time()
        for _ in range(3):
            self.assertEqual(self._admit(300, 1000, now=now), 1)
        self.assertEqual(self._admit(300, 1000, now=now), 0)  # budget full
        # Advance >60s: the old bucket ages out (HDEL), budget resets -> admit.
        later = now + 61
        self.assertEqual(self._admit(300, 1000, now=later), 1)

    def test_disabled_admits_regardless_and_writes_no_tokens_key(self):
        # MAX_TPM=0: admits any size and never creates the tokens hash.
        self.assertEqual(self._admit(999999, 0), 1)
        self.assertEqual(self.client.exists(custom_pacing._TOKENS_KEY), 0)

    def test_single_oversized_request_admitted(self):
        # est (5000) >= MAX_TPM (1000): the bypass admits it on the first attempt
        # rather than starving it, and still records its tokens.
        self.assertEqual(self._admit(5000, 1000), 1)
        self.assertEqual(self._token_sum(), 5000)
        # No token denial was counted for the bypass admit.
        self.assertIsNone(self.client.get(custom_pacing._TPM_DENIED_KEY))


if __name__ == "__main__":
    unittest.main()
