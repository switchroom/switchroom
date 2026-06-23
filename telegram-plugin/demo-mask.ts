/**
 * demo-mask — PII masking for the `demo` suffix on Telegram status
 * commands (`/usage demo`, `/auth demo`, `/status demo`, `/whoami demo`).
 *
 * Purpose: when an operator records a screen-recording / screenshot of a
 * status command, a trailing `demo` token masks the MUST-MASK PII tier so
 * real account emails, the operator's Telegram handle/id, and live vault key
 * names never end up in a published clip. This is per-command and opt-in —
 * the default output is unchanged and still shows the real values.
 *
 * Scope is deliberately narrow (the MUST-MASK tier only):
 *   1. Email addresses (account labels)        → maskEmail
 *   2. Telegram username / sender id           → maskUsername
 *   3. Vault key names                         → maskVaultKey
 *
 * Explicitly OUT of scope (NOT masked): agent names, MCP server names,
 * model ids, host paths, fleet topology. Those are not PII and masking
 * them would make a demo recording confusingly unrepresentative.
 *
 * Determinism contract: every function is a pure-ish mapping with a
 * process-lifetime stable cache. The SAME input always maps to the SAME
 * masked output within a process; DISTINCT inputs map to DISTINCT outputs
 * (within the size of each pool — pools are large enough for realistic
 * fleets, and overflow falls back to a stable suffixed form so distinctness
 * still holds). The mapping is intentionally NOT stable across process
 * restarts — it does not need to be, and a per-process map keeps the module
 * dependency-free (no persisted state, no hashing of secrets to disk).
 */

// ── stable assignment helper ─────────────────────────────────────────

/**
 * Assign a stable masked value for `input` using a per-pool Map. The first
 * time an input is seen it claims the next pool entry (or a deterministic
 * overflow form once the pool is exhausted); subsequent calls return the
 * same value. Distinct inputs never collide.
 */
function stableAssign(
  input: string,
  cache: Map<string, string>,
  pool: readonly string[],
  overflow: (index: number) => string,
): string {
  const existing = cache.get(input);
  if (existing !== undefined) return existing;
  const index = cache.size;
  const value = index < pool.length ? pool[index]! : overflow(index);
  cache.set(input, value);
  return value;
}

// ── emails ───────────────────────────────────────────────────────────

/**
 * Fixed pool of realistic fake emails. Named after computing pioneers so a
 * demo clip reads naturally without exposing the operator's real accounts.
 * All on `example.com` (RFC 2606 reserved — guaranteed not a real inbox).
 */
const EMAIL_POOL: readonly string[] = [
  'ada@example.com',
  'grace@example.com',
  'linus@example.com',
  'hopper@example.com',
  'turing@example.com',
  'lovelace@example.com',
  'dijkstra@example.com',
  'knuth@example.com',
  'ritchie@example.com',
  'torvalds@example.com',
];

const emailCache = new Map<string, string>();

/**
 * Map an account label to a stable realistic fake.
 *
 * Email-shaped labels map to the email pool. A non-email label (some
 * operators use a plain nickname as an account label) still gets a stable
 * fake email — masking a label that MIGHT carry a name to an obviously-fake
 * address is the safe choice for a recording.
 */
export function maskEmail(label: string): string {
  return stableAssign(
    label,
    emailCache,
    EMAIL_POOL,
    (i) => `demo${i + 1}@example.com`,
  );
}

// ── telegram username / sender id ────────────────────────────────────

/**
 * Fixed pool of fake Telegram handles. First input → `@demo_user`, second
 * distinct input → `@demo_user2`, etc., so a recording shows a believable
 * handle and a second account (if any) stays distinct.
 */
const USERNAME_POOL: readonly string[] = [
  '@demo_user',
  '@demo_user2',
  '@demo_user3',
  '@demo_user4',
  '@demo_user5',
];

const usernameCache = new Map<string, string>();

/**
 * Map a `@handle` or a numeric sender id to a stable fake handle. The input
 * may be `@realhandle` (when the user has a username) or a bare numeric id
 * (when they don't) — both map into the same pool, so the masked output is
 * always a `@demo_user…` handle regardless of the input shape. This also
 * normalises the id case to a friendlier handle for the recording.
 */
export function maskUsername(tag: string): string {
  return stableAssign(
    tag,
    usernameCache,
    USERNAME_POOL,
    (i) => `@demo_user${i + 1}`,
  );
}

// ── vault key names ──────────────────────────────────────────────────

const vaultKeyCache = new Map<string, string>();

/**
 * Map a real vault key name (e.g. `coolify/api-token`, `github/token`) to a
 * stable masked form (`demo/secret-1`, `demo/secret-2`, …). Keeps the
 * `namespace/key` shape so a recording still reads like a real vault listing
 * without revealing which services the operator has wired.
 */
export function maskVaultKey(name: string): string {
  return stableAssign(
    name,
    vaultKeyCache,
    [],
    (i) => `demo/secret-${i + 1}`,
  );
}

// ── test-only reset ──────────────────────────────────────────────────

/**
 * Clear all stable-assignment caches. Test-only — lets a test assert the
 * pool-ordering from a known-empty state without cross-test contamination.
 * Not used by production code paths.
 */
export function __resetDemoMaskCachesForTest(): void {
  emailCache.clear();
  usernameCache.clear();
  vaultKeyCache.clear();
}
