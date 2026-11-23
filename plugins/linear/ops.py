"""Operator view of held Linear work: what is stuck, why, and the one supported next step."""
from __future__ import annotations
import json
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from typing import Any
from .store import Store, advisory

RESOLVE = "Check the issue in Linear, then: hermes linear resolve {id} applied|not_applied --evidence \"<what you saw>\""
PARKED = ("Fix the logged cause, then: hermes linear replay {id}. If Linear already shows its answer and a replay would "
          "only repeat it: hermes linear dismiss {id} --evidence \"<what you saw>\"")
def held(write: dict[str, str], cause: str = "") -> str:
    return (f"An earlier {write['kind']} write ({write['id']}) may or may not have reached Linear{f' ({cause})' if cause else ''}; "
            "it holds this issue until reconciled. " + RESOLVE.format(id=write["id"]) + ".")

def _read(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=10)
    db.row_factory = sqlite3.Row
    return db

def _rows(db: sqlite3.Connection, sql: str, *args: Any) -> list[sqlite3.Row]:
    try:
        return db.execute(sql, args).fetchall()
    except sqlite3.OperationalError as exc:  # only a schema the gateway has not migrated yet is empty
        if "no such" not in str(exc): raise
        return []

def needs_resolution(row: Any, payload: dict[str, Any]) -> bool:
    """An uncertain issue write the gateway will not settle by itself: only an operator can say what happened."""
    held_legacy = bool(row["hold_reason"]) if "hold_reason" in row.keys() else False
    return (row["kind"] in ("status", "description", "delegate") and not payload.get("reconciliation") and
            (held_legacy or Store.uncertain(row, payload) and
             (row["state"] == "failed" or bool(payload.get("reconcile_required")))))

def _dismissed(db: sqlite3.Connection) -> set[str]:
    return {row["key"][len(Store.DISMISSED):] for row in
            _rows(db, "SELECT key FROM metadata WHERE key LIKE ?", Store.DISMISSED + "%")}

RETAINED = "Use a new authorized request for any further change."
NOTHING = "Nothing to do."
HISTORY_ACTIONS = frozenset({RETAINED, NOTHING})  # retained records: shown as one count line
AGE_LIMIT = 7 * 86_400  # undelivered writes older than this are no longer listed one by one

def stuck(state: Path, ingress: Path, profile: str, now: float | None = None) -> list[dict[str, Any]]:
    """Every item holding an issue or a delivery, oldest first. `act` marks the ones only an operator can clear."""
    return _scan(state, ingress, profile, now)[0]

def aged_out(state: Path, ingress: Path, profile: str, now: float | None = None) -> int:
    """Undelivered writes past AGE_LIMIT that stuck() no longer lists; counted so they stay visible."""
    return _scan(state, ingress, profile, now)[1]

def _scan(state: Path, ingress: Path, profile: str, now: float | None = None) -> tuple[list[dict[str, Any]], int]:
    now, items, dismissed, aged = time.time() if now is None else now, [], set(), 0
    def add(issue: str, ref: str, since: float, why: str, action: str, act: bool = False) -> None:
        items.append({"issue": issue or "-", "ref": ref, "age_s": max(0, int(now - since)), "why": why,
                      "action": action, "act": act})
    if state.is_file():
        with closing(_read(state)) as db:
            has_holds = any(row["name"] == "hold_reason" for row in _rows(db, "PRAGMA table_info(outbox)"))
            dismissed = _dismissed(db)
            rows = _rows(db, "SELECT rowid AS seq, * FROM outbox WHERE state != 'sent' ORDER BY rowid")
            # The newest delegate this app verifiably set on each issue (a receipt or a matching readback).
            applied = {}
            for row in _rows(db, "SELECT rowid AS seq, payload FROM outbox WHERE kind = 'delegate' AND state = 'sent'"):
                sent = json.loads(row["payload"])
                applied[(sent.get("issue_id"), sent.get("target_delegate_id"))] = row["seq"]
            for row in rows:
                payload = json.loads(row["payload"])
                since, issue = float(payload.get("enqueued_at") or row["next_at"]), payload.get("issue_id", "")
                reason = row["hold_reason"] if has_holds else None
                if not reason:
                    try:
                        reason = Store._delivery_hold_reason(db, row["kind"], payload)
                    except sqlite3.OperationalError as exc:
                        if "no such" not in str(exc):
                            raise
                        reason = "Unverified retained delivery needs migration and explicit reconciliation"
                if reason:
                    if payload.get("reconciliation"):
                        add(issue, row["id"], since, "Reconciled delivery history is retained; automatic replay remains disabled",
                            RETAINED)
                    else:
                        action = (RESOLVE.format(id=row["id"]) if row["kind"] in ("status", "description", "delegate") else
                                  "Inspect the retained request and native/external effects. Do not replay it; use a new authorized request after reconciliation.")
                        add(issue, row["id"], since, reason, action, True)
                elif advisory({"kind": row["kind"], "payload": payload}):
                    continue
                elif needs_resolution(row, payload):
                    held = sum(1 for r in rows if json.loads(r["payload"]).get("requires_status_id") == row["id"])
                    add(issue, row["id"], since, f"{row['kind']} write may or may not have reached Linear; it holds "
                        "this issue" + (f" and {held} dependent write(s)" if held else ""), RESOLVE.format(id=row["id"]), True)
                elif row["kind"] in ("status", "description", "delegate") and Store.uncertain(row, payload):
                    late = now - since > 3600  # a send held this long is not settling by itself
                    add(issue, row["id"], since, f"{row['kind']} write is {'held unsent' if late else 'being sent'}; it holds "
                        "this issue", "Check the gateway log for what holds it." if late else "Settles on its next send.", late)
                elif (row["kind"] == "delegate" and row["state"] == "failed" and not payload.get("reconciliation") and
                      applied.get((issue, payload.get("target_delegate_id")), -1) > row["seq"] and now - since < AGE_LIMIT):
                    add(issue, row["id"], since, "delegate write was not delivered; a later write already set the same delegate",
                        NOTHING)
                elif row["state"] == "failed" and not payload.get("reconciliation") and now - since < AGE_LIMIT:
                    add(issue, row["id"], since, f"{row['kind']} write was not delivered",
                        "Retried after the next successful write." if row["attempts"] else "Not retried: redo the step.",
                        not row["attempts"])
                elif (row["state"] == "failed" and not payload.get("reconciliation") and not (
                        row["kind"] == "delegate" and applied.get((issue, payload.get("target_delegate_id")), -1) > row["seq"])):
                    aged += 1  # Past AGE_LIMIT: no longer listed, but still counted in the report.
            for row in _rows(db, "SELECT * FROM specialist_scope_fence"):
                add(row["issue_id"], "fence", row["fenced_at"], "outside specialist scope",
                    "Permanent by policy; recover only through an approved procedure.")
            for row in _rows(db, "SELECT * FROM chat_admissions WHERE state IN ('claiming', 'ambiguous')"):
                add(row["issue_id"], row["request_id"], now, f"chat-to-worker admission is {row['state']}"
                    + (f" for task {row['task_id']}" if row["task_id"] else ""),
                    "Confirm the task and delegate in Linear and Kanban before new work on this issue.",
                    row["state"] == "ambiguous")
            for row in _rows(db, "SELECT issue_id, last_updated_at FROM work WHERE release_pending = 1"):
                add(row["issue_id"], "release", (row["last_updated_at"] or now * 1000) / 1000,
                    "retained legacy release needs reconciliation", "Inspect native and Linear state; no automatic replay.", True)
            for row in _rows(db, "SELECT issue_id,origin,task_id,last_updated_at FROM work WHERE origin != 'native'"):
                add(row["issue_id"], row["task_id"] or "legacy", (row["last_updated_at"] or now * 1000) / 1000,
                    f"retained {row['origin']} record; execution state is unknown",
                    "Inspect existing native work, checkpoints and external effects before migration. No automatic adoption.", True)
            for row in _rows(db, "SELECT task_id, issue_id FROM retirement"):
                add(row["issue_id"], row["task_id"], now, f"waiting for Kanban task {row['task_id']} to exit",
                    "Inspect native worker and effect state; historical retirement is not proof of worker liveness.", True)
            for row in _rows(db, "SELECT key,value FROM metadata WHERE key LIKE 'native-intent:%'"):
                saved = json.loads(row["value"])
                if saved.get("state") == "applied":
                    continue
                request = saved.get("payload") or {}
                add(request.get("issue_id") or "", row["key"], now,
                    f"native {request.get('kind') or 'delivery'} outcome needs reconciliation",
                    "Inspect native task/comment/run and external state. Reuse the original request; never blindly replay.", True)
            for row in _rows(db, "SELECT id,issue_id,status FROM chat_stop WHERE status IN ('requested','accepted')"):
                add(row["issue_id"], row["id"], now, "retained chat Stop outcome is unverified",
                    "Inspect the actual native process/effect state. The retired plugin protocol will not retry it.", True)
    if ingress.is_file():
        with closing(_read(ingress)) as db:
            for row in _rows(db, "SELECT logical_agent, delivery_id, payload, received_at, status, attempts FROM deliveries WHERE "
                             "profile = ? AND (status = 'failed' OR (status = 'pending' AND attempts > 0)) "
                             "ORDER BY received_at", profile):
                try:
                    event = json.loads(row["payload"])
                    issue = ((event.get("agentSession") or {}).get("issue") or {}).get("id") or (event.get("data") or {}).get("id")
                except (ValueError, TypeError, AttributeError):
                    issue = ""
                parked = row["status"] == "failed"
                if parked and f"{row['logical_agent']}:{row['delivery_id']}" in dismissed:
                    add(issue or "", row["delivery_id"], row["received_at"],
                        f"Linear delivery parked after {row['attempts']} failed attempt(s) was dismissed by an operator; "
                        "its history is retained", RETAINED)
                    continue
                add(issue or "", row["delivery_id"], row["received_at"],
                    f"Linear delivery {'parked' if parked else 'retrying'} after {row['attempts']} failed attempt(s)",
                    PARKED.format(id=row["delivery_id"]) if parked
                    else "Backing off; a restart retries it at once.", parked)
    return sorted(items, key=lambda item: -item["age_s"]), aged

def report(items: list[dict[str, Any]], *, show_all: bool = False, aged: int = 0) -> str:
    """Operator items first, then in-flight ones; retained history is one count line unless show_all."""
    def lines_for(item):
        return [f"- {'ACT ' if item['act'] else ''}{item['issue']} [{item['ref']}] {item['age_s'] / 3600:.1f}h: "
                f"{item['why']}", f"  {item['action']}"]
    old = f"{aged} write(s) that failed more than 7 days ago are no longer listed individually." if aged else ""
    if not items:
        return "Linear: nothing is held." + (f"\n{old}" if old else "")
    act = [i for i in items if i["act"]]
    history = [i for i in items if not i["act"] and i["action"] in HISTORY_ACTIONS]
    moving = [i for i in items if not i["act"] and i not in history]
    if show_all:
        lines = [f"Linear: {len(items)} item(s) held, {len(act)} need an operator."]
        for item in items:
            lines += lines_for(item)
    else:
        lines = [f"Linear: {len(act)} item(s) need an operator, {len(moving)} in progress."]
        for item in act + moving:
            lines += lines_for(item)
        if history:
            lines.append(f"{len(history)} retained record(s), no action needed (hermes linear status --all lists them).")
    if old:
        lines.append(old)
    return "\n".join(lines)

def _parked(ingress: Path, profile: str, delivery_id: str) -> str:
    """The inbox marker of this profile's parked delivery, or empty."""
    if not ingress.is_file():
        return ""
    with closing(_read(ingress)) as db:
        row = db.execute("SELECT logical_agent FROM deliveries WHERE profile = ? AND delivery_id = ? AND status = 'failed'",
                         (profile, delivery_id)).fetchone()
    return f"{row['logical_agent']}:{delivery_id}" if row else ""

def _was_dismissed(state: Path | None, marker: str) -> bool:
    if not marker or state is None or not state.is_file():
        return False
    with closing(_read(state)) as db:
        return marker in _dismissed(db)

def replay(ingress: Path, profile: str, delivery_id: str, state: Path | None = None) -> bool:
    """Give a parked delivery one more try; if it fails again it parks again, without a second alert.

    A delivery an operator dismissed stays dismissed: replaying it would repeat its answered effect."""
    if not ingress.is_file() or _was_dismissed(state, _parked(ingress, profile, delivery_id)):
        return False
    with closing(sqlite3.connect(ingress, timeout=10, isolation_level=None)) as db:
        return bool(db.execute("UPDATE deliveries SET status = 'pending', attempts = 0 WHERE profile = ? AND "
                               "delivery_id = ? AND status = 'failed'", (profile, delivery_id)).rowcount)

def dismiss(state: Path, ingress: Path, profile: str, delivery_id: str, evidence: str, at: float | None = None) -> bool:
    """Record that a parked delivery needs no replay (Linear already shows its answer) and retire its pending notice.

    The inbox row is read, never changed; the record and the retired notice live in this profile's state."""
    marker = _parked(ingress, profile, delivery_id)
    return bool(marker) and Store(state).dismiss_parked(marker, evidence=evidence, at=time.time() if at is None else at)

def setup(parser: Any) -> None:
    sub = parser.add_subparsers(dest="linear_command", required=True)
    status = sub.add_parser("status", help="List held Linear work and the next step")
    status.add_argument("--json", action="store_true")
    status.add_argument("--all", action="store_true", help="Also list retained records that need no action")
    resolve = sub.add_parser("resolve", help="Record the verified outcome of an uncertain status, description or delegate write")
    resolve.add_argument("row_id")
    resolve.add_argument("outcome", choices=("applied", "not_applied"))
    resolve.add_argument("--evidence", required=True, help="What you checked in Linear")
    sub.add_parser("replay", help="Retry one parked Linear delivery").add_argument("delivery_id")
    dismiss_cmd = sub.add_parser("dismiss", help="Record that one parked Linear delivery needs no replay and retire its notice")
    dismiss_cmd.add_argument("delivery_id")
    dismiss_cmd.add_argument("--evidence", required=True, help="What you checked in Linear")
    inspect_work = sub.add_parser("inspect-work", help="Inspect current dispatcher-owned work; original requester unknown, grants no permissions")
    inspect_work.add_argument("--reference-json", required=True, help="Complete work_reference result's reference object")

def run(args: Any, state: Path, ingress: Path, profile: str, *, origin_settings: dict | None = None) -> int:
    if args.linear_command == "inspect-work":
        from . import work
        from .transport import Unavailable
        try:
            result = work.inspect(json.loads(args.reference_json), origin_settings or {})
        except (Unavailable, ValueError, ImportError, OSError, RuntimeError) as exc:
            print(json.dumps({"ok": False, "message": str(exc), "permission_granted": False}))
            return 1
        print(json.dumps({"ok": True, **result}))
        return 0
    if args.linear_command == "status":
        items, aged = _scan(state, ingress, profile)
        print(json.dumps(items, indent=2) if args.json else report(items, show_all=getattr(args, "all", False), aged=aged))
        return 1 if any(item["act"] for item in items) else 0
    if args.linear_command == "resolve":
        store = Store(state) if state.is_file() else None
        if store:
            store.delivery_allowed(args.row_id)  # Persist the same hold shown by the read-only status view.
        row = store.outbox_row(args.row_id) if store else None
        done = bool(row and needs_resolution(row, row["payload"]) and store.reconcile_terminal(
            args.row_id, outcome=args.outcome, evidence=args.evidence, at=time.time()))
        print(f"Recorded {args.outcome} for {args.row_id}; retained execution history will not be replayed." if done else
              f"{args.row_id} does not need resolving now; see: hermes linear status")
        return 0 if done else 1
    if args.linear_command == "dismiss":
        done = bool(args.evidence.strip()) and dismiss(state, ingress, profile, args.delivery_id, args.evidence)
        print(f"Dismissed {args.delivery_id}; its history is kept and it will not be replayed." if done else
              f"{args.delivery_id} is not a parked delivery for profile {profile} that needs dismissing; see: hermes linear status")
        return 0 if done else 1
    done = replay(ingress, profile, args.delivery_id, state)
    print(f"Delivery {args.delivery_id} will be retried on the next tick." if done else
          f"{args.delivery_id} is not a parked delivery for profile {profile}; see: hermes linear status")
    return 0 if done else 1
