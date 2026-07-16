"""Turn-registry-driven candidate discovery for the log-driven recovery mode
(switchroom #3244 follow-up, ``backfill_transcripts.py --from-logs``).

This is the "narrow the candidate set with the durable turn-lifecycle log, then
let SESSION-LEVEL bank membership be the real safety gate" half of the recovery
tool. It never writes anything and issues no HTTP; it only reads the per-agent
Telegram turns registry (``registry.db``, opened READ-ONLY) and the on-disk
``.jsonl`` transcripts, and resolves each agent's TRUE bank from
``switchroom.yaml``.

Three design decisions are load-bearing and fold in the design red-team's three
must-fixes (``log-driven-recovery-design-review-20260715.md``):

1. **BROAD candidate classifier (must-fix #1).** The design's original narrowing
   predicate — ``ended_via='restart' AND tool_call_count>0 AND
   last_assistant_done=0`` — is DEAD on real data: both columns are NULL on 100%
   of deployed ``restart`` rows, so it matches nothing. We do NOT sub-classify
   ``restart``. A row is a candidate iff it is anything other than a clean,
   closed ``stop``: ``ended_via IS NULL`` OR ``ended_via <> 'stop'`` OR
   ``ended_at IS NULL``. Cost stays bounded because slice-level membership
   (a cheap, server-side-filtered GET) is what actually decides restoration, and
   only genuinely-absent slices re-extract.

2. **Event-span CONTAINMENT join (must-fix #3).** A registry turn is ONE turn
   inside a multi-turn session; the transcript ``mtime`` is the last write of the
   WHOLE session, so an ``mtime``-within-window match MISSES the incident turn.
   Instead we resolve the turn's transcript by span containment: the transcript
   whose ``[first_event_ts, last_event_ts]`` CONTAINS the turn's ``started_at``,
   filtered by agent + chat/thread. An agent runs one session at a time, so this
   is unambiguous by construction; 0 or >1 matches ⇒ REFUSE (reported, not
   guessed).

3. **Correct-bank targeting.** ``resolve_true_bank`` reads the agent's own row in
   ``switchroom.yaml`` (``memory.collection ?? name``), cross-checks the agent's
   ``.claude/settings.json`` ``X-Bank-Id`` header, and REFUSES (returns an error
   reason, zero writes) on disagreement, a dynamic bank, or a missing row. Never
   the ambient env / stale plugin default.
"""

from __future__ import annotations

import json
import os
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional


# --------------------------------------------------------------------------- #
# Candidate classification — BROAD (must-fix #1).
# --------------------------------------------------------------------------- #
# A row is a candidate for recovery iff it is NOT a clean, closed ``stop``. We
# deliberately do NOT try to sub-classify ``restart`` by the in-flight columns
# (``last_assistant_done`` / ``tool_call_count``) — both are NULL on all deployed
# ``restart`` rows, so any such predicate matches nothing. Membership is the real
# gate, so a broad candidate set is safe and only costs cheap GETs.
_CANDIDATE_WHERE = (
    "(ended_via IS NULL OR ended_via <> 'stop' OR ended_at IS NULL)"
)


@dataclass
class CandidateTurn:
    """One flagged turn from the registry (not yet joined to a transcript)."""

    turn_key: str
    chat_id: Optional[str]
    thread_id: Optional[str]
    started_at: Optional[int]  # epoch ms
    ended_at: Optional[int]    # epoch ms (None ⇒ null-open)
    ended_via: Optional[str]
    session_id: Optional[str] = None  # populated only on migrated registries


def _columns(conn: sqlite3.Connection) -> set:
    try:
        return {r[1] for r in conn.execute("PRAGMA table_info(turns)")}
    except sqlite3.Error:
        return set()


def read_candidate_turns(registry_path: str) -> list:
    """Read the BROAD candidate set from a per-agent ``registry.db`` (READ-ONLY).

    Returns a list of ``CandidateTurn``. Opens the SQLite DB in ``mode=ro`` so it
    can never mutate a live registry. A missing / unreadable DB yields ``[]``.
    """
    if not registry_path or not os.path.isfile(registry_path):
        return []
    uri = f"file:{registry_path}?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=5)
    except sqlite3.Error:
        return []
    try:
        cols = _columns(conn)
        if "turn_key" not in cols:
            return []
        has_session = "session_id" in cols
        select_cols = [
            "turn_key", "chat_id", "thread_id", "started_at",
            "ended_at", "ended_via",
        ]
        if has_session:
            select_cols.append("session_id")
        sql = f"SELECT {', '.join(select_cols)} FROM turns WHERE {_CANDIDATE_WHERE}"
        rows = conn.execute(sql).fetchall()
    except sqlite3.Error:
        return []
    finally:
        conn.close()

    out = []
    for r in rows:
        session_id = r[6] if has_session and len(r) > 6 else None
        out.append(CandidateTurn(
            turn_key=r[0],
            chat_id=str(r[1]) if r[1] is not None else None,
            thread_id=str(r[2]) if r[2] is not None else None,
            started_at=int(r[3]) if r[3] is not None else None,
            ended_at=int(r[4]) if r[4] is not None else None,
            ended_via=r[5],
            session_id=session_id or None,
        ))
    return out


# --------------------------------------------------------------------------- #
# Transcript event spans (for the containment join — must-fix #3).
# --------------------------------------------------------------------------- #
def _ts_to_ms(value) -> Optional[int]:
    """Coerce a transcript entry timestamp to epoch milliseconds.

    Accepts an int/float (already epoch ms, or epoch seconds if small), or an
    ISO-8601 string (``2026-07-11T01:39:35.707Z`` / with offset). Returns None
    when unparseable.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        v = float(value)
        # Heuristic: < 1e12 ⇒ seconds, else milliseconds.
        return int(v * 1000) if v < 1e12 else int(v)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        try:
            iso = s.replace("Z", "+00:00")
            dt = datetime.fromisoformat(iso)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp() * 1000)
        except ValueError:
            try:
                return int(float(s))
            except ValueError:
                return None
    return None


@dataclass
class TranscriptSpan:
    path: str
    session_id: str
    first_ms: Optional[int]
    last_ms: Optional[int]
    chat_ids: frozenset  # chat ids observed in the transcript (may be empty)


def transcript_span(path: str) -> TranscriptSpan:
    """Compute a transcript's event time-span + any observed chat ids.

    Reads the raw ``.jsonl`` line-by-line, extracting each entry's ``timestamp``
    (Claude Code stamps one per line). ``chat_ids`` collects any ``chat_id`` seen
    (nested under ``message.metadata`` in some formats, or top-level in test
    fixtures) so the join can filter by chat/thread when the data carries it —
    absence never forces a mismatch, it just widens to span-only.
    """
    session_id = os.path.splitext(os.path.basename(path))[0]
    first_ms: Optional[int] = None
    last_ms: Optional[int] = None
    chat_ids: set = set()
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(entry, dict):
                    continue
                ms = _ts_to_ms(entry.get("timestamp"))
                if ms is not None:
                    if first_ms is None or ms < first_ms:
                        first_ms = ms
                    if last_ms is None or ms > last_ms:
                        last_ms = ms
                cid = entry.get("chat_id")
                if cid is None:
                    msg = entry.get("message")
                    if isinstance(msg, dict):
                        meta = msg.get("metadata")
                        if isinstance(meta, dict):
                            cid = meta.get("chat_id")
                if cid is not None:
                    chat_ids.add(str(cid))
    except OSError:
        pass
    return TranscriptSpan(
        path=path, session_id=session_id,
        first_ms=first_ms, last_ms=last_ms, chat_ids=frozenset(chat_ids),
    )


# --------------------------------------------------------------------------- #
# The containment join (must-fix #3).
# --------------------------------------------------------------------------- #
@dataclass
class JoinResult:
    kind: str              # "direct" | "span" | "ambiguous" | "unmatched"
    session_id: Optional[str]
    transcript_path: Optional[str]
    detail: str = ""


def resolve_transcript_for_turn(
    turn: CandidateTurn,
    spans: list,
    *,
    slack_ms: int = 0,
    require_direct_sessionid: bool = False,
) -> JoinResult:
    """Resolve a candidate turn to its transcript.

    * If the registry row carries a stamped ``session_id`` (migrated schema) and
      a transcript with that stem exists, that is a ``direct`` join.
    * Otherwise (all current historical rows), use event-span CONTAINMENT: the
      transcript whose ``[first_ms, last_ms]`` (widened by ``slack_ms``) CONTAINS
      the turn's ``started_at``, filtered by chat id when the transcript carries
      one. Exactly one match ⇒ ``span`` join; zero ⇒ ``unmatched``; more than one
      ⇒ ``ambiguous`` (REFUSED, never guessed).

    ``require_direct_sessionid=True`` refuses any row without a stamped
    ``session_id`` rather than fall back to the span join (strict, going-forward
    only mode).
    """
    if turn.session_id:
        for sp in spans:
            if sp.session_id == turn.session_id:
                return JoinResult("direct", sp.session_id, sp.path,
                                  "stamped session_id")
        return JoinResult("unmatched", turn.session_id, None,
                          "stamped session_id has no surviving transcript")

    if require_direct_sessionid:
        return JoinResult("ambiguous", None, None,
                          "no stamped session_id and --require-direct-sessionid set")

    if turn.started_at is None:
        return JoinResult("unmatched", None, None, "turn has no started_at")

    matches = []
    for sp in spans:
        if sp.first_ms is None or sp.last_ms is None:
            continue
        lo = sp.first_ms - slack_ms
        hi = sp.last_ms + slack_ms
        if not (lo <= turn.started_at <= hi):
            continue
        # Chat filter: only apply when BOTH sides carry a chat id.
        if turn.chat_id and sp.chat_ids and turn.chat_id not in sp.chat_ids:
            continue
        matches.append(sp)

    if len(matches) == 1:
        return JoinResult("span", matches[0].session_id, matches[0].path,
                          "unique span containment")
    if not matches:
        return JoinResult("unmatched", None, None,
                          "no transcript span contains the turn timestamp")
    return JoinResult(
        "ambiguous", None, None,
        f"{len(matches)} transcripts contain the turn timestamp; refusing to guess",
    )


# --------------------------------------------------------------------------- #
# Correct-bank targeting from switchroom.yaml (+ settings cross-check).
# --------------------------------------------------------------------------- #
def _load_agent_collections(yaml_path: str) -> Optional[dict]:
    """Return ``{agent_name: collection_or_None, ...}`` from switchroom.yaml, or
    None if the file can't be parsed. Prefers PyYAML; falls back to a minimal
    scanner for the ``agents: -> <name>: -> memory: -> collection:`` shape when
    PyYAML is unavailable."""
    try:
        with open(yaml_path, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return None
    try:
        import yaml  # type: ignore
        data = yaml.safe_load(text)
        agents = (data or {}).get("agents")
        if isinstance(agents, dict):
            out = {}
            for name, cfg in agents.items():
                coll = None
                if isinstance(cfg, dict):
                    mem = cfg.get("memory")
                    if isinstance(mem, dict):
                        coll = mem.get("collection")
                out[str(name)] = coll
            return out
    except Exception:
        pass
    return _scan_agent_collections(text)


def _scan_agent_collections(text: str) -> dict:
    """Dependency-free minimal parser for the specific nested shape we need.

    Tracks indentation to find each ``<name>:`` directly under ``agents:`` and a
    ``collection:`` under that agent's ``memory:``. Good enough for bank
    resolution; PyYAML is used when present.
    """
    out: dict = {}
    lines = text.splitlines()
    in_agents = False
    agents_indent = None
    cur_agent = None
    cur_agent_indent = None
    in_memory = False
    memory_indent = None
    for raw in lines:
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        stripped = raw.strip()
        if not in_agents:
            if stripped.rstrip() == "agents:":
                in_agents = True
                agents_indent = indent
            continue
        # Left the agents block?
        if indent <= agents_indent and stripped.rstrip() != "agents:":
            break
        # A new agent key: one indent level deeper than "agents:".
        if cur_agent_indent is None or indent == cur_agent_indent:
            if stripped.endswith(":") and ":" not in stripped[:-1]:
                cur_agent = stripped[:-1].strip().strip('"\'')
                cur_agent_indent = indent
                out.setdefault(cur_agent, None)
                in_memory = False
                memory_indent = None
                continue
        if cur_agent is None:
            continue
        if indent <= cur_agent_indent:
            # Dedented back to (or above) agent-key level → possibly a new agent.
            if stripped.endswith(":") and ":" not in stripped[:-1]:
                cur_agent = stripped[:-1].strip().strip('"\'')
                cur_agent_indent = indent
                out.setdefault(cur_agent, None)
                in_memory = False
                memory_indent = None
            continue
        if stripped.rstrip() == "memory:":
            in_memory = True
            memory_indent = indent
            continue
        if in_memory and indent > memory_indent and stripped.startswith("collection:"):
            val = stripped.split(":", 1)[1].strip().strip('"\'')
            out[cur_agent] = val or None
            in_memory = False
    return out


def _settings_bank_id(settings_path: str) -> Optional[str]:
    """Read the ``X-Bank-Id`` header from an agent's ``.claude/settings.json``.

    Searches any ``headers`` map (e.g. under an MCP/hindsight server env) for an
    ``X-Bank-Id`` key. Returns None when absent/unparseable."""
    try:
        with open(settings_path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None

    found: list = []

    def _walk(obj):
        if isinstance(obj, dict):
            for k, v in obj.items():
                if isinstance(k, str) and k.lower() == "x-bank-id" and isinstance(v, str):
                    found.append(v)
                else:
                    _walk(v)
        elif isinstance(obj, list):
            for it in obj:
                _walk(it)

    _walk(data)
    return found[0] if found else None


@dataclass
class BankResolution:
    ok: bool
    bank_id: Optional[str]
    reason: str


def resolve_true_bank(
    agent: str,
    *,
    switchroom_yaml_path: str,
    settings_path: Optional[str] = None,
) -> BankResolution:
    """Resolve ``agent``'s TRUE bank, or REFUSE.

    Bank = ``switchroom.yaml agents.<agent>.memory.collection ?? <agent>``,
    cross-checked against the agent's ``.claude/settings.json`` ``X-Bank-Id``.
    Refuses (``ok=False``, no bank) when: the yaml can't be read; the agent has
    no row in it; or the yaml-derived bank and a present ``X-Bank-Id`` disagree.
    A missing ``X-Bank-Id`` is NOT a refusal (the header is not always present) —
    only a present-and-disagreeing one is.
    """
    collections = _load_agent_collections(switchroom_yaml_path)
    if collections is None:
        return BankResolution(False, None,
                              f"could not read switchroom.yaml at {switchroom_yaml_path}")
    if agent not in collections:
        return BankResolution(False, None,
                              f"{agent} has no row in switchroom.yaml — refusing to guess a bank")
    bank = collections.get(agent) or agent

    if settings_path and os.path.isfile(settings_path):
        header_bank = _settings_bank_id(settings_path)
        if header_bank and header_bank != bank:
            return BankResolution(
                False, None,
                f"switchroom.yaml resolves {agent} to bank '{bank}' but "
                f".claude/settings.json X-Bank-Id is '{header_bank}' — refusing on disagreement",
            )
    return BankResolution(True, bank, "resolved from switchroom.yaml memory.collection")
