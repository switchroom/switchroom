/**
 * Types for `hindsight-bank-guard-core.mjs`.
 *
 * The guard is authored in plain ESM (not TypeScript) on purpose: it is loaded
 * by vitest (`test.setupFiles`), by `bun test` (two `bunfig.toml` preloads),
 * and by the plain-node lint gate
 * `scripts/check-hindsight-bank-hermeticity.mjs`, which cannot import a `.ts`
 * module. One implementation means the runners and the lint can never disagree
 * about which origins are off limits.
 */

/** Message prefix thrown by the guard when it blocks an outbound call. */
export const HINDSIGHT_BANK_GUARD_MARKER: string;

/** Ports switchroom pins a FLEET Hindsight API to. */
export const FLEET_HINDSIGHT_PORTS: string[];

/** Env vars that can name a fleet Hindsight endpoint. */
export const HINDSIGHT_URL_ENV_VARS: string[];

/** Unroutable URL the guard repoints the scrubbed env vars at. */
export const HINDSIGHT_SENTINEL_URL: string;

/** Env var holding a comma-separated opt-in allowlist of origins. */
export const ALLOW_ORIGINS_ENV_VAR: string;

/** The guard's decision policy for one environment. */
export interface HindsightGuardPolicy {
  blockedOrigins: string[];
  allowedOrigins: string[];
}

/** `origin` (scheme://host:port) for a URL-ish input, or null. */
export function originOf(input: unknown): string | null;

/** Build the guard's decision policy from an environment. Pure. */
export function buildHindsightGuardPolicy(env?: Record<string, string | undefined>): HindsightGuardPolicy;

/** True when a test process must NOT issue this request. */
export function shouldBlockHindsightRequest(input: unknown, policy: HindsightGuardPolicy): boolean;

/** Reset the per-test trip counter (setup file's `beforeEach`). */
export function resetHindsightBankGuardTrips(): void;

/** Record one blocked outbound call (the guard stub). */
export function recordHindsightBankGuardTrip(): void;

/** Outbound requests the guard blocked during the current test. */
export function hindsightBankGuardTrips(): number;

/** Human-readable explanation for a blocked call. */
export function blockedMessage(input: unknown): string;
