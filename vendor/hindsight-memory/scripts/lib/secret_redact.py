"""Write-path secret redaction for the Hindsight plugin.

WHY THIS EXISTS
---------------
Switchroom ships a secret redactor (``telegram-plugin/secret-detect/``)
that masks credentials before they are persisted to the Telegram message
store, the issues log and hostd output. It is TypeScript, and it never ran
on the path that writes agent MEMORY — every retain in this plugin is
Python, so credentials that appeared in a turn were stored in Hindsight
verbatim.

This module is the Python half of that redactor, wired at the ONE function
every retain in this plugin goes through (``lib/client.py``:
``HindsightClient.retain`` before splitting, plus ``_request`` as a
structural backstop for any future caller that skips ``retain``).

NO FORKED PATTERN LIST
----------------------
The regex table is NOT written here. It is loaded from
``secret_patterns.json``, which is GENERATED from
``telegram-plugin/secret-detect/patterns.ts`` by
``scripts/gen-secret-patterns.ts`` and pinned by the ``bun lint`` guard
``scripts/check-secret-pattern-parity.ts``. A pattern added once therefore
covers the Telegram gate, the issues pipeline AND memory intake.

That byte-compare proves the SOURCES match. It does not prove the
BEHAVIOUR matches — identical regex source means different things to
``re`` and to ``RegExp`` (see the semantics bridge below), which is how
the ``\b``-boundary fork shipped past a green CI in the first place.
Behaviour parity is a separate, weaker guarantee, held up by the shared
vectors in ``secret_redaction_vectors.json`` and by the differential test
``telegram-plugin/tests/secret-detect-cross-engine.test.ts``, which runs
BOTH engines over the same corpus and compares their output.

The three rules that need imperative gates rather than a bare regex —
the KEY=VALUE entropy heuristic, connection-URI credentials and
human-memorable passwords — are ported by hand below and pinned against
their TypeScript counterparts by the shared behaviour vectors in
``secret_redaction_vectors.json`` (asserted by
``scripts/tests/test_secret_redact.py`` here and by
``telegram-plugin/tests/secret-detect-write-path.test.ts`` there).

DELIBERATE DIFFERENCES FROM THE TS ENGINE
-----------------------------------------
* The generic high-entropy fallback is not ported. ``redact()`` in
  TypeScript explicitly filters ``generic_high_entropy`` out before
  masking (it is a low-precision "ask the user" signal, not a mask
  signal), so a redact-only engine has no use for it.
* No 32 KB chunking. The TS engine windows large inputs to bound ReDoS on
  a hot Telegram path; here we scan the whole string, which is strictly
  more coverage, and the patterns are all linear-time shapes.
* The suppressor (test/example/fixture demotion) is not ported: it only
  demotes confidence, and ``redact()`` masks suppressed hits anyway.

FAIL-CLOSED
-----------
If the pattern table is missing or unparseable, ``redact()`` raises at
import time rather than silently becoming a no-op. A redactor that fails
open is worse than no redactor, because callers stop looking.
"""

import json
import math
import os
import re
from typing import Dict, List, Optional, Tuple

REDACTED_MARKER = "[REDACTED]"

_PATTERNS_FILE = os.path.join(os.path.dirname(__file__), "secret_patterns.json")

# ─── JS/Python regex semantics bridge ─────────────────────────────────
#
# The pattern SOURCES are byte-identical across the two engines (that is
# what `check-secret-pattern-parity` proves), but identical source is not
# identical behaviour: `re` and `RegExp` disagree on what the shorthand
# classes MEAN.
#
#   `\b`, `\w`, `\d`, and case-folding under `re.I`
#       Python `str` patterns are UNICODE-aware by default, JavaScript
#       `RegExp` without the `u` flag is ASCII-only. Every anchored rule
#       here is `\b`-delimited, so `sk-ant-...<CJK char>` was a word
#       boundary in JS (masked) and NOT one in Python (stored verbatim).
#       Fixed by compiling with `re.ASCII`.
#
#       Note the flag arithmetic below: `re.UNICODE` is implicit on `str`
#       patterns and `flags | re.ASCII` alone raises
#       `ValueError: ASCII and UNICODE flags are incompatible`.
#
#   `\s` / `\S`
#       This one runs the OTHER way. JavaScript `\s` is Unicode-aware
#       even without the `u` flag (NBSP, ideographic space, BOM all
#       match), so plain `re.ASCII` would narrow Python's `\s` below
#       JS's and re-open the fork on the separator instead of the
#       boundary. `_js_compat_source` therefore rewrites `\s`/`\S` to an
#       explicit class carrying exactly the ECMAScript WhiteSpace +
#       LineTerminator set, so the two agree under `re.ASCII`.
#
# The rewrite happens HERE rather than in the codegen on purpose: keeping
# `secret_patterns.json` a faithful mirror of `patterns.ts` is what makes
# the byte-compare guard readable, and the semantics bridge is a property
# of the Python engine, not of the shared table.

# ECMAScript WhiteSpace + LineTerminator (what JS `\s` matches).
_JS_WS = (
    " \\t\\n\\x0b\\x0c\\r"
    "\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
)


def _js_compat_source(src: str) -> str:
    """Rewrite `\\s`/`\\S` so they mean under `re.ASCII` what they mean to
    a JavaScript `RegExp` without the `u` flag.

    `[\\s\\S]` (the "any character including newlines" idiom) is left
    alone: `\\S` cannot be expressed inside a character class, and the
    union is every character in either engine regardless of flags.
    """
    out: List[str] = []
    i = 0
    n = len(src)
    in_class = False
    while i < n:
        ch = src[i]
        if ch == "\\" and i + 1 < n:
            nxt = src[i + 1]
            if nxt == "s":
                out.append(_JS_WS if in_class else "[" + _JS_WS + "]")
                i += 2
                continue
            if nxt == "S" and not in_class:
                out.append("[^" + _JS_WS + "]")
                i += 2
                continue
            out.append(src[i : i + 2])
            i += 2
            continue
        if ch == "[" and not in_class:
            in_class = True
        elif ch == "]" and in_class:
            in_class = False
        out.append(ch)
        i += 1
    return "".join(out)


def _compile(source: str, flags: int = 0) -> "re.Pattern[str]":
    """Compile with JavaScript-compatible shorthand-class semantics."""
    return re.compile(_js_compat_source(source), flags & ~re.UNICODE | re.ASCII)


def _load_patterns() -> List[dict]:
    with open(_PATTERNS_FILE, "r", encoding="utf-8") as fh:
        doc = json.load(fh)
    patterns = doc.get("patterns")
    if not isinstance(patterns, list) or not patterns:
        raise ValueError(f"{_PATTERNS_FILE} has no patterns array")
    compiled = []
    for p in patterns:
        flags = 0
        if p.get("ignore_case"):
            flags |= re.I
        if p.get("multiline"):
            flags |= re.M
        compiled.append(
            {
                "rule_id": p["rule_id"],
                "regex": _compile(p["source"], flags),
                "capture_index": int(p.get("capture_index", 0)),
            }
        )
    return compiled


_COMPILED_PATTERNS = _load_patterns()

# ─── Gates mirrored from the TypeScript engine ────────────────────────

# index.ts — env_key_value shape gate.
ENV_KV_MIN_LEN = 12
ENV_KV_MIN_ENTROPY = 3.5
# kv-scanner.ts — KV_ENTROPY_THRESHOLD.
KV_ENTROPY_THRESHOLD = 4.0
# kv-scanner.ts — MEMORABLE_PW_MIN_CLASSES.
MEMORABLE_PW_MIN_CLASSES = 2

_KV_RE = _compile(
    r"\b([A-Za-z_][A-Za-z0-9_-]*(?:password|passwd|token|secret|key|api[_-]?key))"
    r"\s*[:=]\s*[\"']?([^\s\"'\\]{8,})[\"']?",
    re.I,
)

_MEMORABLE_PW_RE = _compile(
    r"\b([A-Za-z0-9_-]*(?:password|passwd|passphrase|pwd))\b"
    r"\s*(?:[:=]\s*|\s+is\s+)([\"']?)([^\s\"']{8,64})\2",
    re.I,
)

# `<scheme>://<user>:<password>@<host>` — see db-uri.ts for the shape
# rationale. The password class deliberately ADMITS `@` and stops only at
# an authority terminator (`/`, `?`, `#`, whitespace); greedy matching
# then backs off to the LAST `@`, so an unencoded `@` inside the password
# cannot leave the tail of the password outside the masked span.
_DB_URI_RE = _compile(
    r"\b([a-zA-Z][a-zA-Z0-9+.-]+)://([^\s:/@]+):([^\s/?#]+)@([^\s/@?#]+)"
)

# Placeholders, variable references and already-masked text. Redacting
# these buys nothing and destroys the meaning of the surrounding line —
# and for a `vault:` reference it deletes exactly the key NAME an agent
# is supposed to remember. Mirrors INERT_VALUE_RE in
# telegram-plugin/secret-detect/inert-values.ts.
_INERT_VALUE_RES = [
    _compile(r"^\[REDACTED", re.I),
    _compile(r"^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$"),
    _compile(r"^\{\{[^\n\r\u2028\u2029]*\}\}$"),
    _compile(r"^<[^>]*>$"),
    _compile(r"^%[A-Za-z_][A-Za-z0-9_]*%$"),
    _compile(r"^vault:", re.I),
    _compile(r"^[*x\u2022.]+$", re.I),
    _compile(r"^(?:process\.env|import\.meta\.env|os\.environ)\b"),
    _compile(
        r"^(?:changeme|change-me|replaceme|replace-me|placeholder|todo|tbd"
        r"|yourkey|your-key|yourpassword|your-password|yoursecret|your-secret"
        r"|yourtoken|your-token)(?:[-_][A-Za-z0-9-]+)?$",
        re.I,
    ),
    _compile(r"^[a-z]+(?: [a-z]+){2,}$"),
]

# Trailing punctuation an English sentence puts AFTER a value. The value
# classes are `[^\s"']`-shaped, so a sentence-final `.` or a list comma
# is captured as part of the value; stripping it before the shape gates
# is what keeps "The password is required." out of the redactor.
_TRAILING_PUNCT_RE = re.compile(r"[.,;:!?)\]}]+$")


def _strip_trailing_punctuation(value: str) -> str:
    return _TRAILING_PUNCT_RE.sub("", value)


def is_inert_value(value: str) -> bool:
    return any(r.search(value) for r in _INERT_VALUE_RES)


# Rules whose captured value is a LABELLED slot: an inert placeholder in
# that slot is documentation, not a credential. See MAJOR 5 of the #3982
# review — `POSTGRES_PASSWORD: vault:pg/password` was being destroyed
# while the lowercase spelling of the same line was left alone.
_INERT_GATED_RULES = frozenset({"env_key_value", "json_secret_field", "cli_flag"})

# url-redact.ts — SENSITIVE_PARAMS.
_SENSITIVE_PARAMS = {
    "token",
    "key",
    "api_key",
    "apikey",
    "secret",
    "access_token",
    "password",
    "pass",
    "auth",
    "client_secret",
    "refresh_token",
    "signature",
}

_URL_RE = _compile(r"\b(?:https?|wss?|ftp)://[^\s<>\"']+", re.I)


def shannon_entropy(value: str) -> float:
    """Shannon entropy in bits/char — mirrors secret-detect/entropy.ts."""
    if not value:
        return 0.0
    counts: Dict[str, int] = {}
    for ch in value:
        counts[ch] = counts.get(ch, 0) + 1
    n = len(value)
    total = 0.0
    for c in counts.values():
        p = c / n
        total -= p * math.log2(p)
    return total


def _char_class_count(value: str) -> int:
    n = 0
    if re.search(r"[a-z]", value):
        n += 1
    if re.search(r"[A-Z]", value):
        n += 1
    if re.search(r"[0-9]", value):
        n += 1
    if re.search(r"[^A-Za-z0-9]", value):
        n += 1
    return n


def _looks_like_memorable_password(value: str) -> bool:
    """Port of looksLikeMemorablePassword() in kv-scanner.ts."""
    if is_inert_value(value):
        return False
    core = _strip_trailing_punctuation(value)
    if len(core) < 8 or len(core) > 64:
        return False
    if is_inert_value(core):
        return False
    if len(set(core)) < 4:
        return False
    return _char_class_count(core) >= MEMORABLE_PW_MIN_CLASSES


# ─── URL credential scrub (port of url-redact.ts) ─────────────────────


def _redact_one_url(raw: str) -> Optional[str]:
    """Mask userinfo + sensitive query params in ONE url, or return None
    when nothing changed. Deliberately string-level: unlike the TS side we
    do not round-trip through a URL parser, because Python's urlsplit /
    urlunsplit normalizes in ways WHATWG does not and the two engines must
    agree byte-for-byte on the common shapes.
    """
    changed = False
    scheme_sep = raw.find("://")
    if scheme_sep < 0:
        return None
    rest = raw[scheme_sep + 3 :]
    # Authority runs to the first /, ?, or #.
    auth_end = len(rest)
    for ch in "/?#":
        i = rest.find(ch)
        if i >= 0:
            auth_end = min(auth_end, i)
    authority = rest[:auth_end]
    tail = rest[auth_end:]
    at = authority.rfind("@")
    if at >= 0:
        authority = "***@" + authority[at + 1 :]
        changed = True
    # Sensitive query params.
    if "?" in tail:
        path, _, query_and_frag = tail.partition("?")
        query, hashsep, frag = query_and_frag.partition("#")
        parts = []
        for pair in query.split("&"):
            key, eq, _val = pair.partition("=")
            if eq and key.lower() in _SENSITIVE_PARAMS:
                parts.append(f"{key}=***")
                changed = True
            else:
                parts.append(pair)
        tail = path + "?" + "&".join(parts) + hashsep + frag
    if not changed:
        return None
    return raw[: scheme_sep + 3] + authority + tail


def redact_urls(text: str) -> str:
    def _sub(m: "re.Match[str]") -> str:
        replaced = _redact_one_url(m.group(0))
        return replaced if replaced is not None else m.group(0)

    return _URL_RE.sub(_sub, text)


# ─── Detection ────────────────────────────────────────────────────────


class _Hit:
    __slots__ = ("rule_id", "start", "end")

    def __init__(self, rule_id: str, start: int, end: int) -> None:
        self.rule_id = rule_id
        self.start = start
        self.end = end


def _pattern_hits(text: str) -> List[_Hit]:
    hits: List[_Hit] = []
    for p in _COMPILED_PATTERNS:
        idx = p["capture_index"]
        for m in p["regex"].finditer(text):
            if not m.group(0):
                continue
            cap = m.group(0) if idx == 0 else m.group(idx)
            if not cap:
                continue
            start = m.start(0) if idx == 0 else m.start(idx)
            if start < 0:
                continue
            if p["rule_id"] in _INERT_GATED_RULES and is_inert_value(cap):
                continue
            if p["rule_id"] == "env_key_value":
                if len(cap) < ENV_KV_MIN_LEN:
                    continue
                if shannon_entropy(cap) < ENV_KV_MIN_ENTROPY:
                    continue
            hits.append(_Hit(p["rule_id"], start, start + len(cap)))
    return hits


def _kv_hits(text: str) -> List[_Hit]:
    hits: List[_Hit] = []
    for m in _KV_RE.finditer(text):
        value = m.group(2)
        if not value:
            continue
        # Mirrors scanKeyValue() in kv-scanner.ts — placeholders and code
        # references are not credentials.
        if is_inert_value(value):
            continue
        if shannon_entropy(value) < KV_ENTROPY_THRESHOLD:
            continue
        hits.append(_Hit("kv_entropy", m.start(2), m.end(2)))
    return hits


def _db_uri_hits(text: str) -> List[_Hit]:
    hits: List[_Hit] = []
    for m in _DB_URI_RE.finditer(text):
        password = m.group(3)
        if password.startswith("[REDACTED") or re.fullmatch(
            r"[*x]+", password, re.I | re.A
        ):
            continue
        hits.append(_Hit("db_uri_password", m.start(3), m.end(3)))
    return hits


def _memorable_password_hits(text: str) -> List[_Hit]:
    hits: List[_Hit] = []
    for m in _MEMORABLE_PW_RE.finditer(text):
        value = m.group(3)
        if not value or not _looks_like_memorable_password(value):
            continue
        # The WHOLE captured value is masked, trailing punctuation
        # included: once the gates have decided this is a credential, a
        # trailing `!` is far more likely to be the last byte of the
        # password than the end of a sentence, and losing a period from
        # inside an already-redacted span costs nothing.
        hits.append(_Hit("memorable_password", m.start(3), m.end(3)))
    return hits


def _marker(rule_id: str) -> str:
    """Port of redactedMarker() in redact.ts."""
    trimmed = re.sub(r"^(kv|env)_", "", rule_id)
    if not trimmed or trimmed in ("key_value", "kv_entropy"):
        return REDACTED_MARKER
    return f"[REDACTED:{trimmed}]"


def _resolve(hits: List[_Hit]) -> List[_Hit]:
    """Keep a non-overlapping set, preferring the earliest start and, on a
    tie, the widest span. Overlapping replacements would corrupt offsets;
    the TS engine gets the same effect from dedupeRaw + dropOverlaps.
    """
    ordered = sorted(hits, key=lambda h: (h.start, -(h.end - h.start)))
    kept: List[_Hit] = []
    last_end = -1
    for h in ordered:
        if h.start < last_end:
            continue
        kept.append(h)
        last_end = h.end
    return kept


def redact(text: Optional[str]) -> Optional[str]:
    """Mask every detected secret in ``text``, leaving prose intact.

    Returns the input unchanged when nothing matched. ``None`` and empty
    strings pass through so callers can apply this to optional fields
    without branching.
    """
    if not text:
        return text
    scrubbed = redact_urls(text)
    hits = (
        _pattern_hits(scrubbed)
        + _kv_hits(scrubbed)
        + _db_uri_hits(scrubbed)
        + _memorable_password_hits(scrubbed)
    )
    if not hits:
        return scrubbed
    out = scrubbed
    for h in sorted(_resolve(hits), key=lambda x: x.start, reverse=True):
        out = out[: h.start] + _marker(h.rule_id) + out[h.end :]
    return out


def redact_metadata(value):
    """Recursively redact string leaves of a JSON-shaped metadata value.

    Retain metadata carries free-form provenance (source paths, tool
    names, transcript excerpts on some producers), so it is a real leak
    surface even though the memory ROW is built from ``content``. Keys are
    left alone — they are structural, and rewriting them would break
    consumers that look them up by name.
    """
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, list):
        return [redact_metadata(v) for v in value]
    if isinstance(value, dict):
        return {k: redact_metadata(v) for k, v in value.items()}
    return value


def redact_retain_fields(
    content: Optional[str],
    context: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> Tuple[Optional[str], Optional[str], Optional[dict]]:
    """Redact every free-text field a retain POST carries."""
    return redact(content), redact(context), redact_metadata(metadata)
