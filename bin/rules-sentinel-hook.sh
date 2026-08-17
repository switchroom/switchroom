#!/bin/bash
# SessionStart hook — Memory v2 M1 rules-block tamper sentinel
# (carve-M1.md §3, red-team-M1.md §B/§C, MINOR fixes #6/#7).
#
# Recomputes the rules block's sha256 sentinel + the mutation-log hash
# chain and compares against what's embedded in the agent's own
# CLAUDE.md. Purely advisory in M1 (dark build — no `memory.rules_block`
# agent exists live yet): this hook exists so the wiring, the read-only
# discipline, and the fast no-op path are all proven out and tested
# BEFORE M3 flips the flag on any real agent.
#
# STRICT DISCIPLINE (red-team §C, root-owned-overlay EACCES hazard):
#   - READ-ONLY. This script must NEVER write to the agent's tree. A
#     root-invoked write here would leave a root-owned file behind and
#     EACCES the agent's own subsequent writes to it (the exact failure
#     class that dropped clerk's crons for weeks — see this repo's
#     CLAUDE.md "root-tier host access" section). `switchroom memory
#     rule verify` (the CLI path) is the only writer-adjacent tool, and
#     even IT never writes — verify is read-only too.
#   - Prints to STDOUT, not stderr. SessionStart hook stdout is added to
#     the model's context (unlike PreCompact); a stderr message would be
#     silently dropped by Claude Code's hook contract, defeating the
#     entire point of a tamper *sentinel* — see this file's own header
#     precedent in bin/timezone-hook.sh for the additionalContext
#     mechanism this hook reuses (NOT because "no additionalContext
#     emitter exists" — one already does, in timezone-hook.sh and
#     scaffold.ts; this hook simply needs the same JSON shape).
#   - No-ops FAST and SILENTLY when the rules-block markers are absent
#     (the M1/M3-flag-off dark case, and the pre-first-rule case even
#     with the flag on) — never print a divergence notice about a block
#     that was never created.
#
# Wiring note (MINOR fix #7): unlike working-state-reload-hook.sh
# (matcher: "compact" — fires ONLY on compaction), this hook is wired
# with NO matcher, so it fires on every SessionStart source (startup,
# resume, clear, fork, compact). That is a deliberate divergence: a
# tamper sentinel that only checked itself after compaction would miss
# tampering that happened between a fresh boot and the first compaction
# (the common case for a short-lived session). The check itself is a
# single local file read + a hash compare — cheap enough to run on every
# boot without a latency concern (contrast working-state-reload's
# network-hop briefing, which specifically justified restricting itself
# to the compact matcher).
#
# Exit code: 0 always. A hook that exits non-zero BLOCKS the turn in
# Claude Code; a tamper signal must degrade to a visible notice, never
# a hard stop (the same "failure modes are silent" doctrine as
# timezone-hook.sh).

set -u

CLAUDE_MD="${CLAUDE_PROJECT_DIR:-}/CLAUDE.md"

if [ -z "${CLAUDE_PROJECT_DIR:-}" ] || [ ! -f "$CLAUDE_MD" ]; then
  exit 0
fi

# Fast no-op: markers absent (dark build / no rules yet). grep -q is a
# single pass over the file, no subshell fork per line.
if ! grep -q '<!-- switchroom:rules:begin -->' "$CLAUDE_MD" 2>/dev/null; then
  exit 0
fi

# Delegate the actual sentinel recompute to the CLI verb this module
# already ships (`switchroom memory rule verify <agent>`), which reuses
# rules-store.ts's verifyIntegrity — one recompute implementation, not
# two (a bash reimplementation of the sha256-over-canonical-JSON
# encoding would be a second place for the two encodings to drift).
# `switchroom` is expected on PATH inside the agent container image;
# if it's missing, degrade silently rather than error the turn.
if ! command -v switchroom >/dev/null 2>&1; then
  exit 0
fi

AGENT_NAME="$(basename "${CLAUDE_PROJECT_DIR:-}")"
VERIFY_OUT="$(switchroom memory rule verify "$AGENT_NAME" 2>&1)"
VERIFY_EXIT=$?

# Exit-code contract (memory-rules.ts `verify`):
#   0 = clean; 2 = GENUINE TAMPER; any other non-zero = an ENVIRONMENT
#   failure (config unreadable, agent-dir mismatch, withConfigError exit 1,
#   `switchroom` bug). Only code 2 warrants injecting a tamper notice into
#   the model's context — an environment failure that hard-injected "tamper
#   FAILED" would cry wolf on every broken boot and erode the signal. Degrade
#   silently on everything that is not an unambiguous tamper.
if [ "$VERIFY_EXIT" -ne 2 ]; then
  exit 0
fi

MSG="Rules-block tamper sentinel FAILED for \"$AGENT_NAME\": ${VERIFY_OUT}"

if command -v jq >/dev/null 2>&1; then
  jq -cn --arg msg "$MSG" \
    '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$msg}}'
else
  ESCAPED=${MSG//\\/\\\\}
  ESCAPED=${ESCAPED//\"/\\\"}
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$ESCAPED"
fi

exit 0
