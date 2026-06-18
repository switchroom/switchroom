/**
 * Unit tests for probeConnections — the boot-card surface for
 * configured-but-unauthed MCP connections (P3). The probe only READS the
 * host-computed snapshot at <agentDir>/.claude/connection-health.json, so
 * we drive it with an injected readFileImpl (no fs / no broker).
 */

import { describe, it, expect } from 'bun:test'
import { probeConnections } from '../gateway/boot-probes.js'

const ENOENT = () => {
  const e = new Error('ENOENT') as NodeJS.ErrnoException
  e.code = 'ENOENT'
  throw e
}

describe('probeConnections', () => {
  it('OK (silent) when the snapshot file is absent — assume healthy', async () => {
    const r = await probeConnections('/agent', { readFileImpl: ENOENT })
    expect(r.status).toBe('ok')
  })

  it('OK when the snapshot is malformed JSON', async () => {
    const r = await probeConnections('/agent', { readFileImpl: () => 'not json{' })
    expect(r.status).toBe('ok')
  })

  it('OK when there are zero issues', async () => {
    const r = await probeConnections('/agent', {
      readFileImpl: () => JSON.stringify({ computedAt: 1, issues: [] }),
    })
    expect(r.status).toBe('ok')
    expect(r.detail).toContain('all authed')
  })

  it('DEGRADED (never fail) with named servers + a fix when connections are unauthed', async () => {
    const snapshot = {
      computedAt: 1,
      issues: [
        { server: 'meta', key: 'meta/token', kind: 'missing', detail: 'x', fix: 'switchroom vault set meta/token --allow marko' },
        { server: 'postiz', key: 'postiz/key', kind: 'missing', detail: 'y', fix: 'switchroom vault set postiz/key --allow marko' },
      ],
    }
    const r = await probeConnections('/agent', { readFileImpl: () => JSON.stringify(snapshot) })
    expect(r.status).toBe('degraded')
    expect(r.detail).toContain('2 integration(s)')
    expect(r.detail).toContain('meta')
    expect(r.detail).toContain('postiz')
    // nextStep carries the first fix + a pointer to doctor for the rest.
    expect(r.nextStep).toContain('switchroom vault set meta/token')
    expect(r.nextStep).toContain('+1 more')
  })

  it('dedupes servers in the detail count', async () => {
    const snapshot = {
      computedAt: 1,
      issues: [
        { server: 'meta', key: 'meta/a', kind: 'missing', detail: 'x', fix: 'fixa' },
        { server: 'meta', key: 'meta/b', kind: 'acl', detail: 'y', fix: 'fixb' },
      ],
    }
    const r = await probeConnections('/agent', { readFileImpl: () => JSON.stringify(snapshot) })
    expect(r.status).toBe('degraded')
    expect(r.detail).toContain('1 integration(s)')
  })
})
