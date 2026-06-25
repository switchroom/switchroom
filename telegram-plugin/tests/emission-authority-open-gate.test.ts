import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  initHistory,
  recordOutbound,
  hasOutboundDeliveredSince,
  _resetForTests,
} from '../history.js'
import {
  mayOpenActivityCard,
  computeCrossTurnAnswerDelivered,
  type FeedOpenGateView,
  type FeedOpenGateDeps,
  type FeedOpenProducer,
} from '../gateway/feed-open-gate.js'
import { FINAL_ANSWER_MIN_CHARS } from '../final-answer-detect.js'

/**
 * PR-4b flag-parity proof — the HEART of the PR, at the façade layer.
 *
 * The emission-authority façade's `openOrEditCard` now RELOCATES main's drain
 * OPEN-gate decision behind the `SWITCHROOM_EMISSION_AUTHORITY` kill-switch. The
 * defining correctness property: flag-OFF ≡ flag-ON ≡ main — not one emitted
 * card differs. This drives `openOrEditCard(producer, applySpy)` across the full
 * input cross-product, for BOTH flag states, and asserts:
 *
 *   - flag OFF  → `applySpy` is ALWAYS called (4a behaviour — the drain's own
 *     gate is what refuses an OPEN; the façade is a pass-through).
 *   - flag ON   → `applySpy` is called IFF `mayOpen` OR the card is already
 *     open (an EDIT is never gated); the SKIP set is exactly the cases where
 *     main would `break` (refuse an OPEN): `activityMessageId == null && !mayOpen`.
 *
 * The flag is read ONCE at module top (the asserted read-once invariant — we do
 * NOT change that). We flip it per flag state by dynamically re-importing the
 * façade module under a unique query string (bun re-evaluates the module, so the
 * read-once const is recomputed against the chosen env). This is a TEST-ONLY
 * seam — it does not touch the production read-once path. The history harness is
 * real (a substantive row ⇒ a true cross-turn flag), so this also proves the
 * wired predicate end-to-end.
 */

let stateDir: string

const SUBSTANTIVE = 'A'.repeat(FINAL_ANSWER_MIN_CHARS)
const CHAT = '-100888'
const OPENED_AT_MS = 1_000_000 * 1000

const deps: FeedOpenGateDeps = {
  hasOutboundDeliveredSince,
  historyEnabled: true,
  finalAnswerMinChars: FINAL_ANSWER_MIN_CHARS,
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'emission-open-gate-'))
  initHistory(stateDir, 30)
})

afterEach(() => {
  _resetForTests()
  delete process.env.SWITCHROOM_EMISSION_AUTHORITY
  if (existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true })
})

let reimportSeq = 0
/**
 * Re-import the façade module with the flag set as requested. Bun re-evaluates a
 * module imported under a fresh query string, so the read-once
 * `EMISSION_AUTHORITY_ENABLED` const is recomputed against the env we set here —
 * a test-only seam that leaves the production read-once path untouched.
 */
async function loadFacade(enabled: boolean): Promise<typeof import('../gateway/emission-authority.js')> {
  if (enabled) process.env.SWITCHROOM_EMISSION_AUTHORITY = '1'
  else delete process.env.SWITCHROOM_EMISSION_AUTHORITY
  return import(`../gateway/emission-authority.js?flagcase=${reimportSeq++}`)
}

// The full cross-product of OPEN-decision inputs (mirrors the verdict test).
type Case = {
  crossTurnTrue: boolean
  finalAnswerEverDelivered: boolean
  producer: FeedOpenProducer
  labeledToolCount: number
  activityMessageId: number | null
}

function* cases(): Generator<Case> {
  for (const crossTurnTrue of [false, true]) {
    for (const finalAnswerEverDelivered of [false, true]) {
      for (const producer of ['narrative', 'tool', 'liveness'] as FeedOpenProducer[]) {
        for (const labeledToolCount of [0, 1]) {
          for (const activityMessageId of [null, 123] as (number | null)[]) {
            yield { crossTurnTrue, finalAnswerEverDelivered, producer, labeledToolCount, activityMessageId }
          }
        }
      }
    }
  }
}

function viewFor(c: Case): FeedOpenGateView {
  return {
    activityMessageId: c.activityMessageId,
    finalAnswerEverDelivered: c.finalAnswerEverDelivered,
    labeledToolCount: c.labeledToolCount,
    crossTurnGate: { sinceMs: OPENED_AT_MS },
    sessionChatId: CHAT,
    sessionThreadId: null,
  }
}

/** The exact `mayOpen` oracle (direct mayOpenActivityCard, real history flag). */
function oracleMayOpen(c: Case, view: FeedOpenGateView): boolean {
  const crossTurnAnswerDelivered = computeCrossTurnAnswerDelivered(view, deps)
  return mayOpenActivityCard({
    producer: c.producer,
    finalAnswerEverDelivered: c.finalAnswerEverDelivered,
    labeledToolCount: c.labeledToolCount,
    crossTurnAnswerDelivered,
  })
}

describe('openOrEditCard flag-parity — flag OFF always applies, flag ON applies iff main would not break', () => {
  it('flag OFF: applySpy is ALWAYS called (4a pass-through, every input)', async () => {
    const { EmissionAuthority } = await loadFacade(false)
    for (const c of cases()) {
      if (c.crossTurnTrue) {
        recordOutbound({ chat_id: CHAT, thread_id: null, message_ids: [42], texts: [SUBSTANTIVE], ts: 1_000_001 })
      }
      const view = viewFor(c)
      const ea = new EmissionAuthority('k')
      ea.wireFeedOpenGate(() => view, deps)
      const applySpy = vi.fn()
      ea.openOrEditCard(c.producer, applySpy)
      expect(applySpy).toHaveBeenCalledTimes(1)
      _resetForTests()
      initHistory(stateDir, 30)
    }
  })

  it('flag ON: applySpy called IFF (isOpen || mayOpen); SKIP set == cases main would break', async () => {
    const { EmissionAuthority } = await loadFacade(true)
    const skippedKeys: string[] = []
    const expectedBreakKeys: string[] = []
    for (const c of cases()) {
      if (c.crossTurnTrue) {
        recordOutbound({ chat_id: CHAT, thread_id: null, message_ids: [42], texts: [SUBSTANTIVE], ts: 1_000_001 })
      }
      const view = viewFor(c)
      const isOpen = c.activityMessageId != null
      const mayOpen = oracleMayOpen(c, view)
      // Main's drain refuses (break) iff about to OPEN AND !mayOpen.
      const mainWouldBreak = !isOpen && !mayOpen

      const ea = new EmissionAuthority('k')
      ea.wireFeedOpenGate(() => view, deps)
      const applySpy = vi.fn()
      ea.openOrEditCard(c.producer, applySpy)

      const key = `crossTurn=${c.crossTurnTrue} final=${c.finalAnswerEverDelivered} producer=${c.producer} tools=${c.labeledToolCount} msgId=${c.activityMessageId ?? 'null'}`
      if (applySpy.mock.calls.length === 0) skippedKeys.push(key)
      if (mainWouldBreak) expectedBreakKeys.push(key)

      // Per-case parity: applied iff NOT(main would break).
      expect(applySpy).toHaveBeenCalledTimes(mainWouldBreak ? 0 : 1)
      // An already-open card (EDIT) is never gated under the flag.
      if (isOpen) expect(applySpy).toHaveBeenCalledTimes(1)

      _resetForTests()
      initHistory(stateDir, 30)
    }
    // Set equality: the flag-ON skip set is EXACTLY main's break set.
    expect(skippedKeys.sort()).toEqual(expectedBreakKeys.sort())
    // Sanity: the skip set is non-empty (the gate actually fires for some input).
    expect(skippedKeys.length).toBeGreaterThan(0)
  })
})
