/**
 * narration-leak-3513.test.ts — outcome-asserting regression suite for
 * switchroom#3513 ("agent intent-narration leaks into the final Telegram reply
 * as a real chat message").
 *
 * The single-surface invariant: every trailing plain-text block is assigned once
 * to exactly one surface — delivered chat answer / ephemeral progress card /
 * suppressed — by ONE shared classifier, and NO delivery path (E1 turn-flush,
 * E2 quiescence, E3 captured-prose bridge, E4 outbox sweep) ever emits a block
 * classified as structural narration; the one genuine unsent answer still
 * delivers exactly once.
 *
 * Every test here asserts an OUTCOME (was the narration delivered? was the real
 * answer delivered?), not merely that a code path ran, and each is written to be
 * RED on the pre-fix code (which had two hand-synced regex classifiers and no
 * structural/ledger guard).
 */

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  isStructuralNarration,
  isNarrationBlock,
  ledgerHashHex,
  SUBSTANTIVE_MIN_CHARS,
} from '../hooks/narration-classify.mjs'
import { selectFlushDeliveryText, FLUSH_SUBSTANTIVE_MIN_CHARS } from '../turn-flush-safety.js'
import { decideOutboxSweep } from '../outbox.js'
import { decideCapturedProseDelivery } from '../silent-end.js'
import { appendShownBlock, isShownBlock, readShownHashes } from '../shown-ledger.js'
import { NarrativeFlushController } from '../narrative-flush.js'

const NARRATION = 'Now let me check the gateway logs to see what happened.'
const REAL_ANSWER =
  'The gateway crashed because the outbox sweep tried to deliver a record whose ' +
  'turnNonce had already been journaled, and the dedup cache had been evicted, so ' +
  'the exactly-once guard fell back to the text-dedup path which returned false. ' +
  'The fix is to check the shown-ledger before the quiet window, not after.'

// A substantive real message that the model happens to precede a NON-delivering
// tool with (react / pin / typing). Must NOT be treated as narration.
const SUBSTANTIVE_BEFORE_REACT = REAL_ANSWER

describe('shared classifier — the ONE source of truth (correction 2 + 3)', () => {
  it('short/narration-shaped block followed by a tool IS structural narration', () => {
    expect(isStructuralNarration(NARRATION, true)).toBe(true)
    expect(isStructuralNarration('On it — pulling the numbers…', true)).toBe(true)
    expect(isStructuralNarration('', true)).toBe(true)
  })

  it('SUBSTANTIVE block followed by a tool is NOT narration (react/pin/typing still delivers)', () => {
    // The #3237 asymmetry: a real answer preceding react/pin/typing must deliver.
    expect(SUBSTANTIVE_BEFORE_REACT.length).toBeGreaterThan(SUBSTANTIVE_MIN_CHARS)
    expect(isStructuralNarration(SUBSTANTIVE_BEFORE_REACT, true)).toBe(false)
  })

  it('a terminal block (nothing followed it) is NEVER structural narration', () => {
    // followedByToolUse false OR absent → never structural (could be the answer).
    expect(isStructuralNarration(NARRATION, false)).toBe(false)
    expect(isStructuralNarration(NARRATION, undefined)).toBe(false)
    expect(isStructuralNarration('Yes.', false)).toBe(false)
  })

  it('FLUSH_SUBSTANTIVE_MIN_CHARS is wired to the shared constant (no drift)', () => {
    expect(FLUSH_SUBSTANTIVE_MIN_CHARS).toBe(SUBSTANTIVE_MIN_CHARS)
  })
})

describe('E1/E2 turn-flush — narration never becomes the delivered answer', () => {
  it('drops a trailing narration block that a tool followed, keeps the real answer', () => {
    const out = selectFlushDeliveryText([REAL_ANSWER, NARRATION], [false, true])
    expect(out).toContain(REAL_ANSWER)
    expect(out).not.toContain(NARRATION)
  })

  it('drops a SHORT non-regex block a tool followed (the class the old regex missed)', () => {
    // "The logs show three errors." matches NO wording heuristic (no opener, no
    // trailing ellipsis/colon) — the pre-fix regex-only classifier would have
    // DELIVERED it. It is structural narration only because a tool followed it
    // AND it is under the substantive floor. This is the core #3513 discriminator.
    const shortNonRegex = 'The logs show three errors.'
    expect(isNarrationBlock(shortNonRegex)).toBe(false)
    expect(shortNonRegex.length).toBeLessThan(SUBSTANTIVE_MIN_CHARS)
    const out = selectFlushDeliveryText([REAL_ANSWER, shortNonRegex], [false, true])
    expect(out).toContain(REAL_ANSWER)
    expect(out).not.toContain(shortNonRegex)
  })

  it('zero-reply, narration-only turn (all blocks followed by tools) flushes NOTHING', () => {
    const out = selectFlushDeliveryText(['Let me pull the logs.', NARRATION], [true, true])
    expect(out).toBe('')
  })

  it('a genuine terminal answer with no provenance still flushes (fail-open)', () => {
    // Provenance-less single block — conservative: deliver it.
    expect(selectFlushDeliveryText(['Here are the results:'])).toBe('Here are the results:')
  })

  it('a SUBSTANTIVE answer followed by a non-delivering tool STILL flushes', () => {
    const out = selectFlushDeliveryText([SUBSTANTIVE_BEFORE_REACT], [true])
    expect(out).toBe(SUBSTANTIVE_BEFORE_REACT)
  })
})

describe('E4 outbox sweep — a ledger-marked block is never re-delivered (correction 1)', () => {
  const base = {
    now: 10_000_000,
    deliveredNonces: new Set<string>(),
    textAlreadyDelivered: false,
    routable: true,
    quietMs: 0,
  }

  it('skips a record whose text was shown on the ephemeral card', () => {
    const d = decideOutboxSweep({
      ...base,
      record: { turnNonce: 'c:_#5', text: NARRATION, createdAt: 0 },
      shownLedgerHit: true,
    })
    expect(d.action).toBe('skip-ephemeral-shown')
    expect(d.text).toBeUndefined()
  })

  it('delivers a real answer that was NOT shown on the card', () => {
    const d = decideOutboxSweep({
      ...base,
      record: { turnNonce: 'c:_#5', text: REAL_ANSWER, createdAt: base.now },
      shownLedgerHit: false,
    })
    expect(d.action).toBe('send')
    expect(d.text).toContain(REAL_ANSWER)
  })

  it('the ledger hit is checked AFTER journaled (exactly-once wins) but BEFORE quiet', () => {
    // Already-journaled record short-circuits regardless of ledger state.
    const journaled = decideOutboxSweep({
      ...base,
      deliveredNonces: new Set(['c:_#5']),
      record: { turnNonce: 'c:_#5', text: NARRATION, createdAt: 0 },
      shownLedgerHit: true,
    })
    expect(journaled.action).toBe('skip-journaled')
  })
})

describe('E3 captured-prose bridge — a shown block is refused (correction 1)', () => {
  /** Write a real silent-end-pending.json into a temp stateDir. */
  function withState(text: string, run: (deps: { stateDir: string }) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'silent-end-'))
    try {
      writeFileSync(
        join(dir, 'silent-end-pending.json'),
        JSON.stringify({
          chatId: 'c',
          threadId: null,
          turnKey: 'c:_',
          turnId: 'c:_#5',
          pendingText: text,
          retryCount: 0,
          timestamp: Date.now(),
        }),
      )
      run({ stateDir: dir })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('refuses to bridge prose already surfaced on the card', () => {
    withState(REAL_ANSWER, ({ stateDir }) => {
      const d = decideCapturedProseDelivery(
        { turnKey: 'c:_', turnId: 'c:_#5', minChars: 10 },
        { stateDir, isBlockShown: () => true },
      )
      expect(d.deliver).toBe(false)
      expect(d.reason).toBe('ephemeral-shown')
    })
  })

  it('bridges a genuine unsent answer that was NOT shown (empty-capture divergence)', () => {
    withState(REAL_ANSWER, ({ stateDir }) => {
      const d = decideCapturedProseDelivery(
        { turnKey: 'c:_', turnId: 'c:_#5', minChars: 10 },
        { stateDir, isBlockShown: () => false },
      )
      expect(d.deliver).toBe(true)
      if (d.deliver) expect(d.text).toContain(REAL_ANSWER)
    })
  })
})

describe('durable shown-ledger — round trip + envelope-less no-op (correction 4)', () => {
  it('marks then recognises a structural narration block for its turnNonce', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shown-ledger-'))
    try {
      appendShownBlock('c:_#7', NARRATION, dir)
      expect(isShownBlock('c:_#7', NARRATION, dir)).toBe(true)
      // A different turn's nonce must NOT match (no cross-turn suppression).
      expect(isShownBlock('c:_#8', NARRATION, dir)).toBe(false)
      // The stored hash matches the shared classifier hash.
      expect(readShownHashes('c:_#7', dir).has(ledgerHashHex(NARRATION))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a null turnNonce (envelope-less handback/cron) is never written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shown-ledger-'))
    try {
      appendShownBlock(null, NARRATION, dir)
      expect(isShownBlock(null, NARRATION, dir)).toBe(false)
      expect(readShownHashes(null, dir).size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** Fake at-most-one scheduler mirroring the real unref'd setTimeout wiring. */
class FakeScheduler {
  private fn: (() => void) | null = null
  arm(fn: () => void): void {
    this.fn = fn
  }
  disarm(): void {
    this.fn = null
  }
  fire(): void {
    const fn = this.fn
    this.fn = null
    fn?.()
  }
}

describe('narrative controller — durable-mark ONLY mid-turn narration (correction 4)', () => {
  function make() {
    const show = vi.fn<[string], void>()
    const retractShown = vi.fn<[string], void>()
    const markDurableNarration = vi.fn<[string], void>()
    const scheduler = new FakeScheduler()
    const ctrl = new NarrativeFlushController(
      { show, retractShown, markDurableNarration },
      scheduler,
      250,
    )
    return { ctrl, show, markDurableNarration, scheduler }
  }

  it('marks a block SHOWN mid-turn because another narration block followed it (stage)', () => {
    const { ctrl, show, markDurableNarration } = make()
    ctrl.stage('First, let me check the logs…')
    ctrl.stage('Now scanning the outbox…') // lookahead → shows + marks the first
    expect(show).toHaveBeenCalledWith('First, let me check the logs…')
    expect(markDurableNarration).toHaveBeenCalledWith('First, let me check the logs…')
  })

  it('marks a block SHOWN mid-turn because a tool followed it (resolveOnTool)', () => {
    const { ctrl, markDurableNarration } = make()
    ctrl.stage(NARRATION)
    ctrl.resolveOnTool('Bash', { command: 'grep' }) // non-reply tool lookahead
    expect(markDurableNarration).toHaveBeenCalledWith(NARRATION)
  })

  it('NEVER marks the timer-painted terminal block (could be the real answer)', () => {
    const { ctrl, show, markDurableNarration, scheduler } = make()
    ctrl.stage(REAL_ANSWER)
    scheduler.fire() // timer paints the LAST block early
    expect(show).toHaveBeenCalledWith(REAL_ANSWER)
    expect(markDurableNarration).not.toHaveBeenCalled()
  })

  it('NEVER marks the turn-end paint (terminal, could be the real answer)', () => {
    const { ctrl, show, markDurableNarration } = make()
    ctrl.stage(REAL_ANSWER)
    ctrl.flushAtTurnEnd('') // no reply delivered → shows trailing prose, but never marks
    expect(show).toHaveBeenCalledWith(REAL_ANSWER)
    expect(markDurableNarration).not.toHaveBeenCalled()
  })

  it('does NOT mark a SUBSTANTIVE block even mid-turn (substance-gated, correction 3)', () => {
    const { ctrl, markDurableNarration } = make()
    ctrl.stage(SUBSTANTIVE_BEFORE_REACT)
    ctrl.resolveOnTool('react', { emoji: '👍' }) // non-delivering tool
    // Followed by a tool, but substantive → not structural narration → not marked,
    // so a backstop could still deliver it if it were the genuine unsent answer.
    expect(markDurableNarration).not.toHaveBeenCalled()
  })
})
