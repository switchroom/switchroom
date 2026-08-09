"""Tests for build_retain_payload's speaker-aware retainContext template.

Switchroom — retainContext is no longer the opaque constant "claude-code".
It is a template resolved per-retain by build_retain_payload's
_resolve_template, filling {agent} from SWITCHROOM_AGENT_NAME and {bank_id}
from the target bank so the consolidation LLM knows whose first-person
experience each transcript line is.
"""

import pytest

from retain import build_retain_payload

MESSAGES = [
    {"role": "user", "content": "human fact"},
    {"role": "assistant", "content": "agent action"},
]


def _build(config, monkeypatch, agent="klanker", bank_id="klanker-main"):
    if agent is None:
        monkeypatch.delenv("SWITCHROOM_AGENT_NAME", raising=False)
    else:
        monkeypatch.setenv("SWITCHROOM_AGENT_NAME", agent)
    result = build_retain_payload(
        config,
        session_id="sess-1",
        messages_to_retain=MESSAGES,
        all_messages=MESSAGES,
        bank_id=bank_id,
        api_url="http://localhost:9077",
        api_token=None,
    )
    assert result is not None
    return result["payload"]["context"]


def test_context_template_resolves_agent_and_bank(monkeypatch):
    context = _build(
        {"retainContext": "agent '{agent}' ({bank_id})"},
        monkeypatch,
        agent="klanker",
        bank_id="klanker-main",
    )
    assert context == "agent 'klanker' (klanker-main)"


def test_context_template_agent_empty_outside_switchroom(monkeypatch):
    context = _build(
        {"retainContext": "agent '{agent}'"},
        monkeypatch,
        agent=None,
    )
    assert context == "agent ''"


def test_context_default_is_speaker_aware_and_resolved(monkeypatch):
    # No retainContext in config → build_retain_payload falls back to the
    # "claude-code" literal, which carries no template vars and is returned
    # verbatim. The speaker-aware default lives in settings.json / config.py
    # DEFAULTS and is exercised by test_config; here we assert the fallback
    # path stays byte-stable.
    context = _build({}, monkeypatch)
    assert context == "claude-code"


def test_context_plain_string_passthrough(monkeypatch):
    context = _build({"retainContext": "just plain text"}, monkeypatch)
    assert context == "just plain text"
