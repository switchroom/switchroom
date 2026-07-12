/**
 * Shared harness for the approval-hold outcome tests (#3084 follow-up).
 *
 * gateway.ts has top-level side effects and is NOT unit-importable (the same
 * constraint `permission-card-routing.test.ts:18` documents), so a literal
 * "boot the gateway" integration test is not available. Instead this harness
 * composes the REAL primitives the gateway composes, in the same order:
 *
 *   - `createRetryApiCall`   — the real retry policy, incl. its pre-call
 *                              flood-window short-circuit (#3094)
 *   - `retryWithThreadFallback` — the real send wrapper
 *   - `makeFloodWaitRecorder` / `makeFloodWaitProbe` — the real on-disk window
 *   - `selectHeldForRedelivery` / `isHeldUndeliverable` — the real hold decisions
 *   - `createBlockedApprovalStore` — the real surface record
 *   - `ttlForTool` — the real TTL
 *
 * Only two things are fakes: the Telegram transport (a counting send spy) and
 * the IPC verdict dispatch (a spy — this is what proves no `deny` was ever
 * fabricated). Everything that makes a DECISION is production code.
 *
 * Deliberately free of `vi.useFakeTimers()` / `vi.setSystemTime()` and of any
 * import from `fake-bot-api.ts` (which pulls in `vi` at module scope): this
 * harness must work under BOTH vitest and bun. It uses an explicit virtual
 * clock instead — the pattern from `typing-emitter.test.ts`.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GrammyError } from 'grammy'
import { createRetryApiCall, retryWithThreadFallback, isFloodWaitActiveError, GIVE_UP_MESSAGE } from '../retry-api-call.js'
import {
  floodStatePath,
  makeFloodWaitRecorder,
  makeFloodWaitProbe,
} from '../flood-circuit-breaker.js'
import {
  createBlockedApprovalStore,
  blockedApprovalsDir,
  selectHeldForRedelivery,
  selectOldestHeld,
  safeActionForRecord,
  holdReasonFor,
  heldRetryBackoffMs,
  applyDeliveredHoldReset,
  type UndeliverableMark,
  type BlockedApprovalStore,
} from '../gateway/approval-hold.js'
import { ttlForTool } from '../gateway/permission-timeout.js'
import { sweepPermissionTtl } from '../gateway/permission-ttl-sweep.js'
import { naturalAction } from '../permission-title.js'

/** A pending permission, shaped exactly like gateway.ts's `pendingPermissions` value. */
export interface Pending {
  tool_name: string
  description: string
  input_preview: string
  startedAt: number
  card_text: string
  cards: { chatId: string; messageId: number; threadId?: number | null }[]
  undeliverable?: UndeliverableMark | null
  redeliveryFailures?: number
}

/** An IPC verdict as `dispatchPermissionVerdict` would emit it. */
export interface Verdict {
  requestId: string
  behavior: 'allow' | 'deny'
  message?: string
}

/** Build the real 429 GrammyError Telegram sends during a flood ban. */
export function floodWait429(retryAfterSec: number): GrammyError {
  return new GrammyError(
    `Call to 'sendRichMessage' failed! (429: Too Many Requests: retry after ${retryAfterSec})`,
    {
      ok: false,
      error_code: 429,
      description: `Too Many Requests: retry after ${retryAfterSec}`,
      parameters: { retry_after: retryAfterSec } as GrammyError['parameters'],
    },
    'sendRichMessage',
    {},
  )
}

/**
 * The REAL failures a card send actually hits. Each throws exactly what Telegram
 * or the network would; `retryApiCall` then decides what surfaces to the caller.
 * The point of driving real errors is that our classification of them is the
 * thing under test.
 */
export type FaultKind = 'tg_502' | 'tg_500' | 'econnreset' | 'fetch_failed' | 'tg_400' | 'tg_403'

const grammyErr = (code: number, desc: string) => new GrammyError(
  `Call to 'sendRichMessage' failed! (${code}: ${desc})`,
  { ok: false, error_code: code, description: desc } as GrammyError['payload'] & { ok: false },
  'sendRichMessage',
  {},
)

export const FAULTS: Record<FaultKind, () => unknown> = {
  // TRANSIENT — the operator never got to answer. Must be HELD.
  tg_502: () => grammyErr(502, 'Bad Gateway'),
  tg_500: () => grammyErr(500, 'Internal Server Error'),
  econnreset: () => new Error('socket hang up ECONNRESET'),
  fetch_failed: () => new Error('fetch failed'),
  // PERMANENT — this card will never render. Falls through to the TTL.
  tg_400: () => grammyErr(400, "Bad Request: can't parse entities"),
  tg_403: () => grammyErr(403, 'Forbidden: bot was blocked by the user'),
}

export interface Harness {
  stateDir: string
  clock: { now: () => number; advance: (ms: number) => void }
  /** Every send the transport actually saw. Length === card send count. */
  sends: { chatId: string; requestId: string }[]
  /** Every IPC verdict dispatched. A `deny` here for an unseen card is THE bug. */
  verdicts: Verdict[]
  /** True whenever the transport was invoked while the window was still open. */
  sentIntoOpenWindow: boolean
  pending: Map<string, Pending>
  blockedStore: BlockedApprovalStore
  /** Simulate Telegram flood-banning the bot for `ms`. */
  banFor: (ms: number) => void
  /** Make a target throw a REAL error. `kind` picks which real failure. */
  breakTarget: (chatId: string, kind: FaultKind) => void
  /** The channel recovers — the target starts working again. */
  healTarget: (chatId: string) => void
  /** Flood-ban ONE target, so another can succeed in the same fan-out. */
  banTarget: (chatId: string, ms: number) => void
  /** Hang one target's send until `releaseTarget` — lets a tick overlap it. */
  hangTarget: (chatId: string) => void
  releaseTarget: (chatId: string) => void
  /** Make the NEXT postPermissionCard for `requestId` throw SYNCHRONOUSLY (one-shot). */
  breakSync: (requestId: string) => void
  /** Remaining ms of the open window, per the real probe. */
  floodRemainingMs: () => number
  /** The gateway's `postPermissionCard` — first delivery AND re-delivery. */
  postPermissionCard: (requestId: string) => Promise<void>
  /** Raise a permission request, as `onPermissionRequest` does. */
  raise: (requestId: string, toolName: string, inputPreview: string) => Promise<void>
  /** One 60s reaper tick: held-card re-delivery sweep, then the TTL sweep. */
  tick: () => Promise<void>
  /** Await every in-flight send (the reaper itself never awaits them). */
  settle: () => Promise<void>
  /** tick() then settle() — the common case. */
  tickSettled: () => Promise<void>
  /** Is this request still mid-send? (the in-flight guard, made observable) */
  isInFlight: (requestId: string) => boolean
  /** Drain the microtask queue so pending .then/.catch chains run to completion. */
  flush: () => Promise<void>
  /** Operator taps Allow on a live card. */
  tap: (requestId: string, behavior: 'allow' | 'deny') => void
}

export function createHarness(opts: { cap?: number; targets?: string[] } = {}): Harness {

  const stateDir = mkdtempSync(join(tmpdir(), 'approval-hold-'))
  const floodPath = floodStatePath(stateDir)

  // Anchored at real `Date.now()` so the virtual clock and the `untilTs` that
  // retryApiCall stamps (which uses real Date.now()) stay coherent at T0.
  let t = Date.now()
  const clock = { now: () => t, advance: (ms: number) => { t += ms } }

  const sends: { chatId: string; requestId: string }[] = []
  const verdicts: Verdict[] = []
  const pending = new Map<string, Pending>()
  const heldInFlight = new Set<string>()
  const blockedStore = createBlockedApprovalStore(blockedApprovalsDir(stateDir), 'overlord')

  const targetChats = opts.targets ?? ['-100200']
  /** Every send promise issued, so a test can await quiescence. */
  const inFlightSends: Promise<void>[] = []
  let banUntil = 0
  let sentIntoOpenWindow = false

  /** Per-chat fault: a factory for the REAL error the transport should throw. */
  const faults = new Map<string, () => unknown>()
  /** Chats banned individually (so one target can flood while another succeeds). */
  const perChatBan = new Map<string, number>()
  /** Requests whose NEXT postPermissionCard throws SYNCHRONOUSLY (one-shot). */
  const syncFaults = new Set<string>()
  /** Chats whose send HANGS until released — lets a tick overlap an in-flight send. */
  const gates = new Map<string, Promise<void>>()
  const gateReleases = new Map<string, () => void>()

  const probe = makeFloodWaitProbe(floodPath, clock.now)
  const robustApiCall = createRetryApiCall({
    sleep: async () => {}, // never actually sleep — the clock is virtual
    onFloodWait: makeFloodWaitRecorder(floodPath, clock.now),
    floodWaitRemainingMs: probe,
  })

  /** The fake Telegram transport. Rejects with a real 429 while banned. */
  async function transport(chatId: string, requestId: string): Promise<{ message_id: number }> {
    // Did this request reach Telegram while we ALREADY KNEW the window was
    // open? That is the amplifier #3094 exists to prevent, and the one way this
    // design could re-earn the ban. (The very FIRST send is how the ban is
    // discovered — the on-disk window is empty until a 429 records it — so it
    // is legitimately not "into a known-open window".)
    if (probe() > 0) sentIntoOpenWindow = true

    // Hang here until the test releases us — models a send still in flight when
    // the next 60s reaper tick fires.
    const gate = gates.get(chatId)
    if (gate != null) { await gate }

    const fault = faults.get(chatId)
    if (fault != null) {
      // Throw the REAL error Telegram/the network would produce, and let the REAL
      // retryApiCall decide what surfaces. The previous harness threw
      // GIVE_UP_MESSAGE directly — the *conclusion* — which hard-coded a premise
      // that turned out to be false (a 5xx is re-thrown RAW, not as a give-up) and
      // made a live auto-deny bug pass green.
      throw fault()
    }

    const until = Math.max(banUntil, perChatBan.get(chatId) ?? 0)
    const remaining = until - clock.now()
    if (remaining > 0) throw floodWait429(Math.ceil(remaining / 1000))
    sends.push({ chatId, requestId })
    return { message_id: 1000 + sends.length }
  }

  /**
   * Mirrors gateway.ts's reconcileBlockedApprovals — and shares its SELECTION
   * with production via `selectOldestHeld` (extracted in #3107's late fix), so
   * the harness cannot drift from the real oldest-held-wins rule.
   */
  function reconcile(): void {
    const oldest = selectOldestHeld(pending)
    if (oldest == null) { blockedStore.clear(); return }
    const { requestId, pend: p, mark: u } = oldest
    blockedStore.write({
      agent: 'overlord',
      requestId,
      toolName: p.tool_name,
      action: safeActionForRecord(naturalAction, p.tool_name, p.input_preview),
      blockedSince: p.startedAt,
      undeliverableSince: u.since,
      retryableAt: u.retryableAt,
      reason: u.reason,
    })
  }

  // ── postPermissionCard — mirrors gateway.ts's extracted send ──────────────
  // Fans out to N targets, exactly as `resolvePermissionCardTargets()` does (it
  // ends in `allowFrom.map(...)`). N>1 is the COMMON case on the re-delivery
  // path, so a harness pinned at N=1 cannot see the double-delivery and
  // permanent-wedge bugs that live in the multi-target interleaving.
  function postPermissionCard(requestId: string): Promise<void> {
    const pend = pending.get(requestId)
    if (pend == null) { heldInFlight.delete(requestId); return Promise.resolve() }

    // Mirrors gateway.ts: the flag is registered at the TOP of postPermissionCard
    // itself, so the initial-delivery caller is covered as well as the sweep —
    // otherwise a tick landing while a slow INITIAL send is in flight re-posts.
    heldInFlight.add(requestId)

    try {
    // A sync throw in the gateway's prologue (resolveScopedAllowChoices /
    // buildPermissionActionRow / resolvePermissionCardTargets), made drivable.
    if (syncFaults.delete(requestId)) {
      throw new Error(`sync fault building card for ${requestId}`)
    }

    // One increment per ATTEMPT, not per failing target (mirrors gateway.ts):
    // every failing target in the same fan-out stamps the SAME attempt number,
    // so N failing targets don't ratchet the backoff ladder N× faster.
    const attemptFailures = (pend.redeliveryFailures ?? 0) + 1

    const sends = targetChats.map(async (chatId) => {
      try {
        const sent = await retryWithThreadFallback<{ message_id: number }>(
          robustApiCall,
          () => transport(chatId, requestId),
          { threadId: undefined, chat_id: chatId, verb: 'permission_request' },
        )
        const live = pending.get(requestId)
        if (live && sent) {
          live.cards.push({ chatId, messageId: sent.message_id })
          // Drive the SAME reset the gateway drives (#3128) — no private copy.
          // Deleting `startedAt = now` from `applyDeliveredHoldReset` turns the
          // `(d2)` full-window outcome test RED, because there is one shared
          // implementation, not a mirror the harness silently compensates with.
          if (applyDeliveredHoldReset(live, clock.now())) {
            reconcile()
          }
        }
      } catch (e) {
        const live = pending.get(requestId)
        if (live == null) return
        // A card landed on ANOTHER target — the ask is NOT undeliverable.
        if (live.cards.length > 0) return
        const reason = holdReasonFor(e)
        if (reason == null) return // permanent — falls through to the TTL
        const failures = attemptFailures
        live.redeliveryFailures = failures
        const now = clock.now()
        const retryableAt = isFloodWaitActiveError(e)
          ? (e as { untilTs: number }).untilTs
          : now + heldRetryBackoffMs(failures)
        live.undeliverable = { since: live.undeliverable?.since ?? now, retryableAt, reason }
        reconcile()
      }
    })

    // ONE settle across ALL targets — the flag must not release while any
    // target is still in flight.
    return Promise.allSettled(sends).then(() => { heldInFlight.delete(requestId) })
    } catch (e) {
      // Mirrors gateway.ts: a sync throw never reaches the settle above, so
      // release the flag here and rethrow to the caller (raise, or tick's catch).
      heldInFlight.delete(requestId)
      throw e
    }
  }

  async function raise(requestId: string, toolName: string, inputPreview: string): Promise<void> {
    pending.set(requestId, {
      tool_name: toolName,
      description: '',
      input_preview: inputPreview,
      startedAt: clock.now(),
      card_text: `card for ${requestId}`,
      cards: [],
    })
    await postPermissionCard(requestId)
  }

  // ── the 60s reaper tick ───────────────────────────────────────────────────
  async function tick(): Promise<void> {
    const now = clock.now()

    // PR 2 — re-deliver held cards once the window closes.
    const { send } = selectHeldForRedelivery(pending.entries(), {
      floodRemainingMs: probe(),
      inFlight: heldInFlight,
      now,
      ...(opts.cap != null ? { cap: opts.cap } : {}),
    })
    // Fire-and-forget, exactly like the real reaper (`void postPermissionCard(...)`).
    // Awaiting here would make an overlapping tick impossible — and an
    // overlapping tick is precisely how a per-target in-flight clear
    // double-delivers. Tests that need the send settled `await h.settle()`.
    // postPermissionCard registers the in-flight flag itself; a SYNC throw is
    // caught here (mirrors gateway's sweep) so it can't kill the tick, and the
    // flag is deleted defensively so the entry stays re-selectable.
    for (const id of send) {
      try {
        inFlightSends.push(postPermissionCard(id))
      } catch {
        heldInFlight.delete(id)
      }
    }

    // The TTL sweep, as gateway.ts runs it.
    // The TTL sweep — the REAL production function, not a copy. This is the whole
    // point: the guard AND the auto-deny it gates live in ONE place that both the
    // gateway and this harness call, so there is no private copy here that could
    // silently compensate for a guard deleted from production.
    sweepPermissionTtl({
      entries: pending,
      now,
      ttlForTool,
      onExpire: (k) => {
        verdicts.push({ requestId: k, behavior: 'deny', message: 'timed out' })
        pending.delete(k)
        reconcile()
      },
    })
  }

  function tap(requestId: string, behavior: 'allow' | 'deny'): void {
    const pend = pending.get(requestId)
    // A tap only resolves a card that actually EXISTS to be tapped.
    if (pend == null || pend.cards.length === 0) return
    verdicts.push({ requestId, behavior })
    pending.delete(requestId)
    reconcile()
  }

  return {
    stateDir,
    clock,
    sends,
    verdicts,
    get sentIntoOpenWindow() { return sentIntoOpenWindow },
    pending,
    blockedStore,
    banFor: (ms: number) => { banUntil = clock.now() + ms },
    breakTarget: (chatId: string, kind: FaultKind) => { faults.set(chatId, FAULTS[kind]) },
    healTarget: (chatId: string) => { faults.delete(chatId) },
    banTarget: (chatId: string, ms: number) => { perChatBan.set(chatId, clock.now() + ms) },
    hangTarget: (chatId: string) => {
      let release!: () => void
      gates.set(chatId, new Promise<void>(res => { release = res }))
      gateReleases.set(chatId, release)
    },
    releaseTarget: (chatId: string) => {
      gateReleases.get(chatId)?.()
      gates.delete(chatId)
      gateReleases.delete(chatId)
    },
    breakSync: (requestId: string) => { syncFaults.add(requestId) },
    floodRemainingMs: () => probe(),
    postPermissionCard,
    raise,
    tick,
    settle: async () => { await Promise.allSettled(inFlightSends.splice(0)) },
    tickSettled: async () => {
      await tick()
      await Promise.allSettled(inFlightSends.splice(0))
    },
    isInFlight: (requestId: string) => heldInFlight.has(requestId),
    flush: async () => {
      // Generous microtask drain — retryApiCall's give-up path hops several
      // awaits (3 attempts x noop sleep) before its catch finally runs.
      for (let i = 0; i < 50; i++) await Promise.resolve()
    },
    tap,
  }
}
