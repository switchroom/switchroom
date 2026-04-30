#!/usr/bin/env bash
# boot-self-test.sh — pre-flight an agent's auth state at boot and
# record findings to the issue sink. Phase 0.3 of #424, refactored
# in #429 1.3 to delegate diagnosis to `switchroom auth heal --json`
# so the boot self-test and the heal CLI speak with one voice.
#
# Invoked by start.sh after env is set up, before `claude` launches.
# Best-effort throughout: every check that can fail does so cleanly,
# and the script always exits 0 — boot must not be blocked by
# visibility tooling.
#
# Why delegate to heal:
# Previously this script ran a bare `claude -p hello` with the env
# stripped to detect "would a hook subprocess work." That produced
# `cli_unauthenticated:critical` for any agent whose `.credentials.json`
# was unreliable — including agents whose .oauth-token still works
# fine for the only consumer that actually shells `claude -p` (the
# handoff hook, which routes around the env strip via Phase 1.2's
# disk injection in defaultClaudeCliRunner). Result: false-positive
# critical issue cards on Telegram.
#
# heal's diagnoser inspects `.credentials.json` + `.oauth-token`
# structurally and severity-ranks per the actual operational risk:
# expired access token = error (will break), no refreshToken = warn
# (works today, breaks later), creds-missing-but-oauth-token-present
# = warn (handoff works via fallback). That matches what users care
# about. cli_unauthenticated as a separate empirical check is
# dropped — heal's structural view is sufficient and more accurate.

set -u

AGENT_NAME="${SWITCHROOM_AGENT_NAME:-}"
STATE_DIR="${TELEGRAM_STATE_DIR:-}"
CLAUDE_CONFIG_DIR_LOCAL="${CLAUDE_CONFIG_DIR:-}"

if [ -z "$AGENT_NAME" ] || [ -z "$STATE_DIR" ] || [ -z "$CLAUDE_CONFIG_DIR_LOCAL" ]; then
  echo "boot-self-test: missing required env (SWITCHROOM_AGENT_NAME, TELEGRAM_STATE_DIR, CLAUDE_CONFIG_DIR); skipping" >&2
  exit 0
fi

# Locate the switchroom CLI.
if [ -n "${SWITCHROOM_CLI_PATH:-}" ] && [ -x "$SWITCHROOM_CLI_PATH" ]; then
  SWITCHROOM_CLI="$SWITCHROOM_CLI_PATH"
elif command -v switchroom >/dev/null 2>&1; then
  SWITCHROOM_CLI="$(command -v switchroom)"
else
  echo "boot-self-test: switchroom CLI not found; cannot record issues" >&2
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "boot-self-test: jq not found; cannot parse heal output, skipping" >&2
  exit 0
fi

# All fingerprints we may toggle. If a code is NOT in heal's findings
# this run, we resolve it (so the issue card auto-clears once the
# user fixes the underlying problem). cli_unauthenticated is listed
# so its prior occurrences (from older boot-self-test versions) get
# resolved on the next boot under the new logic.
ALL_CODES=(credentials_missing token_expired refresh_token_missing credentials_malformed cli_unauthenticated)

record() {
  # record <code> <severity> <summary> [<detail>]
  local code="$1" severity="$2" summary="$3" detail="${4:-}"
  if [ -n "$detail" ]; then
    printf '%s' "$detail" | "$SWITCHROOM_CLI" issues record \
      --severity "$severity" \
      --source "boot:auth-check" \
      --code "$code" \
      --summary "$summary" \
      --detail-stdin --quiet \
      --state-dir "$STATE_DIR" --agent "$AGENT_NAME" \
      >/dev/null 2>&1 || true
  else
    "$SWITCHROOM_CLI" issues record \
      --severity "$severity" \
      --source "boot:auth-check" \
      --code "$code" \
      --summary "$summary" \
      --quiet \
      --state-dir "$STATE_DIR" --agent "$AGENT_NAME" \
      >/dev/null 2>&1 || true
  fi
}

resolve_one() {
  "$SWITCHROOM_CLI" issues resolve \
    --source "boot:auth-check" --code "$1" \
    --state-dir "$STATE_DIR" \
    >/dev/null 2>&1 || true
}

# Run heal --json. It has its own opinionated severity ranking and
# matches the codes we use in the issue sink; we trust its findings
# one-for-one. heal exits 0 for ok/warn and 2 for error/critical;
# either way the JSON is on stdout.
DIAG_JSON=$("$SWITCHROOM_CLI" auth heal "$AGENT_NAME" --json --config-dir "$CLAUDE_CONFIG_DIR_LOCAL" 2>/dev/null || true)

if [ -z "$DIAG_JSON" ]; then
  # heal failed to run. Don't pretend success — record an info-level
  # entry so this is visible without escalating severity.
  record auth_diagnosis_failed warn \
    "$AGENT_NAME boot self-test: \`switchroom auth heal\` produced no output" \
    "The auth heal command failed to run or returned no JSON. Boot continues."
  exit 0
fi

# Resolve cli_unauthenticated unconditionally — it's no longer
# produced by this script, and any leftover entries from older
# versions should clean up on the next reconcile + restart.
resolve_one cli_unauthenticated

# Walk findings; record each present, resolve each absent code.
PRESENT_CODES=$(printf '%s' "$DIAG_JSON" | jq -r '.findings[]?.code' 2>/dev/null)

for code in "${ALL_CODES[@]}"; do
  [ "$code" = "cli_unauthenticated" ] && continue # already resolved above
  if printf '%s\n' "$PRESENT_CODES" | grep -qx "$code"; then
    severity=$(printf '%s' "$DIAG_JSON" | jq -r --arg c "$code" '.findings[] | select(.code == $c) | .severity' | head -1)
    summary=$(printf '%s' "$DIAG_JSON" | jq -r --arg c "$code" '.findings[] | select(.code == $c) | .summary' | head -1)
    # Build a detail block: include heal's recommendation so the
    # issue card detail is directly actionable.
    recommendation=$(printf '%s' "$DIAG_JSON" | jq -r '.recommendation[]?' 2>/dev/null)
    detail="Run \`switchroom auth heal $AGENT_NAME\` for full diagnosis."
    if [ -n "$recommendation" ]; then
      detail="$detail
$recommendation"
    fi
    record "$code" "$severity" "$AGENT_NAME $summary" "$detail"
  else
    resolve_one "$code"
  fi
done

# Resolve any leftover legacy code if it wasn't in ALL_CODES — keeps
# the script robust against drift between boot-self-test and the
# diagnoser over future versions.
resolve_one auth_diagnosis_failed

exit 0
