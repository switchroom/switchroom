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
 *   - Global bucket:      25/sec sustained, small burst (headroom under ~30/s).
 *   - Per-chat bucket:    1/sec sustained, burst 3.
 *   - Per-group bucket:   18/min sustained, small burst (headroom under 20),
 *                         keyed on chat type.
 *   - Per-message edit:   >=1.5s between edits of the same message_id, with
 *                         LAST-WRITE-WINS coalescing (an edit queued while one
 *                         is pending REPLACES the pending payload; it never
 *                         queues behind it — the next edit carries full state)
 *                         AND in-flight serialization (only one send per
 *                         message runs at a time; edits that arrive while a
 *                         send is mid-flight — including one sleeping on a
 *                         429 retry_after — coalesce behind it rather than
 *                         firing a second overlapping edit).
 *
 * Nested buckets like PTB's AIORateLimiter; grammY's Bottleneck numbers are the
 * sanity reference. Sustained rate is the refill rate (= budget); the burst
 * capacity is a small headroom under Telegram's hard window ceiling, NOT a full
 * extra window's worth of budget (that would double the effective rate — see
 * the M2 finding on #3092).
 *
 * It also skips no-op edits: identical rendered payload for the same
 * message_id is dropped before hitting the API (Telegram 400s "message is not
 * modified" today, which still costs flood budget).
 *
 * RESTART-PROOF FLOOD STATE (part3-design §7, PR 2 hook)
 * -----------------------------------------------------
 * `createSendGate` accepts `initialWindows` (flood windows loaded from
 * `flood-wait.json` on boot) and `bootRamp` (start the global bucket at a
 * fraction of capacity for the first N ms to absorb boot-card bursts).
 * `openFloodWindow(scopeKey, untilTs)` lets PR 2 re-open a window at runtime
 * on a 429. A bucket under an open window admits NOTHING until `untilTs`,
 * regardless of token fill — a token bucket alone cannot express a
 * "blocked until" suppression, so the buckets consult a per-scope window too.
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
  /** Number of live per-message edit states (watch for the H2 leak). */
  messageStates: number
  /** Current token fill of each live bucket (for observability, PR 3). */
  fill: {
    global: number
    perChat: Record<string, number>
    perGroup: Record<string, number>
  }
}

/** A flood window: a scope suppressed until `untilTs` (part3-design §7). */
export interface FloodWindow {
  /** `global` | `chat:<id>` | `group:<id>` | `msg-edit:<id>`. */
  scopeKey: string
  /** Epoch ms until which the scope admits nothing. */
  untilTs: number
}

/**
 * Boot ramp for the global bucket (part3-design §7): start at a fraction of
 * capacity for `durationMs` after boot so a burst of boot/config cards can't
 * immediately saturate the freshly-full bucket.
 */
export interface BootRamp {
  /** Fraction of the global burst capacity during the ramp (0..1). Default 0.5. */
  fraction?: number
  /** Ramp duration in ms from gate construction. Default 10_000. */
  durationMs?: number
}

export interface SendGateConfig {
  /** Master switch. When false, `gate()` is a straight passthrough. */
  enabled: boolean
  /** Injected clock; defaults to the real system clock. */
  clock?: Clock
  /** Global bucket sustained rate (tokens/sec). Default 25. */
  globalPerSec?: number
  /** Global burst capacity (headroom under Telegram's ~30/s). Default 5. */
  globalBurst?: number
  /** Per-chat sustained rate (tokens/sec). Default 1. */
  perChatPerSec?: number
  /** Per-chat burst capacity. Default 3. */
  perChatBurst?: number
  /** Per-group sustained rate (tokens/min). Default 18. */
  perGroupPerMin?: number
  /** Per-group burst capacity (headroom under 20/min). Default 2. */
  perGroupBurst?: number
  /** Minimum ms between edits of the same message_id. Default 1500. */
  editFloorMs?: number
  /**
   * Flood windows to re-open at construction (part3-design §7). PR 2 loads
   * these from `flood-wait.json` BEFORE the first outbound call so a restart
   * during an active ban does not immediately resend into the flood.
   */
  initialWindows?: FloodWindow[]
  /** Global-bucket boot ramp (part3-design §7). Omit to start full. */
  bootRamp?: BootRamp
  /**
   * TTL (ms) after which an idle per-message edit state is evicted. Default
   * 60_000. Prevents unbounded growth of the perMessage map (#3092 H2).
   */
  messageStateTtlMs?: number
  /**
   * Hard cap on live per-message edit states; oldest-idle are evicted (LRU)
   * once exceeded. Default 5_000.
   */
  maxMessageStates?: number
}

/**
 * Classic token bucket with an optional per-scope suppression window and an
 * optional boot ramp. `tokens` refills continuously at `refillPerMs` up to
 * `capacity` (or `rampCapacity` while inside the ramp). `consume` and
 * `msUntilAvailable` both refill lazily against the supplied `now`, so there is
 * no timer per bucket. A suppression window (`suppressUntil`) blocks all
 * admission until its `untilTs`, regardless of token fill — a token bucket
 * alone cannot represent "blocked until T" (part3-design §7).
 */
class TokenBucket {
  private tokens: number
  private lastRefillMs: number
  private suppressedUntilMs = 0
  private readonly rampCapacity: number
  private readonly rampUntilMs: number

  constructor(
    readonly capacity: number,
    private readonly refillPerMs: number,
    now: number,
    ramp?: { capacity: number; untilMs: number },
  ) {
    this.rampCapacity = ramp?.capacity ?? capacity
    this.rampUntilMs = ramp?.untilMs ?? 0
    this.tokens = this.capAt(now)
    this.lastRefillMs = now
  }

  /** Effective capacity ceiling at `now` (lower during the boot ramp). */
  private capAt(now: number): number {
    return now < this.rampUntilMs ? this.rampCapacity : this.capacity
  }

  private refill(now: number): void {
    if (now <= this.lastRefillMs) return
    const elapsed = now - this.lastRefillMs
    this.tokens = Math.min(this.capAt(now), this.tokens + elapsed * this.refillPerMs)
    this.lastRefillMs = now
  }

  /** Open/extend a suppression window (part3-design §7). */
  suppressUntil(untilTs: number): void {
    if (untilTs > this.suppressedUntilMs) this.suppressedUntilMs = untilTs
  }

  /**
   * Milliseconds until at least one token is available AND no suppression
   * window is open (0 if admissible now).
   */
  msUntilAvailable(now: number): number {
    const windowWait = this.suppressedUntilMs > now ? this.suppressedUntilMs - now : 0
    this.refill(now)
    const tokenWait = this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.refillPerMs)
    return Math.max(windowWait, tokenWait)
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
  /** Wall time of the last edit SEND START for this message. */
  lastSentMs: number
  /** Hash of the last payload SUCCESSFULLY sent (for the no-op skip). */
  lastHash: string | undefined
  /** At most one queued coalesced edit per message (last-write-wins). */
  pending: PendingEdit | null
  /** True while a driver is actively sending / waiting for this message. */
  running: boolean
  /** Per-message flood suppression window (part3-design §7). */
  suppressedUntilMs: number
}

function hashPayload(payload: unknown): string {
  let s: string
  if (typeof payload === 'string') {
    s = payload
  } else {
    const j = stableStringify(payload)
    // `stableStringify(undefined)` (and any value that JSON.stringify drops)
    // returns undefined; hash a fixed sentinel so createHash never throws
    // (#3092 L2 — a caller may set editPayload: undefined alongside messageId).
    s = j === undefined ? ' undefined' : j
  }
  return createHash('sha256').update(s).digest('hex')
}

/** Deterministic JSON stringify (sorted keys) so equal payloads hash equal. */
function stableStringify(value: unknown): string | undefined {
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
  /**
   * Open/extend a flood-suppression window on a scope (part3-design §7). Used
   * by PR 2 on a 429 and at boot from the persisted `flood-wait.json`.
   */
  openFloodWindow(scopeKey: string, untilTs: number): void
  /** Snapshot of counters + current bucket fill. */
  stats(): SendGateStats
}

const GROUP_TYPES = new Set<ChatType>(['group', 'supergroup'])

export function createSendGate(config: SendGateConfig): SendGate {
  const enabled = config.enabled
  const clock = config.clock ?? systemClock
  const globalPerSec = config.globalPerSec ?? 25
  const globalBurst = config.globalBurst ?? 5
  const perChatPerSec = config.perChatPerSec ?? 1
  const perChatBurst = config.perChatBurst ?? 3
  const perGroupPerMin = config.perGroupPerMin ?? 18
  const perGroupBurst = config.perGroupBurst ?? 2
  const editFloorMs = config.editFloorMs ?? 1500
  const messageStateTtlMs = config.messageStateTtlMs ?? 60_000
  const maxMessageStates = config.maxMessageStates ?? 5_000

  const counters: BucketCounters = { sent: 0, queued: 0, coalesced: 0, dropped: 0 }

  const bootStart = clock.now()
  const globalRamp = config.bootRamp
    ? {
        capacity: Math.max(1, Math.floor(globalBurst * (config.bootRamp.fraction ?? 0.5))),
        untilMs: bootStart + (config.bootRamp.durationMs ?? 10_000),
      }
    : undefined

  const globalBucket = new TokenBucket(globalBurst, globalPerSec / 1000, bootStart, globalRamp)
  const perChat = new Map<string, TokenBucket>()
  const perGroup = new Map<string, TokenBucket>()
  const perMessage = new Map<number, MessageEditState>()
  let lastSweepMs = bootStart

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
      b = new TokenBucket(perGroupBurst, perGroupPerMin / 60000, clock.now())
      perGroup.set(chatId, b)
    }
    return b
  }

  function messageState(messageId: number): MessageEditState {
    let state = perMessage.get(messageId)
    if (!state) {
      state = {
        lastSentMs: Number.NEGATIVE_INFINITY,
        lastHash: undefined,
        pending: null,
        running: false,
        suppressedUntilMs: 0,
      }
      perMessage.set(messageId, state)
    }
    return state
  }

  /** Apply any flood windows that were injected at construction (§7 boot load). */
  for (const w of config.initialWindows ?? []) openFloodWindow(w.scopeKey, w.untilTs)

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
   * Open/extend a flood window on a scope. `global` suppresses the global
   * bucket; `chat:<id>` / `group:<id>` the per-chat / per-group buckets;
   * `msg-edit:<id>` the per-message edit floor. Idempotent + monotonic
   * (only ever extends).
   */
  function openFloodWindow(scopeKey: string, untilTs: number): void {
    if (scopeKey === 'global') {
      globalBucket.suppressUntil(untilTs)
    } else if (scopeKey.startsWith('chat:')) {
      chatBucket(scopeKey.slice('chat:'.length)).suppressUntil(untilTs)
    } else if (scopeKey.startsWith('group:')) {
      groupBucket(scopeKey.slice('group:'.length)).suppressUntil(untilTs)
    } else if (scopeKey.startsWith('msg-edit:')) {
      const id = Number(scopeKey.slice('msg-edit:'.length))
      if (Number.isFinite(id)) {
        const st = messageState(id)
        if (untilTs > st.suppressedUntilMs) st.suppressedUntilMs = untilTs
      }
    }
  }

  function isEvictable(s: MessageEditState, now: number): boolean {
    return !s.pending && !s.running && s.suppressedUntilMs <= now
  }

  /**
   * Bound the perMessage map (#3092 H2). Two mechanisms: a TTL sweep of idle
   * states older than `messageStateTtlMs`, and a hard LRU cap. An entry with a
   * pending/running send or an open suppression window is never evicted.
   */
  function maybeEvict(now: number, reserving: boolean): void {
    // Leave room for the entry about to be created so the map never settles
    // ABOVE the cap (evicting AFTER the insert would perpetually sit at cap+1).
    const target = Math.max(0, maxMessageStates - (reserving ? 1 : 0))
    if (perMessage.size > target) {
      const evictable = [...perMessage.entries()]
        .filter(([, s]) => isEvictable(s, now))
        .sort((a, b) => a[1].lastSentMs - b[1].lastSentMs)
      let over = perMessage.size - target
      for (const [k] of evictable) {
        if (over <= 0) break
        perMessage.delete(k)
        over--
      }
    }
    if (now - lastSweepMs >= messageStateTtlMs) {
      lastSweepMs = now
      for (const [k, s] of perMessage) {
        if (isEvictable(s, now) && now - s.lastSentMs > messageStateTtlMs) {
          perMessage.delete(k)
        }
      }
    }
  }

  /**
   * Wait until every bucket has a token (and no scope window is open), then
   * consume one from each. The check-and-consume block runs synchronously (no
   * `await` after reading the clock), so concurrent admissions never
   * double-spend. Loops because a competing admission may drain a bucket during
   * our sleep.
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

  /**
   * The single serialized driver for one message. Only ONE driver runs per
   * message at a time (`state.running`); every edit that arrives while it runs
   * — whether it is sleeping on the floor, waiting on a bucket, or mid-flight
   * on the network (e.g. a 429 retry_after sleep INSIDE `fn`) — coalesces into
   * `state.pending` rather than firing a second overlapping send. This closes
   * the same-tick double-send (M3) and the in-flight parallelism (M4).
   */
  async function drive(state: MessageEditState, opts: SendGateOpts): Promise<void> {
    state.running = true
    try {
      while (state.pending) {
        const now = clock.now()
        const readyAt = Math.max(state.lastSentMs + editFloorMs, state.suppressedUntilMs)
        const waitMs = readyAt - now
        if (waitMs > 0) {
          // Still inside the floor / an open window — sleep, then re-read
          // state.pending (a newer edit may have replaced it in the meantime).
          await clock.sleep(waitMs)
          continue
        }

        // Floor cleared: take the current pending edit. A newer edit arriving
        // from here on lands in a FRESH state.pending and is handled next loop.
        const p = state.pending
        state.pending = null

        // Re-check the no-op skip against the last SUCCESSFULLY-sent payload —
        // the latest coalesced payload may have reverted to what's on screen.
        if (p.hash === state.lastHash) {
          counters.dropped++
          p.resolve(undefined)
          continue
        }

        await admit(bucketsFor(opts))
        // Reserve the send-start time BEFORE awaiting the network so the floor
        // is measured from send start (matches the per-message serialization).
        state.lastSentMs = clock.now()
        try {
          const res = await p.fn()
          // M1: only record the payload as on-screen AFTER a successful send,
          // so a FAILED edit can be retried with the same payload (not dropped
          // as a phantom no-op).
          state.lastHash = p.hash
          counters.sent++
          p.resolve(res)
        } catch (err) {
          // H1: reject THIS edit's own promise (the closure-local `p`), never
          // state.pending — a distinct newer edit that arrived during the send
          // owns state.pending and must survive to be sent on the next loop.
          p.reject(err)
        }
      }
    } finally {
      state.running = false
    }
  }

  function handleEdit<T>(fn: () => Promise<T>, opts: SendGateOpts): Promise<T> {
    const messageId = opts.messageId as number
    const hash = hashPayload(opts.editPayload)
    const now = clock.now()
    const existing = perMessage.get(messageId)
    maybeEvict(now, existing === undefined)
    const state = existing ?? messageState(messageId)

    // No-op skip: identical to the last payload we actually sent → drop.
    if (hash === state.lastHash) {
      counters.dropped++
      return Promise.resolve(undefined as unknown as T)
    }

    // An edit is already queued for this message → last-write-wins: replace its
    // payload in place rather than queuing behind it. All callers share the
    // single pending promise, which resolves with the coalesced send's result.
    if (state.pending) {
      if (state.pending.hash !== hash) {
        counters.coalesced++
        state.pending.hash = hash
        state.pending.fn = fn as () => Promise<unknown>
      }
      return state.pending.promise as Promise<T>
    }

    // Otherwise create a fresh pending edit. If no driver is currently running
    // for this message, start one; if one IS running (mid-flight send, floor
    // sleep, or bucket wait), it will pick this up on its next loop — this is
    // what serializes sends per message (M3/M4).
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
    if (!state.running) void drive(state, opts)
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
      messageStates: perMessage.size,
      fill: {
        global: globalBucket.fill(now),
        perChat: perChatFill,
        perGroup: perGroupFill,
      },
    }
  }

  return { gate, openFloodWindow, stats }
}

/** Read the feature flag using the standard `SWITCHROOM_*=== '1'` convention. */
export function sendGateEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SWITCHROOM_TELEGRAM_SEND_GATE === '1'
}
