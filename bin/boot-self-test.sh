#!/usr/bin/env bash
# boot-self-test.sh — pre-flight an agent's auth state at boot. Phase
# 0.3 of #424. Records issues via `switchroom issues` so a Telegram
# user sees the moment something breaks, instead of silently watching
# their handoff hook fail for weeks.
#
# Invoked by start.sh after env is set up, before `claude` launches.
# Best-effort throughout: every check that can fail does so cleanly,
# and the script always exits 0 — boot must not be blocked by visibility
# tooling.
#
# What it checks (each maps to a stable fingerprint):
#
#   auth.credentials_missing  — `.credentials.json` is absent. claude
#     code can't shell `claude -p` without it (or without a live
#     CLAUDE_CODE_OAUTH_TOKEN env, which child processes don't get —
#     see #424). Hooks that spawn `claude -p` will fail.
#
#   auth.token_expired         — `.credentials.json` parses but the
#     accessToken's expiresAt has passed.
#
#   auth.refresh_token_missing — refreshToken is empty or absent.
#     Without it, claude can't self-refresh; the agent will work today
#     but break later. Severity warn (not error) since immediate boot
#     still works.
#
#   auth.cli_unauthenticated   — `claude -p hello` actually fails
#     with the env stripped (which is what hook context looks like).
#     This is the empirical, definitive check: if it passes, hooks
#     can shell out. If it fails, they can't.
#
# On every check passing: resolve all four fingerprints. So the issue
# card auto-clears once the user fixes the underlying problem.

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

CREDS="$CLAUDE_CONFIG_DIR_LOCAL/.credentials.json"

# Fingerprints we may toggle. Listed up-front so the resolve-all path
# at the bottom doesn't drift if we add new checks.
ALL_CODES=(credentials_missing token_expired refresh_token_missing cli_unauthenticated)

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

# ─── Check 1: .credentials.json present ──────────────────────────────────────
if [ ! -f "$CREDS" ]; then
  record credentials_missing error \
    "$AGENT_NAME has no .credentials.json — claude -p from hooks will fail" \
    "Path: $CREDS\nFix: run \`switchroom auth heal $AGENT_NAME\`."
  # Skip subsequent token-shape checks; nothing to inspect.
  CREDS_PRESENT=0
else
  resolve_one credentials_missing
  CREDS_PRESENT=1
fi

# ─── Check 2: token not expired (only if creds present) ──────────────────────
if [ "$CREDS_PRESENT" -eq 1 ]; then
  # jq is preferred. If unavailable, skip these structural checks.
  if command -v jq >/dev/null 2>&1; then
    EXPIRES_AT=$(jq -r '.claudeAiOauth.expiresAt // empty' "$CREDS" 2>/dev/null)
    REFRESH_TOKEN=$(jq -r '.claudeAiOauth.refreshToken // empty' "$CREDS" 2>/dev/null)
    NOW_MS=$(($(date +%s) * 1000))
    if [ -n "$EXPIRES_AT" ] && [ "$EXPIRES_AT" -lt "$NOW_MS" ] 2>/dev/null; then
      DAYS=$(( (NOW_MS - EXPIRES_AT) / 86400000 ))
      record token_expired error \
        "$AGENT_NAME .credentials.json access token expired ${DAYS}d ago" \
        "expiresAt: $EXPIRES_AT (unix ms)\nnow:        $NOW_MS\ndelta_days: $DAYS"
    else
      resolve_one token_expired
    fi

    if [ -z "$REFRESH_TOKEN" ]; then
      record refresh_token_missing warn \
        "$AGENT_NAME .credentials.json has no refreshToken; claude can't self-refresh" \
        "Without a refreshToken, the access token will eventually expire and \`claude -p\` from hooks will start failing. Run \`switchroom auth heal $AGENT_NAME\`."
    else
      resolve_one refresh_token_missing
    fi
  fi
fi

# ─── Check 3: claude -p actually works in hook-shaped env ────────────────────
# Strip CLAUDE_CODE_OAUTH_TOKEN so this matches the env hooks see.
# Wall-clock cap so a network hang can't block boot.
if command -v claude >/dev/null 2>&1; then
  CLI_OUT=$(env -u CLAUDE_CODE_OAUTH_TOKEN \
    timeout 12 claude -p "ping" \
      --model claude-haiku-4-5-20251001 \
      --no-session-persistence </dev/null 2>&1)
  CLI_STATUS=$?
  if [ "$CLI_STATUS" -eq 124 ]; then
    # Treat timeout as warn — slow network, not a clear-cut auth break.
    record cli_unauthenticated warn \
      "$AGENT_NAME boot self-test: \`claude -p\` timed out after 12s" \
      "Network conditions or claude code subprocess startup; not necessarily an auth failure. Retry next boot."
  elif [ "$CLI_STATUS" -ne 0 ]; then
    # Tail the output to keep the issue detail readable.
    DETAIL=$(printf '%s' "$CLI_OUT" | tail -n 20)
    record cli_unauthenticated critical \
      "$AGENT_NAME boot self-test: \`claude -p\` exited $CLI_STATUS — hooks that shell claude will fail" \
      "$DETAIL"
  else
    resolve_one cli_unauthenticated
  fi
fi

exit 0
