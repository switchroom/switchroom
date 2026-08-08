#!/usr/bin/env bash
# Hindsight rollout gate driver — capture-then-compare, correct by construction.
#
# The defect this exists to prevent (WP6, switchroom#4533): comparing a
# post-upgrade run against a baseline that came from a different instance or a
# different day produces a fully-red board on completely healthy data. The
# comparator now refuses those inputs, but the better fix is to make the
# CORRECT workflow the easiest thing to run.
#
#   ./rollout_gate.sh pre          # minutes BEFORE the maintenance window
#   ... perform the upgrade ...
#   ./rollout_gate.sh post         # captures, then compares against that pre
#
# `post` reuses the run directory, the api-url and the pinned recency anchor
# recorded by `pre`, so those cannot drift between the two halves by accident.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="${HINDSIGHT_GATE_RUN_DIR:-${HERE}/.gate-run}"
PRE="${RUN_DIR}/pre.json"
POST="${RUN_DIR}/post.json"
META="${RUN_DIR}/run.env"

usage() {
  cat <<'EOF'
usage: rollout_gate.sh <pre|post|compare> [extra args passed through]

  pre       capture the live baseline (run MINUTES before the window)
  post      capture the live post-upgrade run and compare against pre
  compare   re-run only the comparison over an existing run directory

env:
  HINDSIGHT_API_URL       required for `pre`
  HINDSIGHT_GATE_RUN_DIR  where the run artifacts live (default ./.gate-run)
EOF
}

cmd="${1:-}"; shift || true

case "$cmd" in
  pre)
    : "${HINDSIGHT_API_URL:?HINDSIGHT_API_URL must be set}"
    mkdir -p "$RUN_DIR"
    if [ -f "$PRE" ]; then
      echo "refusing to overwrite an existing baseline at $PRE" >&2
      echo "move or delete the run directory to start a new gate run" >&2
      exit 2
    fi
    "${HERE}/canned_recall.py" --phase pre --out "$PRE" "$@"
    anchor="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["query_timestamp_anchor"])' "$PRE")"
    {
      printf 'HINDSIGHT_API_URL=%s\n' "$HINDSIGHT_API_URL"
      printf 'GATE_ANCHOR=%s\n' "$anchor"
    } >"$META"
    echo
    echo "Baseline captured. Do the upgrade, then run \`rollout_gate.sh post\`"
    echo "WITHIN THE FRESHNESS BOUND (default 4h) — a stale baseline is the"
    echo "exact failure mode this gate was rebuilt to prevent."
    ;;
  post)
    [ -f "$PRE" ] || { echo "no baseline at $PRE — run \`rollout_gate.sh pre\` first" >&2; exit 2; }
    # shellcheck disable=SC1090
    . "$META"
    export HINDSIGHT_API_URL
    "${HERE}/canned_recall.py" --phase post --out "$POST" \
      --query-timestamp "$GATE_ANCHOR" "$@"
    echo
    exec "${HERE}/compare_baseline.py" --baseline "$PRE" --post "$POST" \
      --json "${RUN_DIR}/report.json"
    ;;
  compare)
    exec "${HERE}/compare_baseline.py" --baseline "$PRE" --post "$POST" \
      --json "${RUN_DIR}/report.json" "$@"
    ;;
  *)
    usage; exit 2 ;;
esac
