/**
 * InboundDeliveryStateMachine — pure transition function for the
 * gateway's inbound→bridge→outbound pipeline.
 *
 * Per `docs/rfcs/inbound-delivery-state-machine.md` (RFC merged in
 * PR #1576): the gateway's delivery state was implicit and scattered
 * across 8+ pieces of mutable state. The wedge cluster of 2026-05-19
 * (9 PRs in 36h all patching variants of "inbound stranded → 5-min
 * silence-poke fallback") and the v0.12.22 self-blocking gate bug
 * (#1573, symptom-level) shared one root cause: no model anywhere in
 * the codebase said "given these inputs, what should the gateway do."
 *
 * This module IS that model.
 *
 * ## Contract
 *
 *   transition(state, event) → { state', effects[] }
 *
 * Pure. No I/O. No timers. No mutation of inputs. The gateway
 * dispatcher receives `{ state', effects[] }` and EXECUTES the
 * effects against the real bridge/buffer/spool/Telegram. The
 * machine never touches those directly.
 *
 * Property-tested by 5 invariants (see
 * `tests/inbound-delivery-machine.test.ts`):
 *
 *   #1 — Every `inbound` event is delivered XOR persisted
 *   #2 — Every `setTurnStarted(key)` paired with `clearTurnStarted(key)`
 *        before the next end-of-life event for that key
 *   #3 — Per-chat sibling-key cleanup on `turnEnd`
 *   #4 — `permVerdict` delivered iff bridge alive; else persisted +
 *        re-delivered on next `bridgeUp`
 *   #5 — Spurious-fallback suppression (no `firePoke('fallback')` if
 *        the model produced an outbound for this key in the last 60s)
 *
 * ## Scope of this PR
 *
 * This is PR 1 of the 3-PR cutover (per RFC). The module is exported
 * but NOT WIRED into `gateway.ts`. PR 2 will swap the gateway's
 * imperative paths to dispatch through this machine. PR 3 will
 * delete the now-redundant primitives.
 *
 * Zero production behavior change in this PR. The property test is
 * the only gate.
 */

// ─────────────────────────────────────────────────────────────────────
// Branded types — chat-key namespace
// ─────────────────────────────────────────────────────────────────────

/**
 * Canonical chat-thread key. Use the existing `chatKey()` helper from
 * `./chat-key.ts` to construct one — that helper collapses
 * 0/null/undefined thread IDs to the same token (#1564 sibling-key
 * canonicalization). The state machine treats `ChatKey` as opaque.
 */
export type ChatKey = string & { readonly __brand: 'ChatKey' }

// ─────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────

/**
 * Global delivery state. Mirrors the existing `currentTurn` singleton
 * but explicit. The gateway has ONE bridge connection (single claude
 * process per agent container), so global state is the right model.
 */
export type GlobalState =
  | { kind: 'bridge_dead' }
  | { kind: 'bridge_alive_idle' }
  | { kind: 'bridge_alive_in_turn'; activeTurn: ChatKey }

/**
 * Per-key state. Lifts the scattered `activeTurnStartedAt` Map and
 * silence-poke's per-key `lastOutboundAt` tracking into ONE place.
 *
 * `turnStartedAt`: when this chat's current turn began (null = no
 * turn active for this key). Mirrors the existing
 * `activeTurnStartedAt[key]` value.
 *
 * `lastOutboundAt`: when the model last produced an outbound for
 * this key. CARRIES ACROSS TURNS — this is invariant #5's data: even
 * if a new turn starts (overlapping turns case from the
 * 2026-05-20 mid-turn silence wedge), the model's recent outbound is
 * preserved so a spurious fallback fire is suppressed.
 */
export interface PerKeyState {
  readonly turnStartedAt: number | null
  readonly lastOutboundAt: number | null
}

export interface State {
  readonly global: GlobalState
  readonly perKey: ReadonlyMap<ChatKey, PerKeyState>
}

export function initialState(): State {
  return {
    global: { kind: 'bridge_dead' },
    perKey: new Map(),
  }
}

// ─────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────

export interface InboundMessage {
  readonly msgId: number
  readonly isSteering: boolean
  readonly payload: unknown
}

export interface PermissionVerdict {
  readonly requestId: string
  readonly behavior: 'allow' | 'deny' | 'allow_once' | 'allow_always'
  readonly payload: unknown
}

export interface SpooledInbound {
  readonly key: ChatKey
  readonly msg: InboundMessage
}

export type Event =
  | { kind: 'bridgeUp'; at: number }
  | { kind: 'bridgeDown'; at: number }
  | { kind: 'turnStart'; key: ChatKey; at: number }
  | { kind: 'turnEnd'; key: ChatKey; at: number; outboundEmitted: boolean }
  | { kind: 'inbound'; key: ChatKey; msg: InboundMessage; at: number }
  | { kind: 'permVerdict'; verdict: PermissionVerdict; at: number }
  | { kind: 'modelOutbound'; key: ChatKey; at: number }
  | { kind: 'tick'; now: number }

// ─────────────────────────────────────────────────────────────────────
// Effects (returned, not performed)
// ─────────────────────────────────────────────────────────────────────

export type Effect =
  | { kind: 'deliverToBridge'; key: ChatKey; msg: InboundMessage }
  | { kind: 'bufferInbound'; key: ChatKey; msg: InboundMessage }
  | { kind: 'persistInbound'; key: ChatKey; msg: InboundMessage }
  | { kind: 'drainBuffer' }
  | { kind: 'setTurnStarted'; key: ChatKey; at: number }
  | { kind: 'clearTurnStarted'; key: ChatKey }
  | { kind: 'noteOutbound'; key: ChatKey; at: number }
  | { kind: 'firePoke'; key: ChatKey; level: 'soft' | 'firm' | 'fallback' }
  | { kind: 'deliverPermVerdict'; verdict: PermissionVerdict }
  | { kind: 'persistPermVerdict'; verdict: PermissionVerdict }
  | { kind: 'redeliverPersistedPermVerdicts' }
  | { kind: 'logTrace'; stage: string; key?: ChatKey; metadata?: Readonly<Record<string, unknown>> }

// ─────────────────────────────────────────────────────────────────────
// Tunable timings (match the production silence-poke ladder for now;
// the RFC includes a recommendation to tighten these in a follow-up,
// but parity-first for the PR-2 cutover).
// ─────────────────────────────────────────────────────────────────────

export const TURN_TTL_MS = 300_000 // 5 min — silence-poke fallback threshold
export const SOFT_POKE_MS = 75_000
export const FIRM_POKE_MS = 180_000
export const OUTBOUND_RECENT_MS = 60_000 // invariant #5 suppression window

// ─────────────────────────────────────────────────────────────────────
// Transition function
// ─────────────────────────────────────────────────────────────────────

export interface Transition {
  readonly state: State
  readonly effects: readonly Effect[]
}

function emptyPerKey(): PerKeyState {
  return { turnStartedAt: null, lastOutboundAt: null }
}

function updatePerKey(
  state: State,
  key: ChatKey,
  update: (prior: PerKeyState) => PerKeyState,
): State {
  const prior = state.perKey.get(key) ?? emptyPerKey()
  const next = update(prior)
  const m = new Map(state.perKey)
  // Empty entries (both fields null) are pruned to keep the map tight
  // — invariant #2's test reads the map size and we don't want stale
  // empty entries inflating it.
  if (next.turnStartedAt == null && next.lastOutboundAt == null) {
    m.delete(key)
  } else {
    m.set(key, next)
  }
  return { ...state, perKey: m }
}

function chatIdOfKey(key: ChatKey): string {
  // ChatKey shape is `${chatId}:${threadOrUnderscore}`. Splitting on
  // the FIRST colon gives the chatId — robust to threads/suffixes.
  const idx = key.indexOf(':')
  return idx === -1 ? key : key.slice(0, idx)
}

/**
 * Sweep all sibling keys for a chatId — Invariant #3. After the last
 * turnEnd for a chatId, no sibling thread keys should remain.
 *
 * Effect: emits `clearTurnStarted` for every sibling key still
 * holding `turnStartedAt != null`. Returns updated state.
 *
 * The state machine's invariant is enforced because we PROACTIVELY
 * purge siblings on turnEnd. The production sibling-key sweep
 * (#1564's `purgeStaleTurnsForChat`) becomes redundant.
 */
function sweepSiblings(
  state: State,
  chatId: string,
  exceptKey: ChatKey,
): { state: State; effects: Effect[] } {
  const effects: Effect[] = []
  let next = state
  for (const [k, v] of state.perKey) {
    if (k === exceptKey) continue
    if (chatIdOfKey(k) !== chatId) continue
    if (v.turnStartedAt == null) continue
    effects.push({ kind: 'clearTurnStarted', key: k })
    next = updatePerKey(next, k, (p) => ({ ...p, turnStartedAt: null }))
  }
  return { state: next, effects }
}

export function transition(state: State, event: Event): Transition {
  switch (event.kind) {
    case 'bridgeUp': {
      if (state.global.kind !== 'bridge_dead') {
        // Idempotent: a second bridgeUp is a no-op.
        return { state, effects: [{ kind: 'logTrace', stage: 'bridgeUp_redundant' }] }
      }
      return {
        state: { ...state, global: { kind: 'bridge_alive_idle' } },
        effects: [
          { kind: 'redeliverPersistedPermVerdicts' },
          { kind: 'drainBuffer' },
          { kind: 'logTrace', stage: 'bridge_recover' },
        ],
      }
    }

    case 'bridgeDown': {
      // Keep perKey state intact — the next bridgeUp + turnEnd will
      // resolve naturally. Clearing turn state on bridge flap was the
      // wedge-cluster's "drain on disconnect" footgun.
      return {
        state: { ...state, global: { kind: 'bridge_dead' } },
        effects: [{ kind: 'logTrace', stage: 'bridge_flap' }],
      }
    }

    case 'inbound': {
      const isSteering = event.msg.isSteering
      const inTurn = state.global.kind === 'bridge_alive_in_turn'
      const alive = state.global.kind !== 'bridge_dead'

      if (!alive) {
        return {
          state,
          effects: [
            { kind: 'bufferInbound', key: event.key, msg: event.msg },
            { kind: 'persistInbound', key: event.key, msg: event.msg },
            { kind: 'logTrace', stage: 'inbound_bridge_dead_buffer', key: event.key },
          ],
        }
      }

      if (inTurn && !isSteering) {
        // Mid-turn non-steering inbound: buffer (the #1556 contract).
        return {
          state,
          effects: [
            { kind: 'bufferInbound', key: event.key, msg: event.msg },
            { kind: 'persistInbound', key: event.key, msg: event.msg },
            { kind: 'logTrace', stage: 'inbound_held_mid_turn', key: event.key, metadata: { msgId: event.msg.msgId } },
          ],
        }
      }

      // Alive + (idle OR steering): deliver immediately.
      // Steering messages reach claude mid-turn intentionally; they
      // do NOT start a new turn (existing turn continues).
      if (isSteering) {
        return {
          state,
          effects: [
            { kind: 'deliverToBridge', key: event.key, msg: event.msg },
            { kind: 'logTrace', stage: 'steer_delivered_mid_turn', key: event.key },
          ],
        }
      }

      // Fresh turn: state transitions to in_turn(key), perKey
      // turnStartedAt is set, message delivered.
      const next: State = {
        global: { kind: 'bridge_alive_in_turn', activeTurn: event.key },
        perKey: state.perKey,
      }
      return {
        state: updatePerKey(next, event.key, (p) => ({ ...p, turnStartedAt: event.at })),
        effects: [
          { kind: 'setTurnStarted', key: event.key, at: event.at },
          { kind: 'deliverToBridge', key: event.key, msg: event.msg },
          { kind: 'logTrace', stage: 'fresh_turn_deliver', key: event.key, metadata: { msgId: event.msg.msgId } },
        ],
      }
    }

    case 'turnStart': {
      // External signal that a turn has begun (e.g. session_event
      // from bridge). Distinct from the implicit turn-start in
      // `inbound`: a turn can begin without a fresh inbound (cron
      // injection, scheduled fire).
      const next: State = state.global.kind === 'bridge_alive_in_turn'
        ? state
        : { ...state, global: { kind: 'bridge_alive_in_turn', activeTurn: event.key } }
      return {
        state: updatePerKey(next, event.key, (p) => ({ ...p, turnStartedAt: event.at })),
        effects: [
          { kind: 'setTurnStarted', key: event.key, at: event.at },
          { kind: 'logTrace', stage: 'turn_start', key: event.key },
        ],
      }
    }

    case 'turnEnd': {
      // Clear turn state for the ending key AND sweep siblings
      // (invariant #3). Transition global to idle if the ending turn
      // was the active one.
      const chatId = chatIdOfKey(event.key)
      const stateAfterClear = updatePerKey(state, event.key, (p) => ({
        turnStartedAt: null,
        lastOutboundAt: event.outboundEmitted ? event.at : p.lastOutboundAt,
      }))
      const sweep = sweepSiblings(stateAfterClear, chatId, event.key)
      const wasActive = state.global.kind === 'bridge_alive_in_turn' && state.global.activeTurn === event.key
      const next: State = wasActive
        ? { ...sweep.state, global: { kind: 'bridge_alive_idle' } }
        : sweep.state
      const effects: Effect[] = [
        { kind: 'clearTurnStarted', key: event.key },
        ...sweep.effects,
      ]
      if (event.outboundEmitted) {
        effects.push({ kind: 'noteOutbound', key: event.key, at: event.at })
      }
      effects.push({ kind: 'drainBuffer' })
      effects.push({ kind: 'logTrace', stage: 'turn_complete', key: event.key, metadata: { outboundEmitted: event.outboundEmitted } })
      return { state: next, effects }
    }

    case 'modelOutbound': {
      // Updates lastOutboundAt for the key. Does NOT change global
      // state. This is invariant #5's data: it carries across turn
      // boundaries so a spurious fallback can be suppressed.
      return {
        state: updatePerKey(state, event.key, (p) => ({ ...p, lastOutboundAt: event.at })),
        effects: [
          { kind: 'noteOutbound', key: event.key, at: event.at },
        ],
      }
    }

    case 'permVerdict': {
      const alive = state.global.kind !== 'bridge_dead'
      if (alive) {
        return {
          state,
          effects: [
            { kind: 'deliverPermVerdict', verdict: event.verdict },
            { kind: 'logTrace', stage: 'perm_verdict_delivered' },
          ],
        }
      }
      return {
        state,
        effects: [
          { kind: 'persistPermVerdict', verdict: event.verdict },
          { kind: 'logTrace', stage: 'perm_verdict_persisted' },
        ],
      }
    }

    case 'tick': {
      // Scan perKey for stale turns. For each entry with a non-null
      // turnStartedAt where `now - turnStartedAt > TURN_TTL_MS`:
      //   - Check lastOutboundAt: if it's null OR more than
      //     OUTBOUND_RECENT_MS old, fire the fallback poke + clear.
      //   - Otherwise suppress (invariant #5).
      const effects: Effect[] = []
      let next = state
      for (const [k, v] of state.perKey) {
        if (v.turnStartedAt == null) continue
        const age = event.now - v.turnStartedAt
        if (age <= TURN_TTL_MS) {
          // Not yet stale enough for fallback. Soft/firm pokes are
          // not modeled here yet — they're advisory, the gateway
          // emits them; the state machine governs the fallback gate.
          continue
        }
        // Stale enough for fallback. Check the suppression window.
        const recentOutbound =
          v.lastOutboundAt != null && (event.now - v.lastOutboundAt) < OUTBOUND_RECENT_MS
        if (recentOutbound) {
          // Invariant #5: model recently broke silence; suppress fire.
          effects.push({ kind: 'logTrace', stage: 'fallback_suppressed', key: k, metadata: { recentOutboundMs: event.now - (v.lastOutboundAt ?? 0) } })
          continue
        }
        // Fire the fallback + clear the turn.
        effects.push({ kind: 'firePoke', key: k, level: 'fallback' })
        effects.push({ kind: 'clearTurnStarted', key: k })
        next = updatePerKey(next, k, (p) => ({ ...p, turnStartedAt: null }))
        // If this was the active turn globally, drop to idle.
        if (next.global.kind === 'bridge_alive_in_turn' && next.global.activeTurn === k) {
          next = { ...next, global: { kind: 'bridge_alive_idle' } }
        }
      }
      return { state: next, effects }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Test-only helpers — mirror silence-poke.ts's __XForTests idiom
// ─────────────────────────────────────────────────────────────────────

export function __chatIdOfKeyForTests(key: ChatKey): string {
  return chatIdOfKey(key)
}
