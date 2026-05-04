/**
 * PR-C2 — sweepActivePins must recover gracefully from a malformed
 * sidecar file written by a prior crash mid-write.
 *
 * Two scenarios:
 *   (a) JSON-truncated file — readActivePins falls back to [] and the
 *       sweep is a no-op without throwing.
 *   (b) Mixed valid/invalid entries inside a parseable JSON array —
 *       readActivePins drops the invalid entries and processes the
 *       valid ones.
 *
 * fails when: readActivePins is changed to throw on malformed JSON,
 * OR the per-entry validator is loosened so a malformed object slips
 * through and crashes the unpin loop.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACTIVE_PINS_FILENAME } from '../active-pins.js'
import { sweepActivePins } from '../active-pins-sweep.js'

describe('PR-C2: sweepActivePins recovers from a malformed sidecar', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pin-sidecar-partial-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('truncated JSON array: sweep is a clean no-op (no throw, no calls)', async () => {
    // Simulate a crash mid-write: a JSON array prefix that never closed.
    writeFileSync(
      join(dir, ACTIVE_PINS_FILENAME),
      '[{"chatId":"A","messageId":1,"turnKey":"A:0:1","pinnedAt":17',
    )

    const calls: Array<[string, number]> = []
    const logs: string[] = []
    const result = await sweepActivePins(
      dir,
      async (chatId, messageId) => { calls.push([chatId, messageId]) },
      { log: (m) => logs.push(m) },
    )
    expect(calls).toEqual([])
    expect(result.swept).toEqual([])
    expect(result.timedOut).toBe(false)
  })

  it('mixed valid/invalid entries: valid ones still get processed', async () => {
    const blob = JSON.stringify([
      { chatId: 'A', messageId: 1, turnKey: 'A:0:1', pinnedAt: 1700000000000 }, // valid
      { chatId: 42, messageId: 'oops', turnKey: 'B:0:1', pinnedAt: 0 },          // invalid (wrong types)
      null,                                                                       // invalid
      { chatId: 'C', messageId: 3, turnKey: 'C:0:1', pinnedAt: 1700000000001 }, // valid
      'garbage',                                                                  // invalid
    ])
    writeFileSync(join(dir, ACTIVE_PINS_FILENAME), blob)

    const calls: Array<[string, number]> = []
    await sweepActivePins(dir, async (c, m) => { calls.push([c, m]) })
    expect(calls.sort()).toEqual([
      ['A', 1],
      ['C', 3],
    ])
  })
})
