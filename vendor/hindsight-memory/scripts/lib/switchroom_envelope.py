"""Switchroom gateway inbound-envelope grammar — the ONE place this vendored
Python knows about switchroom's ``<channel source="...">`` wire format.

SWITCHROOM DIVERGENCE (not upstream Hindsight). This module isolates the
coupling between the vendored Python hooks and the switchroom telegram-plugin
gateway's inbound envelope. It exists so a change to the TS-side envelope
grammar has ONE obvious Python counterpart to update — instead of the grammar
being buried inline inside directive_verify.py where a silent TS format change
could break a Python guard undetected (#2903 Fix 6.3).

The gateway prepends a leading ``<channel source="..." ...>`` envelope to every
SYNTHESIZED / non-human inbound it injects into the model (cron fires, reaction
dispatches, resume synthetics, vault-grant approvals, sub-agent handbacks,
obligation representations, …). See, on the TS side:

  * telegram-plugin/gateway/*-inbound-builder.ts (and the reaction / resume /
    vault-grant / subagent / obligation builders) — they emit
    ``<channel source="<name>" ...>``.
  * A genuine human message from the primary channel carries
    ``source="telegram"``; interactive (non-gateway) sessions carry NO envelope
    at all.

Contract pinned here (keep in lockstep with the gateway):
  * ``CHANNEL_SOURCE_RE`` — extracts the ``source`` attribute from the leading
    envelope. Handles both open (``<channel source="telegram" ...>``) and
    self-closing (``<channel source="reaction"/>``) forms.
  * ``HUMAN_INBOUND_SOURCES`` — the whitelist of ``source`` values that denote a
    GENUINE human turn. A whitelist (not a blacklist) so any NEW synthetic
    source the gateway adds is treated as machine-authored by default rather
    than accidentally classified human.

If the gateway ever renames the envelope tag, changes the attribute name, or
adds a new human-facing channel, update THIS module (and its test,
tests/test_switchroom_envelope.py). Nothing else in the Python tree should hard
-code the ``<channel source=`` grammar.
"""

import re

# Genuine human inbound channels. A "user" turn whose `<channel source="...">`
# envelope names anything else is a SYNTHESIZED / cron inbound built by the
# gateway — a machine turn, NOT a human correction.
HUMAN_INBOUND_SOURCES = frozenset({"telegram"})

# Pulls the source attribute out of the gateway's leading `<channel ...>`
# envelope. Handles both open (`<channel source="telegram" ...>`) and
# self-closing (`<channel source="reaction"/>`) forms.
CHANNEL_SOURCE_RE = re.compile(r"""<channel\b[^>]*\bsource=["']([^"']+)["']""")


def envelope_source(text) -> "str | None":
    """Return the lower-cased ``source`` of the leading channel envelope, or
    None when there is no envelope (interactive session). Pure regex."""
    if not isinstance(text, str):
        return None
    m = CHANNEL_SOURCE_RE.search(text)
    if not m:
        return None
    return m.group(1).strip().lower()


def is_synthetic_inbound(text) -> bool:
    """True when this turn's opening message is a synthesized/cron inbound
    rather than a genuine human message.

    Detection is purely on the gateway-prepended ``<channel source="...">``
    envelope: a ``source`` outside ``HUMAN_INBOUND_SOURCES`` (``cron``,
    ``reaction``, ``resume_interrupted``, ``vault_grant_approved``,
    ``subagent_handback``, ``obligation_represent``, …) marks a non-human turn.
    No envelope (interactive session) → treated as human. Injected channel tags
    in a human's own body are neutralised upstream by the channel-envelope
    sanitiser, so the only real ``<channel source=`` is the gateway's.
    """
    source = envelope_source(text)
    if source is None:
        return False
    return source not in HUMAN_INBOUND_SOURCES
