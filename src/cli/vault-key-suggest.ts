/**
 * Near-match suggestion for a denied/guessed vault key.
 *
 * When an agent asks the broker for a key it doesn't hold, the most
 * common cause is a *guessed* name (e.g. `postiz/api-key` when the
 * real, already-granted key is `marko/postiz-api-key`). Rather than
 * push the agent straight to `vault_request_access` — which mints a
 * grant for a key that may not even exist — we surface the keys it
 * ALREADY has access to that look like what it asked for.
 *
 * Pure + dependency-free so it's trivially unit-tested. The caller
 * fetches `available` from the broker `list` op (which returns exactly
 * the keys this agent is allowed to read — no info leak beyond what
 * `switchroom vault list` already discloses to the agent).
 */

/** Split a key into lowercased, non-empty tokens on `/`, `-`, `_`, `.`. */
function tokenize(key: string): string[] {
  return key
    .toLowerCase()
    .split(/[/\-_.]+/)
    .filter((t) => t.length > 0);
}

/**
 * Rank `available` keys by similarity to `requested` and return up to
 * `max` of the closest. A candidate must share at least one token to
 * be suggested at all. Ranking: most shared tokens first; ties broken
 * by the smaller symmetric token difference (closer overall shape).
 */
export function suggestVaultKeys(
  requested: string,
  available: string[],
  max = 3,
): string[] {
  const want = new Set(tokenize(requested));
  if (want.size === 0) return [];

  const scored = available
    .map((key) => {
      const have = new Set(tokenize(key));
      let shared = 0;
      for (const t of have) if (want.has(t)) shared++;
      // symmetric difference: tokens in exactly one of the two sets
      const diff = want.size + have.size - 2 * shared;
      return { key, shared, diff };
    })
    .filter((c) => c.shared > 0 && c.key !== requested)
    .sort((a, b) => b.shared - a.shared || a.diff - b.diff);

  return scored.slice(0, max).map((c) => c.key);
}
