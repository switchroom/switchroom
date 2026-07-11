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
import {
  makeFloodWaitActiveError,
  isFloodWaitActiveError,
} from './retry-api-call.js'

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
 * Priority class governing shedding + degraded mode (part3-design §2/§3):
 *   - `critical` — final reply chunks, approval / vault cards, error notices.
 *     Never shed; queued unbounded. Degraded mode: waits a short window,
 *     fails fast with a structured `FLOOD_WAIT_ACTIVE` for a long one.
 *   - `useful`   — progress-card creation, worker handbacks, checklists,
 *     boot/config cards. Queued with a TTL; dropped (counted) when stale.
 *   - `cosmetic` — typing, reactions, all card EDITS, stream updates,
 *     heartbeats. Shed immediately (counted) when no token is free OR any
 *     flood window covering the scope is open.
 *
 * UNTAGGED default (L2, review PR #3106): an untagged NON-EDIT send defaults to
 * `critical` — NON-droppable (queued unbounded, fail-fast only on a long
 * window), NOT `useful`. Rationale: most call sites are untagged, and a `useful`
 * default silently TTL-drops an untagged-but-important send under pressure
 * (a resolved `undefined` a caller reads as "sent"). Conservative posture:
 * nothing is droppable unless a call site OPTS IN by tagging `useful`/`cosmetic`.
 * (Untagged EDITS keep coalescing — the latest payload always wins, never
 * dropped — so their default is non-droppable already.)
 */
export type PriorityClass = 'critical' | 'useful' | 'cosmetic'

/**
 * Priority class an UNTAGGED non-edit send is admitted as. `critical` =
 * non-droppable (L2). See the `PriorityClass` doc above.
 */
export const UNTAGGED_SEND_CLASS: PriorityClass = 'critical'

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
  /**
   * Priority class for shedding + degraded mode (part3-design §2/§3). Untagged
   * NON-EDIT calls default to `critical` (non-droppable — see
   * `UNTAGGED_SEND_CLASS`); untagged edits coalesce (also non-droppable).
   */
  priorityClass?: PriorityClass
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
  /**
   * Cosmetic calls shed under pressure — no token free OR a flood window open
   * (part3-design §2). A shed resolves as `undefined`; the next send carries
   * full state.
   */
  shed: number
  /** Useful calls dropped because they exceeded their queue TTL (part3-design §2). */
  expired: number
  /**
   * Critical calls that failed fast with a structured `FLOOD_WAIT_ACTIVE`
   * because the open window exceeded the fail-fast ceiling (part3-design §3).
   */
  failedFast: number
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
  /**
   * Global burst capacity (headroom under Telegram's ~30/s). Default 4.
   * Worst-case sliding-window admissions = capacity + rate·T, so a full 1s
   * window admits at most `globalBurst + globalPerSec` = 4 + 25 = 29 < 30 —
   * a real margin under the ceiling (#3092 M2 residual: burst 5 hit exactly 30).
   */
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
  /**
   * TTL (ms) a `useful` call may wait in the admission queue before it is
   * dropped as stale (part3-design §2). Default 120_000 (~2 min).
   */
  usefulTtlMs?: number
  /**
   * Ceiling (ms) on an open flood window under which a `critical` send WAITS
   * (single in-flight, jitter); above it, the send fails fast with a structured
   * `FLOOD_WAIT_ACTIVE` carrying `untilTs` so the MCP reply path surfaces a real
   * error instead of a long opaque block (part3-design §3). Default 60_000.
   */
  criticalFailFastMs?: number
  /**
   * Max jitter (ms) added before a `critical` send probes the API during an
   * open (short) window, so serialized criticals don't thunder at the exact
   * window edge. Default 250.
   */
  criticalJitterMaxMs?: number
  /**
   * Injectable 0..1 source for the critical jitter (tests pass `() => 0` for
   * determinism). Default `Math.random`.
   */
  jitter?: () => number
  /**
   * Called whenever `openFloodWindow` opens / extends a window at RUNTIME (on a
   * 429). Write-through persistence hook (part3-design §7) — the gateway wires
   * this to `flood-windows.json` so a window survives a restart. NOT called for
   * `initialWindows` applied at construction (those already came from disk).
   */
  onWindowOpen?: (scopeKey: string, untilTs: number) => void
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

  /** Remaining ms of an open suppression window (0 when none). */
  windowRemainingMs(now: number): number {
    return this.suppressedUntilMs > now ? this.suppressedUntilMs - now : 0
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
  const globalBurst = config.globalBurst ?? 4
  const perChatPerSec = config.perChatPerSec ?? 1
  const perChatBurst = config.perChatBurst ?? 3
  const perGroupPerMin = config.perGroupPerMin ?? 18
  const perGroupBurst = config.perGroupBurst ?? 2
  const editFloorMs = config.editFloorMs ?? 1500
  const messageStateTtlMs = config.messageStateTtlMs ?? 60_000
  const maxMessageStates = config.maxMessageStates ?? 5_000
  const usefulTtlMs = config.usefulTtlMs ?? 120_000
  const criticalFailFastMs = config.criticalFailFastMs ?? 60_000
  const criticalJitterMaxMs = config.criticalJitterMaxMs ?? 250
  const jitter = config.jitter ?? Math.random
  const onWindowOpen = config.onWindowOpen

  const counters: BucketCounters = {
    sent: 0,
    queued: 0,
    coalesced: 0,
    dropped: 0,
    shed: 0,
    expired: 0,
    failedFast: 0,
  }

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
  // H1 (review PR #3106): keyed by `${chat_id}:${messageId}`, NOT messageId
  // alone. Telegram `message_id` is per-chat, not globally unique — two chats
  // routinely both hold a low-numbered card (id 3, 100, …). Keying on the id
  // alone collides cross-chat: chat B's edit overwrites chat A's pending edit
  // (A's real update silently lost), and the edit floor / msg-edit suppression
  // window of one chat sheds an unrelated card in another.
  const perMessage = new Map<string, MessageEditState>()
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

  /**
   * Per-message state key: `${chat_id}:${messageId}` (H1). A missing chat_id
   * degrades to `:${messageId}` — still unique per call site, and edits always
   * carry a chat_id in production. This is ALSO the `msg-edit:` scope suffix, so
   * the boot-reloaded scoped windows and the runtime edit floor agree.
   */
  function messageKey(chatId: string | undefined, messageId: number): string {
    return `${chatId ?? ''}:${messageId}`
  }

  function messageState(key: string): MessageEditState {
    let state = perMessage.get(key)
    if (!state) {
      state = {
        lastSentMs: Number.NEGATIVE_INFINITY,
        lastHash: undefined,
        pending: null,
        running: false,
        suppressedUntilMs: 0,
      }
      perMessage.set(key, state)
    }
    return state
  }

  /**
   * Apply any flood windows injected at construction (§7 boot load) WITHOUT
   * re-persisting them (they already came from disk). Applied before the first
   * outbound call so a boot mid-ban never resends into an open window.
   */
  for (const w of config.initialWindows ?? []) applyWindow(w.scopeKey, w.untilTs, false)

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
   * (only ever extends). Persists write-through via `onWindowOpen` (part3-design
   * §7) so the window survives a restart.
   */
  function openFloodWindow(scopeKey: string, untilTs: number): void {
    // M3 (review PR #3106): flag-OFF is a PURE no-op. The gateway wires
    // `onFloodWait` → `openFloodWindow('global', …)` unconditionally, so without
    // this guard a 429 would mutate in-memory suppression AND write a new
    // `flood-windows.json` even while the feature is disabled — a real fs side
    // effect and behaviour change before the flag is ever enabled. When
    // disabled the gate must open no window and write no file (the separate
    // #2923 `flood-wait.json` recorder is unaffected — it is not wired here).
    if (!enabled) return
    applyWindow(scopeKey, untilTs, true)
  }

  /**
   * Open all scope windows implied by a call's `opts` at `untilTs` — global,
   * plus per-chat / per-group / per-message where keyed. Called when a wrapped
   * send surfaces a `FLOOD_WAIT_ACTIVE` (a real 429 or a pre-call
   * short-circuit) so the ban is remembered at the finest scope we know
   * (part3-design §7). Global is always opened as the conservative floor.
   */
  function openScopedWindowsForOpts(opts: SendGateOpts | undefined, untilTs: number): void {
    applyWindow('global', untilTs, true)
    if (opts?.chat_id) {
      applyWindow(`chat:${opts.chat_id}`, untilTs, true)
      if (opts.chatType && GROUP_TYPES.has(opts.chatType)) {
        applyWindow(`group:${opts.chat_id}`, untilTs, true)
      }
    }
    if (opts?.messageId != null) {
      // H1: msg-edit scope keyed by chat_id+messageId so a 429 on one chat's
      // card never sheds another chat's same-id card.
      applyWindow(`msg-edit:${messageKey(opts.chat_id, opts.messageId)}`, untilTs, true)
    }
  }

  /** Core window application; `persist` gates the write-through hook. */
  function applyWindow(scopeKey: string, untilTs: number, persist: boolean): void {
    if (persist && onWindowOpen) {
      try {
        onWindowOpen(scopeKey, untilTs)
      } catch {
        /* best-effort — persistence must not break the send path */
      }
    }
    if (scopeKey === 'global') {
      globalBucket.suppressUntil(untilTs)
    } else if (scopeKey.startsWith('chat:')) {
      chatBucket(scopeKey.slice('chat:'.length)).suppressUntil(untilTs)
    } else if (scopeKey.startsWith('group:')) {
      groupBucket(scopeKey.slice('group:'.length)).suppressUntil(untilTs)
    } else if (scopeKey.startsWith('msg-edit:')) {
      // H1: the suffix is the composite `${chat_id}:${messageId}` state key.
      const key = scopeKey.slice('msg-edit:'.length)
      if (key) {
        // N2: creating a per-message edit state here must go through the same
        // eviction accounting (maybeEvict / LRU cap) as normal state creation,
        // so opening many per-message flood windows can't grow perMessage past
        // the cap.
        const now = clock.now()
        const existing = perMessage.get(key)
        maybeEvict(now, existing === undefined)
        const st = existing ?? messageState(key)
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
   * our sleep. When `deadline` is set (a `useful` call's TTL), returns `false`
   * without consuming if admission cannot happen before it — the caller drops
   * the call as stale (part3-design §2).
   */
  async function admitLoop(buckets: TokenBucket[], deadline?: number): Promise<boolean> {
    let counted = false
    for (;;) {
      const now = clock.now()
      let wait = 0
      for (const b of buckets) wait = Math.max(wait, b.msUntilAvailable(now))
      if (wait <= 0) {
        for (const b of buckets) b.consume(now)
        return true
      }
      if (deadline !== undefined && now + wait > deadline) return false
      if (!counted) {
        counters.queued++
        counted = true
      }
      await clock.sleep(deadline !== undefined ? Math.min(wait, deadline - now) : wait)
    }
  }

  /** Back-compat unbounded admission (used by the per-message edit driver). */
  function admit(buckets: TokenBucket[]): Promise<boolean> {
    return admitLoop(buckets)
  }

  // Serializes `critical` sends that must probe the API during an open (short)
  // flood window: only ONE in-flight at a time so a burst of criticals doesn't
  // thunder at the window edge (part3-design §3, "single in-flight, jitter").
  let criticalTail: Promise<void> = Promise.resolve()
  function criticalSerialize<R>(job: () => Promise<R>): Promise<R> {
    const prev = criticalTail
    let release!: () => void
    criticalTail = new Promise<void>((r) => {
      release = r
    })
    return (async () => {
      await prev
      try {
        return await job()
      } finally {
        release()
      }
    })()
  }

  type AdmitOutcome =
    | { result: 'ok' }
    | { result: 'shed' }
    | { result: 'expired' }
    | { result: 'failfast'; untilTs: number }

  /**
   * Priority-aware admission (part3-design §2/§3):
   *   - cosmetic — shed immediately when any bucket has a wait (no token OR a
   *     window open); otherwise consume and go.
   *   - useful   — queue with a TTL; drop as stale past the deadline.
   *   - critical — never shed. If a window covering the scope exceeds the
   *     fail-fast ceiling, fail fast with `untilTs` (caller throws a structured
   *     FLOOD_WAIT_ACTIVE). A short window → wait single-in-flight with jitter.
   *     No window → queue unbounded.
   */
  async function admitPriority(
    buckets: TokenBucket[],
    priority: PriorityClass,
  ): Promise<AdmitOutcome> {
    const now = clock.now()
    if (priority === 'cosmetic') {
      let wait = 0
      for (const b of buckets) wait = Math.max(wait, b.msUntilAvailable(now))
      if (wait > 0) return { result: 'shed' }
      for (const b of buckets) b.consume(now)
      return { result: 'ok' }
    }
    if (priority === 'critical') {
      let remaining = 0
      for (const b of buckets) remaining = Math.max(remaining, b.windowRemainingMs(now))
      if (remaining > criticalFailFastMs) {
        return { result: 'failfast', untilTs: now + remaining }
      }
      if (remaining > 0) {
        // Degraded but short window: serialize + jitter, then wait it out —
        // re-checking the ceiling EACH loop (admitCriticalLoop) so a window
        // extended past `criticalFailFastMs` while we wait converts to fail-fast
        // instead of blocking the reply path unbounded (M2, review PR #3106).
        return await criticalSerialize(async () => {
          const j = Math.floor(jitter() * criticalJitterMaxMs)
          if (j > 0) await clock.sleep(j)
          return await admitCriticalLoop(buckets)
        })
      }
      return await admitCriticalLoop(buckets)
    }
    // useful (default): TTL-bounded queue.
    const admitted = await admitLoop(buckets, now + usefulTtlMs)
    return admitted ? { result: 'ok' } : { result: 'expired' }
  }

  /**
   * Unbounded critical admission that RE-EVALUATES the covering window on every
   * iteration (M2, review PR #3106). If a competing 429 extends the window past
   * the fail-fast ceiling while a critical waits out a short window, this stops
   * blocking and returns `failfast` (the caller throws a structured
   * `FLOOD_WAIT_ACTIVE`) rather than blocking the MCP reply path for the whole
   * extended ban — exactly the "opaque long block" part3-design §3 forbids.
   */
  async function admitCriticalLoop(buckets: TokenBucket[]): Promise<AdmitOutcome> {
    let counted = false
    for (;;) {
      const now = clock.now()
      let remaining = 0
      let wait = 0
      for (const b of buckets) {
        remaining = Math.max(remaining, b.windowRemainingMs(now))
        wait = Math.max(wait, b.msUntilAvailable(now))
      }
      if (remaining > criticalFailFastMs) return { result: 'failfast', untilTs: now + remaining }
      if (wait <= 0) {
        for (const b of buckets) b.consume(now)
        return { result: 'ok' }
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
          // N3 (liveness): this awaits `p.fn()` with no watchdog. A `fn` that
          // NEVER settles would keep `state.running` true forever, making the
          // state unevictable and hanging every coalesced caller. We rely on
          // the fact that the only production caller is `robustApiCall`, whose
          // own request/retry timeouts bound every send — so `p.fn()` is
          // guaranteed to settle. No separate watchdog is needed here.
          const res = await p.fn()
          // M1: only record the payload as on-screen AFTER a successful send,
          // so a FAILED edit can be retried with the same payload (not dropped
          // as a phantom no-op).
          state.lastHash = p.hash
          counters.sent++
          p.resolve(res)
        } catch (err) {
          // A 429 surfaced from the edit send opens the flood windows at this
          // scope so later cosmetic edits shed and the window persists (§3/§7).
          if (isFloodWaitActiveError(err)) {
            openScopedWindowsForOpts(opts, err.untilTs)
          }
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
    const key = messageKey(opts.chat_id, messageId)
    const hash = hashPayload(opts.editPayload)
    const now = clock.now()
    const existing = perMessage.get(key)
    maybeEvict(now, existing === undefined)
    const state = existing ?? messageState(key)

    // Cosmetic edits (part3-design §2) shed under pressure — a flood window
    // covering the scope is open, or a bucket has no token free right now. A
    // dropped edit costs nothing: the next edit carries the full state. Only an
    // EXPLICITLY-cosmetic edit sheds; untagged edits keep PR 1's coalescing
    // behaviour (default = useful), so this never changes an untagged caller.
    if ((opts.priorityClass ?? 'useful') === 'cosmetic') {
      let wait = 0
      for (const b of bucketsFor(opts)) wait = Math.max(wait, b.msUntilAvailable(now))
      const msgWait = state.suppressedUntilMs > now ? state.suppressedUntilMs - now : 0
      if (wait > 0 || msgWait > 0) {
        counters.shed++
        return Promise.resolve(undefined as unknown as T)
      }
    }

    // N1: the coalesce (last-write-wins) check runs BEFORE the no-op skip. When
    // a distinct edit is already queued, the newest payload always replaces it —
    // even if that payload reverts to the on-screen one (hash === lastHash).
    // Otherwise a revert-to-on-screen edit would be dropped as a no-op while the
    // stale queued edit still rendered, violating last-write-wins. When the
    // driver dequeues, its own no-op re-check (`p.hash === state.lastHash`) drops
    // a coalesced revert so nothing needless hits the API. All callers share the
    // single pending promise, which resolves with the coalesced send's result.
    if (state.pending) {
      if (state.pending.hash !== hash) {
        counters.coalesced++
        state.pending.hash = hash
        state.pending.fn = fn as () => Promise<unknown>
      }
      return state.pending.promise as Promise<T>
    }

    // No edit queued → a repeat of the last payload we actually sent is a plain
    // no-op skip: drop it before the API.
    if (hash === state.lastHash) {
      counters.dropped++
      return Promise.resolve(undefined as unknown as T)
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

    // Priority-aware admission (part3-design §2/§3). Untagged → critical
    // (non-droppable — L2, review PR #3106); tag `useful`/`cosmetic` to opt into
    // shedding.
    const priority = opts?.priorityClass ?? UNTAGGED_SEND_CLASS
    const outcome = await admitPriority(bucketsFor(opts), priority)
    if (outcome.result === 'shed') {
      counters.shed++
      return undefined as unknown as T
    }
    if (outcome.result === 'expired') {
      counters.expired++
      return undefined as unknown as T
    }
    if (outcome.result === 'failfast') {
      counters.failedFast++
      // Compose #3094's structured error so the MCP reply path surfaces a real
      // flood_wait (untilTs / retry_after) instead of an opaque long block.
      const retryAfterSec = Math.ceil((outcome.untilTs - clock.now()) / 1000)
      openScopedWindowsForOpts(opts, outcome.untilTs)
      throw makeFloodWaitActiveError(retryAfterSec, outcome.untilTs, null)
    }

    try {
      // N4: count `sent` only AFTER a successful send, mirroring the edit path.
      const res = await fn()
      counters.sent++
      return res
    } catch (err) {
      // A 429 surfaced from a non-edit send opens the scope's flood windows so
      // subsequent cosmetic traffic sheds and the window persists (§3/§7).
      if (isFloodWaitActiveError(err)) openScopedWindowsForOpts(opts, err.untilTs)
      throw err
    }
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
