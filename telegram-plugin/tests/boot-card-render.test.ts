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
    expect(out).toBe('✅ **klanker** back up · v0.3.0+44')
    expect(out).not.toContain('\n')
  })

  it('uses ✅ for planned and graceful restart reasons (return-to-service)', () => {
    for (const reason of ['planned', 'graceful'] as const) {
      const out = renderBootCard({ agentName: 'agent', version: 'v1', restartReason: reason })
      expect(out).toBe('✅ **agent** back up · v1')
    }
  })

  it('uses 🆕 for fresh starts (no prior session marker — first boot)', () => {
    const out = renderBootCard({ agentName: 'a', version: 'v', restartReason: 'fresh' })
    expect(out.startsWith('🆕')).toBe(true)
    expect(out).toBe('🆕 **a** back up · v')
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
    expect(lines[0]).toBe('⚠️ **lawgpt** back up · v0.3.0+44')
    expect(lines[1]).toBe('') // separator
    expect(lines[2]).toContain('⚠️ **Restart**')
    expect(lines[2]).toContain('crash recovery')
    expect(lines[2]).toContain('2.1s ago')
  })

  it('crash reason without restartAgeMs omits the "ago" suffix', () => {
    const out = renderBootCard({ agentName: 'a', version: 'v1', restartReason: 'crash' })
    expect(out).toContain('⚠️ **Restart**  crash recovery')
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
    expect(out).toContain('🟡 **Account**  token expiring · 3d')
    expect(out).toContain('🔴 **Quota**  rate limited')
    // Healthy probes must not render.
    expect(out).not.toContain('Agent**')
    expect(out).not.toContain('Gateway**')
    expect(out).not.toContain('Hindsight**')
    expect(out).not.toContain('Scheduler**')
  })

  it('orders probe rows in PROBE_KEYS canonical order regardless of object iteration', () => {
    // Insert in a non-canonical order; renderer must still output Account first,
    // then Hindsight, then Scheduler (matching PROBE_KEYS — Phase 4 renamed
    // crons → scheduler when the in-container agent-scheduler took over).
    const out = renderBootCard({
      agentName: 'a',
      version: 'v',
      probes: {
        scheduler: { status: 'fail',     label: 'Scheduler', detail: 'sidecar not running' },
        hindsight: { status: 'fail',     label: 'Hindsight', detail: 'unreachable' },
        account:   { status: 'degraded', label: 'Account',   detail: 'expiring' },
      },
    })
    const accountIdx = out.indexOf('Account**')
    const hindsightIdx = out.indexOf('Hindsight**')
    const schedulerIdx = out.indexOf('Scheduler**')
    expect(accountIdx).toBeGreaterThan(-1)
    expect(hindsightIdx).toBeGreaterThan(accountIdx)
    expect(schedulerIdx).toBeGreaterThan(hindsightIdx)
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
    expect(out).toContain('⚠️ **Restart**')
    expect(out).toContain('🟡 **Account**  expiring')
  })

  it('renders nextStep as an indented continuation line beneath a degraded row', () => {
    // Principle 1 ("If they need the docs, we've failed"): every degraded
    // probe should surface its remediation inline. Plain backticks in the
    // nextStep get translated to ` spans so the command stays tap-to-
    // copy on mobile.
    const out = renderBootCard({
      agentName: 'lawgpt',
      version: 'v0.7.16',
      probes: {
        skills: {
          status: 'degraded',
          label: 'Skills',
          detail: '10/10 dangling: a, b, c +7 more',
          nextStep: 'Run `switchroom agent reconcile lawgpt` to rebuild symlinks',
        },
      },
    })
    expect(out).toContain('🟡 **Skills**  10/10 dangling')
    expect(out).toContain('    ↳ Run `switchroom agent reconcile lawgpt` to rebuild symlinks')
  })

  it('crash row carries a tail-logs next-step', () => {
    const out = renderBootCard({
      agentName: 'lawgpt',
      version: 'v0.7.16',
      restartReason: 'crash',
      restartAgeMs: 6_100,
    })
    expect(out).toContain('⚠️ **Restart**  crash recovery · 6.1s ago')
    // The tail-logs command is runtime-aware: in-container (docker) vs
    // host (journalctl). Assert against whichever branch the renderer
    // selected so the suite is green under both bun (live container env)
    // and vitest (env scrubbed) — see vitest.config.ts.
    const expectedTail =
      process.env.SWITCHROOM_RUNTIME === 'docker'
        ? '↳ Tail logs: `docker logs --tail 100 switchroom-lawgpt`'
        : '↳ Tail logs: `journalctl --user -u switchroom-lawgpt -n 100`'
    expect(out).toContain(expectedTail)
  })

  it('crash row uses agentSlug for the systemd unit when provided', () => {
    const out = renderBootCard({
      agentName: 'LawGPT',
      agentSlug: 'lawgpt',
      version: 'v1',
      restartReason: 'crash',
    })
    expect(out).toContain('switchroom-lawgpt')
    expect(out).not.toContain('switchroom-LawGPT')
  })

  it('renderNextStep escapes HTML inside backtick-quoted commands', () => {
    const out = renderBootCard({
      agentName: 'a',
      version: 'v',
      probes: {
        account: {
          status: 'fail',
          label: 'Account',
          detail: 'expired',
          nextStep: 'Run `foo <bar> & baz` to fix',
        },
      },
    })
    // #2669: the backtick-delimited content stays a literal code span — no
    // HTML entities. < > & render verbatim inside the span.
    expect(out).toContain('`foo <bar> & baz`')
  })

  it('unpaired backticks in nextStep fall back to plain escaped text', () => {
    const out = renderBootCard({
      agentName: 'a',
      version: 'v',
      probes: {
        account: {
          status: 'fail',
          label: 'Account',
          detail: 'expired',
          nextStep: 'Run `switchroom foo to fix',
        },
      },
    })
    // Unpaired backtick → the whole nextStep is markdown-escaped, so the lone
    // backtick is rendered as a literal `\`` and never opens a real code span.
    expect(out).toContain('↳ Run \\`switchroom foo to fix')
  })

  it('degraded rows without nextStep render unchanged (backwards compat)', () => {
    const out = renderBootCard({
      agentName: 'a',
      version: 'v',
      probes: {
        quota: { status: 'fail', label: 'Quota', detail: 'rate limited' },
      },
    })
    expect(out).toContain('🔴 **Quota**  rate limited')
    expect(out).not.toContain('↳')
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
    expect(out).toContain('🔴 **Agent**  service deactivating')
  })
})

describe('renderBootCard — markdown escaping (#2669)', () => {
  it('passes < > literally in agent name; escapes emphasis specials', () => {
    // < > are literal in rich markdown; an underscore would be escaped.
    const out = renderBootCard({ agentName: 'foo<bar>', version: 'v1' })
    expect(out).toContain('foo<bar>')
    const out2 = renderBootCard({ agentName: 'foo_bar', version: 'v1' })
    expect(out2).toContain('foo\\_bar')
  })

  it('passes < > literally in version', () => {
    const out = renderBootCard({ agentName: 'a', version: 'v<1>' })
    expect(out).toContain('v<1>')
  })

  it('passes < > literally in probe detail', () => {
    const out = renderBootCard({
      agentName: 'a',
      version: 'v',
      probes: {
        quota: { status: 'fail', label: 'Quota', detail: 'rate <limited>' },
      },
    })
    expect(out).toContain('rate <limited>')
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
    expect(out).toBe('✅ **Finn** back up · v0.3.0+50')
    expect(out).not.toContain('**finn**')
  })
})

// ── Issue dedup rendering ──────────────────────────────────────────────────
// Resolved rows render at the top of the degraded section; snoozed rows
// suppress the matching probe row entirely.

describe('renderBootCard — resolved / snooze rendering', () => {
  it('renders a ✅ "resolved" row for each entry in resolvedRows above the degraded section', () => {
    const out = renderBootCard({
      agentName: 'k',
      version: 'v',
      probes: {
        broker: { status: 'fail', label: 'Broker', detail: 'socket missing' },
      },
      resolvedRows: ['hindsight'],
    })
    expect(out).toContain('✅ **Hindsight**  resolved')
    expect(out).toContain('🔴 **Broker**  socket missing')
    // Resolved appears BEFORE Broker.
    expect(out.indexOf('Hindsight')).toBeLessThan(out.indexOf('Broker'))
  })

  it('skips a degraded row when its probe key is in snoozeRows', () => {
    const out = renderBootCard({
      agentName: 'k',
      version: 'v',
      probes: {
        broker: { status: 'fail', label: 'Broker', detail: 'socket missing' },
        kernel: { status: 'fail', label: 'Kernel', detail: 'socket missing' },
      },
      snoozeRows: ['broker'],
    })
    expect(out).not.toContain('Broker')
    expect(out).toContain('Kernel')
  })

  it('snoozed everything → output is the bare ack line (silent-when-snoozed)', () => {
    const out = renderBootCard({
      agentName: 'k',
      version: 'v0.1',
      probes: {
        broker: { status: 'fail', label: 'Broker', detail: 'socket missing' },
      },
      snoozeRows: ['broker'],
    })
    expect(out).toBe('✅ **k** back up · v0.1')
  })

  it('resolvedRows alone (no probes degraded) renders the resolved row beneath the ack', () => {
    const out = renderBootCard({
      agentName: 'k',
      version: 'v',
      resolvedRows: ['skills', 'broker'],
    })
    expect(out).toContain('✅ **Skills**  resolved')
    expect(out).toContain('✅ **Broker**  resolved')
  })
})

// ── Config-change row rendering (E3) ─────────────────────────────────────────

describe('renderBootCard — configChanges rows', () => {
  it('silent when configChanges is absent', () => {
    const out = renderBootCard({ agentName: 'k', version: 'v' })
    expect(out).toBe('✅ **k** back up · v')
    expect(out).not.toContain('Config')
  })

  it('silent when configChanges is empty array', () => {
    const out = renderBootCard({ agentName: 'k', version: 'v', configChanges: [] })
    expect(out).toBe('✅ **k** back up · v')
    expect(out).not.toContain('Config')
  })

  it('renders a model-change row when model changed', () => {
    const out = renderBootCard({
      agentName: 'k',
      version: 'v',
      configChanges: [{ field: 'model', from: 'claude-opus-4', to: 'claude-sonnet-4-5' }],
    })
    expect(out).toContain('⚙️ **Config**')
    expect(out).toContain('claude-opus-4')
    expect(out).toContain('claude-sonnet-4-5')
    expect(out).toContain('→')
  })

  it('renders a coarse tools-changed row for tools diff', () => {
    const out = renderBootCard({
      agentName: 'k',
      version: 'v',
      configChanges: [{ field: 'tools', from: 'aaa', to: 'bbb' }],
    })
    expect(out).toContain('tools allowlist changed')
    expect(out).toContain('/status')
    expect(out).not.toContain('aaa')
    expect(out).not.toContain('bbb')
  })

  it('renders a coarse skills-changed row for skills diff', () => {
    const out = renderBootCard({
      agentName: 'k',
      version: 'v',
      configChanges: [{ field: 'skills', from: 'ccc', to: 'ddd' }],
    })
    expect(out).toContain('skills changed')
    expect(out).toContain('/status')
  })

  it('renders multiple config-change rows (all four fields)', () => {
    const out = renderBootCard({
      agentName: 'k',
      version: 'v',
      configChanges: [
        { field: 'model', from: 'claude-opus-4', to: 'claude-sonnet-4-5' },
        { field: 'tools', from: 'abc', to: 'def' },
        { field: 'skills', from: 'ghi', to: 'jkl' },
        { field: 'memoryBackend', from: 'finn', to: 'finn-v2' },
      ],
    })
    const lines = out.split('\n')
    // Should have more than 1 line (ack + separator + config rows).
    expect(lines.length).toBeGreaterThan(2)
    expect(out).toContain('claude-opus-4')
    expect(out).toContain('tools allowlist changed')
    expect(out).toContain('skills changed')
    expect(out).toContain('finn')
    expect(out).toContain('finn-v2')
  })

  it('config-change rows appear after probe rows', () => {
    const out = renderBootCard({
      agentName: 'k',
      version: 'v',
      probes: {
        broker: { status: 'fail', label: 'Broker', detail: 'socket missing' },
      },
      configChanges: [{ field: 'model', from: 'a', to: 'b' }],
    })
    const brokerIdx = out.indexOf('Broker')
    const configIdx = out.indexOf('Config')
    expect(brokerIdx).toBeGreaterThan(-1)
    expect(configIdx).toBeGreaterThan(-1)
    expect(configIdx).toBeGreaterThan(brokerIdx)
  })

  it('bare ack still returned when configChanges fires but produces only empty rows (defensive)', () => {
    // Edge: empty configChanges array passed → should not produce rows.
    const out = renderBootCard({ agentName: 'k', version: 'v', configChanges: [] })
    expect(out).toBe('✅ **k** back up · v')
  })
})
