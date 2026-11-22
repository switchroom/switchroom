#!/usr/bin/env bash
# One real-Agent runtime leg. Shared by this repository's CI `runtime` job and the Agent
# repository's fleet-integration workflow, so a pin PR can reuse the Agent run's proof: both
# run exactly these commands. Usage:
#   scripts/run-runtime-leg.sh LANE SHARD AGENT_SOURCE [PROOF...]
# LANE and SHARD are one entry of RUNTIME_LEGS in scripts/source-ci.py (SHARD '' for native).
# PROOF is one of the lane's proofs; with none, every proof of the lane runs. AGENT_SOURCE is
# an absolute path to a clean Agent checkout at the revision in release/agent-image-manifest.json.
set -euo pipefail
if (( $# < 3 )); then
  echo "usage: $0 LANE SHARD AGENT_SOURCE [PROOF...]" >&2
  exit 2
fi
lane=$1 shard=$2 agent=$3
shift 3
case "$lane" in
  kanban) all=(linear) ;;
  native) all=(acp journey) ;;
  origin) all=(origin) ;;
  input) all=(input) ;;
  *) echo "unknown runtime lane: $lane" >&2; exit 2 ;;
esac
proofs=("$@")
(( ${#proofs[@]} )) || proofs=("${all[@]}")
for proof in "${proofs[@]}"; do
  [[ " ${all[*]} " == *" $proof "* ]] || { echo "proof $proof is not part of lane $lane" >&2; exit 2; }
done
[[ "$agent" == /* && -d "$agent" ]] || { echo "AGENT_SOURCE must be an absolute directory: $agent" >&2; exit 2; }
work=${RUNNER_TEMP:?RUNNER_TEMP is required}
cd "$(dirname "$0")/.."

venv="$work/linear-scenarios"
python -m venv "$venv"
"$venv/bin/python" -m pip install \
  --require-hashes --only-binary=:all: -r release/linear-scenario-requirements.txt

for proof in "${proofs[@]}"; do
  echo "::group::real-Agent proof: $proof ($lane${shard:+ $shard})"
  case "$proof" in
    linear)
      "$venv/bin/python" scripts/run-linear-scenarios.py --agent-source "$agent" --shard "$shard" ;;
    acp)
      "$venv/bin/python" scripts/run-linear-scenarios.py \
        --agent-source "$agent" --pattern test_claude_acp_context.py ;;
    journey)
      (cd "$agent" && python -m pm.build_env --source . \
        --out "$work/journey-env" --group dev --group test --extra all --ci)
      "$work/journey-env/bin/python" scripts/run-linear-scenarios.py \
        --agent-source "$agent" --pattern test_linear_native_work_journey.py
      "$work/journey-env/bin/python" scripts/run-linear-scenarios.py \
        --agent-source "$agent" --pattern test_linear_worker_questions.py ;;
    origin)
      python3 -I -S scripts/check-linear-origin-guard.py
      "$venv/bin/python" -I scripts/run-linear-origin-scenarios.py --agent-source "$agent" --shard "$shard" ;;
    input)
      "$venv/bin/python" -m pip install \
        --require-hashes --only-binary=:all: -r tests/native-input-requirements.txt
      "$venv/bin/python" -I scripts/run-linear-input-scenarios.py --agent-source "$agent" --shard "$shard" ;;
  esac
  echo "::endgroup::"
done
