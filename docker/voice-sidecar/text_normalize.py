"""Stage B — token normalisation for the TTS path (spoken-form rewriting).

WHY THIS EXISTS
---------------
Speech synthesis has two genuinely different jobs, and the fleet used to do
both of them in the gateway (TypeScript), in two passes that had drifted
apart:

  * Stage A — STRUCTURE. What of a chat message is even speakable: strip
    markdown scaffolding, drop code fences, decide where sentences end. That
    is a property of the *message format* (Telegram-flavoured markdown) and
    stays in the gateway, where the message format is known.

  * Stage B — TOKENS. How a speakable string is pronounced: `90s` is "ninety
    seconds", `16:1` is "sixteen to one", `$1.6M` is "one point six million
    dollars", `#4661` is "hash four six six one". That is a property of
    ENGLISH and of the phonemizer, not of Telegram — so it belongs next to
    the phonemizer. This module.

This module is Stage B. It runs inside the voice sidecar, immediately before
the text is split into synthesis pieces and handed to misaki/Kokoro. It is
the single home for token rules: the two gateway passes
(`telegram-plugin/voice-normalize-text.ts` and `telegram-plugin/
tts-normalize.ts`) had two *contradictory* unit tables — one read a bare `m`
as "minutes", the other as "metres" — and no single place to fix a
mispronunciation. Every caller of `POST /tts` now gets the same token
treatment, including callers that never went through the gateway at all.

DESIGN CONTRACTS (all pinned by tests in test_text_normalize.py)
---------------------------------------------------------------
1. IDEMPOTENCE. `normalize(normalize(x)) == normalize(x)` for every input
   without a verbatim span. Stage A may or may not have already run; a rule
   that fires twice must be a no-op the second time. This is why, e.g., the
   currency rule consumes the `$` and emits the word "dollars" (a second
   pass finds no `$`), and why no rule emits a shape another rule matches.

   The verbatim-span exception is inherent, not an oversight: a span is a
   ONE-SHOT instruction ("do not interpret this region"), and its markers
   are consumed on the first pass because they must never reach the
   phonemizer. Re-normalising the output is therefore a different message —
   the protection was already spent. Production runs exactly one pass, and
   the property is asserted for every span-free input.

2. NO `\\d.\\p{L}` OUTPUT. A digit immediately followed by a letter is the
   shape that makes misaki spell garbage ("94g" → "ninety-four jee"), so no
   rule may *produce* one. Asserted as a property over the corpus.

3. BYTE-PRESERVING BOUNDARY. The HTTP boundary is still `POST /tts {text}`.
   Digits arrive as digits; this module — not the caller — decides how they
   are spoken. Set `VOICE_TTS_NORMALIZE=0` for a byte-identical passthrough
   (the kill switch; `VOICE_TTS_G2P=espeak` remains the separate G2P lever).

4. VERBATIM SPANS. A caller that knows a region must not be re-interpreted
   (inline code, an identifier, a quoted command) wraps it in the private-use
   markers U+E000 … U+E001. Inside a span, prose rules are suppressed and the
   identifier dispatcher runs instead. The protocol is deliberately
   forgiving — a stray closer, an unclosed opener, a nested opener or any
   other PUA codepoint is silently dropped rather than corrupting the rest of
   the message (see `_balance_pua`).

RULE ORDER
----------
The order below is normative, not incidental. Later rules depend on earlier
ones having consumed their input (e.g. clock times must be resolved before
the `#`/`@`/slash rules see a `:`; currency before magnitude so `$1.6M` is
one token; magnitude before units so the `M` in `$1.6M` is never "minutes").
`normalize()` is the only public entry point and applies them in that order.
"""

from __future__ import annotations

import json
import os
import re
from typing import Callable, Dict, Iterable, List, NamedTuple, Sequence, Tuple

from num2words import num2words

__all__ = [
    "normalize",
    "normalize_enabled",
    "SPAN_OPEN",
    "SPAN_CLOSE",
    "Override",
    "OVERRIDES_PATH",
    "load_overrides",
    "apply_overrides",
]

# ---------------------------------------------------------------------------
# Verbatim-span markers (private use area). See §6 of the design.
# ---------------------------------------------------------------------------

SPAN_OPEN = ""
SPAN_CLOSE = ""

_PUA_LO = 0xE000
_PUA_HI = 0xF8FF

# Internal placeholder for a parked verbatim span. Chosen so that NO rule in
# this module can match it: U+0000 is stripped from all input first, and the
# body is `S<digits>` — a single capital letter, which the acronym rule
# (2..5 letters) and the all-caps rule (5+) both decline.
_PARK_OPEN = "\x00"
_PARK_CLOSE = "\x00"


def normalize_enabled() -> bool:
    """False iff VOICE_TTS_NORMALIZE is explicitly turned off.

    Default ON. Accepts the usual falsey spellings so an operator does not
    have to remember which one this service wanted.
    """
    raw = (os.environ.get("VOICE_TTS_NORMALIZE") or "").strip().lower()
    return raw not in {"0", "off", "false", "no"}


# ---------------------------------------------------------------------------
# Number words
# ---------------------------------------------------------------------------
#
# num2words replaces the two hand-rolled `numberToWords` forks the gateway
# carried (they disagreed above 999 and neither did decimals). Its default
# English is British-flavoured — "one thousand, nine hundred and ninety" —
# so we strip the comma and the "and" to match the en-US voice the fleet
# ships (and the two forks' historical output).

_DIGIT_WORDS = {
    "0": "zero",
    "1": "one",
    "2": "two",
    "3": "three",
    "4": "four",
    "5": "five",
    "6": "six",
    "7": "seven",
    "8": "eight",
    "9": "nine",
}


def _us(words: str) -> str:
    """British num2words output → the US reading (no ", ", no " and ")."""
    return words.replace(", ", " ").replace(" and ", " ")


def _cardinal(value: str | int | float) -> str:
    """Spoken cardinal. Accepts an int, a float, or a numeric string.

    Strings are preferred: they preserve trailing zeros ("2.50" → "two point
    five zero") that float() would silently eat, and avoid binary-float
    artefacts entirely.
    """
    if isinstance(value, str):
        text = value.strip().replace(",", "")
        if "." in text:
            whole, _, frac = text.partition(".")
            whole_words = _us(num2words(int(whole or "0")))
            frac_words = " ".join(_DIGIT_WORDS.get(c, c) for c in frac)
            if not frac:
                return whole_words
            return f"{whole_words} point {frac_words}"
        return _us(num2words(int(text)))
    if isinstance(value, float) and not value.is_integer():
        return _cardinal(repr(value))
    return _us(num2words(int(value)))


def _ordinal(value: int) -> str:
    return _us(num2words(int(value), to="ordinal"))


def _digits(text: str) -> str:
    """Per-digit reading: "4661" → "four six six one"."""
    return " ".join(_DIGIT_WORDS.get(c, c) for c in text if c.isdigit())


def _year_words(year: int) -> str:
    """Spoken year, preserving the gateway's historical semantics.

    2000-2099 read as "two thousand [n]" (num2words `to='year'` would say
    "twenty twenty-six" — a legitimate reading, but not the one the fleet has
    been shipping, and changing it is not this PR's business). Other 4-digit
    years read as pairs: 1984 → "nineteen eighty-four".
    """
    if 2000 <= year <= 2099:
        rest = year - 2000
        return "two thousand" if rest == 0 else f"two thousand {_cardinal(rest)}"
    if 1000 <= year <= 9999:
        hi, lo = divmod(year, 100)
        if lo == 0:
            return f"{_cardinal(hi)} hundred"
        if lo < 10:
            return f"{_cardinal(hi)} oh {_cardinal(lo)}"
        return f"{_cardinal(hi)} {_cardinal(lo)}"
    return _cardinal(year)


# ---------------------------------------------------------------------------
# Tables
# ---------------------------------------------------------------------------

# Acronyms spoken letter-by-letter. misaki spells unknown all-caps words
# anyway; this table exists so the KNOWN ones are spelled *deliberately* and
# so the all-caps-lowering rule below knows what to leave alone.
ACRONYMS = frozenset(
    """CI PR API URL GPU CPU TTS STT HTTP JSON SQL UI HTTPS SSH DNS CLI AWS
    UTC MCP PDF ID OK VM LLM YAML RAM USB""".split()
)

_ACRONYM_MAX = max(len(a) for a in ACRONYMS)

# Multi-character units. Single-letter units are handled separately (below)
# because they need a case guard: "3D printer" and "5G network" must not
# become "three days"/"five grams".
_UNITS: Dict[str, Tuple[str, str]] = {
    "ms": ("millisecond", "milliseconds"),
    "sec": ("second", "seconds"),
    "secs": ("second", "seconds"),
    "min": ("minute", "minutes"),
    "mins": ("minute", "minutes"),
    "hr": ("hour", "hours"),
    "hrs": ("hour", "hours"),
    "kb": ("kilobyte", "kilobytes"),
    "mb": ("megabyte", "megabytes"),
    "gb": ("gigabyte", "gigabytes"),
    "tb": ("terabyte", "terabytes"),
    "kg": ("kilogram", "kilograms"),
    "km": ("kilometre", "kilometres"),
    "cm": ("centimetre", "centimetres"),
    "mm": ("millimetre", "millimetres"),
    "mi": ("mile", "miles"),
    "ghz": ("gigahertz", "gigahertz"),
    "mhz": ("megahertz", "megahertz"),
    "kw": ("kilowatt", "kilowatts"),
}

# Single-letter units: lowercase ONLY, and never `m` (which is ambiguous and
# gets its own pair of rules — see `_units`).
_UNITS_1: Dict[str, Tuple[str, str]] = {
    "s": ("second", "seconds"),
    "h": ("hour", "hours"),
    "d": ("day", "days"),
    "g": ("gram", "grams"),
}

_MAGNITUDE = {"k": "thousand", "K": "thousand", "M": "million", "B": "billion"}

_MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
]

_MONTH_ABBR = {
    "Jan": "January",
    "Feb": "February",
    "Mar": "March",
    "Apr": "April",
    "Jun": "June",
    "Jul": "July",
    "Aug": "August",
    "Sep": "September",
    "Sept": "September",
    "Oct": "October",
    "Nov": "November",
    "Dec": "December",
}

_ABBREVIATIONS = {
    "e.g.": "for example",
    "i.e.": "that is",
    "etc.": "et cetera",
    "vs.": "versus",
    "approx.": "approximately",
    "w/": "with",
}

# HTTP status codes: "404s" is "four oh four's", never "four hundred four
# seconds". The set is the codes that actually appear in engineering chat;
# anything outside it falls through to the unit rule.
_HTTP_STATUS = {
    "200",
    "201",
    "202",
    "204",
    "301",
    "302",
    "304",
    "400",
    "401",
    "403",
    "404",
    "405",
    "409",
    "418",
    "422",
    "429",
    "500",
    "501",
    "502",
    "503",
    "504",
}

# Words that, near a `NNNs`, mean the N is an HTTP status rather than a
# duration ("we're seeing 500s from the API").
_HTTP_CUES = re.compile(
    r"\b(http|https|status|code|codes|response|responses|error|errors|"
    r"request|requests|api|endpoint|server|gateway|nginx|proxy|retry|"
    r"retries|throttl\w*|timeouts?|5xx|4xx|seeing|returning|returned|"
    r"spike|spiking|upstream|shipped|serving|served)\b",
    re.IGNORECASE,
)

# Words that mean a `NNs` is a DECADE ("back in the 90s"), not a duration.
_DECADE_CUES = re.compile(
    r"\b(in|since|during|throughout|back|early|mid|late|the|era|nostalgi\w*|"
    r"music|kid|kids|childhood|born|grew|growing)\b",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# §6 — PUA balancing
# ---------------------------------------------------------------------------


def _balance_pua(text: str) -> str:
    """Make the verbatim-span markers well-formed, dropping anything else.

    Deliberately total: any PUA codepoint in the input is either a
    well-formed span marker or is dropped. A user who types a private-use
    character (or a model that emits one) can never desynchronise the
    dispatcher, and no PUA can reach the phonemizer — where it would be
    silently dropped by the vocab anyway, or worse, spelled.

      * stray closer          → dropped
      * unclosed opener       → dropped
      * nested opener         → dropped (the outer span wins)
      * any other PUA char    → dropped
    """
    out: List[str] = []
    open_at: int | None = None
    for ch in text:
        if ch == SPAN_OPEN:
            if open_at is None:
                open_at = len(out)
                out.append(ch)
            # else: nested opener, dropped.
        elif ch == SPAN_CLOSE:
            if open_at is not None:
                out.append(ch)
                open_at = None
            # else: stray closer, dropped.
        elif _PUA_LO <= ord(ch) <= _PUA_HI:
            pass  # other private-use codepoint, dropped.
        else:
            out.append(ch)
    if open_at is not None:
        del out[open_at]  # unclosed opener, dropped.
    return "".join(out)


_SPAN_RE = re.compile(re.escape(SPAN_OPEN) + r"(.*?)" + re.escape(SPAN_CLOSE), re.S)


def _park_spans(text: str) -> Tuple[str, List[str]]:
    """Replace each verbatim span with an inert placeholder.

    The span's CONTENT is dispatched immediately (identifier rules only) and
    the result stored; prose rules then run over the placeholder-bearing
    text and cannot touch it.
    """
    parked: List[str] = []

    def take(m: re.Match[str]) -> str:
        parked.append(_dispatch_verbatim(m.group(1)))
        return f"{_PARK_OPEN}S{len(parked) - 1}{_PARK_CLOSE}"

    return _SPAN_RE.sub(take, text), parked


_UNPARK_RE = re.compile(re.escape(_PARK_OPEN) + r"S(\d+)" + re.escape(_PARK_CLOSE))


def _unpark_spans(text: str, parked: List[str]) -> str:
    def put(m: re.Match[str]) -> str:
        idx = int(m.group(1))
        return parked[idx] if 0 <= idx < len(parked) else ""

    return _UNPARK_RE.sub(put, text)


# ---------------------------------------------------------------------------
# Identifier dispatch (used inside verbatim spans AND on prose identifiers)
# ---------------------------------------------------------------------------

_URL_RE = re.compile(r"\bhttps?://\S+|\bwww\.[^\s<>]+", re.IGNORECASE)
_DOTTED_QUAD_RE = re.compile(r"(?<![\w.])(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{2,5}))?(?![\w.])")
_VERSION_RE = re.compile(r"(?<![\w.])(v?)(\d+(?:\.\d+){2,})(?![\w.])", re.IGNORECASE)
# The lookbehind excludes `.` but NOT `/`: a path-qualified file still
# deserves the "file dot ext, line N" reading, and blocking on `/` meant
# `tui_gateway/methods_session.py:14` fell through to the snake rule,
# which spaced the stem and left `session.py:14` for a second pass
# (corpus-replay idempotence breach).
_FILE_LINE_RE = re.compile(r"(?<![\w.])([\w-]+)\.([A-Za-z]{1,5}):(\d{1,6})(?![\w.])")
_HEX_RE = re.compile(r"(?<![\w])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])([0-9a-f]{7,40})(?![\w])")
_LONG_DIGITS_RE = re.compile(r"(?<![\w.,])(\d{6,})(?![\w.,])")
_SNAKE_RE = re.compile(r"(?<![\w])([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)(?![\w])")
_CAMEL_RE = re.compile(r"(?<![\w])([a-z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)(?![\w])")


def _spell(word: str) -> str:
    return " ".join(word.upper())


_HOST_RE = re.compile(r"^[a-z0-9-]+(?:\.[a-z0-9-]+)+$", re.IGNORECASE)


def _spoken_url(url: str) -> str:
    """A URL as a human reads it aloud: the domain, then "link".

    The path is dropped deliberately — a spoken path is unintelligible and
    the listener cannot click it either way. An IP-literal or userinfo-laden
    host reads worse than saying nothing, so it degrades to "a link".
    """
    m = re.match(r"^(?:https?://)?(?:www\.)?([^/\s:?#]+)", url, re.IGNORECASE)
    if not m:
        return "a link"
    host = m.group(1)
    if not _HOST_RE.match(host) or re.match(r"^\d+\.\d+\.\d+\.\d+$", host):
        return "a link"
    return host.lower().replace(".", " dot ") + " link"


def _segment_words(token: str, joiner: str) -> str:
    """snake_case / camelCase → spoken segments (no "underscore", no "camel")."""
    raw = re.split(r"[_\-]+", token)
    parts: List[str] = []
    for chunk in raw:
        if not chunk:
            continue
        for piece in re.findall(r"[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+", chunk):
            parts.append(piece)
    spoken: List[str] = []
    for piece in parts:
        upper = piece.upper()
        if upper in ACRONYMS:
            spoken.append(_spell(upper))
        elif piece.isdigit():
            # A short number inside an identifier is a COUNT, not a serial:
            # "Snapshot_10" is "Snapshot ten", not "Snapshot one zero". Longer
            # runs stay per-digit — that IS how a serial is read aloud.
            spoken.append(_cardinal(piece) if len(piece) <= 2 else _digits(piece))
        elif piece.isupper() and len(piece) >= 2:
            spoken.append(piece.lower())
        else:
            # A segment can itself be a dispatchable shape: splitting
            # `wf_2f0e6072-af3` exposes a bare git hash that only the hex rule
            # can speak. Resolving it HERE is what keeps the pass idempotent —
            # otherwise the exposed shape sits in the output waiting for a
            # second pass. Terminates: segments carry no `_`/`-` and cannot
            # match the camel shape, so this recurses at most one level.
            spoken.append(_dispatch_token(piece, joiner) or piece)
    return joiner.join(spoken)


def _dispatch_token(token: str, joiner: str) -> str | None:
    """Return a spoken form for an identifier-shaped token, or None."""
    if _URL_RE.fullmatch(token):
        return _spoken_url(token)
    m = _FILE_LINE_RE.fullmatch(token)
    if m:
        stem = _segment_words(m.group(1), " ")
        return f"{stem} dot {m.group(2).lower()}, line {_digits(m.group(3))}"
    m = _DOTTED_QUAD_RE.fullmatch(token)
    if m:
        octets = " dot ".join(_digits(o) for o in m.group(1).split("."))
        if m.group(2):
            return f"{octets}, {_digits(m.group(2))}"
        return octets
    m = _VERSION_RE.fullmatch(token)
    if m:
        head = "v " if m.group(1) else ""
        return head + " point ".join(_cardinal(s) for s in m.group(2).split("."))
    if _HEX_RE.fullmatch(token):
        return " ".join(token.upper())
    if _LONG_DIGITS_RE.fullmatch(token):
        return _digits(token)
    if "_" in token or "-" in token:
        return _segment_words(token, joiner)
    if _CAMEL_RE.fullmatch(token):
        return _segment_words(token, joiner)
    upper = token.upper()
    if token.isupper() and token.isalpha():
        if upper in ACRONYMS:
            return _spell(upper)
        if len(token) >= 5:
            return token.lower()
    return None


def _dispatch_verbatim(content: str) -> str:
    """Speak a verbatim span: identifier rules only, prose rules suppressed.

    Segments inside a span are joined with a comma so the synthesiser puts a
    real pause between them — that is what makes a spoken identifier legible
    ("switchroom, config, dir" rather than one mushed word).
    """
    words = content.split()
    out: List[str] = []
    for word in words:
        core = word
        lead, trail = "", ""
        m = re.match(r"^([\"'(\[]*)(.*?)([\"')\].,;:!?]*)$", word, re.S)
        if m:
            lead, core, trail = m.group(1), m.group(2), m.group(3)
        spoken = _dispatch_token(core, ", ") if core else None
        out.append(f"{lead}{spoken if spoken is not None else core}{trail}")
    return " ".join(out)


def _identifiers(text: str) -> str:
    """Prose identifier shapes. Same dispatcher, spaces instead of commas."""

    def sub(pattern: re.Pattern[str]) -> None:
        nonlocal text
        text = pattern.sub(lambda m: _dispatch_token(m.group(0), " ") or m.group(0), text)

    for pattern in (
        _FILE_LINE_RE,
        _DOTTED_QUAD_RE,
        _VERSION_RE,
        _HEX_RE,
        _SNAKE_RE,
        _CAMEL_RE,
        _LONG_DIGITS_RE,
    ):
        sub(pattern)
    # Identifier expansion produces prose the slash rule owns — see
    # _slash_words for why this second application is a correctness fix and
    # not a belt-and-braces re-run.
    return _slash_words(text)


# ---------------------------------------------------------------------------
# Legacy-markdown belt
# ---------------------------------------------------------------------------
#
# Stage A (the gateway) owns markdown structure and normally hands this
# module clean prose. But `POST /tts` is a public boundary: a caller that
# never went through Stage A can hand us raw markdown, and speaking
# "asterisk asterisk" at someone is worse than the belt's small risk of
# eating a literal asterisk. Every rule here is a pure deletion, so it is
# idempotent by construction.

_FENCE_LINE_RE = re.compile(r"^[ \t]*(?:```|~~~).*$", re.M)
_HEADING_RE = re.compile(r"^ {0,3}#{1,6}[ \t]+", re.M)
_QUOTE_RE = re.compile(r"^ {0,3}>[ \t]?", re.M)
_BULLET_RE = re.compile(r"^ {0,3}[-*+][ \t]+", re.M)
_NUMLIST_RE = re.compile(r"^ {0,3}\d{1,3}[.)][ \t]+", re.M)
_HR_RE = re.compile(r"^ {0,3}(?:[-*_][ \t]*){3,}$", re.M)
_TABLE_SEP_RE = re.compile(r"^ {0,3}\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)+\|?$", re.M)
_LINK_RE = re.compile(r"\[([^\]\n]+)\]\((?:[^)\n]*)\)")


def _markdown_belt(text: str) -> str:
    text = _FENCE_LINE_RE.sub("", text)
    text = _HR_RE.sub("", text)
    text = _TABLE_SEP_RE.sub("", text)
    text = _HEADING_RE.sub("", text)
    text = _QUOTE_RE.sub("", text)
    text = _BULLET_RE.sub("", text)
    text = _NUMLIST_RE.sub("", text)
    text = _LINK_RE.sub(r"\1", text)
    text = re.sub(r"`([^`\n]+)`", r"\1", text)
    text = re.sub(r"\*\*\*([^*\n]+)\*\*\*", r"\1", text)
    text = re.sub(r"___([^_\n]+)___", r"\1", text)
    text = re.sub(r"\*\*([^*\n]+)\*\*", r"\1", text)
    text = re.sub(r"__([^_\n]+)__", r"\1", text)
    text = re.sub(r"~~([^~\n]+)~~", r"\1", text)
    text = re.sub(r"(?<![\w*])\*([^*\n]+)\*(?![\w*])", r"\1", text)
    text = re.sub(r"\|", " ", text)
    return _MARKER_RESIDUE_RE.sub("", _EDGE_UNDERSCORE_RE.sub("", text))


# Decorative residue is stripped HERE, not in the final sweep, because a
# leftover marker HIDES an identifier from the dispatcher: `_resetForTests()`,
# `^VOICE_`, `HINDSIGHT_API_EMBEDDINGS_*` and `${SE_KEY}` all failed their
# pattern's `(?![\w])` boundary on pass 1, then had the marker swept away and
# matched on pass 2 — five of the corpus replay's idempotence breaches, one
# cause. Interior underscores survive: they are what snake_case is made of,
# and the final sweep is still the backstop for any that reach it.
# `~` is deliberately NOT in this set: it still carries meaning at this point
# ("~500" → "about 500"), so it stays for the symbol rule and is swept later.
_MARKER_RESIDUE_RE = re.compile(r"[`*]")
_EDGE_UNDERSCORE_RE = re.compile(r"(?<![\w])_+|_+(?![\w])")


# ---------------------------------------------------------------------------
# Dates
# ---------------------------------------------------------------------------

_ISO_DATE_RE = re.compile(r"(?<![\w-])(\d{4})-(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])(?![\w-])")
_ISO_STAMP_RE = re.compile(
    r"(?<![\w-])(\d{4})-(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])"
    r"[T ]([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?(?![\w])"
)
_SLASH_DATE_RE = re.compile(r"(?<![\w/.])(0?[1-9]|[12]\d|3[01])/(0?[1-9]|1[0-2])/(\d{4}|\d{2})(?![\w/.])")
_MONTH_DAY_RE = re.compile(
    r"\b(" + "|".join(_MONTH_ABBR) + r")\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?![\w/])"
)
_DAY_MONTH_RE = re.compile(
    r"\b(\d{1,2})(?:st|nd|rd|th)?\s+(" + "|".join(_MONTH_ABBR) + r")\.?(?![\w/])"
)


def _iso_dates(text: str) -> str:
    def stamp(m: re.Match[str]) -> str:
        year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
        hour, minute = int(m.group(4)), int(m.group(5))
        spoken = f"{_MONTHS[month - 1]} {_ordinal(day)} {_year_words(year)} at "
        if minute == 0:
            spoken += f"{_cardinal(hour)} o'clock"
        elif minute < 10:
            spoken += f"{_cardinal(hour)} oh {_cardinal(minute)}"
        else:
            spoken += f"{_cardinal(hour)} {_cardinal(minute)}"
        if m.group(6) == "Z":
            spoken += " U T C"
        return spoken

    def sub(m: re.Match[str]) -> str:
        year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
        return f"{_MONTHS[month - 1]} {_ordinal(day)} {_year_words(year)}"

    # Timestamps first: the date half of `2026-08-08T12:39:00Z` matches the
    # date rule and the time half matches the clock rule, and rewriting them
    # independently leaves the `T` welded between two words ("08Ttwelve") —
    # the exact digit-glued-to-letter shape contract 2 forbids, found by the
    # corpus replay. Seconds are dropped on purpose: nobody wants a spoken
    # ":00", and the minute is the smallest unit a listener can use.
    text = _ISO_STAMP_RE.sub(stamp, text)
    return _ISO_DATE_RE.sub(sub, text)


def _month_abbrev(text: str) -> str:
    """Expand a month ABBREVIATION, and only when a day number pins it.

    A bare "Mar" or "Aug" in prose is far more often a name or a word than a
    month; requiring an adjacent day number is what keeps "Marko" and "Sept"
    honest. A full month name is left alone (it already reads correctly).
    """
    text = _MONTH_DAY_RE.sub(lambda m: f"{_MONTH_ABBR[m.group(1)]} {_ordinal(int(m.group(2)))}", text)
    text = _DAY_MONTH_RE.sub(lambda m: f"the {_ordinal(int(m.group(1)))} of {_MONTH_ABBR[m.group(2)]}", text)
    return text


def _slash_dates(text: str) -> str:
    """D/M/Y only, and only with a 4-digit year or an unambiguous day.

    `05/08` stays a slash — it is 5 August to half the fleet and 8 May to the
    other half, and a ratio to the rest. Guessing is worse than leaving it,
    because the phonemizer reads a bare slash date as "five eight" which is
    at least honest.
    """

    def sub(m: re.Match[str]) -> str:
        day, month, year = int(m.group(1)), int(m.group(2)), m.group(3)
        if day > 31 or month > 12:
            return m.group(0)
        yr = int(year) if len(year) == 4 else 2000 + int(year)
        return f"the {_ordinal(day)} of {_MONTHS[month - 1]} {_year_words(yr)}"

    return _SLASH_DATE_RE.sub(sub, text)


# ---------------------------------------------------------------------------
# Phone runs and clock times
# ---------------------------------------------------------------------------

# A grouped phone run: starts with `+` or `0`, groups of 2+ digits, 9 digits
# or more overall. Every one of those is load-bearing — a looser pattern eats
# ordinary spaced numbers ("300 600 900") and, worse, eats the SPACED OUTPUT
# of the hex-hash dispatcher on a second pass (which is how a normaliser
# stops being idempotent).
_PHONE_RE = re.compile(r"(?<![\w.+])(\+?\d{2,}(?:[ -]\d{2,}){1,5})(?![\w.])")
_CLOCK_RE = re.compile(
    r"(?<![\d:.])([01]?\d|2[0-3]):([0-5]\d)(?!:?\d)(?:[ \t]*(a\.?m\.?|p\.?m\.?))?",
    re.IGNORECASE,
)


def _phone_runs(text: str) -> str:
    def sub(m: re.Match[str]) -> str:
        run = m.group(1)
        digits = re.sub(r"\D", "", run)
        if len(digits) < 9 or not (run.startswith("+") or digits.startswith("0")):
            return run
        head = "plus " if run.startswith("+") else ""
        return head + _digits(digits)

    return _PHONE_RE.sub(sub, text)


def _clock(text: str) -> str:
    def sub(m: re.Match[str]) -> str:
        hour, minute, mer = int(m.group(1)), int(m.group(2)), m.group(3)
        if minute == 0:
            spoken = f"{_cardinal(hour)} o'clock"
        elif minute < 10:
            spoken = f"{_cardinal(hour)} oh {_cardinal(minute)}"
        else:
            spoken = f"{_cardinal(hour)} {_cardinal(minute)}"
        if mer:
            spoken += " " + mer.replace(".", "").lower().replace("am", "a m").replace("pm", "p m")
        return spoken

    # Ratios and scores ("16:1", "3:2") are deliberately NOT rewritten: the
    # minute group requires two digits, so the clock rule declines them, and
    # misaki reads "16:1" as "sixteen one" — honest, and better than inventing
    # a "to" the writer did not write. Same for "183/183": the slash-words
    # rule is letters-only.
    return _CLOCK_RE.sub(sub, text)


# ---------------------------------------------------------------------------
# Money, percent, ordinals, magnitude, units
# ---------------------------------------------------------------------------

# The optional currency prefix is CONSUMED, not left welded to the number:
# "A$7.46" used to become "Aseven dollars forty-six" (the phonemizer read
# "Aseven" as one word) because the old rule matched only the `$`.
_CURRENCY_RE = re.compile(
    r"(?<![A-Za-z0-9])(A|AU|NZ|US|C)?\$(\d{1,3}(?:,\d{3})+|\d{1,9})(?:\.(\d{2}))?(?![\d,]|\.\d)"
)
_PERCENT_RE = re.compile(r"(?<![\d.,$])(\d{1,9}(?:\.\d+)?)[ \t]*%")
_ORDINAL_RE = re.compile(r"(?<![\w.,])(\d{1,2})(st|nd|rd|th)(?![\w])", re.IGNORECASE)
_MAGNITUDE_RE = re.compile(r"(?<![\w.,$])(\$?)(\d{1,9}(?:\.\d+)?)([kKMB])(?![\w])")
# `(?!\.\d)` is the citation guard, found by the corpus replay: "Subdivision
# Act 1988 s.35" matched the spaced single-letter form and was read as "1988
# seconds". A unit followed by a dotted number is a section/clause reference,
# never a measurement.
_UNIT_RE = re.compile(
    r"(?<![\w.,$])(\d{1,9}(?:\.\d+)?)[ \t]?("
    + "|".join(sorted(_UNITS, key=len, reverse=True))
    + r")(?![\w]|\.\d)",
    re.IGNORECASE,
)
_UNIT1_RE = re.compile(
    r"(?<![\w.,$])(\d{1,9}(?:\.\d+)?)[ \t]?(" + "|".join(_UNITS_1) + r")(?![\w]|\.\d)"
)
_RANGE_RE = re.compile(
    r"(?<![\w.,$])(\d{1,9})-(?=\d{1,9}(?:\.\d+)?[ \t]?(?:"
    + "|".join(sorted(_UNITS, key=len, reverse=True) + sorted(_UNITS_1))
    + r")(?![\w]|\.\d))",
    re.IGNORECASE,
)
_MIN_GLUED_RE = re.compile(r"(?<![\w.,$])(\d{1,9}(?:\.\d+)?)m(?![\w])")
_METRE_SPACED_RE = re.compile(r"(?<![\w.,$])(\d{1,9}(?:\.\d+)?)[ \t]m(?![\w])")


def _currency(text: str) -> str:
    def sub(m: re.Match[str]) -> str:
        whole, cents = m.group(2), m.group(3)
        amount = int(whole.replace(",", ""))
        spoken = f"{_cardinal(amount)} dollar{'' if amount == 1 else 's'}"
        if cents:
            spoken += " " + _cardinal(int(cents))
        return spoken

    return _CURRENCY_RE.sub(sub, text)


def _percent(text: str) -> str:
    return _PERCENT_RE.sub(lambda m: f"{_cardinal(m.group(1))} percent", text)


def _ordinals(text: str) -> str:
    def sub(m: re.Match[str]) -> str:
        num, suffix = int(m.group(1)), m.group(2).lower()
        # Only rewrite when the written suffix is the CORRECT one — "21th"
        # is a typo, and speaking it as "twenty-first" silently invents a
        # correction the writer did not make. (It is also how "1st"-shaped
        # false positives inside identifiers get declined.)
        if suffix != _expected_suffix(num):
            return m.group(0)
        return _ordinal(num)

    return _ORDINAL_RE.sub(sub, text)


def _expected_suffix(num: int) -> str:
    if 11 <= (num % 100) <= 13:
        return "th"
    return {1: "st", 2: "nd", 3: "rd"}.get(num % 10, "th")


def _magnitude(text: str) -> str:
    def sub(m: re.Match[str]) -> str:
        dollars, number, suffix = m.group(1), m.group(2), m.group(3)
        spoken = f"{_cardinal(number)} {_MAGNITUDE[suffix]}"
        if dollars:
            spoken += " dollars"
        return spoken

    return _MAGNITUDE_RE.sub(sub, text)


_DECADE_WORDS = {
    "00": "hundreds",
    "10": "tens",
    "20": "twenties",
    "30": "thirties",
    "40": "forties",
    "50": "fifties",
    "60": "sixties",
    "70": "seventies",
    "80": "eighties",
    "90": "nineties",
}


def _status_words(number: str) -> str:
    """"404s" → "four oh fours" — the way an engineer says it out loud."""
    return " ".join("oh" if c == "0" else _DIGIT_WORDS[c] for c in number) + "s"


def _decade_words(number: str) -> str:
    if number == "2000":
        return "two thousands"
    if len(number) == 4:
        return f"{_cardinal(int(number[:2]))} {_DECADE_WORDS[number[2:]]}"
    return _DECADE_WORDS[number]


def _is_http_status(number: str, text: str, at: int) -> bool:
    if number not in _HTTP_STATUS:
        return False
    window = text[max(0, at - 90) : at + 90]
    return bool(_HTTP_CUES.search(window))


def _is_decade(number: str, text: str, at: int) -> bool:
    """`90s` is a duration unless the context says decade.

    The gateway's rule was the reverse — any `(19|20)?\\d0s` was a decade —
    which is why "90s timeout" was read as "the nineties" in the corpus. A
    duration is by far the common case in this fleet's chat, so the decade
    reading now has to earn itself with a cue word or an explicit century.
    """
    # A four-digit decade must still BE a decade: "1990s" yes, "1988s" no.
    # (The corpus produced "Subdivision Act 1988 s.35" — see _UNIT1_RE's
    # `(?!\.\d)` guard — and an unguarded `19xx` branch crashed on it.)
    if len(number) == 4 and number[:2] in {"19", "20"} and number[2:] in _DECADE_WORDS:
        if number[2:] != "00":
            return True
        # "2000s" is as likely a round duration as a decade, so the century
        # form still has to earn the decade reading with a cue.
        return bool(_DECADE_CUES.search(text[max(0, at - 40) : at]))
    if not (len(number) == 2 and number.endswith("0")):
        return False
    if at > 0 and text[at - 1] == "'":
        return True
    window = text[max(0, at - 40) : at]
    return bool(_DECADE_CUES.search(window))


def _units(text: str) -> str:
    # A range shares its unit: only the second number carries it, so without
    # this the corpus produced "4-five minutes" — half spoken, half digits.
    text = _RANGE_RE.sub(lambda m: f"{_cardinal(m.group(1))} to ", text)

    def multi(m: re.Match[str]) -> str:
        number, unit = m.group(1), m.group(2).lower()
        singular, plural = _UNITS[unit]
        return f"{_cardinal(number)} {singular if number == '1' else plural}"

    def single(m: re.Match[str]) -> str:
        number, unit = m.group(1), m.group(2)
        if unit == "s":
            # Both declines still SPEAK the token rather than leaving digits
            # glued to an `s`: "404s" reaching misaki as digits+letter is the
            # exact shape that produces garbage, and leaving it would also
            # break idempotence (the cue words this guard reads can be
            # rewritten by later rules).
            if _is_http_status(number, text, m.start(1)):
                return _status_words(number)
            if _is_decade(number, text, m.start(1)):
                return _decade_words(number)
        singular, plural = _UNITS_1[unit]
        return f"{_cardinal(number)} {singular if number == '1' else plural}"

    text = _UNIT_RE.sub(multi, text)
    text = _UNIT1_RE.sub(single, text)
    # The `m` split. This is the rule the two gateway passes disagreed on:
    # one said minutes, the other metres, and whichever ran last won. The
    # corpus says the two senses are written differently — a duration is
    # GLUED ("90m", "5m") and a length is SPACED ("16 m frontage") — so the
    # spacing decides, and a capital `M` is never a unit (it is a magnitude,
    # handled above).
    text = _MIN_GLUED_RE.sub(
        lambda m: f"{_cardinal(m.group(1))} minute{'' if m.group(1) == '1' else 's'}", text
    )
    text = _METRE_SPACED_RE.sub(
        lambda m: f"{_cardinal(m.group(1))} metre{'' if m.group(1) == '1' else 's'}", text
    )
    return text


# ---------------------------------------------------------------------------
# Symbols
# ---------------------------------------------------------------------------

_MULT_RE = re.compile(r"(?<![\w.])(\d{1,9}(?:\.\d+)?)[ \t]*[×x][ \t]*(\d{1,9}(?:\.\d+)?)(?![\w.])")
_MULT_TAIL_RE = re.compile(r"(?<![\w.])(\d{1,9}(?:\.\d+)?)[ \t]*[×x](?![\w])")
_DEG_RE = re.compile(r"[ \t]*°[ \t]*([CF])?\b")
_ARROW_RE = re.compile(r"[ \t]*(?:[-=]>|→|⇒)[ \t]*")
_HASH_RE = re.compile(r"#(?=[A-Za-z0-9])")
_AT_RE = re.compile(r"(^|[\s(])@(?=[A-Za-z0-9_])", re.M)
_AMP_TIGHT_RE = re.compile(r"(?<=\w)&(?=\w)")
_AMP_LOOSE_RE = re.compile(r"[ \t]&[ \t]")
_PLUS_RE = re.compile(r"(?<=[\w)])[ \t]*\+[ \t]*(?=[\w(])")
_EQ_RE = re.compile(r"[ \t]=[ \t]")
_SLASH_WORDS_RE = re.compile(r"(?<![\w/])([A-Za-z]{2,})((?:/[A-Za-z]{2,})+)(?![\w/])")
_TILDE_NUM_RE = re.compile(r"~[ \t]*(?=\d)")


def _symbols(text: str) -> str:
    text = _MULT_RE.sub(lambda m: f"{_cardinal(m.group(1))} by {_cardinal(m.group(2))}", text)
    text = _MULT_TAIL_RE.sub(lambda m: f"{_cardinal(m.group(1))} times", text)
    text = _DEG_RE.sub(
        lambda m: " degrees" + {"C": " Celsius", "F": " Fahrenheit", None: ""}[m.group(1)], text
    )
    text = _ARROW_RE.sub(" to ", text)
    text = _HASH_RE.sub(" hash ", text)
    text = _AT_RE.sub(r"\1at ", text)
    text = _AMP_TIGHT_RE.sub(" and ", text)
    text = _AMP_LOOSE_RE.sub(" and ", text)
    text = _PLUS_RE.sub(" plus ", text)
    text = _EQ_RE.sub(" equals ", text)
    text = _slash_words(text)
    text = _TILDE_NUM_RE.sub("about ", text)
    return text


def _slash_words(text: str) -> str:
    """`word/word` → "word slash word".

    Applied twice: once here in symbol order, and once again immediately after
    identifier dispatch. Expanding an identifier MAKES new word/word pairs —
    `max_entries_to_build/merge` is one snake token plus "/merge", and only
    after the token becomes "max entries to build" is there a `word/word` pair
    for this rule to see. Without the second application the corpus replay
    found the leftover slash surviving pass 1 and firing on pass 2, i.e. a
    breach of the idempotence contract.
    """
    return _SLASH_WORDS_RE.sub(lambda m: m.group(1) + m.group(2).replace("/", " slash "), text)


def _abbreviations(text: str) -> str:
    for src, dst in _ABBREVIATIONS.items():
        text = re.sub(
            r"(?<![\w.])" + re.escape(src) + (r"" if src.endswith("/") else r"(?![\w])"),
            dst,
            text,
            flags=re.IGNORECASE,
        )
    return text


_ACRONYM_RE = re.compile(r"(?<![\w])([A-Z]{2," + str(_ACRONYM_MAX) + r"})(?![\w])")
_ALLCAPS_RE = re.compile(r"(?<![\w])([A-Z]{5,})(?![\w])")


def _acronyms(text: str) -> str:
    return _ACRONYM_RE.sub(
        lambda m: _spell(m.group(1)) if m.group(1) in ACRONYMS else m.group(1), text
    )


def _all_caps(text: str) -> str:
    """Lower an unknown ALL-CAPS word so misaki says it instead of spelling it.

    misaki spells any all-caps token it does not know letter by letter, which
    is how the corpus ended up with "M-E-R-G-E-A-B-L-E". Lowercasing hands it
    back to the normal lexicon path; the acronym table above has already
    claimed the words that genuinely SHOULD be spelled.
    """
    return _ALLCAPS_RE.sub(
        lambda m: m.group(1) if m.group(1) in ACRONYMS else m.group(1).lower(), text
    )


# ---------------------------------------------------------------------------
# Final sweep + whitespace
# ---------------------------------------------------------------------------

# Pictographs / dingbats / arrows / variation selectors. misaki either drops
# these (silence, fine) or spells their CLDR name (not fine), so they go.
_PICTOGRAPH_RE = re.compile(
    "["
    "\U0001f000-\U0001faff"
    "←-⇿"
    "⌀-⏿"
    "☀-➿"
    "⬀-⯿"
    "︎️"
    "]"
)
# Formatting/zero-width controls: invisible on screen, so a writer never
# meant them, and they can split a word for the tokenizer.
_INVISIBLE_RE = re.compile("[​-‏‪-‮⁠-⁤﻿]")
_RESIDUAL_RE = re.compile(r"[`*|~_]")


def _sweep(text: str) -> str:
    text = _PICTOGRAPH_RE.sub(" ", text)
    text = _INVISIBLE_RE.sub("", text)
    text = _RESIDUAL_RE.sub("", text)
    return text


def _whitespace(text: str) -> str:
    text = re.sub(r"\n{2,}", ". ", text)
    text = text.replace("\n", " ")
    text = re.sub(r"[ \t]{2,}", " ", text)
    # An en/em dash left glued to a number reads as part of it; give it the
    # space that makes it a pause ("hash 4661 – hash 4664").
    text = re.sub(r"(?<=\d)([–—])(?=\s)", r" \1", text)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    text = re.sub(r"([.!?])\s*\1+", r"\1", text)
    text = re.sub(r"\.\s*\.", ".", text)
    text = re.sub(r",\s*,", ",", text)
    return text.strip()


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

_PIPELINE: Tuple[Callable[[str], str], ...] = (
    _markdown_belt,
    _iso_dates,
    _month_abbrev,
    _slash_dates,
    _phone_runs,
    _clock,
    _currency,
    _percent,
    _ordinals,
    _magnitude,
    _units,
    _symbols,
    _abbreviations,
    _acronyms,
    _identifiers,
    _all_caps,
    _sweep,
)


def normalize(text: str) -> str:
    """Rewrite `text` into its spoken form. See the module docstring.

    Returns the input unchanged when the kill switch is off. Never raises on
    ordinary input: a rule that blows up would take the whole reply down, so
    the caller (server.py) also guards, but there is nothing in here that
    depends on external state.
    """
    if not text or not text.strip():
        return text
    if not normalize_enabled():
        return text

    working = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    working = _balance_pua(working)
    working, parked = _park_spans(working)

    # URLs first: they contain slashes, dots, colons and hashes that every
    # later rule would otherwise chew on.
    working = _URL_RE.sub(lambda m: _spoken_url(m.group(0)), working)

    for step in _PIPELINE:
        working = step(working)

    working = _unpark_spans(working, parked)
    return _whitespace(working)


# ---------------------------------------------------------------------------
# Pronunciation overrides
# ---------------------------------------------------------------------------
#
# misaki gets a handful of this fleet's vocabulary wrong in ways no amount of
# text rewriting can fix — "Postgres" comes out "post-gers", "Redis" comes
# out "ree-dees". misaki accepts an inline per-word phoneme override written
# `[word](/phonemes/)`, so the fix is a small, reviewable table applied at
# phonemize time (NOT in normalize(): the markup is misaki-specific and must
# never reach the espeak fallback path, which would read it as punctuation).
#
# Two hard rules, both enforced below rather than by convention:
#
#   * Every phoneme string is validated against Kokoro's vocabulary. An
#     out-of-vocab symbol is dropped SILENTLY by kokoro-onnx's tokenizer
#     (tokenizer.py:65) — the word would just vanish from the audio, which is
#     the worst possible failure mode for a pronunciation fix. A rejected
#     entry is dropped and reported; the rest of the table still loads.
#
#   * misaki's alphabet is NOT IPA. Capitals are collapsed diphthongs
#     (A=eɪ, I=aɪ, W=aʊ, Y=ɔɪ, O=oʊ) and `ᵊ` is a small schwa. Every entry in
#     overrides.json was produced by running the word through the actual
#     phonemizer, never by transcribing IPA from a dictionary.

OVERRIDES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "overrides.json")

# Registered `condition` predicates, by name. A condition gates an entry on
# the surrounding sentence (e.g. a POS-sensitive heteronym). Deliberately a
# NAME REGISTRY and not eval: overrides.json is data, and data must not be
# able to execute. Empty today — the one candidate (`live`) did not clear its
# measurement gate.
_CONDITIONS: Dict[str, Callable[[str, "re.Match[str]"], bool]] = {}


class Override(NamedTuple):
    match: str
    phonemes: str
    ci: bool
    condition: str | None


def _vocab_reject(phonemes: str, vocab: Iterable[str] | None) -> str | None:
    if vocab is None:
        return None
    allowed = set(vocab)
    missing = sorted({c for c in phonemes if c not in allowed})
    if missing:
        return "out-of-vocab phoneme(s): " + " ".join(repr(c) for c in missing)
    return None


def load_overrides(
    path: str | None = None, vocab: Iterable[str] | None = None
) -> Tuple[List[Override], List[Tuple[str, str]]]:
    """Load and validate the override table.

    Returns `(accepted, rejected)` where `rejected` is a list of
    `(match, reason)` pairs. Never raises for a bad table: a malformed
    overrides.json degrades to "no overrides" (today's behaviour) rather than
    taking the voice down, and the caller surfaces the reason on /healthz.
    """
    target = path or OVERRIDES_PATH
    accepted: List[Override] = []
    rejected: List[Tuple[str, str]] = []
    try:
        with open(target, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
    except FileNotFoundError:
        return accepted, rejected
    except (OSError, ValueError) as exc:
        return accepted, [("<file>", f"unreadable overrides.json: {exc}")]

    if not isinstance(doc, dict) or not isinstance(doc.get("entries"), list):
        return accepted, [("<file>", "overrides.json must be {version, entries: []}")]

    seen: set[str] = set()
    for raw in doc["entries"]:
        if not isinstance(raw, dict):
            rejected.append(("<entry>", "not an object"))
            continue
        word = raw.get("match")
        phonemes = raw.get("phonemes")
        ci = bool(raw.get("ci", False))
        condition = raw.get("condition")
        label = word if isinstance(word, str) else "<entry>"
        if not isinstance(word, str) or not word.strip():
            rejected.append((label, "missing/empty match"))
            continue
        if not isinstance(phonemes, str) or not phonemes.strip():
            rejected.append((label, "missing/empty phonemes"))
            continue
        if condition is not None and condition not in _CONDITIONS:
            rejected.append((label, f"unknown condition {condition!r}"))
            continue
        key = word.lower() if ci else word
        if key in seen:
            rejected.append((label, "duplicate match"))
            continue
        reason = _vocab_reject(phonemes, vocab)
        if reason:
            rejected.append((label, reason))
            continue
        seen.add(key)
        accepted.append(Override(word, phonemes, ci, condition))
    return accepted, rejected


def apply_overrides(text: str, entries: Sequence[Override]) -> str:
    """Wrap each overridden word in misaki's `[word](/phonemes/)` markup.

    Idempotent: a word already inside override markup is skipped, so a second
    application is a no-op.
    """
    if not entries or not text:
        return text
    out = text
    for entry in entries:
        flags = re.IGNORECASE if entry.ci else 0
        pattern = re.compile(r"(?<![\w/])" + re.escape(entry.match) + r"(?![\w/])", flags)

        def repl(m: "re.Match[str]", entry: Override = entry) -> str:
            start, end = m.start(), m.end()
            src = m.string
            if start > 0 and src[start - 1] == "[":
                return m.group(0)  # already wrapped
            if src[end : end + 2] == "](":
                return m.group(0)
            predicate = _CONDITIONS.get(entry.condition) if entry.condition else None
            if predicate is not None and not predicate(src, m):
                return m.group(0)
            return f"[{m.group(0)}](/{entry.phonemes}/)"

        out = pattern.sub(repl, out)
    return out
