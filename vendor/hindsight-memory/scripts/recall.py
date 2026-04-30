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
  0 — always (graceful degradation on any error)
"""

import hashlib
import json
import os
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


def _cache_key(session_id: str, prompt: str, bank_id: str, extra_banks: list) -> str:
    """Stable hash for cache keying. Session_id is included so a new
    session always misses, regardless of the TTL setting. Extra banks
    are sorted so list-order doesn't change the key."""
    parts = [
        session_id or "",
        prompt or "",
        bank_id or "",
        ",".join(sorted(extra_banks or [])),
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

    session_id = hook_input.get("session_id") or ""

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

    # Switchroom #424 phase 4.1 — cache check BEFORE any HTTP traffic.
    # Whole-session-scoped, opt-in via HINDSIGHT_RECALL_CACHE_TTL_SECS.
    cache_ttl = _cache_ttl_secs()
    cache_key = (
        _cache_key(session_id, prompt, bank_id, additional_banks)
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
            _emit_cached_context(cached_context)
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
            timeout=10,
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
        try:
            extra_response = client.recall(
                bank_id=extra_bank_id,
                query=query,
                max_tokens=config.get("recallMaxTokens", 1024),
                budget=config.get("recallBudget", "mid"),
                types=config.get("recallTypes"),
                timeout=10,
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
        memories_block = (
            f"<hindsight_memories>\n"
            f"{preamble}\n"
            f"Current time - {current_time}\n\n"
            f"{memories_formatted}\n"
            f"</hindsight_memories>"
        )
    else:
        debug_log(config, "No memories found")

    # If neither block has content, there's nothing to inject — exit
    # silently to avoid emitting an empty hookSpecificOutput.
    if not directives_block and not memories_block:
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
        "capped": capped,
        "pre_cap_count": pre_cap_count,
        "memory_ids": [
            m.get("id") for m in results
            if isinstance(m, dict) and m.get("id")
        ],
        "cache_hit": False,
    })

    # Output JSON for Claude Code hook system
    output = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": context_message,
        }
    }
    json.dump(output, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[Hindsight] Unexpected error in recall: {e}", file=sys.stderr)
        # Exit 2 in debug mode surfaces errors to Claude; 0 degrades silently
        try:
            from lib.config import load_config

            sys.exit(2 if load_config().get("debug") else 0)
        except Exception:
            sys.exit(0)
