/**
 * turn-state-purge.ts — defense-in-depth cleanup for the silence-poke
 * framework-fallback (gateway.ts).
 *
 * The fallback's `purgeReactionTracking(fbKey)` clears the canonical
 * `statusKey(chatId, threadId)` for the exact chat+thread that armed
 * the silence-poke. But `activeTurnStartedAt` (and its siblings) can
 * legitimately hold MORE than one entry for the same chat — e.g.:
 *
 *   - a normal turn-end handler null'd `currentTurn` but skipped
 *     `purgeReactionTracking` on a code-path that didn't reach it
 *     (gateway.ts:5887/5921/6193 — purgeReactionTracking calls in
 *     those handlers are conditional/not on every branch), so
 *     `activeTurnStartedAt[oldKey]` is dangling when the fallback
 *     fires for a NEW key
 *   - a multi-thread chat (topic-based group, or a `null` vs
 *     `undefined` thread variant) has entries under different keys of
 *     the SAME chat
 *
 * In either case, the fallback purges `fbKey` but a sibling key for
 * the same chat remains → `activeTurnStartedAt.size > 0` persists →
 * `#1556`'s turn-gate holds every new inbound forever → user sees
 * "not responding" while claude is actually idle (gymbro + klanker,
 * 2026-05-20).
 *
 * This helper sweeps any sibling keys for the firing chat after the
 * canonical `purgeReactionTracking(fbKey)`, via the same purger.
 * Multi-chat safe: it only touches keys whose chatId matches — other
 * chats' active turns are untouched, preserving the deliberate
 * multi-chat safety #1546 kept.
 *
 * Key shape: `statusKey(chatId, threadId)` emits
 * `${chatId}:${threadId ?? '_'}`. Chat ids are numeric strings (no
 * `:` inside), so `indexOf(':')` is a safe prefix delimiter. A
 * "prefix-without-separator" false positive (e.g. chatId `123` vs key
 * `1234:_`) is structurally impossible because the helper splits on
 * `:` and equates the prefix, NOT a string-startsWith.
 *
 * Pure / dependency-free so the multi-chat-safety and key-shape logic
 * are unit-testable without standing up a gateway — mirrors the
 * `#1544 / #1546 / #1549 / #1558` pure-seam idiom.
 */

export interface PurgeStaleTurnsResult {
  /** Keys for `chatId` that the helper purged via the callback. */
  purged: string[]
}

export function purgeStaleTurnsForChat(
  chatId: string,
  keys: Iterable<string>,
  purger: (key: string) => void,
  /**
   * Per-sibling staleness gate. A sibling key for `chatId` is purged only when
   * this returns true. CRITICAL for one-agent-owns-supergroup: all of an
   * agent's forum topics share the SAME chatId, so a chatId-only match would
   * purge a LIVE sibling topic's reaction controller + typing loop when ANOTHER
   * topic's 300s silence-poke fires (the gymbro/klanker wedge class). The
   * caller passes a predicate true only for siblings themselves silent ≥ the
   * fallback threshold (their own poke would also fire) — preserving the #1556
   * dangling-key cleanup while sparing live siblings. Defaults to always-stale
   * for back-compat (DM / single-topic callers, where every sibling is
   * genuinely dangling).
   */
  isStale: (key: string) => boolean = () => true,
): PurgeStaleTurnsResult {
  if (!chatId) return { purged: [] }
  const purged: string[] = []
  // Snapshot first — `purger` typically deletes from the same Map the
  // caller is iterating; mutating during iteration is correct on JS
  // Maps but a snapshot makes the contract explicit and lets the
  // helper accept any iterable.
  const snapshot: string[] = []
  for (const k of keys) snapshot.push(k)
  for (const key of snapshot) {
    const sep = key.indexOf(':')
    if (sep < 0) continue // malformed / non-statusKey shape — skip
    const keyChat = key.slice(0, sep)
    if (keyChat !== chatId) continue
    if (!isStale(key)) continue // live sibling topic — leave its turn state intact
    purger(key)
    purged.push(key)
  }
  return { purged }
}
