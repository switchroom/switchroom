#!/usr/bin/env bash
# Contract: on Darwin, install-deps.sh must not call getent.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
set +e
output=$(bash "$root/scripts/install-deps.sh" 2>&1)
status=$?
set -e
if [ "$status" -eq 0 ]; then
  echo "expected non-zero status" >&2
  exit 1
fi
printf '%s\n' "$output" | grep -q "uses apt and only runs on Linux"
if printf '%s\n' "$output" | grep -q "getent"; then
  echo "getent still ran:" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi
echo "darwin guard ok (exit $status)"
