"""Active directives fetching and formatting for the recall hook.

Why this lives separately from `content.py`:
  Hindsight's `reflect` MCP tool has an upstream bug
  (vectorize-io/hindsight#1269) where tagged directives are silently dropped
  from synthesis. Until that ships, we surface directives client-side as a
  structurally distinct top-of-prompt block so the agent reads them every
  turn — independent of whatever `reflect` does with them.

  `list_directives` itself works correctly upstream — only `reflect` is
  broken — so this is a pure client-side win.

Failure mode: any error fetching directives (HTTP error, malformed
response, timeout) returns an empty list and logs a single warn line to
stderr. We never raise to the caller — directives are nice-to-have on the
recall path; a directive-fetch failure must not kill the recall block.
"""

import re
import sys
from typing import Optional

# Sanity cap on how many directives we ever inject into the prompt. Banks
# with more active directives than this are pathological; truncate with a
# footer so the agent knows there are more.
MAX_DIRECTIVES = 15

# Hard timeout for the list_directives call. The recall hook is on the
# UserPromptSubmit critical path — we cannot block it for long.
DIRECTIVES_TIMEOUT_SECONDS = 2


def fetch_active_directives(client, bank_id: str, timeout: int = DIRECTIVES_TIMEOUT_SECONDS) -> list:
    """Fetch active directives for a bank, sorted by priority (highest first).

    Args:
        client: A HindsightClient instance with a list_directives method.
        bank_id: The bank to fetch directives from.
        timeout: HTTP timeout in seconds.

    Returns:
        A list of directive dicts (each with id, name, content, priority,
        tags, ...), sorted by priority descending. On any failure returns
        an empty list and logs a single warn line to stderr — never raises.
    """
    try:
        response = client.list_directives(bank_id=bank_id, active_only=True, timeout=timeout)
    except Exception as e:
        print(f"[Hindsight] list_directives failed for bank '{bank_id}': {e}", file=sys.stderr)
        return []

    if not isinstance(response, dict):
        print(
            f"[Hindsight] list_directives returned non-dict for bank '{bank_id}': "
            f"{type(response).__name__}",
            file=sys.stderr,
        )
        return []

    items = response.get("items")
    if not isinstance(items, list):
        # Empty / malformed response — quiet success, no warn (banks with
        # no directives are normal).
        return []

    # Filter to dicts only, then sort by priority descending. Treat missing
    # priority as 0 so malformed entries sink to the bottom rather than
    # crashing.
    valid = [d for d in items if isinstance(d, dict)]
    valid.sort(key=lambda d: d.get("priority", 0), reverse=True)
    return valid


def format_active_directives_block(directives: list, max_directives: int = MAX_DIRECTIVES) -> Optional[str]:
    """Format directives into the <active_directives> block string.

    Returns None if the list is empty — callers should omit the block
    entirely rather than emitting an empty wrapper.

    Format:
        <active_directives>
        The following are HARD RULES the agent must follow on this turn. ...

        1. [P10] <name>: <content>
        2. [P9] <name>: <content>
        ...
        (+N more, omitted)
        </active_directives>
    """
    if not directives:
        return None

    total = len(directives)
    truncated = directives[:max_directives]
    omitted = total - len(truncated)

    lines = [
        "<active_directives>",
        (
            "The following are HARD RULES the agent must follow on this turn. "
            "They are the bank's currently active directives, ordered by priority. "
            "Apply them when formulating your response."
        ),
        "",
    ]

    for i, d in enumerate(truncated, start=1):
        priority = d.get("priority", 0)
        name = (d.get("name") or "").strip() or "(unnamed)"
        content = (d.get("content") or "").strip()
        # Content verbatim — directives are deliberately authored. Do not
        # reformat or truncate.
        lines.append(f"{i}. [P{priority}] {name}: {content}")

    if omitted > 0:
        lines.append("")
        lines.append(f"(+{omitted} more, omitted)")

    lines.append("</active_directives>")
    return "\n".join(lines)


# --- Directive dedup (switchroom #2903 Fix 6.2) --------------------------------
#
# A user restating a rule that is ALREADY an active directive should not get
# re-nudged, and the Stage C verifier must not BLOCK the turn where the model
# correctly declines to re-create the duplicate. The verifier can see the
# directives that were injected THIS turn (recall.py emits the
# <active_directives> block into the prompt), so it reads them back out of the
# transcript and treats a rule already covered there as "already captured".
#
# Matching is a deterministic lexical-overlap heuristic (no model call, no API
# call — the verifier is on the Stop critical path). It is intentionally
# lenient: a false "already captured" only means we skip a re-prompt (the rule
# is genuinely already stored in that case), whereas a false "not captured"
# re-blocks a turn the model correctly finished. So we err toward treating a
# strong token overlap as a duplicate.

# Parses the numbered "N. [P<pri>] <name>: <content>" body lines out of a
# rendered <active_directives> block (see format_active_directives_block).
_ACTIVE_DIRECTIVE_LINE_RE = re.compile(
    r"^\s*\d+\.\s*\[P-?\d+\]\s*[^:]*:\s*(?P<content>.+?)\s*$"
)

# Low-signal words stripped before overlap scoring so "always"/"you"/"please"
# framing doesn't inflate similarity between two unrelated rules.
_DEDUP_STOPWORDS = frozenset(
    {
        "the", "a", "an", "to", "of", "and", "or", "for", "in", "on", "at",
        "is", "are", "be", "you", "your", "i", "we", "me", "my", "it", "that",
        "this", "with", "as", "so", "do", "dont", "don", "not", "never",
        "always", "please", "should", "must", "want", "from", "now", "on",
        "going", "forward", "forwards", "future", "rule", "remember", "call",
        "use", "using", "make", "sure", "when", "if", "just", "will", "can",
    }
)


def _dedup_tokens(text: str) -> set:
    """Normalize text into a set of significant lower-case word tokens."""
    if not isinstance(text, str):
        return set()
    words = re.findall(r"[a-z0-9]+", text.lower())
    return {w for w in words if w not in _DEDUP_STOPWORDS and len(w) > 1}


def parse_active_directives_block(text: str) -> list:
    """Extract the directive CONTENT strings from a rendered
    <active_directives> block (as produced by format_active_directives_block).

    Returns [] when the block is absent or malformed. Pure string parsing.
    """
    if not isinstance(text, str) or "<active_directives>" not in text:
        return []
    # Isolate the block body between the tags (tolerate missing close tag).
    body = text.split("<active_directives>", 1)[1]
    body = body.split("</active_directives>", 1)[0]
    contents = []
    for line in body.splitlines():
        m = _ACTIVE_DIRECTIVE_LINE_RE.match(line)
        if m:
            contents.append(m.group("content").strip())
    return contents


def rule_already_captured(
    rule_text: str, directive_contents: list, threshold: float = 0.6
) -> bool:
    """True when ``rule_text`` is lexically well-covered by an EXISTING active
    directive in ``directive_contents``.

    Coverage = |rule_tokens ∩ directive_tokens| / |rule_tokens| for the
    best-matching directive. A high coverage ratio means the restated rule adds
    (almost) no new significant words over one already stored — i.e. a
    duplicate. Deterministic; no model/API call.
    """
    rule_tokens = _dedup_tokens(rule_text)
    if not rule_tokens:
        return False
    for content in directive_contents:
        d_tokens = _dedup_tokens(content)
        if not d_tokens:
            continue
        covered = len(rule_tokens & d_tokens) / len(rule_tokens)
        if covered >= threshold:
            return True
    return False
