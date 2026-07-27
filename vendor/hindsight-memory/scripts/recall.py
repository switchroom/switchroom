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

import hashlib
import json
import os
import re
import socket
import sys
import time
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib.bank import derive_bank_id, ensure_bank_mission
from lib.client import HindsightClient
from lib.config import debug_log, load_config
from lib.content import (
    _extract_text_content,
    compose_recall_query,
    format_current_time,
    format_memories,
    strip_channel_envelope,
    strip_memory_tags,
    truncate_recall_query,
)
from lib.daemon import get_api_url
from lib.directives import (
    DIRECTIVES_CACHE_TTL_SECONDS,
    count_omitted_directives,
    fetch_active_directives_cached,
    format_active_directives_block,
)
from lib.gateway_ipc import extract_chat_id_from_prompt, extract_topic_from_prompt, extract_user_from_prompt, update_placeholder
from lib.parallel_recall import run_parallel
from lib.state import read_state, write_state

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

    Punctuation, digits, and short fragments (<= 1 char) are dropped.
    Returns an empty set on non-string / empty input.
    """
    if not isinstance(text, str) or not text:
        return set()
    out = set()
    cur = []
    for ch in text:
        if ch.isalpha():
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

_FALLBACK_BLOCK_PREAMBLE = (
    "No stored memories matched this query — the fact layer may not have "
    "reconciled this session yet (e.g. an abrupt session death before boot "
    "reconciliation). The following are VERBATIM excerpts from recent turns of "
    "THIS session that mention related terms. Treat them as lower-confidence "
    "than stored memory — they are raw transcript, not synthesized fact:"
)


def _transcript_grep_fallback(transcript_path, query, config):
    """Bounded transcript-grep fallback for the empty-fact-layer window (#3369).

    Reads the CURRENT session transcript's tail (bounded bytes), keeps the most
    recent user/assistant turns whose terms lexically overlap the recall query,
    and returns a clearly-labelled, size-bounded fallback context block plus a
    telemetry dict. Every dimension is bounded: bytes read
    (``recallTranscriptFallbackMaxBytes``), matched turns
    (``recallTranscriptFallbackMaxTurns``), emitted characters
    (``recallTranscriptFallbackMaxChars``), and grep wall-time
    (``recallTranscriptFallbackDeadlineMs``). The caller only invokes this when
    all banks returned zero AND no slot hit its deadline, so a timed-out bank can
    never masquerade as a genuinely empty fact layer.

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
    "in that case it is already saved; do NOT create a duplicate. If it’s "
    "only a one-off instruction, ignore this note and just answer.\n"
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


def _combine_context(base, nudge) -> str:
    """Join the recall/directives context with the directive-capture nudge,
    skipping empties. Either may be None/empty. The nudge is kept OUT of the
    cached / last-recall context (it's transient per-inbound) and appended
    only at emit time, so a cache hit re-derives it from the current prompt
    rather than replaying a stale one."""
    parts = [p for p in (base, nudge) if p]
    return "\n\n".join(parts)


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
            _emit_cached_context(_combine_context(cached_context, nudge_block))
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
                "demoted_count": 0,
                "capped": False,
                # #3541 quality telemetry — present for a uniformly queryable
                # schema. A cache hit replays a formatted context block, not a
                # result set, so no per-memory scores exist to aggregate.
                "injected_score_min": None,
                "injected_score_median": None,
                "injected_score_max": None,
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

    debug_log(config, f"Recalling from bank '{bank_id}', query length: {len(query)}")

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

    def _make_bank_task(target_bank_id, b_tags, b_tags_match, b_tag_groups):
        def _bank_task():
            return client.recall(
                bank_id=target_bank_id,
                query=query,
                max_tokens=config.get("recallMaxTokens", 1024),
                budget=config.get("recallBudget", "mid"),
                types=config.get("recallTypes"),
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
                # 8s in-script per-request timeout: even parallelised, each bank
                # carries its own hard deadline so a single hung bank returns
                # cleanly with no memories rather than sitting on the shared
                # deadline. Tightened from 10s in v0.13.22 (2026-05-24 breach
                # audit); the shared deadline below is the outer ceiling guard.
                timeout=8,
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
                    results = results + bank_results
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
            })
    else:
        # Pre-A3 serial path (rollback lever, HINDSIGHT_RECALL_PARALLEL=false).
        # Directives first, then each bank in turn — total latency is the SUM of
        # the round-trips. Behaviourally equivalent to the pre-parallelism path
        # (log rows stay comparable), NOT byte-for-byte: this path emits an extra
        # own-bank debug line, logs the directives block after the bank loop
        # rather than before, and __main__ still os._exit(0)s on completion.
        recall_mode = "serial"
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
            try:
                response = _make_bank_task(b_id, b_tags, b_tags_match, b_tag_groups)()
                bank_results = response.get("results", []) if isinstance(response, dict) else []
                if bank_results:
                    debug_log(config, f"Got {len(bank_results)} memories from bank '{b_id}'")
                    results = results + bank_results
            except Exception as e:
                _bank_timed_out = _is_timeout_error(e)
                # Non-timeout error → hard outage (see parallel-path note above).
                _bank_errored = not _bank_timed_out
                if b_id == bank_id:
                    print(f"[Hindsight] Recall failed: {e}", file=sys.stderr)
                else:
                    debug_log(config, f"Recall from additional bank '{b_id}' failed: {e}")
            bank_timings.append({
                "bank_id": b_id,
                "elapsed_ms": int((time.monotonic() - _bank_start) * 1000),
                "timed_out": _bank_timed_out,
                "errored": _bank_errored,
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

    # Switchroom-local: client-side count cap. Plugin v0.4.0 has no
    # `recallTopK` in the Claude Code integration (Openclaw-only), and a
    # token budget alone doesn't bound count — a single long memory can
    # blow past intended caps, while many short ones can flood the prompt.
    # Slice the combined results from primary + additional banks before
    # formatting. <= 0 disables the cap.
    recall_max_memories = config.get("recallMaxMemories", 0)
    pre_cap_count = len(results)
    capped = False
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
        results = results[:recall_max_memories]
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
    transcript_fallback_block = None
    transcript_fallback_telemetry = dict(_FALLBACK_TELEMETRY_ZERO)
    if (
        config.get("recallTranscriptFallback", True)
        and pre_filter_count == 0
        and not deadline_hit
        and not bank_errored
    ):
        transcript_fallback_block, transcript_fallback_telemetry = _transcript_grep_fallback(
            hook_input.get("transcript_path", ""),
            query,
            config,
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
        "demoted_count": demoted_count,
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
        "cache_hit": False,
        # Switchroom A3 stage-1 telemetry (hindsight-leverage PR 1) — per-bank
        # latency + timeout breakdown, directives-fetch latency, total
        # critical-path wall time, and a derived `deadline_hit` (any bank hit
        # its hard per-request timeout). Accrues the fresh pre-A3 baseline the
        # parallelism change measures against; the 17-26% figure it replaces is
        # the stale 2026-05-24 pre-fix audit.
        "total_elapsed_ms": int((time.monotonic() - recall_start_monotonic) * 1000),
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
    })

    # Switchroom #3619 — DEGRADED-RECALL DISCLOSURE. See
    # `degraded_recall_notice` for why this exists and why only the agent's
    # OWN bank counts.
    degraded_block = degraded_recall_notice(bank_id, bank_timings)

    # If no block has content, there's nothing to inject — exit
    # silently to avoid emitting an empty hookSpecificOutput. #2848: unless
    # the directive-capture nudge fired, in which case emit the nudge alone
    # (a correction with no memories/directives still needs the reminder).
    # #3619: a degraded own-bank read is likewise worth emitting alone — that
    # is precisely the turn on which the agent must not assume it remembers.
    if not directives_block and not memories_block and not transcript_fallback_block:
        if degraded_block or nudge_block:
            _emit_cached_context(
                "\n\n".join([b for b in (degraded_block, nudge_block) if b])
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
                _combine_context(degraded_block, context_message), nudge_block
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
            # Debug-mode exit 2 is intentional and unchanged —
            # operators with HINDSIGHT_DEBUG=1 are chasing a broken
            # recall and want the hook to surface its failure.
            sys.exit(2)

        # Non-debug: route the failure to the issue-sink, then exit
        # 0 with no stdout (agent's prompt assembly treats absent
        # additionalContext as "no recall this turn").
        _record_issue_safely(_detail, _class)
        sys.exit(0)
