/**
 * Gateway liveness heartbeat writer (duplicate-message fix).
 *
 * The Stop hook's single-writer election only ALLOWS a stop (handing delivery
 * to the gateway) when the gateway heartbeat file is fresh. This pins the
 * writer: it creates the file, bumps its mtime on subsequent touches, and the
 * hook's freshness reader agrees on the filename + bound.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  touchGatewayHeartbeat,
  startGatewayHeartbeat,
  GATEWAY_HEARTBEAT_FILE,
} from '../gateway/gateway-heartbeat.js'
import {
  isGatewayHeartbeatFresh,
  GATEWAY_HEARTBEAT_FILE as HOOK_HEARTBEAT_FILE,
} from '../hooks/silent-end-scan.mjs'

describe('gateway-heartbeat writer', () => {
  it('creates the heartbeat file on first touch under a fresh state dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-hb-w-'))
    try {
      const path = join(dir, GATEWAY_HEARTBEAT_FILE)
      expect(existsSync(path)).toBe(false)
      touchGatewayHeartbeat(dir)
      expect(existsSync(path)).toBe(true)
      // The hook's freshness reader agrees it's fresh.
      expect(isGatewayHeartbeatFresh(dir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refreshes an aged heartbeat back to fresh on a subsequent touch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-hb-w-'))
    try {
      const path = join(dir, GATEWAY_HEARTBEAT_FILE)
      touchGatewayHeartbeat(dir)
      // Backdate the mtime to stale, then touch again → back to fresh.
      const old = new Date(Date.now() - 10 * 60_000)
      utimesSync(path, old, old)
      expect(isGatewayHeartbeatFresh(dir)).toBe(false)
      touchGatewayHeartbeat(dir)
      expect(isGatewayHeartbeatFresh(dir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('startGatewayHeartbeat writes immediately and returns an unref-able timer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-hb-w-'))
    try {
      const timer = startGatewayHeartbeat(dir, 60_000)
      expect(existsSync(join(dir, GATEWAY_HEARTBEAT_FILE))).toBe(true)
      clearInterval(timer)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the writer filename and the hook reader filename are identical (no drift)', () => {
    expect(GATEWAY_HEARTBEAT_FILE).toBe(HOOK_HEARTBEAT_FILE)
    expect(GATEWAY_HEARTBEAT_FILE).toBe('gateway-heartbeat')
  })
})
