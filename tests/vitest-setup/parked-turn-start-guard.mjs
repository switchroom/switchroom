/**
 * parked-turn-start-guard — the `bun test` preload that stops one test file
 * leaking a parked turn-start into the NEXT file's module state.
 *
 * ── The defect class this closes ────────────────────────────────────────
 *
 * `parkedTurnStarts` (telegram-plugin/gateway/stream-render.ts) is module-scope
 * BY DESIGN — it mirrors the ONE claude CLI session's ONE queue, exactly like
 * the `currentTurn` mirror. `bun test` runs all ~657 telegram-plugin files in
 * ONE process with ONE module registry, so that array is shared by every file
 * in the sweep and a file that exits with an entry still parked has changed
 * global state for everything that runs after it.
 *
 * On 2026-08-11 (#4611) `tests/queued-card-surface.test.ts` reset the store in
 * `beforeEach` only. Its last test parks message `502` and never dequeues, so
 * the file exited with `parkedTurnStartCount() === 1` — permanently, because
 * nothing else in the suite drains it. `gateway/obligation-wiring.ts:175` folds
 * that count into `sessionBusy`, so `tests/represent-guard.test.ts`'s "does NOT
 * defer when the session is idle" saw a 20-minute background-work grace it had
 * explicitly stubbed out and asserted `toHaveLength(1)` against `0`. `bun test`
 * file order is not stable across checkouts, so the victim only failed when the
 * leaker happened to run first: two PRs were ejected from the merge queue by
 * runs whose retries passed on byte-identical code.
 *
 * ── Mechanism ───────────────────────────────────────────────────────────
 *
 * A global `afterEach` — registered from a preload, so it applies to every test
 * in the process with NO per-file opt-in — asserts the store is empty and, when
 * it is not, RESETS it and throws. Two properties matter, and both are the
 * point of doing this here rather than per file:
 *
 *   - it fails the LEAKING test, by name, on the line that leaked, instead of a
 *     random victim 200 files later whose own code is blameless;
 *   - it resets before rethrowing, so the sweep reports ONE actionable failure
 *     instead of the ~1800-deep cascade the permanent pollution otherwise
 *     produces.
 *
 * Per-file `afterEach(() => __resetParkedTurnStartsForTest())` (the five suites
 * that drive `handleSessionEvent`) is the fix; this guard is the mechanism that
 * keeps the class from regrowing the next time someone adds a sixth.
 *
 * Loaded via `[test] preload` in bunfig.toml AND telegram-plugin/bunfig.toml —
 * bun reads the bunfig in its CWD, not an ancestor's, and this repo runs
 * `bun test` from both the repo root (`npm run test:bun`) and telegram-plugin/
 * (CI's bun-test-run, via telegram-plugin/scripts/bun-test-ci.sh). Unlike its
 * siblings this guard is `bun test` ONLY: it needs `bun:test`'s lifecycle
 * registry, and every suite that drives the parked store imports `bun:test`
 * semantics and is excluded from vitest.
 *
 * Both wirings are lint-enforced by `npm run lint:parked-turn-start-hermeticity`
 * (`scripts/check-parked-turn-start-hermeticity.mjs`): deleting either one fails
 * CI instead of silently un-protecting a runner. Same shape as the sibling
 * `agent-state-dir-guard.mjs` + `check-agent-state-dir-hermeticity.mjs` and
 * `hindsight-bank-guard.mjs` + `check-hindsight-bank-hermeticity.mjs` pairs.
 */
import { afterEach } from "bun:test";
import {
  __parkedTurnStartCountForTest,
  __resetParkedTurnStartsForTest,
} from "../../telegram-plugin/gateway/stream-render.js";

/** Message prefix thrown when the guard trips. Greppable in CI logs. */
export const PARKED_TURN_START_GUARD_MARKER = "SWITCHROOM_PARKED_TURN_START_LEAK";

/**
 * Register the global `afterEach`. Exported (rather than inlined) so the
 * runtime alarm can drive it directly.
 *
 * Idempotent: two preload entries resolving to this module in one process
 * would otherwise stack two hooks and report the same leak twice.
 */
export function installParkedTurnStartGuard(target = globalThis) {
  if (target.__switchroomParkedTurnStartGuard) return target.__switchroomParkedTurnStartGuard;

  const hook = () => {
    const leaked = __parkedTurnStartCountForTest();
    if (leaked === 0) return;
    // Reset FIRST: the throw below fails this test, and leaving the store dirty
    // would fail every test after it too — the cascade this guard exists to
    // replace with a single, attributable failure.
    __resetParkedTurnStartsForTest();
    throw new Error(
      `${PARKED_TURN_START_GUARD_MARKER}: this test left ${leaked} parked turn-start(s) in ` +
        `stream-render's module-scope store. That store is shared by every file in the ` +
        `bun sweep (one process, one module registry) and a leftover entry makes the ` +
        `obligation sweep read the session as BUSY for the rest of the run (#4611). ` +
        `Add \`afterEach(() => __resetParkedTurnStartsForTest())\` to this suite — ` +
        `\`beforeEach\` alone cleans entry, not exit.`,
    );
  };

  afterEach(hook);
  target.__switchroomParkedTurnStartGuard = { hook };
  return target.__switchroomParkedTurnStartGuard;
}

installParkedTurnStartGuard();
