#!/usr/bin/env bash
set -euo pipefail
# Configure once (creds persist in the mounted volume across restarts); a
# RUNNER_TOKEN is only needed the first time. This is a PERSISTENT runner (not
# --ephemeral) — actions/checkout gives each job a fresh checkout, but the
# uat-runner-data volume carries `_work` residue between jobs. Acceptable here:
# fork PRs are gated by the all_external_contributors approval, so a job can only
# run from an approved/merged change. Egress-only; no docker, no host access.
if [ ! -f .runner ]; then
  if [ -z "${RUNNER_TOKEN:-}" ]; then
    echo "FATAL: first boot needs RUNNER_TOKEN (registration token)" >&2; exit 1
  fi
  ./config.sh \
    --url "https://github.com/switchroom/switchroom" \
    --token "${RUNNER_TOKEN}" \
    --name "uat-runner-sandbox" \
    --labels "uat-host" \
    --work "_work" \
    --unattended --replace
fi
exec ./run.sh
