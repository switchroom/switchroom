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

# THE single source of truth for what the bun CI job runs — `bun test` with
# no args recurses into telegram-plugin/uat/scenarios/, which needs live
# Telegram creds. Both ci-tests-plugin.yml and ci-full.yml invoke this script
# rather than re-typing the list (they used to keep hand-copied duplicates,
# which is how a test file ends up in no runner at all — see
# scripts/check-test-runner-coverage.mjs). BUN_TEST_TARGETS (space-separated)
# overrides the list — used only to exercise the watchdog against a subset.
if [ -n "${BUN_TEST_TARGETS:-}" ]; then
  # shellcheck disable=SC2206
  BUN_TEST_ARGS=(${BUN_TEST_TARGETS})
else
  BUN_TEST_ARGS=(
    # TRAILING SLASHES ARE LOAD-BEARING. A `bun test` positional is a plain
    # SUBSTRING match on the file path, not a directory selector: the bare
    # `gateway` this list used to carry also matched
    # `uat/scenarios/vault-card-survives-gateway-restart-dm.test.ts`, quietly
    # pulling a live-Telegram scenario into the ordinary bun-test job (it only
    # stayed harmless because that scenario self-skips without creds). `gateway/`
    # matches the directory and nothing else.
    admin-commands/ gateway/ registry/ secret-detect/ tests/
    channel-envelope-safety.test.ts
    # Hosted UAT unit tests: no creds, no live Telegram, no driver session.
    # Named as specific files / the runners dir — never a bare `uat` — so the
    # filter can NEVER widen into uat/scenarios/, which does hit real Telegram
    # and must stay on the gated uat-host runner (ci-uat.yml) only.
    #
    # These ran in NEITHER CI runner before this change: vitest.config.ts
    # excludes `**/telegram-plugin/uat/**` wholesale (right for scenarios/,
    # collateral damage for these) and this list never named them. So
    # feed-matcher.test.ts — whose own docblock calls it "the CI-verifiable
    # floor" for the worker-feed matcher, and which #3821 extended with
    # `stripCardNesting` assertions — was executed by nothing.
    #
    # They go on the BUN side rather than being un-excluded from vitest because
    # three of them import `bun:test`, and uat/runners/skill-coverage.test.ts
    # transitively imports uat/driver.ts → `@mtcute/node`, which vite's resolver
    # cannot load out of the bun workspace layout (bun's resolver has no
    # trouble). Fenced by scripts/check-test-runner-coverage.mjs.
    uat/feed-matcher.test.ts
    uat/load-env.test.ts
    uat/uat-driver.test.ts
    uat/runners/
    # M3 directive-flip UAT — deterministic (no-model, no-network) gate half.
    # Same rationale as uat/runners/: vitest excludes all of uat/**, and these
    # import `vitest` (bun runs them via its vitest-compat shim) — so they run
    # on the BUN side. Directory match (trailing slash) never widens into
    # uat/scenarios/. Fenced by scripts/check-test-runner-coverage.mjs.
    uat/flip/
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
