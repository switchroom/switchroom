#!/usr/bin/env bash
# Integration test: watchdog skips genuinely-idle agents (issue #116 follow-up).
#
# Verifies the recent-activity gate added to bridge-watchdog.sh: an agent
# whose latest journal entry is older than RECENT_ACTIVITY_WINDOW_SECS is
# treated as idle (not hung) and is NOT restarted, even if the silence
# duration would otherwise trigger the hard threshold.
#
# Without this gate, the watchdog would false-positive any agent that
# went a long time between user messages — overnight, weekends, agents
# the user hasn't talked to in hours.
#
# Setup:
#   - Agent unit is active (mocked systemctl reports it so).
#   - Agent has been running 4 hours (well past UPTIME_GRACE_SECS).
#   - Latest journal entry is 2 hours old (past RECENT_ACTIVITY_WINDOW_SECS).
#   - Pre-seeded silence_since marker that WOULD trigger restart absent
#     the new gate.
#
# Expected: watchdog observes the silence, applies the recent-activity
# gate, finds NO recent activity, treats as idle, clears the marker,
# does NOT call switchroom agent restart.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WATCHDOG="${SCRIPT_DIR}/../../bin/bridge-watchdog.sh"

if [[ ! -f "$WATCHDOG" ]]; then
  echo "FAIL: watchdog script not found at $WATCHDOG" >&2
  exit 1
fi

# ─── Temp workspace ──────────────────────────────────────────────────────────

TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

MOCK_BIN="${TMPDIR_TEST}/mock-bin"
mkdir -p "$MOCK_BIN"

# Restart capture file — the mock `switchroom` writes here when called.
# In the idle-skip test, this file MUST stay empty.
RESTART_LOG="${TMPDIR_TEST}/restart.log"

# ─── Epoch arithmetic ────────────────────────────────────────────────────────

NOW="$(date +%s)"
# Agent started 4h ago — well past 90s UPTIME_GRACE_SECS.
ACTIVE_ENTER_EPOCH=$(( NOW - 14400 ))
ACTIVE_ENTER_TS="$(date -d "@${ACTIVE_ENTER_EPOCH}" '+%a %Y-%m-%d %H:%M:%S %Z' 2>/dev/null \
  || date -r "$ACTIVE_ENTER_EPOCH" '+%a %Y-%m-%d %H:%M:%S %Z' 2>/dev/null \
  || echo "Mon 2026-01-01 00:00:00 UTC")"

# Latest journal entry is 2 hours old. With RECENT_ACTIVITY_WINDOW_SECS=3600
# (1h), this is OUTSIDE the window — agent is treated as idle, not hung.
JOURNAL_ENTRY_EPOCH=$(( NOW - 7200 ))

# Pre-seeded silence_since marker that WOULD trigger restart in the
# absence of the recent-activity gate (well past 600s hard threshold).
SILENCE_SINCE_EPOCH=$(( NOW - 1800 ))

# ─── Mock: systemctl ─────────────────────────────────────────────────────────

cat > "${MOCK_BIN}/systemctl" << MOCK_SYSTEMCTL
#!/usr/bin/env bash
if [[ "\$*" == *"list-units"*"--type=service"* ]]; then
  if [[ "\$*" == *"active"* ]]; then
    echo "switchroom-idleagent-gateway.service"
    echo "switchroom-idleagent.service"
  fi
  exit 0
fi
if [[ "\$*" == *"show"* ]]; then
  if [[ "\$*" == *"gateway"* ]] && [[ "\$*" == *"WorkingDirectory"* ]]; then
    echo "${TMPDIR_TEST}/gateway-state"
    exit 0
  fi
  if [[ "\$*" == *"idleagent.service"* ]] && [[ "\$*" == *"ActiveEnterTimestamp"* ]]; then
    echo "${ACTIVE_ENTER_TS}"
    exit 0
  fi
  if [[ "\$*" == *"idleagent.service"* ]] && [[ "\$*" == *"ActiveState"* ]]; then
    echo "active"
    exit 0
  fi
  exit 0
fi
if [[ "\$*" == *"is-active"* ]]; then
  exit 0
fi
if [[ "\$*" == *"start"* ]] || [[ "\$*" == *"restart"* ]]; then
  exit 0
fi
exit 0
MOCK_SYSTEMCTL
chmod +x "${MOCK_BIN}/systemctl"

# ─── Mock: journalctl ────────────────────────────────────────────────────────

cat > "${MOCK_BIN}/journalctl" << MOCK_JOURNALCTL
#!/usr/bin/env bash
echo "${JOURNAL_ENTRY_EPOCH}.000000 \$(hostname) switchroom-idleagent[1234]: last log line"
exit 0
MOCK_JOURNALCTL
chmod +x "${MOCK_BIN}/journalctl"

# ─── Mock: switchroom ────────────────────────────────────────────────────────

cat > "${MOCK_BIN}/switchroom" << MOCK_SWITCHROOM
#!/usr/bin/env bash
echo "switchroom \$*" >> "${RESTART_LOG}"
exit 0
MOCK_SWITCHROOM
chmod +x "${MOCK_BIN}/switchroom"

# ─── Mock: ss ───────────────────────────────────────────────────────────────

cat > "${MOCK_BIN}/ss" << MOCK_SS
#!/usr/bin/env bash
exit 0
MOCK_SS
chmod +x "${MOCK_BIN}/ss"

# ─── Mock: logger ────────────────────────────────────────────────────────────

cat > "${MOCK_BIN}/logger" << MOCK_LOGGER
#!/usr/bin/env bash
exit 0
MOCK_LOGGER
chmod +x "${MOCK_BIN}/logger"

# ─── Gateway state dir ───────────────────────────────────────────────────────

GATEWAY_STATE="${TMPDIR_TEST}/gateway-state"
mkdir -p "$GATEWAY_STATE"
touch "${GATEWAY_STATE}/gateway.log"
DISC_MARKER="${GATEWAY_STATE}/.watchdog-disconnect-since"
echo "$(( NOW - 5 ))" > "$DISC_MARKER"
touch "${GATEWAY_STATE}/.bridge-alive"

# ─── Watchdog state dir with pre-seeded silence marker ───────────────────────

WATCHDOG_STATE_DIR="${TMPDIR_TEST}/watchdog-state"
mkdir -p "$WATCHDOG_STATE_DIR"
echo "$SILENCE_SINCE_EPOCH" > "${WATCHDOG_STATE_DIR}/idleagent.silence_since"

# ─── Run the watchdog ────────────────────────────────────────────────────────

# Use the same tight thresholds as the hang-detection test, but keep the
# default RECENT_ACTIVITY_WINDOW_SECS=3600 so the 2h-old entry is OUT of
# the recent-activity window. The gate should kick in and skip restart.
export PATH="${MOCK_BIN}:${PATH}"
WATCHDOG_STATE_DIR="$WATCHDOG_STATE_DIR" \
UPTIME_GRACE_SECS=90 \
JOURNAL_SILENCE_SECS=10 \
JOURNAL_SILENCE_HARD_SECS=10 \
DISCONNECT_GRACE_SECS=9999 \
LIVENESS_GRACE_SECS=60 \
bash "$WATCHDOG" 2>/dev/null || true

# ─── Assertions ──────────────────────────────────────────────────────────────

PASS=0
FAIL=0

check() {
  local desc="$1"
  local result="$2"
  if [[ "$result" == "true" ]]; then
    echo "PASS: $desc"
    PASS=$(( PASS + 1 ))
  else
    echo "FAIL: $desc" >&2
    FAIL=$(( FAIL + 1 ))
  fi
}

# Assert: switchroom agent restart was NOT called.
if [[ ! -f "$RESTART_LOG" ]] || ! grep -q "switchroom agent restart" "$RESTART_LOG" 2>/dev/null; then
  check "watchdog did NOT restart idle agent" "true"
else
  check "watchdog did NOT restart idle agent" "false"
  echo "  restart.log contents:" >&2
  cat "$RESTART_LOG" 2>/dev/null || true
fi

# Assert: stale silence_since marker was cleared (because the agent is
# now classified as idle, not silent-and-suspect).
if [[ ! -f "${WATCHDOG_STATE_DIR}/idleagent.silence_since" ]]; then
  check "stale silence_since marker was cleared on idle classification" "true"
else
  check "stale silence_since marker was cleared on idle classification" "false"
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
