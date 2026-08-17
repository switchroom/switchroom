#!/usr/bin/env python3
"""Auto-recall hook for UserPromptSubmit.

Port of: before_prompt_build handler in Openclaw index.js
Adapted for Claude Code hooks (ephemeral process, JSON stdin/stdout).

Flow:
  1. Read hook input from stdin (prompt, session_id, transcript_path, cwd)
  2. (switchroom #424 4.1) Check per-session recall cache; on hit, emit
     cached output and skip the API round-trip.
  3. Resolve API URL (external, existing local, or auto-start daemon)
  4. Derive bank ID (static or dynamic from project context)
  5. Ensure bank mission is set (first use only)
  6. Compose multi-turn query if recallContextTurns > 1
  7. Truncate to recallMaxQueryChars
  8. Call Hindsight recall API
  9. Format memories and output hookSpecificOutput.additionalContext
 10. Persist to per-session cache for the next prompt-equal invocation.
 11. Save last recall to state (for PostCompact re-injection)

Exit codes:
  0 — normal success (incl. graceful in-flight errors like recall API
      timeouts where we still produce a valid hookSpecificOutput).
  0 — uncaught exception in non-debug mode. Switchroom #1070 (redo,
      after #1085 review): recall.py is registered as a DIRECT Claude
      Code plugin hook (`vendor/hindsight-memory/hooks/hooks.json`),
      NOT wrapped by `bin/run-hook.sh`. Per Claude Code's
      UserPromptSubmit hook contract, exit 2 BLOCKS the user's
      prompt and surfaces stderr to the user — so a hindsight outage
      would block every turn. We instead exit 0 (agent prompt
      assembly proceeds with no memories), emit a bounded stderr
      line for journald, and shell out directly to `switchroom
      issues record` so the #424 issue-sink still captures the
      failure on the operator's issues card. The subprocess call
      is fault-tolerant — if it fails for any reason, we still
      exit 0 with the safe stdout shape.
  2 — debug mode any error. HINDSIGHT_DEBUG=1 operators are
      live-debugging and want maximum signal — full traceback to
      stderr and non-zero exit. Existing behaviour.
"""

import time

# Taken before anything else is imported, so `_IMPORT_ELAPSED_SECONDS` below
# captures the real cost of loading this hook's dependencies. That spend is
# charged against the UserPromptSubmit ceiling (see `HOOK_CEILING_SECONDS`) —
# `recall_start_monotonic` is taken well into main() and cannot see it.
_IMPORT_START_MONOTONIC = time.monotonic()

import hashlib  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import re  # noqa: E402
import socket  # noqa: E402
import sys  # noqa: E402
import urllib.error  # noqa: E402
from datetime import datetime  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib.bank import derive_bank_id, ensure_bank_mission
from lib.client import HindsightClient
from lib.config import debug_log, filter_recall_types, load_config
from lib.content import (
    _extract_text_content,
    compose_recall_query,
    format_current_time,
    format_memories,
    shape_recall_query,
    strip_channel_envelope,
    strip_memory_tags,
    tokenize_for_bm25,
    truncate_recall_query,
)
from lib.daemon import get_api_url
from lib.directives import (
    DIRECTIVES_CACHE_TTL_SECONDS,
    count_omitted_directives,
    fetch_active_directives_cached,
    format_active_directives_block,
    injected_directive_ids,
)
from lib.gateway_ipc import extract_chat_id_from_prompt, extract_topic_from_prompt, extract_user_from_prompt, update_placeholder
from lib.parallel_recall import run_parallel
from lib import recall_buffer
from lib.state import read_state, write_state

# Cost of everything above, charged against the hook ceiling (see
# `HOOK_CEILING_SECONDS`). Measured, not estimated: it is dominated by
# `lib.client` pulling in urllib/ssl and by `lib.content` on cold page cache.
_IMPORT_ELAPSED_SECONDS = time.monotonic() - _IMPORT_START_MONOTONIC

LAST_RECALL_STATE = "last_recall.json"
RECALL_CACHE_STATE = "recall_cache.json"

# Switchroom hindsight-leverage A3 — label for the directives fetch slot in the
# parallel fan-out. Distinct from any bank_id (banks can't start with "__") so a
# bank named "directives" never collides with the directives slot.
DIRECTIVES_SLOT = "__directives__"

# Switchroom #424 phase 4.1 — per-session recall cache.
#
# Caching is opt-in via env var: HINDSIGHT_RECALL_CACHE_TTL_SECS=N. Set N
# to 0 (or leave unset) to disable. On hit, the script emits the cached
# `additionalContext` and skips the directive + recall API round-trips
# entirely.
#
# Hits fire when (session_id, prompt, bank_id, extra_banks) match a
# prior entry within the TTL. Cache entries are scoped to a single
# session_id — a new session (e.g. agent restart, /reset, /new) starts
# a fresh cache window even if the env-configured TTL hasn't elapsed.
#
# The expected hit rate in production is modest (real users don't
# typically resubmit identical prompts), but this trims redundant
# recall traffic on session-resume re-processing and any retry paths.
CACHE_ENV = "HINDSIGHT_RECALL_CACHE_TTL_SECS"

# Maximum number of cache entries kept per session before LRU eviction.
# 100 is comfortably above the typical session size (~30 inbounds) and
# well below any concern about state-file size growth.
CACHE_MAX_ENTRIES = 100

# Switchroom #432 phase 4.4 — demote-from-recall tag.
#
# A memory tagged with any of these strings stays in the bank (it can
# still surface via reflect, manual mcp__hindsight__recall, etc.) but is
# excluded from the auto-recall block injected on every UserPromptSubmit.
# Useful when an over-broad "world fact" memory keeps drowning out more
# relevant recent memories.
DEMOTE_TAG_VARIANTS = (
    "[demote-from-recall]",
    "demote-from-recall",
    "no-recall",
)

# Switchroom PR6 — supergroup-mode topic filter mode.
#
# Controls how memories from OTHER topics are surfaced to the model
# during recall. Default is "soft-preamble": all topic-tagged memories
# are returned (the model decides relevance via the preamble that names
# the active topic). "hard-filter" drops any memory whose stored
# `metadata.thread_id` doesn't match the active prompt's thread_id —
# the escape hatch if instrumentation shows binding failures (model
# applying the right memory to the wrong topic).
#
# The mode is process-wide via env var. Memories with no thread_id
# tag (legacy retains pre-PR6, or fleet-shared/DM agents) are NEVER
# dropped — they pass through both modes regardless of active topic.
TOPIC_FILTER_MODE_ENV = "HINDSIGHT_TOPIC_FILTER_MODE"
TOPIC_FILTER_MODES = ("soft-preamble", "hard-filter")


def _topic_filter_mode() -> str:
    raw = os.environ.get(TOPIC_FILTER_MODE_ENV, "").strip().lower()
    if raw in TOPIC_FILTER_MODES:
        return raw
    return "soft-preamble"


def _filter_by_active_topic(results: list, active_thread_id: str | None) -> tuple[list, int]:
    """When hard-filter mode is on AND we know the active thread, drop
    any memory whose stored metadata.thread_id is set to a different
    value. Untagged memories pass through unconditionally.

    Returns (filtered_results, dropped_count).
    """
    if active_thread_id is None:
        return results, 0
    kept: list = []
    dropped = 0
    for m in results:
        meta = m.get("metadata") if isinstance(m, dict) else None
        if not isinstance(meta, dict):
            kept.append(m)
            continue
        source_thread = meta.get("thread_id")
        if source_thread is None or str(source_thread) == str(active_thread_id):
            kept.append(m)
        else:
            dropped += 1
    return kept, dropped


def _summarise_source_topics(results: list) -> dict:
    """Build a {thread_id: count} summary of recalled memories'
    source topics. Used for instrumented binding-failure analysis
    in the recall log.
    """
    summary: dict = {}
    for m in results:
        meta = m.get("metadata") if isinstance(m, dict) else None
        if not isinstance(meta, dict):
            summary["__untagged__"] = summary.get("__untagged__", 0) + 1
            continue
        tid = meta.get("thread_id")
        key = str(tid) if tid is not None else "__no_thread__"
        summary[key] = summary.get(key, 0) + 1
    return summary

# Switchroom #432 phase 4.3 — recall telemetry log.
#
# Every recall (cache hit or miss) appends a JSONL record to
# state/recall_log.jsonl: timestamp, session_id, bank, count, capped flag,
# memory IDs. The file is bounded by RECALL_LOG_MAX_LINES so it stays
# under a few MB even on chatty 24/7 agents. View via
# `switchroom memory recall-log <agent>`.
RECALL_LOG_FILE = "recall_log.jsonl"
RECALL_LOG_MAX_LINES = 5000
# Honest per-line upper-bound estimate for the size-gated trim (hindsight-
# leverage PR 1, review finding 5). The A3-telemetry row (bounded query
# excerpt ≤200 chars + bank_timings + memory_ids) runs ~700-900 bytes worst
# case; 1024 is a safe upper bound. The size gate only reads+trims the file
# when it plausibly exceeds the line cap, so it must OVER-estimate row size
# (threshold = cap × upper-bound) — otherwise a file over the old 250 B/line
# threshold but still under the line cap triggers a full-file read on every
# hook (critical-path thrash) that never actually trims.
RECALL_LOG_BYTES_PER_LINE_EST = 1024


def _cache_ttl_secs() -> int:
    """Read the recall-cache TTL from env. Returns 0 (disabled) on any
    parse error or sub-zero value — caller treats 0 as "skip cache."""
    raw = os.environ.get(CACHE_ENV, "").strip()
    if not raw:
        return 0
    try:
        n = int(raw)
        return n if n > 0 else 0
    except ValueError:
        return 0


def _normalize_sender(sender: str) -> str:
    """Drop a single leading '@'. The gateway emits a bare username
    (`from.username`), but operators naturally write `@handle` in config —
    normalizing both sides lets either form match."""
    return sender[1:] if sender.startswith("@") else sender


def _resolve_sender_bank(
    sender_banks_json: str,
    active_sender: str | None,
    bank_id: str,
    additional_banks: list,
) -> list:
    """Per-speaker memory routing: if `active_sender` maps to a bank in the
    HINDSIGHT_SENDER_BANKS_JSON map, return ``additional_banks`` with that
    bank appended (additive — skips dup/self). A leading '@' on either the
    map keys or the sender is normalized away, so ``@lisa``, ``lisa``, and
    the gateway's bare-emitted ``lisa`` all resolve together. Failure-safe:
    any bad input (missing sender/env, non-dict JSON, decode error) returns
    ``additional_banks`` unchanged. Never replaces the agent's own bank and
    never touches auth — additive recall scoping only (single-tenant).
    """
    if not active_sender or not sender_banks_json:
        return additional_banks
    try:
        sender_banks = json.loads(sender_banks_json)
    except (json.JSONDecodeError, ValueError, TypeError):
        return additional_banks
    if not isinstance(sender_banks, dict):
        return additional_banks
    normalized = {_normalize_sender(str(k)): v for k, v in sender_banks.items()}
    sender_bank = normalized.get(_normalize_sender(active_sender))
    if (
        sender_bank
        and sender_bank != bank_id
        and sender_bank not in additional_banks
    ):
        return [*additional_banks, sender_bank]
    return additional_banks


def _tag_filter_sig(
    recall_tags,
    tags_match,
    tag_groups,
    additional_bank_filters,
) -> str:
    """Stable fingerprint of the recall tag-filter configuration
    (upstream 962140eef) for cache keying. Tag filters change what the
    recall API returns for an identical query, so they MUST be part of
    the cache key — otherwise a config change (or per-bank filter edit)
    within the TTL window would serve stale, differently-filtered
    results. Empty/default filters collapse to "" so pre-existing cache
    behaviour (and keys) are unchanged when the feature is unused."""
    if not (recall_tags or tag_groups or additional_bank_filters):
        return ""
    try:
        return json.dumps(
            [recall_tags, tags_match, tag_groups, additional_bank_filters],
            sort_keys=True,
            separators=(",", ":"),
        )
    except (TypeError, ValueError):
        # Unserializable config — fall back to repr; stable within a
        # process and still distinguishes filtered from unfiltered.
        return repr([recall_tags, tags_match, tag_groups, additional_bank_filters])


def _cache_key(
    session_id: str,
    prompt: str,
    bank_id: str,
    extra_banks: list,
    active_thread_id: str | None = None,
    active_sender: str | None = None,
    tag_filter_sig: str = "",
) -> str:
    """Stable hash for cache keying. Session_id is included so a new
    session always misses, regardless of the TTL setting. Extra banks
    are sorted so list-order doesn't change the key.

    PR6a: `active_thread_id` is included so cross-topic prompts in
    supergroup mode (same session, same model, same prompt verbatim
    but different topic) don't collide on the cache. Empty/None
    collapses to the empty string — backward-compatible for
    fleet-shared / DM agents where no thread_id is present.

    Switchroom (per-speaker routing): `active_sender` is included for the
    same reason — in a multi-user session two speakers sending the same
    prompt resolve to different recall banks, so the sender must be part of
    the key or one speaker's recall would be served to the other.
    """
    parts = [
        session_id or "",
        prompt or "",
        bank_id or "",
        ",".join(sorted(extra_banks or [])),
        active_thread_id or "",
        active_sender or "",
        # Upstream 962140eef port: tag filters shape the result set, so
        # they are part of the key (see _tag_filter_sig). "" when unused.
        tag_filter_sig or "",
    ]
    payload = "\x1f".join(parts)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _cache_lookup(key: str, ttl_secs: int) -> str | None:
    """Return the cached `additionalContext` for `key` if present and
    within TTL, else None. Failure-tolerant — any read error returns
    None and the caller falls through to a fresh recall."""
    if ttl_secs <= 0:
        return None
    state = read_state(RECALL_CACHE_STATE, {}) or {}
    entries = state.get("entries") or {}
    entry = entries.get(key)
    if not isinstance(entry, dict):
        return None
    saved_at = entry.get("saved_at")
    context = entry.get("context")
    if not isinstance(saved_at, (int, float)) or not isinstance(context, str):
        return None
    if time.time() - saved_at > ttl_secs:
        return None
    return context


def _cache_store(key: str, context: str) -> None:
    """Write a cache entry. LRU-evicts the oldest entry when exceeding
    CACHE_MAX_ENTRIES so the file stays bounded. Failure-tolerant."""
    state = read_state(RECALL_CACHE_STATE, {}) or {}
    entries = state.get("entries") or {}
    if not isinstance(entries, dict):
        entries = {}
    entries[key] = {
        "context": context,
        "saved_at": time.time(),
    }
    if len(entries) > CACHE_MAX_ENTRIES:
        # LRU evict by saved_at ascending.
        sorted_keys = sorted(
            entries.keys(),
            key=lambda k: entries[k].get("saved_at") if isinstance(entries[k], dict) else 0,
        )
        for k in sorted_keys[: len(entries) - CACHE_MAX_ENTRIES]:
            entries.pop(k, None)
    state["entries"] = entries
    state["updated_at"] = time.time()
    write_state(RECALL_CACHE_STATE, state)


def _emit_cached_context(context: str) -> None:
    """Emit the same hookSpecificOutput shape that the fresh-recall
    path emits, so the cached path is byte-equivalent from claude
    code's perspective."""
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": context,
            }
        },
        sys.stdout,
    )


_PREFETCH_DEGRADED_NOTICE = (
    "⏳ prefetch not ready and no prior recall is cached for this session — "
    "proceeding without injected memory this turn."
)


def stale_recall_notice(memories_context: str) -> str:
    """Wrap a PRIOR turn's cached memories-only block in an explicit
    staleness marker for the M4 prefetch-buffer fallback path.

    M4 P-REC Fix B (red-team BINDING, MUST NOT regress): `memories_context`
    must NEVER contain a directives block — the caller is required to pass
    `LAST_RECALL_STATE`'s `memories_context` field (directives-free by
    construction, see the write site near `context_message`), never its
    sibling `context` field (which bundles `directives_block`). Directives
    stay on the synchronous, always-current fetch path only (M3's
    directive-decoupling rule) — a stale directives block re-injected from a
    prior turn could resurrect a rule the user rescinded moments ago.
    """
    if not memories_context:
        return ""
    return (
        "⏳ stale (prefetch not ready this turn) — the memories below are "
        "from the PREVIOUS turn's recall, not this turn's. Treat them as a "
        "hint, not a confirmed current fact.\n\n" + memories_context
    )


def _handle_prefetch_buffer(config: dict, hook_input: dict, prompt: str) -> bool:
    """M4 P-REC Fix C (consumer side) — join the Stop-hook producer's
    prefetch buffer for this session instead of running recall
    synchronously.

    Gated entirely by `config.get("memoryPrefetchEnabled", False)` at the
    caller; this function assumes the flag is already on. Returns True iff
    it emitted an `additionalContext` payload (fresh hit, stale fallback, or
    the explicit degraded notice) and the caller should return without
    running the synchronous path. Returns False on a clean no-op miss (flag
    effectively off / nothing to say) so the caller falls through.

    Never raises past this function's own boundary in normal operation —
    every internal step is wrapped so a bug here degrades to "fall through
    to synchronous recall", never a broken turn. (The caller additionally
    wraps this call in its own try/except as defence in depth.)
    """
    session_id = hook_input.get("session_id") or "unknown"

    # Cold-start short-circuit (red-team MAJOR finding): if this session has
    # NEVER produced a sentinel, polling the full cap on every single
    # session-open turn would cost ~the poll cap on every fresh session —
    # the opposite of M4's latency goal. Only poll when a sentinel already
    # exists (a producer has run at least once for this session).
    if not recall_buffer.sentinel_exists(session_id):
        debug_log(config, "Prefetch buffer: no sentinel ever written for this session, cold-start skip")
    else:
        cap_ms = int(config.get("memoryPrefetchPollCapMs", 400))
        recall_buffer.poll_for_sentinel(session_id, last_consumed_token=None, cap_ms=cap_ms)

    payload, _token = recall_buffer.read_if_fresh(session_id, last_consumed_token=None)

    # Directives stay on the synchronous, always-fresh path (M3 rule) even
    # in the fast path — fetched here directly, never from the buffer.
    directives_block = None
    try:
        bank_id = derive_bank_id(hook_input, config)
        api_url = get_api_url(config)
        client = HindsightClient(api_url)
        directives = fetch_active_directives_cached(
            client, bank_id, ttl_seconds=config.get("directivesCacheTtlSeconds", DIRECTIVES_CACHE_TTL_SECONDS)
        )
        directives_block = format_active_directives_block(directives) if directives else None
    except Exception as exc:  # pragma: no cover - defensive, directives are best-effort here
        debug_log(config, f"Prefetch buffer: directive fetch failed: {exc}")
        directives_block = None

    if payload is not None:
        memories_block = payload.get("context") or ""
        parts = [b for b in (directives_block, memories_block) if b]
        if not parts:
            return False
        _emit_cached_context("\n\n".join(parts))
        return True

    # Miss: no fresh buffer. Fall back to the LAST_RECALL_STATE's
    # directives-FREE `memories_context` field (Fix B) if one exists for
    # this session, explicitly marked stale. Never `context` (directive-
    # contaminated).
    last = read_state(LAST_RECALL_STATE) or {}
    stale_memories = last.get("memories_context") or ""
    stale_block = stale_recall_notice(stale_memories)
    parts = [b for b in (directives_block, stale_block) if b]
    if parts:
        _emit_cached_context("\n\n".join(parts))
        return True

    if directives_block:
        _emit_cached_context(directives_block)
        return True

    # Nothing fresh, nothing stale, nothing cached — say so explicitly
    # rather than silently emitting no context (so a degraded turn is
    # legible, matching the #3619 degraded-disclosure precedent).
    _emit_cached_context(_PREFETCH_DEGRADED_NOTICE)
    return True


def _emit_directives_only(config: dict, hook_input: dict) -> None:
    """#4756 F2 — directive exemption for the task-notification junk gate.

    The M4 P-REC junk gate skips synchronous recall on synthetic
    `<task-notification>` turns to avoid burning latency/cost on
    machine-generated noise. But DIRECTIVES are the one memory class that must
    survive that gate: an agent's standing rules apply on EVERY turn, synthetic
    or not, and suppressing them on a sub-agent-handback turn is a behavior
    change that should not ride along with the noise gate. So the gate drops
    the non-directive classes (observations/world/etc. — the whole `recall`
    result set) but still fetches and injects the active directives block,
    exactly as the prefetch fast path does (M3 directive-decoupling rule).

    Emits nothing when the bank has no active directives (no empty wrapper).
    Failure-safe: any error → emit nothing rather than break the turn, matching
    `fetch_active_directives_cached`'s never-raise contract. Deliberately does
    NOT run the memory `recall` HTTP call — only `list_directives` is touched.
    """
    try:
        bank_id = derive_bank_id(hook_input, config)
        api_url = get_api_url(config)
        client = HindsightClient(api_url, config.get("hindsightApiToken"))
        directives = fetch_active_directives_cached(
            client,
            bank_id,
            ttl_seconds=config.get("directivesCacheTtlSeconds", DIRECTIVES_CACHE_TTL_SECONDS),
        )
        directives_block = format_active_directives_block(directives) if directives else None
    except Exception as exc:  # pragma: no cover - defensive, directives are best-effort here
        debug_log(config, f"Task-notification skip: directive fetch failed: {exc}")
        return

    if directives_block:
        _emit_cached_context(directives_block)


def _is_demoted_memory(memory) -> bool:
    """Return True if the memory has any demote-from-recall tag.

    Switchroom #432 phase 4.4. Tags are case-sensitive and can be
    written with or without surrounding brackets (`[demote-from-recall]`
    or `demote-from-recall` or `no-recall`). Anything that's not a list
    of strings is treated as untagged.
    """
    tags = memory.get("tags") if isinstance(memory, dict) else None
    if not isinstance(tags, list):
        return False
    for tag in tags:
        if isinstance(tag, str) and tag.strip() in DEMOTE_TAG_VARIANTS:
            return True
    return False


# Tokenizer shared by the transcript fallback (`_build_transcript_fallback`).
#
# --- history: the removed lexical-overlap recall gate (#475, #3541, #3761) ---
#
# These tokens used to feed a `recallMinOverlap` gate that ran between the
# engine's reranker and the `recallMaxMemories` head-slice, dropping any
# candidate whose containment overlap with the prompt fell below a threshold.
# It was removed outright — no replacement floor — after measurement showed it
# was pure loss:
#
#   * On healthy production rows (non-timeout, non-error, ts >= 2026-07-20,
#     n=212 across the fleet) it discarded 6026 of 7549 post-reranker
#     candidates — 79.8% fleet-wide, 94.4% for overlord, 91.0% for klanker.
#   * Replaying 330 real logged queries against the live engine, the gate
#     dropped the engine's OWN top-ranked candidate on 31.2% of queries. It
#     was not acting as a floor; it was acting as a rival, worse ranker.
#   * It filtered no measurable noise. The rate at which the best injected
#     memory scored below 1e-3 was 27.0% with the gate and 28.2% with no gate
#     at all — inside sampling noise. It cost a third of top hits and bought
#     nothing.
#
# The root cause is in the tokenizer below: it keeps only alphabetic tokens of
# length > 1, so digits, identifiers, version numbers, PR numbers, file paths
# and short symbols are invisible to it. For a fleet whose prompts are mostly
# identifiers that is close to worst case.
#
# No score floor replaced it. `scores.final` is NOT calibrated across queries —
# the engine's own docs state a clearly-relevant match may score ~0.001 while
# ranked first, and freed slots are not backfilled. Measured over the same 330
# replays, every candidate floor value had `top1lost% == zero%` exactly: a
# floor never trims a bad tail, it only empties the whole result set. A floor
# at 0.001 would take zero-result recalls from 5.8% to 28.2%; at 0.05, to
# 40.6%. That re-creates #3541. `min_scores` is deliberately left unset.
#
# Precision now rests where it belongs: the engine's rerank ordering, the
# `_sort_by_final_score` merge sort, and the `recallMaxMemories` head-slice.
#
# A small English stop-word set is removed from both sides before the
# overlap is computed — common-word coincidence is not a real signal.
# Token comparison is case-insensitive and strips punctuation. The set
# is intentionally tight; we'd rather miss a borderline drop than
# silently throw out a real match.
_OVERLAP_STOPWORDS = frozenset({
    "a", "an", "and", "any", "are", "as", "at",
    "be", "been", "being", "but", "by",
    "can", "could", "did", "do", "does", "doing",
    "for", "from",
    "had", "has", "have", "having", "how",
    "i", "if", "in", "into", "is", "it", "its",
    "me", "my",
    "of", "on", "one", "or",
    "should", "so",
    "that", "the", "their", "them", "then", "there", "these", "they",
    "this", "to",
    "was", "we", "were", "what", "when", "where", "which", "who",
    "why", "will", "with", "would", "you", "your",
})


def _overlap_tokens(text) -> set:
    """Tokenize text into a stop-word-stripped, lowercased set of terms.

    Tokens are maximal runs of ALPHANUMERIC characters (``str.isalnum``);
    everything else (whitespace, punctuation) is a separator. Short fragments
    (<= 1 char) and stop-words are dropped. Returns an empty set on non-string /
    empty input.

    #3578 — DIGITS CARRY SIGNAL. This fallback tokenizer feeds the #3369
    transcript-grep fallback's keyword match (``_build_transcript_fallback``):
    a recent transcript turn is kept only if it shares a token with the recall
    query. This fleet talks in identifiers — "did PR 3993 land", "the :9077
    port", "v0.19.24" — and the previous ``ch.isalpha()`` accumulation dropped
    every digit on the floor, so a turn whose ONLY tie to the query was the
    issue number '3993' shared no token and was filtered out. Accumulating
    ``isalnum`` runs keeps pure-digit and mixed identifiers ('3993', '9077',
    'v0') as tokens, so issue numbers, ports and versions match symmetrically on
    both the query and transcript sides. A lone digit (a bare '9') is still
    dropped by the ``> 1`` length guard, same as a lone letter — it is noise, not
    an identifier. See ``tests/test_overlap_tokens.py`` for the characterisation.
    """
    if not isinstance(text, str) or not text:
        return set()
    out = set()
    cur = []
    for ch in text:
        if ch.isalnum():
            cur.append(ch.lower())
        else:
            if cur:
                tok = "".join(cur)
                if len(tok) > 1 and tok not in _OVERLAP_STOPWORDS:
                    out.add(tok)
                cur = []
    if cur:
        tok = "".join(cur)
        if len(tok) > 1 and tok not in _OVERLAP_STOPWORDS:
            out.add(tok)
    return out


def _result_final_score(m) -> float:
    """Return a result's engine relevance score (`scores.final`).

    Switchroom Phase-1 precision. The Hindsight recall response attaches a
    `scores` object to every result whose required `final` field is the
    engine's combined ranking score (reranker + recency/temporal/proof
    boosts). Results missing a usable score sort last so a malformed or
    score-less entry can never starve a properly-ranked one.
    """
    if isinstance(m, dict):
        scores = m.get("scores")
        if isinstance(scores, dict):
            val = scores.get("final")
            if isinstance(val, (int, float)) and not isinstance(val, bool):
                return float(val)
    return float("-inf")


def _injected_score_stats(results) -> dict:
    """Relevance-score aggregates for the INJECTED set (post-head-slice).

    Switchroom #3541 review finding — recall-quality telemetry.
    `recall_log.jsonl` records volume and plumbing only (`capped`,
    `pre_cap_count`, `memory_ids`, `deadline_hit`). With the lexical overlap
    gate removed (#3761) 100% of precision rests on the engine's
    `scores.final` plus the `recallMaxMemories` head-slice — and no volume
    field observes that. `result_count` rising to the cap reads as
    unambiguous success on every existing dashboard whether the reranker is
    good OR whether every agent is being fed 8 mediocre memories per turn.
    These three fields are what distinguishes those two worlds.

    Returns ``{"injected_score_min", "injected_score_median",
    "injected_score_max"}``. Values are floats rounded to 4dp, or None when
    the set is empty or no result carried a usable score (results missing
    `scores.final` are excluded rather than counted as a sentinel, so a
    single malformed entry cannot drag the aggregate).

    Aggregates ONLY — no query text and no memory text is recorded here.

    READING THESE ACROSS THE CE-DAMPING ROLLOUT (#3579). `scores.final` is the
    engine's `combined_score`, and #3579 changes how that number is composed:
    ``CE * boost`` becomes ``CE * boost**k`` with k ≈ 0.0395 at the engine's
    default alphas. So these three fields SHIFT ON DEPLOY as a scale artifact,
    not as a quality change. Measured against the pinned upstream image on a
    saturated 100-result band (CE 0.9800-0.9999), the injected top-8 moved from
    min/median/max 1.0822/1.0843/1.1136 (spread 0.0314) to 0.9977/0.9979/0.9981
    (spread 0.0004): the level drops ~8% and the spread collapses ~78x as
    combined_score converges onto the raw cross-encoder score. Two consequences:

      * Any threshold or dashboard band calibrated on pre-#3579 data is invalid
        afterwards, and a before/after comparison across the deploy boundary
        measures the rescale, not recall quality. Re-baseline after rollout.
      * These aggregates are PERMUTATION-INVARIANT over the injected set, so
        they cannot see a pure re-ordering of the head-slice - which is exactly
        what #3579 does. They move only when the head-slice MEMBERSHIP changes
        (in the measured band it changed completely: 0 of 8 ids in common).
        Membership churn is therefore the signal to watch, not the level.

    Setting `HINDSIGHT_CE_DECISIVE_RELATIVE_GAP` at or above ~0.651 clamps k to
    1.0 and restores the pre-#3579 scale exactly, which is also how to get a
    like-for-like reading back.
    """
    empty = {
        "injected_score_min": None,
        "injected_score_median": None,
        "injected_score_max": None,
    }
    try:
        scores = [s for s in (_result_final_score(m) for m in results or []) if s != float("-inf")]
        if not scores:
            return empty
        scores.sort()
        n = len(scores)
        mid = n // 2
        median = scores[mid] if n % 2 else (scores[mid - 1] + scores[mid]) / 2.0
        return {
            "injected_score_min": round(scores[0], 4),
            "injected_score_median": round(median, 4),
            "injected_score_max": round(scores[-1], 4),
        }
    except Exception:
        # Telemetry must never take recall down.
        return empty


# Switchroom #3837 — opt-in absolute score floor (`recallMinScore`).
#
# READ #3761 FIRST. It removed the lexical `recallMinOverlap` gate and stated
# "no replacement floor", on a 330-query replay showing that for EVERY floor
# value tested `top1lost% == zero%`: a floor at 0.001 took zero-result recalls
# from 5.8% to 28.2%, at 0.05 to 40.6%. That measurement stands and this change
# does not contradict it — which is why the floor ships DISABLED (0.0) and why
# its default scope is not "every turn".
#
# What #3761 did not separate is the CONDITION of the bank read. Measured
# fleet-wide from `recall_log.jsonl` on 2026-07-27 and recorded independently
# in `src/hindsight-watch/thresholds.ts` (RECALL_SCORE_P50_PAGE):
#
#   own bank HEALTHY  (n=74)   p50 injected_score_max 0.0850   28.4% below 0.01
#   own bank DEGRADED (n=247)  p50 injected_score_max 0.0006   98.4% below 0.01
#
# A ~140x separation in the p50, and the below-0.01 fraction separates
# 28.4% vs 98.4%. Two conclusions follow, and only the second is actionable:
#
#   * On a HEALTHY turn a low `scores.final` does NOT imply noise. The healthy
#     distribution is bimodal, p10 0.0005 to p90 0.9259 — the score is not
#     calibrated across queries, so 28.4% of perfectly good turns would be
#     emptied by a 0.01 floor. That is #3761's result, reproduced. A floor
#     applied unconditionally re-creates #3541.
#   * On a DEGRADED turn — the agent's own bank timed out or was unreachable,
#     so what survives is side-bank residue — 98.4% of injected sets have a
#     best score below 0.01, and the turn ALREADY carries
#     `degraded_recall_notice`. Withholding that residue costs at most the
#     1.6% tail and replaces "six memories presented as recall" with the
#     honest "recall was DEGRADED, treat absence as UNKNOWN" the agent can
#     act on. Injecting noise under the banner of recall is strictly worse
#     than injecting nothing WITH a disclosure, because the agent cannot tell
#     the two apart; injecting nothing WITHOUT a disclosure is the failure
#     mode #3619 fixed and is not re-introduced here.
#
# Hence `recallMinScoreScope`, default "degraded": when the operator sets a
# floor, it binds only on turns where the own-bank read was degraded, which is
# the population the evidence supports. "all" widens it to every turn for an
# operator who has measured their own bank and wants it — no fleet default
# recommends that today.
#
# Nothing is dropped silently. When the floor empties a non-empty set the turn
# emits `min_score_withheld_notice` (and the degraded notice too, when that
# fired), so an empty recall is never mistaken for an empty memory. Per-turn
# telemetry lands on `recall_log.jsonl` as `min_score_floor`,
# `min_score_scope`, `min_score_applied` and `dropped_below_min_score`,
# alongside the existing `injected_score_*` fields — the same instrument the
# problem was measured with, so the effect is measurable the same way.
def _filter_by_min_score(results, threshold: float):
    """Drop results whose engine score (`scores.final`) is below `threshold`.

    Returns ``(kept, dropped)``. ``threshold <= 0`` short-circuits to
    passthrough with no iteration cost, so the disabled default cannot alter
    the injected set.

    A result carrying NO usable score is KEPT, never dropped. `-inf` is the
    sentinel `_result_final_score` returns for a malformed or score-less
    entry, and "the engine gave us no score" is not evidence of irrelevance —
    dropping on it would turn a response-shape change upstream into silent
    total recall loss. Same reasoning as the sort, which parks score-less
    entries last rather than discarding them.
    """
    if threshold <= 0:
        return results, 0
    kept = []
    dropped = 0
    for m in results:
        score = _result_final_score(m)
        if score == float("-inf") or score >= threshold:
            kept.append(m)
        else:
            dropped += 1
    return kept, dropped


def min_score_withheld_notice(dropped: int, threshold: float) -> str:
    """One line telling the agent that recall HAD candidates and withheld them.

    Only meaningful when the floor emptied the injected set. The distinction
    it preserves is #3619's: "I could not retrieve anything worth trusting" is
    not "there is nothing to remember", and an agent that cannot tell those
    apart asserts the second. Kept to a single short line — this fires on an
    already-thin turn.
    """
    if dropped <= 0:
        return ""
    return (
        f"[Hindsight] Memory recall returned {dropped} candidate "
        f"{'memory' if dropped == 1 else 'memories'}, all scoring below the "
        f"configured relevance floor ({threshold:g}), so none were injected. "
        f"Treat an absence of relevant memory as UNKNOWN, not as 'nothing was "
        f"remembered'."
    )


def _sort_by_final_score(results):
    """Sort merged multi-bank results by `scores.final` descending, in place.

    Switchroom Phase-1 bank-starvation fix. The recall path appends
    additional-bank (profile / shared / sender) results after the own-bank
    results, then head-slices at `recallMaxMemories`. Before this sort, a
    full own-bank result set silently dropped every additional-bank memory
    at the cap regardless of relevance. Sorting by the engine's real
    relevance score before the cap means the cap keeps the most relevant
    memories cross-bank. Python's sort is stable, so ties preserve the
    prior own-bank-first insertion order.
    """
    results.sort(key=_result_final_score, reverse=True)
    return results


# Key stamped onto every merged result naming the bank it came from. Private to
# recall.py (leading underscore) and never rendered: `format_memories`
# (lib/content.py:294) reads only `text` / `type` / `mentioned_at`, so an extra
# key cannot leak into the injected `<hindsight_memories>` block.
SOURCE_BANK_KEY = "_source_bank"


def _tag_source_bank(bank_results, bank_id):
    """Stamp `SOURCE_BANK_KEY` onto each result so slot reservation can tell
    own-bank memories from additional-bank (profile / shared / sender) ones
    after the global relevance sort has interleaved them.

    Returns the same list. Non-dict entries are skipped rather than raising:
    a malformed engine response must not take recall down.
    """
    for m in bank_results:
        if isinstance(m, dict):
            m[SOURCE_BANK_KEY] = bank_id
    return bank_results


def _reservable_slots(cap):
    """How many of `cap` slots the per-bank floors may claim between them.

    HALF the cap, rounded down. The other half is always awarded on pure global
    relevance, and that headroom is what keeps these FLOORS rather than a fixed
    quota. Without it the mechanism silently inverts at small caps: this fleet
    runs `defaults.memory.recall.max_memories: 6` (switchroom.yaml — it cascades
    to HINDSIGHT_RECALL_MAX_MEMORIES, which wins over the 8 stamped into the
    plugin's settings.json), so floors of 4+2 would consume the entire cap,
    `scores.final` would have no influence on composition on any turn where both
    banks return, and the injected set would be a constant 4/2 split regardless
    of relevance.

    Scaling with the cap rather than clamping against a hardcoded 6 means the
    invariant holds for any operator cap: at 6 the floors may claim 3, at 12 six,
    at 4 two, at 1 none (reservation is simply off below cap 2).
    """
    if not isinstance(cap, int) or cap <= 0:
        return 0
    return cap // 2


def _reserve_bank_slots(results, cap, own_bank_id, own_floor, additional_floor):
    """Head-slice `results` to `cap`, guaranteeing a minimum number of slots to
    the agent's OWN bank and to the additional (profile / shared / sender) banks.

    Switchroom — profile-bank crowd-out fix. `_sort_by_final_score` above sorts
    the merged multi-bank set by `scores.final` and the caller then head-slices
    at `recallMaxMemories`. On a turn where BOTH banks return more candidates
    than the cap, that head-slice is winner-take-all across banks: nothing stops
    one bank's score distribution from filling every slot, and the shared
    `ken-profile` bank's facts routinely outscore the agent's own working memory
    because a profile bank is dense with short, highly-rerankable statements.
    The result is an agent handed a dossier about its operator and none of its
    own session memory.

    Scope, precisely — this fixes score-based crowd-out among results that DID
    return. It does NOT fix the own-bank timeout: a timed-out bank contributes
    zero candidates, so `own_take` is 0 and reservation is a strict no-op there.
    Measured across 1,036 multi-bank non-cache recalls on this host since
    2026-07-20: own-dead/additional-alive is 67.0% of turns (83.5% for
    overlord), and both-alive — the only state where reservation can act at all
    — is 15.1% fleet-wide, 6.4% for overlord (6.8% once you also require more
    candidates than the cap). The own-bank timeout is a separate, larger defect;
    the `injected_own_bank_count` telemetry added alongside this is what makes
    it legible per-turn.

    Floors, not quotas, and enforced as such. Each side is guaranteed AT MOST
    `floor` slots, only if it actually has that many results, and only up to
    `_reservable_slots(cap)` (half the cap) between them; every other slot is
    filled from the remaining candidates in pure global-relevance order. So at
    the fleet's deployed cap of 6 with the shipped floors 2/1:

      * own returns 10, profile returns 10  -> 2 own + 4 profile (profile-favoured
                                              scores; own is never zeroed)
      * own returns 10, profile returns 10  -> 5 own + 1 profile (own-favoured
                                              scores; profile is never zeroed)
      * own returns 0,  profile returns 10  -> 6 profile (no wasted slots)
      * own returns 10, profile returns 0   -> 6 own      (no wasted slots)
      * own returns 1,  profile returns 10  -> 1 own + 5 profile

    Composition still moves with `scores.final` in both directions — that is the
    property the half-cap headroom buys and the property a quota would destroy.

    A floor of 0 disables reservation for that side. `cap <= 0` disables the cap
    entirely (upstream contract) and is a passthrough here. When the floors sum
    above the reservable half the OWN floor is honoured first — the crowd-out
    being fixed is one-directional, and the agent's own memory is the side that
    loses today.

    Selection is stable and the returned list is re-sorted by relevance, so
    reservation changes WHICH memories are injected, never the order they are
    presented in. Returns `(selected, reserved_own, reserved_additional)` where
    the two counts are the slots that would NOT have been won on global score
    alone — i.e. the observable effect of this function, logged as telemetry.
    """
    if not isinstance(cap, int) or cap <= 0 or len(results) <= cap:
        return results, 0, 0

    baseline_ids = {id(m) for m in results[:cap]}

    own = [m for m in results if _source_bank_of(m) == own_bank_id]
    additional = [m for m in results if _source_bank_of(m) != own_bank_id]

    # Floors compete for the reservable half only — never for the whole cap.
    reservable = _reservable_slots(cap)
    own_take = max(0, min(int(own_floor or 0), len(own), reservable))
    additional_take = max(
        0, min(int(additional_floor or 0), len(additional), reservable - own_take)
    )

    reserved = own[:own_take] + additional[:additional_take]
    reserved_ids = {id(m) for m in reserved}

    remaining = cap - len(reserved)
    if remaining > 0:
        for m in results:
            if id(m) in reserved_ids:
                continue
            reserved.append(m)
            reserved_ids.add(id(m))
            remaining -= 1
            if remaining == 0:
                break

    _sort_by_final_score(reserved)

    promoted_own = sum(
        1 for m in reserved if id(m) not in baseline_ids and _source_bank_of(m) == own_bank_id
    )
    promoted_additional = sum(
        1 for m in reserved if id(m) not in baseline_ids and _source_bank_of(m) != own_bank_id
    )
    return reserved, promoted_own, promoted_additional


def _injected_bank_composition(results, own_bank_id) -> dict:
    """Own-bank / additional-bank split of the INJECTED set (post-head-slice).

    Returns ``{"injected_own_bank_count", "injected_additional_bank_count"}``.
    The two always sum to ``result_count``; results with no stamped source bank
    (only possible from a cached row or a malformed engine response) count as
    additional, so the own-bank number is never optimistic.
    """
    try:
        own = sum(1 for m in results or [] if _source_bank_of(m) == own_bank_id)
        return {
            "injected_own_bank_count": own,
            "injected_additional_bank_count": len(results or []) - own,
        }
    except Exception:
        # Telemetry must never take recall down.
        return {
            "injected_own_bank_count": None,
            "injected_additional_bank_count": None,
        }


def _source_bank_of(m):
    """Read a result's stamped source bank, or None when absent/malformed."""
    if isinstance(m, dict):
        v = m.get(SOURCE_BANK_KEY)
        if isinstance(v, str):
            return v
    return None


def _is_timeout_error(exc: BaseException) -> bool:
    """True if `exc` is (or wraps) a network read/connect timeout.

    Switchroom A3 stage-1 telemetry (hindsight-leverage PR 1). The recall
    HTTP path is `urllib.request.urlopen(..., timeout=8)`. On a hard timeout
    urlopen raises either a bare ``socket.timeout`` / ``TimeoutError`` or a
    ``urllib.error.URLError`` whose ``.reason`` is one of those. We classify
    both so the per-bank ``timed_out`` flag (and the derived ``deadline_hit``)
    distinguishes a bank that hit its deadline from one that failed fast
    (5xx, connection refused, malformed response). Best-effort: anything we
    can't positively identify as a timeout is treated as a non-timeout error.
    """
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return True

    # An HTTP status response is NEVER a client-side read deadline, even when
    # its body says "upstream timed out" / "gateway timeout" (502/504). Rule
    # these out BEFORE the message sniff below (review finding 4), both when
    # the HTTPError is raised directly and when lib.client wraps it as
    # `RuntimeError(f"HTTP {code} from {url}: {body}")` — whose body can carry
    # a proxy's "timed out" text and would otherwise be misclassified.
    cause = getattr(exc, "__cause__", None)
    if isinstance(exc, urllib.error.HTTPError) or isinstance(cause, urllib.error.HTTPError):
        return False
    if re.match(r"HTTP \d+ from ", str(exc)):
        return False

    # A non-HTTP URLError (DNS, connection, read timeout) — inspect the reason.
    if isinstance(exc, urllib.error.URLError):
        reason = getattr(exc, "reason", None)
        if isinstance(reason, (socket.timeout, TimeoutError)):
            return True
        # Some stdlib versions stringify the timeout into the reason.
        if isinstance(reason, str) and "timed out" in reason.lower():
            return True

    # Fall back to a message sniff for RuntimeError wrappers from lib.client
    # (non-HTTP failures — the HTTP-wrapper shape was ruled out above).
    return "timed out" in str(exc).lower()


def _apply_tag_weights(results, tag_weights) -> int:
    """Multiply each result's ``scores.final`` by a per-tag weight in place.

    Switchroom hindsight-leverage PR5 — the recall-side counterpart to the
    ``sidechain`` retain tag. A NEW mechanism, deliberately distinct from the
    demote-tag DROP filter (`_is_demoted_memory`): that path removes a tagged
    memory from recall entirely, which cannot express "keep it, but rank it
    lower". This step DOWN-WEIGHTS a memory's engine relevance score so a
    penalised memory sorts below an equal-scoring un-penalised one at the sort
    below, yet is still returned when it is the only relevant hit (the cap sees
    the full penalised set, not a filtered one).

    ``tag_weights`` is a ``{tag: multiplier}`` map. For each result, the
    multipliers of ALL its tags that appear in the map are multiplied together
    and applied to ``scores.final`` (so a memory carrying two penalised tags is
    penalised compoundly — intended). Tags are matched case-sensitively after
    ``strip()`` (consistent with ``_is_demoted_memory``). Results whose
    ``scores.final`` is absent or non-numeric are left untouched — a score-less
    entry already sorts last and there is nothing to scale. A weight of exactly
    1.0 (or a non-positive / non-numeric weight) is a no-op for that tag.

    Returns the number of results whose score was actually changed (for the
    debug log). Mutation is intentional: the effective (post-weight) score is
    what the sort, the cap, and the recall-log ranking should all reflect.
    """
    if not isinstance(tag_weights, dict) or not tag_weights:
        return 0
    changed = 0
    for m in results:
        if not isinstance(m, dict):
            continue
        tags = m.get("tags")
        if not isinstance(tags, list):
            continue
        factor = 1.0
        for tag in tags:
            if not isinstance(tag, str):
                continue
            w = tag_weights.get(tag.strip())
            if isinstance(w, (int, float)) and not isinstance(w, bool) and w > 0:
                factor *= float(w)
        if factor == 1.0:
            continue
        scores = m.get("scores")
        if not isinstance(scores, dict):
            continue
        val = scores.get("final")
        if isinstance(val, (int, float)) and not isinstance(val, bool):
            scores["final"] = float(val) * factor
            changed += 1
    return changed


def _effective_tag_weights(config) -> dict:
    """Merge the built-in lesson/anti-pattern demotion weights UNDER the operator's
    ``recallTagWeights`` (switchroom E2 / PR9, #398).

    The retain side (``detect_lesson_tags``) tags failure-mode-adjacent transcripts
    ``lesson`` / ``anti-pattern``; this composes those tags into the same PR5
    score-penalty map so they are DEMOTED out of the box. Precedence: an explicit
    ``recallTagWeights`` entry WINS over the built-in for the same tag (operator
    override), and the PR5 ``sidechain`` seed still composes cleanly since it lives
    only in ``recallTagWeights``. When ``lessonDemotion`` is false the built-ins are
    dropped entirely (rollback lever) and only ``recallTagWeights`` applies.
    """
    configured = config.get("recallTagWeights")
    configured = configured if isinstance(configured, dict) else {}
    if not config.get("lessonDemotion", True):
        return configured
    builtin = config.get("lessonDemotionWeights")
    builtin = builtin if isinstance(builtin, dict) else {}
    if not builtin:
        return configured
    # builtin first, operator override wins on key conflict.
    return {**builtin, **configured}


def _write_recall_log(entry: dict) -> None:
    """Append a JSONL line to recall_log.jsonl. Bounded by line count.

    Switchroom #432 phase 4.3. Failure-tolerant — telemetry must never
    block recall, so any write error is swallowed silently. Unbounded
    growth is prevented by truncating to the last RECALL_LOG_MAX_LINES
    when the file is rolled over (cheap because we read once per
    append; the alternative — keeping a separate index — is more code
    for a feature that runs at most once per turn).
    """
    try:
        plugin_data = os.environ.get("CLAUDE_PLUGIN_DATA", "")
        if not plugin_data:
            return
        log_dir = os.path.join(plugin_data, "state")
        os.makedirs(log_dir, exist_ok=True)
        log_path = os.path.join(log_dir, RECALL_LOG_FILE)
        line = json.dumps(entry, separators=(",", ":")) + "\n"
        # Append-then-trim. For typical operation the file is well
        # under the cap and the trim path is a no-op.
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(line)
        # Size-gated trim: only pay the full-file read when the byte size
        # says we plausibly exceed the line cap. The estimate is a per-line
        # UPPER bound (see RECALL_LOG_BYTES_PER_LINE_EST) so we don't read on
        # every hook once rows grew past the old 200 B/line assumption.
        try:
            size = os.path.getsize(log_path)
        except OSError:
            return
        if size > RECALL_LOG_MAX_LINES * RECALL_LOG_BYTES_PER_LINE_EST:
            try:
                with open(log_path, "r", encoding="utf-8") as f:
                    lines = f.readlines()
                if len(lines) > RECALL_LOG_MAX_LINES:
                    keep = lines[-RECALL_LOG_MAX_LINES:]
                    with open(log_path, "w", encoding="utf-8") as f:
                        f.writelines(keep)
            except OSError:
                pass
    except Exception:
        # Silently swallow — telemetry is never load-bearing.
        pass


# Switchroom recall-latency instrumentation — full-hook wall-time.
#
# recall.py is the UserPromptSubmit hook that sits in front of EVERY reply
# (pre-first-token), yet it was the one hook with no wall-time record: it is a
# DIRECT Claude Code plugin hook (hooks/hooks.json), NOT wrapped by
# bin/run-hook.sh, so it never emitted a `hook-timings-<Ddd>.log` row the way
# every wrapped hook does, and `recall_log.jsonl` measured only the recall
# critical path (`total_elapsed_ms`, from `recall_start_monotonic`) — never the
# hook's own import + stdin + cache-check + gate overhead.
#
# Routing it through run-hook.sh was rejected as the mechanism: the vendored
# hooks.json is re-copied verbatim into every agent's plugin dir on `switchroom
# apply`, and run-hook.sh lives in the switchroom repo's bin/, not under
# CLAUDE_PLUGIN_ROOT — coupling the vendor snapshot to switchroom's bin layout is
# fragile, and the os._exit(0) fast-path (which skips atexit / thread-join to
# return control the instant stdout is flushed) would have to be reconciled with
# the wrapper. Instead the hook emits the SAME JSON line, into the SAME weekday-
# ring file, honouring the SAME env knobs, from inside the process at exit — so
# `grep duration_ms hook-timings-*.log` sees this hook next to every other one.
HOOK_TIMING_SOURCE = "hook:hindsight-recall"
HOOK_TIMING_CODE = "recall.py"


def _hook_duration_ms() -> int:
    """Milliseconds since this hook process began doing work.

    Anchored at import start (`_IMPORT_START_MONOTONIC`, taken before any of this
    hook's own imports ran — recall.py line ~48), so the number spans the WHOLE
    hook: dependency import, the stdin read, the cache check, the gate
    short-circuits, and — when it got that far — the recall round-trips. That is
    deliberately WIDER than `total_elapsed_ms` (the recall critical path only,
    measured from `recall_start_monotonic`): `duration_ms - total_elapsed_ms` is
    therefore the pre-recall LOCAL overhead, and the per-bank
    `bank_timings[].elapsed_ms` remain the Hindsight server round-trips — so the
    log already separates server time from local overhead without a new field.
    """
    return int((time.monotonic() - _IMPORT_START_MONOTONIC) * 1000)


def _emit_hook_timing_log(duration_ms: int, status: int) -> None:
    """Append one timing line to `hook-timings-<Ddd>.log`, matching run-hook.sh.

    STDOUT-SAFE by construction: writes only to a log file, NEVER to the hook's
    stdout contract that Claude Code consumes. Failure-tolerant — any error is
    swallowed so instrumentation can never take the hook down. Honours the same
    env knobs as bin/run-hook.sh (`SWITCHROOM_HOOK_TIMING`,
    `SWITCHROOM_HOOK_TIMING_DIR`, `SWITCHROOM_HOOK_TIMING_MIN_MS`) and reproduces
    its 7-day self-truncating weekday ring and JSON line shape exactly, so a
    consumer cannot tell this row apart from a wrapped hook's.

    NOTE on the 12s ceiling: if Claude Code kills this hook at the
    UserPromptSubmit timeout, the process is terminated before any exit path runs
    and NO timing line (nor recall_log row) is written — the MISSING line is the
    breach signal, consistent with the two-signal baseline documented at the
    recall_log write. This records every invocation that returns under budget,
    including a fully-degraded/timed-out recall that still exits cleanly.
    """
    try:
        if os.environ.get("SWITCHROOM_HOOK_TIMING", "1") == "0":
            return
        timing_dir = os.environ.get("SWITCHROOM_HOOK_TIMING_DIR") or os.environ.get(
            "TELEGRAM_STATE_DIR", ""
        )
        if not timing_dir or not os.path.isdir(timing_dir):
            return
        try:
            duration_ms = int(duration_ms)
        except (TypeError, ValueError):
            return
        if duration_ms < 0:
            duration_ms = 0
        try:
            min_ms = int(os.environ.get("SWITCHROOM_HOOK_TIMING_MIN_MS", "0"))
        except (TypeError, ValueError):
            min_ms = 0
        if duration_ms < min_ms:
            return
        # Local wall clock, matching run-hook.sh's builtin `%(...)T` formatting so
        # both writers agree on which weekday-ring file today lands in.
        now = time.localtime()
        today = time.strftime("%Y-%m-%d", now)
        dow = time.strftime("%a", now)
        ts = time.strftime("%Y-%m-%dT%H:%M:%S%z", now)
        logfile = os.path.join(timing_dir, f"hook-timings-{dow}.log")
        # 7-day self-truncating ring: the weekday-named file is either today's or
        # exactly a week stale. If its first line does not carry today's date,
        # reset it before appending (same rule as run-hook.sh).
        try:
            if os.path.getsize(logfile) > 0:
                with open(logfile, encoding="utf-8") as f:
                    first = f.readline()
                if f'"date":"{today}"' not in first:
                    open(logfile, "w", encoding="utf-8").close()
        except OSError:
            pass
        # HOOK_TIMING_SOURCE / HOOK_TIMING_CODE are fixed constants with no JSON
        # metacharacters, so no escape pass is needed (unlike run-hook.sh, whose
        # source/code are caller-supplied).
        line = (
            '{"ts":"%s","date":"%s","source":"%s","code":"%s",'
            '"duration_ms":%d,"status":%d}\n'
            % (ts, today, HOOK_TIMING_SOURCE, HOOK_TIMING_CODE, duration_ms, status)
        )
        with open(logfile, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        # Instrumentation is never load-bearing — swallow everything.
        pass


def _read_transcript_lines(transcript_path: str, tail_bytes: int):
    """Yield the transcript's trailing lines, byte-bounded.

    Switchroom hindsight-leverage A2 (PR2): the latency bound for multi-turn
    recall. When ``tail_bytes > 0`` we seek to ``EOF - tail_bytes`` and read
    forward, discarding the first (possibly partial) line so every yielded line
    is complete JSON. This caps the read+parse cost at O(tail_bytes) regardless
    of how large the session ``.jsonl`` has grown — the last few human turns we
    slice for context always live at the very tail. ``tail_bytes <= 0`` reads
    the whole file (pre-A2 behaviour / rollback lever).

    Reads bytes (not text) so the seek offset is exact; decodes with
    ``errors="ignore"`` so a multi-byte character split by the tail boundary
    can't crash the read (that byte lands in the discarded partial first line
    anyway when the file exceeds the bound).
    """
    if tail_bytes and tail_bytes > 0:
        size = os.path.getsize(transcript_path)
        if size > tail_bytes:
            with open(transcript_path, "rb") as f:
                f.seek(size - tail_bytes)
                chunk = f.read()
            text = chunk.decode("utf-8", errors="ignore")
            # Drop the first line — it may be a partial record from mid-file.
            newline = text.find("\n")
            if newline != -1:
                text = text[newline + 1 :]
            yield from text.splitlines()
            return
    with open(transcript_path, encoding="utf-8") as f:
        yield from f


def read_transcript_messages(transcript_path: str, tail_bytes: int = 0) -> list:
    """Read messages from a JSONL transcript file for multi-turn context.

    Claude Code transcript format nests messages:
      {type: "user", message: {role: "user", content: "..."}, uuid: "...", ...}
    Also supports flat format for testing:
      {role: "user", content: "..."}

    ``tail_bytes`` (Switchroom A2) byte-bounds the read: when > 0 and the file
    is larger, only the trailing ``tail_bytes`` (complete lines) are parsed, so
    the added per-recall transcript read stays cheap on long sessions. 0 reads
    the whole file. The #3369 grep fallback reuses this same tail-reader (see
    ``_transcript_grep_fallback``) rather than shipping its own seek logic, so
    there is a single byte-bounded transcript reader.
    """
    if not transcript_path or not os.path.isfile(transcript_path):
        return []
    messages = []
    try:
        for line in _read_transcript_lines(transcript_path, tail_bytes):
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                # Claude Code nested format: {type: "user", message: {role, content}}
                if entry.get("type") in ("user", "assistant"):
                    msg = entry.get("message", {})
                    if isinstance(msg, dict) and msg.get("role"):
                        messages.append(msg)
                # Flat format (testing / future compatibility)
                elif "role" in entry and "content" in entry:
                    messages.append(entry)
            except json.JSONDecodeError:
                continue
    except OSError:
        pass
    return messages


# Switchroom hindsight-leverage E1 / PR8 (#3369) — bounded transcript-grep
# fallback telemetry shape. A zeroed record is the "did not fire" default,
# emitted on the recall_log row whenever the fallback is gated off, skipped, or
# produced no match — so the log schema is uniform and a downstream query can
# always read `transcript_fallback` without a KeyError.
_FALLBACK_TELEMETRY_ZERO = {
    "fired": False,
    "matched_turns": 0,
    "chars": 0,
    "elapsed_ms": 0,
    "bytes_read": 0,
    "truncated": False,
}

# The UserPromptSubmit timeout Claude Code enforces on THIS script, mirrored
# from `hooks/hooks.json` (which ships in this same package, so the two cannot
# be configured apart by an operator). `test_hook_ceiling_matches_hooks_json`
# fails if they ever drift.
#
# Overrun is not a degraded recall — Claude Code kills the hook and the turn
# loses memories, the fallback AND the directives, which is strictly worse than
# the bug this PR fixes. So every optional tail-end spend is budgeted against
# what is actually left of the ceiling rather than against a flat constant.
HOOK_CEILING_SECONDS = 12.0
# Held back for work this arithmetic cannot see: CPython interpreter boot
# before our first statement runs, plus rendering the additionalContext
# payload, the recall_log write and teardown after the last budgeted step.
HOOK_TAIL_RESERVE_SECONDS = 0.75
# Anchor for the budget arithmetic. Set at the top of main() rather than at
# import, so a process that invokes the hook more than once (the test suite,
# and any future in-process driver) budgets each invocation independently
# instead of inheriting the whole process lifetime. Import cost is charged
# explicitly via `_IMPORT_ELAPSED_SECONDS` so re-anchoring loses nothing.
_hook_start_monotonic = None


def _begin_hook_budget():
    """(Re-)anchor the hook budget clock. Call once at the top of main()."""
    global _hook_start_monotonic
    _hook_start_monotonic = time.monotonic() - _IMPORT_ELAPSED_SECONDS


def _remaining_hook_budget_seconds():
    """Seconds left before this hook risks breaching its UserPromptSubmit ceiling."""
    if _hook_start_monotonic is None:  # pragma: no cover - defensive only
        return HOOK_CEILING_SECONDS - HOOK_TAIL_RESERVE_SECONDS
    elapsed = time.monotonic() - _hook_start_monotonic
    return HOOK_CEILING_SECONDS - HOOK_TAIL_RESERVE_SECONDS - elapsed


_FALLBACK_BLOCK_PREAMBLE = (
    "No stored memories matched this query — the fact layer may not have "
    "reconciled this session yet (e.g. an abrupt session death before boot "
    "reconciliation). The following are VERBATIM excerpts from recent turns of "
    "THIS session that mention related terms. Treat them as lower-confidence "
    "than stored memory — they are raw transcript, not synthesized fact:"
)


def _transcript_grep_fallback(transcript_path, query, config, budget_ms=None):
    """Bounded transcript-grep fallback for the empty-fact-layer window (#3369).

    Reads the CURRENT session transcript's tail (bounded bytes), keeps the most
    recent user/assistant turns whose terms lexically overlap the recall query,
    and returns a clearly-labelled, size-bounded fallback context block plus a
    telemetry dict. Every dimension is bounded: bytes read
    (``recallTranscriptFallbackMaxBytes``), matched turns
    (``recallTranscriptFallbackMaxTurns``), emitted characters
    (``recallTranscriptFallbackMaxChars``), and grep wall-time
    (``recallTranscriptFallbackDeadlineMs``, default 1500). The caller invokes
    this when all banks returned zero and none ERRORED — a hard bank error can
    masquerade as a genuinely empty fact layer, so it still suppresses the
    fallback. A per-bank TIMEOUT no longer does (#3757): timing out was the
    common case, and suppressing on it left the agent with neither memories nor
    fallback.

    That inversion removed the gate that INCIDENTALLY protected the hook
    ceiling, so the grep wall-time bound is now
    ``min(recallTranscriptFallbackDeadlineMs, remaining hook budget)`` rather
    than a flat 1.5s (#3760 review, Major 4). A flat 1.5s after a fully-elapsed
    10s recall left ~0.5s for interpreter startup, config load, the transcript
    read and output formatting — and an overrun costs the turn its directives
    too. ``budget_ms`` is that remaining-budget clamp, supplied by the caller;
    ``<= 0`` means "no time left", and the fallback declines rather than
    gambling the hook.

    Returns ``(block_or_None, telemetry)``. Failure-safe: any error path returns
    ``(None, zeroed-telemetry)`` so the fallback can never break recall.
    """
    telemetry = dict(_FALLBACK_TELEMETRY_ZERO)
    start = time.monotonic()

    if not transcript_path or not os.path.isfile(transcript_path):
        return None, telemetry

    def _int_cfg(key, default):
        try:
            val = int(config.get(key, default))
        except (TypeError, ValueError):
            return default
        return val

    max_bytes = _int_cfg("recallTranscriptFallbackMaxBytes", 262144)
    max_turns = _int_cfg("recallTranscriptFallbackMaxTurns", 6)
    max_chars = _int_cfg("recallTranscriptFallbackMaxChars", 2000)
    deadline_ms = _int_cfg("recallTranscriptFallbackDeadlineMs", 1500)
    if budget_ms is not None:
        # Never spend more than the hook has left, even when the configured
        # bound is larger. A caller with no budget left gets nothing at all.
        deadline_ms = min(deadline_ms, int(budget_ms))
        if deadline_ms <= 0:
            return None, telemetry

    if max_turns <= 0 or max_chars <= 0 or max_bytes <= 0:
        return None, telemetry

    query_tokens = _overlap_tokens(query)
    if not query_tokens:
        return None, telemetry

    # TODO(consolidation, #3450 / epic #3430): two bounded transcript tail-readers now
    # coexist post-merge — retain's, and recall's shared ``_read_transcript_lines``
    # (#3443, which this #3369 fallback now reuses via ``read_transcript_messages``).
    # They each re-implement "read the last N bytes of the session JSONL and parse
    # turns". Consolidate onto a single shared bounded tail-reader helper. Tracked
    # in follow-up #3450 (tied to epic #3430).
    messages = read_transcript_messages(transcript_path, tail_bytes=max_bytes)

    # Review finding — record bytes_read only AFTER the read succeeds, so a
    # failed/partial read doesn't report bytes we never actually consumed.
    try:
        telemetry["bytes_read"] = min(os.path.getsize(transcript_path), max_bytes)
    except OSError:
        pass

    matched = []
    total_chars = 0
    # Newest-first so, under the turn/char/time bounds, we keep the MOST RECENT
    # relevant turns; the collected list is reversed back to chronological order
    # before formatting.
    for msg in reversed(messages):
        if (time.monotonic() - start) * 1000.0 > deadline_ms:
            telemetry["truncated"] = True
            break
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        if role not in ("user", "assistant"):
            continue
        text = _extract_text_content(msg.get("content", ""), role=role)
        text = strip_memory_tags(strip_channel_envelope(text)).strip()
        if not text:
            continue
        if not (_overlap_tokens(text) & query_tokens):
            continue
        entry = f"[{role}] {text}"
        remaining = max_chars - total_chars
        if remaining <= 0:
            telemetry["truncated"] = True
            break
        if len(entry) > remaining:
            # Review finding — reserve 1 char for the ellipsis so the emitted
            # entry is EXACTLY `remaining` chars, not remaining+1 (the "…" is a
            # single code point). Keeps the char budget an exact bound.
            entry = entry[:remaining - 1].rstrip() + "…"
            telemetry["truncated"] = True
        matched.append(entry)
        total_chars += len(entry)
        if len(matched) >= max_turns:
            break

    telemetry["elapsed_ms"] = int((time.monotonic() - start) * 1000)

    if not matched:
        return None, telemetry

    matched.reverse()  # restore chronological order for the model
    block = (
        "<hindsight_transcript_fallback>\n"
        f"{_FALLBACK_BLOCK_PREAMBLE}\n\n"
        + "\n".join(matched)
        + "\n</hindsight_transcript_fallback>"
    )
    telemetry["fired"] = True
    telemetry["matched_turns"] = len(matched)
    telemetry["chars"] = len(block)
    return block, telemetry


# Switchroom Phase 6a — stateless-prompt classifier for the recall skip.
# Returns True ONLY for prompts that provably never need user memory: the
# current time/date/day, or a bare greeting. Biased hard toward False —
# any personal pronoun, memory verb, or context word means "could need
# memory → recall anyway". Trap case: "what host am I on" reads trivial
# but needs memory; the "i" token blocks the skip.
_TRIVIAL_GREETINGS = frozenset({
    "hi", "hello", "hey", "heya", "hiya", "yo", "howdy", "sup",
    "hey there", "hello there", "hi there",
    "morning", "good morning", "good afternoon", "good evening", "evening",
})
# Any of these as a whole word → do NOT skip (prompt may depend on stored
# user / project / session state).
_STATEFUL_SIGNALS = frozenset({
    "i", "im", "ive", "id", "me", "my", "mine", "myself",
    "we", "our", "ours", "us", "you", "your", "yours",
    "remember", "recall", "forget", "forgot", "remind",
    "last", "earlier", "yesterday", "before", "again", "previously", "recent",
    "project", "task", "status", "config", "setup", "host", "machine",
    "running", "deploy", "agent", "memory", "note", "noted",
})
# Matched against an apostrophe-stripped form, so "what's"→"whats",
# "today's"→"todays". Covers "what time is it", "what's the time",
# "what day is it", "what's today's date", "current time", "time?".
_STATELESS_QUESTION_RE = re.compile(
    r"^(?:what(?:s| is)?\s+)?"
    r"(?:the\s+|current\s+|todays\s+)?"
    r"(?:time|date|day(?:\s+of\s+(?:the\s+)?week)?)"
    r"(?:\s+is\s+it)?(?:\s+(?:right\s+now|now|today))?"
    r"\s*\??$"
)


def _is_trivial_stateless(ack_form, stripped):
    text = (stripped or "").lower().strip()
    core = text.strip(" \t\n\r.,!?…👍👌✅🆗🙏")
    if not core:
        return False
    core_noapos = core.replace("'", "")
    # If any token signals personal / project / session state, bail —
    # apostrophes stripped so "i'm"/"i've" tokenise to im/ive (stateful).
    tokens = re.findall(r"[a-z]+", core_noapos)
    if any(tok in _STATEFUL_SIGNALS for tok in tokens):
        return False
    if core in _TRIVIAL_GREETINGS:
        return True
    if _STATELESS_QUESTION_RE.match(core_noapos):
        return True
    return False


# Switchroom #2848 Stage B — deterministic directive-capture nudge.
#
# Stage A audit (issue #2848) measured a ~55% miss rate on durable
# corrections: the model is instructed (guidance-only, in
# profiles/default/CLAUDE.md.hbs) to persist standing rules with
# mcp__hindsight__create_directive, but does so inconsistently — capture
# is a per-agent lottery (the same broadcast correction was captured by
# one agent and silently dropped by two others). This adds DETERMINISTIC
# detection of correction / standing-rule-shaped inbound (pure regex — NO
# model callsite; the claude-native invariant forbids a classifier call)
# and appends a terse advisory nudge to the UserPromptSubmit
# additionalContext. The MODEL makes the judgment IN-SESSION and calls
# create_directive itself (visible in chat); the hook NEVER writes a
# directive on its own — a silent hook-side write would break
# chat-legibility and edge the no-self-escalation invariant.
#
# On by default (Stage A proved a real gap → defaults principle);
# operators opt out per-agent via memory.directive_capture_nudge=false in
# switchroom.yaml, which start.sh exports as
# HINDSIGHT_DIRECTIVE_CAPTURE_NUDGE=false (recall.py falls back to the
# settings.json default, which switchroom pins on).
#
# Detection is intentionally inclusive (the nudge is cheap + advisory, so
# a modest false-positive rate is acceptable — the model just ignores it
# on a one-off), but a negative guard scrubs the obvious pleasantry
# shapes ("always happy to help", "never mind") BEFORE the positive
# match, so those don't fire on a bare "always"/"never".
_DIRECTIVE_NUDGE_NEGATIVE_RE = re.compile(
    r"""(?ix)
    (?:
        never \s* mind
      | nevermind
      | always \s+ (?: happy | glad | welcome | here \s+ to \s+ help | open \s+ to )
      | never \s+ (?: fails? | hurts? | too \s+ late | a \s+ dull )
      | as \s+ always
      | thanks? \s+ as \s+ always
      | forever \s+ grateful
    )
    """
)

_DIRECTIVE_NUDGE_RE = re.compile(
    r"""(?ix)
    (?:
      # --- explicit standing-rule framings ---
        \b from \s+ now \s+ on \b
      | \b going \s+ forward \b
      | \b in \s+ (?: the \s+ )? future \b
      | \b (?: as \s+ a \s+ )? general \s+ (?: rule | behaviou?r | policy | principle | agent \s+ behaviou?r ) \b
      | \b as \s+ a \s+ rule \b
      | \b i \s+ want \s+ you \s+ to \b
      | \b you \s+ should \s+ (?: always | never ) \b
      # --- always / never (pleasantries pre-scrubbed by the negative guard) ---
      | \b always \b
      | \b never \b
      | \b no \s+ longer \b
      | \b anymore \b
      # --- prohibitions / behavioural corrections ---
      | \b stop \s+ (?: doing | saying | using | calling | adding | making | being | sending | putting ) \b
      | \b (?: do \s* n['’]? t | don['’]? t | do \s+ not ) \s+ (?: ever \s+ )?
            (?: make | guess | assume | use | say | add | send | call | include | do | put | write | reply | respond | mention ) \b
      | \b (?: do \s* n['’]? t | don['’]? t | do \s+ not ) \b [^.?!]{0,40} \b again \b
      | \b (?: should \s* n['’]? t | shouldn['’]? t | should \s+ not ) \b
      # --- preferences / identity ---
      | \b (?: i | we ) \s+ (?: prefer | always \s+ want | never \s+ want ) \b
      | \b i['’]? d \s+ prefer \b
      | \b call \s+ me \b
      # --- memory / reinforcement ---
      | \b remember \s+ (?: to | that | this | always | never ) \b
      | \b make \s+ sure \s+ (?: you | to | that | not | it ) \b
      # --- explicit wrongness + restatement ---
      | \b that['’]? s \s+ (?: wrong | not \s+ right | incorrect | not \s+ what ) \b
      | \b (?: no ,? \s+ )? it['’]? s \s+ (?: actually | not ) \b
      | \b (?: that['’]? s | it['’]? s ) \s+ (?: dead | deprecated | retired | closed ) \b
      | \b we \s+ (?: now \s+ )? (?: use \s+ only | only \s+ use | no \s+ longer \s+ use ) \b
    )
    """
)

# Terse, advisory. The model decides IN-SESSION whether this is a durable
# rule and, if so, calls create_directive itself (chat-legible). Kept
# short so it costs a handful of tokens on a false positive.
_DIRECTIVE_CAPTURE_NUDGE = (
    "<directive_capture_check>\n"
    "The latest user message is correction- or standing-rule-shaped "
    '(e.g. "always/never …", "from now on …", "stop doing …", a stated '
    'preference, or "that’s wrong, it’s …"). If it states a DURABLE rule '
    "for how you should behave going forward — not a one-off request for "
    "this task — persist it NOW with mcp__hindsight__create_directive "
    "(verbatim, in the user’s own words) BEFORE you answer, so the "
    "correction survives future sessions. UNLESS an equivalent active "
    "directive already exists (see any <active_directives> block above) — "
    "in that case it is already saved; do NOT create a duplicate. If the "
    "rule can be enforced deterministically — a settings.json hook, a "
    "permission rule, a skill/script edit, or a config change — prefer "
    "that (instead of, or in addition to, the directive) and say which "
    "you did; reserve a directive for judgment rules code can’t enforce. "
    "If it’s only a one-off instruction, ignore this note and just "
    "answer.\n"
    "</directive_capture_check>"
)


def looks_like_standing_rule(text) -> bool:
    """Deterministic (regex-only) test for correction / standing-rule shape.

    Pleasantry shapes ("always happy to help", "never mind") are scrubbed
    BEFORE the positive match so they can't trip the bare always/never
    signals. Returns False on empty / non-string input. No model call —
    the model does the actual judgment in-session (issue #2848).
    """
    if not isinstance(text, str) or not text.strip():
        return False
    scrubbed = _DIRECTIVE_NUDGE_NEGATIVE_RE.sub(" ", text)
    return bool(_DIRECTIVE_NUDGE_RE.search(scrubbed))


# ── Temporal-expression detection for the recall `query_timestamp` anchor ──
# Switchroom P2 (memory-redesign RFC §5). When the inbound prompt asks a
# time-relative question ("what did we work on last week", "on the 12th"),
# the recall body carries an explicit `query_timestamp` anchor so the engine
# resolves the relative expression and anchors recency scoring against the
# real ask-time. The anchor is ALWAYS the current wall clock — that is the
# documented semantics ("when the query is being asked, from the user's
# perspective", https://hindsight.vectorize.io/developer/api/recall) — the
# regex only GATES whether the field is sent, it does not resolve the phrase
# itself (the engine does that server-side against the anchor we supply).
#
# Deterministic regex only — NO model call (claude-native invariant, same as
# the directive-capture nudge above). The match is a cheap substring scan on
# the already-stripped prompt, so it never extends the recall hook's critical
# path (the 12s ceiling / parallel deadline live entirely on the network I/O
# below). Detection is deliberately conservative: it requires a preposition or
# quantifier around ambiguous tokens (bare weekday / month / "may") so an
# ordinary sentence does not fire the field. A false negative merely omits an
# anchor the server would default to anyway; a false positive sends the true
# ask-time, which is the correct anchor regardless — so both error directions
# degrade to today's behaviour.
_TEMPORAL_EXPRESSION_RE = re.compile(
    r"""(?ix)
    (?:
      # --- absolute-relative day words ---
        \b (?: yesterday | tonight | tomorrow ) \b
      | \b last \s+ night \b
      # --- this/last/next + period ---
      | \b (?: this | last | next | past ) \s+
            (?: week | month | year | quarter | fortnight | weekend
              | morning | afternoon | evening | night | decade ) \b
      # --- earlier / other-day framings ---
      | \b the \s+ other \s+ (?: day | week | night ) \b
      | \b earlier \s+ (?: today | this \s+ (?: week | month | year ) ) \b
      | \b a \s+ (?: while | moment ) \s+ ago \b
      # --- "<N> <unit> ago" (worded or digit quantifier) ---
      | \b (?: a | an | one | two | three | four | five | six | seven | eight
            | nine | ten | \d+ | couple \s+ of | few ) \s+
            (?: second | minute | hour | day | week | month | year ) s? \s+ ago \b
      # --- weekday, only with a temporal preposition/qualifier ---
      | \b (?: this | last | next | on | since | by ) \s+
            (?: monday | tuesday | wednesday | thursday | friday
              | saturday | sunday ) \b
      # --- ordinal day-of-month ("on the 12th", "by the 3rd") ---
      | \b (?: on | by | since | before | after | around ) \s+ the \s+
            \d{1,2} (?: st | nd | rd | th ) \b
      # --- month name, only with a temporal preposition ---
      | \b (?: in | on | since | during | back \s+ in | early | late ) \s+
            (?: january | february | march | april | may | june | july
              | august | september | october | november | december ) \b
    )
    """
)


# RFC phase4 P3 — deterministic operator-profile capture nudge.
#
# Ken's first stated want is "save memories about him" (RFC §0 constraint 5a).
# Auto-retain does store transcript facts, but there is no deterministic signal
# that a durable *profile fact* about the operator himself just went by, so
# capture-as-profile is left to model discretion — the same per-agent lottery
# Stage A measured for directives. This mirrors the shipped directive-capture
# nudge (recall.py #2848): a POSITIVE regex detects a first-person durable
# self-statement ("I prefer …", "my … is …", "I always …", "remind me that
# I …"); a NEGATIVE regex scrubs the two shapes that would otherwise misfire —
# questions ("do I prefer …?", "what's my …?") and third-/second-party
# attributions ("you said I prefer …", "she claims my …") — BEFORE the positive
# match. On a hit the hook appends a terse advisory telling the model to persist
# the fact with an explicit mcp__hindsight__retain carrying a `profile:ken` tag
# into THIS AGENT'S OWN bank. Pure regex — NO model callsite (the claude-native
# invariant forbids a classifier call); the model makes the judgment in-session
# and calls retain itself (chat-legible). The hook NEVER writes on its own.
#
# On by default; operators opt out per-agent via memory.profile_capture_nudge
# =false → HINDSIGHT_PROFILE_CAPTURE_NUDGE (recall.py falls back to True).
#
# ROUTING CONSTRAINT (RFC §0 constraint 2, §7 Q3): the fact goes to the agent's
# OWN bank, NOT a shared/cross-agent person bank (ken-profile/lisa-profile).
# The tag makes the facts cheap to find and retire later if Q3 is answered
# differently. The `profile:ken` operator identity is intentionally literal —
# this fleet has a single named operator (Ken); a multi-operator deployment
# would parameterise the tag, which is out of scope for P3.
#
# CONSERVATISM (RFC §7 Q1, unanswered): the RFC flags that this regex set is
# derived from an ASSUMPTION that the profile facts Ken wants are
# preference-/identity-shaped. Until Q1 is answered from a real instance, the
# positive set is deliberately TIGHT (favouring false negatives) — only clearly
# durable first-person framings, not bare "I like"/"I use" reactions that are
# usually one-off. If Q1's answer is not preference-shaped, this set is wrong
# and should be re-derived before it is relied on.
_PROFILE_NUDGE_NEGATIVE_RE = re.compile(
    r"""(?ix)
    (?:
      # --- interrogatives: a question ABOUT the operator is not a statement
      #     OF a durable fact. Scrub the "<wh|aux> [do] I" / "<aux> my" lead so
      #     the following "I prefer" / "my X is" can't fire. ---
        \b (?: what | which | where | when | why | how | do | did | does
             | should | would | could | can | are | is | was | were )
          \s+ (?: do \s+ )? i \b
      | \b what (?: ['’]? s | \s+ is | \s+ are ) \s+ my \b
      | \b (?: where | when | is | are | was | were ) \s+ my \b
      | \b remind \s+ me \s+ what \b
      # --- attributions: a fact the operator ascribes to someone else (or to
      #     the agent) is not the operator stating his own profile. Scrub the
      #     attributed clause up to the next clause boundary. Stop at a comma as
      #     well as sentence-enders so a trailing real fact in the SAME sentence
      #     ("she said X, my timezone is Melbourne") still reaches the positive
      #     matcher instead of being swallowed. ---
      | \b (?: he | she | they | you | who | someone | everyone | nobody )
          \s+ (?: said | says | say | claimed | claims | thinks? | thought
                | told | mentions? | mentioned | asks? | asked | wants? | wanted
                | wrote | believes? | reckons? )
          \b [^.?!,]*
      # --- pleasantries that embed a bare always/never after "I". ---
      | \b i \s+ (?: always | never )
          \s+ (?: appreciate | enjoy | 'm \s+ happy | am \s+ happy | love \s+ working ) \b
      # --- "I'm a <hedge>" is a transient mood/quantifier, not "I'm a <noun>"
      #     identity ("I'm a bit tired", "I'm a little confused"). Scrub the
      #     "I'm a/an" lead so the identity arm can't fire on it. ---
      | \b i (?: \s+ am | \s* ['’] m ) \s+ (?: a | an )
          \s+ (?: bit | little | lot | tad | touch | bunch | couple | few
                | fan \b | big \s+ fan ) \b
      # --- "call me <phone-phrasing>" is a request, not a name form
      #     ("call me back", "call me later"). Scrub so the name arm ("call me
      #     Ken") is the only thing left that can fire. ---
      | \b call \s+ me \s+ (?: back | later | tomorrow | tonight | soon | again
                | when | if | once | after | before | at | on | in | asap ) \b
    )
    """
)


def detect_query_timestamp(text, now=None) -> "str | None":
    """Return an ISO 8601 ask-time anchor when ``text`` carries a temporal
    expression, else ``None``.

    Deterministic and IO-free — a single regex scan, no model call and no
    clock dependency the caller cannot control (``now`` is injectable so the
    behaviour is unit-testable to the exact output string). When a temporal
    phrase is present the anchor returned is the CURRENT time, because
    ``query_timestamp`` is defined by the engine as *when the query is asked*,
    not the period the phrase names — the engine resolves the phrase against
    this anchor. ``None`` means "send no field", which keeps the recall body
    byte-identical to a pre-P2 client.

    The anchor carries the LOCAL wall-clock offset (``datetime.now()`` +
    ``.astimezone()``), NOT UTC. This matters precisely on the dimension P2
    serves: for a Melbourne evening query "what did we do yesterday", a
    UTC-stamped anchor (``+00:00``) can be a calendar day ahead of the
    operator's real day, so the engine would resolve "yesterday"/"last
    week"/"on the 12th" against the wrong day. ``.astimezone()`` with no
    argument attaches the process TZ (the container clock is already
    Australia/Melbourne), which is the operator's actual day. Never
    ``timezone.utc`` here — that would re-introduce the off-by-one this fix
    removes.

    Returns ``None`` on empty / non-string input so a caller can pass a raw
    prompt without a guard.
    """
    if not isinstance(text, str) or not text.strip():
        return None
    if not _TEMPORAL_EXPRESSION_RE.search(text):
        return None
    anchor = now if now is not None else datetime.now().astimezone()
    return anchor.isoformat()


_PROFILE_NUDGE_RE = re.compile(
    r"""(?ix)
    (?:
      # --- stated preferences / tastes ---
        \b i \s+ prefer \b
      | \b i['’]? d \s+ prefer \b
      | \b my \s+ preference \s+ (?: is | are ) \b
      | \b i \s+ (?: hate | love | despise | adore | dislike
                  | can ['’]? t \s+ stand ) \b
      # --- durable self-facts: "my <ATTRIBUTE> is/are/'s <value>".
      #     ATTRIBUTE is a TIGHT allow-list of durable identity attributes.
      #     A free noun ("my build is failing", "my container is down", "my PR
      #     is ready") is transient dev state, not a profile fact — firing on
      #     it inverts the RFC's favour-false-negatives constraint on this very
      #     agent (klanker), so the free-`\w+` arm is deliberately NOT used. ---
      | \b my \s+
          (?: name | e-?mail | timezone | time \s+ zone | address
            | (?: phone | mobile | cell ) (?: \s+ number )? | number
            | birthday | birthdate | dob | anniversary | age | pronouns?
            | handle | username | nickname | initials
            | employer | company | partner | wife | husband | spouse
            | girlfriend | boyfriend | kids? | children | child | son
            | daughter | sister | brother | mother | father | mom | dad
            | parents | dog | cat | pet | diet | allerg(?: y | ies )
            | location | city | country | hometown )
          (?: \s+ \w+ )?
          (?: \s+ (?: is | are ) | \s* ['’] s ) \b
      # --- identity / situation ---
      | \b i \s+ live \s+ (?: in | at | near ) \b
      | \b i \s+ work \s+ (?: at | as | for | in ) \b
      | \b i (?: \s+ am | \s* ['’] m ) \s+ (?: allergic \s+ to
            | based \s+ (?: in | at ) | from | located \s+ in
            | vegetarian | vegan | pescatarian | teetotal ) \b
      | \b i (?: \s+ am | \s* ['’] m ) \s+ (?: a | an ) \s+ \w+
      # --- dietary / abstention identity ("I don't eat meat") ---
      | \b i \s+ (?: do \s* n['’]? t | don['’]? t | do \s+ not )
            \s+ (?: eat | drink | use | own | drive ) \b
      # --- name / address form ("call me Ken") ---
      | \b call \s+ me \b
      # --- durable habits (first person; questions pre-scrubbed) ---
      | \b i \s+ always \b
      | \b i \s+ usually \b
      | \b i \s+ normally \b
      | \b i \s+ never \b
      # --- explicit memory framing about the operator himself ---
      | \b remember \s+ that \s+ i \b
      | \b remind \s+ me \s+ that \s+ i \b
    )
    """
)

# Terse, advisory. The model decides IN-SESSION whether this is a durable
# operator-profile fact and, if so, calls retain itself (chat-legible),
# tagging it `profile:ken` and routing it to the agent's OWN bank. Kept short
# so it costs a handful of tokens on a false positive.
_PROFILE_CAPTURE_NUDGE = (
    "<profile_capture_check>\n"
    "The latest user message states a durable fact about the operator himself "
    '(e.g. a preference "I prefer …", an identity/situation fact "my … is …", '
    'a habit "I always …", or "remind me that I …") — NOT an instruction about '
    "how you should behave (that is the directive path). If it is a DURABLE "
    "fact worth remembering about him across sessions — not a one-off for this "
    "task — persist it NOW with mcp__hindsight__retain, in his own words, "
    'tagged ["profile:ken"], into THIS AGENT\'S OWN bank (the default bank — do '
    "NOT route it to a shared or cross-agent person bank). If an equivalent "
    "fact is already stored, do not duplicate it. If it is only a passing "
    "remark, ignore this note and just answer.\n"
    "</profile_capture_check>"
)


def looks_like_profile_statement(text) -> bool:
    """Deterministic (regex-only) test for an operator durable-profile shape.

    Question and attribution shapes ("do I prefer …?", "what's my …?", "you
    said I prefer …") are scrubbed BEFORE the positive match so they can't trip
    the first-person signals. Returns False on empty / non-string input. No
    model call — the model does the actual judgment in-session (RFC P3)."""
    if not isinstance(text, str) or not text.strip():
        return False
    scrubbed = _PROFILE_NUDGE_NEGATIVE_RE.sub(" ", text)
    return bool(_PROFILE_NUDGE_RE.search(scrubbed))


def _combine_context(base, nudge) -> str:
    """Join the recall/directives context with the directive-capture nudge,
    skipping empties. Either may be None/empty. The nudge is kept OUT of the
    cached / last-recall context (it's transient per-inbound) and appended
    only at emit time, so a cache hit re-derives it from the current prompt
    rather than replaying a stale one."""
    parts = [p for p in (base, nudge) if p]
    return "\n\n".join(parts)


# Switchroom structural-fix #7 — WHAT failed, not merely THAT something did.
#
# Before this, every failure channel on a recall_log row was a BOOLEAN:
# `timed_out`, `errored`, `deadline_hit`. So a log full of `errored: true`
# could not answer the first question anyone asks during an incident — is this
# a connection refused, a 500, a bad bank id, or an auth failure? Each implies
# a different fix, and the log distinguished none of them. Worse, `recall.py`
# exits 0 and Claude Code swallows hook stderr, so the exception text printed
# on the `[Hindsight]` line reaches nobody: the JSONL row is the ONLY place
# this information can survive.
ERROR_TEXT_MAX_CHARS = 300


def error_text(err) -> str | None:
    """One-line, bounded, type-prefixed rendering of a failure. None when clean.

    Type-prefixed because the message alone is often uselessly generic
    (`''`, `'timed out'`); the exception class is frequently the most
    diagnostic part. Bounded because rows are size-trimmed by line count and
    an unbounded traceback-shaped message would evict real history.
    """
    if err is None:
        return None
    if isinstance(err, BaseException):
        text = f"{type(err).__name__}: {err}"
    else:
        text = str(err)
    text = " ".join(text.split())
    if not text:
        return None
    return text[:ERROR_TEXT_MAX_CHARS]


def recall_error_summary(bank_id, bank_timings, directives_timed_out=None) -> str | None:
    """One row-level string answering "what actually failed on this turn?".

    The per-bank `error` strings are the ground truth, but a row-level field is
    what makes the log GREPPABLE: an operator triaging an incident wants
    `jq -r .error recall_log.jsonl | sort | uniq -c`, not a nested walk.

    Own bank first, because a side-bank failure does not mean the agent lost
    its memory (same rationale as `degraded_recall_notice`). Side banks are
    reported only when the own bank was fine, and are prefixed with their bank
    id so the summary is never ambiguous about whose failure it names.
    """
    entries = [bt for bt in (bank_timings or []) if isinstance(bt, dict)]
    own = next((bt for bt in entries if bt.get("bank_id") == bank_id), None) if bank_id else None
    if own and own.get("error"):
        return error_text(own["error"])
    for bt in entries:
        if bt.get("bank_id") != bank_id and bt.get("error"):
            return error_text(f"additional bank '{bt.get('bank_id')}': {bt['error']}")
    if directives_timed_out:
        return "directives fetch timed out"
    return None


def degraded_recall_notice(bank_id, bank_timings) -> str:
    """Switchroom #3619 — return the degraded-recall disclosure for this turn,
    or "" when the agent's own bank answered.

    Until now a recall whose own bank timed out was indistinguishable, from the
    agent's side, from a bank that genuinely held nothing relevant: both
    produced an empty block and silence. That ambiguity is what let a measured
    ~90% own-bank timeout rate run for weeks unnoticed while every agent's
    CLAUDE.md asserted recall "auto-fires on every inbound message" — the agent
    had no way to know it was answering from an empty context, so it never said
    so and the operator never saw it.

    Only the agent's OWN bank warrants the notice: additional banks (a shared
    profile bank, say) are supplementary, and a side-bank timeout does not mean
    the agent lost its own memory. Matching is by `bank_id`, never by position
    in `bank_timings` — the fan-out order is not stable.

    Kept to a single short line on purpose: this fires on an already-degraded
    turn, and a verbose block would spend the very budget the degradation is
    starving. The caller must keep it OUT of the cached context (see
    `_combine_context`) — it is per-turn state and would otherwise replay on a
    later healthy cache hit.
    """
    if not bank_id or not bank_timings:
        return ""
    own = next(
        (
            bt
            for bt in bank_timings
            if isinstance(bt, dict) and bt.get("bank_id") == bank_id
        ),
        None,
    )
    if not own:
        return ""
    if own.get("timed_out"):
        reason = "timed out"
    elif own.get("errored"):
        reason = "was unreachable"
    else:
        return ""
    return (
        f"[Hindsight] Memory recall was DEGRADED this turn: your own bank "
        f"('{bank_id}') {reason}, so the memories below (if any) are "
        f"incomplete and may be missing entirely. Treat an absence of "
        f"relevant memory as UNKNOWN, not as 'nothing was remembered' — "
        f"say so rather than asserting there is no prior context."
    )


def main():
    _begin_hook_budget()
    config = load_config()

    if not config.get("autoRecall"):
        debug_log(config, "Auto-recall disabled, exiting")
        return

    # Read hook input from stdin
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        print("[Hindsight] Failed to read hook input", file=sys.stderr)
        return

    debug_log(config, f"Hook input keys: {list(hook_input.keys())}")

    # Extract user query — hooks-reference.md documents "prompt", but some
    # Claude Code sources reference "user_prompt". Accept both defensively.
    prompt = (hook_input.get("prompt") or hook_input.get("user_prompt") or "").strip()
    if not prompt or len(prompt) < 5:
        debug_log(config, "Prompt too short for recall, skipping")
        return

    # M4 P-REC junk gate: `<task-notification>` is the CLI-native envelope a
    # sub-agent's own scheduler/harness prepends on a synthetic follow-up
    # turn — distinct from the gateway's `<channel source=...>` wrapper
    # (a real user message) and from `is_synthetic_inbound`. Recall on a
    # task-notification turn burns latency/cost on a turn no human is
    # waiting on and whose "query" is machine-generated noise, not intent.
    # Deterministic prefix check only — never a content classifier. On by
    # default (`recallSkipTaskNotification`); flips off for an agent that
    # deliberately wants recall on these turns.
    if config.get("recallSkipTaskNotification", True) and prompt.startswith("<task-notification"):
        # #4756 F2: skip the noisy NON-directive recall, but directives are
        # exempt — they are HARD RULES that apply on every turn, synthetic or
        # not, so still fetch + inject the active directives block. Only the
        # observation/world memory classes (the `recall` result set) are
        # suppressed here; `_emit_directives_only` never touches `recall`.
        debug_log(config, "Prompt is a task-notification envelope, skipping recall (directives exempt)")
        _emit_directives_only(config, hook_input)
        return

    # M4 P-REC Fix C (consumer side) — the whole prefetch-buffer mechanism
    # is gated by `memoryPrefetchEnabled`, default OFF/falsy. When on, try
    # the buffer-join fast path first; on any hit (fresh or stale-fallback)
    # it emits and returns, short-circuiting the synchronous recall below.
    # A miss (disabled, cold-start, buffer absent, or any internal error)
    # falls through to the existing synchronous path untouched.
    if config.get("memoryPrefetchEnabled", False):
        try:
            if _handle_prefetch_buffer(config, hook_input, prompt):
                return
        except Exception as exc:  # pragma: no cover - defensive, never break recall
            debug_log(config, f"Prefetch buffer join failed, falling back to sync recall: {exc}")

    # Switchroom-local: skip recall on conversational acks.
    #
    # The 5-char short-circuit catches `ok`/`yes`/`no`/`ty` but passes
    # longer acks like `thanks!`, `got it`, `see you tomorrow` that
    # don't benefit from recall. Recall costs ~1-2s (low budget) to
    # ~5s (mid budget) per turn — wasted on "I acknowledge" replies
    # where the model is going to produce a one-liner regardless of
    # what came back.
    #
    # Strip the optional `<channel ...>` wrapper that telegram-plugin
    # prepends on inbound, then trim common trailing punctuation/emoji.
    # Conservative match — we'd rather pay the recall cost on a
    # borderline case than miss memory on a real query.
    _stripped = prompt
    _channel_close = _stripped.find(">")
    if _stripped.startswith("<channel") and _channel_close != -1:
        _stripped = _stripped[_channel_close + 1:]
    _stripped = _stripped.replace("</channel>", "").strip()
    _ack_form = _stripped.lower().strip(" \t\n\r.,!?…👍👌✅🆗🙏")
    ACK_PHRASES = frozenset({
        "ok", "okay", "k", "kk", "yes", "yep", "yup", "yeah", "y",
        "no", "nope", "nah", "n",
        "ty", "thanks", "thank you", "thx", "cheers",
        "got it", "gotcha", "understood", "noted", "roger",
        "sure", "sure thing", "alright", "all right",
        "see you", "see ya", "later", "bye", "good night", "goodnight",
        "great", "nice", "cool", "perfect",
        "👍", "👌", "✅", "🆗", "🙏",
    })
    if _ack_form in ACK_PHRASES:
        debug_log(config, f"Prompt is ack-only ({_ack_form!r}), skipping recall")
        return

    # Switchroom Phase 6a (RFC hindsight-synthesis-layers.md) — skip recall
    # on plausibly-stateless trivial asks (time/date/day, bare greetings)
    # when `recallSkipTrivial` is on. Same conservatism as the ack-skip:
    # a false negative (skipping a turn that DID need memory) costs the
    # remember-across-sessions continuity, so `_is_trivial_stateless`
    # bails the instant the prompt carries any personal/stateful signal
    # (a pronoun, a memory verb, "project", etc.). It only skips an exact
    # stateless form — never a content-classifier guess.
    if config.get("recallSkipTrivial", True) and _is_trivial_stateless(_ack_form, _stripped):
        debug_log(config, f"Prompt is trivial/stateless ({_ack_form!r}), skipping recall")
        return

    # Switchroom #2848 Stage B — directive-capture nudge. Deterministic
    # (regex) detection of correction / standing-rule-shaped inbound; when
    # it fires we append a terse advisory to the additionalContext telling
    # the model to persist the rule with create_directive if it IS durable.
    # Computed on `_stripped` (the channel-envelope-stripped text) so the
    # `<channel …>` wrapper never trips detection. Runs AFTER the ack/
    # trivial-skip gates (those return early and genuinely need no nudge)
    # and leaves the recall/directive path below untouched — it only adds
    # to whatever additionalContext that path emits. On by default;
    # HINDSIGHT_DIRECTIVE_CAPTURE_NUDGE=false (or memory.directive_capture_nudge:
    # false) turns it off. No model callsite (claude-native invariant).
    nudge_block = None
    if config.get("directiveCaptureNudge", True) and looks_like_standing_rule(_stripped):
        nudge_block = _DIRECTIVE_CAPTURE_NUDGE
        debug_log(config, "Directive-capture nudge: inbound looks like a standing rule")

    # Switchroom P2 (memory-redesign RFC §5) — anchor recall to the ask-time
    # when the inbound prompt is time-relative, so the engine resolves "last
    # week"/"yesterday"/"on the 12th" against the real now and scores recency
    # from it. Deterministic regex on `_stripped` (same channel-stripped text
    # the nudge uses); no model call, microsecond cost, off the network path.
    # `None` when the prompt has no temporal phrase → the field is never added
    # to the recall body (byte-identical to pre-P2). The `recallQueryTimestamp`
    # key is an IN-CODE guard only — it has NO schema/scaffold/env surface, so
    # a settings.json edit would be clobbered on the next `switchroom apply`
    # (the plugin dir is re-copied from vendor/). Per RFC P2 the rollback is
    # "stop sending the field" = revert the commit; if a runtime knob is ever
    # wanted, wire it the full schema->scaffold->config->env way
    # `directiveCaptureNudge` is, not by hand-editing settings.json.
    query_timestamp = None
    if config.get("recallQueryTimestamp", True):
        query_timestamp = detect_query_timestamp(_stripped)
        if query_timestamp:
            debug_log(config, "Recall query_timestamp anchor: inbound is time-relative")

    # RFC phase4 P3 — operator-profile capture nudge. Independent second nudge
    # class: deterministic (regex) detection of a first-person durable
    # self-statement by the operator; when it fires we append a terse advisory
    # telling the model to persist it with an explicit retain carrying a
    # `profile:ken` tag into the agent's OWN bank (RFC §0 constraint 2 forbids a
    # cross-agent person bank). Computed on `_stripped` like the directive
    # nudge, so the `<channel …>` wrapper never trips it. Both nudges may fire
    # on one turn (e.g. "I prefer …" is both preference and profile-shaped) —
    # they give different advice (create_directive vs profile:ken retain) and
    # are combined independently at emit time. On by default;
    # HINDSIGHT_PROFILE_CAPTURE_NUDGE=false (or memory.profile_capture_nudge:
    # false) turns it off. No model callsite (claude-native invariant).
    profile_nudge_block = None
    if config.get("profileCaptureNudge", True) and looks_like_profile_statement(_stripped):
        profile_nudge_block = _PROFILE_CAPTURE_NUDGE
        debug_log(config, "Profile-capture nudge: inbound states a durable operator fact")

    session_id = hook_input.get("session_id") or ""

    # Switchroom #303 — push a "📚 recalling memories" status to the
    # user's pre-allocated Telegram draft so the gap between inbound and
    # the model's first content token isn't 25 s of dead air. No
    # trailing ellipsis: sendMessageDraft already animates a "typing"
    # indicator on the user's client, so a `…` is redundant noise.
    # Best-effort and silent on every failure path; the gateway no-ops
    # the IPC message when there's no draft for this chat (forum topic,
    # fresh session before pre-alloc lands, etc.).
    placeholder_chat_id = extract_chat_id_from_prompt(prompt)
    if placeholder_chat_id:
        update_placeholder(placeholder_chat_id, "📚 recalling memories")

    # PR6a — supergroup-mode topic context for the current turn.
    # active_thread_id is the message_thread_id from the inbound
    # envelope, used to (a) key the cache so cross-topic prompts
    # don't collide, (b) optionally hard-filter memories by source
    # topic, and (c) log source-vs-active distribution for
    # binding-failure instrumentation.
    active_chat_id, active_thread_id = extract_topic_from_prompt(prompt)
    active_topic_alias = None
    if active_thread_id is not None:
        aliases_json = os.environ.get("HINDSIGHT_TOPIC_ALIASES_JSON", "")
        if aliases_json:
            try:
                aliases = json.loads(aliases_json)
                if isinstance(aliases, dict):
                    inverse = {str(v): k for k, v in aliases.items()}
                    active_topic_alias = inverse.get(str(active_thread_id))
            except (json.JSONDecodeError, ValueError, TypeError):
                pass

    # Resolve API URL (handles all three connection modes)
    def _dbg(*a):
        debug_log(config, *a)

    try:
        api_url = get_api_url(config, debug_fn=_dbg, allow_daemon_start=False)
    except RuntimeError as e:
        print(f"[Hindsight] {e}", file=sys.stderr)
        return

    api_token = config.get("hindsightApiToken")
    try:
        client = HindsightClient(api_url, api_token)
    except ValueError as e:
        print(f"[Hindsight] Invalid API URL: {e}", file=sys.stderr)
        return

    # Derive bank ID (static or dynamic from project context)
    bank_id = derive_bank_id(hook_input, config)
    additional_banks = config.get("recallAdditionalBanks", []) or []

    # Switchroom (per-speaker memory routing, RFC
    # reference/rfcs/per-speaker-memory-routing.md): when this agent serves
    # multiple trusted users, also recall the *speaker's* profile bank. The
    # sender is in the `<channel user="...">` envelope; the sender→bank map is
    # injected as HINDSIGHT_SENDER_BANKS_JSON ({"<username-or-id>": "<bank>"}).
    # Additive — never replaces the agent's own bank, never an auth boundary
    # (single-tenant). Failure-safe + silent on every error path.
    active_sender = extract_user_from_prompt(prompt)
    additional_banks = _resolve_sender_bank(
        os.environ.get("HINDSIGHT_SENDER_BANKS_JSON", ""),
        active_sender,
        bank_id,
        additional_banks,
    )

    # Upstream 962140eef — optional recall tag filters. Resolved BEFORE the
    # cache check so the tag-filter fingerprint is part of the cache key
    # (filters change the result set for an identical query). Per-bank
    # overrides in recallAdditionalBankFilters apply to any additional bank —
    # including sender banks appended by _resolve_sender_bank above.
    recall_tags = config.get("recallTags") or None
    tag_groups = config.get("recallTagGroups") or None
    tags_match = config.get("recallTagsMatch") if recall_tags or tag_groups else None
    additional_bank_filters = config.get("recallAdditionalBankFilters") or {}
    if not isinstance(additional_bank_filters, dict):
        additional_bank_filters = {}
    tag_filter_sig = _tag_filter_sig(recall_tags, tags_match, tag_groups, additional_bank_filters)

    # Switchroom #424 phase 4.1 — cache check BEFORE any HTTP traffic.
    # Whole-session-scoped, opt-in via HINDSIGHT_RECALL_CACHE_TTL_SECS.
    cache_ttl = _cache_ttl_secs()
    cache_key = (
        _cache_key(
            session_id,
            prompt,
            bank_id,
            additional_banks,
            active_thread_id,
            active_sender,
            tag_filter_sig,
        )
        if cache_ttl > 0
        else ""
    )
    if cache_ttl > 0:
        try:
            cached_context = _cache_lookup(cache_key, cache_ttl)
        except Exception as e:
            debug_log(config, f"Recall cache read failed (non-fatal): {e}")
            cached_context = None
        if cached_context is not None:
            debug_log(config, f"Recall cache HIT (key={cache_key[:12]}…) — skipping API call")
            # #2848 — append the nudge to the cached context at emit time
            # (the cache stores nudge-free context; the nudge is re-derived
            # from the current prompt, so a hit can't replay a stale one).
            _emit_cached_context(
                _combine_context(
                    _combine_context(cached_context, nudge_block), profile_nudge_block
                )
            )
            _write_recall_log({
                "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "session_id": (session_id or "")[:32],
                "bank_id": bank_id,
                "additional_banks": additional_banks,
                "query_chars": len(prompt),
                "query": None,  # no recall query composed on a cache hit
                "result_count": None,  # not known on cache hit
                "directive_count": None,
                # No directives block is built on a cache hit.
                "directives_omitted": None,
                # Same reason — a cache hit replays a formatted context
                # block, not a fetched directive list, so there is nothing
                # to derive the injected id set from this turn.
                "directive_ids": None,
                "demoted_count": 0,
                # #3837 score-floor fields, present for a uniformly queryable
                # schema. A cache hit replays a formatted context block, not a
                # result set, so the floor cannot have run: None (not 0.0/False)
                # so a cache-hit row is never counted as an observed
                # floor-disabled turn.
                "min_score_floor": None,
                "min_score_scope": None,
                "min_score_applied": None,
                "dropped_below_min_score": None,
                "capped": False,
                # #3541 quality telemetry — present for a uniformly queryable
                # schema. A cache hit replays a formatted context block, not a
                # result set, so no per-memory scores exist to aggregate.
                "injected_score_min": None,
                "injected_score_median": None,
                "injected_score_max": None,
                # Bank-composition telemetry — present for a uniformly queryable
                # schema. Same reason as the score fields above: a cache hit
                # replays a formatted block, not a per-bank result set.
                "injected_own_bank_count": None,
                "injected_additional_bank_count": None,
                "reserved_own_slots": None,
                "reserved_additional_slots": None,
                "cache_hit": True,
                # A3 stage-1 telemetry keys kept present for a uniformly
                # queryable schema; a cache hit issues no bank HTTP, so there
                # is no per-bank timing and no deadline pressure to record.
                # All are None/[] (NOT False) so a cache-hit row is never
                # miscounted as an observed no-timeout recall in the breach
                # baseline — `deadline_hit is False` means "banks ran, none
                # timed out"; `deadline_hit is None` means "no banks ran"
                # (review finding 3).
                "total_elapsed_ms": None,
                # Switchroom recall-latency instrumentation — full-hook wall time
                # (import + stdin + cache check), measured to this log write. A
                # cache hit issues no bank HTTP, so `total_elapsed_ms` is None and
                # this is pure local overhead — the cheap path this cache exists
                # to create, now visible per-row.
                "duration_ms": _hook_duration_ms(),
                "directives_elapsed_ms": None,
                "bank_timings": [],
                "deadline_hit": None,
                # A3 — no banks ran on a cache hit, so mode/deadline are null
                # for a uniformly queryable schema (never "serial"/"parallel").
                "recall_mode": None,
                "deadline_budget_ms": None,
                "deadline_effective_ms": None,
                "directives_timed_out": None,
                # PR6 — record the active topic on cache hits too so the
                # log is uniformly queryable (cache_key now includes
                # active_thread_id, so a hit means the prior recall was
                # for the same topic — no source_topics inferable here).
                "active_thread_id": active_thread_id,
                "active_topic_alias": active_topic_alias,
                "topic_filter_mode": _topic_filter_mode(),
                "directive_nudge": bool(nudge_block),
                # Switchroom P2 — the ISO ask-time anchor sent to recall, or
                # null when the inbound had no temporal phrase. Logged on cache
                # hits too (no bank ran, so nothing was sent this turn) for a
                # uniformly queryable schema and to measure the firing rate
                # from day one (precedent: `directive_nudge` above).
                "query_timestamp": query_timestamp,
                # RFC P3 — profile-capture nudge firing rate, measurable from
                # day one (mirrors the directive_nudge precedent).
                "profile_nudge": bool(profile_nudge_block),
                # E1 / PR8 (#3369) — no banks ran on a cache hit, so the
                # transcript fallback never fires; carry the zeroed fields for a
                # uniformly queryable schema.
                "transcript_fallback": False,
                "transcript_fallback_turns": 0,
                "transcript_fallback_chars": 0,
                "transcript_fallback_bytes_read": 0,
                "transcript_fallback_elapsed_ms": 0,
                "transcript_fallback_truncated": False,
                # PR8 (#3369) — no banks ran on a cache hit, so no bank raised a
                # hard error. None (NOT False) so a cache-hit row is never
                # miscounted as an observed no-error recall — matching the
                # deadline_hit / directives_timed_out convention above.
                "bank_errored": None,
                # Switchroom structural-fix #7 — WHAT failed, in words. None
                # here (not "") for the same reason as the fields above: no
                # banks ran, so this row observed no failure and must not be
                # counted as one.
                "error": None,
            })
            return
        debug_log(config, f"Recall cache MISS (key={cache_key[:12]}…)")

    # Switchroom A3 stage-1 telemetry (hindsight-leverage PR 1). Wall-clock
    # start for the recall critical path (mission ensure + transcript read +
    # directives fetch + every bank recall). Feeds `total_elapsed_ms` in the
    # log so a fresh pre-parallelism (pre-A3) breach baseline can accrue.
    recall_start_monotonic = time.monotonic()

    # Set bank mission on first use
    ensure_bank_mission(client, bank_id, config, debug_fn=_dbg)

    # Multi-turn query composition
    recall_context_turns = config.get("recallContextTurns", 1)
    recall_max_query_chars = config.get("recallMaxQueryChars", 800)
    recall_roles = config.get("recallRoles", ["user", "assistant"])

    # Switchroom A1 (hindsight-leverage PR 1) — strip the <channel …> transport
    # envelope from the prompt ONCE, before both the single-turn and multi-turn
    # branches, so ~100-200 chars of chat_id/ts/user XML noise never reach the
    # embedding or consume the recallMaxQueryChars cap. `prompt` itself is left
    # untouched (the ack/nudge gates and cache-hit log-length field still want
    # the raw form); only the value fed to the recall query is stripped.
    # compose_recall_query also strips its latest_query internally (defence in
    # depth), but we strip here too so the single-turn path and
    # truncate_recall_query's latest_query arg are both envelope-free.
    recall_query_text = strip_channel_envelope(prompt)

    if recall_context_turns > 1:
        transcript_path = hook_input.get("transcript_path", "")
        # A2 latency bound: only parse the transcript tail (last N bytes) —
        # the human turns we slice for context live at the end.
        recall_transcript_tail_bytes = config.get("recallTranscriptTailBytes", 262144)
        messages = read_transcript_messages(transcript_path, recall_transcript_tail_bytes)
        debug_log(config, f"Multi-turn context: {recall_context_turns} turns, {len(messages)} messages from transcript")
        query = compose_recall_query(recall_query_text, messages, recall_context_turns, recall_roles)
    else:
        query = recall_query_text

    query = truncate_recall_query(query, recall_query_text, recall_max_query_chars)

    # Final defensive cap (mirrors Openclaw)
    if len(query) > recall_max_query_chars:
        query = query[:recall_max_query_chars]

    # Switchroom recall-latency fix (#3757) — bound the BM25 term count of the
    # query we put on the wire. `recallMaxQueryChars` bounds CHARACTERS, which
    # is not the cost driver: Hindsight OR-joins every token into one tsquery
    # and Postgres native FTS ranks the whole matched set before the top-60
    # heapsort, so cost tracks the number of DISTINCT TERMS. An 800-char
    # composed query is ~96 distinct terms and matched 119,510 rows on the
    # live `overlord` bank (14.0s for the 3-arm UNION, and up to 94s under
    # load) — past the 8s client timeout, which is why 96.8% of that agent's
    # own-bank recalls returned nothing. Shaped to 24 terms the same query
    # matches 48,433 rows in 2.5-2.8s.
    #
    # `search_query` is what the SERVER sees. `query` (unshaped) stays the
    # client-side lexical reference: the `recallMinOverlap` containment gate
    # and the transcript-grep fallback both measure against the user's real
    # words, so shaping cannot silently move their thresholds. `query_chars`
    # telemetry also stays on the unshaped value for continuity with the
    # existing recall_log history.
    search_query = shape_recall_query(
        query,
        recall_query_text,
        max_tokens=config.get("recallQueryMaxTokens", 24),
        stop_terms=config.get("recallQueryStopTerms") or (),
    )

    debug_log(
        config,
        f"Recalling from bank '{bank_id}', query length: {len(query)}, "
        f"search terms: {len(set(tokenize_for_bm25(search_query)))}",
    )

    # Fetch active directives FIRST (independent of recall — even if recall
    # finds no memories, an agent with active directives still needs them
    # surfaced every turn). Workaround for upstream bug
    # vectorize-io/hindsight#1269 (tagged directives silently dropped from
    # `reflect`); `list_directives` itself works correctly upstream, so this
    # is a pure client-side surface. fetch_active_directives_cached is
    # failure-safe and returns [] on any error.
    #
    # A4: cache the directives list with a short TTL (invalidated in-session by
    # directive_verify.py on a directive write) so the common no-write turn
    # skips the HTTP round-trip. TTL=0 disables the cache (live every turn).
    #
    # Switchroom hindsight-leverage A3 — the directives fetch and every bank
    # recall run CONCURRENTLY (daemon threads) under ONE shared deadline instead
    # of serially. Serially their latencies SUM (own bank + N extra banks +
    # directives), and a heavy multi-bank agent can breach the 12s
    # UserPromptSubmit ceiling — dropping recall for the turn. Parallel makes the
    # critical path the SLOWEST slot, bounded by `recallParallelDeadlineSeconds`
    # (the hook ceiling minus 2s headroom). A slot still running at the deadline
    # is abandoned (daemon thread, reaped on process exit) and marked timed_out —
    # a straggler bank can never push the hook past its ceiling.
    # HINDSIGHT_RECALL_PARALLEL=false restores the serial path (rollback lever).
    # The directives slot composes with the A4 cache: on a cache HIT it returns
    # near-instantly with no HTTP, so directives_elapsed_ms reads ~0.

    def _directives_task():
        return fetch_active_directives_cached(
            client,
            bank_id,
            ttl_seconds=config.get("directivesCacheTtlSeconds", DIRECTIVES_CACHE_TTL_SECONDS),
        )

    try:
        recall_request_timeout = float(config.get("recallRequestTimeoutSeconds", 12))
    except (TypeError, ValueError):
        recall_request_timeout = 12.0
    if recall_request_timeout <= 0:
        recall_request_timeout = 12.0

    # Fail-safe the recall `types` BEFORE any bank task runs: the 0.9.0 engine
    # 422s an invalid fact type (e.g. an operator typo "observations"/"fact" in
    # memory.recall.types), which fails the whole recall and drops memory
    # injection for the turn. filter_recall_types drops unknowns (shouting on
    # stderr) and falls back to the default set if the filter empties it — it
    # never raises. Computed once here so every bank in the fan-out sends the
    # same validated set.
    resolved_recall_types = filter_recall_types(config)

    def _make_bank_task(target_bank_id, b_tags, b_tags_match, b_tag_groups, timeout_override=None):
        def _bank_task():
            # Switchroom P2 — include the ask-time anchor ONLY when the prompt
            # was time-relative. Passing it conditionally (not as `=None`) keeps
            # the client CALL — not just the wire body — byte-identical on the
            # common non-temporal turn, so a caller/fake with a narrower recall
            # signature is never handed a kwarg it did not have before.
            qts_kwarg = {"query_timestamp": query_timestamp} if query_timestamp else {}
            return client.recall(
                bank_id=target_bank_id,
                query=search_query,
                max_tokens=config.get("recallMaxTokens", 1024),
                budget=config.get("recallBudget", "mid"),
                types=resolved_recall_types,
                # Upstream 962140eef — optional per-bank tag filters (resolved
                # above the cache check; part of the cache key).
                tags=b_tags,
                tags_match=b_tags_match,
                tag_groups=b_tag_groups,
                # Switchroom Phase-1 precision — prefer deduped observation
                # statements over the raw facts they supersede, backfilling freed
                # slots for denser coverage inside the same budget. On by default;
                # operators can pin off via `recallPreferObservations: false`.
                prefer_observations=config.get("recallPreferObservations", True),
                # Per-request in-script timeout: even parallelised, each bank
                # carries its own hard deadline so a single hung bank returns
                # cleanly with no memories rather than sitting on the shared
                # deadline. Tightened from 10s to 8s in v0.13.22 (2026-05-24
                # breach audit); the shared deadline below is the outer ceiling
                # guard.
                #
                # Switchroom #3757: no longer a hardcoded literal. It was the
                # binding constraint on a slow bank (96.8% of overlord's
                # own-bank recalls hit exactly 8s and returned NOTHING), and a
                # hand-patch of the installed copy does not survive
                # `switchroom apply` — the plugin dir is re-copied from
                # `vendor/hindsight-memory` on every reconcile. Default raised
                # to 12s, matching the UserPromptSubmit hook's own 12s budget
                # (hooks/hooks.json). Note the SHARED multi-bank deadline
                # (`recallParallelDeadlineSeconds`, default 10s) is the tighter
                # outer bound in the default configuration, so at the default
                # this timeout only binds when an operator raises that. SAFETY
                # NET behind the query-shaping fix above, not the fix.
                # Operator knob: `memory.recall.request_timeout_seconds`.
                timeout=(
                    recall_request_timeout
                    if timeout_override is None
                    else timeout_override
                ),
                # Switchroom P2 — present only on a time-relative turn (see above).
                **qts_kwarg,
            )
        return _bank_task

    # Resolve (bank_id, tags, tags_match, tag_groups) for every bank we query —
    # own bank first, then each additional bank in config order. This order is
    # preserved for bank_timings and the result-merge sequence regardless of
    # thread completion order, so the emitted telemetry is deterministic.
    # `additional_banks` was extracted above the cache check (so the cache key
    # reflects every bank queried); reuse that local.
    bank_specs = [(bank_id, recall_tags, tags_match, tag_groups)]
    for extra_bank_id in additional_banks:
        # Upstream 962140eef — per-bank tag-filter overrides; fall back to the
        # global filters when the bank has no entry. Applies uniformly to
        # config-listed banks and sender banks appended by _resolve_sender_bank.
        extra_filter = additional_bank_filters.get(extra_bank_id, {})
        if not isinstance(extra_filter, dict):
            extra_filter = {}
        extra_tags = extra_filter.get("recallTags", recall_tags) or None
        extra_tag_groups = extra_filter.get("recallTagGroups", tag_groups) or None
        extra_tags_match = extra_filter.get(
            "recallTagsMatch",
            tags_match if extra_tags or extra_tag_groups else None,
        )
        bank_specs.append((extra_bank_id, extra_tags, extra_tags_match, extra_tag_groups))

    recall_parallel = bool(config.get("recallParallel", True))
    try:
        deadline_seconds = float(config.get("recallParallelDeadlineSeconds", 10))
    except (TypeError, ValueError):
        deadline_seconds = 10.0

    directives = []
    directives_timed_out = False
    bank_timings = []
    results = []

    if recall_parallel:
        recall_mode = "parallel"
        deadline_budget_ms = int(deadline_seconds * 1000)
        # The shared deadline is measured from recall_start_monotonic (the top
        # of the critical path), so mission-ensure + transcript read already
        # spent budget: subtract what elapsed so the remaining wait still
        # respects the ceiling-minus-2s guarantee.
        already_spent = time.monotonic() - recall_start_monotonic
        remaining_deadline = max(0.0, deadline_seconds - already_spent)
        # `deadline_budget_ms` is the CONFIGURED budget; the wait the slots
        # actually get is `remaining_deadline` after pre-fan-out spend. Log both
        # so the breach baseline can tell "configured" from "effectively granted".
        deadline_effective_ms = int(remaining_deadline * 1000)

        tasks = {DIRECTIVES_SLOT: _directives_task}
        for spec in bank_specs:
            tasks[spec[0]] = _make_bank_task(spec[0], spec[1], spec[2], spec[3])
        outcomes = run_parallel(tasks, remaining_deadline)

        # Directives slot. A slot that hit the deadline OR raised yields [] —
        # the same failure-safe contract fetch_active_directives_cached honours.
        d_outcome = outcomes[DIRECTIVES_SLOT]
        directives_elapsed_ms = d_outcome.elapsed_ms if d_outcome.elapsed_ms is not None else 0
        directives_timed_out = not d_outcome.completed
        if d_outcome.completed and isinstance(d_outcome.value, list):
            directives = d_outcome.value
        elif directives_timed_out:
            debug_log(config, "Directives slot hit the shared recall deadline")
        elif d_outcome.error is not None:
            debug_log(config, f"Directives fetch failed: {d_outcome.error}")

        # Bank slots, own-bank first in config order. A bank is timed_out if it
        # did not complete before the shared deadline OR completed by raising a
        # hard timeout error (the finalized `deadline_hit` semantics — an
        # abandoned straggler now counts, which the serial-era per-request-only
        # flag could not express).
        for spec in bank_specs:
            b_id = spec[0]
            b_outcome = outcomes[b_id]
            b_timed_out = (not b_outcome.completed) or (
                b_outcome.error is not None and _is_timeout_error(b_outcome.error)
            )
            # Switchroom review finding (PR8 gating hole) — a bank that raised a
            # HARD (non-timeout) error: connection refused, 5xx, daemon down,
            # malformed response. Distinct from `timed_out` so the transcript
            # fallback can be suppressed on a genuine outage (the fact layer was
            # unreachable, not "empty because nothing reconciled yet").
            b_errored = b_outcome.error is not None and not _is_timeout_error(b_outcome.error)
            if b_outcome.completed and b_outcome.error is None:
                bank_results = (
                    b_outcome.value.get("results", [])
                    if isinstance(b_outcome.value, dict)
                    else []
                )
                if bank_results:
                    debug_log(config, f"Got {len(bank_results)} memories from bank '{b_id}'")
                    results = results + _tag_source_bank(bank_results, b_id)
            elif b_outcome.error is not None:
                # Own bank failure surfaces on stderr (journald signal); extra
                # banks are debug-only, matching the pre-A3 serial behaviour.
                if b_id == bank_id:
                    print(f"[Hindsight] Recall failed: {b_outcome.error}", file=sys.stderr)
                else:
                    debug_log(config, f"Recall from additional bank '{b_id}' failed: {b_outcome.error}")
            elif not b_outcome.completed:
                debug_log(config, f"Recall from bank '{b_id}' hit the shared deadline")
            bank_timings.append({
                "bank_id": b_id,
                "elapsed_ms": b_outcome.elapsed_ms if b_outcome.elapsed_ms is not None else 0,
                "timed_out": b_timed_out,
                "errored": b_errored,
                # The failure TEXT, not just the flags. On the parallel path a
                # slot abandoned at the shared deadline carries no exception at
                # all, so name that case explicitly rather than logging null
                # and leaving "why is this row empty" unanswerable.
                "error": error_text(b_outcome.error)
                or (None if b_outcome.completed else "abandoned at the shared recall deadline"),
            })
    else:
        # Pre-A3 serial path (rollback lever, HINDSIGHT_RECALL_PARALLEL=false).
        # Directives first, then each bank in turn — total latency is the SUM of
        # the round-trips. Behaviourally equivalent to the pre-parallelism path
        # (log rows stay comparable), NOT byte-for-byte: this path emits an extra
        # own-bank debug line, logs the directives block after the bank loop
        # rather than before, and __main__ still os._exit(0)s on completion.
        recall_mode = "serial"
        # #3760 review, Major 4. This path has no outer deadline — bank
        # latencies SUM — so raising the per-bank timeout 8s -> 12s would let
        # two banks spend 24s against a 12s hook ceiling. Each bank is instead
        # clamped to whatever the hook has left when its turn comes, so the
        # serial path can no longer breach the ceiling no matter how many banks
        # are configured. `deadline_budget_ms` stays None on the log row: this
        # is a per-bank clamp, not the parallel path's shared deadline, and
        # conflating them would corrupt the serial-vs-parallel comparison.
        deadline_budget_ms = None
        deadline_effective_ms = None
        _directives_start = time.monotonic()
        directives = fetch_active_directives_cached(
            client,
            bank_id,
            ttl_seconds=config.get("directivesCacheTtlSeconds", DIRECTIVES_CACHE_TTL_SECONDS),
        )
        directives_elapsed_ms = int((time.monotonic() - _directives_start) * 1000)
        for spec in bank_specs:
            b_id, b_tags, b_tags_match, b_tag_groups = spec
            _bank_start = time.monotonic()
            _bank_timed_out = False
            _bank_errored = False
            _bank_error = None
            try:
                _bank_budget = _remaining_hook_budget_seconds()
                if _bank_budget <= 0:
                    raise TimeoutError(
                        f"hook budget exhausted before bank '{b_id}' was queried"
                    )
                response = _make_bank_task(
                    b_id,
                    b_tags,
                    b_tags_match,
                    b_tag_groups,
                    timeout_override=min(recall_request_timeout, _bank_budget),
                )()
                bank_results = response.get("results", []) if isinstance(response, dict) else []
                if bank_results:
                    debug_log(config, f"Got {len(bank_results)} memories from bank '{b_id}'")
                    results = results + _tag_source_bank(bank_results, b_id)
            except Exception as e:
                _bank_timed_out = _is_timeout_error(e)
                # Non-timeout error → hard outage (see parallel-path note above).
                _bank_errored = not _bank_timed_out
                _bank_error = error_text(e)
                if b_id == bank_id:
                    print(f"[Hindsight] Recall failed: {e}", file=sys.stderr)
                else:
                    debug_log(config, f"Recall from additional bank '{b_id}' failed: {e}")
            bank_timings.append({
                "bank_id": b_id,
                "elapsed_ms": int((time.monotonic() - _bank_start) * 1000),
                "timed_out": _bank_timed_out,
                "errored": _bank_errored,
                "error": _bank_error,
            })

    # Switchroom hindsight-leverage A3 — FINALIZED `deadline_hit`: True when ANY
    # slot on the critical path hit its deadline (a bank that raised a hard
    # per-request timeout, or — parallel mode — a bank/directives slot abandoned
    # at the shared deadline). Hoisted here (was inline in the recall_log write)
    # so the E1 / PR8 transcript fallback can gate on it: the #3369 fallback must
    # NOT fire when a bank timed out, only when the fact layer is genuinely empty.
    deadline_hit = any(bt["timed_out"] for bt in bank_timings) or directives_timed_out

    # Switchroom review finding (PR8 gating hole) — True when ANY bank raised a
    # HARD (non-timeout) error. A connection-refused / 5xx / daemon-down outage
    # contributes zero results with `deadline_hit` False, which would otherwise
    # let the empty-fact-layer transcript fallback fire on every turn for the
    # whole outage — mislabelling "fact layer unreachable" as "nothing
    # reconciled yet" and flooding telemetry. Gated on below so the fallback
    # only fires when all banks genuinely returned zero: no timeout AND no error.
    bank_errored = any(bt.get("errored") for bt in bank_timings)

    directives_block = format_active_directives_block(directives) if directives else None
    if directives_block:
        debug_log(config, f"Injecting {len(directives)} active directives")

    # Switchroom #432 phase 4.4 — drop demote-tagged memories before
    # the cap. Filtering early means the cap kicks in over the
    # non-demoted set (i.e. the user gets up to N "real" hits,
    # not N including ones they explicitly demoted).
    pre_filter_count = len(results)
    results = [m for m in results if not _is_demoted_memory(m)]
    demoted_count = pre_filter_count - len(results)
    if demoted_count > 0:
        debug_log(config, f"Filtered {demoted_count} demote-from-recall memories")

    # PR6 — capture source-topic distribution BEFORE optional
    # hard-filter so we can log the would-have-leaked count for
    # binding-failure analysis. Computed unconditionally so the
    # log row carries this for soft-preamble mode too (the
    # whole point is to instrument binding rate over time).
    source_topic_summary = _summarise_source_topics(results)

    # PR6b — optional hard topic filter. Default soft-preamble (no-op);
    # operator flips HINDSIGHT_TOPIC_FILTER_MODE=hard-filter when
    # binding failures are observed. See _filter_by_active_topic and
    # the TOPIC_FILTER_MODE_ENV comment block above for design notes.
    topic_filter_mode = _topic_filter_mode()
    topic_dropped = 0
    if topic_filter_mode == "hard-filter":
        results, topic_dropped = _filter_by_active_topic(results, active_thread_id)
        if topic_dropped > 0:
            debug_log(
                config,
                f"Topic hard-filter dropped {topic_dropped} cross-topic "
                f"memories (active_thread_id={active_thread_id})",
            )

    # Switchroom hindsight-leverage PR5 — per-tag score penalty. Applied
    # IMMEDIATELY before the relevance sort so a down-weighted tag (e.g.
    # `sidechain: 0.8`) reorders the merged set without dropping anything. This
    # is the "reduced weight" the demote-tag DROP filter above cannot express:
    # a penalised memory ranks below equal-scoring untagged memories yet still
    # survives the cap when it is the only relevant hit. See _apply_tag_weights.
    tag_weights = _effective_tag_weights(config)
    weighted = _apply_tag_weights(results, tag_weights)
    if weighted > 0:
        debug_log(config, f"Applied recallTagWeights to {weighted} memories: {tag_weights}")

    # Switchroom Phase-1 precision — sort the merged primary + additional-bank
    # result set by the engine's relevance score (`scores.final`) descending
    # BEFORE the head-slice cap below. Previously additional-bank results were
    # appended after own-bank results and sliced off, silently starving
    # profile / shared / sender banks whenever own-bank filled the cap. Sorting
    # by real relevance first means the cap keeps the most relevant memories
    # regardless of source bank. Stable sort: ties keep own-bank-first order.
    _sort_by_final_score(results)

    # Switchroom #3619 — DEGRADED-RECALL DISCLOSURE. Computed HERE rather than
    # at emit time because the #3837 score floor is scoped by it: the same
    # single source of truth for "the agent's own bank did not answer" decides
    # both whether the floor binds and what the agent is told. See
    # `degraded_recall_notice` for why only the agent's OWN bank counts.
    degraded_block = degraded_recall_notice(bank_id, bank_timings)

    # Switchroom #3837 — opt-in absolute score floor. Runs AFTER the tag
    # weights and the relevance sort (so it judges the same effective
    # `scores.final` the ranking used) and BEFORE the head-slice cap, so the
    # cap sees only survivors. Disabled by default (`recallMinScore` 0.0);
    # when set it binds on degraded turns only unless the operator widens
    # `recallMinScoreScope` to "all". The design note above
    # `_filter_by_min_score` carries the measurement, and why #3761's "no
    # replacement floor" finding is not contradicted by this.
    min_score_floor = config.get("recallMinScore", 0.0)
    if isinstance(min_score_floor, bool) or not isinstance(min_score_floor, (int, float)):
        min_score_floor = 0.0
    min_score_floor = float(min_score_floor)
    min_score_scope = config.get("recallMinScoreScope", "degraded")
    if min_score_scope not in ("degraded", "all"):
        min_score_scope = "degraded"
    min_score_applied = min_score_floor > 0 and (
        min_score_scope == "all" or bool(degraded_block)
    )
    dropped_below_min_score = 0
    if min_score_applied:
        pre_min_score_count = len(results)
        results, dropped_below_min_score = _filter_by_min_score(
            results, min_score_floor
        )
        if dropped_below_min_score > 0:
            debug_log(
                config,
                f"Score floor dropped {dropped_below_min_score}/"
                f"{pre_min_score_count} memories below scores.final "
                f"{min_score_floor} (scope={min_score_scope})",
            )

    # Switchroom-local: client-side count cap. Plugin v0.4.0 has no
    # `recallTopK` in the Claude Code integration (Openclaw-only), and a
    # token budget alone doesn't bound count — a single long memory can
    # blow past intended caps, while many short ones can flood the prompt.
    # Slice the combined results from primary + additional banks before
    # formatting. <= 0 disables the cap.
    recall_max_memories = config.get("recallMaxMemories", 0)
    pre_cap_count = len(results)
    capped = False
    reserved_own = 0
    reserved_additional = 0
    if (
        isinstance(recall_max_memories, int)
        and recall_max_memories > 0
        and len(results) > recall_max_memories
    ):
        debug_log(
            config,
            f"Capping {len(results)} memories to {recall_max_memories} "
            f"(set HINDSIGHT_RECALL_MAX_MEMORIES=0 to disable)",
        )
        # Switchroom — per-bank slot reservation. Head-slicing a globally sorted
        # merged set is winner-take-all across banks: when both banks return more
        # candidates than the cap, one bank's score distribution can fill every
        # slot and the agent's own working memory is crowded out entirely.
        # Guarantee a floor to each side (bounded to half the cap) before the
        # remaining slots go to pure global relevance. This addresses score-based
        # crowd-out only — a timed-out bank contributes no candidates and
        # reservation is a no-op there; see _reserve_bank_slots for the measured
        # share of turns it can bind on. Floors of 0/0 restore the head-slice.
        results, reserved_own, reserved_additional = _reserve_bank_slots(
            results,
            recall_max_memories,
            bank_id,
            config.get("recallOwnBankMinSlots", 0),
            config.get("recallAdditionalBankMinSlots", 0),
        )
        if reserved_own or reserved_additional:
            debug_log(
                config,
                f"Bank slot reservation promoted {reserved_own} own-bank / "
                f"{reserved_additional} additional-bank memories over "
                f"higher-scoring ones",
            )
        capped = True

    memories_block = None
    if results:
        debug_log(config, f"Injecting {len(results)} memories")
        # Format context message — exact match of Openclaw's format
        memories_formatted = format_memories(results)
        preamble = config.get("recallPromptPreamble", "")
        current_time = format_current_time()

        # PR6 — supergroup-mode topic preamble (neutral tone per
        # 2026-05-27 product decision). Only added when we know the
        # active topic AND any of the recalled memories carries a
        # thread_id tag — i.e. we have something for the model to
        # be "topic-aware" about. Fleet-shared / DM agents never
        # see this line.
        topic_line = ""
        if active_thread_id is not None and any(
            isinstance(m.get("metadata"), dict)
            and m["metadata"].get("thread_id") is not None
            for m in results
        ):
            topic_label = active_topic_alias or f"thread {active_thread_id}"
            topic_line = (
                f"Current topic: {topic_label}. Recalled memories are "
                f"tagged with their source topic.\n"
            )

        memories_block = (
            f"<hindsight_memories>\n"
            f"{preamble}\n"
            f"{topic_line}"
            f"Current time - {current_time}\n\n"
            f"{memories_formatted}\n"
            f"</hindsight_memories>"
        )
    else:
        debug_log(config, "No memories found")

    # Switchroom hindsight-leverage E1 / PR8 (#3369) — bounded transcript-grep
    # fallback. Fires ONLY when every bank returned zero results (pre_filter_count
    # == 0 — the merged pre-demote bank count) AND no slot hit its deadline
    # (deadline_hit False, so a timed-out bank can't masquerade as an empty fact
    # layer — the #3369 sequencing constraint on A3's telemetry) AND no bank
    # raised a hard error (bank_errored False, so a connection-refused / 5xx /
    # daemon-down outage can't masquerade as an empty fact layer either — the
    # PR8 gating-hole fix). This recovers
    # the crash-loss window between an abrupt session death and the next boot
    # reconciliation, where live recall would otherwise return nothing for the
    # lost turns. Everything is bounded inside the helper (bytes/turns/chars/time).
    # On by default; HINDSIGHT_RECALL_TRANSCRIPT_FALLBACK=false is the rollback
    # lever. Mutually exclusive with memories_block by construction: a non-empty
    # memories_block requires results, which requires pre_filter_count > 0.
    #
    # Switchroom #3757 — `deadline_hit` NO LONGER SUPPRESSES the fallback.
    # The original gate was written when a deadline meant "the fact layer is
    # unknown, don't guess". In practice a timeout was the COMMON case (96.8%
    # of overlord's own-bank recalls over the 7 days to 2026-07-27), and the
    # gate meant a timed-out turn got neither memories NOR the fallback — the
    # agent went in blind. A timeout and an outage are different: on a timeout
    # the banks are healthy and reachable, we simply ran out of time, so the
    # bounded transcript grep is strictly better than nothing. A hard bank
    # ERROR still suppresses it (`bank_errored`), because that genuinely can
    # masquerade as an empty fact layer while the store is down.
    transcript_fallback_block = None
    transcript_fallback_telemetry = dict(_FALLBACK_TELEMETRY_ZERO)
    if (
        config.get("recallTranscriptFallback", True)
        and pre_filter_count == 0
        and not bank_errored
    ):
        transcript_fallback_block, transcript_fallback_telemetry = _transcript_grep_fallback(
            hook_input.get("transcript_path", ""),
            query,
            config,
            budget_ms=_remaining_hook_budget_seconds() * 1000.0,
        )
        if transcript_fallback_block:
            debug_log(
                config,
                f"Transcript-grep fallback fired: {transcript_fallback_telemetry}",
            )
    elif pre_filter_count == 0 and bank_errored:
        # Suppressed: a bank outage (hard error), not a genuinely empty fact
        # layer. Logged so the gate decision is visible during an outage.
        debug_log(
            config,
            "Transcript-grep fallback suppressed: bank_errored (hard bank error, "
            "not an empty fact layer)",
        )

    # Switchroom #303 — recall is done, model is about to start the long
    # TTFT. Update the placeholder so the user doesn't keep staring at
    # `📚 recalling memories` for the next 15–20 s of opus thinking.
    # No trailing ellipsis — sendMessageDraft already animates the
    # "typing" indicator, the `…` is redundant.
    if placeholder_chat_id:
        update_placeholder(placeholder_chat_id, "💭 thinking")

    # Switchroom #432 phase 4.3 — telemetry log. memory IDs (when
    # available) let an operator confirm what was injected on a given turn.
    # Failure-tolerant.
    #
    # Hoisted ABOVE the empty-block early-return (hindsight-leverage PR 1,
    # review finding 1): a turn where every bank times out AND directives
    # fail produces no directives_block and no memories_block — precisely the
    # breach event the A3 baseline counts. Logging here (not after the return)
    # guarantees every cache-MISS recall attempt records bank_timings /
    # deadline_hit / total_elapsed_ms.
    #
    # NOTE on the PR-3 baseline denominator (review finding 2): a hook the
    # Claude Code UserPromptSubmit ceiling *kills* mid-flight (sequential
    # worst case ~18s > the 12s ceiling) never reaches this line, so a true
    # ceiling breach manifests as a MISSING row, not a logged one. The
    # baseline method is therefore two-signal: (a) ceiling-breach (total-drop)
    # rate = recall-log rows-missing vs the UserPromptSubmit turn count over
    # the window; (b) `deadline_hit` here = per-bank hard-timeout among the
    # hooks that survived long enough to log. Neither number alone is the
    # breach rate; PR 3's before/after must cite both.
    _write_recall_log({
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "session_id": (session_id or "")[:32],
        "bank_id": bank_id,
        "additional_banks": additional_banks,
        "query_chars": len(query),
        # Switchroom A1 (hindsight-leverage PR 1) — a BOUNDED excerpt (≤200
        # chars, review finding 5) of the envelope-stripped, truncated query
        # actually sent to recall. Enough to assert no `<channel` substring
        # reaches the embedding and to pair queries with hits (D2) without
        # bloating each row (which would thrash the size-based trim below).
        # `query_chars` above carries the full untruncated length.
        "query": query[:200],
        "result_count": len(results),
        "directive_count": len(directives),
        # Switchroom 2026-07-25 review finding 2 — how many active directives
        # MAX_DIRECTIVES dropped from this turn's <active_directives> block.
        # The stderr warning in lib/directives.py is NOT operator-visible
        # (Claude Code swallows hook stderr on a zero exit — verified fleet-wide),
        # so this row is the durable, queryable record that real hard rules
        # never reached the agent. >0 here means the bank is over cap and the
        # doctor's directive-count check will be FAILing too.
        "directives_omitted": count_omitted_directives(directives),
        # Switchroom memory-redesign step 1 (E-45 recommendation (b)) — WHICH
        # directives actually reached the prompt this turn, in the same
        # priority-descending order `format_active_directives_block` rendered
        # them. `directive_count`/`directives_omitted` above are volume-only
        # (how many fetched, how many the cap dropped); this is the queryable
        # record of identity, so directive exposure — including "never once
        # injected" — is measurable before any change to what gets injected.
        # Purely additive: does not change `directives_block` composition.
        "directive_ids": injected_directive_ids(directives),
        "demoted_count": demoted_count,
        # Switchroom #3837 — score-floor telemetry, deliberately alongside the
        # `injected_score_*` fields below: those are what the floor was derived
        # from, and these are what says whether it bound and what it cost.
        # `min_score_floor` is the configured value (0.0 = disabled),
        # `min_score_scope` the population it may bind on, `min_score_applied`
        # whether it actually ran this turn, and `dropped_below_min_score` how
        # many results it removed. dropped > 0 with result_count 0 is the case
        # the feature exists for: candidates existed, all were noise, none were
        # injected, and the agent was told so.
        "min_score_floor": min_score_floor,
        "min_score_scope": min_score_scope,
        "min_score_applied": min_score_applied,
        "dropped_below_min_score": dropped_below_min_score,
        "capped": capped,
        "pre_cap_count": pre_cap_count,
        "memory_ids": [
            m.get("id") for m in results
            if isinstance(m, dict) and m.get("id")
        ],
        # Switchroom #3541 — recall QUALITY telemetry, alongside the volume
        # fields above. min/median/max of `scores.final` over the injected
        # (post-head-slice) set. See `_injected_score_stats` for why volume
        # alone can't distinguish "reranker is working" from "8 mediocre
        # memories per turn" now that the overlap gate is near-passthrough.
        **_injected_score_stats(results),
        # Switchroom — injected BANK COMPOSITION. `result_count` above is a
        # volume signal and cannot distinguish "6 own-bank memories" from "6
        # profile-bank memories because the own bank timed out", which is
        # exactly how the own-bank timeout outage stayed invisible for weeks:
        # a fully-timed-out own bank still logged result_count == cap. These
        # two counts always sum to `result_count`, so an own-bank collapse is
        # readable off the log row without joining `bank_timings`.
        **_injected_bank_composition(results, bank_id),
        # Slots the reservation floors handed to a side that would have lost
        # them on global relevance alone — the observable effect of
        # `_reserve_bank_slots` (0/0 when the floors are off or non-binding).
        "reserved_own_slots": reserved_own,
        "reserved_additional_slots": reserved_additional,
        "cache_hit": False,
        # Switchroom A3 stage-1 telemetry (hindsight-leverage PR 1) — per-bank
        # latency + timeout breakdown, directives-fetch latency, total
        # critical-path wall time, and a derived `deadline_hit` (any bank hit
        # its hard per-request timeout). Accrues the fresh pre-A3 baseline the
        # parallelism change measures against; the 17-26% figure it replaces is
        # the stale 2026-05-24 pre-fix audit.
        "total_elapsed_ms": int((time.monotonic() - recall_start_monotonic) * 1000),
        # Switchroom recall-latency instrumentation — FULL-HOOK wall time to this
        # log write: dependency import + stdin read + cache check + the gate
        # short-circuits + the whole recall critical path. `total_elapsed_ms`
        # above is the recall critical path ONLY, so `duration_ms -
        # total_elapsed_ms` is the pre-recall LOCAL overhead this row could not
        # see before, while `bank_timings[].elapsed_ms` stay the server round-
        # trips — the log now separates server time from local overhead. Written
        # here (with the rest of the row, before the empty-block return) so even a
        # fully-timed-out / degraded recall that reaches this line gets a duration.
        "duration_ms": _hook_duration_ms(),
        "directives_elapsed_ms": directives_elapsed_ms,
        "bank_timings": bank_timings,
        # Switchroom hindsight-leverage A3 — FINALIZED `deadline_hit` semantics
        # (PR 1 shipped the interim per-bank-only form pending this PR). It is
        # now True when ANY slot on the critical path hit its deadline: a bank
        # that raised a hard per-request timeout OR (parallel mode) a bank/
        # directives slot abandoned when the shared deadline elapsed. In serial
        # (rollback) mode `directives_timed_out` is always False and each bank's
        # `timed_out` is per-request only, so this reduces to the pre-A3 form —
        # keeping the two modes' rows directly comparable in the breach baseline.
        "deadline_hit": deadline_hit,
        # Switchroom review finding (PR8 gating hole) — True when any bank raised
        # a hard (non-timeout) error this turn. Gates the transcript fallback
        # (suppressed on a real outage) and makes the outage visible per-row so a
        # spike in empty-result turns can be attributed to unreachable banks
        # rather than a genuinely empty fact layer.
        "bank_errored": bank_errored,
        # A3 — recall execution mode ("parallel"/"serial") and the shared
        # deadline budget (ms; None in serial mode). These distinguish pre-A3
        # (serial) from post-A3 (parallel) rows so the ≥3-day breach baseline
        # can segment by mode without guessing from timing.
        "recall_mode": recall_mode,
        "deadline_budget_ms": deadline_budget_ms,
        # A3 — effective deadline actually granted to the slots after pre-fan-out
        # spend (mission-ensure + transcript read). `deadline_budget_ms` is the
        # configured ceiling; this is the smaller wait the slots really got.
        # None in serial mode and on cache hits (no fan-out).
        "deadline_effective_ms": deadline_effective_ms,
        "directives_timed_out": directives_timed_out,
        # PR6 — instrumentation for binding-failure analysis.
        # `active_thread_id`: the current prompt's topic (null on
        # DM / fleet-shared). `source_topics`: distribution of
        # source thread_ids in the recall set (before optional
        # hard-filter). `topic_filter_mode`: "soft-preamble" or
        # "hard-filter". `topic_dropped`: count dropped by hard
        # filter. From these fields we can derive the cross-topic
        # recall rate over time and decide whether to flip to
        # hard-filter mode based on real data.
        "active_thread_id": active_thread_id,
        "active_topic_alias": active_topic_alias,
        "source_topics": source_topic_summary,
        "topic_filter_mode": topic_filter_mode,
        "topic_dropped": topic_dropped,
        "directive_nudge": bool(nudge_block),
        # Switchroom P2 — the ISO ask-time anchor actually sent to recall this
        # turn (null when the inbound had no temporal phrase), so the field's
        # firing rate is measurable from day one against the RFC's falsification
        # window (precedent: `directive_nudge` above).
        "query_timestamp": query_timestamp,
        # RFC P3 — profile-capture nudge firing rate, measurable from day one
        # (mirrors the directive_nudge precedent).
        "profile_nudge": bool(profile_nudge_block),
        # Switchroom hindsight-leverage E1 / PR8 (#3369) — transcript-grep
        # fallback telemetry so its firing (and its bounds) are visible per turn
        # in recall_log.jsonl. `transcript_fallback` True only on an all-zero,
        # no-deadline-hit turn where the grep found ≥1 matching session turn.
        "transcript_fallback": transcript_fallback_telemetry["fired"],
        "transcript_fallback_turns": transcript_fallback_telemetry["matched_turns"],
        "transcript_fallback_chars": transcript_fallback_telemetry["chars"],
        "transcript_fallback_bytes_read": transcript_fallback_telemetry["bytes_read"],
        "transcript_fallback_elapsed_ms": transcript_fallback_telemetry["elapsed_ms"],
        "transcript_fallback_truncated": transcript_fallback_telemetry["truncated"],
        # Switchroom structural-fix #7 — WHAT failed, in words. Every other
        # failure channel on this row is a BOOLEAN (`deadline_hit`,
        # `bank_errored`, per-bank `timed_out`/`errored`), which says THAT
        # something broke and never WHICH thing, so an incident could not be
        # triaged from the log at all. recall.py exits 0 and Claude Code
        # swallows hook stderr, so this row is the only place the reason can
        # survive. None on a healthy turn.
        "error": recall_error_summary(bank_id, bank_timings, directives_timed_out),
    })

    # (`degraded_block` — the #3619 disclosure — was computed before the score
    # floor above, which is scoped by it.)
    #
    # Switchroom #3837 — when the floor emptied a non-empty set, say so. Not
    # emitted when survivors remain: a partial drop still injects real
    # memories and does not change how the turn should be read.
    withheld_block = (
        min_score_withheld_notice(dropped_below_min_score, min_score_floor)
        if not results
        else ""
    )

    # If no block has content, there's nothing to inject — exit
    # silently to avoid emitting an empty hookSpecificOutput. #2848: unless
    # the directive-capture nudge fired, in which case emit the nudge alone
    # (a correction with no memories/directives still needs the reminder).
    # #3619: a degraded own-bank read is likewise worth emitting alone — that
    # is precisely the turn on which the agent must not assume it remembers.
    # #3837: so is a set the score floor withheld entirely.
    if not directives_block and not memories_block and not transcript_fallback_block:
        if degraded_block or withheld_block or nudge_block or profile_nudge_block:
            _emit_cached_context(
                "\n\n".join(
                    [
                        b
                        for b in (
                            degraded_block,
                            withheld_block,
                            nudge_block,
                            profile_nudge_block,
                        )
                        if b
                    ]
                )
            )
        return

    # Compose final context. Directives block goes ABOVE memories so the
    # agent reads HARD RULES before low-signal recall traces. The E1/PR8
    # transcript fallback (#3369) goes LAST — it is the lowest-confidence
    # signal (raw transcript, not synthesized fact) and only present when
    # memories_block is empty by construction.
    #
    # #3619's degraded notice is deliberately NOT part of context_message: like
    # the #2848 nudge it is per-turn state, and this string is what gets cached
    # and written to LAST_RECALL_STATE. Caching it would replay "recall was
    # DEGRADED" on later healthy cache hits; it is prepended at emit time
    # instead, so a cache hit re-derives the turn's real condition.
    parts = []
    if directives_block:
        parts.append(directives_block)
    if memories_block:
        parts.append(memories_block)
    if transcript_fallback_block:
        parts.append(transcript_fallback_block)
    context_message = "\n\n".join(parts)

    # Save last recall to state for diagnostics
    write_state(
        LAST_RECALL_STATE,
        {
            "context": context_message,
            # M4 P-REC Fix B (red-team BINDING): a directives-FREE sibling of
            # `context`, memories/transcript-fallback only. The stale-buffer
            # fallback (`_handle_prefetch_buffer`) reads THIS field, never
            # `context` — `context` bundles `directives_block` (M3's
            # directive-decoupling rule forbids re-injecting stale directives
            # from a prior turn's cache; directives stay on the synchronous,
            # always-fresh fetch path only).
            "memories_context": "\n\n".join(
                [b for b in (memories_block, transcript_fallback_block) if b]
            ),
            "saved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "bank_id": bank_id,
            "result_count": len(results),
            "directive_count": len(directives),
        },
    )

    # Switchroom #424 phase 4.1 — populate the cache for the next hit.
    # Failure-tolerant: a write error here doesn't mask the recall result.
    if cache_ttl > 0 and cache_key:
        try:
            _cache_store(cache_key, context_message)
        except Exception as e:
            debug_log(config, f"Recall cache write failed (non-fatal): {e}")

    # (Telemetry log already written above, before the empty-block return, so
    # total-failure turns are recorded — hindsight-leverage PR 1 finding 1.)

    # Output JSON for Claude Code hook system. #2848: append the
    # directive-capture nudge (if it fired) at emit time — it's kept out of
    # the cached / last-recall context above so it can't go stale. #3619: the
    # degraded-recall notice is prepended for the same reason, and goes FIRST
    # because it changes how everything after it should be read.
    output = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": _combine_context(
                _combine_context(
                    _combine_context(
                        _combine_context(degraded_block, withheld_block),
                        context_message,
                    ),
                    nudge_block,
                ),
                profile_nudge_block,
            ),
        }
    }
    json.dump(output, sys.stdout)


def _redact_secrets(text: str) -> str:
    """Best-effort inline scrub for the obvious leak shapes that show
    up in HTTP error messages (`lib/client.py:73` formats the URL into
    the RuntimeError, and the URL may include query-string credentials).

    We don't have a python-callable bridge to the TS `secret-detect`
    module, so this is a small regex pass covering:
      * Authorization: Bearer <token>
      * ?key=val and &key=val for keys matching token|key|secret|auth
      * x-api-key: <value> header shape

    Bounded by `re` (anchored, no catastrophic alternation) so this is
    safe to run on a 400-char input. Returns `text` unchanged if no
    matches; on regex-engine error, falls back to returning the raw
    text — redaction is best-effort, not a security boundary, and the
    server-side detail handler (#1069) re-scans before persistence.
    """
    import re

    try:
        # Bearer tokens — case-insensitive
        text = re.sub(
            r"(?i)(bearer\s+)[A-Za-z0-9._\-]{8,}",
            r"\1<redacted>",
            text,
        )
        # x-api-key / api-key header values
        text = re.sub(
            r"(?i)(x?-?api[-_]?key\s*[:=]\s*)([A-Za-z0-9._\-]{8,})",
            r"\1<redacted>",
            text,
        )
        # Query-string credentials: ?token=…, &api_key=…, ?secret=…
        text = re.sub(
            r"(?i)([?&](?:[a-z0-9_\-]*?(?:token|key|secret|auth|password|pass)"
            r"[a-z0-9_\-]*?)=)([^&\s]{4,})",
            r"\1<redacted>",
            text,
        )
        return text
    except Exception:
        return text


def _record_issue_safely(detail: str, class_name: str) -> None:
    """Fire-and-forget call into `switchroom issues record`. Bounded by
    timeout; never raises. The agent's responsiveness on a hindsight
    outage depends on this NOT propagating any failure.
    """
    import subprocess

    try:
        subprocess.run(
            [
                "switchroom",
                "issues",
                "record",
                "--severity",
                "warn",
                "--source",
                "hindsight.recall",
                "--code",
                "recall_failed",
                "--summary",
                f"Hindsight recall failed: {class_name}",
                "--detail-stdin",
                "--quiet",
            ],
            input=detail,
            text=True,
            timeout=5,
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        # Hard swallow. The agent stays responsive even if the issue
        # sink is wedged, missing, or the CLI isn't on PATH. The stderr
        # line above is the operator's only signal in that case.
        pass


if __name__ == "__main__":
    try:
        main()
        # Switchroom hindsight-leverage A3 — hard, immediate process exit.
        #
        # The parallel recall path spawns daemon threads. Daemon threads already
        # do not block a normal interpreter shutdown, but two things still can:
        # (a) a non-daemon thread a client library might spawn, and (b) atexit /
        # interpreter-shutdown thread-join bookkeeping. A straggler bank still
        # blocked on an 8s socket read must NEVER hold the UserPromptSubmit hook
        # open past its 12s ceiling. os._exit skips all of that and returns
        # control to Claude Code immediately — but it also skips stdout buffer
        # flushing, so flush FIRST or the hookSpecificOutput JSON is lost.
        try:
            sys.stdout.flush()
        except Exception:
            pass
        # Switchroom recall-latency instrumentation — emit the full-hook timing
        # line AFTER stdout is flushed (Claude Code already has the bytes) and
        # BEFORE os._exit, which skips atexit and would otherwise drop it. Adds
        # ~0.5ms (one file append) before the process exits — the same budget
        # run-hook.sh spends per wrapped hook. Stdout is untouched.
        _emit_hook_timing_log(_hook_duration_ms(), 0)
        os._exit(0)
    except Exception as e:
        # Switchroom #1070 (redo per #1085 review).
        #
        # recall.py is a DIRECT Claude Code plugin hook (see
        # vendor/hindsight-memory/hooks/hooks.json). It is NOT wrapped
        # by bin/run-hook.sh, so the `non-zero exit → record_failure`
        # pipeline does NOT apply here. Per Claude Code's hook
        # contract, exit 2 on UserPromptSubmit BLOCKS the user's
        # prompt and surfaces stderr to them — which would turn a
        # hindsight outage into "every turn blocked".
        #
        # Correct posture: exit 0 with the same safe-empty stdout
        # shape as the no-memories success path (recall.py line ~660
        # — `return` with no JSON dumped), so the agent's prompt
        # assembly proceeds with no memories. Then shell out directly
        # to `switchroom issues record` so the operator still sees
        # the failure on their issues card. The subprocess call is
        # fault-tolerant; if it fails for any reason the agent still
        # stays responsive.
        #
        # Debug mode (HINDSIGHT_DEBUG=1) keeps the legacy posture —
        # traceback + exit 2 — because live-debugging operators want
        # maximum signal and have opted in.
        _msg = str(e)
        if len(_msg) > 400:
            _msg = _msg[:400] + "…"
        _msg = _redact_secrets(_msg)
        _class = type(e).__name__
        _detail = f"{_class}: {_msg}"
        print(
            f"[Hindsight] Unexpected error in recall: {_detail}",
            file=sys.stderr,
        )

        # Decide on debug-branch behaviour. load_config may itself be
        # what failed in main() (it's called early), so guard.
        _is_debug = False
        try:
            from lib.config import load_config

            _is_debug = bool(load_config().get("debug"))
        except Exception:
            pass

        if _is_debug:
            import traceback

            traceback.print_exc(file=sys.stderr)
            # Instrumentation: record the failed invocation's wall time too
            # (status 2, the debug-mode block behaviour) so a crash-looping
            # hook is visible in the timing log, not just a silent gap.
            _emit_hook_timing_log(_hook_duration_ms(), 2)
            # Debug-mode exit 2 is intentional and unchanged —
            # operators with HINDSIGHT_DEBUG=1 are chasing a broken
            # recall and want the hook to surface its failure.
            sys.exit(2)

        # Non-debug: route the failure to the issue-sink, then exit
        # 0 with no stdout (agent's prompt assembly treats absent
        # additionalContext as "no recall this turn").
        _record_issue_safely(_detail, _class)
        # Instrumentation: the non-debug exit code is 0 (the safe-empty stdout
        # posture), so log status 0 — the accompanying issue-sink record is where
        # the failure detail lives; this row just makes the latency observable.
        _emit_hook_timing_log(_hook_duration_ms(), 0)
        sys.exit(0)
