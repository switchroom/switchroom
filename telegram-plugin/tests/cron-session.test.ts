import { describe, it, expect } from 'vitest'
import {
  CRON_IDENTITY_SUFFIX,
  baseAgent,
  cronIdentity,
  isCronIdentity,
  resolveInjectTarget,
  deliverInjectWithFallback,
} from '../gateway/cron-session.js'

describe('cron-session identity helpers', () => {
  it('derives and detects the cron identity', () => {
    expect(cronIdentity('clerk')).toBe(`clerk${CRON_IDENTITY_SUFFIX}`)
    expect(isCronIdentity('clerk-cron')).toBe(true)
    expect(isCronIdentity('clerk')).toBe(false)
    expect(isCronIdentity(null)).toBe(false)
    expect(isCronIdentity(undefined)).toBe(false)
  })

  it('round-trips base agent', () => {
    expect(baseAgent(cronIdentity('marko'))).toBe('marko')
    expect(baseAgent('marko')).toBe('marko')
  })

  it('resolveInjectTarget routes only meta.session=cron to the cron bridge', () => {
    expect(resolveInjectTarget('clerk', { session: 'cron', source: 'cron' })).toBe('clerk-cron')
    expect(resolveInjectTarget('clerk', { session: 'main', source: 'cron' })).toBe('clerk')
    expect(resolveInjectTarget('clerk', { source: 'cron' })).toBe('clerk')
    expect(resolveInjectTarget('clerk', undefined)).toBe('clerk')
    // back-compat: every legacy caller (no session) is unchanged.
    expect(resolveInjectTarget('clerk', { source: 'telegram' })).toBe('clerk')
  })
})

describe('deliverInjectWithFallback — a cron fire is never dropped by tier routing', () => {
  it('delivers to the cron bridge when it is connected', () => {
    const sent: string[] = []
    const r = deliverInjectWithFallback('clerk', { session: 'cron' }, (t) => (sent.push(t), true))
    expect(r).toEqual({ target: 'clerk-cron', delivered: true, fellBackToMain: false })
    expect(sent).toEqual(['clerk-cron']) // tried cron only; it delivered
  })

  it('falls back to the MAIN bridge when the cron bridge is not connected', () => {
    // The exact gap: a hot-added / agent-authored frequent cron whose
    // boot-forked cron session isn't up. Must land on main, not vanish.
    const sent: string[] = []
    const r = deliverInjectWithFallback('clerk', { session: 'cron' }, (t) => {
      sent.push(t)
      return t === 'clerk' // cron bridge down, main up
    })
    expect(r).toEqual({ target: 'clerk', delivered: true, fellBackToMain: true })
    expect(sent).toEqual(['clerk-cron', 'clerk']) // tried cron, then fell back to main
  })

  it('reports not-delivered only when BOTH cron and main are down (then it buffers)', () => {
    const sent: string[] = []
    const r = deliverInjectWithFallback('clerk', { session: 'cron' }, (t) => (sent.push(t), false))
    expect(r).toEqual({ target: 'clerk-cron', delivered: false, fellBackToMain: false })
    expect(sent).toEqual(['clerk-cron', 'clerk']) // tried both, both down
  })

  it('a non-cron (main) fire never tries a fallback', () => {
    const sent: string[] = []
    const r = deliverInjectWithFallback('clerk', { session: 'main' }, (t) => (sent.push(t), false))
    expect(r).toEqual({ target: 'clerk', delivered: false, fellBackToMain: false })
    expect(sent).toEqual(['clerk']) // only the main bridge, no cron fallback attempted
  })
})
