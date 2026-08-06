/**
 * stale-pin-sweep.ts — drains the STACK of orphaned bot pins a crashed or
 * pre-fix session left behind, per chat class, under hard rate gates.
 *
 * ── What was actually broken ─────────────────────────────────────────────────
 *
 * A Telegram chat holds a STACK of pinned messages. `getChat().pinned_message`
 * exposes only the TOP one and the Bot API has no list-pins method, so a
 * probe-based cleanup can never see the rest. Worse — verified live on the
 * fleet 2026-07-29 — a bare `unpinChatMessage(chat_id, message_id)` against a
 * stale entry is a SILENT NO-OP that returns `{"ok":true}`. (Control: unpinning
 * a message that was NEVER pinned also returns `ok:true`, so the response
 * carries no information about whether anything was popped.) The gateway
 * therefore logged a successful cleanup on every boot while the stack grew
 * without bound: 37 orphaned pins across 5 agents, 21 of them in one chat.
 *
 * The load-bearing consequence, and the invariant this module is built around:
 *
 *   ► A resolved `unpinChatMessage` is NOT evidence that anything was unpinned.
 *     Drain progress is only ever concluded from OBSERVED STATE, never from an
 *     API result.
 *
 * ── Two counters, one meaning each, on EVERY branch ──────────────────────────
 *
 * That invariant is only enforceable if the accounting keeps the two apart, so
 * `SweepResult` carries both and every drain primitive populates both:
 *
 *   • `issued` — removal calls that went out unrejected. A claim. Credited
 *     immediately, before any observation.
 *   • `popped` — a `getChat` top that DEMONSTRABLY MOVED. Evidence. A LOWER
 *     BOUND, credited only from an observation, never from a call.
 *
 * Neither branch is allowed its own dialect: a call-counted `popped` on one
 * path and an observation-counted `popped` on another is how the next reader
 * ends up trusting a number that was never evidence (#3955, #3956). `issued -
 * popped` is the honest "went out, could not be verified" figure everywhere,
 * and undercounting `popped` can only make the sweeper do less work.
 *
 * ── The drain primitives, per chat class ─────────────────────────────────────
 *
 * ONE sweep path (`sweepTarget`) that owns eligibility, the rights precheck,
 * the rate gates, the circuit breaker, the cursor and the verification. It
 * branches on chat class only for the drain PRIMITIVE, because DMs and groups
 * genuinely have different Telegram semantics — measured, not assumed, in the
 * test supergroup on 2026-07-29 with the bot admin + `can_pin_messages`:
 *
 *   • DM (`dm`) — targeted `unpinChatMessage` does NOT pop a stale entry here;
 *     the only sequence that does is RE-PIN then unpin:
 *     `pinChatMessage(chat, id, disable_notification)` then
 *     `unpinChatMessage(chat, id)`. Loop until verified empty. A DM emits no
 *     service message for a pin, so the loop is invisible to the user.
 *
 *   • Any group (`supergroup` / `forum-topic`) — targeted
 *     `unpinChatMessage(chat_id, message_id)` WORKS ON ANY STACK POSITION.
 *     Observed: an entry sitting third from the top was unpinned directly and
 *     vanished from the middle of the stack; the top then drained cleanly by
 *     plain targeted unpins. So a group needs NO re-pin, and with the re-pin
 *     goes the only thing that ever spams a group (see below).
 *
 * ── We unpin BY ID, never "unpin all" ────────────────────────────────────────
 *
 * This is a correctness rule, not a preference. `unpinAllChatMessages` works
 * fine on a group stack — one call, silent, clears everything — and that is
 * exactly the problem: "everything" includes OTHER PEOPLE'S pins. Measured, it
 * destroyed a pre-existing pin that predated the test. In a real team chat that
 * is unrecoverable data loss.
 *
 * The gateway already knows precisely which message ids it pinned
 * (`status-pins.json`, plus the pinned activity cards). The group drain unpins
 * exactly those and nothing else. A pin the gateway did not place is not its
 * to remove.
 *
 * `unpinAllForumTopicMessages(chat_id, message_thread_id)` is genuinely
 * topic-scoped (`telegram-bot-api` Client.cpp resolves `get_forum_topic_id` for
 * it; `pinChatMessage`/`unpinChatMessage` never do) and needs only
 * `can_pin_messages`, verified with `can_manage_topics: false`. But it is just
 * as indiscriminate WITHIN the topic, so it is a LAST-RESORT REMEDY behind an
 * explicit opt-in (`allowUnpinAllForumTopic`), never the default sweep. When it
 * does run it runs ONCE: on a deep stack the unpin-all family can peg at `429
 * retry_after: 3` with zero progress, because TDLib services it through
 * `run_affected_history_query_until_complete`, which re-issues the IDENTICAL
 * query while `!is_final_`. Retrying that is not slow, it is non-terminating.
 *
 * ── Pinning is what costs; unpinning is free ─────────────────────────────────
 *
 * Id-gap probe in the test supergroup: control gap 1, pin gap 2 — a pin DOES
 * emit a service message, and `disable_notification` does not suppress it (gap 2
 * either way). Every unpin verb measured gap 1: `unpinChatMessage`,
 * `unpinAllChatMessages` and `unpinAllForumTopicMessages` are all silent.
 *
 * Since the group drain is unpin-only, the group sweep emits nothing visible at
 * all — which is why there is no "groups are manual-only" restriction here. The
 * DM repin loop does pin, but a DM has no service messages.
 *
 * ── Rate gates ───────────────────────────────────────────────────────────────
 *
 * All gates are named constants (`DM_SWEEP_GATE` / `GROUP_SWEEP_GATE`), never
 * inline numbers:
 *
 *   • GROUP — measured headroom is large (~15 mutating calls at 2-3s spacing
 *     plus `getChat` reads at 0.15-0.4s produced zero 429s and no `PEER_FLOOD`),
 *     so 6000ms is a deliberately conservative default rather than a measured
 *     ceiling; it costs nothing on the shallow stacks that are the common case.
 *     There is NO per-chat pop ceiling in a group: the drain is bounded by the
 *     id list, and with no service-message cost there is nothing to ration.
 *   • DM — the rule is ~1 message/second/chat. 1500ms across a two-call pop is
 *     ~0.67 writes/sec, comfortably inside it. The 40-pop cap bounds one blind
 *     drain's blast radius (deepest stack observed: 21).
 *
 * The per-minute cap bounds the BOT across all chats simultaneously (a fleet
 * boot sweeping six chats at once is what actually earns a flood wait). Anything
 * not finished inside the caps persists its cursor and yields to the next boot
 * — which is safe precisely because the obligation is durable.
 *
 * Give-up and circuit-breaker rules are likewise constants: 3 consecutive 429s
 * or 2 identical `retry_after` values with zero observed progress abort THIS
 * target; a `400 … PEER_FLOOD` or a `429 retry_after > 60` halts the whole
 * bot's sweep immediately (those two say "you are already in trouble", and the
 * only correct response is to stop writing).
 *
 * PURE over injected seams — no Telegram import, no fs import, no timers — so
 * every gate, the breaker, the resume and the drain are provable in
 * `stale-pin-sweep.test.ts` against a fake that models the `ok:true` no-op
 * faithfully.
 */

import type { SweepChatKind, SweepCursor, SweepStoreFsSeam } from './stale-pin-sweep-store.js'
export type { SweepChatKind, SweepCursor, SweepStoreFsSeam } from './stale-pin-sweep-store.js'
import {
  loadSweepCursors,
  sweepTargetKey,
  upsertSweepCursor,
  SWEEP_MAX_ATTEMPTS,
} from './stale-pin-sweep-store.js'
// The single source of truth for the pin-rights concept. The sweep classifies
// a rights failure REACTIVELY — it attempts the unpin and reads Telegram's
// honest `400 "not enough rights"` — using the same detector the live status-pin
// path uses, so the two paths can never disagree on what "no pin rights" means
// (this file must stay Telegram-import-free; status-pin.ts is dependency-free).
import { isPinRightsError } from '../status-pin.js'

// ─── Rate gates (operator-mandated; do not inline these numbers) ─────────────

/** The four rate dials one chat class is swept under. */
export interface SweepGate {
  /** Minimum wall-clock gap between two pin/unpin writes in this class. */
  minCallDelayMs: number
  /**
   * Hard cap on pops for ONE chat in ONE sweep; the rest yields to next boot.
   * `Infinity` for groups: the group drain is bounded by the recorded id list
   * and emits nothing visible, so there is nothing to ration.
   */
  maxPopsPerChatPerSweep: number
  /** Cap on pin ops for the whole BOT per minute in this class, all chats. */
  maxPinOpsPerMinute: number
}

/**
 * DM gates. 1500ms across a two-write pop ≈ 0.67 writes/sec, inside Telegram's
 * ~1 message/second/chat rule. 40 pops covers the deepest stack observed (21)
 * with headroom; 30 ops/min bounds a fleet boot sweeping several DMs at once.
 */
export const DM_SWEEP_GATE: SweepGate = {
  minCallDelayMs: 1_500,
  maxPopsPerChatPerSweep: 40,
  maxPinOpsPerMinute: 30,
}

/**
 * Supergroup / forum gates.
 *
 * 6000ms is a CONSERVATIVE DEFAULT, not a measured ceiling: a live session of
 * ~15 mutating calls at 2-3s spacing (plus `getChat` reads at 0.15-0.4s) drew
 * zero 429s and no `PEER_FLOOD`, so there is large headroom. It is kept because
 * it costs nothing on the shallow stacks that are the common case.
 *
 * NO per-chat pop ceiling: a group drain issues one targeted unpin per RECORDED
 * id, so it is already bounded by that list, and unpinning emits no service
 * message — the thing the old ceiling existed to ration does not exist. The
 * per-minute budget still applies and still yields to the next boot.
 */
export const GROUP_SWEEP_GATE: SweepGate = {
  minCallDelayMs: 6_000,
  maxPopsPerChatPerSweep: Number.POSITIVE_INFINITY,
  maxPinOpsPerMinute: 10,
}

/** Backoff after a 429: honour `retry_after`, then double it (3→6→12→24s). */
export const FLOOD_BACKOFF_FACTOR = 2

/** Consecutive 429s for one target before we abort it and defer to next boot. */
export const MAX_CONSECUTIVE_FLOOD_WAITS = 3

/**
 * Identical `retry_after` values seen with ZERO observed progress before we
 * abort. This is the `unpinAllChatMessages` signature — the server hands back
 * the same wait forever because the query never becomes final.
 */
export const MAX_IDENTICAL_RETRY_AFTER_NO_PROGRESS = 2

/** A 429 asking for longer than this trips the breaker outright. */
export const CIRCUIT_BREAKER_RETRY_AFTER_SEC = 60

/**
 * Gap between the two `getChat` reads that must AGREE before a drain is called
 * verified. `getChat` is a CACHE and it lies right after a mutation: a lone
 * empty read taken immediately after an unpin means nothing. Two agreeing reads
 * ~1.8s apart is the cheapest observation that survives the cache.
 */
export const VERIFY_READ_GAP_MS = 1_800

/**
 * How many read PAIRS may be taken while chasing two agreeing values. More than
 * one because the observed lie (`pinned_message: None` on a non-empty stack,
 * ~0.15s after an unpin) settles within ~0.55s: the first pair straddles the
 * transient and disagrees, the second reads the settled value. Bounded so an
 * genuinely flapping chat degrades to "unknown" rather than spinning.
 */
export const VERIFY_READ_MAX_PAIRS = 3

/**
 * THE destructive-remedy policy, in ONE place.
 *
 * `false` ⇒ `unpinAllForumTopicMessages` is never used by the routine sweep.
 *
 * Rationale: it is genuinely topic-scoped (unlike every other pin verb a bot
 * has) and it drains a topic in one silent call, which makes it tempting. But
 * within that topic it is INDISCRIMINATE — measured, the unpin-all family
 * destroyed a pre-existing pin that the gateway never placed. The routine
 * remedy is therefore a targeted unpin of the ids the gateway recorded, and
 * this verb stays behind an explicit per-deployment opt-in for the case where
 * an operator knowingly wants a topic's pins cleared wholesale.
 *
 * Kept as one constant + {@link mayUnpinAllForumTopic} rather than a condition
 * spread through the control flow, so the policy is auditable in one place.
 */
export const UNPIN_ALL_FORUM_TOPIC_ENABLED = false

/**
 * May this sweep use the wholesale topic drain?
 *
 * `override` is the per-deployment escape hatch (`allowUnpinAllForumTopic`,
 * bound to `SWITCHROOM_PIN_SWEEP_UNPIN_ALL_TOPIC=1`); when it is undefined the
 * standing policy above decides.
 */
export function mayUnpinAllForumTopic(kind: SweepChatKind, override?: boolean): boolean {
  if (kind !== 'forum-topic') return false
  return override ?? UNPIN_ALL_FORUM_TOPIC_ENABLED
}

/** Gates for a chat class. Forum topics ride the group gates — same chat. */
export function gateFor(kind: SweepChatKind): SweepGate {
  return kind === 'dm' ? DM_SWEEP_GATE : GROUP_SWEEP_GATE
}

/** Which per-minute budget a class draws from. Forum topics are groups. */
export function budgetClassFor(kind: SweepChatKind): 'dm' | 'group' {
  return kind === 'dm' ? 'dm' : 'group'
}

// ─── Chat classification ─────────────────────────────────────────────────────

/** True iff `chatId` is a user DM: a positive integer. Groups are negative. */
export function isDmChatId(chatId: string): boolean {
  const n = Number(chatId)
  return Number.isFinite(n) && Number.isInteger(n) && n > 0
}

/**
 * Classify a sweep target.
 *
 * `forum-topic` requires BOTH a forum chat and a known `threadId`, because the
 * only thing that distinction now buys is eligibility for the opt-in wholesale
 * topic drain, whose verb takes a `message_thread_id`. Both group classes take
 * the same routine path (targeted unpin of recorded ids), so a forum chat whose
 * orphans have no recorded thread degrades to `supergroup` with no loss of
 * capability.
 */
export function classifyChatForSweep(args: {
  chatId: string
  threadId?: number
  isForum?: boolean
}): SweepChatKind {
  if (isDmChatId(args.chatId)) return 'dm'
  if (args.isForum === true && args.threadId != null) return 'forum-topic'
  return 'supergroup'
}

// ─── Seeding the obligation set from the durable stores ─────────────────────

/**
 * The minimum a persisted row must expose to become a sweep target.
 *
 * `messageId` / `activityMessageId` are read too, because the GROUP drain is
 * not a blind stack walk — it unpins exactly the ids the gateway is on record
 * as having pinned, and those ids must be captured at SCAN time, before the
 * boot reapers empty the very stores they come from.
 */
export interface SweepCandidateRow {
  chatId: string
  threadId?: number | null
  /** status-pin rows: the pinned message. */
  messageId?: number
  /** activity-card rows name it differently. */
  activityMessageId?: number
  /** activity-card rows: only a card that was actually pinned is on the stack. */
  pinned?: boolean
}

/**
 * The DISTINCT `(chat, thread)` targets that appear in ANY persisted store —
 * the set of places a prior session is on record as having pinned something.
 * These, and only these, are worth sweeping: an unpin-all is wasted on a chat
 * the agent never pinned in, and blind-sweeping every known chat is exactly the
 * kind of unbounded write volume the rate gates exist to prevent.
 *
 * Pure over its inputs; the gateway passes the loaded snapshots (status pins,
 * activity cards, queued/busy-ack cards). Rows are deduped on the FULL
 * `(chatId, threadId)` key — the old collector deduped on chat alone, which
 * silently collapsed every topic of a forum into one target and threw away the
 * `message_thread_id` the topic-scoped drain verb needs.
 */
export function collectSweepTargets(input: {
  statusPins?: readonly SweepCandidateRow[]
  activityCards?: readonly SweepCandidateRow[]
  queuedCards?: readonly SweepCandidateRow[]
}): SweepTarget[] {
  const out = new Map<string, SweepTarget>()
  const add = (rows?: readonly SweepCandidateRow[]): void => {
    if (rows == null) return
    for (const r of rows) {
      if (typeof r.chatId !== 'string' || r.chatId.length === 0) continue
      const threadId = r.threadId ?? undefined
      const key = sweepTargetKey(r.chatId, threadId)
      let target = out.get(key)
      if (target == null) {
        target = { chatId: r.chatId, threadId, messageIds: [] }
        out.set(key, target)
      }
      // An activity card that was never pinned is not on the pin stack, so its
      // id must NOT join the unpin list: issuing an unpin for it would spend
      // rate budget on a call that provably cannot pop anything.
      const id = r.messageId ?? (r.pinned === true ? r.activityMessageId : undefined)
      if (typeof id === 'number' && !target.messageIds!.includes(id)) target.messageIds!.push(id)
    }
  }
  add(input.statusPins)
  add(input.activityCards)
  add(input.queuedCards)
  return [...out.values()]
}

/**
 * The messageIds in `chatId` that must SURVIVE a drain because they belong to
 * deliberately-retained store rows: unexpired time-scoped `tool:` pins (the
 * `pin_message` MCP tool, #3001), which `runStatusPinBootCleanup` intentionally
 * KEEPS across restarts. Work-scoped rows (no `expiresAt`) are stale by
 * definition after a restart and are NOT re-pin candidates; expired
 * time-scoped rows are due for sweeping.
 */
export function unexpiredStoreRepinIds(
  rows: readonly { chatId: string; messageId: number; expiresAt?: number }[],
  chatId: string,
  now: number,
): number[] {
  const out: number[] = []
  for (const r of rows) {
    if (r.chatId !== chatId) continue
    if (r.expiresAt != null && r.expiresAt > now) out.push(r.messageId)
  }
  return out
}

// ─── Telegram error shapes ───────────────────────────────────────────────────

function description(err: unknown): string {
  if (err != null && typeof err === 'object') {
    const o = err as { description?: unknown; message?: unknown }
    if (typeof o.description === 'string' && o.description.length > 0) {
      return o.description.toLowerCase()
    }
    if (typeof o.message === 'string' && o.message.length > 0) return o.message.toLowerCase()
  }
  return String(err).toLowerCase()
}

/** Seconds Telegram asked us to wait, or null when this is not a flood wait. */
export function retryAfterSeconds(err: unknown): number | null {
  if (err == null || typeof err !== 'object') return null
  const o = err as { error_code?: unknown; parameters?: { retry_after?: unknown } }
  const fromParams = o.parameters?.retry_after
  if (typeof fromParams === 'number' && fromParams >= 0) return fromParams
  if (o.error_code === 429) {
    const m = /retry after (\d+)/.exec(description(err))
    if (m != null) return Number(m[1])
    return 0
  }
  return null
}

/**
 * `400 … PEER_FLOOD` — Telegram telling the bot it is already flood-limited at
 * the account level. Never retry through this; stop writing entirely.
 */
export function isPeerFloodError(err: unknown): boolean {
  return description(err).includes('peer_flood')
}

/**
 * `unpinChatMessage` with NO `message_id` on an EMPTY stack answers `400
 * "message to unpin not found"`. That is a real, positive termination signal —
 * one of the very few honest answers in this API surface — so we use it as a
 * corroborating check alongside the two agreeing `getChat` reads.
 */
export function isNothingToUnpinError(err: unknown): boolean {
  return description(err).includes('message to unpin not found')
}

// ─── Per-bot op budget ───────────────────────────────────────────────────────

/**
 * Sliding-window budget for pin ops per bot per minute, per class. Shared
 * across every chat in one sweep — the flood ledger Telegram keeps is per BOT,
 * not per chat, so a per-chat-only gate is no gate at all when six chats are
 * swept concurrently at boot.
 */
export interface PinOpBudget {
  /** Ms to wait before the next op in `cls` is within budget (0 = go now). */
  waitMs(cls: 'dm' | 'group'): number
  /** Record that an op just went out. */
  record(cls: 'dm' | 'group'): void
}

export function createPinOpBudget(now: () => number): PinOpBudget {
  const windows: Record<'dm' | 'group', number[]> = { dm: [], group: [] }
  const limits: Record<'dm' | 'group', number> = {
    dm: DM_SWEEP_GATE.maxPinOpsPerMinute,
    group: GROUP_SWEEP_GATE.maxPinOpsPerMinute,
  }
  const prune = (cls: 'dm' | 'group', t: number): void => {
    const w = windows[cls]
    while (w.length > 0 && t - w[0] >= 60_000) w.shift()
  }
  return {
    waitMs(cls) {
      const t = now()
      prune(cls, t)
      const w = windows[cls]
      if (w.length < limits[cls]) return 0
      // Wait until the oldest op in the window ages out of the minute.
      return Math.max(0, 60_000 - (t - w[0]))
    },
    record(cls) {
      windows[cls].push(now())
    },
  }
}

// ─── Sweeper ─────────────────────────────────────────────────────────────────

export interface SweepTarget {
  chatId: string
  threadId?: number
  /** Whether the chat is a forum supergroup, when the caller knows. */
  isForum?: boolean
  /**
   * Message ids the gateway is on record as having pinned here, captured at
   * scan time. The GROUP drain unpins exactly these — a pin the gateway did not
   * place is not its to remove. Unioned with `deps.recordedPinIds` so the lazy
   * first-inbound caller, which has no scan snapshot, still gets a list.
   */
  messageIds?: number[]
}

export type SweepStatus =
  /** Verified empty (two agreeing reads). The obligation is discharged. */
  | 'drained'
  /** Never eligible this boot (lost the startup mutex). Nothing was written. */
  | 'skipped-not-eligible'
  /** Bot is not an admin with can_pin_messages here. Nothing was written. */
  | 'skipped-no-rights'
  /**
   * A GROUP target with no recorded pin ids. Nothing is owed and nothing may be
   * done: the gateway only ever removes pins it placed, so with no record there
   * is no safe action (an unpin-all would take other people's pins with it).
   */
  | 'skipped-nothing-recorded'
  /** Already discharged in a previous boot / earlier in this one. */
  | 'already-drained'
  /**
   * This process already attempted this target. NOT an error: a re-attempt in
   * the same process reads the same state through the same gates and can only
   * burn the attempt budget and the flood ledger.
   */
  | 'already-attempted'
  /** Attempt budget exhausted (SWEEP_MAX_ATTEMPTS boots). Never retried. */
  | 'forfeited'
  /** Hit the per-chat pop cap or the per-minute budget. Cursor persisted. */
  | 'deferred-budget'
  /** Flood-waited out (consecutive 429s, or a pegged identical retry_after). */
  | 'deferred-flood'
  /** Writes stopped: PEER_FLOOD or retry_after > 60s. Cursor persisted. */
  | 'aborted-circuit-breaker'
  /** Drain ran but the stack is provably NOT empty — never reported drained. */
  | 'incomplete'
  /** An unexpected failure. Cursor persisted; retried next boot. */
  | 'error'

export interface SweepResult {
  status: SweepStatus
  /**
   * Pops OBSERVED to have landed in THIS sweep — never counted from an API
   * result (see the module docblock).
   *
   * It is a LOWER BOUND, deliberately, and it means the same thing on EVERY
   * drain branch: "a `getChat` top that demonstrably moved". Two structural
   * reasons it can undercount, both safe:
   *
   *   • a removal aimed at a MID-STACK id changes nothing a bot can read, so it
   *     is never creditable however well it worked (#3959);
   *   • a sweep that exits between a removal and the read that would have
   *     verified it (an unverifiable `getChat`) leaves that removal uncredited
   *     rather than guessing (#3956).
   *
   * Undercounting can only make the sweeper do LESS work — `popped` drives the
   * per-chat pop cap and telemetry, nothing else — whereas overcounting would
   * launder the `ok:true` silent no-op into a success. Use {@link issued} for
   * "how many removals went out"; the two are never the same number by design.
   */
  popped: number
  /**
   * Pin-removal calls that WENT OUT and were not rejected — the DM repin+unpin
   * loop's unpins, the group drain's targeted unpins, and the opt-in wholesale
   * topic drain's single call. (Telegram's honest `message to unpin not found`
   * counts too: it settles the id, it just does not move the top.)
   * Deliberately separate from `popped`: a resolved call is a claim, not
   * evidence — `unpinChatMessage` answers `ok:true` on a silent no-op, and a
   * mid-stack removal has no read-back at all.
   *
   * Every branch populates it, so `issued - popped` is the honest "removals we
   * could not verify" figure on any branch, and the two counters can never be
   * conflated by a future reader.
   */
  issued?: number
  /** Detail for the log line. */
  detail?: string
}

export interface StalePinSweepDeps {
  /**
   * Top of the pin stack (`getChat().pinned_message.message_id`), or null when
   * the chat reports nothing pinned. This is the ONLY source of drain progress
   * — deliberately, because the unpin RESULT is worthless (see the module
   * docblock). May throw; a throw is treated as "unknown", never as "empty".
   */
  getTopPinnedMessageId: (chatId: string) => Promise<number | null>
  /** `pinChatMessage(chat, id, { disable_notification: true })`. */
  pinSilent: (chatId: string, messageId: number) => Promise<unknown>
  /** `unpinChatMessage(chat, id)`. Its resolution proves NOTHING. */
  unpin: (chatId: string, messageId: number) => Promise<unknown>
  /** `unpinAllForumTopicMessages(chat, thread)` — the one topic-scoped verb. */
  unpinAllForumTopicMessages: (chatId: string, threadId: number) => Promise<unknown>
  /**
   * The SHARED per-process pin-rights negative cache (status-pin.ts
   * `PinRightsCache`), so the sweep and the live status-pin path agree on which
   * chats are rights-less. `rightsBlocked` is TRUE only when a REAL Telegram
   * `400 "not enough rights"` was already observed (by the live pin path or an
   * earlier sweep) — never a proactive network probe — so consulting it cannot
   * resurrect the deleted `getChatMember` precheck. When it returns true the
   * sweep skips the doomed group drain; `recordRightsBlock` feeds the cache from
   * the sweep's OWN reactive rights discoveries. Both optional: undefined ⇒ the
   * sweep relies purely on its reactive classifier.
   */
  rightsBlocked?: (chatId: string) => boolean
  recordRightsBlock?: (chatId: string) => void
  /**
   * Message ids in this chat that must be RE-PINNED once the drain finishes:
   * live in-memory claims plus the deliberately-retained store rows (unexpired
   * `tool:` pins). Read at the START of the drain, restored at the end.
   */
  protectedMessageIds: (chatId: string) => number[]
  /**
   * Message ids the gateway is on record as having pinned in this target, read
   * LIVE from the durable stores. Unioned with `SweepTarget.messageIds` so the
   * lazy first-inbound sweep (which carries no boot scan) still has a list.
   */
  recordedPinIds: (chatId: string, threadId?: number) => number[]
  /** Gate: this gateway won the startup mutex and owns the shared pin state. */
  eligible: () => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** Durable obligation ledger. */
  store: { path: string; fs: SweepStoreFsSeam }
  /**
   * Per-deployment override of {@link UNPIN_ALL_FORUM_TOPIC_ENABLED}. Leave
   * undefined to take the standing policy; `true` opts this deployment into the
   * WHOLESALE topic drain, which also removes pins the gateway did not place.
   */
  allowUnpinAllForumTopic?: boolean
  log?: (line: string) => void
}

export interface StalePinSweeper {
  /**
   * Sweep one `(chat, thread)` target to completion or to a gate.
   *
   * AT MOST ONCE PER TARGET PER PROCESS. The lazy first-inbound caller fires on
   * every inbound message, so without this a busy chat whose drain did not
   * finish would re-attempt on every message — burning the 8-boot attempt
   * budget in 8 messages and running overlapping drains against the same chat.
   * Concurrent callers for the same target share the in-flight promise.
   */
  sweepTarget: (target: SweepTarget) => Promise<SweepResult>
  /** True once the breaker tripped — every later target short-circuits. */
  isCircuitOpen: () => boolean
}

export function createStalePinSweeper(deps: StalePinSweepDeps): StalePinSweeper {
  const log = deps.log ?? ((l: string) => process.stderr.write(l))
  const budget = createPinOpBudget(deps.now)
  let circuitOpen = false
  let lastWriteAt = 0

  /** Persist the obligation. Never throws — durability is best-effort. */
  const commit = (cursor: SweepCursor): void => {
    try {
      upsertSweepCursor(deps.store.path, deps.store.fs, cursor, log)
    } catch (err) {
      log(`stale-pin-sweep: cursor persist failed: ${(err as Error).message}\n`)
    }
  }

  const loadCursor = (t: SweepTarget, kind: SweepChatKind): SweepCursor => {
    const key = sweepTargetKey(t.chatId, t.threadId)
    let rows: SweepCursor[] = []
    try {
      rows = loadSweepCursors(deps.store.path, deps.store.fs)
    } catch {
      rows = []
    }
    const existing = rows.find((c) => sweepTargetKey(c.chatId, c.threadId) === key)
    if (existing != null) return { ...existing, kind }
    return {
      chatId: t.chatId,
      threadId: t.threadId,
      kind,
      popped: 0,
      done: false,
      attempts: 0,
      updatedAt: deps.now(),
    }
  }

  /**
   * Wait until BOTH the per-class minimum inter-call delay and the per-minute
   * bot budget allow the next write. Returns false when the budget cannot be
   * satisfied inside this sweep (caller defers to the next boot rather than
   * sleeping a whole minute inside a boot path).
   */
  const awaitWriteSlot = async (kind: SweepChatKind): Promise<boolean> => {
    const cls = budgetClassFor(kind)
    const wait = budget.waitMs(cls)
    // A budget wait means we've already spent this minute's whole allowance.
    // Sleeping it off inside boot would stall the sweep for a full minute for
    // no benefit — the cursor is durable, so yielding to the next boot is
    // strictly better.
    if (wait > 0) return false
    const gate = gateFor(kind)
    const since = deps.now() - lastWriteAt
    if (lastWriteAt > 0 && since < gate.minCallDelayMs) {
      await deps.sleep(gate.minCallDelayMs - since)
    }
    lastWriteAt = deps.now()
    budget.record(cls)
    return true
  }

  /**
   * Two `getChat` reads separated by {@link VERIFY_READ_GAP_MS} that must
   * AGREE, retried up to {@link VERIFY_READ_MAX_PAIRS} times. A read that
   * THROWS is "unknown", never "empty".
   *
   * This exists because of a measured lie with a counter-intuitive shape: right
   * after an unpin, `getChat` transiently reports `pinned_message: None` on a
   * stack that is NOT empty. Tight sampling: at ~0.15s it read `None`; at
   * ~0.55s and every read after, it read the next real pin. The transient value
   * is the EMPTY one, not a stale id — the opposite of what you would guess —
   * so a drain loop that terminates on a single `None` exits early and orphans
   * the rest of the stack. Never treat one `None` as empty.
   *
   * Retrying (rather than giving up on the first disagreement) is what keeps the
   * transient from ending an otherwise healthy drain: the second pair reads the
   * settled value and the loop carries on.
   */
  const readTopVerified = async (chatId: string): Promise<{ top: number | null } | null> => {
    const read = async (): Promise<{ v: number | null } | null> => {
      try {
        return { v: await deps.getTopPinnedMessageId(chatId) }
      } catch {
        return null
      }
    }
    let prev = await read()
    if (prev == null) return null
    for (let i = 0; i < VERIFY_READ_MAX_PAIRS; i++) {
      await deps.sleep(VERIFY_READ_GAP_MS)
      const next = await read()
      if (next == null) return null
      if (next.v === prev.v) return { top: next.v }
      prev = next
    }
    return null
  }

  /** Fold an error into a control decision shared by every drain primitive. */
  type FloodDecision =
    | { kind: 'breaker'; detail: string }
    | { kind: 'flood'; seconds: number }
    | { kind: 'rights' }
    | { kind: 'other'; detail: string }

  const classify = (err: unknown): FloodDecision => {
    if (isPeerFloodError(err)) return { kind: 'breaker', detail: 'PEER_FLOOD' }
    const retry = retryAfterSeconds(err)
    if (retry != null) {
      if (retry > CIRCUIT_BREAKER_RETRY_AFTER_SEC) {
        return { kind: 'breaker', detail: `retry_after=${retry}s > ${CIRCUIT_BREAKER_RETRY_AFTER_SEC}s` }
      }
      return { kind: 'flood', seconds: retry }
    }
    if (isPinRightsError(err)) return { kind: 'rights' }
    return { kind: 'other', detail: (err as Error)?.message ?? String(err) }
  }

  /**
   * The DM / opted-in-supergroup drain: RE-PIN the top then UNPIN it, which is
   * the only sequence that actually pops an entry, and re-read the observed top
   * to decide whether anything moved. A resolved unpin is never counted as a
   * pop — but it IS counted as `issued` the instant it resolves, so an exit
   * taken before the verifying read reports "one removal, none verified"
   * instead of silently reporting nothing at all (#3956).
   */
  const repinUnpinLoop = async (
    target: SweepTarget,
    kind: SweepChatKind,
    cursor: SweepCursor,
  ): Promise<SweepResult> => {
    const gate = gateFor(kind)
    let popped = 0
    let issued = 0
    let consecutiveFloods = 0
    let lastRetryAfter: number | null = null
    let noProgressAtSameRetryAfter = 0
    let lastObservedTop: number | null = null
    // True between "the unpin call resolved" and "we have re-read the top and
    // decided whether it actually did anything". A resolved unpin is a CLAIM,
    // never a pop.
    let unverifiedPop = false

    /**
     * EVERY exit from this loop goes through here, so the issued-vs-observed
     * accounting cannot be dropped on any of its many early-return paths (#3956).
     * A resolved unpin is credited to `issued` the moment it resolves; whether
     * it also becomes a `popped` depends on a later observation that an
     * interrupted sweep may never get to make. Reporting both is what keeps the
     * unverified one visible instead of vanishing.
     */
    const out = (r: Omit<SweepResult, 'issued'>): SweepResult => ({ ...r, issued })

    /** Count a pop ONLY once the observed top has moved. */
    const creditPop = (): void => {
      popped++
      cursor.popped++
      cursor.updatedAt = deps.now()
      commit(cursor)
    }

    for (let i = 0; i < gate.maxPopsPerChatPerSweep; i++) {
      if (circuitOpen) {
        return out({ status: 'aborted-circuit-breaker', popped, detail: 'breaker open' })
      }
      const observed = await readTopVerified(target.chatId)
      if (observed == null) {
        // Ambiguous read (disagreeing reads or a throw). Not a drain, and NOT
        // an empty stack. Defer rather than assert either way.
        return out({ status: 'incomplete', popped, detail: 'pin-stack read unverifiable' })
      }
      if (unverifiedPop) {
        // THE bug this module exists for: `unpinChatMessage` resolves ok:true on
        // a stale entry and pops NOTHING. The same id still on top after a full
        // repin+unpin is proof the pop did not land, whatever the API answered.
        if (observed.top != null && observed.top === lastObservedTop) {
          return out({
            status: 'incomplete',
            popped,
            detail: `no progress: message ${observed.top} still on top after a repin+unpin`,
          })
        }
        creditPop()
        unverifiedPop = false
      }
      if (observed.top == null) {
        return out({ status: 'drained', popped })
      }
      lastObservedTop = observed.top

      if (!(await awaitWriteSlot(kind))) {
        return out({ status: 'deferred-budget', popped, detail: 'per-minute pin-op budget spent' })
      }
      try {
        await deps.pinSilent(target.chatId, observed.top)
      } catch (err) {
        const d = classify(err)
        if (d.kind === 'breaker') {
          circuitOpen = true
          return out({ status: 'aborted-circuit-breaker', popped, detail: d.detail })
        }
        if (d.kind === 'rights') return out({ status: 'skipped-no-rights', popped })
        if (d.kind === 'flood') {
          consecutiveFloods++
          if (lastRetryAfter === d.seconds) noProgressAtSameRetryAfter++
          else noProgressAtSameRetryAfter = 1
          lastRetryAfter = d.seconds
          if (
            consecutiveFloods >= MAX_CONSECUTIVE_FLOOD_WAITS ||
            noProgressAtSameRetryAfter >= MAX_IDENTICAL_RETRY_AFTER_NO_PROGRESS
          ) {
            return out({
              status: 'deferred-flood',
              popped,
              detail: `flood: ${consecutiveFloods} consecutive 429s, retry_after=${d.seconds}s`,
            })
          }
          // Honour retry_after, then double it for the next one (3→6→12→24).
          await deps.sleep(d.seconds * 1000 * Math.pow(FLOOD_BACKOFF_FACTOR, consecutiveFloods - 1))
          continue
        }
        return out({ status: 'error', popped, detail: d.detail })
      }
      // The unpin's RESULT is deliberately ignored — it resolves ok:true on a
      // silent no-op. Only the next observed top decides whether this popped.
      if (!(await awaitWriteSlot(kind))) {
        return out({ status: 'deferred-budget', popped, detail: 'per-minute pin-op budget spent' })
      }
      try {
        await deps.unpin(target.chatId, observed.top)
      } catch (err) {
        const d = classify(err)
        if (d.kind === 'breaker') {
          circuitOpen = true
          return out({ status: 'aborted-circuit-breaker', popped, detail: d.detail })
        }
        if (d.kind === 'rights') return out({ status: 'skipped-no-rights', popped })
        if (isNothingToUnpinError(err)) return out({ status: 'drained', popped })
        if (d.kind === 'flood') {
          consecutiveFloods++
          if (lastRetryAfter === d.seconds) noProgressAtSameRetryAfter++
          else noProgressAtSameRetryAfter = 1
          lastRetryAfter = d.seconds
          if (
            consecutiveFloods >= MAX_CONSECUTIVE_FLOOD_WAITS ||
            noProgressAtSameRetryAfter >= MAX_IDENTICAL_RETRY_AFTER_NO_PROGRESS
          ) {
            return out({
              status: 'deferred-flood',
              popped,
              detail: `flood: ${consecutiveFloods} consecutive 429s, retry_after=${d.seconds}s`,
            })
          }
          await deps.sleep(d.seconds * 1000 * Math.pow(FLOOD_BACKOFF_FACTOR, consecutiveFloods - 1))
          continue
        }
        return out({ status: 'error', popped, detail: d.detail })
      }
      consecutiveFloods = 0
      // The removal went out. It is `issued` NOW — unconditionally, before the
      // observation that may or may not turn it into a `popped`. That ordering
      // is the fix for #3956: an exit taken before the next verified read can
      // no longer make this call disappear from the accounting.
      issued++
      unverifiedPop = true
    }

    // Pop cap reached. Is it actually empty? One verified read decides, and it
    // is the ONLY thing allowed to report `drained`.
    const finalRead = await readTopVerified(target.chatId)
    if (unverifiedPop && finalRead != null && finalRead.top !== lastObservedTop) creditPop()
    if (finalRead != null && finalRead.top == null) return out({ status: 'drained', popped })
    return out({
      status: 'deferred-budget',
      popped,
      detail: `hit the ${gate.maxPopsPerChatPerSweep}-pop cap for this chat; yielding to next boot`,
    })
  }

  /**
   * The GROUP drain: one targeted `unpinChatMessage` per RECORDED id.
   *
   * Measured, a targeted unpin in a supergroup works at ANY stack position — an
   * entry third from the top vanished from the middle — so no re-pin is needed
   * and nothing visible is emitted. It is deliberately scoped to ids the gateway
   * placed: `unpinAllChatMessages` would clear the stack in one silent call and
   * take other people's pins with it (measured, it destroyed a pre-existing
   * pin), which in a real team chat is unrecoverable data loss.
   *
   * Because a mid-stack unpin is unobservable through `getChat` (which exposes
   * only the top), `popped` — the OBSERVED count — is credited only from a top
   * that actually moved. Every issued call is reported separately as `issued`.
   */
  const targetedUnpinDrain = async (
    target: SweepTarget,
    kind: SweepChatKind,
    cursor: SweepCursor,
    ids: readonly number[],
  ): Promise<SweepResult> => {
    const alreadyDone = new Set(cursor.doneIds ?? [])
    const pending = ids.filter((id) => !alreadyDone.has(id))
    if (pending.length === 0) {
      return { status: 'drained', popped: 0, issued: 0, detail: 'every recorded id already unpinned' }
    }

    const before = await readTopVerified(target.chatId)
    let issued = 0
    let deferred: SweepResult | null = null

    for (const id of pending) {
      if (circuitOpen) {
        deferred = { status: 'aborted-circuit-breaker', popped: 0, issued, detail: 'breaker open' }
        break
      }
      if (!(await awaitWriteSlot(kind))) {
        deferred = {
          status: 'deferred-budget',
          popped: 0,
          issued,
          detail: `per-minute pin-op budget spent with ${pending.length - issued} ids left`,
        }
        break
      }
      try {
        // The RESULT is deliberately ignored: `unpinChatMessage` answers ok:true
        // even when it pops nothing. Only the observed top below is evidence.
        await deps.unpin(target.chatId, id)
      } catch (err) {
        const d = classify(err)
        if (d.kind === 'breaker') {
          circuitOpen = true
          deferred = { status: 'aborted-circuit-breaker', popped: 0, issued, detail: d.detail }
          break
        }
        if (d.kind === 'rights') {
          deferred = { status: 'skipped-no-rights', popped: 0, issued }
          break
        }
        if (d.kind === 'flood') {
          deferred = {
            status: 'deferred-flood',
            popped: 0,
            issued,
            detail: `flood: retry_after=${d.seconds}s`,
          }
          break
        }
        if (!isNothingToUnpinError(err)) {
          deferred = { status: 'error', popped: 0, issued, detail: d.detail }
          break
        }
      }
      issued++
      // Durable resume point: a boot that dies here must not re-issue this id.
      alreadyDone.add(id)
      cursor.doneIds = [...alreadyDone]
      cursor.updatedAt = deps.now()
      commit(cursor)
    }

    const after = await readTopVerified(target.chatId)
    if (after == null) {
      return {
        status: deferred?.status ?? 'incomplete',
        popped: 0,
        issued,
        detail: 'pin-stack read unverifiable after the unpin pass',
      }
    }
    // The whole stack is gone ⇒ every issued unpin demonstrably landed.
    if (after.top == null) {
      const popped = issued
      cursor.popped += popped
      commit(cursor)
      return { status: 'drained', popped, issued }
    }
    if (deferred != null) return { ...deferred, popped: 0 }
    const ours = new Set(ids)
    if (ours.has(after.top)) {
      // One of OUR ids is still on top after we unpinned it — the silent no-op,
      // observed. Never call that drained.
      return {
        status: 'incomplete',
        popped: 0,
        issued,
        detail: `recorded pin ${after.top} is still on top after a targeted unpin`,
      }
    }
    // Top is a pin the gateway never placed. Ours were mid-stack, where the API
    // gives no read-back, so this is the honest limit of what can be observed:
    // the obligation is discharged, the effect is unverifiable. Tracked as
    // `issued`, never as `popped`.
    const popped = before != null && before.top !== after.top ? 1 : 0
    cursor.popped += popped
    commit(cursor)
    return {
      status: 'drained',
      popped,
      issued,
      detail: `unpinned ${issued} recorded id(s); top ${after.top} is not ours and was left alone`,
    }
  }

  /**
   * The OPT-IN wholesale topic drain: ONE topic-scoped
   * `unpinAllForumTopicMessages`, no loop. Removes pins the gateway did not
   * place, which is why it is gated on {@link mayUnpinAllForumTopic}. A 429 here
   * is the pegged TDLib re-issue loop, so it is a give-up, not a backoff — see
   * the module docblock.
   *
   * Counting is the SAME contract as every other branch (#3955): the resolved
   * call is one `issued`, and `popped` is credited only from a `getChat` top
   * that demonstrably moved between the before- and after-reads. It is not a
   * distinction without a difference here — the verb is topic-scoped while the
   * only readable state is the CHAT-wide top, so a drained topic in a chat whose
   * top belongs to another topic legitimately moves nothing. That is still a
   * discharged obligation (`drained`), it is just not an observed pop, and
   * crediting one would make this branch's `popped` a call counter wearing a
   * pop counter's name.
   */
  const forumTopicDrain = async (
    target: SweepTarget,
    cursor: SweepCursor,
  ): Promise<SweepResult> => {
    const threadId = target.threadId
    if (threadId == null) {
      return {
        status: 'skipped-nothing-recorded',
        popped: 0,
        issued: 0,
        detail: 'no message_thread_id',
      }
    }
    // Read BEFORE the write, so "did the top move?" is answerable afterwards.
    const before = await readTopVerified(target.chatId)
    if (!(await awaitWriteSlot('forum-topic'))) {
      return {
        status: 'deferred-budget',
        popped: 0,
        issued: 0,
        detail: 'per-minute pin-op budget spent',
      }
    }
    try {
      await deps.unpinAllForumTopicMessages(target.chatId, threadId)
    } catch (err) {
      const d = classify(err)
      if (d.kind === 'breaker') {
        circuitOpen = true
        return { status: 'aborted-circuit-breaker', popped: 0, issued: 0, detail: d.detail }
      }
      if (d.kind === 'rights') return { status: 'skipped-no-rights', popped: 0, issued: 0 }
      if (d.kind === 'flood') {
        // DO NOT retry. `run_affected_history_query_until_complete` re-issues
        // the identical query while `!is_final_`, re-tripping the same server
        // flood wait — a loop here never terminates.
        return {
          status: 'deferred-flood',
          popped: 0,
          issued: 0,
          detail: `unpinAllForumTopicMessages pegged at retry_after=${d.seconds}s; not looping`,
        }
      }
      return { status: 'error', popped: 0, issued: 0, detail: d.detail }
    }
    // The call resolved: that is exactly ONE issued removal, and — per the
    // module invariant — no evidence of anything at all. Only the read below
    // may credit a pop, and only the durable counter it credits is `popped`.
    const observed = await readTopVerified(target.chatId)
    const topMoved =
      before != null && observed != null && observed.top !== before.top ? 1 : 0
    if (topMoved > 0) {
      cursor.popped += topMoved
      cursor.updatedAt = deps.now()
      commit(cursor)
    }
    if (observed != null && observed.top == null) {
      return { status: 'drained', popped: topMoved, issued: 1 }
    }
    // The chat-wide stack may legitimately still hold pins belonging to OTHER
    // topics — the topic-scoped verb only drains this one. That is a success
    // for this obligation, not an incomplete drain.
    return {
      status: 'drained',
      popped: topMoved,
      issued: 1,
      detail: 'topic drained; chat-wide stack may hold other topics',
    }
  }

  const sweepOnce = async (target: SweepTarget): Promise<SweepResult> => {
    if (!deps.eligible()) return { status: 'skipped-not-eligible', popped: 0, issued: 0 }
    if (circuitOpen) {
      return {
        status: 'aborted-circuit-breaker',
        popped: 0,
        issued: 0,
        detail: 'breaker already open',
      }
    }
    const kind = classifyChatForSweep(target)
    const cursor = loadCursor(target, kind)
    if (cursor.done) return { status: 'already-drained', popped: 0, issued: 0 }
    // Attempt budget exhausted: a permanently-undrainable chat (bot kicked,
    // rights revoked, a chat that flood-waits forever) must not re-burn the pop
    // budget on every boot for the rest of time.
    if (cursor.attempts >= SWEEP_MAX_ATTEMPTS) {
      return {
        status: 'forfeited',
        popped: 0,
        issued: 0,
        detail: `${cursor.attempts} attempts exhausted`,
      }
    }

    // NO proactive rights precheck. A `getChatMember`-based precheck was
    // DELETED (see below): the sweep runs against the chat-lock-wrapped bot,
    // which carries only `.api` and no `.botInfo`, so `self` was always null,
    // the precheck always returned false, and every group target forfeited at
    // SWEEP_MAX_ATTEMPTS without a single unpin ever going out
    // (`getChatMember` appeared 0× in a 35MB live gateway log). Rights are now
    // classified REACTIVELY and only from a real Telegram `400 "not enough
    // rights"`: each drain primitive attempts the unpin and folds that error to
    // `{ kind: 'rights' }` via `classify`, returning `skipped-no-rights`. The
    // attempt is counted below BEFORE the drain, so a genuinely rights-less
    // chat still increments `attempts` on every boot and forfeits at
    // SWEEP_MAX_ATTEMPTS — no infinite retry — while a chat the bot CAN pin in
    // is no longer wrongly skipped.
    //
    // Same-process negative cache (D3): if the LIVE status-pin path (or an
    // earlier sweep) already observed a REAL `400 not enough rights` for this
    // chat, skip the doomed group drain rather than re-attempting it. This is
    // NOT a network probe — it is fed only by observed rights failures — so it
    // does not resurrect the deleted precheck. DMs are never rights-gated. The
    // attempt is still counted so the cursor forfeits at SWEEP_MAX_ATTEMPTS.
    if (kind !== 'dm' && deps.rightsBlocked?.(target.chatId) === true) {
      cursor.attempts++
      cursor.lastStatus = 'skipped-no-rights'
      cursor.updatedAt = deps.now()
      commit(cursor)
      return { status: 'skipped-no-rights', popped: 0, issued: 0 }
    }

    cursor.attempts++
    cursor.updatedAt = deps.now()
    commit(cursor)

    // Snapshot the ids that must survive BEFORE draining.
    const protectedIds = [...new Set(deps.protectedMessageIds(target.chatId))]

    let result: SweepResult
    try {
      if (kind === 'dm') {
        // A DM is a blind drain: targeted unpin does not pop there, so the only
        // primitive is repin+unpin against the observed top. It needs no id
        // list, and there are no third-party pins in a DM to protect.
        result = await repinUnpinLoop(target, kind, cursor)
      } else if (mayUnpinAllForumTopic(kind, deps.allowUnpinAllForumTopic)) {
        result = await forumTopicDrain(target, cursor)
      } else {
        // The routine group path: unpin exactly the ids we recorded, minus the
        // ones we deliberately keep (unexpired `tool:` pins).
        const keep = new Set(protectedIds)
        const ids = [
          ...new Set([
            ...(target.messageIds ?? []),
            ...deps.recordedPinIds(target.chatId, target.threadId),
          ]),
        ].filter((id) => !keep.has(id))
        result =
          ids.length === 0
            ? {
                status: 'skipped-nothing-recorded',
                popped: 0,
                issued: 0,
                detail: 'no recorded pin ids for this target — nothing this gateway may remove',
              }
            : await targetedUnpinDrain(target, kind, cursor, ids)
      }
    } catch (err) {
      result = { status: 'error', popped: 0, issued: 0, detail: (err as Error).message }
    }

    // `skipped-nothing-recorded` discharges the obligation too: there is no id
    // this gateway may legitimately remove here, so re-attempting next boot can
    // only burn the attempt budget until it forfeits.
    if (result.status === 'drained' || result.status === 'skipped-nothing-recorded') {
      cursor.done = true
    }
    cursor.lastStatus = result.status
    cursor.updatedAt = deps.now()
    commit(cursor)

    // Feed the shared negative cache (D3): a reactive `skipped-no-rights` is a
    // real observed `400 not enough rights`, so record it so the live pin path
    // and later sweeps of this chat skip the doomed attempt too.
    if (result.status === 'skipped-no-rights') deps.recordRightsBlock?.(target.chatId)

    // Restore the deliberately-retained pins the blind DM drain cleared.
    // Rate-gated like any other write; a failure is logged and never fatal.
    //
    // DM ONLY, deliberately. The group path never removes a protected id in the
    // first place (they are filtered out of the unpin list), so re-pinning there
    // would double-pin — and a pin is the ONE group op that emits a visible
    // service message, so it would also be the only spam this sweep produces.
    if (kind === 'dm' && (result.status === 'drained' || result.popped > 0)) {
      for (const messageId of protectedIds) {
        if (circuitOpen) break
        if (!(await awaitWriteSlot(kind))) break
        try {
          await deps.pinSilent(target.chatId, messageId)
        } catch (err) {
          log(
            `telegram gateway: stale-pin-sweep: re-pin of protected message failed ` +
              `(chat=${target.chatId} msg=${messageId}): ${(err as Error).message}\n`,
          )
        }
      }
    }

    log(
      `telegram gateway: stale-pin-sweep: chat=${target.chatId} ` +
        `thread=${target.threadId ?? '-'} kind=${kind} status=${result.status} ` +
        `popped=${result.popped} issued=${result.issued ?? 0} total=${cursor.popped}` +
        (result.detail != null ? ` (${result.detail})` : '') +
        `\n`,
    )
    return result
  }

  // At-most-once-per-process, plus in-flight coalescing. See StalePinSweeper.
  const attempted = new Set<string>()
  const inFlight = new Map<string, Promise<SweepResult>>()

  const sweepTarget = (target: SweepTarget): Promise<SweepResult> => {
    const key = sweepTargetKey(target.chatId, target.threadId)
    const running = inFlight.get(key)
    if (running != null) return running
    // Not eligible yet ⇒ nothing was attempted, so do NOT consume the one
    // allowed attempt: the boot sweep must still get its turn once the mutex
    // is won.
    if (!deps.eligible()) {
      return Promise.resolve({ status: 'skipped-not-eligible', popped: 0, issued: 0 })
    }
    if (attempted.has(key)) {
      return Promise.resolve({ status: 'already-attempted', popped: 0, issued: 0 })
    }
    attempted.add(key)
    const p = sweepOnce(target).finally(() => inFlight.delete(key))
    inFlight.set(key, p)
    return p
  }

  return { sweepTarget, isCircuitOpen: () => circuitOpen }
}
