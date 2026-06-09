import { describe, it, expect } from 'vitest'
import {
  CRON_IDENTITY_SUFFIX,
  baseAgent,
  cronIdentity,
  isCronIdentity,
  resolveInjectTarget,
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
