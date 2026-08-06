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
    invoked on BOTH subscription-Claude paths — verified against litellm
    v1.91.0:
      - the /anthropic PASSTHROUGH path (call_type ==
        "pass_through_endpoint" — proxy/utils.py::pre_call_hook +
        pass_through_endpoints.py:845), and
      - the /v1/messages ROUTER path (call_type == "anthropic_messages" —
        proxy/endpoints.py route_type; exactly one pre_call per request,
        no double-pacing).
    The passthrough path is always paced (it has no routable group). The
    router path is gated on an explicit paced-GROUP allowlist
    (PACE_MODEL_GROUPS), because data["model"] on the router path is the
    requested GROUP name (pre-routing), not the resolved deployment: e.g.
    subscription-Claude aliases "sonnet"/"fable" and "claude-*" ARE paced,
    but OpenRouter groups like "claude-sonnet-5-openrouter" are NOT (their
    upstream limits differ from the fleet's Anthropic account, so the
    Anthropic cooldown must not hold them).
  * Bounded global CONCURRENCY: at most PACE_MAX_CONCURRENCY upstream
    requests in flight across all 8 proxy workers, coordinated in Redis
    via a self-healing sorted-set lease (missed releases age out after
    PACE_LEASE_TTL_S — no leaked permanent slots).
  * Bounded global RATE: rolling 60s cap (PACE_MAX_RPM) + rolling 1s burst
    smoother (PACE_MAX_RPS).
  * Bounded global TOKENS (PACE_MAX_TPM): a rolling ~60s fleet-wide token
    budget as a 4th admission predicate, because Anthropic's per-minute burst
    ceiling is a token ceiling as much as a request ceiling — a few huge-context
    turns can 429 an account the RPM gate would admit. A cheap char-count
    estimate reserves budget at admit; the non-streaming + router terminal paths
    reconcile it to real usage. DISABLED by default (0) — fully inert until the
    env is set at rollout, so the token logic is behaviour-neutral until then.
  * EXPLICIT LEASE RELEASE on the passthrough path. litellm exposes no
    callback that fires on a passthrough stream, and the one
    post_call_success_hook call site on the non-streaming passthrough path is
    nested under a guardrails condition that is false with no passthrough
    guardrails configured. So every passthrough request used to leak its
    lease and only age out by TTL, which made the concurrency counter
    meaningless and admission control fail-open in practice. Two narrow,
    idempotent, install-once wrappers fix that — see
    _install_streaming_release_patch / _install_nonstreaming_release_patch at
    the bottom of this file. The lease id rides on the per-request logging
    object because metadata is popped off the body before the upstream call.
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
import fnmatch
import os
import random
import time
import uuid
from collections import OrderedDict
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


def _csv_env(name: str, default_csv: str) -> list[str]:
    """Parse a comma-separated env list into a list of stripped, non-empty
    entries. Falls back to the default CSV when the env is unset. Never
    raises — a bad value degrades to the default."""
    try:
        raw = os.getenv(name)
        if raw is None:
            raw = default_csv
        return [x.strip() for x in raw.split(",") if x.strip()]
    except Exception:
        return [x.strip() for x in default_csv.split(",") if x.strip()]


# The gateway nulls a silent turn at SILENCE_FALLBACK_MS (default 300000ms /
# 300s). A pacer hold that approached that would look like a hang, so the hard
# cap is clamped strictly below it with margin. Named so the invariant is one
# obvious constant, not a magic number buried in an expression.
_PACE_WATCHDOG_SAFE_CEILING_S = 280.0


def _clamp_hard_max_wait(
    hard: float, max_wait: float, watchdog_ceiling: float = _PACE_WATCHDOG_SAFE_CEILING_S
) -> float:
    """Runtime-enforce the absolute-cap invariants regardless of env overrides,
    so a deploy-time misconfig can't silently defeat them:
      * never BELOW the burst-smoothing ceiling (a hard cap under MAX_WAIT_S
        would shorten a normal, benign wait), and
      * never AT/ABOVE the gateway silence watchdog (a hold that long looks
        like a hang to the watchdog).
    Deterministic control, not a test-only assertion."""
    return min(max(hard, max_wait), watchdog_ceiling)


def _clamp_hold_ceiling(ceiling: float, max_cooldown: float) -> float:
    """A cooldown-hold can never usefully queue longer than the cooldown itself
    can be parked (MAX_COOLDOWN_S), so clamp the hold ceiling down to it
    regardless of env override."""
    return min(ceiling, max_cooldown)


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
    # A concurrency lease auto-expires after this many seconds. This is a
    # BACKSTOP ONLY — since the streaming/non-streaming release patches landed
    # the explicit release is the load-bearing mechanism, and the TTL only
    # covers a proxy crash mid-stream. Do not remove it.
    LEASE_TTL_S = _int_env("PACE_LEASE_TTL_S", 300)
    # Cap on how long a Retry-After-driven cooldown can park the fleet.
    MAX_COOLDOWN_S = _float_env("PACE_MAX_COOLDOWN_S", 60.0)
    # Poll interval + jitter while waiting for a slot / rate window.
    POLL_MIN_S = _float_env("PACE_POLL_MIN_S", 0.10)
    POLL_MAX_S = _float_env("PACE_POLL_MAX_S", 0.40)

    # --- Layer 1: cooldown-hold + hard-wait backstop (throughput safety) ------
    # ABSOLUTE backstop on ANY wait in the pacer, in EITHER regime. Checked on
    # every iteration of the wait loop (see async_pre_call_hook) so a bug in the
    # cooldown-hold logic can never wedge a request meaningfully past it — the
    # true worst case is HARD_MAX_WAIT_S + at most one backoff interval + the
    # admit-check latency (~a second), not a hard ceiling to the millisecond.
    # ACTIVE BY DEFAULT: it only ever SHORTENS a pathological wait, and with the
    # default 45 (> MAX_WAIT_S's 12/20) it never fires during normal burst-
    # smoothing, so it is behaviour-neutral. Clamped at load into
    # [MAX_WAIT_S, _PACE_WATCHDOG_SAFE_CEILING_S] so an env misconfig can't put
    # it below the smoothing ceiling or above the silence watchdog.
    HARD_MAX_WAIT_S = _clamp_hard_max_wait(
        _float_env("PACE_HARD_MAX_WAIT_S", 45.0), MAX_WAIT_S
    )
    # Gate for the cooldown-HOLD regime. OFF by default => behaviour is identical
    # to pre-L1 (fail open at MAX_WAIT_S even during a signalled cooldown). Set
    # PACE_COOLDOWN_HOLD=true at rollout to hold the line through a cooldown.
    COOLDOWN_HOLD = os.getenv("PACE_COOLDOWN_HOLD", "false").lower() == "true"
    # Ceiling on how long the cooldown-HOLD regime will queue a request while a
    # fleet cooldown is active. Clamped at load to <= MAX_COOLDOWN_S (a hold can
    # never usefully outlast the cooldown that can be parked) regardless of env
    # override. Only consulted when COOLDOWN_HOLD is on, and always dominated by
    # HARD_MAX_WAIT_S.
    COOLDOWN_HOLD_CEILING_S = _clamp_hold_ceiling(
        _float_env("PACE_COOLDOWN_HOLD_CEILING_S", 60.0), MAX_COOLDOWN_S
    )
    # Extra jitter window (seconds) added to the backoff WHILE HOLDING during a
    # cooldown, so that when the cooldown elapses the queued fleet re-admits
    # spread across this window instead of stampeding the same 1s and instantly
    # re-tripping the 429 that set the cooldown. Only applied in the hold regime
    # (which is off by default), so it is behaviour-neutral until hold is on.
    RELEASE_JITTER_S = _float_env("PACE_RELEASE_JITTER_S", 1.0)

    # Master on/off. Set PACE_ENABLED=false to make the hook a pure no-op
    # without touching config wiring.
    ENABLED = os.getenv("PACE_ENABLED", "true").lower() != "false"
    # Only pace these call types. Both are subscription-Claude paths:
    #   * "pass_through_endpoint" — the /anthropic passthrough (always paced;
    #     no routable group).
    #   * "anthropic_messages"   — the /v1/messages ROUTER path (paced only
    #     when its GROUP is in the PACE_MODEL_GROUPS allowlist below).
    # Env-overridable as a comma list (PACE_CALL_TYPES).
    CALL_TYPES = set(
        _csv_env("PACE_CALL_TYPES", "pass_through_endpoint,anthropic_messages")
    )
    # The passthrough call type carries no routable model GROUP, so it is
    # never subject to the group allowlist below — it is paced whenever its
    # call type is enabled. Every OTHER call type in CALL_TYPES is treated as
    # a router path and gated on PACE_MODEL_GROUPS.
    PASSTHROUGH_CALL_TYPE = os.getenv(
        "PACE_PASSTHROUGH_CALL_TYPE", "pass_through_endpoint"
    )
    # Explicit allowlist of paced router GROUP names (fnmatch globs allowed).
    # Seeded to cover the live subscription-Claude groups: the "claude-*"
    # family plus the "sonnet"/"fable" aliases agents actually request (all
    # carry forward_client_headers_to_llm_api:true in litellm-config.yaml).
    # An explicit allowlist — NOT a "claude-*" prefix heuristic — because that
    # heuristic is wrong both ways: "sonnet"/"fable" don't match it (would
    # stay unpaced) and "claude-sonnet-5-openrouter" DOES match it (would be
    # wrongly held by the Anthropic cooldown though it is an OpenRouter group).
    PACE_MODEL_GROUPS = _csv_env("PACE_MODEL_GROUPS", "claude-*,sonnet,fable")
    # Exclusion globs applied AFTER the allowlist (exclusion wins). Keeps any
    # "*-openrouter" group out even though it may match "claude-*", since its
    # upstream rate limits are OpenRouter's, not the fleet Anthropic account's.
    PACE_MODEL_GROUPS_EXCLUDE = _csv_env(
        "PACE_MODEL_GROUPS_EXCLUDE", "*-openrouter"
    )

    # --- Token-aware pacing (PACE_MAX_TPM) -----------------------------------
    # A 4th admission predicate: a fleet-wide rolling ~60s TOKEN budget, layered
    # on top of the concurrency/RPM/RPS gates. Anthropic's per-minute burst
    # ceiling is a token ceiling as much as a request ceiling — a handful of
    # huge-context turns can 429 an account the RPM gate would happily admit.
    # DISABLED BY DEFAULT (0): with MAX_TPM==0 every bit of token logic below is
    # inert — the Lua predicate short-circuits, the estimator is never called,
    # and the `litellm_pace:tokens` key is never written — so merging + redeploy
    # is behaviour-neutral until the env is set at rollout (prod sets 1200000).
    # max(0, …) so a negative env can't invert the gate.
    MAX_TPM = max(0, _int_env("PACE_MAX_TPM", 0))
    # Output tokens reserved per request in the estimate (the response is not yet
    # known at admit time). Also the CAP on a caller-supplied max_tokens, so one
    # request can never reserve an unbounded slice of the budget.
    TPM_OUTPUT_RESERVE = _int_env("PACE_TPM_OUTPUT_RESERVE", 2048)
    # Char/token ratio for the cheap, dependency-free input estimator. ~4 chars
    # per token is the standard rough English ratio; conservative is fine because
    # the estimate reconciles to real usage post-call.
    TPM_CHARS_PER_TOKEN = _float_env("PACE_TPM_CHARS_PER_TOKEN", 4.0)
    # Multiplier applied to the whole per-request estimate — safety headroom for
    # the heuristic's under-count. 1.0 = trust the estimate as-is.
    TPM_EST_MULT = _float_env("PACE_TPM_EST_MULT", 1.0)
    # Weight applied to cache-READ tokens when reconciling to actual usage.
    # Cache reads are far cheaper against the burst ceiling than fresh input; a
    # weight < 1 discounts them. Default 1.0 = count them at par (conservative).
    TPM_CACHE_READ_WEIGHT = _float_env("PACE_TPM_CACHE_READ_WEIGHT", 1.0)

    REDIS_HOST = os.getenv("REDIS_HOST", "redis")
    REDIS_PORT = _int_env("REDIS_PORT", 6379)
    REDIS_PASSWORD = os.getenv("REDIS_PASSWORD") or None
    KEY_PREFIX = os.getenv("PACE_KEY_PREFIX", "litellm_pace")


_INFLIGHT_KEY = f"{_Cfg.KEY_PREFIX}:inflight"      # ZSET member=pace_id score=deadline
_RECENT_KEY = f"{_Cfg.KEY_PREFIX}:recent"          # ZSET member=uuid score=ts (rolling window)
_COOLDOWN_KEY = f"{_Cfg.KEY_PREFIX}:cooldown_until"  # STRING epoch seconds
# HASH field=10s-bucket-start (floor(now/10)*10 as str) value=int tokens. The
# rolling ~60s token sum is the fields whose bucket > now-60 (~7 live buckets);
# the admit Lua HDELs older fields as it walks them and EXPIREs the key 120s so
# a fully idle fleet drops the key entirely.
_TOKENS_KEY = f"{_Cfg.KEY_PREFIX}:tokens"
# Cheap observability counter: INCR'd inside the admit Lua on a token-caused
# denial only (not concurrency/RPM/RPS/cooldown denials), so operators can see
# whether the TOKEN gate is the thing throttling the fleet.
_TPM_DENIED_KEY = f"{_Cfg.KEY_PREFIX}:tpm_denied"

# Atomic admission. Redis runs a script to completion single-threaded, so the
# trim -> count -> conditional-add sequence is race-free across all 8 proxy
# workers (a plain check-then-act leaks the cap under exactly the burst we
# defend against). Returns 1 = admitted (lease taken), 0 = must wait.
_ADMIT_LUA = """
local inflight = KEYS[1]
local recent = KEYS[2]
local cd = KEYS[3]
local tokens = KEYS[4]
local tpm_denied = KEYS[5]
local now = tonumber(ARGV[1])
local maxc = tonumber(ARGV[2])
local maxrpm = tonumber(ARGV[3])
local maxrps = tonumber(ARGV[4])
local lease = tonumber(ARGV[5])
local pid = ARGV[6]
local ruid = ARGV[7]
local maxtpm = tonumber(ARGV[8])
local est = tonumber(ARGV[9])
local until_ = redis.call('GET', cd)
if until_ and tonumber(until_) > now then return 0 end
redis.call('ZREMRANGEBYSCORE', inflight, '-inf', now)
if redis.call('ZCARD', inflight) >= maxc then return 0 end
redis.call('ZREMRANGEBYSCORE', recent, '-inf', now - 60)
if redis.call('ZCARD', recent) >= maxrpm then return 0 end
if tonumber(redis.call('ZCOUNT', recent, now - 1, '+inf')) >= maxrps then return 0 end
-- (4th predicate) rolling ~60s TOKEN budget. Fully inert when maxtpm<=0.
-- Placed AFTER the RPS check and BEFORE the ZADD writes so a token denial
-- takes no concurrency/rate slot. Walks the bucket hash once: HDELs fields at
-- or below now-60 (stale) and sums the rest.
local cur_bucket = math.floor(now / 10) * 10
if maxtpm > 0 then
  local cutoff = now - 60
  local sum = 0
  local fields = redis.call('HGETALL', tokens)
  for i = 1, #fields, 2 do
    local b = tonumber(fields[i])
    local v = tonumber(fields[i + 1])
    if (b == nil) or (b <= cutoff) then
      redis.call('HDEL', tokens, fields[i])
    elseif v then
      sum = sum + v
    end
  end
  if sum < 0 then sum = 0 end
  -- SINGLE-OVERSIZED-REQUEST BYPASS: a request whose OWN estimate already
  -- meets/exceeds the whole budget can never satisfy sum+est<=maxtpm and would
  -- burn the full wait ceiling on every attempt. Skip the sum check for it (it
  -- still records its tokens + admits) so it is not permanently starved; the
  -- budget check only gates requests that could plausibly fit.
  if est < maxtpm then
    if sum + est > maxtpm then
      redis.call('INCR', tpm_denied)
      return 0
    end
  end
end
redis.call('ZADD', inflight, now + lease, pid)
redis.call('EXPIRE', inflight, lease + 60)
redis.call('ZADD', recent, now, ruid)
redis.call('EXPIRE', recent, 120)
if maxtpm > 0 then
  redis.call('HINCRBY', tokens, tostring(cur_bucket), est)
  redis.call('EXPIRE', tokens, 120)
end
return 1
"""


# --- Token estimation + accounting helpers (pure, module-level) ------------
# All three NEVER raise: on ANY error they return 0 / None. They run on the hot
# admit path, so they are deliberately dependency-free — no litellm.token_counter
# (which imports a tokenizer and is far too slow here). A char/token heuristic is
# good enough for a rolling admission budget that reconciles to real usage.


def _token_bucket(now: float) -> int:
    """The 10s bucket start for a timestamp: floor(now/10)*10. Never raises."""
    try:
        return int(now // 10) * 10
    except Exception:
        return 0


def _estimate_tokens(data: Any) -> int:
    """Cheap per-request token estimate for the admit budget. NEVER raises — any
    error returns 0 (which simply doesn't contribute to the fleet budget).

    Counts characters across messages (plain-string content AND content-block
    lists), the system prompt, and the tools spec, divides by CHARS_PER_TOKEN
    for the input estimate, adds a bounded output reservation, and scales by
    EST_MULT. Content blocks: text blocks count their `text` length; an image
    block counts a flat ~1600; any other block counts len(str(block))//4."""
    try:
        if not isinstance(data, dict):
            return 0

        def _block_chars(block: Any) -> int:
            if isinstance(block, dict):
                t = block.get("text")
                if isinstance(t, str):
                    return len(t)
                if block.get("type") in ("image", "image_url"):
                    return 1600
                return len(str(block)) // 4
            return len(str(block)) // 4

        def _content_chars(content: Any) -> int:
            if content is None:
                return 0
            if isinstance(content, str):
                return len(content)
            if isinstance(content, list):
                return sum(_block_chars(b) for b in content)
            return len(str(content))

        chars = 0
        messages = data.get("messages")
        if isinstance(messages, list):
            for msg in messages:
                if isinstance(msg, dict):
                    chars += _content_chars(msg.get("content"))
                elif isinstance(msg, str):
                    chars += len(msg)

        system = data.get("system")
        if system is not None:
            chars += _content_chars(system)

        tools = data.get("tools")
        if tools:
            chars += len(str(tools))

        cpt = _Cfg.TPM_CHARS_PER_TOKEN or 4.0
        est_in = int(chars / cpt)
        reserve = _Cfg.TPM_OUTPUT_RESERVE
        est_out = min(int(data.get("max_tokens") or reserve), reserve)
        total = int((est_in + est_out) * _Cfg.TPM_EST_MULT)
        return total if total > 0 else 0
    except Exception:
        return 0


def _usage_actual_tokens(usage: dict) -> Optional[int]:
    """Actual token count from an Anthropic/OpenAI-style usage dict:
    input + cache_creation + output + cache_read*CACHE_READ_WEIGHT. Missing
    fields contribute 0; a usage carrying NO recognised field returns None (so
    reconciliation is skipped rather than adjusting by a bogus 0). NEVER raises."""
    try:
        if not isinstance(usage, dict):
            return None
        seen = False
        total = 0.0

        def _num(*keys: str) -> float:
            nonlocal seen
            for k in keys:
                v = usage.get(k)
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    seen = True
                    return float(v)
            return 0.0

        total += _num("input_tokens", "prompt_tokens")
        total += _num("cache_creation_input_tokens", "cache_creation_tokens")
        total += _num("output_tokens", "completion_tokens")
        total += (
            _num("cache_read_input_tokens", "cache_read_tokens")
            * _Cfg.TPM_CACHE_READ_WEIGHT
        )
        if not seen:
            return None
        return int(total)
    except Exception:
        return None


# Attribute/key name the lease id is pinned under, on every carrier that can
# survive to a terminal path (request metadata, litellm_params.metadata, and
# the per-request LiteLLMLoggingObj).
_PACE_ATTR = "_pace_id"
# Sibling attribute carrying the admit-time token ESTIMATE alongside the lease
# id on the same carriers, so a terminal path can reconcile the budget against
# the request's real usage.
_PACE_TOK_ATTR = "_pace_tok_est"
# Bound on the per-worker already-released LRU. Purely a Redis-round-trip
# saver — ZREM is idempotent on its own — so any bound works; this one keeps
# the dict trivially small for a long-lived proxy worker.
_RELEASED_LRU_MAX = 4096


class FleetPacer(CustomLogger):
    def __init__(self) -> None:
        super().__init__()
        self._redis = None
        self._redis_init_failed = False
        # Bounded LRU of already-released lease ids, so the several terminal
        # paths that can fire for one request (streaming wrapper, success
        # handler, failure hook) don't each pay a Redis round-trip.
        self._released: "OrderedDict[str, None]" = OrderedDict()
        # Strong refs to fire-and-forget release tasks so the event loop
        # cannot GC them mid-flight.
        self._pending_tasks: set = set()

    # ----- idempotency -------------------------------------------------
    def _already_released(self, pace_id: str) -> bool:
        if pace_id in self._released:
            return True
        self._released[pace_id] = None
        while len(self._released) > _RELEASED_LRU_MAX:
            self._released.popitem(last=False)
        return False

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

    async def _try_admit(self, r, pace_id: str, est_tokens: int = 0) -> bool:
        """One ATOMIC admission attempt via Lua. Returns True if a
        concurrency slot + rate window + token budget was granted (and the
        request recorded). `est_tokens` is the admit-time token estimate; it is
        only consulted when PACE_MAX_TPM>0 (else the Lua predicate is inert).
        Never raises — on any Redis error it fails OPEN (returns True) so the
        pacer can never wedge the fleet."""
        now = time.time()
        try:
            result = await r.eval(
                _ADMIT_LUA,
                5,
                _INFLIGHT_KEY,
                _RECENT_KEY,
                _COOLDOWN_KEY,
                _TOKENS_KEY,
                _TPM_DENIED_KEY,
                repr(now),
                str(_Cfg.MAX_CONCURRENCY),
                str(_Cfg.MAX_RPM),
                str(_Cfg.MAX_RPS),
                str(_Cfg.LEASE_TTL_S),
                pace_id,
                uuid.uuid4().hex,
                str(_Cfg.MAX_TPM),
                str(int(est_tokens or 0)),
            )
            return int(result) == 1
        except Exception as e:
            verbose_proxy_logger.debug("custom_pacing: admit check error (fail open): %s", e)
            # On redis error, fail open by claiming admission.
            return True

    async def _record_est_fail_open(self, r, est: int) -> None:
        """When a request FAILS OPEN past the wait ceiling it was never recorded
        in the token budget by the admit Lua (which only records on admit). Book
        its estimate into the current bucket here so the fleet budget still
        accounts for the tokens it is about to spend. Best-effort only: guarded
        on MAX_TPM>0 and a positive estimate, and swallows every error."""
        if not (_Cfg.MAX_TPM > 0 and est > 0):
            return
        try:
            bucket = _token_bucket(time.time())
            await r.hincrby(_TOKENS_KEY, str(bucket), int(est))
            await r.expire(_TOKENS_KEY, 120)
        except Exception as e:
            verbose_proxy_logger.debug(
                "custom_pacing: fail-open token record failed (non-load-bearing): %s", e
            )

    async def _release(self, pace_id: Optional[str]) -> None:
        """Release a concurrency lease. IDEMPOTENT: ZREM of an absent member
        is a no-op in Redis, and the per-worker LRU short-circuits repeat
        calls, so it is safe for several terminal paths to race here."""
        if not pace_id:
            return
        if self._already_released(pace_id):
            return
        r = await self._get_redis()
        if r is None:
            return
        try:
            await r.zrem(_INFLIGHT_KEY, pace_id)
        except Exception:
            pass

    def _release_soon(self, pace_id: Optional[str]) -> None:
        """Schedule a release without blocking the caller. Used from the
        streaming wrapper's `finally`, which may be running under
        GeneratorExit during a client disconnect — awaiting there is legal,
        but stream teardown must never hang on Redis."""
        if not pace_id:
            return
        try:
            task = asyncio.get_running_loop().create_task(self._release(pace_id))
            self._pending_tasks.add(task)
            task.add_done_callback(self._pending_tasks.discard)
        except Exception as e:  # no running loop / loop closing
            verbose_proxy_logger.debug(
                "custom_pacing: release_soon failed (TTL backstop): %s", e
            )

    # ----- gating ------------------------------------------------------
    @staticmethod
    def _group_of(data: Any) -> Optional[str]:
        """The requested model GROUP name on the router path. On /v1/messages
        the pre_call hook sees the pre-routing group in data["model"], not the
        resolved deployment."""
        if isinstance(data, dict):
            m = data.get("model")
            if isinstance(m, str) and m:
                return m
        return None

    @staticmethod
    def _group_is_paced(group: Optional[str]) -> bool:
        """A router GROUP is paced iff it matches the PACE_MODEL_GROUPS
        allowlist AND is not excluded by PACE_MODEL_GROUPS_EXCLUDE
        (exclusion wins). Unknown group -> not paced (can't attribute it to
        the fleet Anthropic account)."""
        if not group:
            return False
        if any(fnmatch.fnmatch(group, pat) for pat in _Cfg.PACE_MODEL_GROUPS_EXCLUDE):
            return False
        return any(fnmatch.fnmatch(group, pat) for pat in _Cfg.PACE_MODEL_GROUPS)

    def _should_pace(self, call_type: str, data: Any) -> bool:
        """Decide whether this request participates in pacing. Passthrough is
        always paced (no routable group); every other enabled call type is a
        router path gated on the paced-GROUP allowlist."""
        if call_type not in _Cfg.CALL_TYPES:
            return False
        if call_type == _Cfg.PASSTHROUGH_CALL_TYPE:
            return True
        return self._group_is_paced(self._group_of(data))

    # ----- LiteLLM hooks ----------------------------------------------
    async def async_pre_call_hook(
        self,
        user_api_key_dict: Any,
        cache: Any,
        data: dict,
        call_type: str,
    ):
        # Fast bail: disabled, bad payload, or not a paced request -> no-op.
        # Router-path traffic (e.g. anthropic_messages) is paced only when its
        # requested GROUP is in the allowlist; passthrough is always paced.
        if not _Cfg.ENABLED or not isinstance(data, dict) or not self._should_pace(call_type, data):
            return data

        r = await self._get_redis()
        if r is None:
            return data  # fail open

        pace_id = uuid.uuid4().hex
        # Admit-time token estimate, computed ONCE before the wait loop. Fully
        # skipped (and the estimator never consulted) when token pacing is off.
        est = _estimate_tokens(data) if _Cfg.MAX_TPM > 0 else 0
        # Loop deadline math uses a MONOTONIC clock so a backward wall-clock/NTP
        # step can never extend a hold. (Redis cooldown_until stays wall-clock —
        # see _cooldown_remaining — and is never compared against these values.)
        start = time.monotonic()
        # ABSOLUTE backstop: computed once, checked FIRST on every iteration
        # below. It bounds the wait to HARD_MAX_WAIT_S plus at most one more
        # backoff interval and the final admit-check latency (the loop can only
        # notice the deadline between attempts) — the load-bearing safety bound,
        # not a to-the-millisecond ceiling.
        hard_deadline = start + _Cfg.HARD_MAX_WAIT_S
        admitted = False
        try:
            while True:
                if await self._try_admit(r, pace_id, est):
                    admitted = True
                    break
                now = time.monotonic()
                # (1) ABSOLUTE BACKSTOP — checked FIRST, on every iteration, so a
                # bug in the cooldown-hold branch below can't wedge a request
                # more than ~one backoff interval past HARD_MAX_WAIT_S. Do NOT
                # move this inside a conditional or below the regime logic.
                if now >= hard_deadline:
                    verbose_proxy_logger.warning(
                        "custom_pacing: HARD wait cap %.1fs hit, admitting unpaced (fail open)",
                        _Cfg.HARD_MAX_WAIT_S,
                    )
                    # Book the estimate: this request proceeds unpaced, so the
                    # admit Lua never recorded it (best-effort, guarded inside).
                    await self._record_est_fail_open(r, est)
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
                    # Book the estimate: this request proceeds unpaced, so the
                    # admit Lua never recorded it (best-effort, guarded inside).
                    await self._record_est_fail_open(r, est)
                    break
                # (3) Bounded jittered backoff; jitter de-synchronizes the fleet
                # so releases don't thunder (extra release jitter while holding).
                await asyncio.sleep(self._backoff_sleep_s(holding))
        except Exception as e:
            verbose_proxy_logger.debug("custom_pacing: pre_call error (fail open): %s", e)

        # Stash id so terminal paths can release the concurrency lease. Even
        # if every carrier is lost, the lease self-heals via LEASE_TTL_S. The
        # token estimate rides along on the same carriers for reconciliation.
        if admitted:
            self._stash_pace_id(data, pace_id, est)
        return data

    @staticmethod
    def _stash_pace_id(data: Any, pace_id: str, est_tokens: int = 0) -> None:
        """Pin the lease id on every carrier that can survive to a terminal
        path.

        `data["metadata"]` alone is NOT enough: litellm's
        `_init_kwargs_for_pass_through_endpoint` pops every key in
        `all_litellm_params` (which includes "metadata") off the parsed body
        before the upstream call, so by the time a post hook runs the key is
        gone from the body — it survives only INTO
        `kwargs["litellm_params"]["metadata"]`, which the failure path
        re-attaches. The per-request logging object is the durable handle: it
        is passed BY REFERENCE into the streaming chunk processor, which is
        the only terminal point the passthrough streaming path has.
        """
        if not isinstance(data, dict):
            return
        try:
            meta = data.setdefault("metadata", {})
            if isinstance(meta, dict):
                meta[_PACE_ATTR] = pace_id
                if est_tokens:
                    meta[_PACE_TOK_ATTR] = int(est_tokens)
        except Exception:
            pass
        try:
            lobj = data.get("litellm_logging_obj")
            if lobj is not None:
                setattr(lobj, _PACE_ATTR, pace_id)
                if est_tokens:
                    setattr(lobj, _PACE_TOK_ATTR, int(est_tokens))
                mcd = getattr(lobj, "model_call_details", None)
                if isinstance(mcd, dict):
                    mcd[_PACE_ATTR] = pace_id
                    if est_tokens:
                        mcd[_PACE_TOK_ATTR] = int(est_tokens)
        except Exception:
            pass

    @staticmethod
    def _pace_id_from_logging_obj(lobj: Any) -> Optional[str]:
        if lobj is None:
            return None
        try:
            pid = getattr(lobj, _PACE_ATTR, None)
            if isinstance(pid, str):
                return pid
            mcd = getattr(lobj, "model_call_details", None)
            if isinstance(mcd, dict):
                pid = mcd.get(_PACE_ATTR)
                if isinstance(pid, str):
                    return pid
        except Exception:
            pass
        return None

    def _extract_pace_id(self, data: Any) -> Optional[str]:
        """Best-effort recovery of the lease id from whatever shape of
        request payload a terminal hook happens to hand us."""
        try:
            if not isinstance(data, dict):
                return None
            meta = data.get("metadata")
            if isinstance(meta, dict) and isinstance(meta.get(_PACE_ATTR), str):
                return meta[_PACE_ATTR]
            lp = data.get("litellm_params")
            if isinstance(lp, dict):
                lp_meta = lp.get("metadata")
                if isinstance(lp_meta, dict) and isinstance(lp_meta.get(_PACE_ATTR), str):
                    return lp_meta[_PACE_ATTR]
            return self._pace_id_from_logging_obj(data.get("litellm_logging_obj"))
        except Exception:
            pass
        return None

    # ----- token reconciliation (best-effort, never load-bearing) ------
    @staticmethod
    def _tok_est_from_logging_obj(lobj: Any) -> Optional[int]:
        """Sibling of _pace_id_from_logging_obj: recover the admit-time token
        estimate pinned on the logging object / its model_call_details."""
        if lobj is None:
            return None
        try:
            v = getattr(lobj, _PACE_TOK_ATTR, None)
            if isinstance(v, int) and not isinstance(v, bool):
                return v
            mcd = getattr(lobj, "model_call_details", None)
            if isinstance(mcd, dict):
                v = mcd.get(_PACE_TOK_ATTR)
                if isinstance(v, int) and not isinstance(v, bool):
                    return v
        except Exception:
            pass
        return None

    def _extract_tok_est(self, data: Any) -> Optional[int]:
        """Sibling of _extract_pace_id: recover the admit-time token estimate
        from whatever payload shape a terminal hook hands us. Never raises."""
        try:
            if not isinstance(data, dict):
                return None
            meta = data.get("metadata")
            if isinstance(meta, dict):
                v = meta.get(_PACE_TOK_ATTR)
                if isinstance(v, int) and not isinstance(v, bool):
                    return v
            lp = data.get("litellm_params")
            if isinstance(lp, dict):
                lp_meta = lp.get("metadata")
                if isinstance(lp_meta, dict):
                    v = lp_meta.get(_PACE_TOK_ATTR)
                    if isinstance(v, int) and not isinstance(v, bool):
                        return v
            return self._tok_est_from_logging_obj(data.get("litellm_logging_obj"))
        except Exception:
            return None

    @staticmethod
    def _usage_to_dict(usage: Any) -> dict:
        """Coerce a usage object (dict, pydantic model, or plain attr-carrier)
        into a flat dict _usage_actual_tokens can read. Never raises."""
        try:
            if isinstance(usage, dict):
                return usage
            for meth in ("model_dump", "dict"):
                fn = getattr(usage, meth, None)
                if callable(fn):
                    try:
                        d = fn()
                        if isinstance(d, dict):
                            return d
                    except Exception:
                        pass
            d = getattr(usage, "__dict__", None)
            if isinstance(d, dict) and d:
                return d
            out: dict = {}
            for k in (
                "input_tokens",
                "output_tokens",
                "prompt_tokens",
                "completion_tokens",
                "cache_creation_input_tokens",
                "cache_read_input_tokens",
            ):
                v = getattr(usage, k, None)
                if v is not None:
                    out[k] = v
            return out
        except Exception:
            return {}

    def _actual_tokens_from_response(self, response: Any, data: Any = None) -> Optional[int]:
        """Best-effort actual token count for the ROUTER success path: reads
        response.usage, else a dict response's 'usage', else the logging
        object's model_call_details['usage']. Never raises."""
        try:
            usage = getattr(response, "usage", None)
            if usage is None and isinstance(response, dict):
                usage = response.get("usage")
            if usage is None and isinstance(data, dict):
                lobj = data.get("litellm_logging_obj")
                mcd = getattr(lobj, "model_call_details", None) if lobj is not None else None
                if isinstance(mcd, dict):
                    usage = mcd.get("usage")
            if usage is None:
                return None
            return _usage_actual_tokens(self._usage_to_dict(usage))
        except Exception:
            return None

    def _actual_tokens_from_response_body(self, response_body: Any) -> Optional[int]:
        """Best-effort actual token count for the non-streaming PASSTHROUGH path:
        the anthropic response_body dict carries `usage`. Never raises."""
        try:
            if isinstance(response_body, dict):
                return _usage_actual_tokens(self._usage_to_dict(response_body.get("usage")))
            return None
        except Exception:
            return None

    async def _reconcile_tokens(self, est: Optional[int], actual: Optional[int]) -> None:
        """Best-effort convergence of the rolling budget from admit-time ESTIMATE
        to real USAGE: HINCRBY (actual - est) into the CURRENT bucket once usage
        is known. NEVER load-bearing — a no-op when token pacing is off or either
        value is missing, and it swallows every error. The delta may be negative
        (estimate over-counted); the admit Lua clamps the rolling sum at >= 0."""
        if _Cfg.MAX_TPM <= 0 or est is None or actual is None:
            return
        delta = int(actual) - int(est)
        if delta == 0:
            return
        try:
            r = await self._get_redis()
            if r is None:
                return
            bucket = _token_bucket(time.time())
            await r.hincrby(_TOKENS_KEY, str(bucket), delta)
            await r.expire(_TOKENS_KEY, 120)
        except Exception as e:
            verbose_proxy_logger.debug(
                "custom_pacing: token reconcile failed (non-load-bearing): %s", e
            )

    async def async_post_call_success_hook(self, data, user_api_key_dict, response):
        await self._release(self._extract_pace_id(data))
        # Router-path token reconciliation (best-effort; no-op when MAX_TPM==0).
        if _Cfg.MAX_TPM > 0:
            try:
                await self._reconcile_tokens(
                    self._extract_tok_est(data),
                    self._actual_tokens_from_response(response, data),
                )
            except Exception:
                pass
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


# ---------------------------------------------------------------------------
# Streaming lease release for the passthrough path.
#
# WHY A PATCH AND NOT A HOOK: litellm v1.91.0 offers no callback on the
# passthrough streaming path. Verified in the installed package:
#   * pass_through_endpoints.py:1075 and :1134 both `return StreamingResponse(
#     PassThroughStreamingHandler.chunk_processor(...))` — the
#     post_call_success_hook call at :1175 is unreachable for streams.
#   * async_post_call_streaming_hook / async_post_call_streaming_iterator_hook
#     are only ever invoked from proxy/common_request_processing.py:2465 and
#     :2476, i.e. the managed /chat/completions + /v1/messages request
#     processor — never from the passthrough router.
# chunk_processor's own `finally:` is litellm's own chosen terminal point for
# the same reason (it is where they schedule spend logging so a client
# disconnect still records usage). We attach the lease release to that same
# guaranteed point. Claude Code always streams, so before this every agent
# request leaked its lease and only ever aged out by TTL.
#
# Terminal outcomes covered by the wrapper's `finally`:
#   success (generator exhausts) / client disconnect (GeneratorExit raised
#   into the generator by starlette) / upstream or parse exception.
# Not covered: upstream failing BEFORE the StreamingResponse is constructed
# (raise_for_status at :1057/:1126) — that raises out to the outer handler,
# which calls post_call_failure_hook at :1367 with a payload carrying
# litellm_logging_obj, so async_post_call_failure_hook releases it. And a
# proxy crash mid-stream, which is what LEASE_TTL_S remains a backstop for.
#
# The patch is install-once, fails open (any error leaves litellm untouched),
# and never changes the bytes yielded to the client.
#
# TOKEN RECONCILIATION IS DELIBERATELY NOT DONE HERE. The streaming wrapper is
# left untouched by PACE_MAX_TPM: parsing SSE to recover the terminal usage
# block would mean buffering/inspecting the client's byte stream, which this
# wrapper is expressly forbidden from doing (it must be byte-transparent). So a
# STREAMED request keeps its admit-time ESTIMATE in the budget forever — never
# reconciled to actuals. That is an accepted, bounded imprecision: the estimate
# is conservative, the budget is a rolling smoother (not an accountant), and the
# non-streaming + router paths (which CAN see usage cheaply) do reconcile.
# ---------------------------------------------------------------------------

_PATCH_FLAG = "_switchroom_pace_patched"


def _install_streaming_release_patch() -> bool:
    try:
        from litellm.proxy.pass_through_endpoints.streaming_handler import (
            PassThroughStreamingHandler,
        )
    except Exception as e:  # pragma: no cover - version drift
        verbose_proxy_logger.error(
            "custom_pacing: cannot import PassThroughStreamingHandler — streaming "
            "leases will only expire by TTL (%ss). Error: %s",
            _Cfg.LEASE_TTL_S,
            e,
        )
        return False

    original = getattr(PassThroughStreamingHandler, "chunk_processor", None)
    if original is None:
        verbose_proxy_logger.error(
            "custom_pacing: PassThroughStreamingHandler.chunk_processor missing — "
            "streaming leases will only expire by TTL (%ss).",
            _Cfg.LEASE_TTL_S,
        )
        return False
    if getattr(original, _PATCH_FLAG, False):
        return True  # already installed (module re-imported)

    async def _paced_chunk_processor(*args, **kwargs):
        pace_id: Optional[str] = None
        try:
            # Call site uses keywords exclusively (pass_through_endpoints.py
            # :1076-1084, :1135-1143); positional is handled defensively.
            lobj = kwargs.get("litellm_logging_obj")
            if lobj is None and len(args) >= 3:
                lobj = args[2]
            pace_id = FleetPacer._pace_id_from_logging_obj(lobj)
            if pace_id is None:
                body = kwargs.get("request_body")
                if body is None and len(args) >= 2:
                    body = args[1]
                pace_id = pacer_instance._extract_pace_id(body)
        except Exception as e:
            verbose_proxy_logger.debug(
                "custom_pacing: stream pace_id lookup failed: %s", e
            )

        try:
            async for chunk in original(*args, **kwargs):
                yield chunk
        finally:
            # Runs on success, GeneratorExit (client disconnect) and
            # exception. Scheduled rather than awaited so stream teardown
            # never blocks on Redis; release itself is idempotent.
            try:
                pacer_instance._release_soon(pace_id)
            except Exception:
                pass

    setattr(_paced_chunk_processor, _PATCH_FLAG, True)
    setattr(_paced_chunk_processor, "__wrapped__", original)
    PassThroughStreamingHandler.chunk_processor = staticmethod(_paced_chunk_processor)
    verbose_proxy_logger.info(
        "custom_pacing: streaming lease-release patch installed on "
        "PassThroughStreamingHandler.chunk_processor"
    )
    return True


def _install_streaming_release_patch_safe() -> bool:
    """Import-time invocation must be TOTAL: this module is imported by the
    proxy at startup, so an unexpected throw in here (a litellm layout change,
    a logger without .error) would take the whole proxy down rather than
    degrade to the TTL backstop."""
    try:
        return _install_streaming_release_patch()
    except Exception:
        return False


_STREAMING_PATCH_OK = _install_streaming_release_patch_safe()


# ---------------------------------------------------------------------------
# Non-streaming passthrough release.
#
# The non-streaming passthrough path DOES reach a post_call_success_hook call
# site (pass_through_endpoints.py:1175) — but it is nested inside
# `if response_body is not None and guardrails_to_run:` at :1160. With no
# passthrough guardrails configured (our case) the hook never runs, so the
# non-streaming leases leaked too. Measured on a throwaway proxy: 10
# non-streaming /anthropic requests left 10 leases held.
#
# The one thing that IS unconditional on every non-streaming passthrough
# success is the enqueue of
# PassThroughEndpointLogging.pass_through_async_success_handler at :1252,
# which receives the same logging object we pinned the lease id to. We wrap it
# the same way. Failures on this path still go to post_call_failure_hook.
#
# Residual gap (documented, TTL-covered): if GLOBAL_LOGGING_WORKER ever drops
# the enqueued coroutine, that lease falls back to LEASE_TTL_S. That is the
# same reliability litellm itself accepts for spend logging on this path.
# ---------------------------------------------------------------------------


def _install_nonstreaming_release_patch() -> bool:
    try:
        from litellm.proxy.pass_through_endpoints.success_handler import (
            PassThroughEndpointLogging,
        )
    except Exception as e:  # pragma: no cover - version drift
        verbose_proxy_logger.error(
            "custom_pacing: cannot import PassThroughEndpointLogging — non-streaming "
            "leases will only expire by TTL (%ss). Error: %s",
            _Cfg.LEASE_TTL_S,
            e,
        )
        return False

    original = getattr(
        PassThroughEndpointLogging, "pass_through_async_success_handler", None
    )
    if original is None or getattr(original, _PATCH_FLAG, False):
        return original is not None

    async def _paced_success_handler(self, *args, **kwargs):
        pace_id: Optional[str] = None
        est: Optional[int] = None
        actual: Optional[int] = None
        try:
            lobj = kwargs.get("logging_obj")
            pace_id = FleetPacer._pace_id_from_logging_obj(lobj)
            if pace_id is None:
                pace_id = pacer_instance._extract_pace_id(kwargs.get("request_body"))
            # Token reconciliation inputs (only when the budget is active). The
            # non-streaming passthrough success handler is called with keywords
            # (success_handler.py) but positional is handled defensively, the
            # same way the streaming wrapper reads its lobj/body.
            if _Cfg.MAX_TPM > 0:
                est = FleetPacer._tok_est_from_logging_obj(lobj)
                if est is None:
                    est = pacer_instance._extract_tok_est(kwargs.get("request_body"))
                response_body = kwargs.get("response_body")
                if response_body is None and len(args) >= 2:
                    response_body = args[1]
                actual = pacer_instance._actual_tokens_from_response_body(response_body)
        except Exception as e:
            verbose_proxy_logger.debug(
                "custom_pacing: non-stream pace_id lookup failed: %s", e
            )
        try:
            return await original(self, *args, **kwargs)
        finally:
            try:
                await pacer_instance._release(pace_id)
            except Exception:
                pacer_instance._release_soon(pace_id)
            if _Cfg.MAX_TPM > 0:
                try:
                    await pacer_instance._reconcile_tokens(est, actual)
                except Exception:
                    pass

    setattr(_paced_success_handler, _PATCH_FLAG, True)
    setattr(_paced_success_handler, "__wrapped__", original)
    PassThroughEndpointLogging.pass_through_async_success_handler = (
        _paced_success_handler
    )
    verbose_proxy_logger.info(
        "custom_pacing: non-streaming lease-release patch installed on "
        "PassThroughEndpointLogging.pass_through_async_success_handler"
    )
    return True


def _install_nonstreaming_release_patch_safe() -> bool:
    """Total for the same reason as the streaming sibling above."""
    try:
        return _install_nonstreaming_release_patch()
    except Exception:
        return False


_NONSTREAMING_PATCH_OK = _install_nonstreaming_release_patch_safe()
