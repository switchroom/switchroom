/**
 * auth-net-guard-core — the scope predicate and trip counter behind the
 * auth-broker hermeticity guard (#3612).
 *
 * Deliberately free of any vitest import and of any hook registration:
 * importing this module must NOT install the guard. That separation is
 * what lets `src/auth/broker/net-hermeticity.test.ts` be an honest alarm —
 * it reads the counter without installing the thing it is verifying, so
 * unwiring `test.setupFiles` in vitest.config.ts makes it FAIL rather than
 * silently self-heal.
 *
 * Consumers:
 *   - tests/vitest-setup/auth-net-guard.mjs   (the vitest setup file)
 *   - scripts/check-auth-test-hermeticity.mjs (the lint gate — plain node,
 *     which is why this is .mjs and not .ts)
 *   - src/auth/broker/net-hermeticity.test.ts (the runtime proof)
 */

import { readFileSync } from "node:fs";

/** Message prefix thrown by the guard when it blocks an outbound call. */
export const AUTH_NET_GUARD_MARKER = "SWITCHROOM_AUTH_TEST_NET_GUARD";

/**
 * Source-level markers for "this test file can reach `fetchQuota`".
 *
 * - `new AuthBroker(` — the broker force-probes every candidate account
 *   whose eligibility is still `unknown` on the mark-exhausted / roll /
 *   probe-quota paths (`nextHealthyAccountLive` → `probeAndCacheOne` →
 *   `fetchQuota`, src/auth/broker/server.ts).
 * - a `fetchQuota` reference — the probe called directly.
 *
 * Content-based on purpose: a hand-maintained path list is exactly the
 * thing that goes stale when a new broker test lands in a new directory.
 */
const REACHES_FETCH_QUOTA = [/\bnew\s+AuthBroker\s*\(/, /\bfetchQuota\b/];

/**
 * Strip comments so a file that only *mentions* `fetchQuota` in prose is
 * not treated as a live-probe reachable file. Same shape as
 * `scripts/check-vault-test-hermeticity.mjs`; the `[^:]` guard keeps
 * `https://…` inside string literals from eating the rest of the line.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** True when `source` (the text of a test file) can reach `fetchQuota`. */
export function shouldGuardSource(source) {
  const code = stripComments(source);
  return REACHES_FETCH_QUOTA.some((re) => re.test(code));
}

const guardDecisionCache = new Map();

/** True when the test file at `absPath` can reach `fetchQuota`. */
export function shouldGuardTestFile(absPath) {
  const cached = guardDecisionCache.get(absPath);
  if (cached !== undefined) return cached;
  let decision;
  try {
    decision = shouldGuardSource(readFileSync(absPath, "utf8"));
  } catch {
    decision = false;
  }
  guardDecisionCache.set(absPath, decision);
  return decision;
}

let trips = 0;

/** Reset the per-test trip counter. Called by the setup file's beforeEach. */
export function resetAuthNetGuardTrips() {
  trips = 0;
}

/** Record one blocked outbound call. Called by the guard stub. */
export function recordAuthNetGuardTrip() {
  trips += 1;
}

/**
 * Outbound `fetch` calls the guard blocked during the current test.
 *
 * A hermeticity test asserts this is > 0 on the mark-exhausted path: a zero
 * means either the guard is not installed, or the probe no longer happens
 * there and the regression proof has quietly stopped proving anything.
 */
export function authNetGuardTrips() {
  return trips;
}
