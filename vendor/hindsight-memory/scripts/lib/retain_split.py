"""Deterministic size bound for retain content, with structure-preserving split.

Why this exists
---------------
A retain POST is *not* one model call. The Hindsight daemon chunks the
submitted content at ``retain_chunk_size`` chars and runs fact extraction as
one **sequential** LLM call per chunk
(``hindsight_api/config.py`` ``DEFAULT_RETAIN_CHUNK_SIZE = 3000``). So the
server-side wall time of a retain is linear in ``len(content)``, while the
client only ever gets ONE deadline for the whole POST. Past some content
length, no client timeout can cover the work and the retain can never succeed
— not on the live Stop hook, not on the SessionStart drain, not ever. Those
memories are permanently unsaveable.

Measured on the 2026-07-25 fleet backlog (629 queued entries): median content
26,112 chars, p90 150,224, max 744,546. 154 entries exceeded 60,000 chars and
burned the full client deadline on every attempt. A 744,546-char entry is
~249 sequential extraction calls.

Why the bound is enforced here and not server-side
--------------------------------------------------
The daemon *does* have an auto-splitter — ``retain_batch_tokens``
(``DEFAULT_RETAIN_BATCH_TOKENS = 10_000``, "Max chars per sub-batch for async
retain auto-splitting") — but it only applies on the ``async=True`` path.
Every durability retain in this plugin posts ``async=False`` on purpose
(commit-before-ack, switchroom #3244 §1.1): the 200 must prove durable
persistence because a 200 is what lets the caller delete the queue entry and
advance the watermark. So the one server-side mechanism that would help is
structurally unavailable to us. It is also the wrong layer: the server
receives an opaque string and could only cut it at a byte offset, whereas the
plugin still knows the transcript's message structure and can cut on a
message boundary.

The bound is applied at ``HindsightClient.retain()`` — the single function
every retain POST in this plugin goes through (Stop hook, SessionEnd,
drain_pending, reconcile_tail, backfill_transcripts, subagent_retain) — so it
is code-enforced for every present and future caller rather than something a
producer has to remember.

Splitting rules
---------------
Splits are taken on transcript structure, never on a raw byte offset, so a
part is always a syntactically complete transcript with role attribution
intact:

* JSON transcript (``retainToolCalls`` default, a JSON array of
  ``{role, content:[blocks]}``): split the array into groups; each part
  re-serializes as a valid JSON array.
* Text transcript (``[role: x]\\n…\\n[x:end]`` blocks joined by a blank
  line): split on block boundaries; each part is a whole number of blocks.
* An atom (one message / one block) larger than the bound is split at line
  boundaries and each fragment is re-wrapped in the SAME role envelope, so
  context is still attributed rather than stranded.
* Last resort, only if the structural passes cannot get a part under the
  bound (e.g. one unbroken 100k-char line): a hard character slice. The size
  invariant wins over structure at that extreme, because a part over the
  bound is a part that never persists at all.
"""

from __future__ import annotations

import json
import os
from typing import Optional


# ---------------------------------------------------------------------------
# The bound — derived, not chosen
# ---------------------------------------------------------------------------
#
#   max_content_chars = retain_chunk_size
#                       × floor(client_deadline × deadline_safety / chunk_latency)
#
# Each input is a measured or read property of the deployment, not a taste
# call, and each is env-overridable so the bound tracks the deployment:
#
#   retain_chunk_size  3000 s  — server-side chars per extraction chunk.
#                               `hindsight_api/config.py`
#                               DEFAULT_RETAIN_CHUNK_SIZE = 3000. One chunk =
#                               one sequential LLM call.
#   chunk_latency      18.4 s  — measured mean wall time of a healthy retain
#                               extraction call, n=752, LiteLLM SpendLogs
#                               2026-07-25 07:00–08:05 UTC (the 0–7,941
#                               completion-token bucket; the runaway bucket is
#                               a separate defect, fixed by capping
#                               HINDSIGHT_API_RETAIN_MAX_COMPLETION_TOKENS).
#   client_deadline     310 s  — the deadline of the DURABILITY path (the
#                               out-of-hook backlog drain, #3599), deliberately
#                               not the live Stop hook's 15s. The live path is
#                               allowed to miss its deadline: it enqueues to
#                               pending-retains and the drain retries. Sizing
#                               to 15s would cut content to a single chunk and
#                               shred every transcript for no gain.
#                               This is the ONE definition of that deadline:
#                               `drain_pending._backlog_timeout()` defaults to
#                               `retain_client_deadline()` rather than a second
#                               literal, and `src/setup/hindsight.ts`
#                               (`HINDSIGHT_RETAIN_CLIENT_DEADLINE_S`, #3611)
#                               mirrors it as the client half of that PR's
#                               `hindsight per-call timeout < client deadline`
#                               assertion. A test in `tests/setup/hindsight.test.ts`
#                               enforces that the two stay equal, so the mirror
#                               is checked, not merely asserted in prose.
#                               WAS 280.0. Raised to 310 when the retain
#                               per-call timeout became derived from the litellm
#                               routing chain (`local 200 + fallback 90 +
#                               margin 10 = 300`) instead of from the token
#                               budget alone: #3611's 204s could not cover that
#                               chain, so the retain OpenRouter fallback hop had
#                               4s of headroom and could never complete. 310 is
#                               that 300 plus the same one margin, so the plugin
#                               always outlives hindsight by construction. It is
#                               NOT a hand-set number on either side — change
#                               `src/litellm/timeout-budget.ts` and both move.
#
#   deadline_safety    0.7    — the FRACTION of the deadline a maximally-sized
#                               part is allowed to consume. See below; this
#                               input did not exist until #3693 and was
#                               effectively 1.0.
#
#   floor(310 × 0.7 / 18.4) = 11 chunks  →  11 × 3000 = 33,000 chars
#
# WHY THERE IS A SAFETY FRACTION AT ALL (#3693). Without it the bound was
# `floor(deadline / latency)`, which sizes a maximally-sized part to consume
# ~100% of the deadline BY CONSTRUCTION: 16 × 18.4 = 294.4s against a 310s
# deadline is 15.6s — 5% — of headroom for the POST/response, server queueing,
# and any chunk slower than the n=752 MEAN the latency input is. Half the
# extraction calls are slower than the mean; a part sized to the mean therefore
# misses the deadline roughly half the time. `drain_pending._backlog_timeout()`
# defaults to the SAME deadline, so the drainer inherits the same zero margin,
# times the entry out, bumps its attempt count, and after MAX_ATTEMPTS ages it
# to `.dead`. That is not a theory: on this fleet every `.dead` marker measured
# on 2026-07-26 held content of 16,076–44,568 chars — every one of them UNDER
# the then-current 45,000 bound. The bound was manufacturing dead memories.
#
# 0.7 is not a taste call either: it is the utilisation at which the observed
# per-chunk latency distribution fits, and it independently matches the 30,000
# char limit the host-side stopgap converged on empirically before this landed.
# At 0.7 a maximally-sized part is 11 × 18.4 = 202.4s against 310s, leaving
# 107.6s — enough for a chunk distribution ~50% worse than its own mean.
#
# The trade is more parts per logical memory (33,000 rather than 48,000 chars
# each). That costs nothing in total LLM work — the chunk count across the
# whole memory is unchanged, only its grouping — and each part now finishes.
# A part that finishes is worth strictly more than a larger part that does not.
DEFAULT_RETAIN_CHUNK_SIZE = 3000
DEFAULT_RETAIN_CHUNK_LATENCY_S = 18.4
DEFAULT_RETAIN_CLIENT_DEADLINE_S = 310.0

# Fraction of the client deadline a maximally-sized part may consume.
# Clamped to (0, 1]: a value above 1.0 would size parts to overrun the
# deadline outright, which is the defect this input exists to prevent.
DEFAULT_RETAIN_DEADLINE_SAFETY = 0.7

# Absolute floor: one chunk. A bound below one chunk would split every
# transcript into extraction-sized confetti and is never the right answer.
MIN_RETAIN_CONTENT_CHARS = DEFAULT_RETAIN_CHUNK_SIZE


def _env_number(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def retain_client_deadline() -> float:
    """Seconds a DURABILITY caller waits for one retain POST.

    The single definition of that deadline. ``retain_content_limit()`` sizes
    content so a whole POST fits inside it, and
    ``drain_pending._backlog_timeout()`` takes it as its default so the drainer
    actually waits that long — a shorter drain deadline would abandon a
    correctly-sized part mid-extraction and rebuild the very re-post loop #3599
    fixed, one size class up.
    """
    return _env_number("HINDSIGHT_RETAIN_CLIENT_DEADLINE_S", DEFAULT_RETAIN_CLIENT_DEADLINE_S)


def retain_deadline_safety() -> float:
    """Fraction of the client deadline a maximally-sized part may consume.

    Clamped to ``(0, 1]``. A value above 1.0 is not honoured: it would size
    parts to overrun the deadline by construction, which is exactly the defect
    (#3693) this input exists to prevent, so it is treated as "no margin at
    all" — 1.0 — rather than as a licence to go further.
    """
    value = _env_number("HINDSIGHT_RETAIN_DEADLINE_SAFETY", DEFAULT_RETAIN_DEADLINE_SAFETY)
    return min(1.0, value)


def retain_content_limit() -> int:
    """Max chars of retain content that can complete inside the client deadline.

    Recomputed per call (cheap) so a test or an operator can move an input via
    the environment without reimporting the module.
    """
    override = os.environ.get("HINDSIGHT_RETAIN_MAX_CONTENT_CHARS")
    if override:
        try:
            forced = int(override)
            if forced > 0:
                return max(MIN_RETAIN_CONTENT_CHARS, forced)
        except (TypeError, ValueError):
            pass

    chunk_size = int(_env_number("HINDSIGHT_RETAIN_CHUNK_SIZE", DEFAULT_RETAIN_CHUNK_SIZE))
    latency = _env_number("HINDSIGHT_RETAIN_CHUNK_LATENCY_S", DEFAULT_RETAIN_CHUNK_LATENCY_S)
    deadline = retain_client_deadline()

    # A FRACTION of the deadline, not all of it (#3693). Sizing to the whole
    # deadline leaves a maximally-sized part no headroom for the POST itself,
    # server queueing, or a chunk slower than the MEAN `latency` is measured
    # as — so the part times out, the drain bumps its attempt count, and it
    # ages to `.dead`. See the derivation block at the top of this module.
    chunks = int((deadline * retain_deadline_safety()) // latency)
    if chunks < 1:
        chunks = 1
    return max(MIN_RETAIN_CONTENT_CHARS, chunk_size * chunks)


# ---------------------------------------------------------------------------
# Part identity
# ---------------------------------------------------------------------------

def part_document_id(document_id: str, index: int, total: int) -> str:
    """Document id for part ``index`` (0-based) of ``total``.

    ``total <= 1`` returns the id unchanged, so an unsplit retain keeps EXACTLY
    the id it has today and its upsert convergence (retain.py
    ``slice_document_id``) is untouched.

    For a split, ``{base}-p{i}of{n}``: deterministic (same content + same bound
    ⇒ same parts ⇒ same ids, so a retry upserts rather than duplicates), unique
    per part (parts must never overwrite each other — that would be silent
    loss), and prefix-preserving, so the ``{session_id}`` prefix probe in
    ``client.list_session_document_ids`` still finds them.
    """
    if total <= 1:
        return document_id
    return f"{document_id}-p{index + 1}of{total}"


def part_metadata(metadata: Optional[dict], index: int, total: int) -> dict:
    """Metadata for part ``index`` of ``total``, carrying provenance.

    Unsplit retains are returned untouched (a copy). A split stamps the part
    position, so any one part says where it sits in the logical retain and the
    base document id is recoverable from the part id's ``-p{i}of{n}`` suffix.
    Values are strings to match the existing metadata convention
    (``retain.py`` writes ``message_count`` as a string).
    """
    base = dict(metadata or {})
    if total <= 1:
        return base
    base["retain_part_index"] = str(index + 1)
    base["retain_part_count"] = str(total)
    return base


# ---------------------------------------------------------------------------
# Splitting
# ---------------------------------------------------------------------------

_TEXT_BLOCK_SEP = "\n\n"


def split_retain_content(content: str, max_chars: Optional[int] = None) -> list:
    """Split ``content`` into parts each at most ``max_chars`` long.

    Returns ``[content]`` unchanged when it already fits — the overwhelmingly
    common case, and the one where behaviour must not change at all.

    Guarantees, all asserted by the test suite:
      * every part is non-empty and ``<= max_chars``
      * concatenating the parts loses no *message*; only the pathological
        single-unbreakable-line case cuts inside text
      * the split is a pure function of (content, max_chars) — no clock, no
        randomness — so retries converge on identical parts and identical ids
    """
    limit = max_chars if (max_chars and max_chars > 0) else retain_content_limit()
    # Non-string / empty content is passed straight through: the retain path's
    # existing behaviour for it is not this module's business to change.
    if not isinstance(content, str) or len(content) <= limit:
        return [content]

    parts = _split_json(content, limit)
    if parts is None:
        parts = _split_text(content, limit)

    # Normalisation: structure-preserving passes are best-effort; the size
    # bound is not. Anything still over the limit gets hard-sliced, because a
    # part over the limit is a part that never persists.
    normalised: list = []
    for part in parts:
        if len(part) <= limit:
            if part:
                normalised.append(part)
        else:
            normalised.extend(_hard_split(part, limit))
    return normalised or [content[:limit]]


def _hard_split(text: str, limit: int) -> list:
    """Last-resort fixed-width slice. Always satisfies the bound."""
    return [text[i : i + limit] for i in range(0, len(text), limit)] or [""]


def _json_dump(value) -> str:
    # Must match _prepare_json_transcript in lib/content.py exactly, or a part
    # would measure differently here than it serialises there.
    return json.dumps(value, indent=None, ensure_ascii=False)


def _split_json(content: str, limit: int) -> Optional[list]:
    """Split a JSON-array transcript on message boundaries.

    Returns ``None`` (not a partial result) when ``content`` is not the JSON
    transcript shape, so the caller falls through to the text splitter.
    """
    stripped = content.lstrip()
    if not stripped.startswith("["):
        return None
    try:
        messages = json.loads(content)
    except (ValueError, TypeError):
        return None
    if not isinstance(messages, list) or not messages:
        return None

    # Expand any single message that cannot fit on its own, so the grouping
    # pass below only ever sees messages that individually fit.
    expanded: list = []
    for message in messages:
        serialised = _json_dump([message])
        if len(serialised) <= limit:
            expanded.append(message)
        else:
            expanded.extend(_split_json_message(message, limit))

    parts: list = []
    group: list = []
    for message in expanded:
        candidate = group + [message]
        if group and len(_json_dump(candidate)) > limit:
            parts.append(_json_dump(group))
            group = [message]
        else:
            group = candidate
    if group:
        parts.append(_json_dump(group))
    return parts


def _split_json_message(message, limit: int) -> list:
    """Split ONE oversized JSON message into several same-role messages.

    Preserves the role envelope on every fragment: the model still sees who
    said what, which is the context that a naive byte cut strands.
    """
    if not isinstance(message, dict):
        return [message]
    role = message.get("role", "unknown")
    blocks = message.get("content")
    if not isinstance(blocks, list) or not blocks:
        return [message]

    # Envelope cost of a one-message array with no blocks — the budget that
    # blocks have to fit inside.
    envelope = len(_json_dump([{"role": role, "content": []}]))
    budget = limit - envelope
    if budget <= 0:
        return [message]

    # Expand oversized individual blocks first (a single giant tool_result).
    atoms: list = []
    for block in blocks:
        if len(_json_dump(block)) <= budget:
            atoms.append(block)
        else:
            atoms.extend(_split_json_block(block, budget))

    out: list = []
    group: list = []
    for atom in atoms:
        candidate = group + [atom]
        if group and len(_json_dump(candidate)) > budget:
            out.append({"role": role, "content": group})
            group = [atom]
        else:
            group = candidate
    if group:
        out.append({"role": role, "content": group})
    return out or [message]


def _split_json_block(block, budget: int) -> list:
    """Split one oversized content block by slicing its longest text field."""
    if not isinstance(block, dict):
        return [block]
    field = None
    for candidate in ("text", "content", "input", "output"):
        if isinstance(block.get(candidate), str) and block[candidate]:
            field = candidate
            break
    if field is None:
        return [block]

    # Room the text has once the rest of the block is serialised.
    skeleton = dict(block)
    skeleton[field] = ""
    room = budget - len(_json_dump(skeleton))
    if room <= 0:
        return [block]

    out = []
    for fragment in _split_text_by_lines(block[field], room):
        clone = dict(block)
        clone[field] = fragment
        out.append(clone)
    return out or [block]


def _split_text(content: str, limit: int) -> list:
    """Split a ``[role: x]…[x:end]`` transcript on block boundaries."""
    blocks = content.split(_TEXT_BLOCK_SEP)

    expanded: list = []
    for block in blocks:
        if len(block) <= limit:
            expanded.append(block)
        else:
            expanded.extend(_split_text_block(block, limit))

    parts: list = []
    group: list = []
    group_len = 0
    sep_len = len(_TEXT_BLOCK_SEP)
    for block in expanded:
        added = len(block) + (sep_len if group else 0)
        if group and group_len + added > limit:
            parts.append(_TEXT_BLOCK_SEP.join(group))
            group, group_len = [block], len(block)
        else:
            group.append(block)
            group_len += added
    if group:
        parts.append(_TEXT_BLOCK_SEP.join(group))
    return parts


def _split_text_block(block: str, limit: int) -> list:
    """Split one oversized ``[role: x]…[x:end]`` block, re-wrapping each part.

    Falls back to a plain line split when the block is not in the marker form
    (e.g. a legacy flat transcript), which the caller's normalisation pass
    then hard-slices if any fragment is still over the bound.
    """
    lines = block.split("\n")
    if len(lines) < 3 or not lines[0].startswith("[role: ") or not lines[-1].endswith(":end]"):
        return _split_text_by_lines(block, limit)

    header, footer = lines[0], lines[-1]
    body = "\n".join(lines[1:-1])
    # +2 for the two newlines that rejoin header/body/footer.
    room = limit - len(header) - len(footer) - 2
    if room <= 0:
        return _split_text_by_lines(block, limit)
    return [f"{header}\n{fragment}\n{footer}" for fragment in _split_text_by_lines(body, room)]


def _split_text_by_lines(text: str, limit: int) -> list:
    """Group whole lines into fragments of at most ``limit`` chars.

    A single line longer than ``limit`` is hard-sliced — the only place this
    module cuts inside a line, and unavoidable: an unbroken 100k-char line has
    no structural boundary to cut on.
    """
    if limit <= 0:
        return [text]
    if len(text) <= limit:
        return [text]

    out: list = []
    buf: list = []
    buf_len = 0
    for line in text.split("\n"):
        if len(line) > limit:
            if buf:
                out.append("\n".join(buf))
                buf, buf_len = [], 0
            out.extend(_hard_split(line, limit))
            continue
        added = len(line) + (1 if buf else 0)
        if buf and buf_len + added > limit:
            out.append("\n".join(buf))
            buf, buf_len = [line], len(line)
        else:
            buf.append(line)
            buf_len += added
    if buf:
        out.append("\n".join(buf))
    return out or [text]
