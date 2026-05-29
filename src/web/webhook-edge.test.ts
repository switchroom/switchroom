/**
 * Tests for the Cloudflare-only edge lock primitives (Phase 2).
 * Uses vitest + tmpdir for file I/O isolation.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EDGE_HEADER, loadEdgeSecret, verifyEdgeHeader } from './webhook-edge.js'

function tmpFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'webhook-edge-'))
  const p = join(dir, 'webhook-edge-secret')
  writeFileSync(p, contents, { mode: 0o600 })
  return p
}

describe('EDGE_HEADER', () => {
  it('is lower-cased for case-insensitive Headers.get lookups', () => {
    expect(EDGE_HEADER).toBe('x-switchroom-edge')
  })
})

describe('loadEdgeSecret', () => {
  it('returns the trimmed secret when the file exists', () => {
    const p = tmpFile('super-secret-value\n')
    expect(loadEdgeSecret(p)).toBe('super-secret-value')
  })

  it('returns null when the file is missing', () => {
    expect(loadEdgeSecret(join(tmpdir(), 'does-not-exist-' + Math.random()))).toBeNull()
  })

  it('returns null when the file is empty / whitespace only', () => {
    expect(loadEdgeSecret(tmpFile(''))).toBeNull()
    expect(loadEdgeSecret(tmpFile('   \n  '))).toBeNull()
  })
})

describe('verifyEdgeHeader', () => {
  it('accepts a matching header', () => {
    expect(verifyEdgeHeader('s3cr3t', 's3cr3t')).toBe(true)
  })

  it('rejects a mismatched header', () => {
    expect(verifyEdgeHeader('wrong', 's3cr3t')).toBe(false)
  })

  it('rejects a length-mismatched header without throwing', () => {
    expect(verifyEdgeHeader('short', 'a-much-longer-secret')).toBe(false)
  })

  it('rejects when the header is null/undefined/empty', () => {
    expect(verifyEdgeHeader(null, 's3cr3t')).toBe(false)
    expect(verifyEdgeHeader(undefined, 's3cr3t')).toBe(false)
    expect(verifyEdgeHeader('', 's3cr3t')).toBe(false)
  })

  it('rejects when the expected secret is null (fail-closed)', () => {
    expect(verifyEdgeHeader('anything', null)).toBe(false)
  })
})
