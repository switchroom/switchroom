#!/usr/bin/env bash
# Integration test: watchdog journal-silence detection (issue #116).
#
# Verifies that bridge-watchdog.sh detects a journal-silent agent and
# restarts it via `switchroom agent restart <agent>` when:
#   1. The agent unit is active (mocked systemctl reports it so).
#   2. The agent has been running longer than UPTIME_GRACE_SECS.
#   3. The most recent journal entry is older than JOURNAL_SILENCE_SECS.
#   4. The silence_since marker is older than JOURNAL_SILENCE_HARD_SECS.
#
# All system calls are mocked via PATH overrides — no real systemd or
# switchroom needed.

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
RESTART_LOG="${TMPDIR_TEST}/restart.log"

# ─── Epoch arithmetic ────────────────────────────────────────────────────────

NOW="$(date +%s)"
# Agent started 200s ago — well past the 90s UPTIME_GRACE_SECS.
ACTIVE_ENTER_EPOCH=$(( NOW - 200 ))
ACTIVE_ENTER_TS="$(date -d "@${ACTIVE_ENTER_EPOCH}" '+%a %Y-%m-%d %H:%M:%S %Z' 2>/dev/null \
  || date -r "$ACTIVE_ENTER_EPOCH" '+%a %Y-%m-%d %H:%M:%S %Z' 2>/dev/null \
  || echo "Mon 2026-01-01 00:00:00 UTC")"

# Journal entry is 700s old — past the 10s test threshold we'll set.
JOURNAL_ENTRY_EPOCH=$(( NOW - 700 ))

# silence_since marker is 30s old — past the 10s hard threshold we'll set.
SILENCE_SINCE_EPOCH=$(( NOW - 30 ))

# ─── Mock: systemctl ─────────────────────────────────────────────────────────

cat > "${MOCK_BIN}/systemctl" << MOCK_SYSTEMCTL
#!/usr/bin/env bash
# Minimal systemctl mock for watchdog tests.

# list-units: return one gateway (for the bridge-check loop) and one agent unit.
if [[ "\$*" == *"list-units"*"--type=service"* ]]; then
  if [[ "\$*" == *"active"* ]]; then
    echo "switchroom-testagent-gateway.service"
    echo "switchroom-testagent.service"
  fi
  exit 0
fi

# show: return properties for the units we care about.
if [[ "\$*" == *"show"* ]]; then
  # Gateway WorkingDirectory (for the bridge-check loop).
  if [[ "\$*" == *"gateway"* ]] && [[ "\$*" == *"WorkingDirectory"* ]]; then
    echo "${TMPDIR_TEST}/gateway-state"
    exit 0
  fi
  # Agent ActiveEnterTimestamp.
  if [[ "\$*" == *"testagent.service"* ]] && [[ "\$*" == *"ActiveEnterTimestamp"* ]]; then
    echo "${ACTIVE_ENTER_TS}"
    exit 0
  fi
  # Agent ActiveState.
  if [[ "\$*" == *"testagent.service"* ]] && [[ "\$*" == *"ActiveState"* ]]; then
    echo "active"
    exit 0
  fi
  exit 0
fi

# is-active: the agent is active.
if [[ "\$*" == *"is-active"* ]]; then
  exit 0
fi

# start / restart — no-op for mocked units.
if [[ "\$*" == *"start"* ]] || [[ "\$*" == *"restart"* ]]; then
  exit 0
fi

exit 0
MOCK_SYSTEMCTL
chmod +x "${MOCK_BIN}/systemctl"

# ─── Mock: journalctl ────────────────────────────────────────────────────────

cat > "${MOCK_BIN}/journalctl" << MOCK_JOURNALCTL
#!/usr/bin/env bash
# Returns a journal entry JOURNAL_ENTRY_EPOCH seconds old.
echo "${JOURNAL_ENTRY_EPOCH}.000000 $(hostname) switchroom-testagent[1234]: last log line"
exit 0
MOCK_JOURNALCTL
chmod +x "${MOCK_BIN}/journalctl"

# ─── Mock: switchroom ────────────────────────────────────────────────────────

cat > "${MOCK_BIN}/switchroom" << MOCK_SWITCHROOM
#!/usr/bin/env bash
# Capture the invocation so the test can assert on it.
echo "switchroom \$*" >> "${RESTART_LOG}"
exit 0
MOCK_SWITCHROOM
chmod +x "${MOCK_BIN}/switchroom"

# ─── Mock: ss (no gateway socket — bridge loop skips cleanly) ────────────────

cat > "${MOCK_BIN}/ss" << MOCK_SS
#!/usr/bin/env bash
# No ESTAB connections — makes the bridge-check see a disconnected bridge.
# We give it a fresh disconnect marker so the bridge check won't trigger.
exit 0
MOCK_SS
chmod +x "${MOCK_BIN}/ss"

# ─── Mock: logger ────────────────────────────────────────────────────────────

cat > "${MOCK_BIN}/logger" << MOCK_LOGGER
#!/usr/bin/env bash
# Suppress logger output in tests.
exit 0
MOCK_LOGGER
chmod +x "${MOCK_BIN}/logger"

# ─── Gateway state dir (so the bridge-check loop doesn't bail early) ─────────

GATEWAY_STATE="${TMPDIR_TEST}/gateway-state"
mkdir -p "$GATEWAY_STATE"
# Create gateway.log and gateway.sock stubs so the bridge check doesn't skip.
touch "${GATEWAY_STATE}/gateway.log"
# No real socket — the ss mock returns nothing, which means ESTAB==0.
# We set a fresh disconnect marker so the disconnect grace window isn't hit.
DISC_MARKER="${GATEWAY_STATE}/.watchdog-disconnect-since"
echo "$(( NOW - 5 ))" > "$DISC_MARKER"  # 5s disconnect — below grace threshold

# Also create the liveness file to indicate the bridge process is alive
# (so bridge-check won't trigger a restart — we want ONLY the journal check
# to fire in this test).
touch "${GATEWAY_STATE}/.bridge-alive"

# ─── Watchdog state dir with pre-seeded silence marker ───────────────────────

# The watchdog writes silence markers to /run/user/$UID/switchroom-watchdog/.
# We override the UID to point at our tmp dir by setting UID_VAL and
# WATCHDOG_STATE_DIR through env vars... except UID_VAL is not exported.
# Instead, we write the silence_since file at the path the script would use
# after it constructs WATCHDOG_STATE_DIR from UID_VAL. We pass WATCHDOG_STATE_DIR
# directly as an env override — the script uses it if set.
WATCHDOG_STATE_DIR="${TMPDIR_TEST}/watchdog-state"
mkdir -p "$WATCHDOG_STATE_DIR"
echo "$SILENCE_SINCE_EPOCH" > "${WATCHDOG_STATE_DIR}/testagent.silence_since"

# ─── Run the watchdog ────────────────────────────────────────────────────────

# Use tight tunables so the test thresholds are met by our fixture data:
#   UPTIME_GRACE_SECS=90       agent started 200s ago → cleared
#   JOURNAL_SILENCE_SECS=10    journal is 700s old → cleared
#   JOURNAL_SILENCE_HARD_SECS=10  marker is 30s old → cleared
#   DISCONNECT_GRACE_SECS=9999 bridge check won't fire

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

# Assert: switchroom agent restart was called for testagent.
if [[ -f "$RESTART_LOG" ]] && grep -q "switchroom agent restart testagent" "$RESTART_LOG"; then
  check "watchdog called 'switchroom agent restart testagent'" "true"
else
  check "watchdog called 'switchroom agent restart testagent'" "false"
  echo "  restart.log contents:" >&2
  cat "$RESTART_LOG" 2>/dev/null || echo "  (empty)" >&2
fi

# Assert: silence_since marker was cleared after restart.
if [[ ! -f "${WATCHDOG_STATE_DIR}/testagent.silence_since" ]]; then
  check "silence_since marker cleared after restart" "true"
else
  check "silence_since marker cleared after restart" "false"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
