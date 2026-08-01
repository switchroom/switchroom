#!/usr/bin/env python3
"""One-time backfill of transcript work already missing from Hindsight banks.

switchroom #3244 Part 2 (design-20260715.md). Recovers work an abrupt session
death silently dropped BEFORE the forward fix (PR1) shipped — e.g. clerk's
2026-07-11 planner sessions whose Stop-hook retains were discarded and never
reconciled. This is a standalone, operator-run CLI, NOT runtime code: it scans
every agent's on-disk ``.jsonl`` transcripts (which survive every kind of
death) and re-POSTs anything missing from the bank, paced and resumable.

**Reuse, not fork (design Part 2).** It imports PR1's seams verbatim — the
deterministic content-derived ``document_id`` (``retain.slice_document_id`` via
``build_retain_payload``), the durable watermark, the shared inflight pacing
lock, and the pending-retains layout. The backfill is "run the boot reconciler
over ALL history for ALL agents, paced, resumable, with a dry-run."

Guarantees, all resting on daemon contracts CONFIRMED against hindsight
v0.18.24 (daemon-contract-20260715.md):

* **Dedup by deterministic document_id + daemon UPSERT — ACROSS BACKFILL
  RE-RUNS.** Every slice is posted under ``{session_id}-r{start_uuid}-{end_uuid}``
  — a pure function of *which turns* it holds. The daemon UPSERTs on
  ``(id, bank_id)`` (``ops_postgresql.py:63-69`` ``ON CONFLICT DO UPDATE``;
  full-replace of derived memories, ``fact_storage.py:334-360``) and
  short-circuits an identical re-post on ``content_hash``. So two backfill runs
  over the same transcript **with the same ``slice_turns``** compute identical
  ids and upsert to ONE document. NOTE — these ids do **NOT** converge with the
  live/boot path's ids: the live path slices a *sliding* ``retainEveryNTurns``+
  overlap window (``retain.py:130-136``) while the backfill slices *non-
  overlapping* ``slice_turns`` (default 40) chunks, so the boundary uuids differ
  and the daemon CANNOT upsert one against the other. The backfill is kept
  duplicate-free **not** by id-convergence with the live path but by the
  **total-loss gate** (§ classification below — it only ever re-posts sessions
  the live path wrote *nothing* for) plus advancing the watermark after commit.
  Do NOT remove the total-loss gate believing upsert will dedup live-vs-backfill
  — it will not.
* **Never-storm pacing (HARD).** Strictly serial — one ``client.retain()`` in
  flight at a time, fleet-wide, via PR1's shared ``retain-inflight.lock``
  (acquired blocking around every POST) plus a backfill-only ``backfill.lock``
  "one backfill process at a time" mutex. A deterministic ~1.5s inter-POST
  delay, exponential backoff (cap 60s) + a circuit-breaker cooldown on repeated
  failure, and session-granular slicing bound the downstream LLM extractor.
  Every POST uses ``async_processing=False`` (commit-before-ack) so each write
  is durably confirmed before the next is issued.
* **Dry-run is the DEFAULT and is genuinely ZERO-write.** Without ``--commit``
  the tool calls ONLY ``build_retain_payload`` (network-free, mission-write-
  free by contract) and reports what it WOULD recover: zero retain POSTs, zero
  ``set_bank_mission`` PATCHes. An operator reviews the blast radius before
  committing per agent.
* **Resumable.** Per-``(agent, session)`` progress in
  ``~/.hindsight/backfill-progress.json`` (advanced to ``done`` only after ALL
  of a session's slices are confirmed persisted). Kill it anywhere and re-run:
  completed sessions are skipped, an in-progress session re-does its current
  slices (safe upsert), no duplicates.

Classification & guards (design Part 2 dedup redesign + PR3248 review F1/F3):

* **Dynamic-bank agent** ⇒ **REFUSED (warn + skip, no writes).** Its bank is
  composed from ``project``/``channel``/``user`` (bank.py), none recoverable
  from a transcript scan, so backfilling would write to the WRONG bank. Only
  static-bank agents are eligible (F1).
* **Active / recently-written session** (transcript mtime within
  ``--min-idle-s``, default 1h) ⇒ **SKIPPED.** An in-flight session may have no
  watermark yet; re-posting non-overlapping slices while the live path writes
  sliding-window slices would duplicate the same turns under different ids the
  daemon can't upsert away (F3).
* **No live watermark, idle session** ⇒ true-total-loss (the clerk case) —
  post it in full. RESIDUAL (F3, narrow): a *closed* session whose live retain
  landed but whose best-effort watermark WRITE failed has a bank doc and no
  watermark; it is indistinguishable from total-loss without a per-document
  existence query (which the vendored client lacks) and would be re-posted. The
  ``--min-idle-s`` gate does not close this; it is a rare, documented residual.
* **Has a live watermark** ⇒ partially retained by the live path, whose slice
  boundaries differ from the backfill's, so an id-collision is not guaranteed.
  The vendored client exposes no per-document existence query, so the
  conservative default is to **SKIP and report for manual review** rather than
  risk a partial-overlap duplicate. Consequence: a permanently-closed partial
  session's lost TAIL is not recovered by backfill (only the live path + boot
  reconcile cover it) — surfaced in the report, not silently dropped.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time
from typing import Callable, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib import watermark
from lib.bank import derive_bank_id
from lib.client import HindsightClient
from lib.config import debug_log, load_config
from lib.content import _is_tool_result_only_user_message
from lib.daemon import get_api_url
from lib.pacing import inflight_lock
from lib.turnlog import (
    read_candidate_turns,
    resolve_transcript_for_turn,
    resolve_true_bank,
    transcript_span,
)
from retain import build_retain_payload, read_transcript

# Injectable sleep so tests assert pacing via a fake clock, not wall time.
_SLEEP: Callable[[float], None] = time.sleep


# --------------------------------------------------------------------------- #
# Config knobs (env-overridable, mirroring the HINDSIGHT_DRAIN_* convention).
# --------------------------------------------------------------------------- #
def _delay_ms(override: Optional[int] = None) -> float:
    if override is not None:
        return max(0, override)
    try:
        return max(0, int(os.environ.get("HINDSIGHT_BACKFILL_DELAY_MS", "1500")))
    except ValueError:
        return 1500


def _slice_turns(override: Optional[int] = None) -> int:
    if override is not None:
        return max(1, override)
    try:
        return max(1, int(os.environ.get("HINDSIGHT_BACKFILL_SLICE_TURNS", "40")))
    except ValueError:
        return 40


def _cooldown_s() -> float:
    try:
        return max(1.0, float(os.environ.get("HINDSIGHT_BACKFILL_COOLDOWN_S", "120")))
    except ValueError:
        return 120.0


def _min_idle_s(override: Optional[int] = None) -> float:
    """A session whose transcript was modified more recently than this is treated
    as ACTIVE / in-flight and is NEVER backfilled (F3): an active session may have
    no watermark yet, so classifying it total-loss and re-posting non-overlapping
    slices would duplicate turns the live path is concurrently writing. Default
    1h; override with ``--min-idle-s`` / ``HINDSIGHT_BACKFILL_MIN_IDLE_S``."""
    if override is not None:
        return max(0, override)
    try:
        return max(0.0, float(os.environ.get("HINDSIGHT_BACKFILL_MIN_IDLE_S", "3600")))
    except ValueError:
        return 3600.0


def _window_slack_s(override: Optional[int] = None) -> float:
    """Slack (seconds) added to each side of a transcript's event span when
    resolving the historical span-containment join (turnlog #3). Default 120s;
    override with ``--window-slack-s`` / ``HINDSIGHT_BACKFILL_WINDOW_SLACK_S``."""
    if override is not None:
        return max(0, override)
    try:
        return max(0.0, float(os.environ.get("HINDSIGHT_BACKFILL_WINDOW_SLACK_S", "120")))
    except ValueError:
        return 120.0


def _switchroom_yaml_path(agents_root: str) -> str:
    """Path to switchroom.yaml. Override with ``HINDSIGHT_SWITCHROOM_YAML``;
    otherwise the sibling of the agents root (``~/.switchroom/switchroom.yaml``)."""
    override = os.environ.get("HINDSIGHT_SWITCHROOM_YAML")
    if override:
        return override
    return os.path.join(os.path.dirname(os.path.normpath(agents_root)), "switchroom.yaml")


def _registry_tmpl(agents_root: str) -> str:
    """Template (with ``{agent}``) for a per-agent turns registry. Override with
    ``HINDSIGHT_REGISTRY_TMPL``; default ``<agents>/{agent}/telegram/registry.db``."""
    override = os.environ.get("HINDSIGHT_REGISTRY_TMPL")
    if override:
        return override
    return os.path.join(agents_root, "{agent}", "telegram", "registry.db")


def _is_dynamic_bank(config: dict) -> bool:
    """True when the loaded config resolves banks dynamically (per project /
    channel / user). A transcript scan cannot reliably reconstruct such a bank
    (F1): ``cwd`` is unknown at backfill time so ``project`` → ``unknown`` and
    ``channel``/``user`` fall back to the operator's env — the recovered memory
    would land in the WRONG bank. Such agents are refused (warn + skip)."""
    return bool(config.get("dynamicBankId", False))


_STALL_THRESHOLD = 3          # consecutive failures → circuit-breaker cooldown
_BACKOFF_CAP_S = 60.0         # exponential backoff ceiling
_POST_MAX_ATTEMPTS = 3        # bounded per-slice retry before giving up (#3291)


def agents_dir() -> str:
    """Root holding every agent's scaffold. Override with ``HINDSIGHT_AGENTS_DIR``."""
    override = os.environ.get("HINDSIGHT_AGENTS_DIR")
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".switchroom", "agents")


# --------------------------------------------------------------------------- #
# Resumable per-(agent, session) progress store.
# --------------------------------------------------------------------------- #
def progress_path() -> str:
    """Path of the backfill progress JSON. Override with ``HINDSIGHT_BACKFILL_PROGRESS``."""
    override = os.environ.get("HINDSIGHT_BACKFILL_PROGRESS")
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".hindsight", "backfill-progress.json")


class Progress:
    """Small atomic JSON store: ``{"<agent>/<session>": {"status": ...}}``.

    ``status`` ∈ {``done``, ``skipped_partial``, ``failed``}. Only ``done`` is a
    resume-skip; a re-run retries ``failed``/``skipped_partial`` sessions.
    """

    def __init__(self, path: Optional[str] = None):
        self.path = path or progress_path()
        self._data: dict = {}
        self._load()

    # Reserved (non-session) key holding id-affecting run params. Cannot collide
    # with an "<agent>/<session>" key.
    PARAMS_KEY = "__backfill_params__"

    @staticmethod
    def _key(agent: str, session: str) -> str:
        return f"{agent}/{session}"

    def recorded_slice_turns(self) -> Optional[int]:
        entry = self._data.get(self.PARAMS_KEY)
        if isinstance(entry, dict):
            val = entry.get("slice_turns")
            return int(val) if isinstance(val, int) else None
        return None

    def ensure_slice_turns(self, slice_turns: int) -> None:
        """Persist the run's ``slice_turns`` on first commit, and REFUSE to
        resume with a different value (F2).

        A different ``slice_turns`` re-slices at new boundaries → new
        ``document_id``s → the already-committed run-1 slices orphan as
        duplicates (the daemon can't upsert them away). Raises ``ValueError`` on
        mismatch so the caller aborts before writing anything new.
        """
        recorded = self.recorded_slice_turns()
        if recorded is None:
            self._data[self.PARAMS_KEY] = {"slice_turns": int(slice_turns)}
            self._flush()
            return
        if recorded != int(slice_turns):
            raise ValueError(
                f"backfill-progress.json was written with slice_turns={recorded}, "
                f"but this run requested slice_turns={slice_turns}. Resuming with a "
                f"different slice size would orphan the already-committed slices as "
                f"duplicates. Re-run with --slice-turns {recorded}, or start a fresh "
                f"backfill (new --backfill-progress path / clear the progress file)."
            )

    def _load(self) -> None:
        try:
            with open(self.path, encoding="utf-8") as f:
                loaded = json.load(f)
                if isinstance(loaded, dict):
                    self._data = loaded
        except (OSError, json.JSONDecodeError):
            self._data = {}

    def status(self, agent: str, session: str) -> Optional[str]:
        entry = self._data.get(self._key(agent, session))
        return entry.get("status") if isinstance(entry, dict) else None

    def is_done(self, agent: str, session: str) -> bool:
        return self.status(agent, session) == "done"

    def record(self, agent: str, session: str, status: str, **extra) -> None:
        self._data[self._key(agent, session)] = {
            "agent": agent,
            "session": session,
            "status": status,
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            **extra,
        }
        self._flush()

    def _flush(self) -> None:
        d = os.path.dirname(self.path)
        try:
            if d and not os.path.isdir(d):
                os.makedirs(d, mode=0o700, exist_ok=True)
        except OSError:
            return
        tmp = self.path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._data, f, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# Transcript chunking — forward, deterministic, human-turn bounded.
# --------------------------------------------------------------------------- #
def _human_turn_indices(messages: list) -> list:
    return [
        i
        for i, m in enumerate(messages)
        if isinstance(m, dict) and m.get("role") == "user" and not _is_tool_result_only_user_message(m)
    ]


def chunk_by_human_turns(messages: list, turns: int) -> list:
    """Partition ``messages`` into consecutive slices of up to ``turns`` human
    turns each, on user-message boundaries.

    Forward (oldest-first) and deterministic: re-running produces identical
    slices ⇒ identical ``document_id``s ⇒ clean upsert / resume. Leading
    non-human prelude before the first human turn is dropped (the live path
    counts human turns too). Each slice runs from its first human turn up to
    just before the next chunk's first human turn, so trailing assistant/tool
    messages travel with their turn.
    """
    idx = _human_turn_indices(messages)
    if not idx:
        return []
    slices = []
    for start in range(0, len(idx), turns):
        s = idx[start]
        end_h = start + turns
        e = idx[end_h] if end_h < len(idx) else len(messages)
        slice_msgs = messages[s:e]
        if slice_msgs:
            slices.append(slice_msgs)
    return slices


def _session_id_from_path(path: str) -> str:
    return os.path.splitext(os.path.basename(path))[0]


def _resolve_bank_id(agent: str, session_id: str, config: dict) -> str:
    synthetic_hook = {"session_id": session_id, "cwd": ""}
    cfg = dict(config)
    cfg.setdefault("agentName", agent)
    if config.get("dynamicBankId"):
        cfg["agentName"] = agent
    return derive_bank_id(synthetic_hook, cfg)


# --------------------------------------------------------------------------- #
# The backfill.
# --------------------------------------------------------------------------- #
class Backfill:
    def __init__(
        self,
        config: dict,
        *,
        commit: bool = False,
        delay_ms: Optional[int] = None,
        slice_turns: Optional[int] = None,
        max_per_min: Optional[int] = None,
        agents_root: Optional[str] = None,
        min_idle_s: Optional[int] = None,
        client: Optional[HindsightClient] = None,
        progress: Optional[Progress] = None,
        from_logs: bool = False,
        switchroom_yaml: Optional[str] = None,
        registry_tmpl: Optional[str] = None,
        window_slack_s: Optional[int] = None,
        require_direct_sessionid: bool = False,
    ):
        self.config = config
        self.commit = commit
        self.delay_s = _delay_ms(delay_ms) / 1000.0
        self.slice_turns = _slice_turns(slice_turns)
        self.max_per_min = max_per_min
        self.agents_root = agents_root or agents_dir()
        self.min_idle_s = _min_idle_s(min_idle_s)
        self.dynamic_bank = _is_dynamic_bank(config)
        # --from-logs (log-driven recovery) wiring.
        self.from_logs = from_logs
        self.switchroom_yaml = switchroom_yaml or _switchroom_yaml_path(self.agents_root)
        self.registry_tmpl = registry_tmpl or _registry_tmpl(self.agents_root)
        self.window_slack_ms = int(_window_slack_s(window_slack_s) * 1000)
        self.require_direct_sessionid = require_direct_sessionid
        self.client = client
        self.progress = progress or Progress()
        self._api_url = None
        self._api_token = config.get("hindsightApiToken")
        # Pacing / breaker state.
        self._posted_count = 0
        self._consecutive_failures = 0
        self._post_times: list = []  # monotonic timestamps for --max-per-min
        # Per-agent + rollup report.
        self.report: dict = {"agents": {}, "rollup": {}}

    # -- daemon wiring ------------------------------------------------------ #
    def _ensure_client(self) -> Optional[HindsightClient]:
        if self.client is not None:
            if self._api_url is None:
                self._api_url = "http://backfill-client"
            return self.client
        if self._api_url is None:
            try:
                self._api_url = get_api_url(
                    self.config, debug_fn=lambda *a: debug_log(self.config, *a),
                    allow_daemon_start=False,
                )
            except (RuntimeError, ValueError) as e:
                debug_log(self.config, f"backfill: daemon unavailable: {e}")
                return None
            self.client = HindsightClient(
                self._api_url,
                self._api_token,
                request_timeout_override=self.config.get("requestTimeoutSeconds"),
            )
        return self.client

    # -- pacing ------------------------------------------------------------- #
    def _pace_before_post(self) -> None:
        """Deterministic inter-POST delay + optional hard rate cap. First POST
        of the run is not delayed."""
        if self._posted_count > 0 and self.delay_s > 0:
            _SLEEP(self.delay_s)
        if self.max_per_min:
            now = time.monotonic()
            self._post_times = [t for t in self._post_times if now - t < 60.0]
            if len(self._post_times) >= self.max_per_min:
                oldest = self._post_times[0]
                wait = 60.0 - (now - oldest)
                if wait > 0:
                    _SLEEP(wait)

    def _on_failure(self) -> None:
        """Exponential backoff + circuit-breaker cooldown on repeated failure."""
        self._consecutive_failures += 1
        backoff = min(self.delay_s * (2 ** self._consecutive_failures), _BACKOFF_CAP_S)
        _SLEEP(backoff)
        if self._consecutive_failures >= _STALL_THRESHOLD:
            debug_log(self.config, "backfill: circuit-breaker tripped, cooling down")
            _SLEEP(_cooldown_s())
            self._consecutive_failures = 0

    def _post_slice(self, bank_id: str, built: dict) -> bool:
        """Serial, paced, confirmed POST of one slice with bounded retry.

        Returns True on confirmed persistence, False after exhausting
        ``_POST_MAX_ATTEMPTS`` transient failures. NEVER concurrent — one in
        flight fleet-wide via the shared inflight lock.

        The bounded retry (#3291) matters because every POST is
        ``async_processing=False`` (commit-before-ack): a slice that lands is
        durable immediately, so a *single*-attempt failure on slice ``k`` used to
        strand slices ``0..k-1`` as a committed prefix while the session was
        marked ``failed`` and — via the session-membership skip — never revisited.
        Retrying each slice in place lets a transient blip resolve without leaving
        that partial-commit gap. Persistent failure still returns False so the
        caller records ``failed`` and the gap-completion path (routed from the
        progress record, not the membership skip) fills the remainder on re-run."""
        client = self._ensure_client()
        if client is None:
            return False
        payload = built["payload"]
        self._pace_before_post()
        last_exc = None
        for _attempt in range(_POST_MAX_ATTEMPTS):
            with inflight_lock(blocking=True) as acquired:
                if not acquired:  # pragma: no cover - blocking acquire fails open
                    return False
                try:
                    client.retain(
                        bank_id=bank_id,
                        content=payload["content"],
                        document_id=built["document_id"],
                        context=payload["context"],
                        metadata=payload["metadata"],
                        tags=payload["tags"],
                        timeout=15,
                        async_processing=False,  # commit-before-ack (daemon contract 2)
                        observation_scopes=payload.get("observation_scopes"),
                    )
                except Exception as e:
                    last_exc = e
                    debug_log(self.config, f"backfill: POST failed for {built['document_id']}: {e}")
                    self._posted_count += 1
                    self._on_failure()  # backoff before the next attempt
                    continue
            self._posted_count += 1
            self._post_times.append(time.monotonic())
            self._consecutive_failures = 0
            return True
        debug_log(
            self.config,
            f"backfill: POST gave up for {built['document_id']} after "
            f"{_POST_MAX_ATTEMPTS} attempts: {last_exc}",
        )
        return False

    # -- scanning ----------------------------------------------------------- #
    def _list_agents(self, agent_filter: Optional[set]) -> list:
        try:
            names = sorted(
                n for n in os.listdir(self.agents_root)
                if os.path.isdir(os.path.join(self.agents_root, n))
            )
        except OSError:
            return []
        if agent_filter:
            names = [n for n in names if n in agent_filter]
        return names

    def _agent_transcripts(self, agent: str) -> list:
        base = os.path.join(self.agents_root, agent, ".claude", "projects")
        paths = sorted(glob.glob(os.path.join(base, "**", "*.jsonl"), recursive=True))
        seen = set()
        return [p for p in paths if not (p in seen or seen.add(p))]

    def _agent_report(self, agent: str) -> dict:
        return self.report["agents"].setdefault(agent, {
            "bank_id": None,
            "dynamic_bank_skipped": False,
            "sessions_scanned": 0,
            "sessions_total_loss": 0,
            "sessions_partial_skipped": 0,
            "sessions_active_skipped": 0,
            "sessions_already_done": 0,
            "turns_recovered": 0,
            "slices": 0,
            "posts_ok": 0,
            "posts_failed": 0,
            "sessions": [],
        })

    def _registry_path(self, agent: str) -> str:
        return self.registry_tmpl.replace("{agent}", agent)

    def _settings_path(self, agent: str) -> str:
        return os.path.join(self.agents_root, agent, ".claude", "settings.json")

    def run(self, agent_filter: Optional[set] = None) -> dict:
        # F2: on a commit run, pin the id-affecting slice_turns; refuse to resume
        # a progress file written with a different value (raises ValueError).
        if self.commit:
            self.progress.ensure_slice_turns(self.slice_turns)
        self.report["mode"] = "from_logs" if self.from_logs else "watermark"
        for agent in self._list_agents(agent_filter):
            if self.from_logs:
                self._backfill_agent_from_logs(agent)
            else:
                self._backfill_agent(agent)
        if self.from_logs:
            self._finalize_report_from_logs()
        else:
            self._finalize_report()
        return self.report

    def _backfill_agent(self, agent: str) -> None:
        ar = self._agent_report(agent)

        # F1: a dynamic-bank agent's bank cannot be reconstructed from a
        # transcript scan (cwd/channel/user are unknown at backfill time), so we
        # REFUSE it entirely rather than write recovered memory to a guessed
        # WRONG bank. Warn loudly, count, and skip — never post.
        if self.dynamic_bank:
            ar["dynamic_bank_skipped"] = True
            debug_log(self.config,
                      f"backfill: REFUSING dynamic-bank agent {agent} — bank cannot be "
                      f"reliably reconstructed from a transcript scan; skipping.")
            print(f"[Hindsight] backfill: WARNING — {agent} is dynamic-bank; refusing to "
                  f"guess its bank. Skipped (no writes).", file=sys.stderr)
            return

        now = time.time()
        for path in self._agent_transcripts(agent):
            session = _session_id_from_path(path)
            ar["sessions_scanned"] += 1

            # Resumability: an already-completed session is skipped cheaply.
            if self.progress.is_done(agent, session):
                ar["sessions_already_done"] += 1
                continue

            # F3: never touch an ACTIVE / recently-written session — it may have
            # no watermark yet, and re-posting non-overlapping slices while the
            # live path writes sliding-window slices duplicates the turns.
            try:
                idle = now - os.path.getmtime(path)
            except OSError:
                continue
            if idle < self.min_idle_s:
                ar["sessions_active_skipped"] += 1
                ar["sessions"].append({"session": session, "class": "active",
                                       "action": "skipped_recent", "idle_s": round(idle, 1)})
                continue

            messages = read_transcript(path)
            if not messages:
                continue

            # Classification (design Part 2 dedup redesign).
            live_wm = watermark.load(session)
            if live_wm is not None:
                # Partially retained by the live path — conservative skip
                # (no existence query available in the vendored client).
                ar["sessions_partial_skipped"] += 1
                ar["sessions"].append({"session": session, "class": "partial", "action": "skipped_for_review"})
                if self.commit:
                    self.progress.record(agent, session, "skipped_partial")
                continue

            # True-total-loss — recover in full.
            slices = chunk_by_human_turns(messages, self.slice_turns)
            if not slices:
                continue

            bank_id = _resolve_bank_id(agent, session, self.config)
            if ar["bank_id"] is None:
                ar["bank_id"] = bank_id
            built_slices = []
            n_turns = 0
            for sl in slices:
                built = build_retain_payload(
                    self.config, session, sl, messages,
                    bank_id=bank_id, api_url=self._api_url or "http://backfill-client",
                    api_token=self._api_token, retain_full_window=True, document_id=None,
                )
                if built is None:
                    continue
                built_slices.append(built)
                n_turns += len(_human_turn_indices(sl))

            if not built_slices:
                continue
            ar["sessions_total_loss"] += 1
            ar["slices"] += len(built_slices)
            ar["turns_recovered"] += n_turns
            ar["sessions"].append({
                "session": session, "class": "total_loss",
                "bank_id": bank_id,
                "slices": len(built_slices), "turns": n_turns,
                "document_ids": [b["document_id"] for b in built_slices],
            })

            if not self.commit:
                # Dry-run: build-only, ZERO writes. Nothing posted, no mission
                # PATCH, no progress mutation.
                continue

            all_ok = True
            last_built = None
            for built in built_slices:
                if self._post_slice(bank_id, built):
                    ar["posts_ok"] += 1
                    last_built = built
                else:
                    ar["posts_failed"] += 1
                    all_ok = False

            if all_ok and last_built is not None:
                # Advance the live watermark so the agent's own boot reconcile
                # sees the tail as committed, and mark the session done for a
                # cheap resume.
                try:
                    watermark.commit(
                        session, last_built["last_uuid"], last_built["document_id"],
                        transcript_path=path, ordered_uuids=last_built["ordered_uuids"],
                    )
                except Exception:  # pragma: no cover - defensive
                    pass
                self.progress.record(agent, session, "done", slices=len(built_slices), turns=n_turns)
            else:
                self.progress.record(agent, session, "failed")

    # -- from-logs (log-driven recovery) ------------------------------------ #
    def _logs_agent_report(self, agent: str) -> dict:
        return self.report["agents"].setdefault(agent, {
            "bank_id": None,
            "bank_refused": False,
            "refuse_reason": None,
            "candidate_turns": 0,
            "candidate_sessions": 0,
            "ambiguous_turns": 0,
            "unmatched_turns": 0,
            "sessions_has_documents": 0,
            "sessions_total_loss": 0,
            "sessions_membership_error": 0,
            "sessions_active_skipped": 0,
            "sessions_already_done": 0,
            "sessions_restored": 0,
            "slices_restored": 0,
            # Slice-level gap completion (#3291): a session this backfill is the
            # sole writer of that was previously left partially committed.
            "sessions_gap_completed": 0,
            "sessions_gap_incomplete": 0,
            "slices_gap_filled": 0,
            "slices_gap_present": 0,
            # Convergence visibility (#3291 self-heal): sessions that STILL are
            # not fully recovered after this run (a restore or gap-completion
            # POST failed). Non-zero ⇒ another run is needed; surfaced so a
            # non-converging session can never be a SILENT permanent trap.
            "sessions_incomplete": 0,
            "turns_recovered": 0,
            "posts_ok": 0,
            "posts_failed": 0,
            "sessions": [],
        })

    def _slice_exists(self, bank_id: str, document_id: str) -> Optional[bool]:
        """Paced tri-state presence check for ONE deterministic slice document.

        ``True`` — already durable (skip, no re-cost). ``False`` — confirmed 404
        (missing → must post). ``None`` — unknown (transport/5xx): the caller
        (re)posts, because the daemon UPSERTs on ``document_id`` so a needless
        re-post of an already-present slice is a safe idempotent no-op, whereas
        SKIPPING a genuinely-missing slice would re-open the #3291 silent gap. The
        GET is paced through the shared inflight lock like every other op."""
        client = self._ensure_client()
        if client is None:
            return None
        self._pace_before_post()
        try:
            with inflight_lock(blocking=True) as acquired:
                if not acquired:  # pragma: no cover - blocking acquire fails open
                    return None
                return client.document_exists(bank_id, document_id)
        except Exception as e:  # pragma: no cover - defensive
            debug_log(self.config, f"backfill(gap): document_exists failed "
                                   f"for {document_id}: {e}")
            return None
        finally:
            self._posted_count += 1
            self._post_times.append(time.monotonic())

    def _session_membership(self, bank_id: str, session_id: str) -> str:
        """SESSION-LEVEL, id-scheme-AGNOSTIC membership (BLOCKER-1 fix).

        Returns ``"present"`` when the bank holds ANY document belonging to the
        session, ``"absent"`` when it holds NONE (true total loss), or
        ``"error"`` on any query failure (caller fails CLOSED — treats it as
        present ⇒ skip, never restores on uncertainty).

        We deliberately do NOT compare against the tool's ``-r{uuid}`` slice ids
        here: production banks are a MIX of the deterministic ``-r{uuid}`` scheme
        (``retain.py``'s ``slice_document_id``, live since #3246) and the older
        ``{session_id}-{epoch_ms}`` docs written before it, so an exact slice-id
        set would never match a legacy doc → every slice looks "missing" → every
        intact session gets duplicated. Presence is decided by the id PREFIX
        ``{session_id}`` which every scheme shares (``{session_id}-...`` legacy or
        ``-r{uuid}``, or the bare ``{session_id}`` chunk-0 id). Restore fires ONLY
        for a session with ZERO documents — so partial-tail recovery *within a
        legacy-populated session* stays OUT OF SCOPE (we cannot tell WHICH turns a
        legacy epoch-ms id covers). The one partial case we CAN complete safely is
        a session this backfill is the SOLE writer of — its docs are all
        deterministic ``-r{uuid}`` ids, so ``_gap_complete_session`` recomputes
        them and posts only the missing ones; that path is routed from the
        progress ``failed`` record (a session this tool already classified
        total-loss), never from this session-membership check.

        The GET is paced through the shared inflight lock so must-fix #1's broad
        candidate set can never create a read storm (should-fix 4b)."""
        client = self._ensure_client()
        if client is None:
            return "error"
        self._pace_before_post()
        try:
            with inflight_lock(blocking=True) as acquired:
                if not acquired:  # pragma: no cover - blocking acquire fails open
                    return "error"
                ids = client.list_session_document_ids(bank_id, session_id)
        except Exception as e:
            debug_log(self.config, f"backfill(from-logs): membership query failed "
                                   f"for {session_id}: {e} — failing closed (skip)")
            return "error"
        finally:
            # A membership GET counts toward pacing state just like a POST.
            self._posted_count += 1
            self._post_times.append(time.monotonic())
        prefix = f"{session_id}-"
        for did in ids:
            if isinstance(did, str) and (did == session_id or did.startswith(prefix)):
                return "present"
        return "absent"

    def _backfill_agent_from_logs(self, agent: str) -> None:
        ar = self._logs_agent_report(agent)

        # Correct-bank targeting: resolve TRUE bank or REFUSE (zero writes).
        res = resolve_true_bank(
            agent,
            switchroom_yaml_path=self.switchroom_yaml,
            settings_path=self._settings_path(agent),
        )
        if not res.ok:
            ar["bank_refused"] = True
            ar["refuse_reason"] = res.reason
            print(f"[Hindsight] backfill(from-logs): REFUSING {agent} — {res.reason} "
                  f"(no writes).", file=sys.stderr)
            return
        bank_id = res.bank_id
        ar["bank_id"] = bank_id

        # BROAD candidate classifier over the durable turn-lifecycle log.
        turns = read_candidate_turns(self._registry_path(agent))
        ar["candidate_turns"] = len(turns)
        if not turns:
            return

        # Event-span containment join (must-fix #3).
        spans = [transcript_span(p) for p in self._agent_transcripts(agent)]
        sessions: dict = {}
        for t in turns:
            jr = resolve_transcript_for_turn(
                t, spans,
                slack_ms=self.window_slack_ms,
                require_direct_sessionid=self.require_direct_sessionid,
            )
            if jr.kind in ("span", "direct") and jr.session_id:
                sessions.setdefault(jr.session_id, {"path": jr.transcript_path, "join": jr.kind})
            elif jr.kind == "ambiguous":
                ar["ambiguous_turns"] += 1
                ar["sessions"].append({"turn_key": t.turn_key, "class": "ambiguous",
                                       "action": "refused", "detail": jr.detail})
            else:
                ar["unmatched_turns"] += 1
        ar["candidate_sessions"] = len(sessions)

        now = time.time()
        for session, info in sessions.items():
            path = info["path"]

            if self.progress.is_done(agent, session):
                ar["sessions_already_done"] += 1
                continue

            # Never touch an ACTIVE / recently-written session.
            try:
                idle = now - os.path.getmtime(path)
            except OSError:
                continue
            if idle < self.min_idle_s:
                ar["sessions_active_skipped"] += 1
                ar["sessions"].append({"session": session, "class": "active",
                                       "action": "skipped_recent", "idle_s": round(idle, 1)})
                continue

            # #3291: a session this backfill previously classified total-loss but
            # left PARTIALLY committed (a slice POST failed ⇒ recorded ``failed``
            # after slices 0..k-1 landed durably). The session-membership check
            # below would now see that committed prefix, classify it ``present``,
            # and skip it FOREVER — silently under-recovering the exact total-loss
            # sessions this mode exists to rescue. Route it instead into
            # slice-level gap completion: this tool is the sole writer, so every
            # doc is a deterministic ``-r{uuid}`` id we can recompute and fill only
            # the missing slices. Guarded by ``ensure_slice_turns`` (a resume with
            # a different slice size aborts before any write), so recomputed ids
            # are guaranteed to match the committed prefix.
            if self.progress.status(agent, session) == "failed":
                self._gap_complete_session(agent, session, bank_id, path, info, ar)
                continue

            # SESSION-LEVEL, scheme-agnostic membership (BLOCKER-1 fix): restore
            # ONLY a session the bank has ZERO documents for (true total loss).
            # A session with ANY doc (legacy epoch-ms OR new -r{uuid} scheme) is
            # PRESENT ⇒ skipped — we cannot safely fill a partial tail on a
            # legacy-keyed bank without duplicating the intact head. Fail CLOSED
            # (error ⇒ treated present ⇒ skip).
            membership = self._session_membership(bank_id, session)
            if membership == "error":
                ar["sessions_membership_error"] += 1
                ar["sessions"].append({"session": session, "class": "membership_error",
                                       "join": info["join"], "action": "skipped_fail_closed"})
                continue
            if membership == "present":
                ar["sessions_has_documents"] += 1
                ar["sessions"].append({"session": session, "class": "has_documents",
                                       "join": info["join"], "action": "skip_has_documents"})
                continue

            # membership == "absent" → true total loss → restore the whole session.
            messages = read_transcript(path)
            if not messages:
                continue
            slices = chunk_by_human_turns(messages, self.slice_turns)
            if not slices:
                continue
            built_slices = []
            for sl in slices:
                built = build_retain_payload(
                    self.config, session, sl, messages,
                    bank_id=bank_id, api_url=self._api_url or "http://backfill-client",
                    api_token=self._api_token, retain_full_window=True, document_id=None,
                )
                if built is not None:
                    built_slices.append((built, sl))
            if not built_slices:
                continue

            total = len(built_slices)
            n_turns = sum(len(_human_turn_indices(sl)) for _, sl in built_slices)
            ar["sessions_total_loss"] += 1

            session_entry = {
                "session": session, "class": "total_loss",
                "join": info["join"], "bank_id": bank_id,
                "slices": total, "turns": n_turns,
                "document_ids": [b["document_id"] for b, _ in built_slices],
                "action": None,
            }

            if not self.commit:
                # Dry-run: build-only, ZERO writes. Report the gap it WOULD fill.
                session_entry["action"] = "would_restore"
                ar["turns_recovered"] += n_turns
                ar["slices_restored"] += total
                ar["sessions"].append(session_entry)
                continue

            all_ok = True
            last_built = None
            for built, _ in built_slices:
                if self._post_slice(bank_id, built):
                    ar["posts_ok"] += 1
                    ar["slices_restored"] += 1
                    last_built = built
                else:
                    ar["posts_failed"] += 1
                    all_ok = False

            if all_ok and last_built is not None:
                ar["sessions_restored"] += 1
                ar["turns_recovered"] += n_turns
                session_entry["action"] = "restored"
                # Advance the live watermark so the agent's own boot reconcile
                # sees the tail as committed.
                try:
                    watermark.commit(
                        session, last_built["last_uuid"], last_built["document_id"],
                        transcript_path=path, ordered_uuids=last_built["ordered_uuids"],
                    )
                except Exception:  # pragma: no cover - defensive
                    pass
                self.progress.record(agent, session, "done", slices=total, turns=n_turns)
            else:
                session_entry["action"] = "restore_failed"
                ar["sessions_incomplete"] += 1
                self.progress.record(agent, session, "failed")
            ar["sessions"].append(session_entry)

        # Convergence visibility: if any session is still short after this run,
        # tell the operator plainly (and how to converge it) so a session that
        # keeps failing can never be a silent permanent trap. The mechanism
        # guarantees forward progress — each re-run posts only what is still
        # missing — but a persistently-unpostable session needs a human.
        if self.commit and ar["sessions_incomplete"] > 0:
            stuck = [s.get("session") for s in ar["sessions"]
                     if s.get("action") in ("restore_failed", "gap_incomplete")]
            print(
                f"[Hindsight] backfill(from-logs): {agent} — "
                f"{ar['sessions_incomplete']} session(s) still INCOMPLETE after this "
                f"run (POST failures): {', '.join(str(s) for s in stuck)}. Re-run "
                f"`--from-logs --commit --agent {agent}` to fill the remaining "
                f"slices (gap-completion posts ONLY what is still missing).",
                file=sys.stderr,
            )

    def _gap_complete_session(self, agent, session, bank_id, path, info, ar) -> None:
        """Fill the missing slices of a backfill-sole-writer session left
        partially committed by a prior run (#3291).

        Precondition (enforced by the caller): the session's progress record is
        ``failed`` — this tool already classified it total-loss and committed a
        deterministic ``-r{uuid}`` prefix before a POST failed. Because the
        backfill is the SOLE writer of such a session, EVERY doc it holds is a
        deterministic slice id we can recompute (``ensure_slice_turns`` guarantees
        the same boundaries as the prior run). We check each slice's presence and
        POST ONLY the ones the bank is missing, so the committed prefix is never
        duplicated and the session always makes forward progress toward complete
        recovery rather than being skipped forever by session-membership."""
        messages = read_transcript(path)
        if not messages:
            return
        slices = chunk_by_human_turns(messages, self.slice_turns)
        if not slices:
            return
        built_slices = []
        for sl in slices:
            built = build_retain_payload(
                self.config, session, sl, messages,
                bank_id=bank_id, api_url=self._api_url or "http://backfill-client",
                api_token=self._api_token, retain_full_window=True, document_id=None,
            )
            if built is not None:
                built_slices.append((built, sl))
        if not built_slices:
            return

        total = len(built_slices)
        n_turns = sum(len(_human_turn_indices(sl)) for _, sl in built_slices)
        session_entry = {
            "session": session, "class": "gap_completion",
            "join": info["join"], "bank_id": bank_id,
            "slices": total, "turns": n_turns,
            "document_ids": [b["document_id"] for b, _ in built_slices],
            "action": None,
        }

        if not self.commit:
            # Dry-run: report the whole session as the gap it WOULD complete
            # (per-slice presence probing is itself a network read, elided here).
            session_entry["action"] = "would_gap_complete"
            ar["sessions"].append(session_entry)
            return

        # POST only the slices the bank is actually missing. ``True`` ⇒ already
        # durable (skip); ``False``/``None`` ⇒ (re)post — the daemon UPSERTs on
        # document_id so a needless re-post is a safe no-op, while skipping a
        # genuinely-missing slice would re-open the gap.
        filled = 0
        present = 0
        failed = 0
        for built, _ in built_slices:
            if self._slice_exists(bank_id, built["document_id"]) is True:
                present += 1
                continue
            if self._post_slice(bank_id, built):
                filled += 1
                ar["posts_ok"] += 1
            else:
                failed += 1
                ar["posts_failed"] += 1

        ar["slices_gap_filled"] += filled
        ar["slices_gap_present"] += present
        session_entry["slices_filled"] = filled
        session_entry["slices_present"] = present

        if failed == 0:
            # Every slice is now durable → the session is fully recovered.
            ar["sessions_gap_completed"] += 1
            ar["turns_recovered"] += n_turns
            session_entry["action"] = "gap_completed"
            last_built = built_slices[-1][0]
            try:
                watermark.commit(
                    session, last_built["last_uuid"], last_built["document_id"],
                    transcript_path=path, ordered_uuids=last_built["ordered_uuids"],
                )
            except Exception:  # pragma: no cover - defensive
                pass
            self.progress.record(agent, session, "done", slices=total, turns=n_turns)
        else:
            # Still short — stay ``failed`` so the NEXT run re-enters this same
            # gap-completion path (never the membership skip) and fills whatever
            # remains. Convergent: each run strictly reduces the missing set.
            ar["sessions_gap_incomplete"] += 1
            ar["sessions_incomplete"] += 1
            session_entry["action"] = "gap_incomplete"
            self.progress.record(agent, session, "failed")
        ar["sessions"].append(session_entry)

    def _finalize_report_from_logs(self) -> None:
        roll = {
            "mode": "from_logs",
            "agents": len(self.report["agents"]),
            "banks_refused": 0,
            "candidate_turns": 0,
            "candidate_sessions": 0,
            "ambiguous_turns": 0,
            "unmatched_turns": 0,
            "sessions_has_documents": 0,
            "sessions_total_loss": 0,
            "sessions_membership_error": 0,
            "sessions_active_skipped": 0,
            "sessions_already_done": 0,
            "sessions_restored": 0,
            "slices_restored": 0,
            "sessions_gap_completed": 0,
            "sessions_gap_incomplete": 0,
            "slices_gap_filled": 0,
            "slices_gap_present": 0,
            "sessions_incomplete": 0,
            "turns_recovered": 0,
            "posts_ok": 0,
            "posts_failed": 0,
            "slice_turns": self.slice_turns,
            "committed": self.commit,
        }
        for ar in self.report["agents"].values():
            if ar.get("bank_refused"):
                roll["banks_refused"] += 1
            for k in (
                "candidate_turns", "candidate_sessions", "ambiguous_turns",
                "unmatched_turns", "sessions_has_documents", "sessions_total_loss",
                "sessions_membership_error", "sessions_active_skipped",
                "sessions_already_done", "sessions_restored", "slices_restored",
                "sessions_gap_completed", "sessions_gap_incomplete",
                "slices_gap_filled", "slices_gap_present", "sessions_incomplete",
                "turns_recovered", "posts_ok", "posts_failed",
            ):
                roll[k] += ar.get(k, 0)
        self.report["rollup"] = roll

    def _finalize_report(self) -> None:
        roll = {
            "agents": len(self.report["agents"]),
            "dynamic_bank_agents_skipped": 0,
            "sessions_scanned": 0,
            "sessions_total_loss": 0,
            "sessions_partial_skipped": 0,
            "sessions_active_skipped": 0,
            "sessions_already_done": 0,
            "turns_recovered": 0,
            "slices": 0,
            "posts_ok": 0,
            "posts_failed": 0,
            "slice_turns": self.slice_turns,
            "committed": self.commit,
        }
        for ar in self.report["agents"].values():
            if ar.get("dynamic_bank_skipped"):
                roll["dynamic_bank_agents_skipped"] += 1
            for k in (
                "sessions_scanned", "sessions_total_loss", "sessions_partial_skipped",
                "sessions_active_skipped", "sessions_already_done", "turns_recovered",
                "slices", "posts_ok", "posts_failed",
            ):
                roll[k] += ar[k]
        self.report["rollup"] = roll


# --------------------------------------------------------------------------- #
# Reporting / CLI.
# --------------------------------------------------------------------------- #
def format_report_from_logs(report: dict) -> str:
    roll = report.get("rollup", {})
    mode = "COMMIT" if roll.get("committed") else "DRY-RUN (no writes)"
    lines = [f"[Hindsight] log-driven recovery report — {mode}", ""]
    for agent in sorted(report.get("agents", {})):
        ar = report["agents"][agent]
        if ar.get("bank_refused"):
            lines.append(f"  {agent}: BANK REFUSED — {ar.get('refuse_reason')} (no writes)")
            continue
        lines.append(
            f"  {agent} [bank={ar.get('bank_id')}]: "
            f"cand_turns={ar['candidate_turns']} cand_sessions={ar['candidate_sessions']} "
            f"ambiguous={ar['ambiguous_turns']} unmatched={ar['unmatched_turns']} "
            f"has_documents={ar['sessions_has_documents']} "
            f"total_loss={ar['sessions_total_loss']} "
            f"membership_err={ar['sessions_membership_error']} "
            f"active_skip={ar['sessions_active_skipped']} "
            f"already_done={ar['sessions_already_done']} "
            f"restored={ar['sessions_restored']} "
            f"slices_restored={ar['slices_restored']} "
            f"gap_completed={ar.get('sessions_gap_completed', 0)} "
            f"gap_filled={ar.get('slices_gap_filled', 0)} "
            f"incomplete={ar.get('sessions_incomplete', 0)} "
            f"turns={ar['turns_recovered']} "
            f"posts_ok={ar['posts_ok']} posts_failed={ar['posts_failed']}"
        )
        for s in ar.get("sessions", []):
            if s.get("class") in ("total_loss", "gap_completion",
                                  "membership_error", "ambiguous"):
                lines.append(
                    f"      - {s.get('session', s.get('turn_key'))} [{s.get('class')}] "
                    f"join={s.get('join', '-')} "
                    f"slices={s.get('slices', '-')} "
                    f"action={s.get('action')} {s.get('detail', '')}".rstrip()
                )
    lines.append("")
    lines.append(
        f"  ROLLUP: agents={roll.get('agents', 0)} "
        f"banks_refused={roll.get('banks_refused', 0)} "
        f"candidate_sessions={roll.get('candidate_sessions', 0)} "
        f"ambiguous={roll.get('ambiguous_turns', 0)} "
        f"has_documents(skipped)={roll.get('sessions_has_documents', 0)} "
        f"total_loss={roll.get('sessions_total_loss', 0)} "
        f"membership_err={roll.get('sessions_membership_error', 0)} "
        f"restored={roll.get('sessions_restored', 0)} "
        f"slices_restored={roll.get('slices_restored', 0)} "
        f"gap_completed={roll.get('sessions_gap_completed', 0)} "
        f"gap_filled={roll.get('slices_gap_filled', 0)} "
        f"incomplete={roll.get('sessions_incomplete', 0)} "
        f"turns_would_recover={roll.get('turns_recovered', 0)} "
        f"posts_ok={roll.get('posts_ok', 0)} posts_failed={roll.get('posts_failed', 0)}"
    )
    incomplete = roll.get("sessions_incomplete", 0)
    if incomplete:
        lines.append(
            f"  ⚠ CONVERGENCE: {incomplete} session(s) still INCOMPLETE (a POST "
            f"failed). Re-run `--from-logs --commit` — gap-completion posts ONLY "
            f"the still-missing slices, so each run strictly reduces the gap. A "
            f"count that never reaches 0 across runs means a persistently-"
            f"unpostable session that needs a human."
        )
    lines.append("  NOTE: recovers only ZERO-document (total-loss) sessions. "
                 "Partial-tail recovery within a populated session is OUT OF SCOPE "
                 "on legacy epoch-ms banks (needs the -r{uuid} id scheme deployed).")
    if not roll.get("committed"):
        est_posts = roll.get("slices_restored", 0)
        delay_ms = _delay_ms()
        est_secs = est_posts * (delay_ms / 1000.0)
        lines.append(
            f"  ESTIMATE (at {delay_ms}ms/post): ~{est_posts} restore POSTs, "
            f"~{est_secs:.0f}s wall-clock. Re-run with --commit --agent <name> to write."
        )
    return "\n".join(lines)


def format_report(report: dict) -> str:
    if report.get("mode") == "from_logs" or report.get("rollup", {}).get("mode") == "from_logs":
        return format_report_from_logs(report)
    roll = report.get("rollup", {})
    mode = "COMMIT" if roll.get("committed") else "DRY-RUN (no writes)"
    lines = [f"[Hindsight] backfill report — {mode}", ""]
    for agent in sorted(report.get("agents", {})):
        ar = report["agents"][agent]
        if ar.get("dynamic_bank_skipped"):
            lines.append(f"  {agent}: DYNAMIC-BANK — REFUSED (bank not reconstructable, no writes)")
            continue
        lines.append(
            f"  {agent} [bank={ar.get('bank_id')}]: scanned={ar['sessions_scanned']} "
            f"total_loss={ar['sessions_total_loss']} "
            f"partial_skipped={ar['sessions_partial_skipped']} "
            f"active_skipped={ar['sessions_active_skipped']} "
            f"already_done={ar['sessions_already_done']} "
            f"turns={ar['turns_recovered']} slices={ar['slices']} "
            f"posts_ok={ar['posts_ok']} posts_failed={ar['posts_failed']}"
        )
    lines.append("")
    lines.append(
        f"  ROLLUP: agents={roll.get('agents', 0)} "
        f"dynamic_bank_refused={roll.get('dynamic_bank_agents_skipped', 0)} "
        f"total_loss_sessions={roll.get('sessions_total_loss', 0)} "
        f"partial_skipped={roll.get('sessions_partial_skipped', 0)} "
        f"active_skipped={roll.get('sessions_active_skipped', 0)} "
        f"turns_would_recover={roll.get('turns_recovered', 0)} "
        f"slices={roll.get('slices', 0)} slice_turns={roll.get('slice_turns')} "
        f"posts_ok={roll.get('posts_ok', 0)} posts_failed={roll.get('posts_failed', 0)}"
    )
    if not roll.get("committed"):
        est_posts = roll.get("slices", 0)
        delay_ms = _delay_ms()
        est_secs = est_posts * (delay_ms / 1000.0)
        lines.append(
            f"  ESTIMATE (at {delay_ms}ms/post): ~{est_posts} POSTs, "
            f"~{est_secs:.0f}s wall-clock. Re-run with --commit to write."
        )
    return "\n".join(lines)


def _acquire_process_mutex():
    """``backfill.lock`` — one backfill process at a time (distinct from the
    per-POST storm guard). Returns the held fd, or None if flock unavailable /
    already held."""
    if sys.platform == "win32":
        return None
    import fcntl
    path = os.environ.get("HINDSIGHT_BACKFILL_LOCK") or os.path.join(
        os.path.expanduser("~"), ".hindsight", "backfill.lock"
    )
    d = os.path.dirname(path)
    try:
        if d and not os.path.isdir(d):
            os.makedirs(d, mode=0o700, exist_ok=True)
        fd = open(path, "w")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except OSError:
        return None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="One-time backfill of transcript work missing from Hindsight banks (#3244).",
    )
    parser.add_argument("--commit", action="store_true",
                        help="Actually write. WITHOUT this flag the tool is a zero-write dry-run (the default).")
    parser.add_argument("--agent", action="append", dest="agents", default=None,
                        help="Restrict to this agent (repeatable). Default: all agents.")
    parser.add_argument("--agents-dir", default=None, help="Override the agents scaffold root.")
    parser.add_argument("--delay-ms", type=int, default=None, help="Inter-POST delay (default 1500).")
    parser.add_argument("--slice-turns", type=int, default=None, help="Human turns per document slice (default 40).")
    parser.add_argument("--max-per-min", type=int, default=None, help="Optional hard POST rate cap.")
    parser.add_argument("--min-idle-s", type=int, default=None,
                        help="Skip sessions whose transcript was modified within this many seconds "
                             "(treated as active/in-flight). Default 3600.")
    parser.add_argument("--from-logs", action="store_true", dest="from_logs",
                        help="Log-driven recovery mode: narrow candidate sessions via the per-agent "
                             "turns registry, then restore ONLY sessions the agent's true bank has ZERO "
                             "documents for (session-level, scheme-agnostic total-loss gate). "
                             "Partial-tail recovery within a populated session is OUT OF SCOPE on legacy "
                             "epoch-ms banks (needs the -r{uuid} id scheme deployed).")
    parser.add_argument("--switchroom-yaml", default=None,
                        help="Path to switchroom.yaml for true-bank resolution (--from-logs). "
                             "Default: sibling of the agents dir.")
    parser.add_argument("--registry-tmpl", default=None,
                        help="Template (with {agent}) for a per-agent turns registry.db (--from-logs). "
                             "Default: <agents>/{agent}/telegram/registry.db")
    parser.add_argument("--window-slack-s", type=int, default=None,
                        help="Slack (seconds) on each side of a transcript event-span for the "
                             "historical containment join (--from-logs). Default 120.")
    parser.add_argument("--require-direct-sessionid", action="store_true",
                        help="Refuse any turn without a stamped session_id rather than use the "
                             "span-containment join (strict, going-forward-only; --from-logs).")
    parser.add_argument("--json", action="store_true", help="Emit the machine-readable report as JSON.")
    args = parser.parse_args(argv)

    # F1/F3 footgun guard: a blanket --commit across the whole fleet can write to
    # a wrong (dynamic) bank or double-post an active session. Require an explicit
    # per-agent opt-in for any write; dry-run may still scan the whole fleet.
    if args.commit and not args.agents:
        print("[Hindsight] backfill: --commit requires an explicit --agent <name> "
              "(fleet-wide commit is refused; dry-run the fleet first, then commit per agent).",
              file=sys.stderr)
        return 2

    config = load_config()

    mutex = _acquire_process_mutex()
    if mutex is None and sys.platform != "win32":
        print("[Hindsight] backfill: could not take backfill.lock — another backfill may be "
              "running. Refusing to co-run.", file=sys.stderr)
        return 2

    try:
        bf = Backfill(
            config,
            commit=args.commit,
            delay_ms=args.delay_ms,
            slice_turns=args.slice_turns,
            max_per_min=args.max_per_min,
            agents_root=args.agents_dir,
            min_idle_s=args.min_idle_s,
            from_logs=args.from_logs,
            switchroom_yaml=args.switchroom_yaml,
            registry_tmpl=args.registry_tmpl,
            window_slack_s=args.window_slack_s,
            require_direct_sessionid=args.require_direct_sessionid,
        )
        agent_filter = set(args.agents) if args.agents else None
        try:
            report = bf.run(agent_filter)
        except ValueError as e:
            # F2: slice_turns mismatch on resume — refuse before writing.
            print(f"[Hindsight] backfill: {e}", file=sys.stderr)
            return 2
    finally:
        if mutex is not None:
            try:
                mutex.close()
            except OSError:
                pass

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(format_report(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
