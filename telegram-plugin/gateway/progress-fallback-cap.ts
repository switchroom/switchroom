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
 *
 * NOTE: this is the check-then-record shape (`progressFallbackAtCap` then
 * `recordProgressFallbackSend`) which is NOT safe against two truly-concurrent
 * same-key calls — both can pass the cap check before either records. The
 * production path uses {@link reserveProgressSlot} / {@link sendWithProgressCap}
 * instead, which reserve the slot BEFORE the await so the count is visible to a
 * concurrent caller. These two remain for the direct unit tests of the window.
 */
export function recordProgressFallbackSend(key: string, now: number): void {
  const recent = prune(key, now);
  recent.push(now);
  recentSends.set(key, recent);
}

/** A reserved cap slot; call {@link release} to hand it back (idempotent). */
export interface ProgressSlotReservation {
  release: () => void;
}

/**
 * Reserve one fallback-window slot for `key` at `now`, or refuse when the
 * window is already at capacity.
 *
 * Unlike {@link progressFallbackAtCap} + {@link recordProgressFallbackSend},
 * this records the timestamp AT CHECK TIME (before the caller's `await`), so a
 * second concurrent same-key call sees the reservation and cannot overshoot the
 * cap. On send failure the caller must {@link ProgressSlotReservation.release |
 * release} it, which removes exactly the one timestamp this reservation added —
 * so a throw still burns no slot (#4328 Fix 2 preserved under concurrency).
 *
 * Returns `null` when the window is full (caller refuses with `turn_limit`).
 */
export function reserveProgressFallbackSlot(
  key: string,
  now: number,
): ProgressSlotReservation | null {
  const recent = prune(key, now);
  if (recent.length >= PROGRESS_FALLBACK_MAX) return null;
  recent.push(now);
  recentSends.set(key, recent);

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      const arr = recentSends.get(key);
      if (!arr) return;
      // Remove exactly ONE occurrence of the reserved timestamp — concurrent
      // reservations may share the same `now`, and they are interchangeable.
      const idx = arr.indexOf(now);
      if (idx >= 0) arr.splice(idx, 1);
      if (arr.length === 0) recentSends.delete(key);
      else recentSends.set(key, arr);
    },
  };
}

/** Max `progress_update` deliveries per turn atom — mirrors the fallback cap. */
export const PROGRESS_TURN_MAX = 5;

/** Dependencies the unified reservation needs, threaded from the gateway. */
export interface ProgressCapDeps {
  /** The chat/topic status key. */
  key: string;
  /** `Date.now()` captured once by the caller. */
  now: number;
  /**
   * `activeTurnStartedAt.get(key)` — presence selects the turn-scoped counter
   * path; absence selects the rolling fallback window.
   */
  turnStart: number | undefined;
  /** The live per-turn counter (`progressUpdateTurnCount`). */
  turnCount: Map<string, number>;
}

/**
 * Reserve one attention-cap slot BEFORE the send, race-safely, on whichever
 * path applies:
 *
 * - turn atom present → increment `progressUpdateTurnCount` now (bounded at
 *   {@link PROGRESS_TURN_MAX}); release decrements it.
 * - turn atom absent → reserve a rolling-window slot via
 *   {@link reserveProgressFallbackSlot}.
 *
 * Because the reservation mutates the shared count synchronously (no `await`
 * between the read and the write), a second concurrent same-key call sees it
 * and cannot push the count past the cap. Returns `null` when already at cap.
 */
export function reserveProgressSlot(
  deps: ProgressCapDeps,
): ProgressSlotReservation | null {
  const { key, now, turnStart, turnCount } = deps;
  if (turnStart != null) {
    const current = turnCount.get(key) ?? 0;
    if (current >= PROGRESS_TURN_MAX) return null;
    turnCount.set(key, current + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        turnCount.set(key, Math.max(0, (turnCount.get(key) ?? 0) - 1));
      },
    };
  }
  return reserveProgressFallbackSlot(key, now);
}

/**
 * The reserve-then-confirm wrapper the gateway's `executeProgressUpdate` uses
 * around its send. Reserves a cap slot (race-safe, before the await), runs
 * `send`, and RELEASES the slot if `send` throws — so a failed delivery never
 * consumes a slot even under concurrency.
 *
 * Returns `{ capped: true }` when already at cap (no send attempted), else
 * `{ capped: false, result }` with the successful send's result. A successful
 * send KEEPS the reservation (it is the delivery record); the caller records
 * nothing extra.
 */
export async function sendWithProgressCap<T>(
  deps: ProgressCapDeps,
  send: () => Promise<T>,
): Promise<{ capped: true } | { capped: false; result: T }> {
  const reservation = reserveProgressSlot(deps);
  if (reservation === null) return { capped: true };
  try {
    const result = await send();
    return { capped: false, result };
  } catch (err) {
    reservation.release();
    throw err;
  }
}

/** Test-only: clear all fallback-window state. */
export function _resetProgressFallbackCap(): void {
  recentSends.clear();
}
