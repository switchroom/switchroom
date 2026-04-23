#!/bin/bash
# UserPromptSubmit hook that emits the agent's current local time.
#
# Switchroom agents run as long-lived Claude Code processes. Inbound Telegram
# messages arrive with UTC timestamps (e.g. ts="2026-04-23T00:37:12Z"), and
# the LLM — having no other clock — infers that UTC is "now." On a host whose
# operator lives in Australia/Melbourne that's 10–11 hours off, and the
# agent will cheerfully tell the user "good morning" at 10pm local time.
#
# This hook fires on every UserPromptSubmit and prints a one-line hint that
# Claude Code prepends to the prompt as additionalContext, so the LLM sees
# fresh local time each turn. The resolved zone is passed in via
# SWITCHROOM_TIMEZONE (baked into the agent's systemd unit at scaffold/
# reconcile time). If unset we fall back to UTC — same default as the
# resolver — so the hook never fails loudly.
#
# Stale-install detection: when SWITCHROOM_TIMEZONE is unset we also annotate
# the hint with an in-band WARNING. This makes the failure visible to the
# agent (and thus to the user), rather than silently emitting "UTC" while the
# operator's real zone is Australia/Melbourne. Typical cause: an install
# upgraded past the timezone-awareness PR without re-running
# `switchroom systemd install` to refresh the unit files.
#
# Failure modes are silent: hooks that error block the turn in Claude Code,
# and a missing timezone hint is never worse than no hint at all.

set -eu

if [ -z "${SWITCHROOM_TIMEZONE:-}" ]; then
  TZ_VAL="UTC"
  TZ_UNSET=1
else
  TZ_VAL="$SWITCHROOM_TIMEZONE"
  TZ_UNSET=0
fi

NOW=$(TZ="$TZ_VAL" date '+%Y-%m-%d %H:%M %Z (UTC%:z)')

if [ "$TZ_UNSET" = "1" ]; then
  MSG="Current local time: $NOW ($TZ_VAL — WARNING: SWITCHROOM_TIMEZONE unset; systemd unit may be stale, run \`switchroom systemd install\` to refresh)"
else
  MSG="Current local time: $NOW ($TZ_VAL)"
fi

# Emit as additionalContext so Claude Code prepends to the prompt.
# Prefer jq for JSON escaping when available (handles backticks, quotes,
# newlines); fall back to a manual escape of the few chars we might embed.
if command -v jq >/dev/null 2>&1; then
  jq -cn --arg msg "$MSG" \
    '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:$msg}}'
else
  # Manual escape: backslash, then double-quote. The message only ever
  # contains the above fixed template + TZ value + date output, none of
  # which legally contain control chars, so this is sufficient.
  ESCAPED=${MSG//\\/\\\\}
  ESCAPED=${ESCAPED//\"/\\\"}
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$ESCAPED"
fi
