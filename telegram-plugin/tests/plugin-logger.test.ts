import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  installPluginLogger,
  resolveLogPath,
  _resetForTests,
} from '../plugin-logger.js'

let tmpDir: string
let logPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'plugin-logger-'))
  logPath = join(tmpDir, 'nested', 'subdir', 'telegram-plugin.log')
  process.env.SWITCHROOM_TELEGRAM_LOG_PATH = logPath
  _resetForTests()
})

afterEach(() => {
  _resetForTests()
  delete process.env.SWITCHROOM_TELEGRAM_LOG_PATH
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('resolveLogPath', () => {
  it('uses SWITCHROOM_TELEGRAM_LOG_PATH when set', () => {
    expect(resolveLogPath({ SWITCHROOM_TELEGRAM_LOG_PATH: '/tmp/custom.log' })).toBe(
      '/tmp/custom.log',
    )
  })

  it('falls back to a path under ~/.switchroom/logs when env is unset', () => {
    const out = resolveLogPath({})
    expect(out).toMatch(/\.switchroom\/logs\/telegram-plugin\.log$/)
  })
})

describe('installPluginLogger — stderr interception', () => {
  it('creates the log directory if missing', () => {
    installPluginLogger()
    process.stderr.write('telegram channel: boot\n')
    expect(existsSync(logPath)).toBe(true)
  })

  it('appends every stderr.write call to the logfile', () => {
    installPluginLogger()
    process.stderr.write('telegram channel: line one\n')
    process.stderr.write('[streaming-metrics] {"kind":"x"}\n')
    process.stderr.write('stream → edit failed: whatever\n')
    const contents = readFileSync(logPath, 'utf8')
    expect(contents).toContain('telegram channel: line one')
    expect(contents).toContain('[streaming-metrics]')
    expect(contents).toContain('stream → edit failed')
  })

  it('forwards to the original stderr (behavior unchanged for other readers)', () => {
    // We can't easily observe bun's real stderr, but we can verify the
    // wrapped writer returns a boolean like the original does.
    installPluginLogger()
    const result = process.stderr.write('probe\n')
    expect(typeof result).toBe('boolean')
  })

  it('uninstall() restores the original writer and stops capturing', () => {
    const handle = installPluginLogger()
    process.stderr.write('before\n')
    handle.uninstall()
    process.stderr.write('after\n')
    const contents = readFileSync(logPath, 'utf8')
    expect(contents).toContain('before')
    expect(contents).not.toContain('after')
  })

  it('is idempotent — second install returns the first handle', () => {
    const a = installPluginLogger()
    const b = installPluginLogger()
    expect(b).toBe(a)
  })

  it('accepts Uint8Array chunks and decodes them to utf8 in the file', () => {
    installPluginLogger()
    const encoder = new TextEncoder()
    process.stderr.write(encoder.encode('binary-path: ok\n'))
    const contents = readFileSync(logPath, 'utf8')
    expect(contents).toContain('binary-path: ok')
  })

  it('swallows filesystem errors and never throws from stderr.write', () => {
    // Point at an unwritable path (a file that cannot become a directory).
    process.env.SWITCHROOM_TELEGRAM_LOG_PATH = '/proc/1/cannot-write-here.log'
    _resetForTests()
    installPluginLogger()
    expect(() => process.stderr.write('still ok\n')).not.toThrow()
  })
})
