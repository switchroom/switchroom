/**
 * Unit tests for the turn-active marker (#412 fix). The marker file
 * exists exactly during in-flight turns; the bash watchdog reads its
 * mtime to distinguish "wedged mid-turn" from "healthy idle".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TURN_ACTIVE_MARKER_FILE,
  writeTurnActiveMarker,
  touchTurnActiveMarker,
  removeTurnActiveMarker,
} from '../gateway/turn-active-marker.js'

describe('turn-active-marker (#412)', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'turn-active-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('writeTurnActiveMarker creates a JSON file with the expected payload', () => {
    writeTurnActiveMarker(tmp, {
      turnKey: 'chat:1:1700000000000',
      chatId: 'chat',
      threadId: null,
      startedAt: 1700000000000,
    })
    const path = join(tmp, TURN_ACTIVE_MARKER_FILE)
    expect(existsSync(path)).toBe(true)
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    expect(parsed.turnKey).toBe('chat:1:1700000000000')
    expect(parsed.chatId).toBe('chat')
    expect(parsed.startedAt).toBe(1700000000000)
  })

  it('writeTurnActiveMarker is idempotent (overwrites existing)', () => {
    writeTurnActiveMarker(tmp, {
      turnKey: 'k1',
      chatId: 'c',
      threadId: null,
      startedAt: 1,
    })
    writeTurnActiveMarker(tmp, {
      turnKey: 'k2',
      chatId: 'c',
      threadId: null,
      startedAt: 2,
    })
    const parsed = JSON.parse(readFileSync(join(tmp, TURN_ACTIVE_MARKER_FILE), 'utf-8'))
    expect(parsed.turnKey).toBe('k2')
  })

  it('touchTurnActiveMarker bumps the mtime', async () => {
    writeTurnActiveMarker(tmp, {
      turnKey: 'k',
      chatId: 'c',
      threadId: null,
      startedAt: 1,
    })
    const path = join(tmp, TURN_ACTIVE_MARKER_FILE)
    // Force the mtime to 5 minutes in the past so the touch is visible.
    const past = new Date(Date.now() - 5 * 60 * 1000)
    utimesSync(path, past, past)
    const before = statSync(path).mtimeMs

    touchTurnActiveMarker(tmp)
    const after = statSync(path).mtimeMs
    expect(after).toBeGreaterThan(before)
  })

  it('touchTurnActiveMarker is a no-op when no marker exists', () => {
    // Must not throw, must not create the file.
    touchTurnActiveMarker(tmp)
    expect(existsSync(join(tmp, TURN_ACTIVE_MARKER_FILE))).toBe(false)
  })

  it('removeTurnActiveMarker deletes the file', () => {
    writeTurnActiveMarker(tmp, {
      turnKey: 'k',
      chatId: 'c',
      threadId: null,
      startedAt: 1,
    })
    const path = join(tmp, TURN_ACTIVE_MARKER_FILE)
    expect(existsSync(path)).toBe(true)
    removeTurnActiveMarker(tmp)
    expect(existsSync(path)).toBe(false)
  })

  it('removeTurnActiveMarker is idempotent (no throw on missing file)', () => {
    expect(() => removeTurnActiveMarker(tmp)).not.toThrow()
    expect(() => removeTurnActiveMarker(tmp)).not.toThrow()
  })

  it('writeTurnActiveMarker creates the state dir if missing', () => {
    const fresh = join(tmp, 'fresh', 'subdir')
    writeTurnActiveMarker(fresh, {
      turnKey: 'k',
      chatId: 'c',
      threadId: null,
      startedAt: 1,
    })
    expect(existsSync(join(fresh, TURN_ACTIVE_MARKER_FILE))).toBe(true)
  })

  it('writes mode 0600 (operator-only readable)', () => {
    writeTurnActiveMarker(tmp, {
      turnKey: 'k',
      chatId: 'c',
      threadId: null,
      startedAt: 1,
    })
    const path = join(tmp, TURN_ACTIVE_MARKER_FILE)
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
  })
})
