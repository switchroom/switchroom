#!/usr/bin/env bash
# Top-level CI snapshot gate (Phase 3c F3).
#
# Runs the docker test suite under `tests/docker/**` with pre/post
# `docker ps` snapshots captured AT THE STEP LEVEL. Even if vitest
# crashes mid-run (process killed, OOM, segfault), the post-snapshot is
# still captured in the trap and the gate fails on any drift relative
# to the pre-snapshot.
#
# This complements the per-test `expectNoProdDrift()` assertions that
# run inside `afterAll()` blocks: those only fire when vitest reaches
# afterAll. A crash before afterAll would silently leave drift on the
# host. This gate catches that case.
#
# Filter regex matches `_prod-snapshot.ts:filterPhaseTestContainers` —
# any `switchroom-phase\d` named container is sibling-phase noise and
# stripped from both sides before diffing. Production containers do
# not carry that name prefix.
#
# Exit codes:
#   0  — no drift, vitest passed
#   1  — drift detected (regardless of vitest exit code)
#   N  — vitest exit code (no drift, but tests failed)

set -uo pipefail

snapshot() {
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo docker ps --no-trunc --format '{{.Names}}|{{.ID}}|{{.Status}}' 2>/dev/null || true
  else
    docker ps --no-trunc --format '{{.Names}}|{{.ID}}|{{.Status}}' 2>/dev/null || true
  fi
}

# Filter out switchroom-phase\d ephemerals (sibling-phase noise) and
# sort for deterministic diffing. Mirrors _prod-snapshot.ts.
filter_snapshot() {
  grep -v -E 'switchroom-phase[0-9]' | sort
}

PRE_FILE="$(mktemp)"
POST_FILE="$(mktemp)"
DIFF_FILE="$(mktemp)"
VITEST_EXIT=0

cleanup() {
  rm -f "$PRE_FILE" "$POST_FILE" "$DIFF_FILE"
}
trap cleanup EXIT

# Always capture POST in the EXIT path, even if vitest crashed.
post_and_compare() {
  snapshot | filter_snapshot >"$POST_FILE"
  if ! diff -u "$PRE_FILE" "$POST_FILE" >"$DIFF_FILE" 2>&1; then
    echo "::error::production-host docker snapshot DRIFTED during tests/docker run"
    echo "--- pre ---"
    cat "$PRE_FILE"
    echo "--- post ---"
    cat "$POST_FILE"
    echo "--- diff ---"
    cat "$DIFF_FILE"
    exit 1
  fi
  echo "snapshot stable: $(wc -l <"$PRE_FILE") containers before/after"
}

snapshot | filter_snapshot >"$PRE_FILE"
echo "captured pre-snapshot: $(wc -l <"$PRE_FILE") containers"

# Run the docker test slice. Any failure is captured but does NOT skip
# the post-snapshot — we MUST always compare.
set +e
bunx vitest run tests/docker
VITEST_EXIT=$?
set -e

post_and_compare

# No drift — propagate vitest's exit code.
exit "$VITEST_EXIT"
