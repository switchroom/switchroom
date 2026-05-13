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
# Filter rule mirrors `tests/docker/_prod-snapshot.ts:filterPhaseTestContainers`
# post-#1102:
#
#   1. Any container whose Labels column contains `switchroom.test=` is
#      test-owned (single-run + compose paths both stamp it via
#      `_label-helpers.ts:dockerRunLabelsArgv` / `injectLabelsIntoCompose`).
#      This is the LOAD-BEARING rule — it catches Moby-auto-named
#      containers from `docker run --rm` callsites that omit `--name`
#      (e.g. `tests/docker/e2e.test.ts`'s spawnSync calls), which the
#      name regex alone misses (the recurring `friendly_chatelet`
#      flake — #1102).
#   2. Belt-and-braces: any container NAME starting with
#      `switchroom-phase<digit>` (single-container `docker run` shape)
#      or `phase<digit><letter>-` (compose-project shape used by
#      broker-ipc-race / per-agent-isolation). Production containers
#      do not carry these name prefixes.
#
# Exit codes:
#   0  — no drift, vitest passed
#   1  — drift detected (regardless of vitest exit code)
#   N  — vitest exit code (no drift, but tests failed)

set -uo pipefail

snapshot() {
  # Include {{.Labels}} so the label-based filter below can fire. Mirror
  # `captureProdSnapshot` in tests/docker/_prod-snapshot.ts.
  local fmt='{{.Names}}|{{.ID}}|{{.Status}}|{{.Labels}}'
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo docker ps --no-trunc --format "$fmt" 2>/dev/null || true
  else
    docker ps --no-trunc --format "$fmt" 2>/dev/null || true
  fi
}

filter_snapshot() {
  # `grep -v` exits 1 when stdin is empty (no lines processed). Combined
  # with `pipefail` + `set -e` (enabled around the post-vitest call), an
  # empty `docker ps` snapshot — the steady-state on hosted Buildkite
  # agents with no production containers — would kill the script with
  # exit 1 and no error output, masking the actual outcome of the
  # test run. Absorb that one specific case so an empty snapshot stays
  # an empty filtered snapshot.
  { grep -v -E 'switchroom\.test=|^switchroom-phase[0-9]|^phase[0-9][a-z]-' || true; } | sort
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
