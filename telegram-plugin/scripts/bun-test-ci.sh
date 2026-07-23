#!/usr/bin/env bash
#
# bun-test-ci.sh — hang-watchdog + automatic retry wrapper for the
# telegram-plugin Bun test suite (the `bun-test-run` CI job).
#
# WHY THIS EXISTS
# ---------------
# The `telegram-plugin/tests/subagent-watcher*` tests exercise the real
# Node/Bun `fs.watch` API. Under CPU contention (the hosted 2-vCPU GitHub
# runner) Bun's runtime intermittently DEADLOCKS inside `fs.watch` — the
# `bun` process wedges in `futex_do_wait` with ZERO child processes, so it
# is not a stuck subprocess or a leaked user handle but an internal Bun
# scheduler deadlock. Symptom: the suite prints a few thousand of ~8970
# tests, then goes idle for minutes until the job's hard timeout cancels
# the whole run — turning an unrelated flake into a red required check on
# every telegram-plugin PR. It reproduces locally ~1-in-7 runs under
# `taskset -c 0`; it is NOT an assertion failure (zero `(fail)` lines).
#
# Bun's own `--timeout` does NOT preempt it (the deadlocked thread IS the
# scheduler), so the recovery has to happen one level up: an external
# watchdog that KILLS a wedged attempt and retries. Because the deadlock
# is nondeterministic, a retry almost always clears it.
#
# HANG vs REAL FAILURE
# --------------------
# We must never mask a genuine test failure by retrying it. A real Bun
# assertion failure exits non-zero WITHOUT the watchdog having to kill
# anything, so `timeout` reports the command's own exit code and we do NOT
# retry. Only a watchdog-initiated kill (GNU `timeout` exit status 124, or
# 128+signal when `--kill-after` escalates to SIGKILL) is treated as a
# hang and retried.
#
# Env overrides (defaults tuned for the 2-vCPU runner; healthy run ~50s):
#   BUN_TEST_ATTEMPT_TIMEOUT  per-attempt wall-clock budget, seconds (180)
#   BUN_TEST_KILL_AFTER       grace before SIGKILL escalation, seconds (30)
#   BUN_TEST_MAX_ATTEMPTS     total attempts before giving up (3)
set -uo pipefail

ATTEMPT_TIMEOUT="${BUN_TEST_ATTEMPT_TIMEOUT:-180}"
KILL_AFTER="${BUN_TEST_KILL_AFTER:-30}"
MAX_ATTEMPTS="${BUN_TEST_MAX_ATTEMPTS:-3}"

# Same explicit dir list as the Buildkite/CI invocation — running `bun
# test` with no args recurses into telegram-plugin/uat/scenarios/ which
# need live Telegram creds. Keep this in sync with ci-tests-plugin.yml if
# the surface changes. BUN_TEST_TARGETS (space-separated) overrides the
# list — used only to exercise the watchdog against a narrow subset.
if [ -n "${BUN_TEST_TARGETS:-}" ]; then
  # shellcheck disable=SC2206
  BUN_TEST_ARGS=(${BUN_TEST_TARGETS})
else
  BUN_TEST_ARGS=(
    admin-commands gateway registry secret-detect tests
    channel-envelope-safety.test.ts
  )
fi

attempt=1
while :; do
  echo "::group::bun test — attempt ${attempt}/${MAX_ATTEMPTS} (per-attempt timeout ${ATTEMPT_TIMEOUT}s, kill-after ${KILL_AFTER}s)"
  set +e
  timeout --kill-after="${KILL_AFTER}s" "${ATTEMPT_TIMEOUT}s" \
    bun test "${BUN_TEST_ARGS[@]}"
  rc=$?
  set -e
  echo "::endgroup::"

  if [ "$rc" -eq 0 ]; then
    echo "bun test passed on attempt ${attempt}/${MAX_ATTEMPTS}"
    exit 0
  fi

  # GNU timeout: 124 = timed out (SIGTERM sent); 137 = 128+9, SIGKILL from
  # --kill-after escalation; 143 = 128+15, killed by SIGTERM. All three
  # mean the watchdog had to kill a wedged attempt → a hang, not a failure.
  case "$rc" in
    124 | 137 | 143)
      echo "::warning::bun test attempt ${attempt} HUNG (watchdog killed after ${ATTEMPT_TIMEOUT}s) — known pre-existing Bun fs.watch deadlock in subagent-watcher tests. See telegram-plugin/scripts/bun-test-ci.sh."
      if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
        echo "::error::bun test hung on all ${MAX_ATTEMPTS} attempts — not a clean pass; failing the job."
        exit 1
      fi
      attempt=$((attempt + 1))
      continue
      ;;
    *)
      echo "::error::bun test failed on attempt ${attempt} with exit code ${rc} — a real test failure (not a hang), NOT retrying."
      exit "$rc"
      ;;
  esac
done
