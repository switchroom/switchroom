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
