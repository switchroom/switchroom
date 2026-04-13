#!/usr/bin/env bash
# Read the most recent trigger + quality eval result JSONs and post a
# Buildkite annotation summarizing pass/fail counts. Falls back to a warning
# annotation if no result files are present (eval steps were skipped).

set -uo pipefail

shopt -s nullglob
results_dir="evals/results"

latest_of() {
  local pattern="$1"
  local files=( "$results_dir"/$pattern )
  if [[ ${#files[@]} -eq 0 ]]; then
    return 1
  fi
  ls -t "${files[@]}" | head -1
}

summarize() {
  local file="$1"
  local label="$2"
  python3 - "$file" "$label" <<'PY'
import json, sys
path, label = sys.argv[1], sys.argv[2]
data = json.load(open(path))
results = data.get("results", data) if isinstance(data, dict) else data
total = len(results)
passed = sum(1 for r in results if r.get("passed") or r.get("status") == "pass")
failed = total - passed
pct = (100 * passed / total) if total else 0
status = ":white_check_mark:" if failed == 0 else (":warning:" if passed > total / 2 else ":x:")
print(f"| {status} {label} | {passed}/{total} ({pct:.0f}%) | {failed} failed |")
PY
}

trigger_file="$(latest_of 'trigger_*.json' || true)"
quality_file="$(latest_of 'quality_*.json' || true)"

if [[ -z "${trigger_file:-}" && -z "${quality_file:-}" ]]; then
  buildkite-agent annotate \
    --style "warning" \
    --context "evals-summary" \
    "No eval result files found in \`evals/results/\`. Eval steps may have been skipped or failed before producing output."
  exit 0
fi

{
  echo "## :bar_chart: Skills eval results"
  echo
  echo "| Suite | Pass rate | Failures |"
  echo "|-------|-----------|----------|"
  [[ -n "${trigger_file:-}" ]] && summarize "$trigger_file" "Trigger routing"
  [[ -n "${quality_file:-}" ]] && summarize "$quality_file" "Quality"
  echo
  echo "Build SHA: \`${BUILDKITE_COMMIT:-unknown}\`"
  echo
  [[ -n "${trigger_file:-}" ]] && echo "- Trigger results: \`$(basename "$trigger_file")\`"
  [[ -n "${quality_file:-}" ]] && echo "- Quality results: \`$(basename "$quality_file")\`"
} | buildkite-agent annotate --style "info" --context "evals-summary"
