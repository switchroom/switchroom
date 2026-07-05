/**
 * Pure decision helpers for permission-card re-arm across gateway restarts
 * (#2861 / umbrella #2859).
 *
 * gateway.ts has top-level side effects and can't be unit-imported, so the
 * discriminable logic lives here where it can be tested in isolation. The
 * gateway wires these into `onPermissionRequest` and the boot-sweep.
 *
 * The mechanism, end to end:
 *
 *  1. The bridge keeps an outstanding-request ledger and re-sends every
 *     unresolved `permission_request` to the gateway on each IPC (re)connect
 *     (see `bridge/permission-ledger.ts`). So the gateway MUST treat repeat
 *     `permission_request`s for the same request_id as idempotent.
 *
 *  2. `classifyPermissionRequest` decides what a `permission_request` is:
 *       - `duplicate` — already live in `pendingPermissions` → ignore (no
 *         second card). The bridge re-sends on every reconnect.
 *       - `rearm` — not in memory, but the persisted card store still has
 *         entries for it → a gateway restart orphaned it. Restore the
 *         pending entry with the ORIGINAL `startedAt` (the TTL clock keeps
 *         running from the original ask; an already-expired re-arm falls
 *         straight into the existing TTL auto-deny sweep, which correctly
 *         unwedges claude) and re-attach the keyboard on the EXISTING
 *         message(s) via editMessageText — never a new card.
 *       - `fresh` — a brand-new ask; post a card as usual.
 *
 *  3. The boot-sweep becomes a grace-period strip. At boot, instead of
 *     stripping persisted cards immediately, wait ~90 s, then strip only the
 *     cards whose request_id is NOT currently live in `pendingPermissions`.
 *     A live entry means either a bridge re-send re-armed the card, OR a fresh
 *     approval was posted during the window — both are legitimately-pending
 *     asks. Only a genuinely dead session's card (container recreate → new
 *     bridge, empty ledger, never re-sends → no live entry) gets today's
 *     "Gateway restarted" strip.
 *
 * NEVER auto-allows anything: re-arm restores only the QUESTION, never a
 * verdict (no-self-escalation invariant). No model callsite is involved —
 * verdicts still travel only over the existing IPC/MCP channel.
 */

import type { PersistedPermCard } from './permission-card-store.js'

/** Default grace window before the boot-sweep strips an un-re-claimed card. */
export const PERMISSION_REARM_GRACE_MS = 90_000

/**
 * Kill switch. `SWITCHROOM_PERMISSION_REARM=0` reverts to the legacy
 * immediate-strip (gateway) / drop-when-disconnected (bridge) behavior.
 */
export function isPermissionRearmEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.SWITCHROOM_PERMISSION_REARM !== '0'
}

/**
 * Resolve the boot-sweep grace window (ms). `SWITCHROOM_PERMISSION_REARM_GRACE_MS`
 * overrides the default (used by tests to collapse the wait). A non-finite or
 * negative override falls back to the default.
 */
export function permissionRearmGraceMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.SWITCHROOM_PERMISSION_REARM_GRACE_MS
  if (raw == null || raw === '') return PERMISSION_REARM_GRACE_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : PERMISSION_REARM_GRACE_MS
}

export type PermissionRequestDisposition = 'duplicate' | 'rearm' | 'fresh'

/**
 * Classify an incoming `permission_request` (pure).
 *
 * @param hasPending    is the request_id already live in `pendingPermissions`?
 * @param persistedCount how many persisted card entries exist for this request_id?
 */
export function classifyPermissionRequest(opts: {
  hasPending: boolean
  persistedCount: number
}): PermissionRequestDisposition {
  if (opts.hasPending) return 'duplicate'
  if (opts.persistedCount > 0) return 'rearm'
  return 'fresh'
}

/**
 * Which persisted cards should the boot-sweep strip at the grace deadline?
 * Everything whose request_id is NOT currently live.
 *
 * `liveRequestIds` is the set of request_ids present in `pendingPermissions`
 * at the deadline — which covers BOTH:
 *   - re-armed cards (a bridge re-send restored the pending entry), and
 *   - fresh cards born during the grace window (a new approval posted after
 *     boot sets a pending entry the normal way).
 * Both are legitimately-pending asks a claude session is still suspended on;
 * stripping either would re-wedge the turn. Only a genuinely dead session's
 * card — persisted but with no live pending entry (the bridge never
 * reconnected to re-arm it) — is stripped. Keying on liveness rather than a
 * "was re-claimed" flag is what makes fresh-during-grace cards safe.
 */
export function computeBootSweepStripTargets(
  stale: readonly PersistedPermCard[],
  liveRequestIds: ReadonlySet<string>,
): PersistedPermCard[] {
  return stale.filter(card => !liveRequestIds.has(card.requestId))
}

/** Distinct request_ids in a persisted-card list (for per-request store removal). */
export function distinctRequestIds(
  cards: readonly PersistedPermCard[],
): string[] {
  return [...new Set(cards.map(c => c.requestId))]
}
