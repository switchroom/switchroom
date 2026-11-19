"""Small Linear GraphQL client: rate-limit aware, token-provider driven, client-id creates."""
from __future__ import annotations

import hashlib
import fcntl
import hmac
import json
import logging
import math
import random
import re
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager, nullcontext
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable
from .oauth import ReauthorizationRequired
from . import diag

ENDPOINT = "https://api.linear.app/graphql"
DEFAULT_RATE_LIMIT_PAUSE = 60.0
# Linear (developers/rate-limiting, checked 2026-11): an OAuth app user gets 5,000 requests and
# 2,000,000 complexity points per hour; one query may cost at most 10,000 points. Every client of
# one app user (bridge, chat tools, skills, cron) shares that budget, so the observed headers are
# saved beside the pause. Below OPTIONAL_FLOOR, optional reads (rechecks, sweeps, recovery, history
# paging) wait for the reset; below ESSENTIAL_FLOOR only mutations and essential work (outbox
# delivery, Stop) still go out, so a busy hour never starves the writes people are waiting for.
OPTIONAL_FLOOR, ESSENTIAL_FLOOR = 0.20, 0.05
BUDGETS = ("requests", "complexity")
PRIORITIES = ("optional", "normal", "essential")
LEAN_HISTORY_PAGE = 100  # entries per later IssueHistory page; those pages carry no issue fields
# A status read also shows what people saw from agents in the issue thread: Agent Session
# activities, which are not comments. One nested selection in the same IssueProgress query
# (no extra request) reads the newest ACTIVITY_SESSIONS sessions and their newest ACTIVITY_PAGE
# activities. Prompts are excluded server side: a person's prompt is already their comment.
ACTIVITY_SESSIONS, ACTIVITY_PAGE = 5, 10
ACTIVITY_REFUSAL_PAUSE = 3600.0  # after a definite refusal, plain comment reads for an hour
ACTIVITY_TYPES = ("thought", "response", "action", "error", "elicitation")
_ACTIVITY_BODY = " ".join("... on AgentActivity%sContent { type body }" % kind.capitalize()
                          for kind in ACTIVITY_TYPES if kind != "action")
ACTIVITY_FIELDS = ("agentSessions(first: %d, orderBy: updatedAt) { nodes { id appUser { id name } "
                   "activities(first: %d, filter: { type: { in: [%s] } }) { nodes { id createdAt updatedAt ephemeral "
                   "user { id name } content { %s ... on AgentActivityActionContent { type action parameter result } } } "
                   "pageInfo { hasNextPage } } } pageInfo { hasNextPage } }"
                   % (ACTIVITY_SESSIONS, ACTIVITY_PAGE, ", ".join('"%s"' % kind for kind in ACTIVITY_TYPES), _ACTIVITY_BODY))
# create_issue resolves a named project to its team from one cached directory of the teams and
# active projects this app can see (one request, about 1,400 complexity points per page), reused
# for DIRECTORY_TTL; a miss refetches a directory older than DIRECTORY_MISS_REFRESH once.
DIRECTORY_TTL, DIRECTORY_MISS_REFRESH = 600.0, 60.0
DIRECTORY_PROJECT_PAGES = 3  # 100 projects per page, most recently updated first
DIRECTORY_FIELDS = ("nodes { id name slugId completedAt canceledAt archivedAt teams(first: 10) { nodes { id } } } "
                    "pageInfo { hasNextPage endCursor }")
# An issue named by its title prefix ("QA-10" for "QA-10: list the commits"): one bounded search.
TITLE_SEARCH_PAGE = 25
ISSUE_FIELDS = """id identifier title description url updatedAt completedAt canceledAt creator { id } assignee { id }
  delegate { id name } state { id name type } project { id }
  team { id key states { nodes { id name type position } } }"""

class LinearError(RuntimeError):
    """A Linear request failed. ``retryable`` is False for a definite GraphQL rejection."""
    def __init__(self, message: str, *, errors: Any = None, retryable: bool = True,
                 authoritative_issue_id: str | None = None, authoritative_session_id: str | None = None) -> None:
        super().__init__(message)
        self.errors = errors
        self.retryable = retryable
        self.authoritative_issue_id = authoritative_issue_id
        self.authoritative_session_id = authoritative_session_id

class RateLimited(LinearError):
    def __init__(self, until: float) -> None:
        super().__init__(f"Linear rate limit; paused until {until:.0f}")
        self.until = until

class Throttled(RateLimited):
    """This client chose not to spend scarce budget on a lower-priority request; nothing was sent."""
    def __init__(self, until: float, priority: str) -> None:
        RateLimited.__init__(self, until)
        self.args = (f"Linear budget low; {priority} request deferred until {until:.0f}",)
        self.priority = priority

def backoff_delay(failures: int, *, base: float, cap: float, jitter: float = 0.2,
                  rand: Callable[[], float] = random.random) -> float:
    """Capped exponential delay with +/- jitter, so restarted or parallel callers do not retry in step."""
    delay = min(cap, base * 2 ** max(0, min(failures - 1, 30)))
    return max(0.0, delay * (1 + jitter * (2 * rand() - 1)))

def _require_mutation_success(data: dict[str, Any], mutation: str) -> None:
    result = data.get(mutation)
    success = result.get("success") if isinstance(result, dict) else None
    if success is True:
        return
    if success is False:
        raise LinearError(f"Linear {mutation} rejected the mutation", retryable=False)
    raise LinearError(f"Linear {mutation} response did not confirm success")

def _graphql_rejection(errors: Any, request_kind: str = "graphql", *, expected_missing: bool = False) -> str:
    """Keep bounded, redacted GraphQL detail beside the stable error prefix."""
    parts: list[str] = []
    entries = errors if isinstance(errors, list) else []
    for error in entries[:3]:
        if not isinstance(error, dict):
            continue
        message = error.get("message")
        raw_extensions = error.get("extensions")
        extensions = raw_extensions if isinstance(raw_extensions, dict) else {}
        code = extensions.get("code")
        text = _safe_diagnostic_text(message, 360)
        safe_code = code if isinstance(code, str) and re.fullmatch(r"[A-Z0-9_]{1,80}", code) else ""
        if safe_code == "INPUT_ERROR" and isinstance(message, str) and message.startswith("conflict on insert of"):
            diag.evt("api.result", "deduped", "duplicate_create", code=safe_code)  # idempotent create replay, not an error
        elif expected_missing and isinstance(message, str) and message.startswith("Entity not found"):
            # A lookup the caller expects may miss (a title alias such as "QA-10"); its fallback decides.
            logging.getLogger(diag.LOGGER_NAME).debug("linear: expected miss request_kind=%s message=%s", request_kind, text)
        else:
            logging.getLogger(diag.LOGGER_NAME).error("linear: GraphQL error request_kind=%s message=%s code=%s", request_kind, text, safe_code)
        if text and safe_code:
            parts.append(f"{text} ({safe_code})")
        elif text or safe_code:
            parts.append(text or safe_code)
    if len(entries) > 3:
        parts.append("additional errors omitted")
    return "Linear GraphQL error" + (f": {'; '.join(parts)}" if parts else "")

def _safe_diagnostic_text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    text = re.sub(r"[\r\n\x00-\x1f\x7f]+", " ", value).strip()
    text = re.sub(r"(?i)\bBearer\s+\S+", "Bearer [redacted]", text)
    text = re.sub(r"(?i)\b(?:api[_-]?key|token|secret)\s*[:=]\s*\S+", "[redacted]", text)
    text = re.sub(
        r'''(?i)(["']?(?:access[_-]?token|refresh[_-]?token|token|password|secret|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^"'&\s,}]+''',
        r"\1[redacted]", text)
    text = re.sub(r"(?i)(https?://)[^/@\s]+:[^/@\s]+@", r"\1[redacted]@", text)
    text = text[:limit]
    return re.sub(r"\s+", " ", text)

def is_duplicate_create_error(errors: Any, client_id: str) -> bool:
    """True when Linear rejected a create because an entity with our client ``id`` exists.

    Every create sends the UUID v4 stored with its outbox row, so this means an earlier
    attempt (whose response we lost) already landed. Verified live (plan phase 0) for
    commentCreate and agentActivityCreate: HTTP 200, ``data: null``, code ``INPUT_ERROR``,
    message "conflict on insert of <Entity>", userPresentableMessage naming our id.
    ``INVALID_INPUT`` is a real input error and never matches.
    """
    for error in errors if isinstance(errors, list) else []:
        ext = (error.get("extensions") or {}) if isinstance(error, dict) else {}
        if (ext.get("code") == "INPUT_ERROR" and str(error.get("message", "")).startswith("conflict on insert of")
                and client_id in str(ext.get("userPresentableMessage", ""))):
            return True
    return False

def verify_webhook(secret: bytes, body: bytes, signature: str, now_ms: float, max_skew_ms: int = 60_000) -> bool:
    """HMAC-SHA256 ``linear-signature`` check plus Linear's one-minute ``webhookTimestamp`` window."""
    try:
        supplied = bytes.fromhex(signature)
        stamp = json.loads(body).get("webhookTimestamp")
    except (ValueError, TypeError, AttributeError, UnicodeDecodeError):
        return False
    expected = hmac.new(secret, body, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, supplied):
        return False
    if isinstance(stamp, bool) or not isinstance(stamp, (int, float)) or not math.isfinite(stamp):
        return False
    return abs(now_ms - stamp) <= max_skew_ms

REQUEST_TIMEOUT_SECONDS = 20.0  # One Linear HTTP request; a deadline never starts one it cannot finish.


def _http(url: str, body: bytes, headers: dict[str, str]) -> tuple[int, dict[str, str], bytes]:
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:  # nosec B310: configured https endpoint
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers.items()) if exc.headers else {}, exc.read() or b""

def _bare_host_line_matches(actual: str, expected: str) -> bool:
    """Permit only an observed HTTP autolink added to an expected bare host.

    Be conservative around Markdown syntax: code, escapes, HTML and authored
    links are not candidates. Do not erase links on both sides, which would
    hide a removed authored link or a changed destination.
    """
    prose = re.sub(r'^(?:[ \t]*(?:[-*+]|[0-9]+[.)]) )\[[xX ]\] ', '', expected)
    if expected.startswith(('    ', '\t')) or any(char in prose for char in '`\\[]<>'):
        return False
    hosts = re.finditer(
        r'(?<![\w@./:+%?&=#~-])'
        r'(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}'
        r'(?![\w@/:+%?&=#~-]|\.[\w-])', expected)
    parts, offset = [], 0
    for match in hosts:
        host = re.escape(match.group())
        parts.extend((re.escape(expected[offset:match.start()]),
                      rf'(?:{host}|\[{host}\]\(http://{host}\))'))
        offset = match.end()
    parts.append(re.escape(expected[offset:]))
    return re.fullmatch(''.join(parts), actual) is not None


# Linear's editor stores Markdown through its own serializer: it backslash-escapes punctuation it
# would otherwise read as syntax (``~1.5:1`` comes back as ``\~1.5:1``), writes ``*`` bullets for
# ``-`` and drops trailing spaces and repeated blank lines. Seen live on a chat-created issue,
# 2026-11-02. Outside code these spell the same text, so readback compares them as equal.
# Escapes that change structure stay significant: code ticks, link brackets, HTML angle brackets,
# and a block marker (heading, quote, bullet, ordered item) escaped at the start of a line.
_ESCAPABLE = r'!-/:-@\[-`{-~'
_TEXT_TOKEN = re.compile(r'\\[' + _ESCAPABLE + r']|`+|[^\\`]+|\\')
_STRUCTURAL = frozenset('`[]<>')
_BLOCK_ESCAPE = re.compile(r'^[ \t]*(?:(?:[-*+]|[0-9]+[.)]) +)?(?:\\[#>*+-]|[0-9]+\\[.)])')

def _editor_text(line: str) -> str:
    """Unescape text punctuation outside inline code, normalise the bullet marker, trim the end."""
    out, run = [], None
    block = _BLOCK_ESCAPE.match(line)
    protected = block.end() if block else 0
    offset = 0
    for token in _TEXT_TOKEN.findall(line):
        start, offset = offset, offset + len(token)
        if token.startswith('`'):
            run = len(token) if run is None else (None if len(token) == run else run)
            out.append(token)
        elif (run is None and len(token) == 2 and token[0] == '\\' and token[1] not in _STRUCTURAL
              and start >= protected):
            out.append(token[1])
        else:
            out.append(token)
    text = re.sub(r'^([ \t]*)[*+] ', r'\1- ', ''.join(out))
    # Two or more trailing spaces are a hard line break; any other trailing whitespace is noise.
    return text.rstrip() + ("  " if re.search(r'\S {2,}$', text) else "")

_LIST_START = re.compile(r'(?:[-*+]|1[.)])[ \t]+\S')
_LIST_ITEM = re.compile(r'[ \t]*(?:[-*+]|[0-9]+[.)])(?:[ \t]|$)')
_PARAGRAPH_LINE = re.compile(r'[^\s#>|`~<]')

def markdown_matches(actual: object, expected: str) -> bool:
    """Accept narrow editor rewrites, including bare-host autolinks; preserve code/text."""
    if not isinstance(actual, str):
        return False
    def canonical(text: str) -> list[tuple[str, bool]]:
        lines, result, fence = text.splitlines(), [], None
        after_heading = indented = False
        inline_run, delimiters = None, 0
        for line in lines:
            marker = re.match(r'^\s*(`{3,}|~{3,})', line)
            if marker:
                run = marker.group(1)
                if fence is None: fence = (run[0], len(run))
                elif run[0] == fence[0] and len(run) >= fence[1]: fence = None
                result.append((line, False))
                after_heading = False
                continue
            if fence is not None:
                result.append((line, False))
                continue
            if not line.strip():
                if not indented and (after_heading or not result or not result[-1][0]):
                    continue  # Linear keeps one blank line, none after a heading or at the start
                result.append(("", False))
                continue
            if (len(result) >= 2 and result[-1] == ("", False) and _LIST_START.match(line)
                    and _PARAGRAPH_LINE.match(result[-2][0]) and not _LIST_ITEM.match(result[-2][0])):
                # Linear adds a blank line between a paragraph and the list that follows it (seen
                # live on an agent plan section, 2026-11-19). A bullet list, or one starting at 1,
                # interrupts a paragraph anyway, so both spellings render the same.
                result.pop()
            after_heading = bool(re.match(r'^#{1,6} +', line))
            # A bare-looking host on a later line may still be inside inline
            # code, a link label/destination, or an HTML tag opened earlier.
            prose = inline_run is None and delimiters == 0
            for token in re.findall(r'\\.|`+|[\[\]()<>]', line):
                if token.startswith('\\'):
                    continue
                if token.startswith('`'):
                    if inline_run is None: inline_run = len(token)
                    elif len(token) == inline_run: inline_run = None
                elif inline_run is None:
                    delimiters = max(0, delimiters + (1 if token in '[(<' else -1))
            indented = line.expandtabs(4).startswith('    ')
            if indented:
                result.append((line, False))  # indented code (or a deep list item) stays exact
                continue
            if not (prose and inline_run is None and delimiters == 0) or '`' in line:
                # Inline code, links or HTML: only the editor's text rewrites, and only when the
                # line does not start inside a construct opened on an earlier line.
                result.append((_editor_text(line) if prose else line, False))
                continue
            # Escaped text is never a bare-host autolink candidate.
            prose = '\\' not in line
            line = re.sub(r'^([ \t]*(?:[-*+]|[0-9]+[.)]) )\[X\](?=[ \t]|$)', r'\1[x]', _editor_text(line))
            result.append((re.sub(r'\]\(<((?:[^\s<>()]|\([^\s<>()]*\))+)>\)', r'](\1)', line), prose))
        while fence is None and result and not result[-1][0]:
            result.pop()  # trailing blank lines
        return result
    received, authored = canonical(actual), canonical(expected)
    return len(received) == len(authored) and all(
        line == wanted or ('<' not in expected and prose and expected_prose and _bare_host_line_matches(line, wanted))
        for (line, prose), (wanted, expected_prose) in zip(received, authored))

# Create readback only (never write settlement): two more rewrites Linear's editor makes on save.
# An authored bare URL or host/path comes back autolinked, and bold is split around inline code.
_AUTOLINK = re.compile(r'\[([^\[\]\s`]+)\]\((?:<([^\s<>]+)>|([^\s<>()]+))\)')
_FULL_URL = re.compile(r'https?://[^\s<>]+')
_HOST_PATH = re.compile(r'(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(?:/[^\s<>]*)?')
_CODE_SPAN = re.compile(r'(`+)(.+?)(?<!`)\1(?!`)')

def _outside_code(text: str, rewrite: Callable[[str], str | None]) -> str:
    """Apply ``rewrite`` to each prose line, keeping fenced, indented and inline code exact.

    ``rewrite`` returns None to mean "this line cannot be canonicalised"; the line stays as is.
    """
    out, fence = [], None
    for line in text.split('\n'):
        marker = re.match(r'^\s*(`{3,}|~{3,})', line)
        if marker:
            run = marker.group(1)
            if fence is None: fence = (run[0], len(run))
            elif run[0] == fence[0] and len(run) >= fence[1]: fence = None
            out.append(line)
            continue
        if fence is not None or line.expandtabs(4).startswith('    '):
            out.append(line)
            continue
        rewritten = rewrite(line)
        out.append(line if rewritten is None else rewritten)
    return '\n'.join(out)

def _code_split(line: str) -> list[tuple[str, bool]] | None:
    """Prose and inline-code pieces of one line; None when a backtick run is left open."""
    pieces, offset = [], 0
    for match in _CODE_SPAN.finditer(line):
        pieces += [(line[offset:match.start()], False), (match.group(), True)]
        offset = match.end()
    pieces.append((line[offset:], False))
    return None if any('`' in text for text, code in pieces if not code) else pieces

def _unlink_autolinks(actual: str, expected: str) -> str:
    """Undo Linear's autolink of a token the author wrote bare: ``[T](<T>)`` for a full http(s)
    URL, ``[T](<http://T>)`` for a bare host or host/path. The label and target must be exactly
    the authored token; any other link (changed target, https for http, added path, query,
    fragment or port) is kept and still differs."""
    def bare(token: str) -> bool:
        return re.search(r'(?<![\w\[</:.@-])(?<!\]\()' + re.escape(token) + r'(?![\w/?#&=%~+:@-])(?!\.\w)',
                         expected) is not None
    def unlink(match: re.Match) -> str:
        label, target = match.group(1), match.group(2) or match.group(3)
        if ((_FULL_URL.fullmatch(label) and target == label) or
                (_HOST_PATH.fullmatch(label) and target == 'http://' + label)) and bare(label):
            return label
        return match.group()
    def line_rewrite(line: str) -> str | None:
        pieces = _code_split(line)
        if pieces is None:
            return None
        return ''.join(text if code else _AUTOLINK.sub(unlink, text) for text, code in pieces)
    return _outside_code(actual, line_rewrite)

# An inline link whose label has no emphasis, code or nested brackets of its own.
_PLAIN_LINK = re.compile(r'\[[^\[\]`*\\]+\]\((?:<[^\s<>]+>|[^\s<>()]+)\)')

def _link_split(pieces: list[tuple[str, bool]]) -> list[tuple[str, bool]]:
    """Split prose pieces further so each plain inline link is its own exact unit, like code."""
    out = []
    for text, exact in pieces:
        if exact:
            out.append((text, True))
            continue
        offset = 0
        for match in _PLAIN_LINK.finditer(text):
            out += [(text[offset:match.start()], False), (match.group(), True)]
            offset = match.end()
        out.append((text[offset:], False))
    return out

def _canonical_bold(text: str) -> str:
    """Compare emphasis as which characters are bold, not where ``**`` sits.

    Linear writes ``**a (**`b`**, c**`` for ``**a (`b`, c)**``: the same characters are bold.
    It also closes bold before a link that ends it: ``**see [X](u)** now`` comes back as
    ``**see** [X](u) now`` (seen live on a chat-created issue, 2026-11-19).
    Whitespace, code spans and plain links carry no bold of their own (they take the preceding
    character's). Linear stores bold code alone as plain code (``**`x`**`` comes back `` `x` ``),
    but nothing shows it doing that to a link, so a bold run holding only links and no prose keeps
    their bold: dropping it from ``**[X](u)**`` still differs. Code and links stay byte-exact
    (label and target), and a line with unbalanced, tripled or escaped ``**`` is left exact.
    """
    def line_rewrite(line: str) -> str | None:
        pieces = _code_split(line)
        if pieces is None:
            return None
        pieces = _link_split(pieces)
        prose = [text for text, code in pieces if not code]
        if not any('**' in text for text in prose):
            return line
        if (any('***' in text or re.search(r'\\\*', text) for text in prose)
                or sum(text.count('**') for text in prose) % 2):
            return None
        units, bold = [], False  # [text, bold flag or None for neutral]
        run_links, run_prose = [], False  # link units inside the open bold run; prose seen in it
        for text, code in pieces:
            if code:
                units.append([text, None])
                if bold and text.startswith('['):
                    run_links.append(units[-1])
                continue
            for part in re.split(r'(\*\*)', text):
                if part == '**':
                    if bold and not run_prose:
                        for unit in run_links:
                            unit[1] = True  # a bold run of only links (and code) keeps the links bold
                    bold, run_links, run_prose = not bold, [], False
                else:
                    units.extend([char, None if char.isspace() else bold] for char in part)
                    run_prose = run_prose or (bold and not part.isspace() and part != '')
        flags = [flag for _, flag in units if flag is not None]
        current, out, open_ = flags[0] if flags else False, [], False
        for unit, flag in units:
            current = current if flag is None else flag
            if current != open_:
                out.append('**')
                open_ = current
            out.append(unit)
        return ''.join(out) + ('**' if open_ else '')
    return _outside_code(text, line_rewrite)

def created_markdown_matches(actual: object, expected: str) -> bool:
    """Readback of a just-created description: markdown_matches plus Linear's autolink and bold
    rewrites. Write settlement keeps the stricter markdown_matches."""
    if markdown_matches(actual, expected):
        return True
    if not isinstance(actual, str):
        return False
    return markdown_matches(_canonical_bold(_unlink_autolinks(actual, expected)), _canonical_bold(expected))

# Fields Linear stores as sent. On a same-id replay a difference here means the id was already used
# for something else, not that the editor rewrote it.
_IDENTITY_FIELDS = frozenset({"title", "name", "team", "teams", "project", "parent"})

def _created(entity: dict[str, Any], kind: str, replayed: bool, differs: dict[str, bool]) -> dict[str, Any]:
    """A create Linear accepted under our id is created, even when it stores something differently.

    Refusing it would make a good create look failed and invite a retry under a new id, which is
    the one way to duplicate it. Remaining differences go back to the caller and to the log. The
    exception is an id that already belonged to a different entity: that entity is not the one asked
    for, so the caller is told which one it is and that a new id is needed."""
    fields = sorted(name for name, changed in differs.items() if changed)
    if not fields:
        return entity
    identifier = entity.get("identifier")
    if replayed and _IDENTITY_FIELDS & set(fields):
        diag.evt("content.write", "refused", "id_reused", level=logging.WARNING, kind=f"{kind}_create",
                 iss=str(entity.get("id") or "")[:8] or None,
                 issue=identifier if isinstance(identifier, str) else None)
        named = f" {identifier}" if isinstance(identifier, str) else ""
        raise LinearError(f"This id already belongs to an existing {kind}{named} whose {', '.join(fields)} "
                          f"{'differs' if len(fields) == 1 else 'differ'}, so nothing new was created. If that {kind} is the one meant, use it; "
                          "otherwise create with a new id.", retryable=False)
    diag.evt("content.write", "applied", "readback_differs", level=logging.WARNING, kind=f"{kind}_create",
             iss=str(entity.get("id") or "")[:8] or None,
             issue=identifier if isinstance(identifier, str) else None, fields=",".join(fields))
    return {**entity, "readback_differences": fields}

class LinearAPI:
    """``token`` is the provider interface: a callable returning an access token, with an
    optional ``invalidate()`` that forces a refresh after a 401."""

    def __init__(self, token: Callable[[], str], *, endpoint: str = ENDPOINT,
                 transport: Callable[..., tuple[int, dict[str, str], bytes]] = _http,
                 clock: Callable[[], float] = time.time, rate_limit_path: Path | None = None) -> None:
        self.token = token
        self.endpoint = endpoint
        self.transport = transport
        self.clock = clock
        self.paused_until = 0.0
        self.rate_limit_path = rate_limit_path
        self._request_lock = threading.RLock()
        self._viewer: str | None = None
        self._activities_refused_until = 0.0  # Linear refused the internal Issue.agentSessions selection
        self._mutation_guard = threading.local()
        self._expected_missing = threading.local()
        self._priority = threading.local()
        self._deadline = threading.local()
        self.budget: dict[str, dict[str, float]] = {}
        self._budget_level = "ok"
        self._directory: tuple[float, dict[str, Any]] | None = None
    @contextmanager
    def priority(self, level: str):
        """Mark requests made in this block: optional work yields first when the shared budget runs low."""
        if level not in PRIORITIES: raise ValueError(f"unknown Linear request priority {level!r}")
        previous = getattr(self._priority, "level", None)
        # Nested work keeps the most important caller's priority (a Stop inside a recheck stays essential).
        self._priority.level = level if previous is None else max(previous, level, key=PRIORITIES.index)
        try: yield
        finally: self._priority.level = previous
    @contextmanager
    def optional_work(self):
        """Cap every request in disposable work, even inside essential authorization helpers."""
        previous = getattr(self._priority, "optional_work", False)
        self._priority.optional_work = True
        try:
            if self.clock() < self._pause_state():
                raise RateLimited(self.paused_until)
            self._admit("query OptionalWorkBudget")
            yield
        finally:
            self._priority.optional_work = previous

    @contextmanager
    def deadline(self, seconds: float):
        """Requests made in this block (on this thread) must finish within ``seconds``: a request
        that could not finish in time (each may take REQUEST_TIMEOUT_SECONDS) is not started and
        raises a retryable LinearError instead. A nested block replaces the outer deadline for its
        duration. Used where a caller has promised its own caller an answer in bounded time."""
        previous = getattr(self._deadline, "at", None)
        self._deadline.at = time.monotonic() + max(0.0, float(seconds))
        try: yield
        finally: self._deadline.at = previous
    def _deadline_left(self) -> float | None:
        at = getattr(self._deadline, "at", None)
        if at is None:
            return None
        left = at - time.monotonic()
        if left < REQUEST_TIMEOUT_SECONDS:
            raise LinearError("Linear is answering too slowly to finish this in time")
        return left
    def budget_remaining(self) -> tuple[float, float]:
        """(lowest remaining fraction across Linear's hourly budgets, when that budget resets)."""
        now, fraction, reset = self.clock(), 1.0, 0.0
        for observed in self.budget.values():
            limit, remaining, until = observed.get("limit", 0), observed.get("remaining", 0), observed.get("reset", 0)
            if limit > 0 and until > now and remaining / limit < fraction:
                fraction, reset = remaining / limit, until
        return fraction, reset
    def _admit(self, query: str) -> None:
        level = ("optional" if getattr(self._priority, "optional_work", False)
                 else getattr(self._priority, "level", None) or "normal")
        fraction, reset = self.budget_remaining()
        mutation = query.lstrip().startswith("mutation")
        if (level == "optional" and fraction < OPTIONAL_FLOOR) or (
                fraction < ESSENTIAL_FLOOR and level != "essential" and not mutation):
            raise Throttled(reset, level)
    def _observe_budget(self, headers: dict[str, str]) -> dict[str, dict[str, float]]:
        now, seen = self.clock(), {}
        for name in BUDGETS:
            try:
                remaining = float(headers["x-ratelimit-%s-remaining" % name])
                limit = float(headers["x-ratelimit-%s-limit" % name])
                reset = float(headers["x-ratelimit-%s-reset" % name]) / 1000.0
            except (KeyError, ValueError, TypeError):
                continue
            if all(math.isfinite(value) for value in (remaining, limit, reset)) and limit > 0:
                seen[name] = {"remaining": max(0.0, remaining), "limit": limit, "reset": reset, "at": now}
        return seen
    def _merge_budget(self, saved: Any) -> None:
        for name in BUDGETS:
            entry = saved.get(name) if isinstance(saved, dict) else None
            try:
                entry = {key: float(entry[key]) for key in ("remaining", "limit", "reset", "at")}
            except (KeyError, ValueError, TypeError):
                continue
            if all(math.isfinite(value) for value in entry.values()) and \
                    entry["at"] >= self.budget.get(name, {}).get("at", -math.inf):
                self.budget[name] = entry
    def _report_budget(self) -> None:
        fraction, reset = self.budget_remaining()
        level = "essential-only" if fraction < ESSENTIAL_FLOOR else "optional-paused" if fraction < OPTIONAL_FLOOR else "ok"
        if level != self._budget_level:
            log = logging.getLogger(diag.LOGGER_NAME)
            report = log.info if level == "ok" else log.warning
            report("linear: shared request budget %s (%.0f%% left until %.0f)", level, fraction * 100, reset)
            self._budget_level = level
    @contextmanager
    def expected_missing(self):
        """Reads in this block may legitimately find nothing: "Entity not found" logs at DEBUG, not ERROR."""
        previous = getattr(self._expected_missing, "on", False)
        self._expected_missing.on = True
        try: yield
        finally: self._expected_missing.on = previous
    @contextmanager
    def guarded_mutation(self, guard):
        previous = getattr(self._mutation_guard, "callback", None)
        self._mutation_guard.callback = guard
        try: yield
        finally: self._mutation_guard.callback = previous
    def _pause_state(self, until: float = 0.0, budget: dict[str, dict[str, float]] | None = None) -> float:
        """Retain the longest cooldown and the newest budget headers in this profile across clients and restarts."""
        self.paused_until = max(self.paused_until, until)
        if budget: self._merge_budget(budget)
        if self.rate_limit_path is None: return self.paused_until
        try:
            self.rate_limit_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with self.rate_limit_path.open("a+", encoding="utf-8") as handle:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                handle.seek(0)
                raw = handle.read()
                try:
                    state = json.loads(raw) if raw else {}
                    saved = float(state["paused_until"]) if raw else 0.0
                    if not math.isfinite(saved): raise ValueError("invalid cooldown")
                except (ValueError, TypeError, KeyError):
                    state, saved = {}, self.clock() + DEFAULT_RATE_LIMIT_PAUSE
                self.paused_until = max(self.paused_until, saved)
                self._merge_budget(state.get("budget") if isinstance(state, dict) else None)
                handle.seek(0)
                handle.truncate()
                json.dump({"paused_until": self.paused_until, **({"budget": self.budget} if self.budget else {})}, handle)
        except OSError:
            raise LinearError("Linear rate-limit state unavailable") from None
        return self.paused_until
    def _pause(self, headers: dict[str, str], *, limited: bool = True) -> float:
        """Linear signals a limit with RATELIMITED; its reset headers are epoch milliseconds."""
        now, resets, exhausted = self.clock(), [], []
        headers = {name.lower(): value for name, value in headers.items()}
        for prefix in ("x-ratelimit-requests", "x-ratelimit-complexity", "x-ratelimit-endpoint-requests"):
            try: empty = float(headers.get(prefix + "-remaining", "nan")) <= 0
            except (ValueError, TypeError): empty = False
            if empty: exhausted.append(prefix)
        budget = self._observe_budget(headers)
        if not limited and not exhausted:
            if budget:
                self._pause_state(budget=budget)
                self._report_budget()
            return self.paused_until
        for prefix in exhausted or ("x-ratelimit-requests", "x-ratelimit-complexity", "x-ratelimit-endpoint-requests"):
            value = headers.get(prefix + "-reset")
            if value is not None:
                try:
                    reset = float(value) / 1000.0
                    if math.isfinite(reset) and reset > now: resets.append(reset)
                except (ValueError, TypeError):
                    continue
        if limited and "retry-after" in headers:
            try:
                value = headers["retry-after"]
                try: retry = now + float(value)
                except ValueError: retry = parsedate_to_datetime(value).timestamp()
                if math.isfinite(retry) and retry > now: resets.append(retry)
            except (ValueError, TypeError, OverflowError): pass
        return self._pause_state(max(resets) if resets else now + DEFAULT_RATE_LIMIT_PAUSE, budget)
    def graphql(self, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._graphql(query, variables)
    def _graphql(self, query: str, variables: dict[str, Any] | None = None, *,
                 token_provider: Callable[[], str] | None = None,
                 verify_credential: Callable[[Callable[[], str]], tuple[Callable[[], str], str]] | None = None) -> dict[str, Any]:
        with diag.api_time():  # The reporting tick reports this apart from its local work.
            left = self._deadline_left()
            if left is None:
                with self._request_lock:
                    return self._request(query, variables, token_provider=token_provider, verify_credential=verify_credential)
            if not self._request_lock.acquire(timeout=max(0.0, left - REQUEST_TIMEOUT_SECONDS)):
                raise LinearError("Linear is answering too slowly to finish this in time")
            try:
                return self._request(query, variables, token_provider=token_provider, verify_credential=verify_credential)
            finally:
                self._request_lock.release()
    def _request(self, query, variables, *, token_provider, verify_credential):
        if self.clock() < self._pause_state():
            raise RateLimited(self.paused_until)
        self._admit(query)
        body = json.dumps({"query": query, "variables": variables or {}}).encode()
        guard = getattr(self._mutation_guard, "callback", None) if query.lstrip().startswith("mutation") else None
        for attempt in (1, 2):
            provider = token_provider if token_provider is not None else self.token
            credential = None
            if verify_credential is not None:
                provider, credential = verify_credential(provider)
            if self.clock() < self.paused_until:
                raise RateLimited(self.paused_until)
            self._deadline_left()  # A credential refresh retry is a second request: it must fit too.
            try:
                headers = {"Content-Type": "application/json",
                           "Authorization": "Bearer " + (credential if credential is not None else provider())}
            except Exception as exc:  # noqa: BLE001 - credential providers may include secrets in errors
                logging.getLogger(diag.LOGGER_NAME).error("linear: credentials unavailable")
                if isinstance(exc, ReauthorizationRequired):
                    raise LinearError("Linear credentials unavailable") from exc
                raise LinearError("Linear credentials unavailable") from None
            try:
                diag.api_sent()
                with guard() if guard else nullcontext():
                    status, response_headers, raw = self.transport(self.endpoint, body, headers)
            except (OSError, TimeoutError) as exc:
                category = "network error" if isinstance(exc, TimeoutError) else "OS error"
                raise LinearError(f"Linear unreachable ({category})") from None
            try:
                payload = json.loads(raw or b"{}")
            except ValueError:
                payload = {}
            errors = payload.get("errors") if isinstance(payload, dict) else None
            codes = [e["extensions"].get("code") for e in errors or []
                     if isinstance(e, dict) and isinstance(e.get("extensions"), dict)]
            if status == 429 or "RATELIMITED" in codes:
                rejected = getattr(guard, "rejected", None) if guard is not None else None
                no_effect_data = not (isinstance(payload, dict) and payload.get("data"))
                definite = no_effect_data and (status == 429 or (
                    isinstance(errors, list) and len(codes) == len(errors) and
                    all(code == "RATELIMITED" for code in codes)))
                if definite and callable(rejected):
                    rejected()  # Release only this rejected attempt, never an earlier unknown send.
                raise RateLimited(self._pause(response_headers))
            self._pause(response_headers, limited=False)
            if status == 401:
                self._credential_rejected()
            rejected = getattr(guard, "rejected", None) if guard is not None else None
            if status == 401 and callable(rejected):
                # False means this project-update create was already started or is a
                # prepared legacy create. Other guarded mutations do not install this
                # callback, so their 401 still refreshes credentials and retries once.
                if rejected() is False:
                    break
            refresh_provider = provider if token_provider is not None or verify_credential is not None else self.token
            if status == 401 and attempt == 1 and callable(getattr(refresh_provider, "invalidate", None)):
                refresh_provider.invalidate()
                continue
            break
        if status >= 500 or status in (401, 408):
            raise LinearError(f"Linear HTTP {status}")
        if status == 403:
            raise LinearError("Linear refused this app (HTTP 403); check its scopes", retryable=False)
        if errors:
            request_kind = "mutation" if query.lstrip().startswith("mutation") else "query"
            duplicate_check = request_kind == "mutation" and "mutation Create(" in query
            raise LinearError(_graphql_rejection(errors, request_kind,
                                                 expected_missing=getattr(self._expected_missing, "on", False)),
                              errors=errors if duplicate_check or query.startswith("query OutboundAgentActivity(") else None, retryable=False)
        if status >= 400 or not isinstance(payload, dict) or not isinstance(payload.get("data"), dict):
            raise LinearError(f"Linear HTTP {status}", retryable=status < 400 or status >= 500)
        return payload["data"]
    def _credential_rejected(self) -> None:
        """Linear refused the credential (HTTP 401); subclasses drop anything cached for it."""
    def viewer_id(self) -> str:
        if self._viewer is not None:
            return self._viewer
        viewer = self.graphql("query Viewer { viewer { id } }").get("viewer")
        candidate = viewer.get("id") if isinstance(viewer, dict) else None
        if not isinstance(candidate, str) or not candidate:
            raise LinearError("Linear viewer identity response is missing an id")
        self._viewer = candidate
        return candidate
    def issue(self, ref: str) -> dict[str, Any]:
        data = self.graphql(f"query Issue($id: String!) {{ issue(id: $id) {{ {ISSUE_FIELDS} }} }}", {"id": ref})
        if not data.get("issue"):
            raise LinearError(f"Linear issue {ref} not found", retryable=False)
        return data["issue"]
    def issue_with_thread(self, issue_id: str, limit: int = 50, *, progress: bool = False,
                          activities: bool = False) -> tuple[dict[str, Any], list[dict[str, str]]]:
        """Read one bounded page; ordinary threads retain creation-time chronology.

        ``activities`` (progress reads only) adds the bounded Agent Session selection to the same
        query; read it with ``agent_activities(issue)``. Linear marks ``Issue.agentSessions``
        internal, so a definite rejection of the combined read retries once without it (comments
        must not be lost to it); when that plain read succeeds, this client stops asking for
        ACTIVITY_REFUSAL_PAUSE seconds. The issue then carries no ``agentSessions``."""
        operation = "IssueProgress" if progress else "IssueThread"
        order = "updatedAt" if progress else "createdAt"
        updated = " updatedAt" if progress else ""
        page = " pageInfo { hasNextPage }" if progress else ""
        def read(extra: str) -> dict[str, Any]:
            return self.graphql("query %s($id: String!) { issue(id: $id) { %s comments(first: %d, orderBy: %s) "
                                "{ nodes { id url body createdAt%s user { id name } botActor { name } }%s }%s } }"
                                % (operation, ISSUE_FIELDS, limit, order, updated, page, extra), {"id": issue_id})
        if activities and progress and self.clock() >= self._activities_refused_until:
            try:
                data = read(" " + ACTIVITY_FIELDS)
            except LinearError as exc:
                if exc.retryable or isinstance(exc, RateLimited):
                    raise
                data = read("")  # A refusal that also refuses the plain read propagates unchanged.
                self._activities_refused_until = self.clock() + ACTIVITY_REFUSAL_PAUSE
                logging.getLogger(diag.LOGGER_NAME).warning(
                    "linear: agent session activities refused on issue reads; showing comments only for %.0fs",
                    ACTIVITY_REFUSAL_PAUSE)
        else:
            data = read("")
        if not data.get("issue"):
            raise LinearError(f"Linear issue {issue_id} not found", retryable=False)
        nodes = (data["issue"].get("comments") or {}).get("nodes") or []
        comments = []
        for node in nodes:
            if not isinstance(node, dict):
                continue
            created = str(node.get("createdAt") or "")
            comment = {"id": str(node.get("id") or ""), "url": str(node.get("url") or ""),
                       "at": created, "body": str(node.get("body") or ""),
                       "user_id": (node.get("user") or {}).get("id"),
                       "who": str((node.get("user") or node.get("botActor") or {}).get("name") or "unknown")}
            if progress:
                comment.update(created_at=created, updated_at=str(node.get("updatedAt") or ""))
                comment["at"] = comment["updated_at"] or created
            comments.append(comment)
        # Linear's first page is newest first for the selected order. Only
        # ordinary worker threads need their existing oldest-first presentation.
        return data["issue"], comments if progress else sorted(comments, key=lambda comment: comment["at"])
    @staticmethod
    def agent_activities(issue: dict[str, Any]) -> tuple[list[dict[str, Any]], bool] | None:
        """The user-visible Agent Session activities in one issue read, newest first per session.

        None when the read carried no activity selection. ``complete`` is False when Linear has
        more sessions or older activities than the bounded selection. An ephemeral activity is
        shown by Linear only until the next one replaces it, so only a session's newest survives."""
        sessions = issue.get("agentSessions") if isinstance(issue, dict) else None
        if not isinstance(sessions, dict) or not isinstance(sessions.get("nodes"), list):
            return None
        complete = (sessions.get("pageInfo") or {}).get("hasNextPage") is False
        found: list[dict[str, Any]] = []
        for session in sessions["nodes"]:
            if not isinstance(session, dict):
                continue
            page = session.get("activities")
            if not isinstance(page, dict) or not isinstance(page.get("nodes"), list):
                complete = False
                continue
            complete = complete and (page.get("pageInfo") or {}).get("hasNextPage") is False
            app = session.get("appUser") if isinstance(session.get("appUser"), dict) else {}
            nodes = [node for node in page["nodes"] if isinstance(node, dict)]
            newest = max((str(node.get("createdAt") or "") for node in nodes), default="")
            for node in nodes:
                content = node.get("content") if isinstance(node.get("content"), dict) else {}
                created = str(node.get("createdAt") or "")
                if content.get("type") not in ACTIVITY_TYPES or (node.get("ephemeral") and created != newest):
                    continue
                user = node.get("user") if isinstance(node.get("user"), dict) else {}
                found.append({"id": str(node.get("id") or ""), "session_id": str(session.get("id") or ""),
                              "at": created, "created_at": created, "updated_at": str(node.get("updatedAt") or created),
                              "type": str(content["type"]), "ephemeral": bool(node.get("ephemeral")),
                              "content": {key: str(content.get(key) or "")
                                          for key in ("type", "body", "action", "parameter", "result")},
                              "user_id": user.get("id"),
                              "who": str(app.get("name") or user.get("name") or "unknown")})
        return found, complete
    def routing_history(self, issue_id: str, limit: int = 50, after: str | None = None) -> tuple[list[dict[str, Any]], str | None]:
        """One newest-first IssueHistory page: who changed state, assignee or delegate, and when.

        Returns the page and the cursor of the next (older) page, or None at the end."""
        lean = after is not None
        return self._routing_history(issue_id, max(limit, LEAN_HISTORY_PAGE) if lean else limit, after, lean=lean)[1:]
    def _routing_history(self, issue_id: str, limit: int, after: str | None = None, *,
                         lean: bool = False) -> tuple[dict[str, Any], list[dict[str, Any]], str | None]:
        """``lean`` pages (a later page of a scan whose first page was read in full) ask only for history."""
        data = self.graphql("query IssueRoutingHistory($id: String!, $after: String) { issue(id: $id) { %s "
                            "history(first: %d, after: $after) "
                            "{ nodes { createdAt actorId fromStateId toStateId fromAssigneeId toAssigneeId "
                            "fromDelegate { id } toDelegate { id } } pageInfo { hasNextPage endCursor } } } }"
                            % ("id" if lean else ISSUE_FIELDS, limit), {"id": issue_id, "after": after})
        issue = data.get("issue")
        history = (issue or {}).get("history")
        if not isinstance(history, dict) or not isinstance(history.get("nodes"), list):
            raise LinearError(f"Linear issue {issue_id} history unavailable")
        nodes = [node for node in history["nodes"] if isinstance(node, dict)]
        page = history.get("pageInfo") or {}
        if not page.get("hasNextPage"):
            return issue, nodes, None
        cursor = page.get("endCursor")
        if not isinstance(cursor, str) or not cursor:
            raise LinearError(f"Linear issue {issue_id} history page has no cursor")
        return issue, nodes, cursor
    def issue_thread(self, issue_id: str, limit: int = 50) -> list[dict[str, str]]:
        return self.issue_with_thread(issue_id, limit)[1]
    def delegated_started_issues(self, delegate_id: str, *, after: str | None = None,
                                 limit: int = 50) -> tuple[list[dict[str, Any]], str | None]:
        """One page of issues delegated to ``delegate_id`` in a started state; the next cursor or None."""
        data = self.graphql("query DelegatedStarted($delegate: ID!, $after: String) { issues(first: %d, after: $after, "
                            "filter: { delegate: { id: { eq: $delegate } }, state: { type: { eq: \"started\" } } }) "
                            "{ nodes { %s } pageInfo { hasNextPage endCursor } } }" % (limit, ISSUE_FIELDS),
                            {"delegate": delegate_id, "after": after})
        issues = data.get("issues")
        if not isinstance(issues, dict) or not isinstance(issues.get("nodes"), list):
            raise LinearError("Linear delegated issue listing unavailable")
        page = issues.get("pageInfo") or {}
        cursor = page.get("endCursor") if page.get("hasNextPage") else None
        return [node for node in issues["nodes"] if isinstance(node, dict)], cursor if isinstance(cursor, str) and cursor else None
    def update_issue(self, issue_id: str, fields: dict[str, Any]) -> dict[str, Any] | None:
        data = self.graphql("mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) "
                            "{ issueUpdate(id: $id, input: $input) { success issue { " + ISSUE_FIELDS + " } } }",
                            {"id": issue_id, "input": fields})
        _require_mutation_success(data, "issueUpdate")
        issue = data["issueUpdate"].get("issue")
        return issue if isinstance(issue, dict) else None
    def replace_description(self, issue_id: str, expected: str, body: str) -> None:
        current = self.issue(issue_id)
        if current.get("id") != issue_id:
            raise LinearError("Description target could not be verified", retryable=False)
        if markdown_matches(current.get("description"), body):
            return  # same-id readback reconciliation; never overwrite a concurrent change
        if current.get("description") != expected:
            raise LinearError("Description changed or could not be verified; no replacement made", retryable=False)
        # This is an optimistic preflight, not a server-side CAS: a concurrent
        # edit between this read and mutation can still be overwritten.
        self.update_issue(issue_id, {"description": body})
        verified = self.issue(issue_id)
        if verified.get("id") != issue_id or not markdown_matches(verified.get("description"), body):
            raise LinearError("Description replacement could not be verified; reconcile before retrying")
    def verify_comment(self, comment_id: str, issue_id: str, body: str) -> bool:
        data = self.graphql("query CommentReadback($id: String!) { comment(id: $id) { id body issue { id } } }",
                            {"id": comment_id})
        comment = data.get("comment")
        return bool(isinstance(comment, dict) and comment.get("id") == comment_id and
                    markdown_matches(comment.get("body"), body) and isinstance(comment.get("issue"), dict) and
                    comment["issue"].get("id") == issue_id)
    def verify_completion_comment(self, comment_id: str, issue_id: str, body: str) -> bool:
        """Closing proof must be an ordinary top-level comment written by this app."""
        data = self.graphql("query CompletionCommentReadback($id: String!) { comment(id: $id) { "
                            "id body parent { id } user { id } issue { id } } }", {"id": comment_id})
        comment = data.get("comment")
        return bool(isinstance(comment, dict) and comment.get("id") == comment_id and
                    markdown_matches(comment.get("body"), body) and isinstance(comment.get("issue"), dict) and
                    comment["issue"].get("id") == issue_id and
                    "parent" in comment and comment["parent"] is None and
                    isinstance(comment.get("user"), dict) and comment["user"].get("id") == self.viewer_id())

    def _create(self, mutation: str, input_type: str, fields: dict[str, Any]) -> bool:
        try:
            data = self.graphql(f"mutation Create($input: {input_type}!) {{ {mutation}(input: $input) {{ success }} }}",
                                {"input": fields})
            _require_mutation_success(data, mutation)
        except LinearError as exc:
            if not is_duplicate_create_error(exc.errors, fields["id"]):
                raise
            return True  # an entity with this id already existed
        return False
    def _read_created(self, query: str, key: str, client_id: str) -> dict[str, Any]:
        """Read a create back by its id. Any failure here follows an accepted create, so it is retryable
        under the same id (which cannot duplicate it) and never a reason to pick a new one."""
        try:
            entity = self.graphql(query, {"id": client_id}).get(key)
        except RateLimited:
            raise  # keeps its pause; the create itself already landed under this id
        except LinearError as exc:
            raise LinearError(f"Linear accepted the {key} but it could not be read back yet; "
                              "retry with the same id and content") from exc
        if not isinstance(entity, dict) or entity.get("id") != client_id:
            raise LinearError(f"Linear accepted the {key} but it could not be read back yet; "
                              "retry with the same id and content")
        return entity
    def agent_session(self, session_id: str) -> dict[str, Any]:
        raise LinearError("Agent Session authorization requires a bound specialist client", retryable=False)
    def agent_activity(self, activity_id: str, session_id: str) -> dict[str, Any]:
        raise LinearError("Agent Activity authorization requires a bound specialist client", retryable=False)
    def outbound_activity(self, activity_id: str, session_id: str, issue_id: str) -> dict[str, Any] | None:
        """Read only an activity authored by this app, for uncertain conversation settlement."""
        session = self.agent_session(session_id)
        if session["issue"]["id"] != issue_id:
            raise LinearError("Outbound activity session changed its issue", retryable=False)
        query = ("query OutboundAgentActivity($id: String!) { agentActivity(id: $id) { id user { id } "
                 "agentSession { id } content { __typename ... on AgentActivityResponseContent { body } "
                 "... on AgentActivityThoughtContent { body } ... on AgentActivityElicitationContent { body } "
                 "... on AgentActivityActionContent { action parameter result } "
                 "... on AgentActivityErrorContent { body } } } }")
        try:
            with self.expected_missing():
                data = self.graphql(query, {"id": activity_id})
        except LinearError as exc:
            errors = exc.errors
            if (isinstance(errors, list) and len(errors) == 1 and isinstance(errors[0], dict)
                    and errors[0].get("message") == "Entity not found: AgentActivity"
                    and (errors[0].get("extensions") or {}).get("code") == "INPUT_ERROR"):
                return None
            raise
        if "agentActivity" not in data:
            raise LinearError("Outbound activity readback is incomplete")
        activity = data["agentActivity"]
        if activity is None:
            return None
        if (not isinstance(activity, dict) or activity.get("id") != activity_id or
                (activity.get("user") or {}).get("id") != self.viewer_id() or
                (activity.get("agentSession") or {}).get("id") != session_id):
            raise LinearError("Outbound activity identity does not match this app and session", retryable=False)
        content = activity.get("content") or {}
        if content.get("__typename") == "AgentActivityActionContent":
            if not all(isinstance(content.get(key), str) for key in ("action", "parameter")):
                raise LinearError("Outbound action content could not be verified", retryable=False)
            return {"type": "action", "action": content["action"], "parameter": content["parameter"],
                    **({"result": content["result"]} if content.get("result") is not None else {})}
        kind = {"AgentActivityResponseContent": "response", "AgentActivityThoughtContent": "thought",
                "AgentActivityElicitationContent": "elicitation", "AgentActivityErrorContent": "error"}.get(content.get("__typename"))
        if kind is None or not isinstance(content.get("body"), str):
            raise LinearError("Outbound conversation content could not be verified", retryable=False)
        return {"type": kind, "body": content["body"]}

    def question_precedes_answer(self, question_id: str, answer_id: str, session_id: str, actor_id: str, *,
                                 question_actor_id: str | None = None) -> bool:
        """Compare the provider's immutable creation times for these exact two activities."""
        from datetime import datetime
        self.agent_session(session_id)
        fields = "{ id createdAt user { id } agentSession { id } }"
        data = self.graphql("query AgentAnswerChronology($question: String!, $answer: String!) { "
            "question: agentActivity(id: $question) " + fields +
            " answer: agentActivity(id: $answer) " + fields + " }",
            {"question": question_id, "answer": answer_id})
        stamps = []
        for label, identity, actor in (("question", question_id, question_actor_id or self.viewer_id()),
                                       ("answer", answer_id, actor_id)):
            activity = data.get(label)
            if (not isinstance(activity, dict) or activity.get("id") != identity or
                    (activity.get("user") or {}).get("id") != actor or
                    (activity.get("agentSession") or {}).get("id") != session_id):
                raise LinearError("Linear question/answer chronology could not be verified")
            try:
                stamp = datetime.fromisoformat(activity["createdAt"].replace("Z", "+00:00"))
                if stamp.tzinfo is None:
                    raise ValueError("missing timezone")
            except (KeyError, TypeError, AttributeError, ValueError):
                raise LinearError("Linear question/answer creation time is unavailable") from None
            stamps.append(stamp)
        return stamps[0] < stamps[1]

    def create_comment(self, client_id: str, issue_id: str, body: str) -> None:
        self._create("commentCreate", "CommentCreateInput", {"id": client_id, "issueId": issue_id, "body": body})
    def create_activity(self, client_id: str, session_id: str, content: dict[str, Any], *,
                        issue_id: str | None = None, ephemeral: bool = False,
                        signal: str | None = None, signal_metadata: dict[str, Any] | None = None) -> None:
        fields = {"id": client_id, "agentSessionId": session_id, "content": content}
        if ephemeral:
            if content.get("type") not in ("thought", "action"):
                raise LinearError("only a thought or action activity can be ephemeral", retryable=False)
            fields["ephemeral"] = True
        if signal is not None:
            # Linear's ``select`` offers options on a question; the person's pick comes back as a prompt.
            if signal != "select" or content.get("type") != "elicitation":
                raise LinearError("only an elicitation can carry the select signal", retryable=False)
            fields["signal"] = signal
            if signal_metadata is not None:
                fields["signalMetadata"] = signal_metadata
        self._create("agentActivityCreate", "AgentActivityCreateInput", fields)
    def create_project_update(self, client_id: str, project_id: str, body: str, *,
                              issue_ids: list[str] | None = None) -> None:
        # Agent updates report finished issues without Linear's automatic project-progress diff,
        # which reads as "Status: Backlog, 0% -> 100%" beside them. Health is left to Linear and the
        # people who set it, so an agent update never overrides a human "at risk".
        self._create("projectUpdateCreate", "ProjectUpdateCreateInput",
                     {"id": client_id, "projectId": project_id, "body": body, "isDiffHidden": True})
    def create_issue(self, client_id: str, team_id: str, title: str, *, description: str | None = None,
                     project_id: str | None = None, parent_id: str | None = None) -> dict[str, Any]:
        """Create an issue as the authenticated app. Never assigns or delegates."""
        fields = {"id": client_id, "teamId": team_id, "title": title, "assigneeId": None, "delegateId": None}
        fields.update({key: value for key, value in (
            ("description", description), ("projectId", project_id), ("parentId", parent_id)) if value is not None})
        replayed = self._create("issueCreate", "IssueCreateInput", fields)
        issue = self._read_created(
            "query CreatedIssue($id: String!) { issue(id: $id) { id identifier title description url "
            "team { id key } project { id } parent { id } assignee { id } delegate { id } } }", "issue", client_id)
        team, project, parent = (issue.get(key) or {} for key in ("team", "project", "parent"))
        return _created(issue, "issue", replayed, {
            "title": issue.get("title") != title,
            "team": team_id not in {team.get("id"), team.get("key")},
            "description": description is not None and not created_markdown_matches(issue.get("description"), description),
            "assignee": issue.get("assignee") is not None, "delegate": issue.get("delegate") is not None,
            "project": project_id is not None and project.get("id") != project_id,
            "parent": parent_id is not None and parent.get("id") != parent_id})
    def team_projects(self, team_id: str) -> list[dict[str, str]]:
        """Active (not completed, canceled or archived) projects of one team, as id and name."""
        data = self.graphql("query TeamProjects($id: String!) { team(id: $id) { id projects(first: 100) "
                            "{ nodes { id name completedAt canceledAt archivedAt } } } }", {"id": team_id})
        nodes = (((data.get("team") or {}).get("projects") or {}).get("nodes")
                 if isinstance(data.get("team"), dict) else None)
        if not isinstance(nodes, list):
            raise LinearError(f"Linear team {team_id} projects unavailable")
        return [{"id": node["id"], "name": node["name"]} for node in nodes
                if isinstance(node, dict) and isinstance(node.get("id"), str) and isinstance(node.get("name"), str)
                and not (node.get("completedAt") or node.get("canceledAt") or node.get("archivedAt"))]
    def workspace_directory(self, *, max_age: float = DIRECTORY_TTL) -> dict[str, Any]:
        """Teams and active projects this app can see, cached for ``max_age`` seconds.

        ``{"teams": [{id, key, name}], "projects": [{id, name, slug, team_ids}], "complete": bool}``;
        complete is False when either listing had more pages than were read."""
        cached = self._directory
        if cached is not None and self.clock() - cached[0] < max_age:
            return cached[1]
        data = self.graphql("query LinearDirectory { teams(first: 100) { nodes { id key name } pageInfo { hasNextPage } } "
                            "projects(first: 100, orderBy: updatedAt) { %s } }" % DIRECTORY_FIELDS)
        teams_page, projects_page = data.get("teams"), data.get("projects")
        if (not isinstance(teams_page, dict) or not isinstance(teams_page.get("nodes"), list)
                or not isinstance(projects_page, dict)):
            raise LinearError("Linear team and project directory unavailable")
        teams = [{"id": node["id"], "key": node["key"], "name": node.get("name") if isinstance(node.get("name"), str) else ""}
                 for node in teams_page["nodes"] if isinstance(node, dict)
                 and isinstance(node.get("id"), str) and isinstance(node.get("key"), str)]
        complete = (teams_page.get("pageInfo") or {}).get("hasNextPage") is False
        projects: list[dict[str, Any]] = []
        for page_number in range(DIRECTORY_PROJECT_PAGES):
            nodes = projects_page.get("nodes")
            if not isinstance(nodes, list):
                raise LinearError("Linear team and project directory unavailable")
            for node in nodes:
                if (not isinstance(node, dict) or not isinstance(node.get("id"), str) or not isinstance(node.get("name"), str)
                        or node.get("completedAt") or node.get("canceledAt") or node.get("archivedAt")):
                    continue
                team_nodes = (node.get("teams") or {}).get("nodes") if isinstance(node.get("teams"), dict) else None
                projects.append({"id": node["id"], "name": node["name"],
                                 "slug": node.get("slugId") if isinstance(node.get("slugId"), str) else "",
                                 "team_ids": [team["id"] for team in team_nodes or []
                                              if isinstance(team, dict) and isinstance(team.get("id"), str)]})
            info = projects_page.get("pageInfo") or {}
            cursor = info.get("endCursor")
            if info.get("hasNextPage") is not True:
                break
            if page_number + 1 == DIRECTORY_PROJECT_PAGES or not isinstance(cursor, str) or not cursor:
                complete = False
                break
            projects_page = self.graphql("query LinearDirectoryProjects($after: String) { projects(first: 100, "
                                         "after: $after, orderBy: updatedAt) { %s } }" % DIRECTORY_FIELDS,
                                         {"after": cursor}).get("projects")
            if not isinstance(projects_page, dict):
                raise LinearError("Linear team and project directory unavailable")
        directory = {"teams": teams, "projects": projects, "complete": complete}
        self._directory = (self.clock(), directory)
        return directory
    def issues_by_title(self, text: str) -> tuple[list[dict[str, Any]], bool]:
        """(recent issues whose title starts with ``text`` ignoring case, newest update first; more may exist).

        One bounded page; "more" is True when Linear has another page or the page is full."""
        data = self.graphql("query IssueTitleSearch($q: String!) { issues(first: %d, orderBy: updatedAt, "
                            "filter: { title: { startsWithIgnoreCase: $q } }) { nodes { id identifier title updatedAt "
                            "state { name type } team { id key } project { id } } pageInfo { hasNextPage } } }"
                            % TITLE_SEARCH_PAGE, {"q": text})
        issues = data.get("issues")
        if not isinstance(issues, dict) or not isinstance(issues.get("nodes"), list):
            raise LinearError("Linear issue search unavailable")
        more = (issues.get("pageInfo") or {}).get("hasNextPage") is not False or len(issues["nodes"]) >= TITLE_SEARCH_PAGE
        return [node for node in issues["nodes"] if isinstance(node, dict) and isinstance(node.get("identifier"), str)
                and isinstance(node.get("title"), str)], more
    def create_project(self, client_id: str, name: str, team_ids: list[str], *,
                       description: str | None = None) -> dict[str, Any]:
        """Create a project as the authenticated app. Never sets a lead."""
        fields: dict[str, Any] = {"id": client_id, "name": name, "teamIds": list(team_ids), "leadId": None}
        if description is not None:
            fields["description"] = description
        replayed = self._create("projectCreate", "ProjectCreateInput", fields)
        self._directory = None  # the new project must resolve by name on the next create_issue
        project = self._read_created(
            "query CreatedProject($id: String!) { project(id: $id) { id name url lead { id } teams { nodes { id key } } } }",
            "project", client_id)
        teams = {node.get("id") for node in (project.get("teams") or {}).get("nodes") or []}
        return _created(project, "project", replayed, {"name": project.get("name") != name,
                                             "lead": project.get("lead") is not None,
                                             "teams": not set(team_ids) <= teams})
    def link_issue(self, issue_id: str, related_issue_id: str, relation: str) -> dict[str, Any]:
        """Link two issues. ``blocked_by`` records the related issue as the blocker."""
        if relation not in {"blocks", "blocked_by", "related"}:
            raise LinearError("issue link relation must be blocks, blocked_by, or related", retryable=False)
        if relation == "blocked_by":
            issue_id, related_issue_id, kind = related_issue_id, issue_id, "blocks"
        else:
            kind = relation
        data = self.graphql(
            "mutation IssueRelationCreate($input: IssueRelationCreateInput!) "
            "{ issueRelationCreate(input: $input) { success issueRelation "
            "{ id type issue { id } relatedIssue { id } } } }",
            {"input": {"issueId": issue_id, "relatedIssueId": related_issue_id, "type": kind}})
        _require_mutation_success(data, "issueRelationCreate")
        relation_row = (data.get("issueRelationCreate") or {}).get("issueRelation") or {}
        if (relation_row.get("type") != kind or (relation_row.get("issue") or {}).get("id") != issue_id
                or (relation_row.get("relatedIssue") or {}).get("id") != related_issue_id):
            raise LinearError("Linear issue link readback does not match the create", retryable=False)
        return relation_row
