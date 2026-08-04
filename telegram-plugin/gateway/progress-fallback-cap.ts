/**
 * Fallback attention cap for `progress_update` when the inbound minted no turn
 * atom.
 *
 * The documented ceiling for `progress_update` is "at most 5 per turn" — but
 * that cap is enforced only when a turn atom exists (`activeTurnStartedAt` set
 * by `turn-start-surfaces.ts`). Some inbounds mint no turn atom at all —
 * handback turns and the synthesized progress-inbound turns — so on those a
 * worker could call `progress_update` at the unconditional 20s floor forever
 * (~3/min, ~180/hr into one chat), which defeats the documented cap and pings
 * the operator's phone indefinitely.
 *
 * This module restores the attention cap on that path with a rolling window:
 * at most {@link PROGRESS_FALLBACK_MAX} DELIVERIES per
 * {@link PROGRESS_FALLBACK_WINDOW_MS} per chat/topic key. It is not a ban
 * defence — the 20s floor and the edit-flood fuse still pace sends; this only
 * bounds how many phone-pinging progress messages a turn-less path can emit.
 *
 * State is a per-key list of delivery timestamps, pruned in place on every
 * access; a key whose window empties is dropped from the map so it cannot grow
 * unbounded across chats that have gone quiet. Because each window holds at
 * most {@link PROGRESS_FALLBACK_MAX} entries, the per-key array is O(1).
 */

const recentSends = new Map<string, number[]>();

/** Rolling window length. */
export const PROGRESS_FALLBACK_WINDOW_MS = 15 * 60_000;
/** Max deliveries per window per key — mirrors the 5-per-turn cap. */
export const PROGRESS_FALLBACK_MAX = 5;

/**
 * Prune timestamps older than the window for `key`, persisting the result.
 * Drops the key entirely when its window is empty so the map stays bounded.
 */
function prune(key: string, now: number): number[] {
  const cutoff = now - PROGRESS_FALLBACK_WINDOW_MS;
  const recent = (recentSends.get(key) ?? []).filter((ts) => ts > cutoff);
  if (recent.length === 0) recentSends.delete(key);
  else recentSends.set(key, recent);
  return recent;
}

/**
 * True when the rolling window for `key` is already at capacity — the caller
 * should refuse the send with `turn_limit`. Read-only w.r.t. the delivery
 * count (it only prunes aged-out entries); record a delivery separately via
 * {@link recordProgressFallbackSend} AFTER the send lands.
 */
export function progressFallbackAtCap(key: string, now: number): boolean {
  return prune(key, now).length >= PROGRESS_FALLBACK_MAX;
}

/**
 * Record one successful fallback-path delivery. Call ONLY after the send has
 * actually landed, so a thrown send never consumes a window slot.
 */
export function recordProgressFallbackSend(key: string, now: number): void {
  const recent = prune(key, now);
  recent.push(now);
  recentSends.set(key, recent);
}

/** Test-only: clear all fallback-window state. */
export function _resetProgressFallbackCap(): void {
  recentSends.clear();
}
