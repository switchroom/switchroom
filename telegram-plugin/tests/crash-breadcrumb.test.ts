/**
 * Pins the #3033 bridge crash-breadcrumb contract: uncaughtException /
 * unhandledRejection in the bridge process persist a bounded, greppable
 * line to bridge-crash.log (Claude Code drops MCP stderr after startup,
 * so this file is the only durable trace of why a bridge died).
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendCrashBreadcrumb } from '../bridge/crash-breadcrumb.js'

function tmpLog(): string {
  return join(mkdtempSync(join(tmpdir(), 'crash-bc-')), 'bridge-crash.log')
}

describe('appendCrashBreadcrumb', () => {
  it('appends a single line with kind, pid and folded stack', () => {
    const log = tmpLog()
    const err = new Error('boom')
    appendCrashBreadcrumb(log, 'uncaughtException', err, new Date('2026-07-11T01:40:59Z'))
    const content = readFileSync(log, 'utf8')
    const lines = content.trimEnd().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('2026-07-11T01:40:59')
    expect(lines[0]).toContain('uncaughtException')
    expect(lines[0]).toContain(`pid=${process.pid}`)
    expect(lines[0]).toContain('Error: boom')
    expect(lines[0]).not.toContain('\n')
  })

  it('handles non-Error rejections and appends across calls', () => {
    const log = tmpLog()
    appendCrashBreadcrumb(log, 'unhandledRejection', 'string reason')
    appendCrashBreadcrumb(log, 'unhandledRejection', { odd: true })
    const lines = readFileSync(log, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('string reason')
  })

  it('rotates once past the size cap instead of growing unbounded', () => {
    const log = tmpLog()
    writeFileSync(log, 'x'.repeat(1024 * 1024 + 1))
    appendCrashBreadcrumb(log, 'uncaughtException', new Error('after rotation'))
    expect(existsSync(`${log}.1`)).toBe(true)
    const content = readFileSync(log, 'utf8')
    expect(content).toContain('after rotation')
    expect(content.length).toBeLessThan(5000)
  })

  it('never throws when the path is unwritable', () => {
    expect(() =>
      appendCrashBreadcrumb('/nonexistent-dir-xyz/bridge-crash.log', 'uncaughtException', new Error('x')),
    ).not.toThrow()
  })
})
