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
 * We mock `putViaBroker` so the unit test never hits a real socket /
 * a real vault.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../../src/vault/broker/client.js', () => ({
  putViaBroker: vi.fn(),
  resolveBrokerSocketPath: vi.fn(() => '/run/switchroom/broker/sock'),
}))

const { defaultVaultWritePosture } = await import('../secret-detect/vault-write.js')
const brokerClient = await import('../../src/vault/broker/client.js')
const putMock = brokerClient.putViaBroker as ReturnType<typeof vi.fn>

describe('defaultVaultWritePosture', () => {
  beforeEach(() => {
    putMock.mockReset()
  })

  it('returns { ok: true } on broker `kind: ok`', async () => {
    putMock.mockResolvedValueOnce({ kind: 'ok' })
    const r = await defaultVaultWritePosture('forward-email/api-key', 'sk-value')
    expect(r.ok).toBe(true)
    expect(r.output).toContain('forward-email/api-key')
  })

  it('forwards attest_via_posture: true on the put RPC', async () => {
    putMock.mockResolvedValueOnce({ kind: 'ok' })
    await defaultVaultWritePosture('ha/access-token', 'jwt-value')
    expect(putMock).toHaveBeenCalledTimes(1)
    const [, , opts] = putMock.mock.calls[0]
    expect(opts).toMatchObject({ attest_via_posture: true })
  })

  it('forwards kind: string entry verbatim', async () => {
    putMock.mockResolvedValueOnce({ kind: 'ok' })
    await defaultVaultWritePosture('some-key', 'some-value')
    const [keyArg, entryArg] = putMock.mock.calls[0]
    expect(keyArg).toBe('some-key')
    expect(entryArg).toEqual({ kind: 'string', value: 'some-value' })
  })

  it('returns ok:false with VAULT-BROKER-UNREACHABLE prefix on unreachable', async () => {
    putMock.mockResolvedValueOnce({ kind: 'unreachable', msg: 'connect ENOENT' })
    const r = await defaultVaultWritePosture('k', 'v')
    expect(r.ok).toBe(false)
    expect(r.output).toContain('VAULT-BROKER-UNREACHABLE')
    expect(r.output).toContain('connect ENOENT')
  })

  it('returns ok:false with VAULT-BROKER-DENIED prefix on denied', async () => {
    putMock.mockResolvedValueOnce({
      kind: 'denied',
      code: 'DENIED',
      msg: 'attest_via_posture requires telegram-id',
    })
    const r = await defaultVaultWritePosture('k', 'v')
    expect(r.ok).toBe(false)
    expect(r.output).toContain('VAULT-BROKER-DENIED')
    expect(r.output).toContain('DENIED')
    expect(r.output).toContain('telegram-id')
  })

  it('returns ok:false with VAULT-BROKER-UNKNOWN_KEY prefix on not_found', async () => {
    putMock.mockResolvedValueOnce({
      kind: 'not_found',
      code: 'UNKNOWN_KEY',
      msg: 'no such key',
    })
    const r = await defaultVaultWritePosture('k', 'v')
    expect(r.ok).toBe(false)
    expect(r.output).toContain('VAULT-BROKER-UNKNOWN_KEY')
  })

  it('resolves the broker socket via resolveBrokerSocketPath()', async () => {
    const resolveMock = brokerClient.resolveBrokerSocketPath as ReturnType<typeof vi.fn>
    resolveMock.mockReturnValueOnce('/tmp/test-socket')
    putMock.mockResolvedValueOnce({ kind: 'ok' })
    await defaultVaultWritePosture('k', 'v')
    const [, , opts] = putMock.mock.calls[0]
    expect(opts).toMatchObject({ socket: '/tmp/test-socket' })
  })
})
