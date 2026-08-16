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
import time
from typing import Optional

from .state import list_state_names, read_state, remove_state, write_state

# Sanity cap on how many directives we ever inject into the prompt.
#
# This number is a COST TRADEOFF, not an arbitrary limit, and the real cost is
# larger than "one block": `recall.py` rebuilds the <active_directives> block
# on EVERY UserPromptSubmit (the `format_active_directives_block` call there)
# with no per-session dedupe and no "unchanged since last turn" suppression,
# and `additionalContext` is APPENDED into the conversation. So the block is
# re-paid every turn and accumulates — roughly (block size) x (turn count) over
# a session, not once.
#
# Measured live 2026-07-25 (fleet REST `/directives`):
#   overlord  12 active  ~9.8 KB   ~816 chars avg  (one 2,981-char outlier)
#   klanker   17 active  ~9.9 KB   ~585 chars avg
#   gymbro     9 active  ~9.3 KB  ~1038 chars avg
# At the ~700-char fleet average, a bank sitting at this cap injects ~21 KB —
# on the order of 5,000-6,000 tokens per injection, per turn, cumulative across
# the session. 30 is chosen to clear the observed fleet maximum with headroom;
# it is NOT a size at which a runaway bank becomes harmless. The actual defence
# against pile-up is the doctor's WARN/FAIL on the active directive count
# (src/cli/doctor-memory.ts), not this cap. Raising it further is a legitimate
# call — make it deliberately, with the per-turn-times-turns cost in mind, and
# move the doctor thresholds with it.
#
# Banks with more active directives than this are pathological; we truncate
# with a LOUD, operator-directed in-prompt overflow notice (memory-RFC P7 — the
# in-turn channel), a `directives_omitted` field on the recall_log row, and a
# stderr warning (see `format_active_directives_block`).
MAX_DIRECTIVES = 30

# Hard timeout for the list_directives call. The recall hook is on the
# UserPromptSubmit critical path — we cannot block it for long.
DIRECTIVES_TIMEOUT_SECONDS = 2

# --- Directives-list cache (switchroom hindsight-leverage A4) -----------------
#
# `list_directives` runs on the recall (UserPromptSubmit) critical path every
# non-skipped turn — a fresh 2s-timeout HTTP round-trip whose result changes
# only when a directive is created/updated/deleted (rare). We cache the fetched
# list in the plugin state dir with a short TTL so the common no-write turn
# skips the round-trip, while bounding staleness:
#   * In-session writes: directive_verify.py (Stop hook) deletes the cache when
#     the just-ended turn contains a create/update/delete_directive tool_use, so
#     the very next recall re-fetches — the new state is visible in turn N+1.
#   * Cross-process writes (another session, operator CLI) have no invalidation
#     channel and rely on TTL alone → at most TTL seconds stale.
#
# Invalidation blind spots (both fall back to TTL, ≤ TTL stale — acceptable):
#   * Sub-agent / sidechain directive writes: the create_directive tool_use is
#     in the SIDECHAIN transcript, not the parent's, so the parent's Stop hook
#     (which reads the parent transcript) never sees it. PR 5 (SubagentStop)
#     is where sidechain awareness lands.
#   * Bash / operator-CLI directive writes (`switchroom` or a curl) produce no
#     tool_use in any transcript, so there is nothing for the Stop hook to
#     detect.
#
# Rollback: set the TTL to 0 (HINDSIGHT_DIRECTIVES_CACHE_TTL_SECONDS=0) to
# disable the cache entirely — every turn fetches live, as before A4.
DIRECTIVES_CACHE_TTL_SECONDS = 120

# All directive cache files share this basename prefix so they can be
# enumerated for bulk (bank-agnostic) invalidation.
_CACHE_PREFIX = "directives_cache."


def _cache_name(bank_id: str) -> str:
    """State-file name for a bank's cached directive list."""
    return f"{_CACHE_PREFIX}{bank_id}.json"


def _fetch_directives_with_status(client, bank_id: str, timeout: int) -> tuple:
    """Fetch + normalize active directives, reporting fetch success.

    Returns ``(ok, directives)``. ``ok`` is False only on a genuine fetch
    FAILURE (HTTP error, non-dict response) — a bank that simply has no
    directives returns ``(True, [])``. Callers use ``ok`` to avoid caching a
    transient failure's empty result (which would mask real directives for a
    whole TTL window). Never raises; logs a single warn line on failure.
    """
    try:
        response = client.list_directives(bank_id=bank_id, active_only=True, timeout=timeout)
    except Exception as e:
        print(f"[Hindsight] list_directives failed for bank '{bank_id}': {e}", file=sys.stderr)
        return False, []

    if not isinstance(response, dict):
        print(
            f"[Hindsight] list_directives returned non-dict for bank '{bank_id}': "
            f"{type(response).__name__}",
            file=sys.stderr,
        )
        return False, []

    items = response.get("items")
    if not isinstance(items, list):
        # Empty / malformed response — quiet success, no warn (banks with
        # no directives are normal). Cacheable.
        return True, []

    # Filter to dicts only, then sort by priority descending. Treat missing
    # priority as 0 so malformed entries sink to the bottom rather than
    # crashing.
    valid = [d for d in items if isinstance(d, dict)]
    valid.sort(key=lambda d: d.get("priority", 0), reverse=True)
    return True, valid


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
    _ok, directives = _fetch_directives_with_status(client, bank_id, timeout)
    return directives


def _read_cache(bank_id: str) -> Optional[dict]:
    """Read + validate a bank's cache envelope. Returns None on miss/corruption.

    A corrupted or wrong-shaped cache (bad JSON handled by read_state; here we
    additionally reject a non-dict envelope, a non-numeric timestamp, or a
    non-list directive payload) is treated as a MISS so the caller falls back to
    a live fetch rather than injecting garbage.

    Also rejects an envelope whose stored ``bank_id`` does not match the
    requested one: ``_safe_filename`` can collapse two distinct bank ids onto a
    single cache file, and serving bank A's directives for bank B would leak
    rules across banks. The embedded ``bank_id`` is the authoritative key.
    """
    raw = read_state(_cache_name(bank_id), None)
    if not isinstance(raw, dict):
        return None
    if raw.get("bank_id") != bank_id:
        return None
    ts = raw.get("ts")
    directives = raw.get("directives")
    if not isinstance(ts, (int, float)) or isinstance(ts, bool):
        return None
    if not isinstance(directives, list):
        return None
    return raw


def fetch_active_directives_cached(
    client,
    bank_id: str,
    ttl_seconds: int = DIRECTIVES_CACHE_TTL_SECONDS,
    timeout: int = DIRECTIVES_TIMEOUT_SECONDS,
    now: Optional[float] = None,
) -> list:
    """Cached wrapper around :func:`fetch_active_directives`.

    On a fresh cache hit (age < ``ttl_seconds``) returns the cached list WITHOUT
    an HTTP call. On a miss / expiry / corrupted cache, fetches live and, when
    the fetch SUCCEEDED, writes the cache. A failed fetch is never cached, so a
    transient error can't mask real directives for a TTL window.

    ``ttl_seconds <= 0`` disables the cache (always live-fetch, never write) —
    the A4 rollback lever.

    Args:
        now: Injectable current epoch seconds, for deterministic tests.
    """
    if now is None:
        now = time.time()

    caching = isinstance(ttl_seconds, (int, float)) and ttl_seconds > 0

    if caching:
        cached = _read_cache(bank_id)
        if cached is not None:
            age = now - cached["ts"]
            # A negative age means the stored timestamp is in the FUTURE
            # (wall-clock step-back / a doctored envelope) — treat it as
            # expired rather than "fresh forever", so a clock correction can't
            # pin a stale cache.
            if 0 <= age < ttl_seconds:
                return cached["directives"]

    ok, directives = _fetch_directives_with_status(client, bank_id, timeout)

    if caching and ok:
        write_state(_cache_name(bank_id), {"ts": now, "bank_id": bank_id, "directives": directives})

    return directives


def invalidate_directives_cache(bank_id: Optional[str] = None) -> None:
    """Delete the directives cache so the next recall re-fetches live.

    With ``bank_id`` set, removes just that bank's cache file. With no argument
    (the Stop-hook invalidation path, which does not resolve the bank), removes
    EVERY directive cache file — directive writes are rare, so a bank-agnostic
    sweep is cheap and robust. Best-effort; never raises.
    """
    if bank_id is not None:
        remove_state(_cache_name(bank_id))
        return
    for name in list_state_names(_CACHE_PREFIX):
        remove_state(name)


def count_omitted_directives(directives: list, max_directives: int = MAX_DIRECTIVES) -> int:
    """How many directives `format_active_directives_block` would DROP.

    Pure counterpart of the truncation branch below, so `recall.py` can put the
    number on the recall_log row without re-deriving the cap. 0 when nothing is
    dropped.
    """
    return max(0, len(directives) - max_directives)


def injected_directive_ids(directives: list, max_directives: int = MAX_DIRECTIVES) -> list:
    """The `id`s of the directives `format_active_directives_block` would
    actually INJECT (the `[:max_directives]` head-slice), in the same
    priority-descending order the block renders them.

    Read-only / additive instrumentation (step 1 of the memory redesign,
    E-45 recommendation (b)): today a recall_log row records only
    `directive_count` (how many were fetched) and `directives_omitted` (how
    many were dropped by the cap), never WHICH directives actually reached
    the prompt. This makes exposure queryable — e.g. "which directives have
    never once been injected" — without touching what gets injected. Skips
    any directive dict missing a truthy `id` rather than raising, so a
    malformed entry can't take recall telemetry down.
    """
    truncated = directives[:max_directives] if directives else []
    return [d["id"] for d in truncated if isinstance(d, dict) and d.get("id")]


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

        === DIRECTIVE OVERFLOW — ACTION REQUIRED ===
        <N of TOTAL directives dropped; agent is told to surface it to the
         operator this turn and merge/retire directives> (only when omitted > 0)
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
        # LOUD in-prompt overflow notice (memory-RFC P7). The prior footer was a
        # single quiet parenthetical — `(+N more, omitted)` — which the agent
        # could read past without registering that explicit, operator-authored
        # instructions had been silently DROPPED from this turn. The three other
        # signals this module records are either not operator-visible (stderr —
        # swallowed, see below) or not in-turn (the `directives_omitted`
        # recall_log row and `switchroom doctor`, both read after the fact). The
        # in-prompt block is the one channel that is BOTH in-turn and reaches an
        # operator — indirectly, because the agent relays it in its reply. So we
        # make the footer loud and explicitly action-directed: state the loss,
        # name the count and cap, and instruct the agent to surface it to the
        # operator THIS turn. This is the P7 "loud channel" and is deliberately
        # NOT a MAX_DIRECTIVES change (raising the cap only moves the silent-drop
        # point; visibility has to ship first).
        #
        # The literal `(+N more, omitted)` marker is retained verbatim so the
        # existing recall_log/doctor cross-checks and the directive-dedup parser
        # (`parse_active_directives_block`) keep working unchanged.
        lines.append("")
        lines.append("=== DIRECTIVE OVERFLOW — ACTION REQUIRED ===")
        lines.append(
            f"{omitted} of {total} active directives were DROPPED from this turn's "
            f"prompt: the bank exceeds MAX_DIRECTIVES={max_directives}, so the "
            f"{omitted} LOWEST-priority directive(s) are NOT in effect this turn. "
            "This is silent loss of explicit, operator-authored instructions."
        )
        lines.append(
            "ACTION: tell the operator in your reply this turn that directive "
            "overflow is dropping rules, then merge or retire duplicate/stale "
            "directives (mental-model-curator skill) to get the bank back under "
            "the cap. Do not let this pass unmentioned."
        )
        lines.append(f"(+{omitted} more, omitted)")
        # The in-prompt notice above is the operator-visible in-turn channel
        # (P7): the agent reads it every turn the overflow persists and is told
        # to relay it. This stderr warn is the same channel every other
        # operational failure in this module uses (see
        # `_fetch_directives_with_status`), and it is a LAST-RESORT breadcrumb
        # only — do NOT rely on it reaching an operator.
        #
        # Measured 2026-07-25: `docker logs --tail 20000` across all 12 running
        # agent containers returns ZERO `[Hindsight]` lines, and nothing under
        # ~/.switchroom/logs/ contains them either, despite months of runtime
        # and several long-standing stderr paths in recall.py. Claude Code
        # appears to swallow hook stderr on a zero exit, so hook stderr is not
        # an operator-visible channel.
        #
        # The other channels that reach an operator, but only AFTER the turn:
        #   * the `directives_omitted` field on the recall_log row
        #     (state/recall_log.jsonl — see `count_omitted_directives`), and
        #   * `switchroom doctor`'s WARN/FAIL on the bank's active directive
        #     count (src/cli/doctor-memory.ts `classifyDirectiveCount`), which
        #     reads the count from the same REST surface this module fetches.
        print(
            f"[Hindsight] directive truncation: {total} active directives exceeds "
            f"MAX_DIRECTIVES={max_directives} — {omitted} lowest-priority "
            f"directive(s) were DROPPED from this turn's prompt. Merge or retire "
            f"directives (mental-model-curator) or raise MAX_DIRECTIVES.",
            file=sys.stderr,
        )

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


# Length-aware guard for terse rules (#2912). Forward coverage alone
# (|rule ∩ directive| / |rule|) is easy to satisfy when the rule has only a
# couple of significant tokens: any long directive that happens to contain
# those few words scores ~1.0 and silently swallows a genuinely-new short
# rule, skipping a legitimate re-prompt. For such short rules we additionally
# require REVERSE coverage — the matched directive's significant-token set must
# also be substantially covered by the rule's — which is a Jaccard-style
# bidirectional check. That fails precisely the "few tokens diluted inside a
# long unrelated directive" case while still passing a terse rule that restates
# a comparably terse directive.
#
# Constants chosen against the real tokenizer output:
#   - < 4 significant tokens is "short" (1-3 tokens: the regime where a single
#     incidental word swings forward coverage past 0.6).
#   - reverse coverage >= 0.5 keeps near-equal-size restatements deduped
#     (e.g. a 2-token rule vs a 4-token directive → 2/4 = 0.5) but rejects a
#     2-token rule diluted inside a 6+-token directive (2/6 ≈ 0.33 < 0.5).
_SHORT_RULE_TOKEN_LIMIT = 4
_SHORT_RULE_REVERSE_COVERAGE = 0.5


def rule_already_captured(
    rule_text: str, directive_contents: list, threshold: float = 0.6
) -> bool:
    """True when ``rule_text`` is lexically well-covered by an EXISTING active
    directive in ``directive_contents``.

    Coverage = |rule_tokens ∩ directive_tokens| / |rule_tokens| for the
    best-matching directive. A high coverage ratio means the restated rule adds
    (almost) no new significant words over one already stored — i.e. a
    duplicate. Deterministic; no model/API call.

    For terse rules (fewer than ``_SHORT_RULE_TOKEN_LIMIT`` significant tokens)
    forward coverage is not sufficient — see the module comment above — so a
    reverse-coverage guard is also required before declaring a match.
    """
    rule_tokens = _dedup_tokens(rule_text)
    if not rule_tokens:
        return False
    is_short_rule = len(rule_tokens) < _SHORT_RULE_TOKEN_LIMIT
    for content in directive_contents:
        d_tokens = _dedup_tokens(content)
        if not d_tokens:
            continue
        intersection = len(rule_tokens & d_tokens)
        covered = intersection / len(rule_tokens)
        if covered < threshold:
            continue
        if is_short_rule:
            # Bidirectional guard: the directive must not be much larger than
            # the rule, or those few shared tokens are incidental overlap
            # rather than a true restatement.
            reverse_covered = intersection / len(d_tokens)
            if reverse_covered < _SHORT_RULE_REVERSE_COVERAGE:
                continue
        return True
    return False
