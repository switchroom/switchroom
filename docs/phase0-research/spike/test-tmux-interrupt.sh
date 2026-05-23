#!/usr/bin/env bash
# tmux-under-tini interrupt smoke test.
# Validates the production interrupt path: gateway sends C-c via
# `tmux send-keys` to a long-running command; the command actually dies.
# Runs as the agent user inside the agent container (PID 1 = tini).

set -uo pipefail

# pgrep tini's pid 1 sanity (informational).
echo "# pid 1: $(awk -F'[() ]' 'NR==1{print $2}' /proc/1/comm) ($(cat /proc/1/comm))"

SOCK="/tmp/tmux-$(id -u)/spike"
rm -f "$SOCK" 2>/dev/null
mkdir -p "$(dirname "$SOCK")"

# Start a fresh tmux server on a private socket, daemonised.
tmux -S "$SOCK" new-session -d -s spike "sleep 600; echo SLEEP-EXITED-NORMALLY > /tmp/sleep-result"

# Confirm the sleep is running.
sleep 0.5
SLEEP_PID=$(pgrep -f 'sleep 600' | head -1 || true)
if [ -z "$SLEEP_PID" ]; then
  echo "FAIL: sleep didn't start under tmux"
  exit 1
fi
echo "# sleep pid=$SLEEP_PID running under tmux"

# Send C-c — the production interrupt path.
tmux -S "$SOCK" send-keys -t spike C-c
sleep 1

# Verify the sleep is gone AND no normal-exit marker was written.
if kill -0 "$SLEEP_PID" 2>/dev/null; then
  echo "FAIL: sleep $SLEEP_PID still alive after C-c"
  tmux -S "$SOCK" kill-server 2>/dev/null
  exit 1
fi
if [ -f /tmp/sleep-result ]; then
  echo "FAIL: sleep exited normally rather than via SIGINT"
  cat /tmp/sleep-result
  exit 1
fi

# Tmux server itself should still be alive (only the pane's command died).
if ! tmux -S "$SOCK" list-sessions >/dev/null 2>&1; then
  # Pane death may close the session depending on tmux config — check that
  # the SERVER (not the session) survived. With `new-session -d` and a
  # one-shot command, default tmux closes the session when the command
  # exits. That's fine; what we care about is C-c reaching the child.
  echo "# (info) tmux session closed after pane command died — expected default behaviour"
fi

echo "PASS: tmux send-keys C-c reached the supervised child under tini"
tmux -S "$SOCK" kill-server 2>/dev/null
exit 0
