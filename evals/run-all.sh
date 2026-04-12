#!/bin/bash
# Run the full eval suite in an isolated process (via systemd-run).
# Results written to evals/results/. Run from the clerk repo root.

set -euo pipefail

cd "$(dirname "$0")/.."

export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.clerk/agents/assistant/.claude}"
PARALLEL="${1:-3}"
LOG="/tmp/clerk-evals-$(date +%Y%m%d_%H%M%S).log"

echo "=== Clerk Skills Eval Suite ===" | tee "$LOG"
echo "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR" | tee -a "$LOG"
echo "Parallel: $PARALLEL" | tee -a "$LOG"
echo "Log: $LOG" | tee -a "$LOG"
echo "" | tee -a "$LOG"

echo "--- Trigger evals (routing) ---" | tee -a "$LOG"
python3 evals/run_trigger.py --parallel "$PARALLEL" 2>&1 | tee -a "$LOG"
TRIGGER_EXIT=${PIPESTATUS[0]}
echo "" | tee -a "$LOG"

echo "--- Quality evals (content) ---" | tee -a "$LOG"
python3 evals/run_quality.py --parallel "$PARALLEL" 2>&1 | tee -a "$LOG"
QUALITY_EXIT=${PIPESTATUS[0]}
echo "" | tee -a "$LOG"

echo "=== Summary ===" | tee -a "$LOG"
echo "Trigger: $([ $TRIGGER_EXIT -eq 0 ] && echo PASS || echo FAIL) (exit $TRIGGER_EXIT)" | tee -a "$LOG"
echo "Quality: $([ $QUALITY_EXIT -eq 0 ] && echo PASS || echo FAIL) (exit $QUALITY_EXIT)" | tee -a "$LOG"
echo "Results: $(ls -t evals/results/*.json 2>/dev/null | head -2)" | tee -a "$LOG"
echo "Log: $LOG" | tee -a "$LOG"

exit $(( TRIGGER_EXIT + QUALITY_EXIT ))
