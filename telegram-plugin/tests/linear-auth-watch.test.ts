import { describe, it, expect } from 'vitest'
import { runLinearAuthCheck, type LinearAuthWatchDeps } from '../gateway/linear-auth-watch.js'
import { serializeBundle } from '../../src/linear/oauth-refresh.js'

function baseDeps(over: Partial<LinearAuthWatchDeps> = {}): { deps: LinearAuthWatchDeps; alerts: Array<{ reason: string }> } {
  const alerts: Array<{ reason: string }> = []
  const deps: LinearAuthWatchDeps = {
    agent: 'clerk',
    linearEnabled: () => true,
    readBundle: async () => serializeBundle({ clientId: 'c', clientSecret: 's', refreshToken: 'rt', expiresAt: 10_000 }),
    refresh: async () => ({ ok: true, accessToken: 'lin_new', expiresAt: 20_000 }),
    onAuthDead: (i) => alerts.push(i),
    nowSec: () => 1_000, // far before expiry → fresh
    log: () => {},
    ...over,
  }
  return { deps, alerts }
}

describe('runLinearAuthCheck (proactive Linear auth watch)', () => {
  it('disabled agent → no-op, no alert', async () => {
    const { deps, alerts } = baseDeps({ linearEnabled: () => false })
    expect(await runLinearAuthCheck(deps)).toBe('disabled')
    expect(alerts).toEqual([])
  })

  it('fresh token (not near expiry) → fresh, no refresh, no alert', async () => {
    let refreshed = false
    const { deps, alerts } = baseDeps({ refresh: async () => { refreshed = true; return { ok: true, accessToken: 'x', expiresAt: 1 } } })
    expect(await runLinearAuthCheck(deps)).toBe('fresh')
    expect(refreshed).toBe(false)
    expect(alerts).toEqual([])
  })

  it('missing bundle → no_bundle + proactive operator alert', async () => {
    const { deps, alerts } = baseDeps({ readBundle: async () => null })
    expect(await runLinearAuthCheck(deps)).toBe('no_bundle')
    expect(alerts).toEqual([{ agent: 'clerk', reason: 'no_bundle', detail: expect.any(String) }])
  })

  it('near-expiry token → proactively refreshes, no alert', async () => {
    // now=9999 is within the 2h skew of expiresAt=10000
    const { deps, alerts } = baseDeps({ nowSec: () => 9_999 })
    expect(await runLinearAuthCheck(deps)).toBe('refreshed')
    expect(alerts).toEqual([])
  })

  it('near-expiry + revoked refresh token → alert(revoked)', async () => {
    const { deps, alerts } = baseDeps({
      nowSec: () => 9_999,
      refresh: async () => ({ ok: false, reason: 'revoked', detail: 'invalid_grant' }),
    })
    expect(await runLinearAuthCheck(deps)).toBe('revoked')
    expect(alerts.map((a) => a.reason)).toEqual(['revoked'])
  })

  it('near-expiry + transient refresh failure → no alert (retries later)', async () => {
    const { deps, alerts } = baseDeps({
      nowSec: () => 9_999,
      refresh: async () => ({ ok: false, reason: 'network', detail: 'boom' }),
    })
    expect(await runLinearAuthCheck(deps)).toBe('refresh_failed')
    expect(alerts).toEqual([])
  })

  it('broker read error → refresh_failed, no alert (transient infra)', async () => {
    const { deps, alerts } = baseDeps({ readBundle: async () => { throw new Error('broker down') } })
    expect(await runLinearAuthCheck(deps)).toBe('refresh_failed')
    expect(alerts).toEqual([])
  })

  it('expiry-untracked bundle (no expiresAt) → fresh (reactive path covers it)', async () => {
    const { deps, alerts } = baseDeps({
      readBundle: async () => serializeBundle({ clientId: 'c', clientSecret: 's', refreshToken: 'rt' }),
    })
    expect(await runLinearAuthCheck(deps)).toBe('fresh')
    expect(alerts).toEqual([])
  })
})
