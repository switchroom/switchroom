/**
 * hindsight-bank-guard — the test-runner entry point that stops a test process
 * reaching the FLEET's Hindsight and minting banks in it.
 *
 * ── The defect class this closes ────────────────────────────────────────
 *
 * `~/.switchroom/` is production state and a test that writes there corrupts a
 * running fleet (CLAUDE.md, "Vault & shared-state test discipline"). The
 * fleet's Hindsight instance is the same kind of shared production state, and
 * it had no guard: on 2026-07-30T23:51-23:55Z a harness/parity sweep minted
 * eleven throwaway banks in the live instance, all named after switchroom test
 * fixtures. One was `clerk` — a LIVE agent's name. Agent `clerk` actually
 * writes to the bank `assistant` (86,240 facts), and the empty decoy `clerk`
 * bank carried a warning annotation in its `mission` saying exactly that. The
 * sweep replaced the bank and erased the annotation, and a week later an agent
 * read the empty bank and reported clerk's memory as lost.
 *
 * Hindsight has no "missing bank" error: `get_or_create_bank_profile`
 * (engine/retain/bank_utils.py) and `ensure_bank_exists`
 * (engine/retain/fact_storage.py) auto-create on miss and return zeros. One
 * stray request is enough, and deleting a stray does not help — the next
 * lookup of that name recreates it. So the fix has to stop the REQUEST.
 *
 * ── Mechanism ───────────────────────────────────────────────────────────
 *
 * Loaded by BOTH runners, before any test module (and its module-level env
 * reads) is imported:
 *
 *   vitest    `test.setupFiles` in vitest.config.ts
 *   bun test  `[test] preload` in bunfig.toml + telegram-plugin/bunfig.toml
 *             (bun reads the bunfig in its CWD, not an ancestor's, and this
 *             repo runs `bun test` from both the repo root and
 *             telegram-plugin/)
 *
 * Two halves, in this order:
 *
 *   1. Capture the ambient Hindsight URLs into the blocked-origin set, THEN
 *      scrub those env vars to an unroutable sentinel. Inside an agent
 *      container `npm test` inherits `HINDSIGHT_API_URL=http://127.0.0.1:18888`
 *      — the live fleet endpoint — so a test that reads the env and fetches is
 *      talking to production by default. Capture-then-scrub means the origin
 *      stays blocked even though nothing can read it any more.
 *   2. Replace `globalThis.fetch` with a stub that throws for any request to a
 *      fleet origin and delegates everything else. A test that stubs `fetch`
 *      itself replaces this wrapper, which is correct — a stubbed fetch makes
 *      no network call and cannot reach production.
 *
 * The predicate is origin-based, never bank-name-based: a test named after a
 * live agent is not the hazard, a test TALKING TO THE FLEET is. Ephemeral
 * servers (`listen(0)`, ports 32768-60999 on Linux) can never collide with the
 * fleet ports, so the existing suites that stand up real local Hindsight-shaped
 * servers and drive real bank paths — `tests/hindsight-mcp-shim.test.ts`,
 * `tests/hindsight-write-redaction.test.ts` — are unaffected.
 *
 * **`fetch` throwing `SWITCHROOM_HINDSIGHT_BANK_GUARD` is the guard working,
 * not a bug.** If a test genuinely owns an instance on a fleet port, opt in
 * explicitly with `SWITCHROOM_TEST_HINDSIGHT_ALLOW_ORIGINS`.
 *
 * ── Why not fix this in the Hindsight engine ────────────────────────────
 *
 * Because the server cannot tell a test-context caller from a production one:
 * the stray banks arrived as ordinary, well-formed bank-scoped requests. Any
 * engine-side rule would have to guess from the bank name, and a name guess
 * cannot both let a genuinely new agent create its bank and refuse a fixture
 * that shares a live agent's name. The test runner is the only place where
 * "this is a test context" is structural. It also means this guard is on no
 * boot path whatsoever — it ships in no image and runs only under `vitest` /
 * `bun test` — so it cannot crash-loop an agent the way a guard added to
 * `migrations.py`'s `ensure_*` reconcile could.
 *
 * Both wirings are lint-enforced by `npm run lint:hindsight-bank-hermeticity`
 * (`scripts/check-hindsight-bank-hermeticity.mjs`): deleting any one of them
 * fails CI instead of silently un-protecting a runner. The matching runtime
 * alarm is `tests/hindsight-bank-guard.test.ts`. Same shape as the sibling
 * `agent-state-dir-guard.mjs` + `check-agent-state-dir-hermeticity.mjs` and
 * `auth-net-guard.mjs` + `check-auth-test-hermeticity.mjs` pairs.
 */
import {
  HINDSIGHT_SENTINEL_URL,
  HINDSIGHT_URL_ENV_VARS,
  blockedMessage,
  buildHindsightGuardPolicy,
  recordHindsightBankGuardTrip,
  shouldBlockHindsightRequest,
} from "./hindsight-bank-guard-core.mjs";

/**
 * Install the guard on an environment + global object. Exported (rather than
 * inlined) so the runtime alarm can assert its behaviour against a synthetic
 * globalThis without a second implementation.
 *
 * Idempotent: a second load (vitest setup + a bun preload in one process)
 * leaves the first wrapper in place rather than stacking two.
 */
export function installHindsightBankGuard(env = process.env, target = globalThis) {
  if (target.__switchroomHindsightBankGuard) return target.__switchroomHindsightBankGuard;

  // Capture BEFORE scrubbing — the ambient value is the fleet endpoint we
  // most need in the blocked set.
  const policy = buildHindsightGuardPolicy(env);
  for (const k of HINDSIGHT_URL_ENV_VARS) {
    if (env[k]) env[k] = HINDSIGHT_SENTINEL_URL;
  }

  const realFetch = target.fetch;
  const guarded = function fetch(input, init) {
    if (shouldBlockHindsightRequest(input, policy)) {
      recordHindsightBankGuardTrip();
      return Promise.reject(new Error(blockedMessage(input)));
    }
    return realFetch.call(target, input, init);
  };
  target.fetch = guarded;
  target.__switchroomHindsightBankGuard = { policy, realFetch, guarded };
  return target.__switchroomHindsightBankGuard;
}

installHindsightBankGuard();
