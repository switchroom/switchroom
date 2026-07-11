/**
 * Deterministic outbound send gate for the Telegram Bot API (#3084, PR 1/3).
 *
 * WHY
 * ---
 * Each agent's gateway drives MANY outbound surfaces (reply chunks, answer /
 * draft stream edits, typing, worker-feed edits, reactions, cards). Each has
 * its own local throttle, but nothing composes them into a global or per-chat
 * ceiling — so during a busy turn the per-surface throttles ADD UP with no cap
 * and trip a per-bot-token flood ban (429 retry_after ~hours). See
 * `part2-audit.md` §3 and issue #3084.
 *
 * This module is the core control from `part3-design.md` §1: ONE token-bucket
 * scheduler that every Bot API call passes through (wired at the robustApiCall
 * layer so no call site can bypass it). It enforces:
 *
 *   - Global bucket:      25/sec  (headroom under Telegram's ~30/sec).
 *   - Per-chat bucket:    1/sec sustained, burst 3.
 *   - Per-group bucket:   18/min  (headroom under 20), keyed on chat type.
 *   - Per-message edit:   >=1.5s between edits of the same message_id, with
 *                         LAST-WRITE-WINS coalescing (an edit queued while one
 *                         is pending REPLACES the pending payload; it never
 *                         queues behind it — the next edit carries full state).
 *
 * It also skips no-op edits: identical rendered payload for the same
 * message_id is dropped before hitting the API (Telegram 400s "message is not
 * modified" today, which still costs flood budget).
 *
 * SAFETY / ROLLOUT
 * ----------------
 * Feature-flagged and default-OFF (`SWITCHROOM_TELEGRAM_SEND_GATE=1` to enable,
 * following the `SWITCHROOM_*=== '1'` gateway flag convention). When disabled,
 * `gate()` is a pure passthrough to the wrapped call — zero behaviour change.
 * This is PR 1 of 3; priority-class shedding + degraded mode (PR 2) and
 * observability + operator alert (PR 3) build on the counters exposed here.
 *
 * DETERMINISM / TESTABILITY
 * -------------------------
 * All time comes from an injectable `Clock` (`now()` + `sleep()`); there is no
 * inline `Date.now()` / `setTimeout()` in the scheduling logic, so a fake clock
 * makes the buckets fully deterministic under test. Token consumption happens
 * in a synchronous critical section (no `await` between reading the clock and
 * consuming), so concurrent admissions on a single-threaded runtime never
 * double-spend a token.
 */

import { createHash } from 'node:crypto'

/** Injectable time source. Default binds to real wall clock + setTimeout. */
export interface Clock {
  /** Milliseconds since epoch (monotonic-enough for bucket refill math). */
  now(): number
  /** Resolve after `ms` milliseconds. */
  sleep(ms: number): Promise<void>
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
}

/** Chat type as reported by Telegram, used to key the per-group bucket. */
export type ChatType = 'private' | 'group' | 'supergroup' | 'channel'

/**
 * Extra metadata a call site can attach so the gate can key the right buckets.
 * All fields optional — a call with none still passes the global bucket. These
 * mirror (a superset of) `RetryCallOpts` so the gate can wrap `robustApiCall`
 * transparently.
 */
export interface SendGateOpts {
  /** Destination chat id — keys the per-chat and (for groups) per-group bucket. */
  chat_id?: string
  /** Chat type — a group/supergroup additionally passes the per-group bucket. */
  chatType?: ChatType
  /** For edits: the target message id. Enables the edit floor + coalescing. */
  messageId?: number
  /**
   * For edits: the rendered payload (any stable-stringifiable value). Used for
   * the no-op skip (hash equal to last sent → dropped) and last-write-wins
   * coalescing. Only meaningful together with `messageId`.
   */
  editPayload?: unknown
  /** Informational label (e.g. "editMessageText"); surfaced in stats/logs. */
  verb?: string
}

/** Per-bucket counters, snapshotted by `stats()`. */
export interface BucketCounters {
  /** Calls that executed the wrapped fn. */
  sent: number
  /** Calls that had to wait on at least one bucket before executing. */
  queued: number
  /** Edits whose payload replaced a still-pending edit for the same message. */
  coalesced: number
  /** Calls dropped without hitting the API (no-op edit skip). */
  dropped: number
}

export interface SendGateStats {
  enabled: boolean
  global: BucketCounters
  /** Current token fill of each live bucket (for observability, PR 3). */
  fill: {
    global: number
    perChat: Record<string, number>
    perGroup: Record<string, number>
  }
}

export interface SendGateConfig {
  /** Master switch. When false, `gate()` is a straight passthrough. */
  enabled: boolean
  /** Injected clock; defaults to the real system clock. */
  clock?: Clock
  /** Global bucket rate (tokens/sec). Default 25. */
  globalPerSec?: number
  /** Per-chat sustained rate (tokens/sec). Default 1. */
  perChatPerSec?: number
  /** Per-chat burst capacity. Default 3. */
  perChatBurst?: number
  /** Per-group rate (tokens/min). Default 18. */
  perGroupPerMin?: number
  /** Minimum ms between edits of the same message_id. Default 1500. */
  editFloorMs?: number
}

/**
 * Classic token bucket. `tokens` refills continuously at `refillPerMs` up to
 * `capacity`. `consume` and `msUntilAvailable` both refill lazily against the
 * supplied `now`, so there is no timer per bucket — refill is computed on
 * demand from the injected clock.
 */
class TokenBucket {
  private tokens: number
  private lastRefillMs: number

  constructor(
    readonly capacity: number,
    private readonly refillPerMs: number,
    now: number,
  ) {
    this.tokens = capacity
    this.lastRefillMs = now
  }

  private refill(now: number): void {
    if (now <= this.lastRefillMs) return
    const elapsed = now - this.lastRefillMs
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs)
    this.lastRefillMs = now
  }

  /** Milliseconds until at least one token is available (0 if available now). */
  msUntilAvailable(now: number): number {
    this.refill(now)
    if (this.tokens >= 1) return 0
    return Math.ceil((1 - this.tokens) / this.refillPerMs)
  }

  /** Consume one token. Caller must have checked availability in the SAME tick. */
  consume(now: number): void {
    this.refill(now)
    this.tokens -= 1
  }

  fill(now: number): number {
    this.refill(now)
    return this.tokens
  }
}

interface PendingEdit {
  hash: string
  fn: () => Promise<unknown>
  promise: Promise<unknown>
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}

interface MessageEditState {
  /** Wall time of the last edit actually sent for this message. */
  lastSentMs: number
  /** Hash of the last payload actually sent (for the no-op skip). */
  lastHash: string | undefined
  /** At most one in-flight/queued coalesced edit per message. */
  pending: PendingEdit | null
}

function hashPayload(payload: unknown): string {
  const s = typeof payload === 'string' ? payload : stableStringify(payload)
  return createHash('sha256').update(s).digest('hex')
}

/** Deterministic JSON stringify (sorted keys) so equal payloads hash equal. */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (v as Record<string, unknown>)[k]
          return acc
        }, {})
    }
    return v
  })
}

export interface SendGate {
  /**
   * Run `fn` (a single Bot API call) through the gate. Returns whatever `fn`
   * resolves to. For a dropped no-op edit, resolves to `undefined` without
   * calling `fn`. For a coalesced edit, resolves when the coalesced send
   * completes (with that send's result).
   */
  gate<T>(fn: () => Promise<T>, opts?: SendGateOpts): Promise<T>
  /** Snapshot of counters + current bucket fill. */
  stats(): SendGateStats
}

const GROUP_TYPES = new Set<ChatType>(['group', 'supergroup'])

export function createSendGate(config: SendGateConfig): SendGate {
  const enabled = config.enabled
  const clock = config.clock ?? systemClock
  const globalPerSec = config.globalPerSec ?? 25
  const perChatPerSec = config.perChatPerSec ?? 1
  const perChatBurst = config.perChatBurst ?? 3
  const perGroupPerMin = config.perGroupPerMin ?? 18
  const editFloorMs = config.editFloorMs ?? 1500

  const counters: BucketCounters = { sent: 0, queued: 0, coalesced: 0, dropped: 0 }

  const globalBucket = new TokenBucket(globalPerSec, globalPerSec / 1000, clock.now())
  const perChat = new Map<string, TokenBucket>()
  const perGroup = new Map<string, TokenBucket>()
  const perMessage = new Map<number, MessageEditState>()

  function chatBucket(chatId: string): TokenBucket {
    let b = perChat.get(chatId)
    if (!b) {
      b = new TokenBucket(perChatBurst, perChatPerSec / 1000, clock.now())
      perChat.set(chatId, b)
    }
    return b
  }

  function groupBucket(chatId: string): TokenBucket {
    let b = perGroup.get(chatId)
    if (!b) {
      b = new TokenBucket(perGroupPerMin, perGroupPerMin / 60000, clock.now())
      perGroup.set(chatId, b)
    }
    return b
  }

  function bucketsFor(opts?: SendGateOpts): TokenBucket[] {
    const buckets: TokenBucket[] = [globalBucket]
    if (opts?.chat_id) {
      buckets.push(chatBucket(opts.chat_id))
      if (opts.chatType && GROUP_TYPES.has(opts.chatType)) {
        buckets.push(groupBucket(opts.chat_id))
      }
    }
    return buckets
  }

  /**
   * Wait until every bucket has a token, then consume one from each. The
   * check-and-consume block runs synchronously (no `await` after reading the
   * clock), so concurrent admissions never double-spend. Loops because a
   * competing admission may drain a bucket during our sleep.
   */
  async function admit(buckets: TokenBucket[]): Promise<void> {
    let counted = false
    for (;;) {
      const now = clock.now()
      let wait = 0
      for (const b of buckets) wait = Math.max(wait, b.msUntilAvailable(now))
      if (wait <= 0) {
        for (const b of buckets) b.consume(now)
        return
      }
      if (!counted) {
        counters.queued++
        counted = true
      }
      await clock.sleep(wait)
    }
  }

  async function handleEdit<T>(fn: () => Promise<T>, opts: SendGateOpts): Promise<T> {
    const messageId = opts.messageId as number
    const hash = hashPayload(opts.editPayload)
    let state = perMessage.get(messageId)
    if (!state) {
      state = { lastSentMs: Number.NEGATIVE_INFINITY, lastHash: undefined, pending: null }
      perMessage.set(messageId, state)
    }

    // No-op skip: identical to the last payload we actually sent → drop.
    if (hash === state.lastHash) {
      counters.dropped++
      return undefined as unknown as T
    }

    const now = clock.now()
    const elapsed = now - state.lastSentMs

    // Free to send now: no queued edit AND the edit floor has elapsed.
    if (!state.pending && elapsed >= editFloorMs) {
      await admit(bucketsFor(opts))
      state.lastSentMs = clock.now()
      state.lastHash = hash
      counters.sent++
      return fn()
    }

    // An edit is already queued for this message → last-write-wins: replace its
    // payload in place rather than queuing behind it. Both callers share the
    // single pending promise, which resolves with the coalesced send's result.
    if (state.pending) {
      // Payload identical to the already-queued one → nothing to do.
      if (state.pending.hash !== hash) {
        counters.coalesced++
        state.pending.hash = hash
        state.pending.fn = fn as () => Promise<unknown>
      }
      return state.pending.promise as Promise<T>
    }

    // Within the edit floor and nothing queued yet → schedule one pending edit
    // that fires when the floor elapses, carrying whatever payload is latest.
    let resolve!: (v: unknown) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res
      reject = rej
    })
    const pending: PendingEdit = {
      hash,
      fn: fn as () => Promise<unknown>,
      promise,
      resolve,
      reject,
    }
    state.pending = pending

    const waitMs = editFloorMs - elapsed
    void (async () => {
      try {
        if (waitMs > 0) await clock.sleep(waitMs)
        const p = state.pending
        state.pending = null
        if (!p) return
        // Re-check the no-op skip against the last sent payload — the latest
        // coalesced payload may have reverted to what's already on screen.
        if (p.hash === state.lastHash) {
          counters.dropped++
          p.resolve(undefined)
          return
        }
        await admit(bucketsFor(opts))
        state.lastSentMs = clock.now()
        state.lastHash = p.hash
        counters.sent++
        p.resolve(await p.fn())
      } catch (err) {
        const p = state.pending
        state.pending = null
        ;(p ?? pending).reject(err)
      }
    })()

    return promise as Promise<T>
  }

  async function gate<T>(fn: () => Promise<T>, opts?: SendGateOpts): Promise<T> {
    // Flag OFF → pure passthrough, zero behaviour change.
    if (!enabled) return fn()

    // Edit path (floor + coalescing + no-op skip) only when we can key it.
    if (opts && opts.messageId != null && 'editPayload' in opts) {
      return handleEdit(fn, opts)
    }

    await admit(bucketsFor(opts))
    counters.sent++
    return fn()
  }

  function stats(): SendGateStats {
    const now = clock.now()
    const perChatFill: Record<string, number> = {}
    for (const [k, b] of perChat) perChatFill[k] = b.fill(now)
    const perGroupFill: Record<string, number> = {}
    for (const [k, b] of perGroup) perGroupFill[k] = b.fill(now)
    return {
      enabled,
      global: { ...counters },
      fill: {
        global: globalBucket.fill(now),
        perChat: perChatFill,
        perGroup: perGroupFill,
      },
    }
  }

  return { gate, stats }
}

/** Read the feature flag using the standard `SWITCHROOM_*=== '1'` convention. */
export function sendGateEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SWITCHROOM_TELEGRAM_SEND_GATE === '1'
}
