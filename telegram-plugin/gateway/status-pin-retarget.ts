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
 * Failure semantics are inherited from `reconcilePin`, not re-invented here: a
 * leg-1 result that is NON-NULL means the unpin was never confirmed (#3664
 * Defect B — the old message is provably still pinned and the claim was
 * deliberately retained). Pinning the new message then would leave two pins in
 * the chat with a durable record of one, so leg 2 is skipped and the retained
 * claim is left for the next reconcile / the mid-session reaper / the boot
 * sweep to retry.
 *
 * Dependency-free apart from the pure decision, so it is provable in isolation
 * (`telegram-plugin/tests/status-pin-retarget.test.ts`); the gateway owns the
 * wiring of `runLeg` / `commit`.
 */

import type { DesiredPin, PinState } from '../status-pin.js'
import { decidePinAction } from '../status-pin.js'
import type { StatusPinPersistOp, StatusPinStoreFsSeam } from './status-pin-store.js'
import { reconcileAndPersistStatusPin } from './status-pin-store.js'

/** The three parallel in-memory maps the gateway keys by pinKey. */
export interface StatusPinRegistries {
  /** The claim: which message we believe is pinned for this key. */
  state: Map<string, PinState>
  /** Which chat that claim lives in (the `wk:` reaper needs it to unpin). */
  chatIds: Map<string, string>
  /** When the claim was FIRST taken — the reaper's TTL age. */
  pinnedAt: Map<string, number>
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
   * Execute the real Telegram pin/unpin for one leg (the gateway binds
   * `reconcilePin`). Must never throw — API errors are absorbed inside.
   */
  runPin: (from: PinState | null, want: DesiredPin) => Promise<PinState | null>
  registries: StatusPinRegistries
}

/**
 * Drive `prev → desired` for one pin key, expanding a RETARGET into its two
 * legs. Every other action (pin / unpin / noop) is a single leg, unchanged.
 *
 * Each leg is committed to the registries as it lands, so the in-memory claim
 * never lags the durable row — including the intermediate cleared state between
 * a retarget's two legs, which is what lets a concurrent reader (the `wk:`
 * reaper) see an honest snapshot rather than a claim on an unpinned id.
 *
 * Callers must hold the per-key reconcile lock (`withPinReconcileLock`); `prev`
 * is read once by the caller and both legs run inside that critical section.
 */
export async function runStatusPinReconcile(args: StatusPinReconcileArgs): Promise<void> {
  const { pinKey, chatId, prev, desired, persist, runPin, registries } = args

  // Publish a leg's outcome. `pinnedAt` is set only when absent so it keeps the
  // FIRST-taken timestamp; clearing the claim drops it, so a re-pin ages fresh.
  const commit = (next: PinState | null): void => {
    if (next == null) {
      registries.state.delete(pinKey)
      registries.chatIds.delete(pinKey)
      registries.pinnedAt.delete(pinKey)
      return
    }
    registries.state.set(pinKey, next)
    registries.chatIds.set(pinKey, chatId)
    if (!registries.pinnedAt.has(pinKey)) registries.pinnedAt.set(pinKey, Date.now())
  }

  // One leg, with the persist ordering its action requires. Only a fresh `pin`
  // opens the crash window that persist-BEFORE-pin closes; unpin / noop / re-pin
  // of the same id clear or leave the row and are safe to persist after.
  const runLeg = (from: PinState | null, want: DesiredPin): Promise<PinState | null> => {
    if (persist == null) return runPin(from, want)
    const legAction = decidePinAction(from, want)
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
      applyPin: () => runPin(from, want),
    })
  }

  const action = decidePinAction(prev, desired)

  if (action.kind === 'repin' && desired.pinned) {
    const afterUnpin = await runLeg(prev, { pinned: false })
    commit(afterUnpin)
    // Never-confirmed unpin (#3664 Defect B): keep the retained claim, skip the
    // pin leg. See the docblock.
    if (afterUnpin != null) return
    commit(await runLeg(null, desired))
    return
  }

  commit(await runLeg(prev, desired))
}
