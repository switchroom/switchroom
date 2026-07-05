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
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib.bank import derive_bank_id, ensure_bank_mission
from lib.client import HindsightClient
from lib.config import debug_log, load_config
from lib.content import (
    compose_recall_query,
    format_current_time,
    format_memories,
    truncate_recall_query,
)
from lib.daemon import get_api_url
from lib.directives import fetch_active_directives, format_active_directives_block
from lib.gateway_ipc import extract_chat_id_from_prompt, extract_topic_from_prompt, extract_user_from_prompt, update_placeholder
from lib.state import read_state, write_state

LAST_RECALL_STATE = "last_recall.json"
RECALL_CACHE_STATE = "recall_cache.json"

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


# Switchroom #475 — lexical-overlap relevance gate.
#
# Hindsight's HTTP API does not return similarity scores. Without a
# score the existing `recallMaxMemories` cap acts as a *floor* on
# low-relevance prompts: weak matches still fill the slot up to N,
# mis-steering the model. This gate computes Jaccard overlap between
# the user's query terms and each memory's text terms, and drops
# memories below a configurable threshold.
#
# Threshold default is 0.0 (disabled) so the gate is opt-in initially.
# Operators tune via `memory.recall.min_overlap` in switchroom.yaml or
# `HINDSIGHT_RECALL_MIN_OVERLAP=0.15` env. Telemetry surfaces the dropped
# count via the existing recall_log.jsonl (#432 4.3) under
# `overlap_dropped`, so the gate's effect is observable per turn from
# `switchroom memory recall-log <agent>`.
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


def jaccard_overlap(query: str, memory_text: str) -> float:
    """Jaccard similarity between two texts, after stop-word + punctuation
    stripping. Returns a float in [0.0, 1.0]. Empty/degenerate inputs
    return 0.0 — it's safer to drop than retain when we can't compute.
    """
    a = _overlap_tokens(query)
    b = _overlap_tokens(memory_text)
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def _filter_by_overlap(results, query: str, threshold: float):
    """Drop memories whose Jaccard overlap with the query is below the
    threshold. Threshold <= 0 short-circuits to passthrough (no
    iteration cost).

    Returns (kept_results, dropped_count).
    """
    if threshold <= 0:
        return results, 0
    kept = []
    dropped = 0
    for m in results:
        text = m.get("text", "") if isinstance(m, dict) else ""
        if jaccard_overlap(query, text) >= threshold:
            kept.append(m)
        else:
            dropped += 1
    return kept, dropped


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
        # Cheap rolling trim every ~50 writes (estimated by file size
        # vs. 200 bytes/line average) to amortize the read cost.
        try:
            size = os.path.getsize(log_path)
        except OSError:
            return
        if size > RECALL_LOG_MAX_LINES * 250:
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


def read_transcript_messages(transcript_path: str) -> list:
    """Read messages from a JSONL transcript file for multi-turn context.

    Claude Code transcript format nests messages:
      {type: "user", message: {role: "user", content: "..."}, uuid: "...", ...}
    Also supports flat format for testing:
      {role: "user", content: "..."}
    """
    if not transcript_path or not os.path.isfile(transcript_path):
        return []
    messages = []
    try:
        with open(transcript_path, encoding="utf-8") as f:
            for line in f:
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
    "correction survives future sessions. If it’s only a one-off "
    "instruction, ignore this note and just answer.\n"
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
                "result_count": None,  # not known on cache hit
                "directive_count": None,
                "demoted_count": 0,
                "capped": False,
                "cache_hit": True,
                # PR6 — record the active topic on cache hits too so the
                # log is uniformly queryable (cache_key now includes
                # active_thread_id, so a hit means the prior recall was
                # for the same topic — no source_topics inferable here).
                "active_thread_id": active_thread_id,
                "active_topic_alias": active_topic_alias,
                "topic_filter_mode": _topic_filter_mode(),
                "directive_nudge": bool(nudge_block),
            })
            return
        debug_log(config, f"Recall cache MISS (key={cache_key[:12]}…)")

    # Set bank mission on first use
    ensure_bank_mission(client, bank_id, config, debug_fn=_dbg)

    # Multi-turn query composition
    recall_context_turns = config.get("recallContextTurns", 1)
    recall_max_query_chars = config.get("recallMaxQueryChars", 800)
    recall_roles = config.get("recallRoles", ["user", "assistant"])

    if recall_context_turns > 1:
        transcript_path = hook_input.get("transcript_path", "")
        messages = read_transcript_messages(transcript_path)
        debug_log(config, f"Multi-turn context: {recall_context_turns} turns, {len(messages)} messages from transcript")
        query = compose_recall_query(prompt, messages, recall_context_turns, recall_roles)
    else:
        query = prompt

    query = truncate_recall_query(query, prompt, recall_max_query_chars)

    # Final defensive cap (mirrors Openclaw)
    if len(query) > recall_max_query_chars:
        query = query[:recall_max_query_chars]

    debug_log(config, f"Recalling from bank '{bank_id}', query length: {len(query)}")

    # Fetch active directives FIRST (independent of recall — even if recall
    # finds no memories, an agent with active directives still needs them
    # surfaced every turn). Workaround for upstream bug
    # vectorize-io/hindsight#1269 (tagged directives silently dropped from
    # `reflect`); `list_directives` itself works correctly upstream, so this
    # is a pure client-side surface. fetch_active_directives is failure-safe
    # and returns [] on any error.
    directives = fetch_active_directives(client, bank_id)
    directives_block = format_active_directives_block(directives) if directives else None
    if directives_block:
        debug_log(config, f"Injecting {len(directives)} active directives")

    # Call Hindsight recall API
    results = []
    try:
        response = client.recall(
            bank_id=bank_id,
            query=query,
            max_tokens=config.get("recallMaxTokens", 1024),
            budget=config.get("recallBudget", "mid"),
            types=config.get("recallTypes"),
            # Upstream 962140eef — optional tag filters (resolved above the
            # cache check; part of the cache key).
            tags=recall_tags,
            tags_match=tags_match,
            tag_groups=tag_groups,
            # 8s in-script timeout leaves 4s headroom inside the 12s
            # UserPromptSubmit hook ceiling (see hooks.json:20) for cache
            # write + block formatting. Tightened from 10s in switchroom
            # v0.13.22: the 2026-05-24 audit showed 17-26% of turns
            # breaching the 12s hook timeout on heavy agents (finn /
            # gymbro / klanker), which dropped the recall entirely; an
            # earlier-hard-timeout failure returns cleanly with no
            # memories instead of blowing past the hook ceiling.
            timeout=8,
        )
        results = response.get("results", [])
    except Exception as e:
        print(f"[Hindsight] Recall failed: {e}", file=sys.stderr)
        # Fall through — we still want to emit the directives block if we
        # have one, so a recall API failure doesn't blind the agent to
        # its own active directives.

    # Also recall from any additional banks (e.g. shared user profile bank).
    # `additional_banks` was already extracted above the cache check so the
    # cache key reflects every bank queried; reuse that local instead of
    # re-reading config.
    for extra_bank_id in additional_banks:
        # Upstream 962140eef — per-bank tag-filter overrides; fall back to
        # the global filters when the bank has no entry. Applies uniformly
        # to config-listed banks and sender banks appended by
        # _resolve_sender_bank (both flow through `additional_banks`).
        extra_filter = additional_bank_filters.get(extra_bank_id, {})
        if not isinstance(extra_filter, dict):
            extra_filter = {}
        extra_tags = extra_filter.get("recallTags", recall_tags) or None
        extra_tag_groups = extra_filter.get("recallTagGroups", tag_groups) or None
        extra_tags_match = extra_filter.get(
            "recallTagsMatch",
            tags_match if extra_tags or extra_tag_groups else None,
        )
        try:
            extra_response = client.recall(
                bank_id=extra_bank_id,
                query=query,
                max_tokens=config.get("recallMaxTokens", 1024),
                budget=config.get("recallBudget", "mid"),
                types=config.get("recallTypes"),
                tags=extra_tags,
                tags_match=extra_tags_match,
                tag_groups=extra_tag_groups,
                # 8s in-script timeout leaves 4s headroom inside the 12s
                # UserPromptSubmit hook ceiling (see hooks.json:20) for cache
                # write + block formatting. Tightened from 10s in switchroom
                # v0.13.22: the 2026-05-24 audit showed 17-26% of turns
                # breaching the 12s hook timeout on heavy agents (finn /
                # gymbro / klanker), which dropped the recall entirely; an
                # earlier-hard-timeout failure returns cleanly with no
                # memories instead of blowing past the hook ceiling.
                timeout=8,
            )
            extra_results = extra_response.get("results", [])
            if extra_results:
                debug_log(config, f"Got {len(extra_results)} memories from additional bank '{extra_bank_id}'")
                results = results + extra_results
        except Exception as e:
            debug_log(config, f"Recall from additional bank '{extra_bank_id}' failed: {e}")

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

    # Switchroom #475 — lexical-overlap relevance gate. Drops memories
    # whose Jaccard overlap with the query is below
    # `recallMinOverlap` (default 0.0 = disabled). Runs after the
    # demote filter so the threshold sees the operator-curated set.
    overlap_threshold = config.get("recallMinOverlap", 0.0)
    if isinstance(overlap_threshold, (int, float)) and overlap_threshold > 0:
        pre_overlap_count = len(results)
        results, overlap_dropped = _filter_by_overlap(
            results, query, float(overlap_threshold)
        )
        if overlap_dropped > 0:
            debug_log(
                config,
                f"Overlap gate dropped {overlap_dropped}/{pre_overlap_count} "
                f"memories below threshold {overlap_threshold}",
            )
    else:
        overlap_dropped = 0

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

    # Switchroom #303 — recall is done, model is about to start the long
    # TTFT. Update the placeholder so the user doesn't keep staring at
    # `📚 recalling memories` for the next 15–20 s of opus thinking.
    # No trailing ellipsis — sendMessageDraft already animates the
    # "typing" indicator, the `…` is redundant.
    if placeholder_chat_id:
        update_placeholder(placeholder_chat_id, "💭 thinking")

    # If neither block has content, there's nothing to inject — exit
    # silently to avoid emitting an empty hookSpecificOutput. #2848: unless
    # the directive-capture nudge fired, in which case emit the nudge alone
    # (a correction with no memories/directives still needs the reminder).
    if not directives_block and not memories_block:
        if nudge_block:
            _emit_cached_context(nudge_block)
        return

    # Compose final context. Directives block goes ABOVE memories so the
    # agent reads HARD RULES before low-signal recall traces.
    parts = []
    if directives_block:
        parts.append(directives_block)
    if memories_block:
        parts.append(memories_block)
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

    # Switchroom #432 phase 4.3 — telemetry log. memory IDs (when
    # available) let an operator confirm what was injected on a given
    # turn. Failure-tolerant.
    _write_recall_log({
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "session_id": (session_id or "")[:32],
        "bank_id": bank_id,
        "additional_banks": additional_banks,
        "query_chars": len(query),
        "result_count": len(results),
        "directive_count": len(directives),
        "demoted_count": demoted_count,
        "overlap_dropped": overlap_dropped,
        "capped": capped,
        "pre_cap_count": pre_cap_count,
        "memory_ids": [
            m.get("id") for m in results
            if isinstance(m, dict) and m.get("id")
        ],
        "cache_hit": False,
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
    })

    # Output JSON for Claude Code hook system. #2848: append the
    # directive-capture nudge (if it fired) at emit time — it's kept out of
    # the cached / last-recall context above so it can't go stale.
    output = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": _combine_context(context_message, nudge_block),
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
