#!/usr/bin/env python3
"""M4 P-PRE — async Stop-hook prefetch producer.

carve-M4.md: moves recall injection off the synchronous UserPromptSubmit
path by speculatively retaining + recalling at the END of turn N (this
script, registered as an async Stop hook), so turn N+1's UserPromptSubmit
(`recall.py`) can join an already-warm buffer instead of paying the full
recall latency synchronously.

Entirely gated by `memoryPrefetchEnabled` (default OFF/falsy — Fix C, the
red-team-mandated per-agent kill switch). When off this script is a no-op:
it reads config, sees the flag off, and exits silently before touching
`lib.retain`, `lib.recall_buffer`, or the network.

Call order (test a-integration in `tests/test_prefetch_pipeline.py`):
  1. delta retain (`retain.run_retain(hook_input, force=False, delta=True)`)
     — persists this turn's NEW slice using the Fix-A content-derived
     document_id, never truncating the session document.
  2. speculative recall (best-effort query derived from the transcript's
     last human turn — the strongest available proxy for what turn N+1
     will ask about).
  3. `recall_buffer.write_buffer` then `recall_buffer.write_sentinel`
     (STRICTLY in that order — the sentinel-ordering contract `lib/
     recall_buffer.py` and `tests/test_recall_buffer.py` prove).

Silent on stdout always (an async Stop hook's stdout is not surfaced to the
transcript); errors go to stderr and NEVER raise past `main()` — a broken
prefetch must degrade to "recall.py's synchronous path runs as before",
never break the turn or leave a torn buffer (a crash between steps 2 and 3a
just means no sentinel is written this turn, which `read_if_fresh` already
treats as "nothing fresh" — fail-closed by construction).

Skips the same junk turns `recall.py` skips (`<task-notification>` prefix)
— a synthetic follow-up turn is not a real conversation shift worth
prefetching for.
"""

from __future__ import annotations

import json
import sys

from lib.bank import derive_bank_id
from lib.client import HindsightClient
from lib.config import debug_log, load_config
from lib.content import _extract_text_content, strip_channel_envelope
from lib.daemon import get_api_url
from lib import recall_buffer
import retain as retain_module


def _last_human_prompt(transcript_path: str) -> str:
    """Best-effort: the most recent human-authored user turn's text, used
    as the speculative query for next turn's prefetch. Never raises —
    returns "" on any read/parse failure (degrades to no query, which the
    caller treats as "nothing to prefetch")."""
    try:
        messages = retain_module.read_transcript(transcript_path)
    except Exception:
        return ""
    for msg in reversed(messages):
        if msg.get("role") != "user":
            continue
        text = _extract_text_content(msg.get("content"), role="user")
        text = strip_channel_envelope(text) if text else text
        if text and text.strip():
            return text.strip()
    return ""


def run_prefetch(hook_input: dict, config: dict) -> bool:
    """Execute one prefetch cycle. Returns True iff a buffer+sentinel pair
    was written. Never raises — every internal step is wrapped so a bug in
    ANY sub-step degrades to "no buffer written this turn", never a crash
    that could take the Stop hook (and thus the turn) down with it."""
    session_id = hook_input.get("session_id") or "unknown"

    # F6 — junk gate derived from the TRANSCRIPT's last human turn, not from a
    # `hook_input["prompt"]` field. A Stop hook's input carries only
    # session_id/transcript_path/stop_hook_active — never `prompt`/`user_prompt`
    # — so the old `hook_input.get("prompt")` gate was permanently empty and
    # NEVER fired, meaning prefetch would run on `<task-notification>` turns once
    # lit. `_last_human_prompt` reads the same last-human turn the speculative
    # query is derived from, so the gate now fires on exactly the synthetic
    # follow-up turns `recall.py`'s synchronous gate skips (honouring the same
    # `recallSkipTaskNotification` switch).
    transcript_path = hook_input.get("transcript_path") or ""
    query = _last_human_prompt(transcript_path)
    if config.get("recallSkipTaskNotification", True) and query.startswith("<task-notification"):
        debug_log(config, "Prefetch: task-notification turn, skipping")
        return False

    # Step 0 — MUTATION INVALIDATION (red-team-M3 R2, BLOCKER). This turn is
    # about to retain (step 1) — a memory mutation. Drop any buffer left from a
    # prior turn BEFORE recalling, so that if this turn's fresh recall fails or
    # returns empty (steps 2-3 below bail without overwriting), the consumer
    # cannot resurrect the pre-mutation snapshot: with no sentinel it falls to
    # the explicitly stale-marked LAST_RECALL_STATE / degraded notice instead of
    # serving a stale buffer as fresh. A successful recall repopulates the buffer
    # with the post-mutation snapshot at step 3. Never raises.
    recall_buffer.invalidate(session_id)

    # Step 1 — delta retain (Fix A: content-derived document_id, never the
    # bare {session_id} document; never truncates).
    try:
        retain_module.run_retain(hook_input, force=False, delta=True)
    except Exception as exc:  # pragma: no cover - defensive
        debug_log(config, f"Prefetch: delta retain failed, continuing without it: {exc}")

    # Step 2 — speculative recall (query derived above from the transcript's
    # last human turn).
    if not query:
        debug_log(config, "Prefetch: no usable query, nothing to prefetch")
        return False

    try:
        bank_id = derive_bank_id(hook_input, config)
        api_url = get_api_url(config)
        client = HindsightClient(api_url)
        response = client.recall(
            bank_id,
            query,
            types=None,
            timeout=config.get("memoryPrefetchTimeoutSeconds", 5),
        )
        results = (response or {}).get("results") or []
    except Exception as exc:  # pragma: no cover - defensive
        debug_log(config, f"Prefetch: recall fetch failed: {exc}")
        return False

    if not results:
        debug_log(config, "Prefetch: no candidates, nothing to buffer")
        return False

    # F5 — CURATE before buffering, through the SAME pipeline the synchronous
    # recall path enforces (demote-drop, relevance sort, score floor, and the
    # `recallMaxMemories` cap). Calling recall's shared helper — rather than
    # `format_memories(results)` on the raw set — is what stops a demoted or
    # uncapped memory from reaching the buffer and bypassing curation the sync
    # path applies (carve §6.1 sharing requirement). Imported lazily so the
    # flag-off no-op in `main()` never pays recall.py's import cost.
    try:
        import recall  # noqa: PLC0415 - lazy, kept off the flag-off no-op path

        results = recall.curate_recall_results(results, config, bank_id)
    except Exception as exc:  # pragma: no cover - defensive
        debug_log(config, f"Prefetch: curation failed, skipping buffer: {exc}")
        return False

    if not results:
        debug_log(config, "Prefetch: all candidates filtered by curation, nothing to buffer")
        return False

    from lib.content import format_memories

    memories_block = format_memories(results)
    if not memories_block:
        return False

    # Step 3 — write payload THEN sentinel, strictly in that order.
    try:
        recall_buffer.write_buffer(session_id, memories_block, {"result_count": len(results)})
        recall_buffer.write_sentinel(session_id)
    except Exception as exc:  # pragma: no cover - defensive
        debug_log(config, f"Prefetch: buffer write failed: {exc}")
        return False

    return True


def main():
    config = load_config()
    if not config.get("memoryPrefetchEnabled", False):
        # Fix C, producer side: the whole mechanism is dark by default.
        return

    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        print("[Hindsight] Prefetch: failed to read hook input", file=sys.stderr)
        return

    try:
        run_prefetch(hook_input, config)
    except Exception as exc:  # pragma: no cover - defensive, must never break the turn
        print(f"[Hindsight] Prefetch: unexpected error: {exc}", file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # pragma: no cover - defensive
        print(f"[Hindsight] Unexpected error in prefetch: {e}", file=sys.stderr)
        sys.exit(0)
