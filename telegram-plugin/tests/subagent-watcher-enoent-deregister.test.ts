/**
 * Tests for the readSubTail ENOENT/EACCES deregister path.
 *
 * Production symptom: clerk agent's gateway-supervisor.log was growing
 * at ~30 ENOENT lines/sec sustained (540k+ in 3 days) because the
 * watcher's poll loop kept statx-ing JSONL files Claude Code had
 * already reaped along with the parent session's `subagents/` dir.
 * Same shape on klanker with EACCES (635 events) — likely a perm
 * flip during cleanup.
 *
 * Fix shape: when readSubTail's statSync throws ENOENT or EACCES,
 * log ONE line + invoke the onFileVanished callback so the watcher
 * factory can call cleanupTerminalAgent and stop polling. Other
 * errors (parse, malformed JSONL) keep the legacy per-poll log line.
 */

import { describe, it, expect, vi } from 'vitest'
import { readSubTail } from '../subagent-watcher.js'
import type { WorkerEntry } from '../subagent-watcher.js'

function fakeFsThrowingFromStat(code: 'ENOENT' | 'EACCES' | 'EOTHER') {
  const err = new Error(`fake ${code}`) as NodeJS.ErrnoException
  err.code = code
  return {
    existsSync: () => true,
    readdirSync: () => [],
    statSync: () => { throw err },
    openSync: () => -1,
    closeSync: () => {},
    readSync: () => 0,
    watch: () => ({ close: () => {} } as ReturnType<typeof require>),
  } as unknown as Parameters<typeof readSubTail>[4]
}

function makeEntry(): WorkerEntry {
  return {
    agentId: 'a1234567890abcdef',
    filePath: '/tmp/fake/agent-a1234567890abcdef.jsonl',
    dispatchedAt: 0,
    lastActivityAt: 0,
    toolCount: 0,
    state: 'running',
    completionNotified: false,
    stallNotified: false,
    historical: false,
    description: '',
    lastSummaryLine: '',
    lastResultText: '',
  }
}

function makeTail() {
  return {
    cursor: 0,
    pendingPartial: '',
    hasEmittedStart: false,
    watcher: null,
  }
}

describe('readSubTail — ENOENT/EACCES deregister', () => {
  it('fires onFileVanished and logs ONCE on ENOENT', () => {
    const onFileVanished = vi.fn()
    const log = vi.fn()
    const entry = makeEntry()

    readSubTail(
      entry,
      makeTail(),
      0,
      vi.fn(),
      fakeFsThrowingFromStat('ENOENT'),
      log,
      null,
      null,
      undefined,
      onFileVanished,
    )

    expect(onFileVanished).toHaveBeenCalledTimes(1)
    expect(onFileVanished).toHaveBeenCalledWith('a1234567890abcdef', 'ENOENT')
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toMatch(/JSONL vanished for a1234567890abcdef \(ENOENT\) — deregistering/)
    expect(log.mock.calls[0][0]).not.toMatch(/read error/)
  })

  it('fires onFileVanished and logs ONCE on EACCES (klanker pattern)', () => {
    const onFileVanished = vi.fn()
    const log = vi.fn()

    readSubTail(
      makeEntry(),
      makeTail(),
      0,
      vi.fn(),
      fakeFsThrowingFromStat('EACCES'),
      log,
      null,
      null,
      undefined,
      onFileVanished,
    )

    expect(onFileVanished).toHaveBeenCalledTimes(1)
    expect(onFileVanished).toHaveBeenCalledWith('a1234567890abcdef', 'EACCES')
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toMatch(/EACCES/)
  })

  it('still logs the legacy "read error" for unexpected error codes', () => {
    // Regression guard: parse errors, EIO, EBUSY, etc. must still
    // surface their detail. Only file-vanished codes are deregistered.
    const onFileVanished = vi.fn()
    const log = vi.fn()

    readSubTail(
      makeEntry(),
      makeTail(),
      0,
      vi.fn(),
      fakeFsThrowingFromStat('EOTHER'),
      log,
      null,
      null,
      undefined,
      onFileVanished,
    )

    expect(onFileVanished).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toMatch(/read error a1234567890abcdef/)
  })

  it('omitting onFileVanished is safe (optional callback)', () => {
    const log = vi.fn()

    expect(() =>
      readSubTail(
        makeEntry(),
        makeTail(),
        0,
        vi.fn(),
        fakeFsThrowingFromStat('ENOENT'),
        log,
        null,
        null,
        undefined,
      ),
    ).not.toThrow()
    expect(log).toHaveBeenCalledTimes(1)
  })
})
