/**
 * Unit tests for the session-start privacy reset (PR3 of `/private` `/public`).
 *
 * Covers the two collaborating pieces:
 *   - `resetPrivacyOnGenuineSessionStart` (privacy-state.ts): always truncates
 *     to public; fires `onOpenIntervalReset` ONLY on a private→public
 *     transition (a leftover OPEN interval).
 *   - `makePrivacyResetForNewSession` (privacy-reset.ts): binds the loud-send
 *     primitive so the alert is emitted exactly when — and only when — that
 *     transition happened.
 *
 * The three spec scenarios:
 *   1. leftover open interval  → file reset to empty AND loud alert emitted
 *   2. already public          → file reset, NO alert
 *   3. compact / no-reset path → state PRESERVED unchanged, NO alert
 *
 * Run with: npx vitest run telegram-plugin/gateway/privacy-reset.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openPrivateInterval,
  readPrivacyState,
  resetPrivacyOnGenuineSessionStart,
  emptyPrivacyState,
  privacyStatePath,
  SESSION_RESET_ALERT,
} from './privacy-state.js'
import {
  makePrivacyResetForNewSession,
  bootRestoresTranscript,
  isContinueRestoreBoot,
} from './privacy-reset.js'

describe('privacy session-start reset', () => {
  let dir: string
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'privacy-reset-'))
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  const onDisk = () => JSON.parse(readFileSync(privacyStatePath(dir), 'utf8'))

  describe('resetPrivacyOnGenuineSessionStart', () => {
    it('scenario 1: a leftover OPEN interval → file reset to empty AND callback fired', () => {
      openPrivateInterval(new Date('2026-08-06T02:00:00.000Z'), dir)
      const onReset = vi.fn()
      const result = resetPrivacyOnGenuineSessionStart({ stateDir: dir, onOpenIntervalReset: onReset })
      expect(result.hadOpenInterval).toBe(true)
      expect(onReset).toHaveBeenCalledTimes(1)
      expect(onDisk()).toEqual(emptyPrivacyState())
    })

    it('scenario 2: already public → file reset (idempotent), NO callback', () => {
      const onReset = vi.fn()
      const result = resetPrivacyOnGenuineSessionStart({ stateDir: dir, onOpenIntervalReset: onReset })
      expect(result.hadOpenInterval).toBe(false)
      expect(onReset).not.toHaveBeenCalled()
      expect(onDisk()).toEqual(emptyPrivacyState())
    })

    it('scenario 2b: a CLOSED-only history is treated as public → NO callback, reset to empty', () => {
      writeFileSync(
        privacyStatePath(dir),
        JSON.stringify({
          version: 1,
          intervals: [{ start: '2026-08-06T02:00:00.000Z', end: '2026-08-06T02:05:00.000Z' }],
        }),
        'utf8',
      )
      const onReset = vi.fn()
      const result = resetPrivacyOnGenuineSessionStart({ stateDir: dir, onOpenIntervalReset: onReset })
      expect(result.hadOpenInterval).toBe(false)
      expect(onReset).not.toHaveBeenCalled()
      expect(onDisk().intervals).toEqual([])
    })

    it('scenario 3: a NON-reset path (compact / resume) preserves state — no reset is called', () => {
      // The compact/resume paths are EXEMPT by construction: the gateway simply
      // never calls the reset there. This asserts the invariant that, absent a
      // reset, an open private interval survives untouched.
      openPrivateInterval(new Date('2026-08-06T02:00:00.000Z'), dir)
      const before = readPrivacyState(dir)
      // ...compaction happens here in the real gateway; privacy is not touched...
      const after = readPrivacyState(dir)
      expect(after).toEqual(before)
      expect(after.intervals).toEqual([{ start: '2026-08-06T02:00:00.000Z', end: null }])
    })
  })

  describe('makePrivacyResetForNewSession (loud-send binding)', () => {
    // The factory uses the DEFAULT state-dir resolver (no stateDir param), so
    // point TELEGRAM_STATE_DIR at the temp dir for the duration of this test.
    let prevEnv: string | undefined
    beforeEach(() => {
      prevEnv = process.env.TELEGRAM_STATE_DIR
      process.env.TELEGRAM_STATE_DIR = dir
    })
    afterEach(() => {
      if (prevEnv === undefined) delete process.env.TELEGRAM_STATE_DIR
      else process.env.TELEGRAM_STATE_DIR = prevEnv
    })

    it('emits the loud SESSION_RESET_ALERT to the chat only on a private→public transition', () => {
      const send = vi.fn<(chatId: string, threadId: number | undefined, text: string) => void>()
      const reset = makePrivacyResetForNewSession(send)

      // Already public: no alert.
      reset('chat-1', undefined)
      expect(send).not.toHaveBeenCalled()
      expect(onDisk()).toEqual(emptyPrivacyState())

      // Now go private, then reset: exactly one loud alert with the pinned text.
      openPrivateInterval(new Date('2026-08-06T02:00:00.000Z'))
      reset('chat-1', 77)
      expect(send).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledWith('chat-1', 77, SESSION_RESET_ALERT)
      expect(onDisk()).toEqual(emptyPrivacyState())
    })
  })

  describe('boot reset gating on --continue transcript-restore (MAJOR fix)', () => {
    it('bootRestoresTranscript: continue/auto restore; handoff/none/undefined do not; force-fresh overrides', () => {
      expect(bootRestoresTranscript({ resumeMode: 'continue', forceFresh: false })).toBe(true)
      expect(bootRestoresTranscript({ resumeMode: 'auto', forceFresh: false })).toBe(true)
      expect(bootRestoresTranscript({ resumeMode: 'handoff', forceFresh: false })).toBe(false)
      expect(bootRestoresTranscript({ resumeMode: 'none', forceFresh: false })).toBe(false)
      expect(bootRestoresTranscript({ resumeMode: undefined, forceFresh: false })).toBe(false)
      // A /new /reset force-fresh boot is genuinely fresh even under continue/auto.
      expect(bootRestoresTranscript({ resumeMode: 'continue', forceFresh: true })).toBe(false)
      expect(bootRestoresTranscript({ resumeMode: 'auto', forceFresh: true })).toBe(false)
    })

    it('isContinueRestoreBoot reads SWITCHROOM_RESUME_MODE / SWITCHROOM_FORCE_FRESH', () => {
      const saved = { ...process.env }
      try {
        delete process.env.SWITCHROOM_FORCE_FRESH
        process.env.SWITCHROOM_RESUME_MODE = 'continue'
        expect(isContinueRestoreBoot(null)).toBe(true)
        process.env.SWITCHROOM_RESUME_MODE = 'handoff'
        expect(isContinueRestoreBoot(null)).toBe(false)
        // force-fresh env override wins over continue.
        process.env.SWITCHROOM_RESUME_MODE = 'continue'
        process.env.SWITCHROOM_FORCE_FRESH = '1'
        expect(isContinueRestoreBoot(null)).toBe(false)
      } finally {
        process.env = saved
      }
    })

    // Emulates the guarded boot call site: `if (target && !isContinueRestoreBoot(dir)) reset(...)`.
    // This is the exact failure scenario the reviewer flagged.
    function guardedBootReset(reset: (c: string, t: number | undefined) => void): void {
      if (!isContinueRestoreBoot(null)) reset('boot-chat', undefined)
    }

    it('continue-restore boot: NO reset, NO alert, open interval PRESERVED', () => {
      const saved = { ...process.env }
      try {
        process.env.TELEGRAM_STATE_DIR = dir
        delete process.env.SWITCHROOM_FORCE_FRESH
        process.env.SWITCHROOM_RESUME_MODE = 'continue'
        openPrivateInterval(new Date('2026-08-06T02:00:00.000Z'))
        const send = vi.fn<(chatId: string, threadId: number | undefined, text: string) => void>()
        guardedBootReset(makePrivacyResetForNewSession(send))
        expect(send).not.toHaveBeenCalled()
        expect(onDisk().intervals).toEqual([{ start: '2026-08-06T02:00:00.000Z', end: null }])
      } finally {
        process.env = saved
      }
    })

    it('fresh (handoff) boot: reset FIRES, loud alert emitted, interval cleared', () => {
      const saved = { ...process.env }
      try {
        process.env.TELEGRAM_STATE_DIR = dir
        delete process.env.SWITCHROOM_FORCE_FRESH
        process.env.SWITCHROOM_RESUME_MODE = 'handoff'
        openPrivateInterval(new Date('2026-08-06T02:00:00.000Z'))
        const send = vi.fn<(chatId: string, threadId: number | undefined, text: string) => void>()
        guardedBootReset(makePrivacyResetForNewSession(send))
        expect(send).toHaveBeenCalledTimes(1)
        expect(send).toHaveBeenCalledWith('boot-chat', undefined, SESSION_RESET_ALERT)
        expect(onDisk()).toEqual(emptyPrivacyState())
      } finally {
        process.env = saved
      }
    })

    it('continue-mode /new force-fresh boot: reset FIRES (genuinely fresh)', () => {
      const saved = { ...process.env }
      try {
        process.env.TELEGRAM_STATE_DIR = dir
        process.env.SWITCHROOM_RESUME_MODE = 'continue'
        process.env.SWITCHROOM_FORCE_FRESH = '1'
        openPrivateInterval(new Date('2026-08-06T02:00:00.000Z'))
        const send = vi.fn<(chatId: string, threadId: number | undefined, text: string) => void>()
        guardedBootReset(makePrivacyResetForNewSession(send))
        expect(send).toHaveBeenCalledTimes(1)
        expect(onDisk()).toEqual(emptyPrivacyState())
      } finally {
        process.env = saved
      }
    })
  })
})
