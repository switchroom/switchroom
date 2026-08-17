"""Memory v2 M5 — Surface B: orientation-at-boot (pure logic).

carve-M5.md §3/§5/§0c. This module holds the network-free, deterministically
testable half of the orientation SessionStart hook: staleness classification
(per-tier thresholds, NOT a fixed 36h), rule-aware truncation to the content
token budget, and the `additionalContext` rendering. The hook entry
(`orientation.py`) does the I/O — resolve own bank, list mental models, match
the orientation model by name, GET its content — and calls into here so the
budget/staleness/render logic can be unit-tested without a live engine.

Why the split mirrors the fleet's other deterministic memory surfaces
(recall.py's nudge regexes, prefetch.py's buffer contract): the value is a
DETERMINISTIC mechanism, not model discretion, so every branch that decides
"inject / prefix-as-stale / degrade-to-cold / truncate" must be pinned by a
test that fails on the bug it guards (carve §8 tautology-guard discipline).

TOKEN BUDGET (carve §0c). The epic caps the injected briefing at 2048 tokens,
but M0 measured real mental models at ~1,766–1,962 tokens of CONTENT alone —
so a naive "cap at 2048" overflows the moment a stale prefix or framing is
prepended. The real number to design to is a CONTENT budget below the cap,
leaving headroom for the prefix + framing. Truncation is rule-aware: whole
markdown sections are kept, trailing sections dropped, and a visible marker is
emitted so the loss is never silent.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone

#: Hard ceiling on the total injected `additionalContext` (epic line 143).
ORIENTATION_TOTAL_TOKEN_CAP = 2048
#: Budget for the model CONTENT alone, below the cap so the stale prefix +
#: framing tags fit inside 2048 (carve §0c: ~1,800, reserving ~250).
ORIENTATION_CONTENT_TOKEN_BUDGET = 1800
#: Chars-per-token estimate M0 used to convert measured char sizes to tokens
#: (7,063 chars ≈ 1,766 tokens). Deterministic proxy — no tokenizer dependency
#: on the boot critical path.
CHARS_PER_TOKEN = 4

#: Emitted (once) when trailing sections were dropped to fit the budget, so the
#: loss is visible to the model rather than a silent mid-sentence byte-cut.
TRUNCATION_MARKER = "(orientation truncated to fit context budget)"

# Framing tags. Kept intentionally tiny — they count against the 2048 cap.
_OPEN_TAG = "<orientation source=\"memory\">"
_CLOSE_TAG = "</orientation>"


def estimate_tokens(text: str) -> int:
    """Deterministic token estimate (ceil of chars / CHARS_PER_TOKEN).

    A proxy, not a real tokenizer — but the SAME proxy M0 measured content
    sizes with, so the budget math is internally consistent, and it needs no
    model/tokenizer on the boot path. Empty string is 0 tokens.
    """
    if not text:
        return 0
    return math.ceil(len(text) / CHARS_PER_TOKEN)


def classify_staleness(
    last_refreshed_at: str | None,
    cadence_hours: int,
    now: datetime | None = None,
) -> tuple[str, float | None]:
    """Classify an orientation model's freshness against its agent's TIER.

    Returns ``(state, hours_ago)`` where state is one of:
      - ``"fresh"``    — refreshed < 1.5× cadence ago: inject plainly.
      - ``"stale"``    — 1.5×–3× cadence ago: inject WITH a visible prefix.
      - ``"degraded"`` — > 3× cadence ago: do NOT inject stale-as-fresh; the
                          hook emits the cold notice + enqueues a refresh.
      - ``"unknown"``  — no/unparseable ``last_refreshed_at``: treat as cold
                          (fail closed — never present an un-dated model as
                          fresh). ``hours_ago`` is None.

    The thresholds are PER-TIER (carve §5): a fixed 36h would mislabel every
    48h-cadence agent as stale a full day early. 1.5× / 3× of the resolved
    cadence is the tier-correct boundary — 36h/72h at cadence 24, 72h/144h at
    cadence 48. Keyed on ``last_refreshed_at`` (the freshness watermark the
    persisting refresh advances — m5-0-probe Q3), NOT ``updated_at`` (returned
    null on the single-model read) and NOT the engine's own ``is_stale`` (its
    threshold is engine-defined, not the agent's tier).
    """
    if now is None:
        now = datetime.now(timezone.utc)
    if not last_refreshed_at:
        return ("unknown", None)
    ts = _parse_iso(last_refreshed_at)
    if ts is None:
        return ("unknown", None)
    # A naive timestamp is assumed UTC (the engine stores tz-aware UTC; this is
    # belt-and-braces so an aware/naive mismatch can never raise on subtract).
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    hours_ago = (now - ts).total_seconds() / 3600.0
    # Guard a clock-skew future timestamp: treat as fresh, never negative-stale.
    if hours_ago < 0:
        hours_ago = 0.0
    stale_at = 1.5 * cadence_hours
    degrade_at = 3.0 * cadence_hours
    if hours_ago < stale_at:
        return ("fresh", hours_ago)
    if hours_ago < degrade_at:
        return ("stale", hours_ago)
    return ("degraded", hours_ago)


def _parse_iso(value: str) -> datetime | None:
    """Parse an engine ISO-8601 timestamp, tolerating a trailing ``Z``."""
    try:
        # datetime.fromisoformat handles "+00:00" and fractional seconds; map a
        # trailing Z (some engine surfaces emit it) to the offset form first.
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def truncate_to_budget(content: str, token_budget: int) -> tuple[str, bool]:
    """Rule-aware truncation to ``token_budget`` tokens.

    Returns ``(text, truncated)``. Prefers WHOLE markdown sections (a section
    starts at a line beginning with ``#``): accumulates sections while they fit,
    drops trailing sections that don't, and signals ``truncated=True`` so the
    caller can append :data:`TRUNCATION_MARKER`. If the very first section
    already exceeds the budget, hard-cuts at a whitespace boundary (never
    mid-word) rather than emitting nothing.

    Never returns more than the budget; an empty/whitespace input returns
    ``("", False)``.
    """
    content = (content or "").strip()
    if not content:
        return ("", False)
    if estimate_tokens(content) <= token_budget:
        return (content, False)

    sections = _split_sections(content)
    kept: list[str] = []
    used = 0
    for sec in sections:
        sec_tokens = estimate_tokens(sec)
        # +1 token slack for the join newline between kept sections.
        if kept and used + sec_tokens + 1 > token_budget:
            break
        if not kept and sec_tokens > token_budget:
            # First section alone overflows — hard-cut on a word boundary.
            return (_hard_cut(sec, token_budget), True)
        kept.append(sec)
        used += sec_tokens + (1 if len(kept) > 1 else 0)

    if not kept:
        return (_hard_cut(sections[0], token_budget), True)
    return ("\n".join(kept).strip(), True)


def _split_sections(content: str) -> list[str]:
    """Split markdown into whole sections at lines beginning with ``#``.

    Leading preamble before the first header is its own section. A document
    with no headers is a single section (the hard-cut path handles overflow).
    """
    lines = content.split("\n")
    sections: list[str] = []
    cur: list[str] = []
    for line in lines:
        if line.startswith("#") and cur:
            sections.append("\n".join(cur))
            cur = [line]
        else:
            cur.append(line)
    if cur:
        sections.append("\n".join(cur))
    return sections


def _hard_cut(text: str, token_budget: int) -> str:
    """Cut ``text`` to fit ``token_budget`` at a whitespace boundary."""
    char_budget = max(0, token_budget * CHARS_PER_TOKEN)
    if len(text) <= char_budget:
        return text.strip()
    cut = text[:char_budget]
    # Back up to the last whitespace so we never slice a word in half.
    ws = cut.rfind(" ")
    nl = cut.rfind("\n")
    boundary = max(ws, nl)
    if boundary > 0:
        cut = cut[:boundary]
    return cut.strip()


def stale_prefix(hours_ago: float | None) -> str:
    """One-line visible staleness prefix (carve §5). Never presents stale as fresh."""
    if hours_ago is None:
        return "(orientation staleness unknown — may be stale)"
    return f"(orientation last refreshed {int(round(hours_ago))}h ago — may be stale)"


def cold_notice() -> str:
    """One-line cold notice (carve §3-4): no usable model, boot un-blocked.

    Visible by design — a missing/degraded briefing degrades to a NOTICE the
    model can see, never a silently memoryless boot.
    """
    return (
        f"{_OPEN_TAG}\n"
        "orientation model not yet built or refreshed — booting without a "
        "briefing (a background refresh has been requested)\n"
        f"{_CLOSE_TAG}"
    )


def render_orientation(
    content: str,
    staleness: str,
    hours_ago: float | None,
) -> str:
    """Render the injected `additionalContext` for a usable model.

    Applies the stale prefix when warranted, truncates the CONTENT to
    :data:`ORIENTATION_CONTENT_TOKEN_BUDGET` (rule-aware), wraps in the tiny
    framing tags, and guarantees the WHOLE rendered block (prefix + framing +
    content) stays within :data:`ORIENTATION_TOTAL_TOKEN_CAP` — if the prefix
    pushes it over, the content budget is trimmed further so the cap holds.

    Callers pass only ``fresh`` or ``stale`` here; ``degraded``/``unknown`` go
    to :func:`cold_notice` in the hook (never rendered as fresh).
    """
    prefix = stale_prefix(hours_ago) if staleness == "stale" else ""
    # Reserve budget for the framing tags + prefix so the TOTAL stays under the
    # hard cap, not just the content.
    framing_tokens = estimate_tokens(_OPEN_TAG) + estimate_tokens(_CLOSE_TAG) + 2
    prefix_tokens = estimate_tokens(prefix) + (1 if prefix else 0)
    content_budget = min(
        ORIENTATION_CONTENT_TOKEN_BUDGET,
        ORIENTATION_TOTAL_TOKEN_CAP - framing_tokens - prefix_tokens,
    )
    body, truncated = truncate_to_budget(content, content_budget)
    if truncated:
        body = f"{body}\n\n{TRUNCATION_MARKER}"

    parts = [_OPEN_TAG]
    if prefix:
        parts.append(prefix)
    parts.append(body)
    parts.append(_CLOSE_TAG)
    return "\n".join(parts)
