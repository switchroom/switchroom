import { describe, it, expect, afterEach, vi } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  captureSpeechText,
  SPEECH_CAPTURE_FILE_NAME,
  __resetSpeechCaptureLogStateForTests,
} from '../gateway/speech-capture.js'

/**
 * PR-0 (`/tmp/claude-0/tts/out/fable-plan-v2.md` §9): flag-gated raw-markdown
 * capture hook. Every test here points at an explicit `stateDir` override —
 * never at `process.env.TELEGRAM_STATE_DIR` — so nothing in this suite can
 * touch a live agent's state tree (`TELEGRAM_STATE_DIR` is not covered by the
 * repo's agent-state-dir hermeticity guard, see
 * `tests/vitest-setup/agent-state-dir-guard-core.mjs`).
 *
 * The integration-level guarantees (a write failure never breaks the REAL
 * `sendReply`; the captured string IS the exact `resolveVoiceOutPlan`
 * argument, not merely textually adjacent) are pinned separately in
 * `send-reply-golden.test.ts`, driven through the real wiring — this file
 * covers the module's own contract in isolation.
 */
describe('captureSpeechText', () => {
  const dirs: string[] = []
  function freshDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'speech-capture-test-'))
    dirs.push(d)
    return d
  }

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true })
    }
    __resetSpeechCaptureLogStateForTests()
  })

  it('flag off (explicit enabled:false) writes nothing — true no-op', () => {
    const stateDir = freshDir()
    captureSpeechText('hello world', { enabled: false, stateDir })
    expect(existsSync(join(stateDir, SPEECH_CAPTURE_FILE_NAME))).toBe(false)
  })

  it('flag off via env (SWITCHROOM_SPEECH_CAPTURE unset) writes nothing', () => {
    const stateDir = freshDir()
    const prior = process.env.SWITCHROOM_SPEECH_CAPTURE
    delete process.env.SWITCHROOM_SPEECH_CAPTURE
    try {
      captureSpeechText('hello world', { stateDir })
      expect(existsSync(join(stateDir, SPEECH_CAPTURE_FILE_NAME))).toBe(false)
    } finally {
      if (prior === undefined) delete process.env.SWITCHROOM_SPEECH_CAPTURE
      else process.env.SWITCHROOM_SPEECH_CAPTURE = prior
    }
  })

  it('flag off: never touches the filesystem, even with a garbage stateDir', () => {
    // Negligible-cost proof: an unwritable/garbage destination must not
    // surface any error or side effect when the flag is off — the function
    // should return before touching fs at all.
    expect(() => captureSpeechText('x', {
      enabled: false,
      stateDir: '/definitely/does/not/exist/\0bad',
    })).not.toThrow()
  })

  it('M1: flag accepts "1"', () => {
    const stateDir = freshDir()
    const prior = process.env.SWITCHROOM_SPEECH_CAPTURE
    process.env.SWITCHROOM_SPEECH_CAPTURE = '1'
    try {
      captureSpeechText('x', { stateDir })
      expect(existsSync(join(stateDir, SPEECH_CAPTURE_FILE_NAME))).toBe(true)
    } finally {
      if (prior === undefined) delete process.env.SWITCHROOM_SPEECH_CAPTURE
      else process.env.SWITCHROOM_SPEECH_CAPTURE = prior
    }
  })

  it('M1: flag accepts "true" (text-voice-scrub.ts:102 convention) — not silently a no-op', () => {
    const stateDir = freshDir()
    const prior = process.env.SWITCHROOM_SPEECH_CAPTURE
    process.env.SWITCHROOM_SPEECH_CAPTURE = 'true'
    try {
      captureSpeechText('x', { stateDir })
      expect(existsSync(join(stateDir, SPEECH_CAPTURE_FILE_NAME))).toBe(true)
    } finally {
      if (prior === undefined) delete process.env.SWITCHROOM_SPEECH_CAPTURE
      else process.env.SWITCHROOM_SPEECH_CAPTURE = prior
    }
  })

  it('flag on appends the exact string, byte-for-byte, including a table, a fenced code block, an emoji, and inline backticks', () => {
    const stateDir = freshDir()
    const raw = [
      '# Heading',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '```ts',
      'const x = 1 | 2',
      '```',
      '',
      'Status: ✅ done, use `inline code` with a pipe | here, and an emoji 😀.',
    ].join('\n')
    captureSpeechText(raw, { enabled: true, stateDir, now: () => 1234567890 })
    const filePath = join(stateDir, SPEECH_CAPTURE_FILE_NAME)
    expect(existsSync(filePath)).toBe(true)
    const contents = readFileSync(filePath, 'utf8')
    const lines = contents.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]) as { ts: number; text: string }
    expect(parsed.ts).toBe(1234567890)
    // Byte-for-byte: exact equality, not a fuzzy/normalized comparison.
    expect(parsed.text).toBe(raw)
    // Explicitly pin the bytes the redesign depends on surviving capture.
    expect(parsed.text).toContain('| A | B |')
    expect(parsed.text).toContain('```ts')
    expect(parsed.text).toContain('`inline code`')
    expect(parsed.text).toContain('✅')
    expect(parsed.text).toContain('😀')
  })

  it('flag on preserves a lone (unpaired) surrogate byte-for-byte through the JSON round-trip', () => {
    const stateDir = freshDir()
    // A lone high surrogate with no low-surrogate partner — the kind of
    // malformed-but-real string content a JS string can hold (e.g. a
    // truncated emoji from an upstream mangling) that a naive re-encoding
    // pass can silently mutate or drop.
    const raw = 'before \uD800 after'
    captureSpeechText(raw, { enabled: true, stateDir, now: () => 1 })
    const filePath = join(stateDir, SPEECH_CAPTURE_FILE_NAME)
    const line = readFileSync(filePath, 'utf8').split('\n').filter((l) => l.length > 0)[0]!
    const parsed = JSON.parse(line) as { ts: number; text: string }
    expect(parsed.text).toBe(raw)
    expect(parsed.text.charCodeAt(parsed.text.indexOf('\uD800'))).toBe(0xd800)
  })

  it('flag on appends one JSON line per call, in order', () => {
    const stateDir = freshDir()
    captureSpeechText('first', { enabled: true, stateDir, now: () => 1 })
    captureSpeechText('second', { enabled: true, stateDir, now: () => 2 })
    const filePath = join(stateDir, SPEECH_CAPTURE_FILE_NAME)
    const lines = readFileSync(filePath, 'utf8').split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual({ ts: 1, text: 'first' })
    expect(JSON.parse(lines[1])).toEqual({ ts: 2, text: 'second' })
  })

  it('flag on but stateDir unresolved (no TELEGRAM_STATE_DIR, no override) writes nothing and does not throw', () => {
    const prior = process.env.TELEGRAM_STATE_DIR
    delete process.env.TELEGRAM_STATE_DIR
    try {
      expect(() => captureSpeechText('x', { enabled: true })).not.toThrow()
    } finally {
      if (prior === undefined) delete process.env.TELEGRAM_STATE_DIR
      else process.env.TELEGRAM_STATE_DIR = prior
    }
  })

  it('B1: the capture file is created 0o600 (owner-only), not the umask default', () => {
    const stateDir = freshDir()
    captureSpeechText('x', { enabled: true, stateDir })
    const filePath = join(stateDir, SPEECH_CAPTURE_FILE_NAME)
    const mode = statSync(filePath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('B1: mode stays 0o600 across repeated appends to an already-created file', () => {
    const stateDir = freshDir()
    captureSpeechText('first', { enabled: true, stateDir })
    // Second call appends to the now-existing file; mode must not have been
    // relaxed by any subsequent create-mode default.
    captureSpeechText('second', { enabled: true, stateDir })
    const filePath = join(stateDir, SPEECH_CAPTURE_FILE_NAME)
    const mode = statSync(filePath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('B1/no dead mkdir: a stateDir that does not exist is a swallowed write failure, not silently created', () => {
    // The prior implementation's `mkdirSync(stateDir, {recursive:true, mode:
    // 0o700})` protected nothing in production (TELEGRAM_STATE_DIR always
    // pre-exists) and is gone; a genuinely-missing dir now fails the write
    // (ENOENT) exactly like any other write-failure shape, swallowed.
    const parent = freshDir()
    const missing = join(parent, 'does', 'not', 'exist')
    expect(() => captureSpeechText('x', { enabled: true, stateDir: missing })).not.toThrow()
    expect(existsSync(missing)).toBe(false)
  })

  it('a write error (destination path collides with a file, not a dir) does not throw', () => {
    const parent = freshDir()
    const stateDir = join(parent, 'not-a-directory')
    writeFileSync(stateDir, 'not a directory')
    expect(() => captureSpeechText('should not throw', { enabled: true, stateDir })).not.toThrow()
    expect(existsSync(join(stateDir, SPEECH_CAPTURE_FILE_NAME))).toBe(false)
  })

  it('a write error into a read-only directory does not throw', () => {
    const stateDir = freshDir()
    mkdirSync(stateDir, { recursive: true })
    const originalMode = 0o755
    try {
      // Some sandboxes ignore chmod as non-root; this test still asserts the
      // no-throw contract either way, it just may not exercise the EACCES
      // path when running as root.
      chmodSync(stateDir, 0o500)
      expect(() => captureSpeechText('x', { enabled: true, stateDir })).not.toThrow()
    } finally {
      chmodSync(stateDir, originalMode)
    }
  })

  describe('M2: observability — never silent for the full 7-day window', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('logs one stderr line the first time capture actually fires, not on every call', () => {
      const stateDir = freshDir()
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      try {
        captureSpeechText('first', { enabled: true, stateDir })
        captureSpeechText('second', { enabled: true, stateDir })
        captureSpeechText('third', { enabled: true, stateDir })
        const enableLines = spy.mock.calls.filter((c) => String(c[0]).includes('speech-capture: enabled'))
        expect(enableLines).toHaveLength(1)
      } finally {
        spy.mockRestore()
      }
    })

    it('does not log the "enabled" line when the flag is off', () => {
      const stateDir = freshDir()
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      try {
        captureSpeechText('x', { enabled: false, stateDir })
        const enableLines = spy.mock.calls.filter((c) => String(c[0]).includes('speech-capture: enabled'))
        expect(enableLines).toHaveLength(0)
      } finally {
        spy.mockRestore()
      }
    })

    it('logs a write-failure line on the first failure, then rate-limits further failures', () => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      const parent = freshDir()
      const stateDir = join(parent, 'not-a-directory')
      writeFileSync(stateDir, 'not a directory')
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      try {
        captureSpeechText('one', { enabled: true, stateDir })
        captureSpeechText('two', { enabled: true, stateDir })
        vi.setSystemTime(1000) // 1s later — still inside the rate-limit window
        captureSpeechText('three', { enabled: true, stateDir })
        const failLines = spy.mock.calls.filter((c) => String(c[0]).includes('speech-capture: write failed'))
        expect(failLines).toHaveLength(1)

        vi.setSystemTime(6 * 60_000) // past the 5-minute window
        captureSpeechText('four', { enabled: true, stateDir })
        const failLinesAfter = spy.mock.calls.filter((c) => String(c[0]).includes('speech-capture: write failed'))
        expect(failLinesAfter).toHaveLength(2)
      } finally {
        spy.mockRestore()
      }
    })
  })
})
