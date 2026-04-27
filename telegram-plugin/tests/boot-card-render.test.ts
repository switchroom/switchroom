/**
 * Tests for the post-#142 boot-card renderer.
 *
 * The contract this PR locks in:
 *   - Healthy boot → one line ack ("✅ <agent> back up · <version>"). No probe
 *     rows ever, regardless of `probes` shape (all-ok or absent).
 *   - Crash recovery → ⚠️ on the ack line + a single "Crash recovery" row.
 *   - Degraded probes (status='degraded' or 'fail') → one row per probe,
 *     in PROBE_KEYS order, with the matching dot emoji.
 *   - All-green probes after the settle window → no edit (text equals
 *     the initial post).
 *   - HTML escaping on agentName, version, and probe `detail`.
 */

import { describe, it, expect } from 'vitest'
import { renderBootCard, resolvePersonaName } from '../gateway/boot-card.js'

describe('renderBootCard — quiet by default', () => {
  it('returns one-line ack with default ✅ when no probes and no restart reason', () => {
    const out = renderBootCard({ agentName: 'klanker', version: 'v0.3.0+44' })
    expect(out).toBe('✅ <b>klanker</b> back up · v0.3.0+44')
    expect(out).not.toContain('\n')
  })

  it('uses ✅ for planned and graceful restart reasons (return-to-service)', () => {
    for (const reason of ['planned', 'graceful'] as const) {
      const out = renderBootCard({ agentName: 'agent', version: 'v1', restartReason: reason })
      expect(out).toBe('✅ <b>agent</b> back up · v1')
    }
  })

  it('uses 🆕 for fresh starts (no prior session marker — first boot)', () => {
    const out = renderBootCard({ agentName: 'a', version: 'v', restartReason: 'fresh' })
    expect(out.startsWith('🆕')).toBe(true)
    expect(out).toBe('🆕 <b>a</b> back up · v')
  })

  it('all-ok probes produce no extra rows — same output as no probes at all', () => {
    const ackOnly = renderBootCard({ agentName: 'k', version: 'v0.3.0' })
    const ackWithGreenProbes = renderBootCard({
      agentName: 'k',
      version: 'v0.3.0',
      probes: {
        account:   { status: 'ok', label: 'Account',   detail: 'a@b' },
        agent:     { status: 'ok', label: 'Agent',     detail: 'PID 1' },
        gateway:   { status: 'ok', label: 'Gateway',   detail: 'up 5s' },
        quota:     { status: 'ok', label: 'Quota',     detail: '50% used' },
        hindsight: { status: 'ok', label: 'Hindsight', detail: 'reachable' },
        crons:     { status: 'ok', label: 'Crons',     detail: '0 timers' },
      },
    })
    expect(ackWithGreenProbes).toBe(ackOnly)
  })
})

describe('renderBootCard — degraded conditions', () => {
  it('crash reason flips ack emoji to ⚠️ and appends a Crash recovery row', () => {
    const out = renderBootCard({
      agentName: 'lawgpt',
      version: 'v0.3.0+44',
      restartReason: 'crash',
      restartAgeMs: 2_100,
    })
    const lines = out.split('\n')
    expect(lines[0]).toBe('⚠️ <b>lawgpt</b> back up · v0.3.0+44')
    expect(lines[1]).toBe('') // separator
    expect(lines[2]).toContain('⚠️ <b>Restart</b>')
    expect(lines[2]).toContain('crash recovery')
    expect(lines[2]).toContain('2.1s ago')
  })

  it('crash reason without restartAgeMs omits the "ago" suffix', () => {
    const out = renderBootCard({ agentName: 'a', version: 'v1', restartReason: 'crash' })
    expect(out).toContain('⚠️ <b>Restart</b>  crash recovery')
    expect(out).not.toMatch(/\d+\.\d+s ago/)
  })

  it('appends one row per non-ok probe, healthy probes never render', () => {
    const out = renderBootCard({
      agentName: 'klanker',
      version: 'v0.3.0',
      probes: {
        account:   { status: 'degraded', label: 'Account',   detail: 'token expiring · 3d' },
        agent:     { status: 'ok',       label: 'Agent',     detail: 'PID 1' },
        gateway:   { status: 'ok',       label: 'Gateway',   detail: 'up 30s' },
        quota:     { status: 'fail',     label: 'Quota',     detail: 'rate limited' },
        hindsight: { status: 'ok',       label: 'Hindsight', detail: 'reachable' },
        crons:     { status: 'ok',       label: 'Crons',     detail: '4 timers' },
      },
    })
    expect(out).toContain('🟡 <b>Account</b>  token expiring · 3d')
    expect(out).toContain('🔴 <b>Quota</b>  rate limited')
    // Healthy probes must not render.
    expect(out).not.toContain('Agent</b>')
    expect(out).not.toContain('Gateway</b>')
    expect(out).not.toContain('Hindsight</b>')
    expect(out).not.toContain('Crons</b>')
  })

  it('orders probe rows in PROBE_KEYS canonical order regardless of object iteration', () => {
    // Insert in a non-canonical order; renderer must still output Account first,
    // then Hindsight, then Crons (matching PROBE_KEYS).
    const out = renderBootCard({
      agentName: 'a',
      version: 'v',
      probes: {
        crons:     { status: 'fail',     label: 'Crons',     detail: 'bad' },
        hindsight: { status: 'fail',     label: 'Hindsight', detail: 'unreachable' },
        account:   { status: 'degraded', label: 'Account',   detail: 'expiring' },
      },
    })
    const accountIdx = out.indexOf('Account</b>')
    const hindsightIdx = out.indexOf('Hindsight</b>')
    const cronsIdx = out.indexOf('Crons</b>')
    expect(accountIdx).toBeGreaterThan(-1)
    expect(hindsightIdx).toBeGreaterThan(accountIdx)
    expect(cronsIdx).toBeGreaterThan(hindsightIdx)
  })

  it('crash + degraded probe = both rows render', () => {
    const out = renderBootCard({
      agentName: 'a',
      version: 'v',
      restartReason: 'crash',
      restartAgeMs: 1_500,
      probes: {
        account: { status: 'degraded', label: 'Account', detail: 'expiring' },
      },
    })
    const lines = out.split('\n')
    expect(lines[0].startsWith('⚠️')).toBe(true)
    expect(lines).toContain('') // separator after ack
    expect(out).toContain('⚠️ <b>Restart</b>')
    expect(out).toContain('🟡 <b>Account</b>  expiring')
  })

  it('null probe entries are skipped (defensive against partial probe maps)', () => {
    const out = renderBootCard({
      agentName: 'a',
      version: 'v',
      probes: {
        account: null,
        agent: { status: 'fail', label: 'Agent', detail: 'service deactivating' },
      },
    })
    expect(out).not.toContain('Account')
    expect(out).toContain('🔴 <b>Agent</b>  service deactivating')
  })
})

describe('renderBootCard — HTML escaping', () => {
  it('escapes special chars in agent name', () => {
    const out = renderBootCard({ agentName: 'foo<bar>', version: 'v1' })
    expect(out).toContain('foo&lt;bar&gt;')
    expect(out).not.toContain('foo<bar>')
  })

  it('escapes special chars in version', () => {
    const out = renderBootCard({ agentName: 'a', version: 'v<1>' })
    expect(out).toContain('v&lt;1&gt;')
  })

  it('escapes special chars in probe detail', () => {
    const out = renderBootCard({
      agentName: 'a',
      version: 'v',
      probes: {
        quota: { status: 'fail', label: 'Quota', detail: 'rate <limited>' },
      },
    })
    expect(out).toContain('rate &lt;limited&gt;')
    expect(out).not.toContain('rate <limited>')
  })
})

describe('resolvePersonaName — persona name over slug (#169)', () => {
  it('returns soul.name when set in config', () => {
    const fakeCfg = () => ({
      agents: { finn: { soul: { name: 'Finn', style: 'warm' } } },
    })
    expect(resolvePersonaName('finn', fakeCfg)).toBe('Finn')
  })

  it('falls back to slug when soul.name is absent', () => {
    const fakeCfg = () => ({
      agents: { finn: { soul: null } },
    })
    expect(resolvePersonaName('finn', fakeCfg)).toBe('finn')
  })

  it('falls back to slug when soul.name is empty string', () => {
    const fakeCfg = () => ({
      agents: { finn: { soul: { name: '', style: 'warm' } } },
    })
    expect(resolvePersonaName('finn', fakeCfg)).toBe('finn')
  })

  it('falls back to slug when agent key is not in config', () => {
    const fakeCfg = () => ({ agents: {} })
    expect(resolvePersonaName('finn', fakeCfg)).toBe('finn')
  })

  it('falls back to slug when config loader throws', () => {
    const throwing = () => { throw new Error('no config file') }
    expect(resolvePersonaName('finn', throwing)).toBe('finn')
  })

  it('boot card rendered with soul.name not slug — acceptance criterion for #169', () => {
    // Simulate: slug is "finn", soul.name is "Finn"
    const fakeCfg = () => ({
      agents: { finn: { soul: { name: 'Finn', style: 'warm' } } },
    })
    const displayName = resolvePersonaName('finn', fakeCfg)
    const out = renderBootCard({ agentName: displayName, version: 'v0.3.0+50' })
    // User sees "Finn", not the slug "finn"
    expect(out).toBe('✅ <b>Finn</b> back up · v0.3.0+50')
    expect(out).not.toContain('<b>finn</b>')
  })
})
