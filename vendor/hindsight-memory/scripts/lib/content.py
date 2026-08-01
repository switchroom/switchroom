"""Content processing utilities.

Faithful port of Openclaw plugin's content processing: memory tag stripping,
query composition/truncation, transcript formatting, and memory formatting.

Source: reference/openclaw-source/index.js — stripMemoryTags, composeRecallQuery,
truncateRecallQuery, sliceLastTurnsByUserBoundary, prepareRetentionTranscript,
formatMemories.
"""

import os
import re
from datetime import datetime

try:  # Python 3.9+; present in every switchroom agent image.
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - defensive only
    ZoneInfo = None  # type: ignore[assignment,misc]

# ---------------------------------------------------------------------------
# Memory tag stripping (anti-feedback-loop)
# ---------------------------------------------------------------------------


def strip_channel_envelope(content: str) -> str:
    """Strip Claude Code channel XML wrappers from user messages.

    Claude Code wraps incoming channel messages in XML:
      <channel source="plugin:telegram:telegram" chat_id="..." ...>
      actual message text
      </channel>

    This is the Claude Code equivalent of Openclaw's stripMetadataEnvelopes().
    Extracts the inner text, preserving the actual user message while removing
    transport metadata that Hindsight doesn't need.

    A single prompt may carry MORE THAN ONE envelope (e.g. a coalesced
    burst where several inbound messages were concatenated). Since this now
    sits on the live recall-query path (hindsight-leverage PR 1, review
    finding 6), coalesce EVERY envelope's inner text rather than keeping only
    the first and silently dropping everything after the first ``</channel>``.
    """
    # Match every <channel ...>content</channel> — extract & join inner texts.
    matches = re.findall(r"<channel\b[^>]*>([\s\S]*?)</channel>", content)
    if matches:
        return "\n".join(m.strip() for m in matches if m.strip()).strip()
    return content


def strip_memory_tags(content: str) -> str:
    """Remove <hindsight_memories> and <relevant_memories> blocks.

    Prevents retain feedback loop — these were injected during recall and
    should not be re-stored.

    Port of: stripMemoryTags() in index.js
    """
    content = re.sub(r"<hindsight_memories>[\s\S]*?</hindsight_memories>", "", content)
    content = re.sub(r"<relevant_memories>[\s\S]*?</relevant_memories>", "", content)
    return content


# ---------------------------------------------------------------------------
# Recall: query composition and truncation
# ---------------------------------------------------------------------------


def compose_recall_query(
    latest_query: str,
    messages: list,
    recall_context_turns: int,
    recall_roles: list = None,
) -> str:
    """Compose a multi-turn recall query from conversation history.

    Port of: composeRecallQuery() in index.js

    When recallContextTurns > 1, includes prior context from the transcript
    above the latest user query. Format:

        Prior context:

        user: ...
        assistant: ...

        <latest query>
    """
    # Switchroom A1 (hindsight-leverage PR 1) — strip the <channel> envelope
    # from the latest query INSIDE the helper as well, so any caller (present
    # or future) gets an envelope-free composed query. The recall.py caller
    # already strips before calling, but keeping the strip here is defence in
    # depth: it guarantees the trailing latest-query segment appended below
    # (and returned on the turns<=1 short-circuit) never carries the raw
    # chat_id/ts/user XML noise into the embedding or the char cap.
    latest = strip_channel_envelope(latest_query).strip()
    if recall_context_turns <= 1 or not isinstance(messages, list) or not messages:
        return latest

    allowed_roles = set(recall_roles or ["user", "assistant"])
    contextual_messages = slice_last_turns_by_user_boundary(messages, recall_context_turns)

    context_lines = []
    for msg in contextual_messages:
        role = msg.get("role")
        if role not in allowed_roles:
            continue

        content = _extract_text_content(msg.get("content", ""), role=role)
        content = strip_channel_envelope(content)
        content = strip_memory_tags(content).strip()
        if not content:
            continue

        # Skip if this is the same as the latest query (avoid duplication)
        if role == "user" and content == latest:
            continue

        # Switchroom recall-latency fix (#3757): NO ``{role}: `` prefix.
        # These labels were formatting scaffolding, never search terms, and
        # they were the single most expensive thing this hook put on the wire.
        # Hindsight's BM25 arm OR-joins every query token, so ``user`` and
        # ``assistant`` widened the match set by the two highest-document-
        # frequency terms in a mature bank (measured on bank ``overlord``,
        # 135,443 rows: ``user`` = 67,363 rows = 50% of the bank,
        # ``assistant`` = 29,942 = 22%). Dropping just these two labels cut a
        # production-shaped 3-arm BM25 UNION from 119,510 ranked rows / 14.0s
        # to 86,653 / 11.8s. Turn separation is preserved by the newline join,
        # which is all the embedding arm needs.
        context_lines.append(content)

    if not context_lines:
        return latest

    return "\n\n".join(
        [
            "Prior context:",
            "\n".join(context_lines),
            latest,
        ]
    )


def truncate_recall_query(query: str, latest_query: str, max_chars: int) -> str:
    """Truncate a composed recall query to max_chars.

    Port of: truncateRecallQuery() in index.js

    Preserves the latest user message. When the query contains "Prior context:",
    drops oldest context lines first (from the top) to fit within the limit.
    """
    if max_chars <= 0:
        return query

    latest = latest_query.strip()
    if len(query) <= max_chars:
        return query

    # If even the latest alone is too long, hard-truncate it
    latest_only = latest[:max_chars] if len(latest) > max_chars else latest

    if "Prior context:" not in query:
        return latest_only

    context_marker = "Prior context:\n\n"
    marker_index = query.find(context_marker)
    if marker_index == -1:
        return latest_only

    suffix_marker = "\n\n" + latest
    suffix_index = query.rfind(suffix_marker)
    if suffix_index == -1:
        return latest_only

    suffix = query[suffix_index:]  # \n\n<latest>
    if len(suffix) >= max_chars:
        return latest_only

    context_body = query[marker_index + len(context_marker) : suffix_index]
    context_lines = [line for line in context_body.split("\n") if line]

    # Add context lines from newest (bottom) to oldest (top), stop when exceeding
    kept = []
    for i in range(len(context_lines) - 1, -1, -1):
        kept.insert(0, context_lines[i])
        candidate = f"{context_marker}{chr(10).join(kept)}{suffix}"
        if len(candidate) > max_chars:
            kept.pop(0)
            break

    if kept:
        return f"{context_marker}{chr(10).join(kept)}{suffix}"
    return latest_only


# ---------------------------------------------------------------------------
# Recall: search-query shaping (BM25 token budget)
# ---------------------------------------------------------------------------
#
# Switchroom recall-latency fix (#3757). Hindsight's keyword arm OR-joins
# EVERY token of the query into one `to_tsquery` disjunction, and Postgres
# native FTS cannot top-k from the GIN index — it computes `ts_rank_cd` on
# every matching row before the top-60 heapsort. So BM25 cost grows with the
# size of the matched set, which grows with query length. Measured on the live
# `overlord` bank (135,565 memory_units, 3 fact-type arms, LIMIT 60 each,
# production-shaped composed query):
#
#     as shipped (96 distinct terms)     119,510 rows ranked    14.0 s
#     role labels + header stripped      86,653 rows ranked     11.8 s
#     + capped to 24 BM25 terms          48,433 rows ranked      2.7 s
#
# The 8s client timeout then fired on 96.8% of overlord's own-bank recalls
# over the 7 days to 2026-07-27, so the agent got zero memories.
#
# We therefore shape the query into a bounded set of the most selective terms
# before it goes on the wire. Only the SERVER-BOUND query is shaped; the
# client-side lexical surfaces (the `recallMinOverlap` containment gate and the
# transcript-grep fallback) keep the unshaped text, so this change cannot move
# their thresholds.

# Common English function words.
#
# MEASURED CAVEAT, so nobody over-credits this list: on the CURRENT backend
# (Postgres native tsvector with the `english` configuration) these are already
# stopped by Postgres itself — `to_tsquery('english', 'the | user | worktree')`
# returns `'user' | 'worktre'`. Removing them client-side moved the matched set
# by only 86,653 → ~86,300 rows on the `overlord` bank. Their real job here is
# BUDGET: every function word we send would otherwise consume one of the
# `max_tokens` slots that a content word needs. They also matter directly on
# the non-native backends Hindsight supports (vchord / pgroonga / pg_search /
# pg_textsearch), none of which strip English stopwords for us.
#
# Deliberately conservative: only closed-class words (determiners, pronouns,
# prepositions, auxiliaries, conjunctions), never content words.
BM25_STOPWORDS = frozenset(
    """
    a about above after again against all am an and any are aren as at
    be because been before being below between both but by
    can cannot could couldn
    did didn do does doesn doing don down during
    each few for from further
    had hadn has hasn have haven having he her here hers herself him himself his
    how
    i if in into is isn it its itself
    just
    ll
    me more most mustn my myself
    no nor not now
    of off on once only or other ought our ours ourselves out over own
    re
    s same shan she should shouldn so some such
    t than that the their theirs them themselves then there these they this
    those through to too
    under until up
    ve very
    was wasn we were weren what when where which while who whom why will with
    won would wouldn
    you your yours yourself yourselves
    """.split()
)

# Role labels this hook used to prefix onto context turns, plus the composed
# query's own section header. Structural scaffolding, never search terms.
_ROLE_LABEL_RE = re.compile(r"(?mi)^\s*(?:user|assistant|system|tool)\s*:[ \t]*")
_CONTEXT_HEADER_RE = re.compile(r"(?mi)^\s*prior context\s*:[ \t]*$")

# Mirrors the server's own BM25 tokenizer
# (hindsight_api/engine/search/retrieval.py::tokenize_query): lowercase, strip
# punctuation, split on whitespace, then APPEND intact "compound" tokens —
# word-char runs joined by . / - (semvers, paths, hyphenated identifiers) —
# because the server emits those alongside their fragments. Keeping the two in
# sync is what makes the cap mean "N terms in the tsquery", not "N words we
# happened to send".
_COMPOUND_TOKEN_RE = re.compile(r"\w+(?:[./-]\w+)+")


def tokenize_for_bm25(text: str) -> list:
    """Tokenize ``text`` the way Hindsight's BM25 arm will.

    Port of ``tokenize_query`` in the Hindsight engine. Returns the token list
    (with duplicates, in order); the tsquery ORs the distinct values.
    """
    lowered = text.lower()
    tokens = re.sub(r"[^\w\s]", " ", lowered).split()
    if not tokens:
        return []
    for match in _COMPOUND_TOKEN_RE.finditer(lowered):
        compound = match.group(0)
        if compound not in tokens:
            tokens.append(compound)
    return tokens


def strip_query_scaffolding(text: str) -> str:
    """Remove role labels and the "Prior context:" header from a query.

    Defence in depth for #3757: ``compose_recall_query`` no longer emits the
    ``user:`` / ``assistant:`` prefixes, but a transcript turn can legitimately
    *contain* such a line, and older composed strings may still reach here.
    """
    text = _CONTEXT_HEADER_RE.sub("", text)
    return _ROLE_LABEL_RE.sub("", text)


_ENGLISH_WORDS_FILE = os.path.join(os.path.dirname(__file__), "english_words.txt")
_ENGLISH_WORDS_CACHE = None


def common_english_words() -> frozenset:
    """Lazily load the common-English demotion list (see english_words.txt).

    Read once per process and cached. A missing or unreadable file degrades to
    an empty set — shaping still works, it just loses the demotion signal — so
    a packaging slip can never break recall on the critical path.
    """
    global _ENGLISH_WORDS_CACHE
    if _ENGLISH_WORDS_CACHE is None:
        words = set()
        try:
            with open(_ENGLISH_WORDS_FILE, encoding="utf-8") as handle:
                for line in handle:
                    word = line.strip()
                    if word and not word.startswith("#"):
                        words.add(word)
        except OSError:
            words = set()
        _ENGLISH_WORDS_CACHE = frozenset(words)
    return _ENGLISH_WORDS_CACHE


# How much each signal is worth. Digit and compound are equal because both are
# measured to predict the same thing (an identifier); the English demotion is
# deliberately smaller than either, so a digit-bearing English word still wins.
_SCORE_DIGIT = 3.0
_SCORE_COMPOUND = 3.0
_SCORE_NOT_COMMON_ENGLISH = 2.0
# Recency is a WEIGHT, not a tier (#3760 review, Blocker 2). Sized below the
# shape signals on purpose: a distinctive prior-context identifier (`nginx`,
# score 2.0) must outrank a generic latest-turn English word (score 0.0 + 1.5),
# but between two terms of equal merit the one the user just typed wins.
_SCORE_RECENCY = 1.5


def _selectivity_score(token: str) -> float:
    """Deterministic proxy for how discriminating ``token`` is.

    True per-token document frequency is not available client-side: Hindsight
    exposes no term-stats endpoint, and one ``count(*)`` probe per token would
    cost more than the query it is trying to speed up. Every signal below was
    checked against real df, measured with ``ts_stat`` over the live `overlord`
    bank (135,565 units) and five other topically-unrelated banks:

      * carries a digit (+3.0) — versions, issue numbers, ids, dates. The one
        shape that reliably predicts a low df: median df 0.000, and only 6.8%
        of digit-bearing tokens exceed 1% of the bank, against 33-50% for every
        other shape class.
      * is a compound token (+3.0) — ``v0.19.17``, ``src/agents/scaffold.ts``.
      * is NOT a common English word (+2.0) — see ``english_words.txt``. df
        cannot separate contentless English from domain identifiers (both are
        rare: `particularly` 0.022%, `situation` 0.018%, vs `npm` 1.38%,
        `worktree` 1.85%), but English-word membership can, and it is exactly
        the separation the budget needs.

    LENGTH IS DELIBERATELY ABSENT. The previous revision added
    ``min(len(token), 12) / 4.0``. Measured median `overlord` df by token
    length is flat-to-RISING — len2 0.0022, len3 0.0032, len4 0.0042,
    len5 0.0070, len6 0.0103, len7 0.0102, len9 0.0068, len11 0.0055,
    len13 0.0093 — so length predicts nothing in either direction. Inverting
    it would have been as unjustified as the original; it is dropped instead.
    Case was checked too and also rejected: `Capitalised` tokens have the
    HIGHEST rate of df > 1% (50.6%), and ALLCAPS the highest mean df (0.034).

    Known limit: bank-specific high-df content words (`agent` and `switchroom`
    each match ~20% of the `overlord` bank) still score normally. They are not
    a cost problem — ``max_tokens`` bounds tsquery cost regardless of which
    terms are chosen — only a slot-allocation one, and they remain the job of
    the operator-set ``recallQueryStopTerms``.
    """
    score = 0.0
    if any(ch.isdigit() for ch in token):
        score += _SCORE_DIGIT
    if _COMPOUND_TOKEN_RE.fullmatch(token):
        score += _SCORE_COMPOUND
    if token not in common_english_words():
        score += _SCORE_NOT_COMMON_ENGLISH
    return score


def shape_recall_query(
    query: str,
    latest_query: str = "",
    max_tokens: int = 24,
    stop_terms=None,
) -> str:
    """Bound the BM25 cost of ``query`` by capping its distinct tsquery terms.

    Returns a space-joined term string in the query's original word order (so
    the embedding arm still sees the text's natural sequence, just with the
    scaffolding and function words removed).

    Selection is RESERVE-then-FILL, in three parts:

      1. ``max_tokens // 3`` slots go to the highest-:func:`_selectivity_score`
         terms in the whole window, recency deliberately excluded from that
         score. The most discriminating terms present survive regardless of
         which turn they came from.
      2. ``max_tokens // 3`` slots go to the best terms of the latest turn, so
         a prior turn dense in high-merit tokens (a pasted stack trace, a list
         of ids) cannot cost the user the question they just asked.
      3. Everything left is filled by ``_selectivity_score`` plus
         ``_SCORE_RECENCY`` for terms appearing in ``latest_query``, ties broken
         by first appearance.

    Both reserves are CEILINGS, not allocations: a side with fewer terms simply
    leaves its unused slots to the fill, and a window under ``max_tokens`` terms
    is unaffected entirely.

    Recency is therefore a WEIGHT, not an absolute tier (#3760 review, Blocker
    2). It has to be preferred at all, because the composed query is
    ``Prior context: <older turns> … <latest>`` and a naive truncation keeps
    whichever turn comes FIRST — i.e. throws away the actual question and keeps
    the stalest context. But making it absolute silently defeated
    ``recallContextTurns``: any latest turn with ``>= max_tokens`` surviving
    terms took EVERY slot, so a conversational follow-up whose subject lives
    only in the prior turn ("is the thing we were discussing still broken?")
    produced a query with no subject in it at all. Step 1 is the structural
    guarantee against that; step 3 is where recency actually decides anything,
    and in ordinary conversational text — where nearly every candidate scores
    0.0 on shape — that is most of the budget.

    A kept compound token costs its own slot PLUS a slot for each fragment the
    server will shred it into, so the emitted string never expands past
    ``max_tokens`` distinct tsquery terms.

    ``max_tokens <= 0`` disables shaping and returns ``query`` unchanged (the
    operator rollback lever, ``memory.recall.query_max_tokens: 0``).
    """
    # Defensive coercion: `max_tokens` reaches here from settings.json /
    # env, so a string or None is a config error, not a crash on the recall
    # critical path. Anything uninterpretable falls back to "do not shape".
    try:
        max_tokens = int(max_tokens)
    except (TypeError, ValueError):
        return query
    if max_tokens <= 0:
        return query

    cleaned = strip_query_scaffolding(query)
    tokens = tokenize_for_bm25(cleaned)
    if not tokens:
        # Nothing tokenizable (e.g. a pure-punctuation prompt) — send the
        # original so we never turn a real query into an empty one.
        return query

    stop = set(BM25_STOPWORDS)
    # A bare string here (`"switchroom,agent"` mis-set in settings.json) would
    # otherwise iterate CHARACTERS and stop-list half the alphabet.
    if isinstance(stop_terms, str):
        stop_terms = [t for t in re.split(r"[,\s]+", stop_terms) if t]
    for term in stop_terms or ():
        if isinstance(term, str) and term.strip():
            stop.add(term.strip().lower())

    latest_tokens = set(tokenize_for_bm25(strip_query_scaffolding(latest_query or "")))

    first_seen = {}
    for index, token in enumerate(tokens):
        first_seen.setdefault(token, index)

    # Stopword removal is the PRIMARY filter; the length guard lives only in the
    # fallback below (#3766). Filtering ``len(t) > 1`` here would silently drop a
    # single-char SUBJECT — a language name ('C', 'R'), a single-digit version
    # ('v3' tokenizes fine, but a bare '9' in "python 9077" or "Angular 9" does
    # not) — before the fallback ever runs, leaving the query with only its
    # multi-char stopwords. Single-char stopwords ('a', 'i', 's', 't') are still
    # removed because they are in ``stop``; a single-char content word survives.
    candidates = [t for t in first_seen if t not in stop]
    if not candidates:
        # Every term was a stopword. Fall back to the unfiltered token set so a
        # short conversational prompt ("what did you say about it?") still
        # searches for something. The ``len(t) > 1`` guard applies HERE — with
        # every term a stopword there is no subject to protect, so dropping the
        # remaining single-char noise is safe.
        candidates = [t for t in first_seen if len(t) > 1] or list(first_seen)

    def weight(token):
        score = _selectivity_score(token)
        if token in latest_tokens:
            score += _SCORE_RECENCY
        return score

    # MERIT RESERVE, then RECENCY FILL.
    #
    # `max_tokens // 3` slots are reserved for the highest-merit terms in the
    # WHOLE window, scored with recency deliberately excluded, so the most
    # discriminating terms present cannot be displaced by sheer latest-turn
    # volume no matter which turn they came from. That is the Blocker 2
    # guarantee, and it is structural: a conversational follow-up whose subject
    # lives only in the prior turn ("is the thing we were discussing still
    # broken?") keeps its subject.
    #
    # The remaining two thirds are filled by the recency-WEIGHTED score, which
    # is where `_SCORE_RECENCY` earns its keep: between terms of equal merit —
    # and after stopword removal most conversational terms are equal on merit —
    # the one the user just typed wins, instead of the composed string's leading
    # (i.e. STALEST) turn winning on `first_seen` alone.
    #
    # The reserve is a ceiling, not an allocation: any term it reserves that the
    # recency fill would have chosen anyway costs nothing, and a window with
    # fewer than `max_tokens` terms is unaffected entirely.
    reserve_size = max(1, max_tokens // 3)
    merit_ordered = sorted(candidates, key=lambda t: (-_selectivity_score(t), first_seen[t]))
    reserved = merit_ordered[:reserve_size]
    reserved_set = set(reserved)

    # ...and a mirror-image LATEST-TURN reserve of the same size, because a
    # merit reserve alone is one-sided. A prior turn dense in high-merit tokens
    # (a pasted stack trace, a list of ids) outscores an ordinary question on
    # every slot, which would cost the user the thing they actually just asked.
    # Same shape as above: a ceiling of `max_tokens // 3`, never an allocation.
    latest_reserve = sorted(
        (t for t in candidates if t in latest_tokens and t not in reserved_set),
        key=lambda t: (-weight(t), first_seen[t]),
    )[:reserve_size]
    reserved_set.update(latest_reserve)

    filled = sorted(
        (t for t in candidates if t not in reserved_set),
        key=lambda t: (-weight(t), first_seen[t]),
    )
    candidates = reserved + latest_reserve + filled

    kept = []
    emitted = set()
    for token in candidates:
        # A compound token is emitted by the server ALONGSIDE its fragments;
        # charge the budget for both so `max_tokens` is a true tsquery bound.
        expansion = {token}
        if _COMPOUND_TOKEN_RE.fullmatch(token):
            expansion |= set(re.sub(r"[^\w\s]", " ", token).split())
        new_terms = expansion - emitted
        if len(emitted) + len(new_terms) > max_tokens:
            continue
        emitted |= new_terms
        kept.append(token)

    if not kept:
        return query

    kept.sort(key=lambda t: first_seen[t])
    # Emit the ORIGINAL surface form of each survivor, not the lowercased
    # token. BM25 lowercases and stems on the server either way, but the SAME
    # string also feeds the embedding arm, and `Python` / `Coolify` / `PR`
    # carry case a sentence-transformer legitimately uses.
    surfaces = _surface_forms(cleaned)
    return " ".join(surfaces.get(t, t) for t in kept)


def _surface_forms(text: str) -> dict:
    """Map each BM25 token to its first original-case spelling in ``text``."""
    forms = {}
    for word in re.sub(r"[^\w\s]", " ", text).split():
        forms.setdefault(word.lower(), word)
    for match in _COMPOUND_TOKEN_RE.finditer(text):
        forms.setdefault(match.group(0).lower(), match.group(0))
    return forms


# ---------------------------------------------------------------------------
# Turn slicing
# ---------------------------------------------------------------------------


def _is_tool_result_only_user_message(message: dict) -> bool:
    """True when a ``role="user"`` message carries ONLY tool_result blocks.

    SWITCHROOM DIVERGENCE (candidate to upstream to vectorize-io/hindsight):
    Claude Code emits tool results as ``role="user"`` messages whose content
    is a list of ``{"type": "tool_result", ...}`` blocks — they are NOT
    human turns. A genuine human turn has text (a string, or a content list
    with at least one non-tool_result block, e.g. ``{"type": "text"}`` or an
    image). Treating tool_result messages as turn boundaries lets a tool-heavy
    turn (≥N sequential tool rounds) fill a fixed-size retain window with
    tool_result messages and push the actual human message OUTSIDE the window
    — silently dropping the fact from that fire, and from every later fire
    (whose window starts even further from the human message). On restart the
    fact is gone. This helper lets the boundary counter skip those messages so
    "window = N turns" means N *human* turns regardless of tool volume.
    """
    if message.get("role") != "user":
        return False
    content = message.get("content")
    if isinstance(content, list):
        blocks = [b for b in content if isinstance(b, dict)]
        # A non-empty content list that is ENTIRELY tool_result blocks.
        if blocks and all(b.get("type") == "tool_result" for b in blocks):
            return True
    return False


def slice_last_turns_by_user_boundary(messages: list, turns: int) -> list:
    """Slice messages to the last N turns, where a turn starts at a user message.

    Port of: sliceLastTurnsByUserBoundary() in index.js

    Walks backward counting GENUINE HUMAN user messages as turn boundaries.
    Returns messages from the Nth human boundary to the end.

    SWITCHROOM DIVERGENCE (candidate to upstream): tool_result messages carry
    ``role="user"`` in the Claude Code transcript but are not human turns; they
    are skipped as boundaries (see ``_is_tool_result_only_user_message``). This
    keeps the fixed-size retain window anchored to human turns so a tool-heavy
    turn can never push the human's fact outside the window (silent memory loss).
    Affects both the retain window-slice and the recall context slice — both
    want "N human turns", not "N transcript user-messages".
    """
    if not isinstance(messages, list) or not messages or turns <= 0:
        return []

    user_turns_seen = 0
    start_index = -1

    for i in range(len(messages) - 1, -1, -1):
        msg = messages[i]
        if msg.get("role") == "user" and not _is_tool_result_only_user_message(msg):
            user_turns_seen += 1
            if user_turns_seen >= turns:
                start_index = i
                break

    if start_index == -1:
        return list(messages)

    return messages[start_index:]


# ---------------------------------------------------------------------------
# Sidechain (sub-agent transcript) detection
# ---------------------------------------------------------------------------


def transcript_first_line_is_sidechain(path: str) -> bool:
    """True when the first JSON line of ``path`` carries ``isSidechain: true``.

    Switchroom hindsight-leverage PR5. Claude Code writes sub-agent (Task-tool)
    transcripts as separate ``.jsonl`` files under
    ``<project>/<session>/subagents/agent-<agent_id>.jsonl`` whose every line
    carries ``isSidechain: true``. This shared predicate lets BOTH the
    SubagentStop retain (which resolves + retains these deliberately, tagged
    ``sidechain`` + volume-gated) AND the boot reconciler / any transcript
    sweeper (which must NOT treat a sidechain as a pseudo-session and re-retain
    it untagged, at full recall weight, bypassing the volume gate) recognise a
    sidechain file from its first line alone — a cheap single-line read. Any
    read/parse error is treated as "not a sidechain" (fail-open: a
    genuinely-unreadable file is skipped elsewhere by its empty transcript).
    """
    import json

    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    return json.loads(line).get("isSidechain") is True
                except json.JSONDecodeError:
                    return False
    except OSError:
        return False
    return False


# ---------------------------------------------------------------------------
# Memory formatting (recall results → context string)
# ---------------------------------------------------------------------------


def format_memories(results: list) -> str:
    """Format recall results into human-readable text.

    Port of: formatMemories() in index.js
    Format: - <text> [<type>] (<mentioned_at>)
    """
    if not results:
        return ""
    lines = []
    for r in results:
        text = r.get("text", "")
        mem_type = r.get("type", "")
        mentioned_at = r.get("mentioned_at", "")
        type_str = f" [{mem_type}]" if mem_type else ""
        # switchroom #tz-fix (recall side): mentioned_at arrives as a UTC ISO
        # timestamp from the Hindsight server. Render it through the same
        # SWITCHROOM_TIMEZONE→TZ→UTC zoneinfo conversion as format_current_time
        # so recall lines never inject a UTC "when". Date-only / unparseable
        # values are surfaced verbatim rather than crashing recall.
        display_at = _format_local_timestamp(mentioned_at) if mentioned_at else ""
        date_str = f" ({display_at})" if display_at else ""
        lines.append(f"- {text}{type_str}{date_str}")
    return "\n\n".join(lines)


def _resolve_agent_timezone() -> str:
    """Resolve the agent's configured IANA timezone.

    Mirrors the switchroom cascade used by ``bin/timezone-hook.sh`` and
    ``src/config/timezone.ts``: ``SWITCHROOM_TIMEZONE`` → ``TZ`` → ``UTC``.
    This recall hook runs as a plugin subprocess INSIDE the agent container,
    so it inherits both env vars (compose.ts bakes them onto the container).
    """
    return os.environ.get("SWITCHROOM_TIMEZONE") or os.environ.get("TZ") or "UTC"


def _format_local_timestamp(value: str) -> str:
    """Render a UTC ISO timestamp in the agent's LOCAL timezone (am/pm form).

    Used by ``format_memories`` to convert the server-supplied ``mentioned_at``
    (UTC ISO, e.g. ``2026-07-16T04:09:00Z``) through the same
    SWITCHROOM_TIMEZONE→TZ→UTC zoneinfo cascade as ``format_current_time``,
    so recalled memories never surface a UTC "when".

    Guarding: only full ISO *datetime* values (those carrying a time component,
    i.e. containing ``T``) are converted. Date-only strings (``2024-01-01``) and
    anything unparseable are returned verbatim rather than crashing recall or
    fabricating a midnight time.
    """
    if not isinstance(value, str):
        return value
    raw = value.strip()
    # Only convert full ISO datetimes — a bare date has no wall-clock to shift.
    if "T" not in raw:
        return value
    parsed = None
    try:
        # Python <3.11 fromisoformat rejects a trailing 'Z'; normalise it.
        iso = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
        parsed = datetime.fromisoformat(iso)
    except (ValueError, TypeError):
        return value
    # Naive value → server sends UTC, so assume UTC before converting.
    if parsed.tzinfo is None:
        if ZoneInfo is not None:
            try:
                parsed = parsed.replace(tzinfo=ZoneInfo("UTC"))
            except Exception:
                return value
        else:
            return value
    tz_name = _resolve_agent_timezone()
    if ZoneInfo is not None:
        try:
            local = parsed.astimezone(ZoneInfo(tz_name))
        except Exception:  # unknown/invalid zone — degrade to process-local.
            local = parsed.astimezone()
    else:
        local = parsed.astimezone()
    return local.strftime("%Y-%m-%d %I:%M %p %Z")


def format_current_time() -> str:
    """Format the current time in the agent's LOCAL timezone for recall context.

    Switchroom #tz-fix: previously this emitted ``"%Y-%m-%d %H:%M UTC"``, the
    STRONGEST of several competing UTC "current time" strings the model saw
    each turn — it fought the single correct local-time hint and made agents
    intermittently report UTC / wrong-offset times. We now render the agent's
    LOCAL wall clock in am/pm form (e.g. ``2026-07-16 04:09 PM AEST``) so the
    recall block never injects a UTC "now". Deterministic — the timezone comes
    from the container env, not model discipline.

    Port of: formatCurrentTimeForRecall() in index.js
    """
    tz_name = _resolve_agent_timezone()
    now = None
    if ZoneInfo is not None:
        try:
            now = datetime.now(ZoneInfo(tz_name))
        except Exception:  # unknown/invalid zone — degrade, don't crash recall.
            now = None
    if now is None:
        # No zoneinfo or bad zone: fall back to the process-local clock, which
        # already honours the container's TZ env via libc. am/pm form, no "UTC".
        now = datetime.now().astimezone()
    # "%Y-%m-%d %I:%M %p %Z" → e.g. "2026-07-16 04:09 PM AEST" (mirrors the
    # %I:%M %p %Z tail of bin/timezone-hook.sh's format).
    return now.strftime("%Y-%m-%d %I:%M %p %Z")


# ---------------------------------------------------------------------------
# Retention transcript formatting
# ---------------------------------------------------------------------------


def _extract_message_blocks(content, role: str = "") -> list:
    """Extract structured content blocks from a message for JSON retention.

    Returns a list of dicts, each representing a content block:
      - {"type": "text", "text": "..."} for text blocks
      - {"type": "tool_use", "name": "...", "input": {...}} for tool calls
      - Channel message tool_use blocks get their text extracted inline.
    """
    if isinstance(content, str):
        cleaned = strip_channel_envelope(strip_memory_tags(content)).strip()
        return [{"type": "text", "text": cleaned}] if cleaned else []

    if not isinstance(content, list):
        return []

    blocks = []
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type", "")

        if block_type == "text":
            text = strip_channel_envelope(strip_memory_tags(block.get("text", ""))).strip()
            if text:
                blocks.append({"type": "text", "text": text})

        elif block_type == "tool_use" and role == "assistant":
            if _is_channel_message_tool(block):
                # Channel messages: extract the outgoing text
                tool_input = block.get("input", {})
                for field in _MESSAGE_TEXT_FIELDS:
                    val = tool_input.get(field)
                    if isinstance(val, str) and val.strip():
                        blocks.append({"type": "text", "text": val.strip()})
                        break
            else:
                name = block.get("name", "unknown")
                inp = block.get("input", {})
                # Skip Hindsight MCP tools to avoid feedback loops
                if name.startswith("mcp__") and _OPERATIONAL_TOOL_PATTERN.search(name.split("__")[-1]):
                    continue
                blocks.append({"type": "tool_use", "name": name, "input": inp})

        elif block_type == "tool_result":
            # Include tool results for context.
            # content can be a plain string or a list of content blocks
            # (e.g. [{"type": "text", "text": "..."}] for Agent results).
            result_content = block.get("content", "")
            if isinstance(result_content, list):
                # Extract text from content blocks
                parts = []
                for item in result_content:
                    if isinstance(item, dict) and item.get("type") == "text":
                        t = item.get("text", "").strip()
                        if t:
                            parts.append(t)
                result_content = "\n".join(parts)
            if isinstance(result_content, str) and result_content.strip():
                text = result_content.strip()
                # Truncate very long results
                if len(text) > 2000:
                    text = text[:2000] + "... (truncated)"
                blocks.append({"type": "tool_result", "tool_use_id": block.get("tool_use_id", ""), "content": text})

    return blocks


def prepare_retention_transcript(
    messages: list,
    retain_roles: list = None,
    retain_full_window: bool = False,
    include_tool_calls: bool = False,
) -> tuple:
    """Format messages into a retention transcript.

    When include_tool_calls is True, outputs JSON with full message structure
    including tool calls and their inputs. Otherwise outputs the legacy
    text format with [role: ...]...[role:end] markers.

    Args:
        messages: List of message dicts with 'role' and 'content'.
        retain_roles: Roles to include (default: ['user', 'assistant']).
        retain_full_window: If True, retain all messages (chunked mode).
            If False, retain only the last turn (last user msg + responses).
        include_tool_calls: If True, output JSON format with full tool call data.

    Returns:
        (transcript_text, message_count) or (None, 0) if nothing to retain.
    """
    if not messages:
        return None, 0

    if retain_full_window:
        target_messages = messages
    else:
        # Default: retain only the last turn
        last_user_idx = -1
        for i in range(len(messages) - 1, -1, -1):
            if messages[i].get("role") == "user":
                last_user_idx = i
                break
        if last_user_idx == -1:
            return None, 0
        target_messages = messages[last_user_idx:]

    allowed_roles = set(retain_roles or ["user", "assistant"])

    if include_tool_calls:
        return _prepare_json_transcript(target_messages, allowed_roles)
    return _prepare_text_transcript(target_messages, allowed_roles)


def _prepare_json_transcript(messages: list, allowed_roles: set) -> tuple:
    """Format messages as JSON with full tool call data."""
    import json

    structured_messages = []
    for msg in messages:
        role = msg.get("role", "unknown")
        if role not in allowed_roles:
            continue

        blocks = _extract_message_blocks(msg.get("content", ""), role=role)
        if not blocks:
            continue

        structured_messages.append({"role": role, "content": blocks})

    if not structured_messages:
        return None, 0

    transcript = json.dumps(structured_messages, indent=None, ensure_ascii=False)
    if len(transcript.strip()) < 10:
        return None, 0

    return transcript, len(structured_messages)


def _prepare_text_transcript(messages: list, allowed_roles: set) -> tuple:
    """Format messages as legacy text with [role:]...[role:end] markers."""
    parts = []

    for msg in messages:
        role = msg.get("role", "unknown")
        if role not in allowed_roles:
            continue

        content = _extract_text_content(msg.get("content", ""), role=role)
        content = strip_channel_envelope(content)
        content = strip_memory_tags(content).strip()

        if not content:
            continue

        parts.append(f"[role: {role}]\n{content}\n[{role}:end]")

    if not parts:
        return None, 0

    transcript = "\n\n".join(parts)
    if len(transcript.strip()) < 10:
        return None, 0

    return transcript, len(parts)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Fields in tool_use input that carry the outgoing message text.
# Ordered by likelihood — first match wins.
_MESSAGE_TEXT_FIELDS = ("text", "body", "message", "content")

# MCP tool name suffixes that are operational, not conversational.
# Checked against the last segment of the tool name (after the last __).
import re as _re

_OPERATIONAL_TOOL_PATTERN = _re.compile(
    r"(?:recall|retain|reflect|search|extract|create_|delete_|update_|get_|list_)",
    _re.IGNORECASE,
)


def _is_channel_message_tool(block: dict) -> bool:
    """Detect if a tool_use block is a channel message (reply/send).

    Uses a structural approach rather than name-matching for robustness:
      1. Must be an MCP tool (name starts with "mcp__")
      2. Must NOT match known operational patterns (recall, search, CRUD)
      3. Must have a text-like field in input (text, body, message, content)

    This catches any channel plugin (Telegram, Slack, Discord, Matrix,
    future channels) without hardcoding tool names. Built-in tools (Bash,
    Read, Write) don't start with mcp__. MCP tools for non-messaging
    purposes (hindsight recall, search) are excluded by pattern and by
    lacking text/body fields.
    """
    name = block.get("name", "")
    if not name.startswith("mcp__"):
        return False

    # Exclude operational MCP tools (check only the tool suffix, not server name)
    tool_suffix = name.split("__")[-1]
    if _OPERATIONAL_TOOL_PATTERN.search(tool_suffix):
        return False

    tool_input = block.get("input", {})
    if not isinstance(tool_input, dict):
        return False

    # Must have a text-carrying field with actual content
    return any(isinstance(tool_input.get(f), str) and tool_input[f].strip() for f in _MESSAGE_TEXT_FIELDS)


def _extract_text_content(content, role: str = "") -> str:
    """Extract text from message content (string or content blocks array).

    For user messages: extracts from plain strings (channel XML wrappers
    are stripped separately by strip_channel_envelope).

    For assistant messages: extracts from:
      - {type: "text"} blocks — terminal output/narration
      - {type: "tool_use"} blocks detected as channel messages — the agent's
        actual responses to the user. Detection is structural (MCP tool with
        text-like input field), not name-based, for channel-agnosticism.

    Excludes:
      - {type: "thinking"} — internal reasoning
      - {type: "tool_use"} for operational tools — Bash, Read, Write, recall, etc.
      - {type: "tool_result"} — operational results, not conversation
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts = []
        for block in content:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type", "")

            # Text blocks: terminal output / narration
            if block_type == "text":
                text = block.get("text", "").strip()
                if text:
                    texts.append(text)

            # Tool use blocks: extract channel messages
            elif block_type == "tool_use" and role == "assistant":
                if _is_channel_message_tool(block):
                    tool_input = block.get("input", {})
                    for field in _MESSAGE_TEXT_FIELDS:
                        val = tool_input.get(field)
                        if isinstance(val, str) and val.strip():
                            texts.append(val.strip())
                            break

        return "\n".join(texts)
    return ""
