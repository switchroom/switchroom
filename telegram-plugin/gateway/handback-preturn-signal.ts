/**
 * handback-preturn-signal.ts — close the sub-agent-handback "dead-air" gap.
 *
 * THE GAP. When a *background* sub-agent (worker / researcher) finishes, the
 * gateway synthesises a `subagent_handback` inbound and buffers it
 * (`pendingInboundBuffer`). That inbound is RELEASED for delivery only at an
 * idle prompt (the buffer drain), travels bridge → claude, and eventually
 * mints a fresh turn at the `enqueue` session-event. Between the RELEASE and
 * the turn's first tool/narration render there is a stretch of dead air: no
 * `typing…` indicator and no activity card. The user — who dispatched the work
 * and is waiting — sees nothing until the turn is well underway. Worse, a
 * handback turn historically never even got a turn-long typing loop
 * (`startTurnTypingLoop` had a single caller on the real-inbound path), so the
 * dark stretch extended past turn start. That second half is now closed
 * independently of this seam: the `enqueue` seam arms the loop for EVERY minted
 * turn (#3544), so an un-adopted handback turn is lit for its whole compose
 * window. This seam still covers the pre-turn stretch (release → enqueue).
 *
 * THE FIX (one continuous card lifecycle, NOT an orphan). The moment the
 * buffered handback is RELEASED, emit a pre-turn signal for its topic:
 *
 *   1. a turn-long `typing…` loop (the same mechanism the real-inbound path
 *      starts), and
 *   2. a "reading the worker's results…" activity CARD.
 *
 * When the handback's turn later mints at `enqueue`, it ADOPTS that exact card
 * (its `activityMessageId` is seeded onto the new turn, `activityEverOpened`
 * set) so the turn EDITS the existing card instead of opening a second one —
 * one card, one lifecycle, finalized by the turn's normal end-of-turn
 * `clearActivitySummary`. The typing loop keeps running across the seam (no
 * zero-gap), stopped by the canonical turn-end (`purgeReactionTracking →
 * stopTurnTypingLoop`).
 *
 * WHY THIS SHAPE (each decision closes a red-team hole in the naive
 * "single emit at the enqueue seam" design):
 *
 *   • EMIT AT THE DRAIN/RELEASE SITE, not the enqueue seam, and DO NOT gate on
 *     global turn-in-flight. The common case is a worker finishing WHILE the
 *     parent is mid-turn on another topic; a turn-in-flight guard would suppress
 *     exactly that case. The release is the earliest deterministic signal that a
 *     handback turn is imminent.
 *
 *   • ADOPT BY INBOUND IDENTITY, not by bare topic key. A racing user inbound
 *     on the same topic would mis-adopt a bare-key entry. Each pre-turn entry
 *     records the `turnId` its handback will derive at enqueue
 *     (`deriveTurnId(chat, thread, messageId)` — the handback carries a
 *     synthetic `messageId`, so the id is stable and unique). Only the enqueue
 *     whose `turnId` matches consumes it. This mirrors the `pendingCrossTurnGate`
 *     consume-by-turnId pattern in gateway.ts.
 *
 *   • ADOPTION SEEDS `activityMessageId` so the turn's own end-of-turn
 *     `clearActivitySummary` is the durable-teardown owner (it clears the
 *     durable card record keyed on `statusKey(chat,thread)` + that exact id).
 *     On adoption the durable record is re-keyed from its synthetic pre-turn key
 *     to the real `statusKey` so that teardown matches.
 *
 *   • NEVER-ADOPTED ORPHAN REAP — GATED ON A GLOBAL-BUSY QUEUE CHECK. A
 *     degenerate case (bridge death after release, no enqueue ever arrives)
 *     would leave a frozen card + a forever `typing…` loop. But the reap must
 *     fire ONLY for that genuine orphan, never for a handback that is correctly
 *     enqueued and simply waiting behind a long in-flight turn: claude has ONE
 *     bridge / ONE input queue, so a released handback mints its adopting turn
 *     only when claude next goes idle. A flat age-based reap cannot tell the two
 *     apart and (before this gate) posted a false "never started — needs a
 *     nudge" card every time a parent turn out-ran the timeout (the 3-cards-in-
 *     4-min incident). The reap therefore consults `isClaudeBusy()` — the
 *     machine-level "a turn is in flight right now" signal — and DEFERS
 *     (re-arms for another `adoptTimeoutMs`) while claude is busy, finalizing
 *     only once claude is idle AND the handback still has not been adopted. That
 *     idle-with-no-adoption state is the genuine bridge-death / dropped-inbound
 *     degenerate case. Lengthening the flat timeout would merely move the false
 *     positive; the queue-state gate removes it. The pre-turn card is persisted
 *     as a COMPLETE `ActivityCardRecord`
 *     under a SYNTHETIC `turnKey` (`preturn:<statusKey>:<startedAt>`) — synthetic
 *     so a sibling REAL turn on the same topic key can neither upsert-clobber it
 *     nor keep it "live" (the mid-session reaper's `isLive` keys on live topic
 *     keys, which never contain a synthetic key). An AGE-BASED self-reap timer
 *     (independent of topic liveness) finalizes the frozen card, stops the
 *     typing loop, clears the record, and drops the in-memory entry; the
 *     gateway's mid-session + boot reapers are the crash backstop (the complete
 *     record lets them finalize an orphan across a restart), and a reap hook
 *     lets them stop the typing loop + drop the map entry too.
 *     The typing stop on EITHER reap path is SKIPPED when a real turn is live
 *     on that key (`hasLiveTurn`, #3544): the loop is keyed on (chat, thread),
 *     so reaping a stale pre-turn entry must never darken a turn that is still
 *     composing — that turn's canonical turn-end owns the stop.
 *
 *   • DEBOUNCE (~700ms) kills sub-second-worker flicker: a worker that finishes
 *     and whose turn mints within the debounce window never paints a pre-turn
 *     card at all — the enqueue arrives first, cancels the debounce, and the
 *     turn's own early-liveness card takes over. The typing loop is still
 *     started for that turn (adoption returns a result even with no card).
 *
 * PURE, IMPORTABLE SEAM. The gateway monolith is not importable by tests; this
 * factory (mirroring `turn-typing-loop.ts` / the `idleDrainTick` extraction)
 * takes every effect as an injected dep, so the emit→adopt→reap contract is
 * driven deterministically by a vitest contract test with fake timers and spy
 * transports (`tests/handback-preturn-signal.test.ts`).
 */

import type { InboundMessage } from './ipc-protocol.js'

/** Prefix marking a durable card record as a pre-turn (not-yet-adopted) card.
 *  The gateway uses this to route mid-session/boot-reaped records back through
 *  the seam's `handleReaped` hook (stop typing loop + drop map entry). */
export const PRETURN_TURNKEY_PREFIX = 'preturn:'

/** `meta` key carrying the deterministic-recovery re-injection counter across a
 *  re-injected handback's round trip through the pending-inbound buffer. Stamped
 *  on the inbound just before it is re-injected on a genuine orphan; read back
 *  when that same inbound is released again, so the retry cap survives the
 *  drop-and-recreate of the per-topic pre-turn entry. `meta` is
 *  `Record<string,string>`, so the count is stored as a decimal string. */
export const HANDBACK_REINJECT_COUNT_META_KEY = 'handbackReinjectCount'

/** Emitted (NOT to chat) when a genuine orphan has exhausted its re-injection
 *  retries — the deterministic-recovery escalation surface. The gateway routes
 *  this to fleet-health telemetry (a structured log line the nightly sensor
 *  reads), never to an operator-facing card: the system must recover itself, not
 *  ask a human to nudge it. */
export interface HandbackOrphanEscalation {
  statusKey: string
  chatId: string
  threadId: number | null
  adoptTurnId: string
  reinjectCount: number
  /** Age (ms) of the handback at escalation — release → escalation. */
  ageMs: number
}

/** True IFF `source` is the load-bearing subagent-handback source string. Kept
 *  here next to the seam so a source-string regression is caught by this
 *  module's own test, not only the inbound-builder's. */
export function isHandbackInbound(msg: InboundMessage): boolean {
  return msg.type === 'inbound' && msg.meta?.source === 'subagent_handback'
}

/** A COMPLETE durable card handle for a pre-turn card — enough for the gateway's
 *  mid-session / boot reapers to finalize an orphan across a restart. Shape is a
 *  structural subset of `ActivityCardRecord` (activity-card-store.ts) so the
 *  gateway can persist it through the existing `writeActivityCardRecord`. */
export interface PreTurnCardRecord {
  /** Synthetic `preturn:<statusKey>:<startedAt>` — decoupled from the real
   *  topic key so a sibling real turn can't clobber or keep it alive. */
  turnKey: string
  chatId: string
  threadId: number | null
  activityMessageId: number
  startedAt: number
  pinned: boolean
}

/** What `tryAdopt` returns to the gateway's `enqueue` seam. `activityMessageId`
 *  is non-null when a pre-turn CARD had already been painted (adopt it by
 *  seeding); null when the debounce had not yet fired (no card to adopt, but the
 *  turn is still a released handback so it must get a typing loop). */
export interface HandbackAdoption {
  statusKey: string
  chatId: string
  threadId: number | null
  activityMessageId: number | null
  startedAt: number
  pinned: boolean
}

export interface HandbackPreturnSignalDeps {
  /** Canonical `statusKey`/`chatKey` (null/0/undefined thread → `_`). */
  chatKey: (chatId: string, threadId: number | null) => string
  /** The gateway's `deriveTurnId(chat, thread, messageId)` — the SAME function
   *  the `enqueue` seam uses, so the identity computed at release matches the
   *  turnId minted at enqueue. Returns null for a message with no usable id. */
  deriveTurnId: (
    chatId: string,
    threadId: number | null,
    messageId: string | number | null | undefined,
  ) => string | null
  /** Turn-long `typing…` loop — the gateway's shared `turnTypingLoop`. `start`
   *  fires one action immediately and refreshes on the loop's own cadence;
   *  `stop` clears it. Started at pre-turn emit, kept running across adoption,
   *  stopped by the gateway's canonical turn-end (or by this seam on orphan
   *  reap). */
  startTypingLoop: (chatId: string, threadId: number | null) => void
  stopTypingLoop: (chatId: string, threadId: number | null) => void
  /** Open the pre-turn activity card. Resolves to the sent message id, or null
   *  when the send failed / was suppressed (best-effort — a null just means no
   *  card was painted, so nothing to adopt or reap). */
  openCard: (chatId: string, threadId: number | null) => Promise<number | null>
  /** DELETE (not edit) a never-adopted pre-turn card. Used on the genuine-orphan
   *  reap so the frozen card is removed rather than rewritten to a stale
   *  user-facing "needs a nudge" message, and on the rare emit-race teardown of a
   *  card the adopting turn already owns. Best-effort; failures swallowed by the
   *  caller. */
  deleteCard: (record: PreTurnCardRecord) => void | Promise<void>
  /** Re-inject a genuinely-orphaned handback back through the pending-inbound
   *  buffer so the machine recovers itself — the deterministic alternative to
   *  asking the operator to nudge. The gateway's `pendingInboundBuffer.push`. The
   *  seam stamps `HANDBACK_REINJECT_COUNT_META_KEY` on `inbound.meta` first so the
   *  retry cap survives the round trip. */
  reinjectHandback: (inbound: InboundMessage) => void
  /** Escalate a genuine orphan that has exhausted its re-injection retries to
   *  fleet-health telemetry (NOT a chat card). */
  escalateOrphan: (escalation: HandbackOrphanEscalation) => void
  /** Persist the durable card record (the gateway's `writeActivityCardRecord`,
   *  scoped by `turnKey`). */
  writeCardRecord: (record: PreTurnCardRecord) => void
  /** Clear a durable card record scoped to `turnKey` + exact `activityMessageId`
   *  (the gateway's `clearActivityCardRecord`). */
  clearCardRecord: (turnKey: string, activityMessageId: number) => void
  /** True IFF the topic's adopting turn has ALREADY delivered a final answer or
   *  ended by the time the debounce fires — in which case skip the emit
   *  entirely (design lever 5: never paint beneath a settled turn). Optional;
   *  defaults to "not settled". */
  isTurnSettled?: (statusKey: string) => boolean
  /** True IFF a turn is CURRENTLY live (minted, not yet ended) on this topic
   *  key. Consulted before the orphan reap stops the typing loop: that loop is
   *  keyed on (chat, thread), NOT on this seam's entry, so stopping it while a
   *  real turn is composing darkens that turn's indicator for the rest of its
   *  life (#3544 — the 30 s reap killing a healthy loop). The stop is only
   *  ours to make when nothing else owns the key; when a turn IS live, its
   *  canonical turn-end owns the stop. Optional; defaults to "no live turn"
   *  (the pre-#3544 behaviour). */
  hasLiveTurn?: (statusKey: string) => boolean
  /** True IFF claude is CURRENTLY producing a turn (ANY topic — the machine has
   *  ONE bridge / ONE input queue). Consulted by the orphan reap: a released
   *  handback is delivered into that single queue and only mints its adopting
   *  turn when claude next goes idle, so while claude is busy the handback is
   *  NOT orphaned — it is correctly enqueued BEHIND the in-flight turn (a long
   *  parent turn can run many minutes). Reaping it as an orphan in that window
   *  used to post a false "never started — needs a nudge" card (the 3-cards-in-
   *  4-min incident). The reap therefore DEFERS (re-arms) while this is true —
   *  and, complementarily, while the handback was delivered but its turn has not
   *  started streaming yet (`deliveredAwaitingTurnStart`, the #4027 coverage
   *  gap) — recovering only once claude is idle AND the delivered window has
   *  elapsed AND the handback still has not been adopted (the genuine bridge-
   *  death / dropped-inbound case). Recovery is deterministic (delete the frozen
   *  card + re-inject, then escalate), never an operator nudge. Distinct from
   *  `hasLiveTurn`, which is PER-KEY and only governs the typing-loop stop; this
   *  is the GLOBAL busy signal because the handback queues behind whatever turn
   *  is running, regardless of topic. Optional; defaults to "not busy". */
  isClaudeBusy?: () => boolean
  now?: () => number
  /** Debounce before painting the pre-turn card (kills sub-second flicker). */
  debounceMs?: number
  /** Age after emit at which a never-adopted card self-reaps. Independent of
   *  topic liveness. */
  adoptTimeoutMs?: number
  /** TTL (ms) for the delivered-but-not-yet-streaming window. A released
   *  handback has been DELIVERED into claude's queue but its adopting turn may
   *  not have started streaming yet — the false-orphan window #4027 left open
   *  (idle machine + un-adopted = looked like an orphan). While within this TTL
   *  the reap DEFERS (`deliveredAwaitingTurnStart`); past it a truly-stuck
   *  delivery finally reaps for deterministic recovery rather than hanging
   *  forever. Defaults to 5 min. */
  deliveredTtlMs?: number
  /** Max deterministic re-injections of a genuine orphan before escalating to
   *  fleet-health telemetry. Defaults to 2. */
  maxReinjects?: number
  /** Injected scheduler (mirrors bridge-dead-watchdog.ts): defaults to
   *  setTimeout/clearTimeout. Injected so a runner-agnostic test can drive the
   *  debounce + self-reap deterministically WITHOUT any vitest-only fake-timer
   *  API (bun's test runner lacks `vi.advanceTimersByTimeAsync`). */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  log?: (line: string) => void
}

interface PreTurnEntry {
  statusKey: string
  chatId: string
  threadId: number | null
  /** The turnId the handback will derive at enqueue — the adoption identity. */
  adoptTurnId: string
  syntheticTurnKey: string
  startedAt: number
  /** When the handback was RELEASED/DELIVERED for delivery (stamped at
   *  `noteHandbackRelease`). Drives `deliveredAwaitingTurnStart`: the reap must
   *  not treat a delivered-but-not-yet-streaming handback as an orphan within
   *  the delivered TTL. Equal to `startedAt` (release is the delivery point). */
  deliveredAt: number
  /** How many times this handback has already been deterministically re-injected
   *  (carried across the buffer round trip via `HANDBACK_REINJECT_COUNT_META_KEY`
   *  on the inbound). Governs the retry cap before fleet-health escalation. */
  reinjectCount: number
  /** The released handback inbound itself — retained so a genuine orphan can be
   *  re-injected through the pending-inbound buffer (deterministic recovery). */
  inbound: InboundMessage
  pinned: boolean
  debounceTimer: unknown | null
  reapTimer: unknown | null
  /** Set once the debounce fired and the card was painted. */
  activityMessageId: number | null
  emitted: boolean
  consumed: boolean
}

export interface HandbackPreturnSignal {
  /** Called once per handback inbound at the point it is RELEASED for delivery
   *  (the buffer drain). Dedupes per topic key. Arms the debounce; on fire it
   *  starts the typing loop, paints the card, persists the durable record, and
   *  arms the orphan self-reap. No-op for a non-handback inbound, an inbound
   *  with no derivable turnId, or a topic key that already has a live entry. */
  noteHandbackRelease: (inbound: InboundMessage) => void
  /** Called from the `enqueue` seam with the freshly minted `turnId`. Returns an
   *  adoption when this turn corresponds to a released handback (consuming the
   *  entry), else null. On a card-bearing adoption the durable record is
   *  re-keyed to the real `statusKey` so the turn's end-of-turn
   *  `clearActivitySummary` finalizes it. Cancels the debounce/self-reap. */
  tryAdopt: (turnId: string) => HandbackAdoption | null
  /** True IFF a live (un-consumed) pre-turn entry is armed whose adopting turn
   *  is `turnId`. Consulted by the queued-card surface (stream-render Part B) at
   *  PARK time: when a handback pre-turn signal already owns the surface for the
   *  turn this parked message will mint, the queued card must NOT be posted —
   *  otherwise the same message ends up with two cards (the handback card the
   *  turn adopts, plus a queued card that then freezes). Turn-scoped, NOT
   *  key-scoped, so an unrelated user message parked on the same topic (a
   *  DIFFERENT adoptTurnId) is not wrongly suppressed. */
  hasPendingForTurnId: (turnId: string) => boolean
  /** True IFF `turnKey` is a synthetic pre-turn record key. */
  isPreTurnRecord: (turnKey: string) => boolean
  /** Reap hook for the gateway's mid-session / boot card reapers: stop the
   *  typing loop and drop the in-memory entry for a reaped synthetic key. */
  handleReaped: (turnKey: string) => void
  /** Test/observability: number of live (un-consumed) pre-turn entries. */
  pendingCount: () => number
  /** Shutdown-drain cleanup: clear every timer + entry (does not stop typing
   *  loops — the gateway's `turnTypingLoop.stopAll` owns that). */
  stopAll: () => void
}

export function createHandbackPreturnSignal(
  deps: HandbackPreturnSignalDeps,
): HandbackPreturnSignal {
  const now = deps.now ?? (() => Date.now())
  const debounceMs = deps.debounceMs ?? 700
  const adoptTimeoutMs = deps.adoptTimeoutMs ?? 30_000
  const deliveredTtlMs = deps.deliveredTtlMs ?? 300_000
  const maxReinjects = deps.maxReinjects ?? 2
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms)
      ;(t as { unref?: () => void }).unref?.()
      return t
    })
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const log = deps.log ?? ((l: string) => process.stderr.write(l))

  // Keyed by statusKey — one live pre-turn entry per topic (dedupe).
  const byKey = new Map<string, PreTurnEntry>()
  // Reverse index synthetic turnKey → statusKey, so a reaped record routes back.
  const bySyntheticKey = new Map<string, string>()

  function clearTimers(entry: PreTurnEntry): void {
    if (entry.debounceTimer != null) {
      clearTimer(entry.debounceTimer)
      entry.debounceTimer = null
    }
    if (entry.reapTimer != null) {
      clearTimer(entry.reapTimer)
      entry.reapTimer = null
    }
  }

  function dropEntry(entry: PreTurnEntry): void {
    clearTimers(entry)
    byKey.delete(entry.statusKey)
    bySyntheticKey.delete(entry.syntheticTurnKey)
  }

  function emit(entry: PreTurnEntry): void {
    entry.debounceTimer = null
    if (entry.consumed) return // adopted or reaped in the debounce window
    if (deps.isTurnSettled?.(entry.statusKey)) {
      // The adopting turn already delivered/ended — a pre-turn card would
      // narrate beneath a finished turn. Skip the emit and drop the entry.
      dropEntry(entry)
      return
    }
    // Start the turn-long typing loop NOW so the chat lights up the instant the
    // handback is released; it keeps running across adoption into the turn.
    deps.startTypingLoop(entry.chatId, entry.threadId)
    entry.emitted = true
    // Age-based self-reap armed HERE — before (and independent of) the async
    // card open — so a card send that returns null / fails, OR an enqueue that
    // never arrives, can never leak the entry + a forever-running typing loop.
    // A reap with `activityMessageId == null` just stops the typing loop and
    // drops the entry (no card to finalize). Cancelled by `tryAdopt` on
    // adoption. (Reaping is independent of topic liveness — lever 4.)
    entry.reapTimer = setTimer(() => reap(entry), adoptTimeoutMs)
    // Paint the card. Async: the entry may be consumed (adopted) before the send
    // resolves — guard on that so we never orphan a card the turn already owns.
    void Promise.resolve()
      .then(() => deps.openCard(entry.chatId, entry.threadId))
      .then((messageId) => {
        if (messageId == null) return // no card painted; the reap timer cleans up
        if (entry.consumed) {
          // Adopted/reaped while the send was in flight: the card is now the
          // turn's (adoption seeds a null id it can't use) — DELETE it so it
          // never dangles. Rare; the debounce makes it unlikely.
          void deps.deleteCard({
            turnKey: entry.syntheticTurnKey,
            chatId: entry.chatId,
            threadId: entry.threadId,
            activityMessageId: messageId,
            startedAt: entry.startedAt,
            pinned: entry.pinned,
          })
          return
        }
        entry.activityMessageId = messageId
        const record: PreTurnCardRecord = {
          turnKey: entry.syntheticTurnKey,
          chatId: entry.chatId,
          threadId: entry.threadId,
          activityMessageId: messageId,
          startedAt: entry.startedAt,
          pinned: entry.pinned,
        }
        // COMPLETE durable record — the crash backstop: a gateway restart before
        // adoption lets the boot reaper finalize this orphan. (The self-reap
        // timer was armed synchronously above.)
        deps.writeCardRecord(record)
      })
      .catch((err) => {
        log(
          `handback-preturn-signal: openCard failed key=${entry.statusKey}: ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        )
      })
  }

  /**
   * Stop the typing loop for an entry ONLY when no real turn owns that key
   * (#3544). The loop is keyed on (chat, thread); a live turn's indicator would
   * otherwise be killed mid-compose by this seam's age-based reap, and nothing
   * re-arms it. When a turn IS live the canonical turn-end owns the stop, so
   * skipping here cannot leak an interval.
   */
  function stopTypingUnlessTurnLive(entry: PreTurnEntry, reason: string): void {
    if (deps.hasLiveTurn?.(entry.statusKey) === true) {
      log(
        `handback-preturn-signal: ${reason} key=${entry.statusKey} ` +
          `typing=kept (live turn owns the stop)\n`,
      )
      return
    }
    deps.stopTypingLoop(entry.chatId, entry.threadId)
  }

  /**
   * The delivered-but-not-yet-streaming window (#4027 coverage gap). A released
   * handback has been DELIVERED into claude's single input queue, but its
   * adopting turn may not have started streaming yet — and in that stretch the
   * machine reads as idle (`isClaudeBusy()` false) with the entry un-adopted,
   * which looked exactly like a genuine orphan and produced the false "needs a
   * nudge" card even after #4027 gated on `isMachineInTurn`. While the handback
   * is within the delivered TTL and its turn has not started (we are in `reap`,
   * so the entry is un-consumed = no adopting turn minted), it is NOT orphaned —
   * defer. Past the TTL a truly-stuck delivery finally reaps rather than hanging
   * forever, handing off to deterministic recovery.
   */
  function deliveredAwaitingTurnStart(entry: PreTurnEntry): boolean {
    return now() - entry.deliveredAt < deliveredTtlMs
  }

  function reap(entry: PreTurnEntry): void {
    entry.reapTimer = null
    if (entry.consumed) return
    // PRIMARY GATE (queue state, not a flat timeout): a released handback is
    // delivered into claude's SINGLE input queue and mints its adopting turn
    // only when claude next goes idle. If claude is STILL in a turn, OR the
    // handback was delivered and its turn has simply not started streaming yet
    // (within the delivered TTL — the #4027 coverage gap), the handback is NOT
    // orphaned. Reaping now would have posted a false "never started — needs a
    // nudge" card (the 3-cards-in-4-min incident). Defer: re-arm and re-check.
    // We proceed to recovery only once claude is idle AND the delivered window
    // has elapsed AND the handback still has not been adopted (the genuine
    // bridge-death / dropped-inbound case). This cannot loop forever: claude
    // processes its queue FIFO (adoption cancels the reap), and the delivered
    // TTL is bounded, so a stuck delivery eventually recovers deterministically.
    if (deps.isClaudeBusy?.() === true || deliveredAwaitingTurnStart(entry)) {
      log(
        `handback-preturn-signal: reap deferred key=${entry.statusKey} ` +
          `(${deps.isClaudeBusy?.() === true ? 'claude busy' : 'delivered, turn not yet streaming'}` +
          ` — not orphaned)\n`,
      )
      entry.reapTimer = setTimer(() => reap(entry), adoptTimeoutMs)
      return
    }
    entry.consumed = true
    // GENUINE ORPHAN. Recover DETERMINISTICALLY — never ask the operator to
    // nudge. Stop the forever-running typing loop, DELETE the frozen card (do
    // not leave a stale "needs a nudge" message), then re-inject the handback so
    // the machine re-processes it itself. Cap the re-injections; past the cap
    // escalate to fleet-health telemetry (NOT a chat card).
    stopTypingUnlessTurnLive(entry, 'orphan reap')
    if (entry.activityMessageId != null) {
      const record: PreTurnCardRecord = {
        turnKey: entry.syntheticTurnKey,
        chatId: entry.chatId,
        threadId: entry.threadId,
        activityMessageId: entry.activityMessageId,
        startedAt: entry.startedAt,
        pinned: entry.pinned,
      }
      // Clear the durable record BEFORE the delete (at-most-once idempotency
      // guard, mirroring the activity-card-store reapers).
      deps.clearCardRecord(entry.syntheticTurnKey, entry.activityMessageId)
      void Promise.resolve(deps.deleteCard(record)).catch((err) => {
        log(
          `handback-preturn-signal: orphan card delete failed key=${entry.statusKey}: ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        )
      })
    }
    // Drop the entry from the topic map BEFORE re-injecting so a redelivery that
    // re-enters `noteHandbackRelease` (production: async buffer drain; possible
    // synchronously) is not swallowed by the per-topic dedupe guard. The entry
    // object stays valid for the captured re-inject below.
    dropEntry(entry)
    if (entry.reinjectCount < maxReinjects) {
      const nextCount = entry.reinjectCount + 1
      // Stamp the counter on the inbound so it survives the buffer round trip
      // (the re-injected inbound re-enters `noteHandbackRelease`, which reads it
      // back — the retry cap outlives the drop-and-recreate of this entry).
      entry.inbound.meta[HANDBACK_REINJECT_COUNT_META_KEY] = String(nextCount)
      log(
        `handback-preturn-signal: orphan reap key=${entry.statusKey} ` +
          `turnId=${entry.adoptTurnId} — re-injecting handback (attempt ${nextCount}/${maxReinjects})\n`,
      )
      try {
        deps.reinjectHandback(entry.inbound)
      } catch (err) {
        log(
          `handback-preturn-signal: orphan re-inject failed key=${entry.statusKey}: ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        )
      }
    } else {
      log(
        `handback-preturn-signal: orphan reap key=${entry.statusKey} ` +
          `turnId=${entry.adoptTurnId} — re-injection cap (${maxReinjects}) exhausted, ` +
          `escalating to fleet-health telemetry\n`,
      )
      try {
        deps.escalateOrphan({
          statusKey: entry.statusKey,
          chatId: entry.chatId,
          threadId: entry.threadId,
          adoptTurnId: entry.adoptTurnId,
          reinjectCount: entry.reinjectCount,
          ageMs: now() - entry.deliveredAt,
        })
      } catch (err) {
        log(
          `handback-preturn-signal: orphan escalation failed key=${entry.statusKey}: ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        )
      }
    }
  }

  return {
    noteHandbackRelease(inbound) {
      if (!isHandbackInbound(inbound)) return
      const chatId = inbound.chatId
      if (chatId == null || chatId === '') return
      const threadId = inbound.threadId ?? null
      const adoptTurnId = deps.deriveTurnId(chatId, threadId, inbound.messageId)
      // Observability (#3544): one line per handback RELEASE — the event that
      // was previously invisible in the gateway log (zero `subagent_handback`
      // lines were ever captured), so the next occurrence of a dark handback
      // turn is diagnosable. Bounded by worker completions, not by turn volume.
      const releaseKey = deps.chatKey(chatId, threadId)
      if (adoptTurnId == null) {
        log(`handback-preturn-signal: release key=${releaseKey} armed=no (no derivable turnId)\n`)
        return // no stable identity → can't be adopted
      }
      const statusKey = releaseKey
      // Dedupe: a live entry already covers this topic (e.g. two handbacks for
      // the same topic released together — the first owns the pre-turn signal).
      if (byKey.has(statusKey)) {
        // NOT a dark turn any more: the enqueue seam arms the typing loop
        // unconditionally for every minted turn (#3544), so a deduped handback
        // still lights up — it just doesn't own the pre-turn card.
        log(
          `handback-preturn-signal: release key=${statusKey} turnId=${adoptTurnId} ` +
            `armed=no (deduped: topic already has a live pre-turn entry)\n`,
        )
        return
      }
      log(
        `handback-preturn-signal: release key=${statusKey} turnId=${adoptTurnId} armed=yes\n`,
      )
      const startedAt = now()
      const syntheticTurnKey = `${PRETURN_TURNKEY_PREFIX}${statusKey}:${startedAt}`
      // Carry the re-injection counter across the buffer round trip: a genuine
      // orphan re-injects this inbound, which re-enters here with the counter
      // stamped on `meta`, so the retry cap survives the entry's recreate.
      const rawReinject = inbound.meta?.[HANDBACK_REINJECT_COUNT_META_KEY]
      const parsedReinject = rawReinject != null ? Number.parseInt(rawReinject, 10) : 0
      const reinjectCount = Number.isFinite(parsedReinject) && parsedReinject > 0 ? parsedReinject : 0
      const entry: PreTurnEntry = {
        statusKey,
        chatId,
        threadId,
        adoptTurnId,
        syntheticTurnKey,
        startedAt,
        // Release IS the delivery point (this is the buffer-drain chokepoint).
        deliveredAt: startedAt,
        reinjectCount,
        inbound,
        pinned: false,
        debounceTimer: null,
        reapTimer: null,
        activityMessageId: null,
        emitted: false,
        consumed: false,
      }
      byKey.set(statusKey, entry)
      bySyntheticKey.set(syntheticTurnKey, statusKey)
      entry.debounceTimer = setTimer(() => emit(entry), debounceMs)
    },

    tryAdopt(turnId) {
      // Match by inbound identity, not bare key — a racing user inbound on the
      // same topic derives a DIFFERENT turnId and cannot consume this entry.
      let entry: PreTurnEntry | undefined
      for (const e of byKey.values()) {
        if (e.adoptTurnId === turnId && !e.consumed) {
          entry = e
          break
        }
      }
      if (entry == null) return null
      entry.consumed = true
      clearTimers(entry)
      const adoption: HandbackAdoption = {
        statusKey: entry.statusKey,
        chatId: entry.chatId,
        threadId: entry.threadId,
        activityMessageId: entry.activityMessageId,
        startedAt: entry.startedAt,
        pinned: entry.pinned,
      }
      if (entry.activityMessageId != null) {
        // Re-key the durable record from the synthetic pre-turn key to the real
        // topic key so the adopting turn's end-of-turn `clearActivitySummary`
        // (which clears on `statusKey` + this exact id) finalizes it — one
        // continuous card lifecycle, torn down by the real owner.
        deps.clearCardRecord(entry.syntheticTurnKey, entry.activityMessageId)
        deps.writeCardRecord({
          turnKey: entry.statusKey,
          chatId: entry.chatId,
          threadId: entry.threadId,
          activityMessageId: entry.activityMessageId,
          startedAt: entry.startedAt,
          pinned: entry.pinned,
        })
      }
      dropEntry(entry)
      return adoption
    },

    hasPendingForTurnId(turnId) {
      for (const e of byKey.values()) {
        if (e.adoptTurnId === turnId && !e.consumed) return true
      }
      return false
    },

    isPreTurnRecord(turnKey) {
      return turnKey.startsWith(PRETURN_TURNKEY_PREFIX)
    },

    handleReaped(turnKey) {
      const statusKey = bySyntheticKey.get(turnKey)
      if (statusKey == null) return
      const entry = byKey.get(statusKey)
      if (entry == null) return
      entry.consumed = true
      stopTypingUnlessTurnLive(entry, 'reaped record')
      dropEntry(entry)
    },

    pendingCount() {
      let n = 0
      for (const e of byKey.values()) if (!e.consumed) n++
      return n
    },

    stopAll() {
      for (const e of [...byKey.values()]) clearTimers(e)
      byKey.clear()
      bySyntheticKey.clear()
    },
  }
}
