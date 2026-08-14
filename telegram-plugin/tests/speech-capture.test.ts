import { describe, it, expect, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureSpeechText, SPEECH_CAPTURE_FILE_NAME } from '../gateway/speech-capture.js'

/**
 * PR-0 (`/tmp/claude-0/tts/out/fable-plan-v2.md` §9): flag-gated raw-markdown
 * capture hook. Every test here points at an explicit `stateDir` override —
 * never at `process.env.TELEGRAM_STATE_DIR` — so nothing in this suite can
 * touch a live agent's state tree (`TELEGRAM_STATE_DIR` is not covered by the
 * repo's agent-state-dir hermeticity guard, see
 * `tests/vitest-setup/agent-state-dir-guard-core.mjs`).
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

  it('a write error (destination path collides with a file, not a dir) does not throw', () => {
    const parent = freshDir()
    // Make `stateDir` itself a FILE, so mkdirSync/appendFileSync both fail
    // with ENOTDIR — the exact swallow path the spec requires.
    const stateDir = join(parent, 'not-a-directory')
    writeFileSync(stateDir, 'not a directory')
    expect(() => captureSpeechText('should not throw', { enabled: true, stateDir })).not.toThrow()
    // And confirm no file materialized at the (impossible) capture path.
    expect(existsSync(join(stateDir, SPEECH_CAPTURE_FILE_NAME))).toBe(false)
  })

  it('a write error into a read-only directory does not throw', () => {
    const stateDir = freshDir()
    mkdirSync(stateDir, { recursive: true })
    // Deny write access; appendFileSync should throw internally and be
    // swallowed, never propagating to the caller (the send path).
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
})
