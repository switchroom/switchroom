/**
 * Integration test for the Stage B crux false-positive protection (review
 * Finding C).
 *
 * The pure `decideHangRestart` tests pass `markerAgeMs` as a literal. This
 * test proves the REAL chain end-to-end on a real marker file:
 *
 *   sub-agent JSONL growth → touchTurnActiveMarker (the exact call the
 *   subagent-watcher makes at subagent-watcher.ts:1324) → readTurnActiveMarkerAgeMs
 *   yields a SMALL age → decideHangRestart does NOT restart.
 *
 * i.e. a genuinely-working long turn (its only liveness being sub-agent output)
 * is protected against the hang-restart, not just in the abstract.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  writeTurnActiveMarker,
  touchTurnActiveMarker,
  readTurnActiveMarkerAgeMs,
  removeTurnActiveMarker,
  TURN_ACTIVE_MARKER_FILE,
} from '../gateway/turn-active-marker.js'
import { decideHangRestart, DEFAULT_HANG_STALENESS_MS } from '../gateway/hang-restart-decision.js'

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'hang-marker-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('Stage B marker integration — healthy long turn is protected end-to-end', () => {
  it('sub-agent JSONL growth touches the marker → small age → NOT restarted', () => {
    const dir = tempDir()
    writeTurnActiveMarker(dir, { turnKey: 't1', chatId: '123', startedAt: Date.now() })
    const path = join(dir, TURN_ACTIVE_MARKER_FILE)

    // Simulate a turn that has been running long with NO interim tool_use —
    // force the marker mtime stale (15 min old). Without a progress touch this
    // would read as a hang.
    const now = Date.now()
    const staleTime = new Date(now - 900_000)
    utimesSync(path, staleTime, staleTime)
    const staleAge = readTurnActiveMarkerAgeMs(dir, now)
    expect(staleAge).not.toBeNull()
    expect(staleAge!).toBeGreaterThanOrEqual(DEFAULT_HANG_STALENESS_MS)

    // Now the sub-agent produces output: the watcher touches the marker (this
    // is the exact call at subagent-watcher.ts:1324). The mtime advances.
    touchTurnActiveMarker(dir)
    const freshAge = readTurnActiveMarkerAgeMs(dir)
    expect(freshAge).not.toBeNull()
    expect(freshAge!).toBeLessThan(5_000) // touched just now → small age

    // Fed through the real decision with a NON-protected in-flight tool (so the
    // only thing keeping it alive is the fresh marker), it must NOT restart.
    const d = decideHangRestart({
      inFlightToolNames: ['some_mcp_query'],
      markerAgeMs: freshAge,
      stalenessThresholdMs: DEFAULT_HANG_STALENESS_MS,
    })
    expect(d.restart).toBe(false)
    expect(d.reason).toBe('marker-advancing')
  })

  it('with no touch, the stale marker + non-protected tool DOES restart (control)', () => {
    const dir = tempDir()
    writeTurnActiveMarker(dir, { turnKey: 't2', chatId: '123', startedAt: Date.now() })
    const path = join(dir, TURN_ACTIVE_MARKER_FILE)
    const now = Date.now()
    const staleTime = new Date(now - 900_000)
    utimesSync(path, staleTime, staleTime)

    const age = readTurnActiveMarkerAgeMs(dir, now)
    const d = decideHangRestart({
      inFlightToolNames: ['some_mcp_query'],
      markerAgeMs: age,
      stalenessThresholdMs: DEFAULT_HANG_STALENESS_MS,
    })
    expect(d.restart).toBe(true)
    expect(d.reason).toBe('mid-tool-marker-stale')
  })

  it('readTurnActiveMarkerAgeMs is null once the marker is removed', () => {
    const dir = tempDir()
    writeTurnActiveMarker(dir, { turnKey: 't3', chatId: '1', startedAt: Date.now() })
    expect(statSync(join(dir, TURN_ACTIVE_MARKER_FILE)).isFile()).toBe(true)
    removeTurnActiveMarker(dir)
    expect(readTurnActiveMarkerAgeMs(dir)).toBeNull()
  })
})
