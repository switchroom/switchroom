#!/usr/bin/env bash
# Integration test: watchdog skips chat-cadence agents (issue #405).
#
# Verifies the bug-fix from issue #405: with the new defaults
# (JOURNAL_SILENCE_SECS=4000, JOURNAL_SILENCE_HARD_SECS=4000,
# RECENT_ACTIVITY_WINDOW_SECS=3600), an agent whose latest journal entry
# is 30 minutes old (well within the recent-activity window AND well past
# the OLD 600s silence threshold) must NOT be restarted.
#
# Before the fix, this exact scenario landed in the trap zone:
#   600s (old JOURNAL_SILENCE_SECS) <= 1800s journal_age < 3600s
#                                                 (RECENT_ACTIVITY_WINDOW_SECS)
# and the watchdog would record a silence marker, wait 600s, and restart.
# That produced ~208 false-positive restarts/24h on a typical host with
# 5 chat-cadence agents.
#
# Setup:
#   - Agent unit is active (mocked).
#   - Agent has been running 4h (well past UPTIME_GRACE_SECS).
#   - Latest journal entry is 30 min old (1800s).
#   - No pre-existing silence marker (this is the first observation).
#
# Expected: with the new 4000s default JOURNAL_SILENCE_SECS, the journal
# is "fresh enough" (1800s < 4000s) and the silence branch is never
# entered. The watchdog does NOT call switchroom agent restart, and no
# silence marker is created.

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

# Restart capture file — must stay empty for this test.
RESTART_LOG="${TMPDIR_TEST}/restart.log"

# ─── Epoch arithmetic ────────────────────────────────────────────────────────

NOW="$(date +%s)"
# Agent started 4h ago — well past 90s UPTIME_GRACE_SECS.
ACTIVE_ENTER_EPOCH=$(( NOW - 14400 ))
ACTIVE_ENTER_TS="$(date -d "@${ACTIVE_ENTER_EPOCH}" '+%a %Y-%m-%d %H:%M:%S %Z' 2>/dev/null \
  || date -r "$ACTIVE_ENTER_EPOCH" '+%a %Y-%m-%d %H:%M:%S %Z' 2>/dev/null \
  || echo "Mon 2026-01-01 00:00:00 UTC")"

# Latest journal entry is 30 min (1800s) old. Under the OLD defaults
# (JOURNAL_SILENCE_SECS=600), this would land in the trap zone (>600s
# silence AND <3600s recent-activity-window). Under the NEW defaults
# (JOURNAL_SILENCE_SECS=4000), it's well below the threshold — the
# silence branch never even runs.
JOURNAL_ENTRY_EPOCH=$(( NOW - 1800 ))

# ─── Mock: systemctl ─────────────────────────────────────────────────────────

cat > "${MOCK_BIN}/systemctl" << MOCK_SYSTEMCTL
#!/usr/bin/env bash
if [[ "\$*" == *"list-units"*"--type=service"* ]]; then
  if [[ "\$*" == *"active"* ]]; then
    echo "switchroom-chatagent-gateway.service"
    echo "switchroom-chatagent.service"
  fi
  exit 0
fi
if [[ "\$*" == *"show"* ]]; then
  if [[ "\$*" == *"gateway"* ]] && [[ "\$*" == *"WorkingDirectory"* ]]; then
    echo "${TMPDIR_TEST}/gateway-state"
    exit 0
  fi
  if [[ "\$*" == *"chatagent.service"* ]] && [[ "\$*" == *"ActiveEnterTimestamp"* ]]; then
    echo "${ACTIVE_ENTER_TS}"
    exit 0
  fi
  if [[ "\$*" == *"chatagent.service"* ]] && [[ "\$*" == *"ActiveState"* ]]; then
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
echo "${JOURNAL_ENTRY_EPOCH}.000000 \$(hostname) switchroom-chatagent[1234]: last log line"
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

# ─── Watchdog state dir (clean — no pre-seeded silence marker) ───────────────

WATCHDOG_STATE_DIR="${TMPDIR_TEST}/watchdog-state"
mkdir -p "$WATCHDOG_STATE_DIR"

# ─── Run the watchdog with PRODUCTION defaults ───────────────────────────────

# The whole point of this test is that the DEFAULT thresholds protect
# chat-cadence agents. So we do NOT override JOURNAL_SILENCE_SECS or
# JOURNAL_SILENCE_HARD_SECS — we rely on the script's defaults.
export PATH="${MOCK_BIN}:${PATH}"
WATCHDOG_STATE_DIR="$WATCHDOG_STATE_DIR" \
UPTIME_GRACE_SECS=90 \
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
  check "watchdog did NOT restart chat-cadence agent (30 min idle)" "true"
else
  check "watchdog did NOT restart chat-cadence agent (30 min idle)" "false"
  echo "  restart.log contents:" >&2
  cat "$RESTART_LOG" 2>/dev/null || true
fi

# Assert: no silence_since marker was created (journal was fresh enough
# under the new default that the silence branch never fired).
if [[ ! -f "${WATCHDOG_STATE_DIR}/chatagent.silence_since" ]]; then
  check "no silence_since marker created (journal fresh under new default)" "true"
else
  check "no silence_since marker created (journal fresh under new default)" "false"
  echo "  marker contents:" >&2
  cat "${WATCHDOG_STATE_DIR}/chatagent.silence_since" 2>/dev/null || true
fi

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
