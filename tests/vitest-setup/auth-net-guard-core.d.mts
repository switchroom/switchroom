/**
 * Types for `auth-net-guard-core.mjs`.
 *
 * The guard is authored in plain ESM (not TypeScript) on purpose: it is
 * loaded both by vitest (`test.setupFiles`) and by the plain-node lint gate
 * `scripts/check-auth-test-hermeticity.mjs`, which cannot import a `.ts`
 * module. One implementation means the runner and the lint can never
 * disagree about which test files must be hermetic.
 */

/** Message prefix thrown by the guard when it blocks an outbound call. */
export const AUTH_NET_GUARD_MARKER: string;

/** True when the text of a test file can reach `fetchQuota`. */
export function shouldGuardSource(source: string): boolean;

/** True when the test file at `absPath` can reach `fetchQuota`. */
export function shouldGuardTestFile(absPath: string): boolean;

/** Reset the per-test trip counter (setup file's `beforeEach`). */
export function resetAuthNetGuardTrips(): void;

/** Record one blocked outbound call (the guard stub). */
export function recordAuthNetGuardTrip(): void;

/** Outbound `fetch` calls the guard blocked during the current test. */
export function authNetGuardTrips(): number;
