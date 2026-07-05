#!/usr/bin/env python3
"""Post-turn directive-capture verification hook for the Stop event.

Switchroom #2848 Stage C — deterministic correction capture (hindsight
synthesis-layers RFC, Phase 3 "corrections stick").

Stage B (recall.py) appends an advisory nudge to the UserPromptSubmit
context when the inbound looks correction-shaped, then trusts the model to
call ``mcp__hindsight__create_directive`` itself. That closes part of the
~55% miss rate Stage A measured, but capture still relies on the model
CHOOSING to act on the nudge — a purely advisory path. When the model
silently ignores the nudge, a durable correction is lost the same way it was
before Stage B.

This hook closes the residual gap for the HIGH-CONFIDENCE case. On Stop it:

  1. Re-reads the transcript, isolates the human turn that opened this turn,
     and tests it against a NARROW, high-precision "durable standing rule"
     regex (a strict subset of Stage B's inclusive detector — see
     ``looks_like_durable_directive``). Bare "always"/"never"/"stop …" and
     other one-off-prone shapes are deliberately EXCLUDED here; only explicit
     standing-rule framings ("from now on", "as a rule", "you should always",
     "call me …", "remember to …", "don't … again") qualify.
  2. Scans the assistant messages of the turn for an actual
     ``create_directive`` tool call.
  3. If the turn stated a durable rule but recorded NO directive, it BLOCKS
     the stop ONCE (Claude Code ``{"decision":"block"}``) with a terse reason
     telling the model to persist the rule now — or, if on reflection it was
     genuinely a one-off, to just finish. ``stop_hook_active`` gates the
     block to fire at most once per turn, so it can never loop and never
     override the model's second, explicit judgment.

Why this stays invariant-clean (same reasoning as Stage B):
  * NO model callsite here — detection is pure regex (claude-native).
  * NO silent hook-side write — the hook never calls the Hindsight API; the
    MODEL authors the directive verbatim and the call is visible in chat
    (chat-legibility / no-self-escalation). The block is a re-prompt, not a
    write.
  * Guarded against spam — the durable regex is high-precision, the block
    fires once, and the reason explicitly authorizes "one-off → don't create,
    just finish". A false positive costs one bounded model continuation.

Gated by the same knob as Stage B: ``directiveCaptureNudge`` (switchroom
default on; operators opt out per-agent via
``memory.directive_capture_nudge=false`` →
``HINDSIGHT_DIRECTIVE_CAPTURE_NUDGE``). Disabling the nudge disables this
verification too — they are one deterministic-capture feature.

Exit codes:
  0 — always (graceful degradation; a raise here must never wedge a turn).
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib.config import debug_log, load_config  # noqa: E402

# Reuse Stage B's pleasantry scrub so "as always" / "always happy to help"
# can't trip the high-confidence detector either. Imported lazily-safe: if
# recall.py fails to import for any reason we fall back to a no-op scrub so
# this hook still degrades gracefully rather than wedging Stop.
try:
    from recall import _DIRECTIVE_NUDGE_NEGATIVE_RE as _NEGATIVE_RE
    from recall import looks_like_standing_rule as _looks_like_standing_rule
except Exception:  # pragma: no cover - defensive import guard
    _NEGATIVE_RE = re.compile(r"(?!x)x")  # matches nothing → scrub is a no-op

    def _looks_like_standing_rule(_text):  # type: ignore
        # If recall.py can't be imported, fall back to the high-precision
        # detector alone rather than wedging the hook. (Never expected in
        # practice — recall.py ships in the same plugin tree.)
        return True


# High-confidence, high-precision "durable standing rule" detector. Fires only
# on explicit standing-rule / preference / identity framings that read as
# durable on their face. Bare "always"/"never"/"stop …"/"don't …" (without a
# standing frame), and pure world-fact corrections ("we no longer use X" —
# recall/retain handle those, they aren't behavioural directives), are
# intentionally omitted: the blocking re-prompt is more intrusive than Stage
# B's advisory nudge, so its trigger set is narrower and directive-shaped only.
#
# looks_like_durable_directive() additionally AND-gates this against
# recall.py's inclusive looks_like_standing_rule, so the durable trigger set is
# a GUARANTEED SUBSET of Stage B's nudge trigger set — Stage C can never block
# on a turn Stage B wouldn't even have nudged on.
_DURABLE_DIRECTIVE_RE = re.compile(
    r"""(?ix)
    (?:
      # --- explicit temporal / standing-rule framings ---
        \b from \s+ now \s+ on \b
      | \b going \s+ forwards? \b
      | \b in \s+ (?: the \s+ )? future \b
      | \b as \s+ a \s+ (?: general \s+ )?
            (?: rule | policy | principle | convention | standard | default | habit ) \b
      # --- directed standing behaviour ("you should always", "please never") ---
      | \b you \s+ (?: should | must ) \s+ (?: always | never ) \b
      | \b i \s+ want \s+ you \s+ to \s+ (?: always | never ) \b
      | \b please \s+ (?: always | never ) \b
      # --- durable preferences / identity ---
      | \b i \s* ['’]? d \s+ (?: really \s+ )? prefer \b
      | \b (?: i | we ) \s+ prefer \s+ (?: that \s+ )? you \b
      | \b call \s+ me \b
      # --- memory / reinforcement ---
      | \b remember \s+ (?: to | that | always | never ) \b
      # --- prohibitions with a durable frame ---
      | \b (?: do \s* n['’]? t | don['’]? t | dont | do \s+ not )
            \b [^.?!]{0,40} \b again \b
    )
    """
)

# Terse, bounded. Fed back to the model on a single blocked Stop. It must
# offer an explicit escape hatch (one-off → just finish) so a false positive
# is cheap and never forces a spurious directive.
_VERIFY_BLOCK_REASON = (
    "<directive_capture_verify>\n"
    "The user's last message stated a DURABLE, standing rule for how you "
    "should behave going forward (e.g. \"from now on …\", \"as a rule …\", "
    "\"you should always …\", \"call me …\", \"remember to …\", \"don't … "
    "again\"), but this turn is ending without recording it — so the "
    "correction will NOT survive the next session.\n"
    "If it is genuinely a durable rule, call "
    "mcp__hindsight__create_directive NOW (verbatim, in the user's own "
    "words), then briefly confirm you have saved it.\n"
    "If, on reflection, it was only a one-off instruction for this task, do "
    "NOT create a directive — just finish your reply normally.\n"
    "This verification fires once per turn.\n"
    "</directive_capture_verify>"
)

# Guard: skip any "user" content that is actually hook-injected context
# (recall's memories/nudge blocks), not a human message.
_INJECTED_MARKERS = (
    "<directive_capture_check>",
    "<directive_capture_verify>",
    "<hindsight_memories>",
    "Relevant memories from past conversations",
)


def looks_like_durable_directive(text) -> bool:
    """High-precision test for an explicit, durable standing rule.

    Narrower than recall.py's ``looks_like_standing_rule`` — see the module
    docstring. Pleasantries are scrubbed first (shared Stage B negative
    guard). Returns False on empty / non-string input. Pure regex; no model
    call.
    """
    if not isinstance(text, str) or not text.strip():
        return False
    scrubbed = _NEGATIVE_RE.sub(" ", text)
    if not _DURABLE_DIRECTIVE_RE.search(scrubbed):
        return False
    # Subset gate: only act where Stage B would also have nudged.
    return bool(_looks_like_standing_rule(text))


def _message_text(content) -> str:
    """Extract the human-authored text from a message's content.

    Handles the plain-string shape and the Claude Code list shape
    ``[{type:"text", text:...}, {type:"tool_use"/"tool_result", ...}]``.
    Only ``text`` parts are joined — tool_result / tool_use parts are
    ignored, so a role="user" tool-result message yields "" (correctly not a
    human turn).
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, dict) and p.get("type") == "text":
                t = p.get("text")
                if isinstance(t, str):
                    parts.append(t)
        return "\n".join(parts)
    return ""


def _is_injected(text: str) -> bool:
    return any(marker in text for marker in _INJECTED_MARKERS)


def find_last_human_turn(messages: list) -> tuple:
    """Return ``(index, text)`` of the most recent genuine human turn.

    Skips role="user" entries that are tool_result-only (no text) or
    hook-injected context blocks. Returns ``(None, "")`` when there is no
    human message.
    """
    for i in range(len(messages) - 1, -1, -1):
        msg = messages[i]
        if not isinstance(msg, dict) or msg.get("role") != "user":
            continue
        text = _message_text(msg.get("content"))
        if not text.strip():
            continue  # tool_result-only user message
        if _is_injected(text):
            continue  # recall/nudge injection, not the human
        return i, text
    return None, ""


def _directive_call_present(content) -> bool:
    """True if a message's content contains a create_directive tool_use."""
    if not isinstance(content, list):
        return False
    for p in content:
        if not isinstance(p, dict) or p.get("type") != "tool_use":
            continue
        name = p.get("name", "")
        if isinstance(name, str) and "create_directive" in name:
            return True
    return False


def directive_recorded_after(messages: list, start_index: int) -> bool:
    """True if any assistant turn after ``start_index`` called create_directive."""
    for msg in messages[start_index + 1:]:
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            continue
        if _directive_call_present(msg.get("content")):
            return True
    return False


def read_transcript(transcript_path: str) -> list:
    """Read a JSONL transcript into a list of message dicts (role/content).

    Mirrors retain.py.read_transcript: supports the nested Claude Code shape
    ``{type, message:{role, content}}`` and the flat testing shape
    ``{role, content}``.
    """
    if not transcript_path or not os.path.isfile(transcript_path):
        return []
    messages = []
    try:
        with open(transcript_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("type") in ("user", "assistant"):
                    msg = entry.get("message", {})
                    if isinstance(msg, dict) and msg.get("role"):
                        messages.append(msg)
                elif "role" in entry and "content" in entry:
                    messages.append(entry)
    except OSError:
        pass
    return messages


def evaluate(hook_input: dict, config: dict) -> str | None:
    """Core decision. Returns a block reason string, or None to allow stop.

    None → the turn is allowed to end (no-op). A non-empty string → block the
    stop once and feed the string back to the model.
    """
    # Same knob as Stage B — disabling the nudge disables this verification.
    if not config.get("directiveCaptureNudge", True):
        debug_log(config, "Directive-capture verify: feature disabled, allowing stop")
        return None

    # Loop / one-off guard: if we already blocked once this turn, respect the
    # model's second judgment and never re-block.
    if hook_input.get("stop_hook_active"):
        debug_log(config, "Directive-capture verify: stop_hook_active, not re-blocking")
        return None

    messages = read_transcript(hook_input.get("transcript_path", ""))
    if not messages:
        return None

    idx, text = find_last_human_turn(messages)
    if idx is None:
        return None

    if not looks_like_durable_directive(text):
        return None

    if directive_recorded_after(messages, idx):
        debug_log(config, "Directive-capture verify: create_directive already called, allowing stop")
        return None

    debug_log(
        config,
        "Directive-capture verify: durable rule stated, no create_directive call — blocking once",
    )
    return _VERIFY_BLOCK_REASON


def main():
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        # No input → nothing to verify. Allow stop.
        return
    try:
        config = load_config()
    except Exception:
        return
    try:
        reason = evaluate(hook_input, config)
    except Exception as e:  # never wedge a turn on a verify bug
        debug_log(config, f"Directive-capture verify error (allowing stop): {e}")
        return
    if reason:
        # Claude Code Stop-hook block contract: emit decision=block + reason;
        # the model continues the turn with `reason` as feedback.
        print(json.dumps({"decision": "block", "reason": reason}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # absolute backstop — Stop must never hard-fail
        print(f"[Hindsight] Unexpected error in directive_verify: {e}", file=sys.stderr)
        try:
            sys.exit(2 if load_config().get("debug") else 0)
        except Exception:
            sys.exit(0)
