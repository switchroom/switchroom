/**
 * status-pin-retarget.ts — orchestrates a status-pin RETARGET as two persisted
 * legs, so a single-shot caller still ends up with the new surface pinned.
 *
 * The defect this closes
 * ----------------------
 * `decidePinAction(prev, { pinned: true, messageId: NEW })` with a claim on a
 * DIFFERENT message used to report a bare `unpin`, documented as "a subsequent
 * desired-pin re-pins the new one on the next reconcile". That is true only for
 * callers that RE-DRIVE the reconcile:
 *
 *   - the worker-activity feed does (`syncPin` runs on every steady-state edit,
 *     `worker-activity-feed.ts`), so its group-message rotation converges;
 *   - the FOREGROUND activity card does NOT. `narrative-lane.ts` reconciles
 *     `fg:<statusKey>` exactly once, inside the `activityMessageId == null`
 *     OPEN branch; the `else` (edit) branch never touches the pin, and turn-end
 *     only ever unpins (`turn-end.ts`).
 *
 * So when the ack-first reopen path (`feed-reopen-gate.ts`) nulls
 * `activityMessageId` mid-turn and a FRESH card opens, that one reconcile
 * unpinned the old card and stopped. The live card ran unpinned for the rest of
 * the turn, and — because the retarget mapped to a `clear` persist op — the
 * durable `status-pins.json` row was deleted too, so neither the mid-session
 * reaper nor the next boot's sweep had anything left to reconcile from.
 *
 * Why TWO legs and not one
 * ------------------------
 * `reconcileAndPersistStatusPin` carries the persist-BEFORE-pin contract for a
 * single op. Running the retarget as one `pin`-op leg would write a pending row
 * naming the NEW id before the OLD one is unpinned — a crash in that window
 * erases the only durable record of a message that is still pinned. Splitting
 * it keeps each leg's crash-safety exactly as designed:
 *
 *   leg 1  unpin the stale claim, with the row still naming the OLD id;
 *   leg 2  pin the new message from a null claim, with its own pending row.
 *
 * Failure semantics are inherited from `executePinLeg`, not re-invented here: a
 * leg-1 result that is NON-NULL means the unpin was never confirmed (#3664
 * Defect B — the old message is provably still pinned and the claim was
 * deliberately retained). Pinning the new message then would leave two pins in
 * the chat with a durable record of one, so leg 2 is skipped and the retained
 * claim is left for the next reconcile / the mid-session reaper / the boot
 * sweep to retry.
 *
 * THE SINGLE PATH (#3831)
 * -----------------------
 * This module is the ONLY decider. `status-pin-driver.ts` used to call
 * `decidePinAction` itself and carry its OWN copy of the expansion above — a
 * copy that recursed without the per-leg persistence, so which of the two
 * implementations ran decided whether the durable row survived. That copy is
 * deleted, and the driver's parameter type (`PinLegAction`) can no longer even
 * express a repin, so a second one cannot grow back.
 *
 * Dependency-free apart from the pure decision, so it is provable in isolation
 * (`telegram-plugin/tests/status-pin-retarget.test.ts`); the gateway owns the
 * wiring of `runPin` / `commit`.
 */

import type { DesiredPin, PinLegAction, PinState } from '../status-pin.js'
import { decidePinAction } from '../status-pin.js'
import type { StatusPinPersistOp, StatusPinStoreFsSeam } from './status-pin-store.js'
import { reconcileAndPersistStatusPin } from './status-pin-store.js'

/**
 * ONE in-memory claim for a pin key — the message we believe is pinned, the
 * chat it lives in, and when the claim was FIRST taken (the reaper's TTL age).
 *
 * #3809 — these were three parallel `Map`s (`statusPinState` / `statusPinChatIds`
 * / `statusPinPinnedAt`) written together but able to diverge. A `wk:` claim
 * whose chatId entry went missing was skipped by the mid-session reaper on
 * EVERY pass (it cannot unpin without a chat) and excluded from the durable
 * store-orphan net (which skips keys that DO have an in-memory claim) — so it
 * was permanently unreapable until the next boot, silently. Collapsing the
 * three maps into one record makes the invariant STRUCTURAL: a claim without a
 * chat id cannot be represented, so that gap cannot be reintroduced.
 */
export interface StatusPinClaim {
  /** Telegram message_id we believe is pinned for this key. */
  messageId: number
  /** Chat the pin lives in. Never empty — the reconcile refuses an empty chat. */
  chatId: string
  /** Wall-clock ms the claim was FIRST taken (survives a same-id re-pin). */
  pinnedAt: number
}

export interface StatusPinReconcileArgs {
  pinKey: string
  chatId: string
  /** The claim held for this key when the reconcile started. */
  prev: PinState | null
  /** What the caller wants pinned for this key now. */
  desired: DesiredPin
  /** Durable-store binding, or null when persistence is off (STATIC). */
  persist: { path: string; fs: StatusPinStoreFsSeam } | null
  /**
   * Execute ONE already-decided leg against Telegram (the gateway binds
   * `executePinLeg`). Must never throw — API errors are absorbed inside.
   */
  runPin: (action: PinLegAction, from: PinState | null) => Promise<PinState | null>
  /** The single claim registry, keyed by pinKey. */
  claims: Map<string, StatusPinClaim>
  /** Injectable clock for the `pinnedAt` stamp (tests). */
  now?: () => number
}

/**
 * Drive `prev → desired` for one pin key, expanding a RETARGET into its two
 * legs. Every other action (pin / unpin / noop) is a single leg, unchanged.
 *
 * Each leg is committed to the claim registry as it lands, so the in-memory
 * claim never lags the durable row — including the intermediate cleared state
 * between a retarget's two legs, which is what lets a concurrent reader (the
 * `wk:` reaper) see an honest snapshot rather than a claim on an unpinned id.
 *
 * Callers must hold the per-key reconcile lock (`withPinReconcileLock`); `prev`
 * is read once by the caller and both legs run inside that critical section.
 */
export async function runStatusPinReconcile(args: StatusPinReconcileArgs): Promise<void> {
  const { pinKey, chatId, prev, desired, persist, runPin, claims } = args
  const now = args.now ?? Date.now

  // Publish a leg's outcome into the single claim registry. `pinnedAt` is
  // carried forward when a claim already exists so it keeps the FIRST-taken
  // timestamp; clearing the claim drops it, so a re-pin ages fresh.
  const commit = (next: PinState | null): void => {
    if (next == null) {
      claims.delete(pinKey)
      return
    }
    const pinnedAt = claims.get(pinKey)?.pinnedAt ?? now()
    claims.set(pinKey, { messageId: next.messageId, chatId, pinnedAt })
  }

  // One leg, with the persist ordering its action requires. Only a fresh `pin`
  // opens the crash window that persist-BEFORE-pin closes; unpin / noop / re-pin
  // of the same id clear or leave the row and are safe to persist after.
  //
  // The leg action is decided ONCE, below, and threaded through to both the
  // persist-op mapping and the driver — the driver no longer re-derives it
  // (#3831).
  const runLeg = (
    legAction: PinLegAction,
    from: PinState | null,
  ): Promise<PinState | null> => {
    if (persist == null) return runPin(legAction, from)
    const op: StatusPinPersistOp =
      legAction.kind === 'pin'
        ? { kind: 'pin', messageId: legAction.messageId }
        : { kind: 'clear' }
    return reconcileAndPersistStatusPin({
      path: persist.path,
      fs: persist.fs,
      pinKey,
      chatId,
      op,
      applyPin: () => runPin(legAction, from),
      now: now(),
    })
  }

  const action = decidePinAction(prev, desired)

  // THE retarget expansion. This is the only copy in the codebase; the driver's
  // parameter type (`PinLegAction`) cannot express a repin, so a second one
  // cannot be written there again (#3831).
  if (action.kind === 'repin') {
    const afterUnpin = await runLeg(
      { kind: 'unpin', messageId: action.unpinMessageId },
      prev,
    )
    commit(afterUnpin)
    // Never-confirmed unpin (#3664 Defect B): keep the retained claim, skip the
    // pin leg. See the docblock.
    if (afterUnpin != null) return
    commit(await runLeg({ kind: 'pin', messageId: action.pinMessageId }, null))
    return
  }

  commit(await runLeg(action, prev))
}
