/**
 * Admin-only vault keys (`vault.broker.adminOnlyKeys`).
 *
 * A credential listed here is held to a higher approval bar than the
 * fleet default:
 *
 *  - Only the **admin operator** (`access.allowFrom[0]`) may approve a
 *    grant for it — other allowFrom members cannot.
 *  - It can never be minted via **posture attestation** (which is
 *    agent-forgeable: `claude` shares the per-agent broker socket with
 *    the gateway). Granting it REQUIRES the operator passphrase, so an
 *    agent — even one on `postureMintAgents` — cannot self-grant it.
 *
 * Patterns are exact key names or `*` globs — e.g. `stripe/*` (whole
 * namespace), a trailing-`*` suffix match, or `microsoft/ken-tokens`
 * (exact). `*` matches any run of characters (including `/`). Matching
 * is case-sensitive — vault keys are case-sensitive.
 *
 * Pure + dependency-free so BOTH the broker (`src/vault/broker`) and the
 * gateway (`telegram-plugin/gateway`) import it without pulling runtime
 * deps across the boundary.
 */

function globToRegExp(pattern: string): RegExp {
  // Escape every regex metachar EXCEPT `*`, then turn `*` into `.*`.
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** True if `key` matches any admin-only `pattern` (exact or `*` glob). */
export function matchesAdminOnlyKey(
  key: string,
  patterns: readonly string[],
): boolean {
  for (const p of patterns) {
    if (p === key) return true; // fast path: exact
    if (p.includes("*") && globToRegExp(p).test(key)) return true;
  }
  return false;
}

/**
 * The subset of `keys` that are admin-only under `patterns`.
 * Order-preserving and deduped.
 */
export function filterAdminOnlyKeys(
  keys: readonly string[],
  patterns: readonly string[],
): string[] {
  const out: string[] = [];
  for (const k of keys) {
    if (matchesAdminOnlyKey(k, patterns) && !out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * Posture-mint guard. Returns the admin-only keys in `requestedKeys`
 * that are being NEWLY added — i.e. not already present in the agent's
 * active grant set (`existingKeys`).
 *
 * Posture attestation may RETAIN an admin-only key across a union
 * re-mint (the gateway unions a new key with the agent's existing grant
 * keys, so a previously passphrase-granted admin-only key legitimately
 * reappears) but may never ADD one — adding requires the operator
 * passphrase. A non-empty result means the posture mint must be denied.
 */
export function adminOnlyKeysBeingAdded(
  requestedKeys: readonly string[],
  existingKeys: readonly string[],
  patterns: readonly string[],
): string[] {
  const existing = new Set(existingKeys);
  const blocked: string[] = [];
  for (const k of requestedKeys) {
    if (
      matchesAdminOnlyKey(k, patterns) &&
      !existing.has(k) &&
      !blocked.includes(k)
    ) {
      blocked.push(k);
    }
  }
  return blocked;
}
