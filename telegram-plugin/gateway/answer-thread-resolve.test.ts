import { describe, it, expect } from 'vitest'
import {
  resolveAnswerThreadId,
  isCrossChatAnchor,
  type AnswerThreadInput,
} from './answer-thread-resolve.js'

// Distinct symbolic thread ids so an output's provenance is unambiguous (no two
// tiers share a value): explicit=70, origin=50, live=30, lastEnded=90.
const T = 70 // explicit
const O = 50 // origin
const L = 30 // live
const E = 90 // lastEnded

// ── Framework-authority (DEFAULT) — human-readable map ──────────────────────
describe('resolveAnswerThreadId — framework authority (default)', () => {
  it('origin turn wins over the model explicit (the General→CRM fix)', () => {
    expect(
      resolveAnswerThreadId({
        explicitThreadId: T,
        originResolved: true,
        originThreadId: O,
        liveTurnPresent: true,
        liveThreadId: L,
      }),
    ).toBe(O)
  })

  it('THE marko case: a General-origin question (origin resolved, thread undefined) + model explicit ⇒ General, NOT the model topic', () => {
    expect(
      resolveAnswerThreadId({
        explicitThreadId: 4, // model tried to send the answer to CRM (topic 4)
        originResolved: true,
        originThreadId: undefined, // General origin carries no thread
        liveTurnPresent: true,
        liveThreadId: undefined,
      }),
    ).toBeUndefined() // → General, where it was asked
  })

  it('a live in-flight turn wins over the model explicit even with no origin echo', () => {
    expect(
      resolveAnswerThreadId({
        explicitThreadId: T,
        originResolved: false,
        liveTurnPresent: true,
        liveThreadId: L,
      }),
    ).toBe(L)
  })

  it('a General live turn (present, thread undefined) still beats the model explicit', () => {
    expect(
      resolveAnswerThreadId({
        explicitThreadId: T,
        originResolved: false,
        liveTurnPresent: true,
        liveThreadId: undefined,
      }),
    ).toBeUndefined()
  })

  it('model explicit is honoured only when there is NO origin and NO live turn (orphaned/proactive)', () => {
    expect(
      resolveAnswerThreadId({
        explicitThreadId: T,
        originResolved: false,
        liveTurnPresent: false,
      }),
    ).toBe(T)
  })

  it('late reply, no anchor, no explicit → recovers the last-ended topic', () => {
    expect(
      resolveAnswerThreadId({
        originResolved: false,
        liveTurnPresent: false,
        lastEndedResolvedForChat: true,
        lastEndedThreadIdForChat: E,
      }),
    ).toBe(E)
  })

  it('pure DM (no anchors) → undefined', () => {
    expect(resolveAnswerThreadId({ originResolved: false })).toBeUndefined()
  })
})

// ── Legacy precedence (kill switch SWITCHROOM_REPLY_TOPIC_AUTHORITY=0) ───────
describe('resolveAnswerThreadId — legacy (frameworkTopicAuthority:false)', () => {
  it('explicit wins outright (the old behaviour)', () => {
    expect(
      resolveAnswerThreadId({
        frameworkTopicAuthority: false,
        explicitThreadId: T,
        originResolved: true,
        originThreadId: O,
        liveThreadId: L,
      }),
    ).toBe(T)
  })
  it('origin beats live when no explicit (unchanged)', () => {
    expect(
      resolveAnswerThreadId({
        frameworkTopicAuthority: false,
        originResolved: true,
        originThreadId: O,
        liveThreadId: L,
      }),
    ).toBe(O)
  })
})

// ── Cross-chat anchor guard (bug c, 2026-08-13) ─────────────────────────────
//
// The live failure: a reply into chat A resolved its thread from an anchor turn
// owned by forum supergroup B, so B's topic id rode along on the send into A and
// Telegram answered `400 Bad Request: message thread not found`. The retry
// fallback resent threadless and succeeded, so the symptom was a guaranteed-
// failed FIRST API call rather than a lost message. Each case below asserts the
// RESOLVED THREAD, not that a branch ran.
const CHAT_A = '12345678' // a DM — the reply target
const CHAT_B = '-1001234567890' // a forum supergroup — where the anchor lives

describe('resolveAnswerThreadId — cross-chat anchor guard', () => {
  it("THE bug: a live turn in supergroup B must not lend its topic to a reply into chat A", () => {
    expect(
      resolveAnswerThreadId({
        targetChatId: CHAT_A,
        originResolved: false,
        liveTurnPresent: true,
        liveThreadId: 635, // B's topic — the id Telegram rejected
        liveChatId: CHAT_B,
      }),
    ).toBeUndefined() // → no thread; the send into A is threadless and succeeds
  })

  it('a cross-chat ORIGIN anchor (origin_turn_id echoed from another chat) is ignored', () => {
    expect(
      resolveAnswerThreadId({
        targetChatId: CHAT_A,
        originResolved: true,
        originThreadId: O,
        originChatId: CHAT_B,
      }),
    ).toBeUndefined()
  })

  it('a dropped cross-chat anchor falls through to the model explicit (its only remaining signal)', () => {
    expect(
      resolveAnswerThreadId({
        targetChatId: CHAT_A,
        explicitThreadId: T,
        originResolved: true,
        originThreadId: O,
        originChatId: CHAT_B,
        liveTurnPresent: true,
        liveThreadId: L,
        liveChatId: CHAT_B,
      }),
    ).toBe(T)
  })

  it('a dropped cross-chat anchor falls through to the chat-scoped last-ended recovery when there is no explicit', () => {
    expect(
      resolveAnswerThreadId({
        targetChatId: CHAT_A,
        originResolved: false,
        liveTurnPresent: true,
        liveThreadId: L,
        liveChatId: CHAT_B,
        lastEndedResolvedForChat: true,
        lastEndedThreadIdForChat: E,
      }),
    ).toBe(E)
  })

  it('a SAME-chat anchor is untouched — the guard only drops foreign chats', () => {
    expect(
      resolveAnswerThreadId({
        targetChatId: CHAT_B,
        explicitThreadId: T,
        originResolved: true,
        originThreadId: O,
        originChatId: CHAT_B,
      }),
    ).toBe(O)
  })

  it('an origin in chat A survives while a live turn in chat B is dropped (independent guards)', () => {
    expect(
      resolveAnswerThreadId({
        targetChatId: CHAT_A,
        originResolved: true,
        originThreadId: O,
        originChatId: CHAT_A,
        liveTurnPresent: true,
        liveThreadId: L,
        liveChatId: CHAT_B,
      }),
    ).toBe(O)
  })

  it('the guard also applies under the legacy kill switch — a wrong-chat topic is an API error, not a precedence policy', () => {
    expect(
      resolveAnswerThreadId({
        frameworkTopicAuthority: false,
        targetChatId: CHAT_A,
        originResolved: true,
        originThreadId: O,
        originChatId: CHAT_B,
        liveThreadId: L,
        liveChatId: CHAT_B,
      }),
    ).toBeUndefined()
  })

  it('numeric-vs-string chat ids compare by value, so no anchor is dropped spuriously', () => {
    expect(
      resolveAnswerThreadId({
        targetChatId: CHAT_B,
        originResolved: true,
        originThreadId: O,
        originChatId: String(Number(CHAT_B)),
      }),
    ).toBe(O)
  })

  it('BACK-COMPAT: with no chat ids supplied the guard is inert (identical to pre-guard routing)', () => {
    expect(
      resolveAnswerThreadId({
        originResolved: false,
        liveTurnPresent: true,
        liveThreadId: L,
      }),
    ).toBe(L)
  })
})

describe('isCrossChatAnchor', () => {
  it('true only when both ids are present and differ', () => {
    expect(isCrossChatAnchor(CHAT_A, CHAT_B)).toBe(true)
    expect(isCrossChatAnchor(CHAT_A, CHAT_A)).toBe(false)
    expect(isCrossChatAnchor(undefined, CHAT_B)).toBe(false)
    expect(isCrossChatAnchor(CHAT_A, undefined)).toBe(false)
    expect(isCrossChatAnchor('', CHAT_B)).toBe(false)
    expect(isCrossChatAnchor(CHAT_A, '')).toBe(false)
  })
})

// ── TOTAL-ENUMERATION DETERMINISM PROOF ─────────────────────────────────────
//
// The operator standard (memory feedback_prove_finite_fsm_not_sample): a passing
// sample is not a proof. `resolveAnswerThreadId` is a PURE decision function over
// a FINITE input space — so we prove its behaviour by CONSTRUCTION: enumerate
// every REACHABLE input (origin/live/ended each have 3 reachable states ×
// explicit present/absent) for BOTH precedence modes, and assert totality,
// determinism, no-fabrication, the documented precedence, and the load-bearing
// guarantee: under framework authority the model's explicit thread CANNOT
// redirect a reply that has a framework anchor.

// Reachable sub-states (a thread value is only present when its 'resolved' flag is).
const ORIGIN_STATES: Array<Pick<AnswerThreadInput, 'originResolved' | 'originThreadId'>> = [
  { originResolved: false },
  { originResolved: true, originThreadId: undefined }, // DM/General origin
  { originResolved: true, originThreadId: O },
]
const LIVE_STATES: Array<Pick<AnswerThreadInput, 'liveTurnPresent' | 'liveThreadId'>> = [
  { liveTurnPresent: false },
  { liveTurnPresent: true, liveThreadId: undefined }, // General live turn
  { liveTurnPresent: true, liveThreadId: L },
]
const ENDED_STATES: Array<
  Pick<AnswerThreadInput, 'lastEndedResolvedForChat' | 'lastEndedThreadIdForChat'>
> = [
  { lastEndedResolvedForChat: false },
  { lastEndedResolvedForChat: true, lastEndedThreadIdForChat: undefined },
  { lastEndedResolvedForChat: true, lastEndedThreadIdForChat: E },
]

function reachableInputs(frameworkTopicAuthority: boolean): AnswerThreadInput[] {
  const rows: AnswerThreadInput[] = []
  for (const explicitThreadId of [undefined, T])
    for (const o of ORIGIN_STATES)
      for (const lv of LIVE_STATES)
        for (const en of ENDED_STATES)
          rows.push({ explicitThreadId, ...o, ...lv, ...en, frameworkTopicAuthority })
  return rows // 2 × 3 × 3 × 3 = 54
}

// Independent SPEC encodings, kept separate from the implementation so a
// regression in either surfaces as a divergence.
function specFramework(i: AnswerThreadInput): number | undefined {
  if (i.originResolved) return i.originThreadId // (1)
  if (i.liveTurnPresent) return i.liveThreadId // (2)
  if (i.explicitThreadId != null) return i.explicitThreadId // (3)
  if (i.lastEndedResolvedForChat) return i.lastEndedThreadIdForChat // (4)
  return i.liveThreadId
}
function specLegacy(i: AnswerThreadInput): number | undefined {
  if (i.explicitThreadId != null) return i.explicitThreadId
  if (i.originResolved) return i.originThreadId
  if (i.liveThreadId != null) return i.liveThreadId
  if (i.lastEndedResolvedForChat) return i.lastEndedThreadIdForChat
  return i.liveThreadId
}

describe('resolveAnswerThreadId — total-enumeration proof (54 reachable inputs × 2 modes)', () => {
  const FA = reachableInputs(true)
  const LEGACY = reachableInputs(false)

  it('the reachable input space is exactly 54 rows per mode', () => {
    expect(FA.length).toBe(54)
    expect(LEGACY.length).toBe(54)
  })

  it('TOTAL: every input returns without throwing (both modes)', () => {
    for (const i of [...FA, ...LEGACY]) expect(() => resolveAnswerThreadId(i)).not.toThrow()
  })

  it('DETERMINISTIC: each input maps to exactly one output across repeated calls', () => {
    for (const i of [...FA, ...LEGACY]) {
      expect(resolveAnswerThreadId({ ...i })).toBe(resolveAnswerThreadId(i))
    }
  })

  it('NO FABRICATION: every output is undefined or one of the four input thread fields', () => {
    for (const i of [...FA, ...LEGACY]) {
      const out = resolveAnswerThreadId(i)
      const provenance = new Set([
        undefined,
        i.explicitThreadId,
        i.originThreadId,
        i.liveThreadId,
        i.lastEndedThreadIdForChat,
      ])
      expect(provenance.has(out)).toBe(true)
    }
  })

  it('PRECEDENCE (framework): matches the documented spec on all 54 inputs', () => {
    for (const i of FA) expect(resolveAnswerThreadId(i)).toBe(specFramework(i))
  })

  it('PRECEDENCE (legacy): matches the legacy spec on all 54 inputs', () => {
    for (const i of LEGACY) expect(resolveAnswerThreadId(i)).toBe(specLegacy(i))
  })

  // ── The load-bearing guarantee ────────────────────────────────────────────
  it('INV-ANCHOR (framework): the model explicit CANNOT redirect a reply that has a framework anchor — output is independent of explicitThreadId whenever originResolved OR liveTurnPresent', () => {
    for (const i of FA) {
      if (i.originResolved || i.liveTurnPresent) {
        const withExplicit = resolveAnswerThreadId({ ...i, explicitThreadId: T })
        const without = resolveAnswerThreadId({ ...i, explicitThreadId: undefined })
        expect(withExplicit).toBe(without)
      }
    }
  })

  it('INV-ORIGIN (framework): originResolved ⇒ output === originThreadId, for EVERY explicit/live/ended combo (flip-immunity + explicit-immunity)', () => {
    for (const i of FA) if (i.originResolved) expect(resolveAnswerThreadId(i)).toBe(i.originThreadId)
  })

  it('INV-LIVE (framework): ¬originResolved ∧ liveTurnPresent ⇒ output === liveThreadId, regardless of explicit', () => {
    for (const i of FA) {
      if (!i.originResolved && i.liveTurnPresent) expect(resolveAnswerThreadId(i)).toBe(i.liveThreadId)
    }
  })

  it('INV-EXPLICIT-LAST (framework): an explicit-tier result occurs ONLY when no origin AND no live turn', () => {
    for (const i of FA) {
      if (resolveAnswerThreadId(i) === T) {
        expect(i.originResolved).toBe(false)
        expect(i.liveTurnPresent).toBe(false)
      }
    }
  })

  it('INV-EXPLICIT-DOMINANCE (legacy): explicit set ⇒ output === explicit, independent of all other fields', () => {
    for (const i of LEGACY) if (i.explicitThreadId != null) expect(resolveAnswerThreadId(i)).toBe(i.explicitThreadId)
  })

  // ── Cross-chat guard, proved over the same enumeration (both modes) ────────
  it('INV-CROSS-CHAT: anchors in a FOREIGN chat route exactly as if they did not exist, on all 54 inputs × 2 modes', () => {
    for (const i of [...FA, ...LEGACY]) {
      const foreign = resolveAnswerThreadId({
        ...i,
        targetChatId: CHAT_A,
        originChatId: CHAT_B,
        liveChatId: CHAT_B,
      })
      const anchorless = resolveAnswerThreadId({
        ...i,
        originResolved: false,
        originThreadId: undefined,
        liveTurnPresent: false,
        liveThreadId: undefined,
      })
      expect(foreign).toBe(anchorless)
    }
  })

  it('INV-SAME-CHAT: annotating anchors with the TARGET chat changes nothing, on all 54 inputs × 2 modes', () => {
    for (const i of [...FA, ...LEGACY]) {
      expect(
        resolveAnswerThreadId({
          ...i,
          targetChatId: CHAT_A,
          originChatId: CHAT_A,
          liveChatId: CHAT_A,
        }),
      ).toBe(resolveAnswerThreadId(i))
    }
  })
})
