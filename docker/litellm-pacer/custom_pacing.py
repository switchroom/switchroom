"""
custom_pacing.py — fleet-wide LLM request pacer for LiteLLM's Anthropic
passthrough path.

Ken's standing rule (2026-07-12): "never storm, always pace." When the
switchroom auth-broker flips the whole fleet onto a new Anthropic OAuth
account, every agent's in-flight + queued turn hits that account at once.
A cold / low-burst-ceiling account 429s ("This request would exceed your
account's rate limit") even when the 5h quota is at ~1% — its per-minute
BURST ceiling is below fleet burst demand. This module smooths that burst.

Mechanism (deterministic, version-independent, config-only-impossible under
LiteLLM v3's per-key reject-based limiter):

  * Runs as a LiteLLM CustomLogger callback. Its async_pre_call_hook is
    invoked on the /anthropic passthrough path (call_type ==
    "pass_through_endpoint") — verified against litellm v1.91
    proxy/utils.py::pre_call_hook + pass_through_endpoints.py:845.
  * Bounded global CONCURRENCY: at most PACE_MAX_CONCURRENCY upstream
    requests in flight across all 8 proxy workers, coordinated in Redis
    via a self-healing sorted-set lease (missed releases age out after
    PACE_LEASE_TTL_S — no leaked permanent slots).
  * Bounded global RATE: rolling 60s cap (PACE_MAX_RPM) + rolling 1s burst
    smoother (PACE_MAX_RPS).
  * ADAPTIVE 429 cooldown: async_post_call_failure_hook watches for upstream
    429s carrying Retry-After and parks a fleet-wide `pace:cooldown_until`
    in Redis. While cooling, pre_call paces harder — honoring Anthropic's
    own retry-after signal instead of hammering.
  * QUEUES, does not reject: over-limit requests AWAIT (bounded jittered
    sleep up to PACE_MAX_WAIT_S) rather than 429. If the wait ceiling is
    hit the request FAILS OPEN (proceeds) — the pacer can never make the
    fleet worse than no pacer at all.

Everything FAILS OPEN: any Redis / logic error is swallowed and the request
proceeds. A bug in this hot-path module degrades to today's behavior, never
to a fleet outage.

All knobs are env-overridable (see _cfg) so tuning needs no code change and
no image rebuild — only a container restart to re-read env, OR set them live
via the same Redis keys.

Wire-up (litellm-config.yaml):
    litellm_settings:
      callbacks: ["custom_pacing.pacer_instance"]

Deploy: bind-mount this file to /app/custom_pacing.py (the config dir is on
the proxy's sys.path). See PLAN.md for exact compose + apply steps.
"""

import asyncio
import os
import random
import time
import uuid
from typing import Any, Optional

from litellm._logging import verbose_proxy_logger
from litellm.integrations.custom_logger import CustomLogger


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except Exception:
        return default


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except Exception:
        return default


class _Cfg:
    # Max simultaneous upstream Anthropic requests across the whole fleet.
    MAX_CONCURRENCY = _int_env("PACE_MAX_CONCURRENCY", 8)
    # Rolling 60s request ceiling (fleet-wide).
    MAX_RPM = _int_env("PACE_MAX_RPM", 60)
    # Rolling 1s burst smoother (fleet-wide).
    MAX_RPS = _int_env("PACE_MAX_RPS", 4)
    # Hard ceiling on how long a single request will wait in the pacer
    # before failing open and proceeding regardless.
    MAX_WAIT_S = _float_env("PACE_MAX_WAIT_S", 20.0)
    # A concurrency lease auto-expires after this many seconds so a missed
    # release (crash / streaming edge) cannot permanently consume a slot.
    LEASE_TTL_S = _int_env("PACE_LEASE_TTL_S", 300)
    # Cap on how long a Retry-After-driven cooldown can park the fleet.
    MAX_COOLDOWN_S = _float_env("PACE_MAX_COOLDOWN_S", 60.0)
    # Poll interval + jitter while waiting for a slot / rate window.
    POLL_MIN_S = _float_env("PACE_POLL_MIN_S", 0.10)
    POLL_MAX_S = _float_env("PACE_POLL_MAX_S", 0.40)

    # --- Layer 1: cooldown-hold + hard-wait backstop (throughput safety) ------
    # ABSOLUTE backstop on ANY wait in the pacer, in EITHER regime. Enforced on
    # every iteration of the wait loop (see async_pre_call_hook) so a bug in the
    # cooldown-hold logic can never wedge a request longer than this. Must stay
    # strictly below the gateway's 300s silence watchdog and below claude's own
    # retry budget. ACTIVE BY DEFAULT: it only ever SHORTENS a pathological wait,
    # and with the default 45 (> MAX_WAIT_S's 12/20) it never fires during normal
    # burst-smoothing, so turning it on is behaviour-neutral. Keep >= MAX_WAIT_S.
    HARD_MAX_WAIT_S = _float_env("PACE_HARD_MAX_WAIT_S", 45.0)
    # Gate for the cooldown-HOLD regime. OFF by default => behaviour is identical
    # to pre-L1 (fail open at MAX_WAIT_S even during a signalled cooldown). Set
    # PACE_COOLDOWN_HOLD=true at rollout to hold the line through a cooldown.
    COOLDOWN_HOLD = os.getenv("PACE_COOLDOWN_HOLD", "false").lower() == "true"
    # Ceiling on how long the cooldown-HOLD regime will queue a request while a
    # fleet cooldown is active. Naturally bounded by MAX_COOLDOWN_S too; keep
    # <= MAX_COOLDOWN_S. Only consulted when COOLDOWN_HOLD is on, and always
    # dominated by HARD_MAX_WAIT_S.
    COOLDOWN_HOLD_CEILING_S = _float_env("PACE_COOLDOWN_HOLD_CEILING_S", 60.0)
    # Extra jitter window (seconds) added to the backoff WHILE HOLDING during a
    # cooldown, so that when the cooldown elapses the queued fleet re-admits
    # spread across this window instead of stampeding the same 1s and instantly
    # re-tripping the 429 that set the cooldown. Only applied in the hold regime
    # (which is off by default), so it is behaviour-neutral until hold is on.
    RELEASE_JITTER_S = _float_env("PACE_RELEASE_JITTER_S", 1.0)

    # Master on/off. Set PACE_ENABLED=false to make the hook a pure no-op
    # without touching config wiring.
    ENABLED = os.getenv("PACE_ENABLED", "true").lower() != "false"
    # Only pace these call types. Passthrough is what agents use.
    CALL_TYPES = {"pass_through_endpoint"}

    REDIS_HOST = os.getenv("REDIS_HOST", "redis")
    REDIS_PORT = _int_env("REDIS_PORT", 6379)
    REDIS_PASSWORD = os.getenv("REDIS_PASSWORD") or None
    KEY_PREFIX = os.getenv("PACE_KEY_PREFIX", "litellm_pace")


_INFLIGHT_KEY = f"{_Cfg.KEY_PREFIX}:inflight"      # ZSET member=pace_id score=deadline
_RECENT_KEY = f"{_Cfg.KEY_PREFIX}:recent"          # ZSET member=uuid score=ts (rolling window)
_COOLDOWN_KEY = f"{_Cfg.KEY_PREFIX}:cooldown_until"  # STRING epoch seconds

# Atomic admission. Redis runs a script to completion single-threaded, so the
# trim -> count -> conditional-add sequence is race-free across all 8 proxy
# workers (a plain check-then-act leaks the cap under exactly the burst we
# defend against). Returns 1 = admitted (lease taken), 0 = must wait.
_ADMIT_LUA = """
local inflight = KEYS[1]
local recent = KEYS[2]
local cd = KEYS[3]
local now = tonumber(ARGV[1])
local maxc = tonumber(ARGV[2])
local maxrpm = tonumber(ARGV[3])
local maxrps = tonumber(ARGV[4])
local lease = tonumber(ARGV[5])
local pid = ARGV[6]
local ruid = ARGV[7]
local until_ = redis.call('GET', cd)
if until_ and tonumber(until_) > now then return 0 end
redis.call('ZREMRANGEBYSCORE', inflight, '-inf', now)
if redis.call('ZCARD', inflight) >= maxc then return 0 end
redis.call('ZREMRANGEBYSCORE', recent, '-inf', now - 60)
if redis.call('ZCARD', recent) >= maxrpm then return 0 end
if tonumber(redis.call('ZCOUNT', recent, now - 1, '+inf')) >= maxrps then return 0 end
redis.call('ZADD', inflight, now + lease, pid)
redis.call('EXPIRE', inflight, lease + 60)
redis.call('ZADD', recent, now, ruid)
redis.call('EXPIRE', recent, 120)
return 1
"""


class FleetPacer(CustomLogger):
    def __init__(self) -> None:
        super().__init__()
        self._redis = None
        self._redis_init_failed = False

    # ----- redis -------------------------------------------------------
    async def _get_redis(self):
        if self._redis is not None:
            return self._redis
        if self._redis_init_failed:
            return None
        try:
            import redis.asyncio as aioredis  # type: ignore

            self._redis = aioredis.Redis(
                host=_Cfg.REDIS_HOST,
                port=_Cfg.REDIS_PORT,
                password=_Cfg.REDIS_PASSWORD,
                socket_connect_timeout=1.0,
                socket_timeout=1.0,
                decode_responses=True,
            )
            # Cheap liveness probe; if it fails we fail open forever after.
            await self._redis.ping()
            return self._redis
        except Exception as e:  # pragma: no cover - defensive
            verbose_proxy_logger.warning(
                "custom_pacing: redis unavailable, pacer fails OPEN (no pacing): %s", e
            )
            self._redis_init_failed = True
            self._redis = None
            return None

    # ----- helpers -----------------------------------------------------
    async def _cooldown_remaining(self, r) -> float:
        try:
            raw = await r.get(_COOLDOWN_KEY)
            if not raw:
                return 0.0
            remaining = float(raw) - time.time()
            return max(0.0, min(remaining, _Cfg.MAX_COOLDOWN_S))
        except Exception:
            return 0.0

    def _backoff_sleep_s(self, holding: bool) -> float:
        """Jittered backoff between admit attempts. The base poll jitter already
        de-synchronizes the fleet during ordinary polling. In the cooldown-HOLD
        regime we add an extra bounded release-jitter term (RELEASE_JITTER_S) so
        that when the cooldown elapses the queued requests re-admit spread across
        that window instead of stampeding the same 1s window and immediately
        re-tripping the 429 that set the cooldown (thundering-herd guard). Only
        widened while holding; the burst-smoothing regime keeps the original
        POLL_MIN..POLL_MAX behaviour."""
        base = random.uniform(_Cfg.POLL_MIN_S, _Cfg.POLL_MAX_S)
        if holding and _Cfg.RELEASE_JITTER_S > 0:
            base += random.uniform(0.0, _Cfg.RELEASE_JITTER_S)
        return base

    async def _try_admit(self, r, pace_id: str) -> bool:
        """One ATOMIC admission attempt via Lua. Returns True if a
        concurrency slot + rate window was granted (and the request
        recorded). Never raises — on any Redis error it fails OPEN
        (returns True) so the pacer can never wedge the fleet."""
        now = time.time()
        try:
            result = await r.eval(
                _ADMIT_LUA,
                3,
                _INFLIGHT_KEY,
                _RECENT_KEY,
                _COOLDOWN_KEY,
                repr(now),
                str(_Cfg.MAX_CONCURRENCY),
                str(_Cfg.MAX_RPM),
                str(_Cfg.MAX_RPS),
                str(_Cfg.LEASE_TTL_S),
                pace_id,
                uuid.uuid4().hex,
            )
            return int(result) == 1
        except Exception as e:
            verbose_proxy_logger.debug("custom_pacing: admit check error (fail open): %s", e)
            # On redis error, fail open by claiming admission.
            return True

    async def _release(self, pace_id: Optional[str]) -> None:
        if not pace_id:
            return
        r = await self._get_redis()
        if r is None:
            return
        try:
            await r.zrem(_INFLIGHT_KEY, pace_id)
        except Exception:
            pass

    # ----- LiteLLM hooks ----------------------------------------------
    async def async_pre_call_hook(
        self,
        user_api_key_dict: Any,
        cache: Any,
        data: dict,
        call_type: str,
    ):
        # Fast bail: disabled, wrong call type, or bad payload -> no-op.
        if not _Cfg.ENABLED or call_type not in _Cfg.CALL_TYPES or not isinstance(data, dict):
            return data

        r = await self._get_redis()
        if r is None:
            return data  # fail open

        pace_id = uuid.uuid4().hex
        start = time.time()
        # ABSOLUTE backstop: no wait in EITHER regime may exceed this. Computed
        # once, checked first on every iteration below — unbypassable by the
        # regime logic. This is the load-bearing safety invariant.
        hard_deadline = start + _Cfg.HARD_MAX_WAIT_S
        admitted = False
        try:
            while True:
                if await self._try_admit(r, pace_id):
                    admitted = True
                    break
                now = time.time()
                # (1) ABSOLUTE BACKSTOP — enforced FIRST, on every iteration, so
                # a bug in the cooldown-hold branch below can never wedge a
                # request past HARD_MAX_WAIT_S. Do NOT move this inside a
                # conditional or below the regime logic.
                if now >= hard_deadline:
                    verbose_proxy_logger.warning(
                        "custom_pacing: HARD wait cap %.1fs hit, admitting unpaced (fail open)",
                        _Cfg.HARD_MAX_WAIT_S,
                    )
                    break
                # (2) Pick this iteration's regime ceiling:
                #   * burst-smoothing (no active cooldown): the short MAX_WAIT_S
                #     ceiling then benign fail-open — leaking here is fine.
                #   * cooldown-HOLD (a fleet cooldown is in the future: Anthropic
                #     has SIGNALLED a throttle): do NOT fail open at MAX_WAIT_S;
                #     keep holding until the cooldown elapses, bounded by
                #     COOLDOWN_HOLD_CEILING_S (and, above, by the hard cap).
                # The hold regime is gated OFF by default, so with default config
                # this reduces exactly to the pre-L1 MAX_WAIT_S ceiling.
                ceiling = _Cfg.MAX_WAIT_S
                holding = False
                if _Cfg.COOLDOWN_HOLD:
                    remaining = await self._cooldown_remaining(r)
                    if remaining > 0:
                        holding = True
                        ceiling = _Cfg.COOLDOWN_HOLD_CEILING_S
                if now - start >= ceiling:
                    # Fail open: never reject, just proceed after the ceiling.
                    verbose_proxy_logger.warning(
                        "custom_pacing: %s wait ceiling %.1fs hit, admitting unpaced (fail open)",
                        "cooldown-hold" if holding else "burst",
                        ceiling,
                    )
                    break
                # (3) Bounded jittered backoff; jitter de-synchronizes the fleet
                # so releases don't thunder (extra release jitter while holding).
                await asyncio.sleep(self._backoff_sleep_s(holding))
        except Exception as e:
            verbose_proxy_logger.debug("custom_pacing: pre_call error (fail open): %s", e)

        # Stash id so post hooks can release the concurrency lease. Even if
        # this is lost, the lease self-heals via LEASE_TTL_S.
        if admitted:
            try:
                meta = data.setdefault("metadata", {})
                if isinstance(meta, dict):
                    meta["_pace_id"] = pace_id
            except Exception:
                pass
        return data

    def _extract_pace_id(self, data: Any) -> Optional[str]:
        try:
            if isinstance(data, dict):
                meta = data.get("metadata")
                if isinstance(meta, dict):
                    return meta.get("_pace_id")
        except Exception:
            pass
        return None

    async def async_post_call_success_hook(self, data, user_api_key_dict, response):
        await self._release(self._extract_pace_id(data))
        return response

    async def async_post_call_failure_hook(
        self, request_data, original_exception, user_api_key_dict, traceback_str: Optional[str] = None
    ):
        # Release the slot first.
        await self._release(self._extract_pace_id(request_data))

        # Adaptive cooldown on upstream 429: park the fleet for Retry-After.
        try:
            status = getattr(original_exception, "status_code", None) or getattr(
                original_exception, "code", None
            )
            msg = str(getattr(original_exception, "message", "") or original_exception)
            is_429 = str(status) == "429" or "rate_limit_error" in msg or "would exceed your account" in msg
            if not is_429:
                return
            retry_after = self._parse_retry_after(original_exception)
            cooldown = retry_after if retry_after and retry_after > 0 else 5.0
            cooldown = min(cooldown, _Cfg.MAX_COOLDOWN_S)
            r = await self._get_redis()
            if r is None:
                return
            until = time.time() + cooldown
            # Only extend, never shorten, an existing cooldown.
            existing = await r.get(_COOLDOWN_KEY)
            if not existing or float(existing) < until:
                await r.set(_COOLDOWN_KEY, str(until), ex=int(_Cfg.MAX_COOLDOWN_S) + 5)
                verbose_proxy_logger.warning(
                    "custom_pacing: upstream 429 -> fleet cooldown %.1fs (honoring retry-after)",
                    cooldown,
                )
        except Exception as e:
            verbose_proxy_logger.debug("custom_pacing: failure hook error: %s", e)

    @staticmethod
    def _parse_retry_after(exc: Any) -> Optional[float]:
        # Try common shapes: exc.headers['retry-after'], exc.response.headers,
        # or a numeric in the message. Best-effort, never raises.
        try:
            for attr in ("headers",):
                h = getattr(exc, attr, None)
                if h and hasattr(h, "get"):
                    v = h.get("retry-after") or h.get("Retry-After")
                    if v is not None:
                        return float(v)
            resp = getattr(exc, "response", None)
            if resp is not None:
                h = getattr(resp, "headers", None)
                if h and hasattr(h, "get"):
                    v = h.get("retry-after") or h.get("Retry-After")
                    if v is not None:
                        return float(v)
        except Exception:
            pass
        return None


# LiteLLM loads the callback by importing this module and resolving the
# dotted path "custom_pacing.pacer_instance" to this singleton.
pacer_instance = FleetPacer()
