/**
 * Unit tests for `defaultVaultWritePosture` — the posture-attested
 * vault write helper introduced by the #1115 follow-up.
 *
 * Contract pinned here:
 *   - Returns `{ ok: true, output }` on broker `kind: 'ok'`.
 *   - Returns `{ ok: false, output: <marker>: <msg> }` on each broker
 *     failure shape (unreachable / denied / not_found), with markers
 *     that the gateway's `parseVaultCliError` / `renderVaultCliError`
 *     stack can recognize (so failures still render the actionable
 *     host hint instead of a raw blob).
 *   - Forwards `attest_via_posture: true` on the put — the load-
 *     bearing flag the broker server (server.ts:1448-1500) gates on.
 *   - Forwards `kind: 'string'` entry shape verbatim (only kind the
 *     `vault_request_save` MCP tool emits).
 *
 * Test seam: the helper accepts an optional `deps` param so tests
 * inject mock fns directly (no `vi.mock` / `mock.module`). This
 * keeps the test runnable under both vitest AND bun:test without
 * the module-cache cross-pollination that broke an earlier rev.
 */

import { describe, expect, it } from 'vitest'
import { defaultVaultWritePosture } from '../secret-detect/vault-write.js'
import type { PutResult } from '../../src/vault/broker/client.js'

type PutCall = {
  slug: string
  entry: { kind: 'string'; value: string } | { kind: 'binary'; value: string }
  opts: { socket?: string; attest_via_posture?: boolean; timeoutMs?: number }
}

function makeDeps(putResult: PutResult, socket = '/run/switchroom/broker/sock'): {
  deps: { putViaBroker: (...args: never[]) => Promise<PutResult>; resolveBrokerSocketPath: () => string }
  calls: PutCall[]
} {
  const calls: PutCall[] = []
  const deps = {
    putViaBroker: async (...args: never[]): Promise<PutResult> => {
      const [slug, entry, opts] = args as unknown as [PutCall['slug'], PutCall['entry'], PutCall['opts']]
      calls.push({ slug, entry, opts })
      return putResult
    },
    resolveBrokerSocketPath: () => socket,
  }
  return { deps, calls }
}

describe('defaultVaultWritePosture', () => {
  it('returns { ok: true } on broker `kind: ok`', async () => {
    const { deps } = makeDeps({ kind: 'ok' })
    const r = await defaultVaultWritePosture('forward-email/api-key', 'sk-value', deps)
    expect(r.ok).toBe(true)
    expect(r.output).toContain('forward-email/api-key')
  })

  it('forwards attest_via_posture: true on the put RPC', async () => {
    const { deps, calls } = makeDeps({ kind: 'ok' })
    await defaultVaultWritePosture('ha/access-token', 'jwt-value', deps)
    expect(calls).toHaveLength(1)
    expect(calls[0].opts.attest_via_posture).toBe(true)
  })

  it('forwards kind: string entry verbatim', async () => {
    const { deps, calls } = makeDeps({ kind: 'ok' })
    await defaultVaultWritePosture('some-key', 'some-value', deps)
    expect(calls[0].slug).toBe('some-key')
    expect(calls[0].entry).toEqual({ kind: 'string', value: 'some-value' })
  })

  it('returns ok:false with VAULT-BROKER-UNREACHABLE prefix on unreachable', async () => {
    const { deps } = makeDeps({ kind: 'unreachable', msg: 'connect ENOENT' })
    const r = await defaultVaultWritePosture('k', 'v', deps)
    expect(r.ok).toBe(false)
    expect(r.output).toContain('VAULT-BROKER-UNREACHABLE')
    expect(r.output).toContain('connect ENOENT')
  })

  it('returns ok:false with VAULT-BROKER-DENIED prefix on denied', async () => {
    const { deps } = makeDeps({
      kind: 'denied',
      code: 'DENIED',
      msg: 'attest_via_posture requires telegram-id',
    })
    const r = await defaultVaultWritePosture('k', 'v', deps)
    expect(r.ok).toBe(false)
    expect(r.output).toContain('VAULT-BROKER-DENIED')
    expect(r.output).toContain('DENIED')
    expect(r.output).toContain('telegram-id')
  })

  it('returns ok:false with VAULT-BROKER-UNKNOWN_KEY prefix on not_found', async () => {
    const { deps } = makeDeps({
      kind: 'not_found',
      code: 'UNKNOWN_KEY',
      msg: 'no such key',
    })
    const r = await defaultVaultWritePosture('k', 'v', deps)
    expect(r.ok).toBe(false)
    expect(r.output).toContain('VAULT-BROKER-UNKNOWN_KEY')
  })

  it('resolves the broker socket via the injected resolveBrokerSocketPath', async () => {
    const { deps, calls } = makeDeps({ kind: 'ok' }, '/tmp/test-socket')
    await defaultVaultWritePosture('k', 'v', deps)
    expect(calls[0].opts.socket).toBe('/tmp/test-socket')
  })
})
