"""Readable native closeout through the existing issue-comment and Activity outbox."""
import json

POINTER_BODY = "Completed. The result and checks are in the issue comment."


def comment_id_for(issue_id, completion):
    from .bridge import stable_uuid4
    return stable_uuid4("native-outcome-comment", issue_id, json.dumps(completion, sort_keys=True, separators=(",", ":")))


def captured_body(store, issue_id, completion):
    """The text of this completion's outcome comment when one is already in the outbox, else None."""
    prior = store.outbox_row(comment_id_for(issue_id, completion))
    if prior and prior["kind"] == "comment" and prior["payload"].get("native_outcome_comment") is True:
        body = prior["payload"].get("body")
        return body if isinstance(body, str) else None
    return None


def prepare(writes, *, issue_id, owner, completion, summary, evidence, head_note, assessment_id=None, body=None):
    """One full issue comment per native completion; a session carries only its pointer.

    ``body`` is the text this completion's comment already has (outcome.captured_body), kept as is."""
    from .bridge import _done_body
    comment_id = assessment_id or comment_id_for(issue_id, completion)
    if not assessment_id:
        body = body if body is not None else _done_body(summary, evidence) + head_note
        writes.insert(1, ("comment", dict(id=comment_id, issue_id=issue_id, task_id=completion["task_id"],
            body=body, native_completion=completion, native_outcome_comment=True)))
    result = []
    for kind, payload in writes:
        if kind == "activity" and payload.get("content", {}).get("type") == "response":
            if not owner:
                continue  # The full comment already serves a task without an Agent Session.
            payload = {**payload, "native_outcome_pointer": True, "requires_comment_id": comment_id,
                "outcome_assessment": bool(assessment_id),
                "native_completion": completion, "content": {"type": "response",
                    "body": POINTER_BODY}}
        result.append((kind, payload))
    return result


def pointer_ready(bridge, row):
    """Reuse an existing assessment repair while its sole pointer is still unattempted."""
    payload = row["payload"]
    if bridge.store.outcome_comment_applied(payload):
        return True
    prior = bridge.store.outbox_row(payload["requires_comment_id"])
    if payload.get("write_started") is False and prior and prior["payload"].get("assessment"):
        candidate = bridge.store.assessment_comment_id(payload["issue_id"], prior["payload"]["body"],
            completion=payload["native_completion"])
        if candidate and candidate != prior["id"]:
            row["payload"] = {**payload, "requires_comment_id": candidate}
            bridge.store.rewrite(row["id"], row["payload"], row["next_at"])
    return bridge.store.outcome_comment_applied(row["payload"])


def reuse_comment(store, db, row_id, payload, *, status, status_id, at):
    """Keep one immutable result identity; retarget only a proven unsent repair."""
    prior = store.outbox_row(row_id)
    if prior is None:
        return False
    saved = prior['payload']
    if (prior['kind'] != 'comment' or saved.get('native_outcome_comment') is not True
            or any(saved.get(key) != payload.get(key) for key in
                   ('id', 'issue_id', 'task_id', 'native_completion', 'body'))):
        raise ValueError('Native outcome comment identity conflicts with its captured result')
    # Applied and possibly sent results retain their exact receipt/dependencies.
    # No new visible comment is permitted even when a transport result is unknown.
    request_id = status.get('completion_reconcile_request_id')
    if (request_id and saved.get('write_started') is False and prior.get('hold_reason') is None
            and not (prior['state'] == 'sent' and saved.get('applied') == 1)):
        intent = store.native_intent(f"track:{payload['issue_id']}:{request_id}") or {}
        request = intent.get('payload', {}).get('request', {})
        if (intent.get('state') != 'applied' or request.get('reconcile_complete') is not True
                or request.get('binding') != store.native_binding(payload['issue_id'])
                or status.get('native_completion') != saved.get('native_completion')
                or status.get('source_ms') != intent.get('payload', {}).get('at')):
            raise ValueError('Native outcome comment repair lacks its current reporting request')
        repaired = {key: value for key, value in saved.items()
                    if key not in {'applied', 'failure_kind', 'last_error', 'reported', 'reconciled_status_id'}}
        repaired.update(requires_status_id=status_id, completion_reconcile_request_id=request_id,
                        source_ms=status['source_ms'])
        db.execute("UPDATE outbox SET state='pending',payload=?,next_at=?,attempts=0 WHERE id=?",
                   (json.dumps(repaired), at, row_id))
    return True
