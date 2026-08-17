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
from lib.directives import (  # noqa: E402
    DIRECTIVES_CACHE_TTL_SECONDS,
    invalidate_directives_cache,
    parse_active_directives_block,
    rule_already_captured,
)
from lib import recall_buffer  # noqa: E402

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
    "UNLESS an equivalent active directive already exists (see the "
    "<active_directives> block for this turn) — in that case it is already "
    "saved; do NOT create a duplicate, just finish.\n"
    "If the rule can be enforced deterministically — a settings.json hook, "
    "a permission rule, a skill/script edit, or a config change — prefer "
    "that (instead of, or in addition to, the directive) and say which you "
    "did; reserve a directive for judgment rules code cannot enforce.\n"
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
    # recall.py injects the bank's active directives as a top-of-prompt block;
    # it is hook-injected context, not a human turn (#2903 Fix 6.2).
    "<active_directives>",
    "Relevant memories from past conversations",
)

# SWITCHROOM DIVERGENCE (#2903 Fix 6.3): the `<channel source="...">` envelope
# grammar and the human-source whitelist used to be hard-coded inline here,
# silently coupling this vendored Python guard to the switchroom gateway's TS
# wire format. Extracted to lib/switchroom_envelope.py so a TS-side envelope
# change has ONE obvious Python counterpart to update (and its own test) rather
# than breaking this guard undetected. `is_synthetic_inbound` is re-exported for
# backward compatibility with existing tests/callers.
from lib.switchroom_envelope import is_synthetic_inbound  # noqa: E402,F401


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


def _directive_call_ids(content) -> list:
    """Return the tool_use ids of any create_directive calls in a message's
    content (empty list if none)."""
    ids = []
    if not isinstance(content, list):
        return ids
    for p in content:
        if not isinstance(p, dict) or p.get("type") != "tool_use":
            continue
        name = p.get("name", "")
        if isinstance(name, str) and "create_directive" in name:
            # Track the id so we can pair it with its tool_result and reject a
            # call whose write ERRORED. A call with no id still counts as a
            # (best-effort) attempt — see _directive_call_present.
            ids.append(p.get("id"))
    return ids


def _directive_call_present(content) -> bool:
    """True if a message's content contains a create_directive tool_use."""
    return len(_directive_call_ids(content)) > 0


# SWITCHROOM DIVERGENCE (#2903, Fix 1.3): a create_directive tool_use whose
# tool_result came back with an error must NOT count as "recorded". A hindsight
# tools/call returns HTTP 200 + is_error:true on failure (engine down / renamed
# arg / isError envelope); without this the verifier would see the call, treat
# the correction as captured, and never fire its one bounded re-prompt — the
# same false-success class that made chat show "📌 remembered" for a failed
# write. We scan subsequent user messages for the matching tool_result id and
# treat is_error:true (or an error-shaped text result) as NOT-recorded.
def _errored_tool_use_ids(messages: list) -> set:
    """Collect tool_use ids whose tool_result reported an error."""
    errored = set()
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for p in content:
            if not isinstance(p, dict) or p.get("type") != "tool_result":
                continue
            if p.get("is_error") is True:
                tid = p.get("tool_use_id")
                if tid is not None:
                    errored.add(tid)
    return errored


def collect_active_directive_contents(messages: list) -> list:
    """Gather the CONTENT strings of every active directive injected into this
    turn's context.

    recall.py injects an ``<active_directives>`` block (the bank's currently
    active directives) into the UserPromptSubmit context; it shows up in the
    transcript as an injected user message. We parse those back out so the
    verifier can tell whether a restated rule is ALREADY stored — in which case
    the model correctly declines to re-create it and we must NOT block (#2903
    Fix 6.2). Pure string parsing; no API call.
    """
    contents: list = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        text = _message_text(msg.get("content"))
        if "<active_directives>" in text:
            contents.extend(parse_active_directives_block(text))
    return contents


def directive_recorded_after(messages: list, start_index: int) -> bool:
    """True if any assistant turn after ``start_index`` called create_directive
    with a SUCCESSFUL result. A call whose tool_result errored does not count
    (SWITCHROOM DIVERGENCE #2903, Fix 1.3) — so the verifier still re-prompts
    once for a durable rule whose write failed."""
    errored = _errored_tool_use_ids(messages)
    for msg in messages[start_index + 1:]:
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            continue
        ids = _directive_call_ids(msg.get("content"))
        if not ids:
            continue
        # Recorded only if at least one create_directive call did NOT error.
        # A call with a None id (older/testing shape carrying no id) has no
        # pairable result, so treat it as a successful attempt (prior behaviour).
        for tid in ids:
            if tid is None or tid not in errored:
                return True
    return False


# --- Directives-cache invalidation (switchroom hindsight-leverage A4) ---------
#
# recall.py caches the bank's active-directives list with a short TTL to skip an
# HTTP round-trip on the critical path. That cache would otherwise stay stale
# until the TTL elapsed — so this Stop hook, which already re-reads the turn's
# transcript, deletes the cache whenever the just-ended turn performed a
# directive WRITE (create/update/delete). The next recall then re-fetches, so an
# in-session directive change is visible in the very next turn's
# <active_directives> block (cross-process writes still rely on TTL alone).

# Matches the hindsight directive-write MCP tools by their bare or namespaced
# name, e.g. "create_directive", "mcp__hindsight__update_directive",
# "delete_directive". Read-only "list_directives" is deliberately excluded.
_DIRECTIVE_WRITE_TOOL_RE = re.compile(r"(?:create|update|delete)_directive")


def _is_directive_write_tool(name) -> bool:
    return isinstance(name, str) and bool(_DIRECTIVE_WRITE_TOOL_RE.search(name))


def turn_contains_directive_write(messages: list, start_index: int) -> bool:
    """True if any assistant turn after ``start_index`` issued a directive-write
    tool_use (create/update/delete). ``start_index = -1`` scans all messages
    (used when there is no human turn, e.g. a synthetic/cron inbound that still
    wrote a directive). Pure inspection; no API call."""
    for msg in messages[start_index + 1:]:
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for p in content:
            if (
                isinstance(p, dict)
                and p.get("type") == "tool_use"
                and _is_directive_write_tool(p.get("name", ""))
            ):
                return True
    return False


def invalidate_cache_on_directive_write(messages: list, config: dict) -> None:
    """Delete the directives cache if this turn wrote a directive.

    Takes the ALREADY-READ transcript ``messages`` (main() reads the transcript
    exactly once and shares it with the capture verifier — a Stop hook must not
    parse a multi-MB session twice). Only the tail after the last human turn is
    scanned, since only writes issued THIS turn matter. Runs independently of
    the capture-verify decision (and of the directiveCaptureNudge knob) — the
    cache is a separate feature. Best-effort; never raises, so a bug here can
    never wedge Stop.
    """
    try:
        if not messages:
            return
        idx, _text = find_last_human_turn(messages)
        start = idx if idx is not None else -1
        if turn_contains_directive_write(messages, start):
            invalidate_directives_cache()
            debug_log(config, "Directives cache invalidated — turn wrote a directive")
    except Exception as e:  # pragma: no cover - defensive; Stop must not wedge
        debug_log(config, f"Directives cache invalidation skipped (error): {e}")


def invalidate_prefetch_buffer_on_directive_write(messages: list, config: dict, session_id: str) -> None:
    """Drop this session's pending M4 prefetch buffer if this turn wrote a
    directive (create/update/delete/retire).

    red-team-M3 R2 (BLOCKER): the A4 cache invalidation above keeps the fresh
    <active_directives> block current, but the M4 prefetch buffer carries a
    RECALLED memories block captured at a prior turn's Stop — and a rule/
    directive that was just retired can survive in that snapshot as recalled
    text. Without this, a buffer prefetched while the rule was active would
    re-inject the retired rule on the next turn (the exact §4.4 resurrection
    failure), and `run_prefetch` bailing on an empty recall would leave that
    stale buffer to be served on later turns too. Deleting the buffer + sentinel
    here forces the consumer to fall to the synchronous, always-current path
    (or the explicitly stale-marked fallback) instead of resurrecting it.

    Only fires when `memoryPrefetchEnabled` is on (the buffer only exists then)
    — a cheap no-op statting two absent files otherwise, so gated to avoid it.
    Self-guarded; never raises (a Stop hook must not wedge a turn).
    """
    try:
        if not messages or not config.get("memoryPrefetchEnabled", False):
            return
        idx, _text = find_last_human_turn(messages)
        start = idx if idx is not None else -1
        if turn_contains_directive_write(messages, start):
            recall_buffer.invalidate(session_id or "unknown")
            debug_log(config, "Prefetch buffer invalidated — turn wrote a directive (R2 resurrection guard)")
    except Exception as e:  # pragma: no cover - defensive; Stop must not wedge
        debug_log(config, f"Prefetch-buffer invalidation skipped (error): {e}")


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


def evaluate(hook_input: dict, config: dict, messages: list | None = None) -> str | None:
    """Core decision. Returns a block reason string, or None to allow stop.

    None → the turn is allowed to end (no-op). A non-empty string → block the
    stop once and feed the string back to the model.

    ``messages`` is the pre-read transcript when the caller already parsed it
    (main() reads once and shares it); when None, the transcript is read here so
    direct callers/tests keep the old single-arg contract.
    """
    # Same knob as Stage B — disabling the nudge disables this verification.
    if not config.get("directiveCaptureNudge", True):
        debug_log(config, "Directive-capture verify: feature disabled, allowing stop")
        return None

    # #2873/#2903 Fix 6.2 — the BLOCK is separately gated: an operator can keep
    # the advisory Stage B nudge while dropping the more intrusive Stop block.
    if not config.get("directiveCaptureVerify", True):
        debug_log(config, "Directive-capture verify: block disabled (nudge-only), allowing stop")
        return None

    # Loop / one-off guard: if we already blocked once this turn, respect the
    # model's second judgment and never re-block.
    if hook_input.get("stop_hook_active"):
        debug_log(config, "Directive-capture verify: stop_hook_active, not re-blocking")
        return None

    if messages is None:
        messages = read_transcript(hook_input.get("transcript_path", ""))
    if not messages:
        return None

    idx, text = find_last_human_turn(messages)
    if idx is None:
        return None

    # Non-interactive turn guard: cron / synthesized-inbound turns (resume,
    # reaction, vault-grant, subagent-handback, obligation-represent, …) are
    # machine turns, not human corrections. Never block Stop to nag capture on
    # them — that's spurious. (See is_synthetic_inbound.)
    if is_synthetic_inbound(text):
        debug_log(config, "Directive-capture verify: synthetic/cron inbound, allowing stop")
        return None

    if not looks_like_durable_directive(text):
        return None

    if directive_recorded_after(messages, idx):
        debug_log(config, "Directive-capture verify: create_directive already called, allowing stop")
        return None

    # Dedup (#2903 Fix 6.2): if the restated rule is already covered by an
    # active directive injected into this turn's <active_directives> block, the
    # model CORRECTLY declined to re-create a duplicate — blocking here would
    # nag it to double-store. Allow stop.
    existing = collect_active_directive_contents(messages)
    if existing and rule_already_captured(text, existing):
        debug_log(
            config,
            "Directive-capture verify: rule already covered by an active directive, allowing stop",
        )
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

    # Read the transcript AT MOST ONCE and share it with both consumers below
    # (a Stop hook must not parse a multi-MB session twice, nor at all when
    # nothing here needs it). Two features want the transcript:
    #   * A4 directives-cache invalidation — only when the cache is enabled
    #     (TTL > 0); with the cache off there is nothing to invalidate.
    #   * capture-verify (evaluate) — only when the nudge+verify knobs are on
    #     and this is not an already-blocked re-fire.
    ttl = config.get("directivesCacheTtlSeconds", DIRECTIVES_CACHE_TTL_SECONDS)
    cache_on = isinstance(ttl, (int, float)) and ttl > 0
    prefetch_on = bool(config.get("memoryPrefetchEnabled", False))
    verify_maybe = (
        config.get("directiveCaptureNudge", True)
        and config.get("directiveCaptureVerify", True)
        and not hook_input.get("stop_hook_active")
    )

    messages: list = []
    if cache_on or verify_maybe or prefetch_on:
        messages = read_transcript(hook_input.get("transcript_path", ""))

    # A4: invalidate the directives cache when this turn wrote a directive, so
    # the change is visible on the very next recall. Independent of the
    # capture-verify decision below and self-guarded — runs on every Stop.
    if cache_on:
        invalidate_cache_on_directive_write(messages, config)

    # R2 (BLOCKER): invalidate this session's M4 prefetch buffer when this turn
    # wrote/retired a directive, so a stale pre-retire snapshot can never
    # resurrect the retired rule on a later turn. Self-guarded no-op when
    # prefetch is off.
    if prefetch_on:
        invalidate_prefetch_buffer_on_directive_write(
            messages, config, hook_input.get("session_id") or "unknown"
        )

    try:
        reason = evaluate(hook_input, config, messages=messages)
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
