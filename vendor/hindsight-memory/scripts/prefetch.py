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

    prompt = (hook_input.get("prompt") or hook_input.get("user_prompt") or "").strip()
    if prompt.startswith("<task-notification"):
        debug_log(config, "Prefetch: task-notification turn, skipping")
        return False

    # Step 1 — delta retain (Fix A: content-derived document_id, never the
    # bare {session_id} document; never truncates).
    try:
        retain_module.run_retain(hook_input, force=False, delta=True)
    except Exception as exc:  # pragma: no cover - defensive
        debug_log(config, f"Prefetch: delta retain failed, continuing without it: {exc}")

    # Step 2 — speculative recall.
    transcript_path = hook_input.get("transcript_path") or ""
    query = _last_human_prompt(transcript_path)
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
