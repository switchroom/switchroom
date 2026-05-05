/**
 * Tests for webhook dispatch (#715):
 *   - Static matcher (event/action/label/author combinations)
 *   - Template rendering
 *   - Cooldown state machine
 *   - Quiet hours
 *   - evaluateDispatch integration (matcher → spawn)
 */

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  matchesRule,
  renderTemplate,
  buildGithubContext,
  parseDurationMs,
  isQuietHour,
  evaluateDispatch,
  createFileCooldownStore,
  type DispatchMatcher,
  type DispatchRule,
  type WebhookDispatchConfig,
  type TemplateContext,
  type QuietHours,
} from './webhook-dispatch.js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FIXTURES = resolve(import.meta.dirname, '../../tests/fixtures')

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf-8')) as Record<string, unknown>
}

const prOpened = loadFixture('github-pr-opened.json')
const prLabeled = loadFixture('github-pr-labeled.json')
const prDependabot = loadFixture('github-pr-dependabot.json')
const pushPayload = loadFixture('github-push.json')

// ─── parseDurationMs ──────────────────────────────────────────────────────────

describe('parseDurationMs', () => {
  it('parses seconds', () => expect(parseDurationMs('30s')).toBe(30_000))
  it('parses minutes', () => expect(parseDurationMs('5m')).toBe(300_000))
  it('parses hours', () => expect(parseDurationMs('1h')).toBe(3_600_000))
  it('parses days', () => expect(parseDurationMs('2d')).toBe(172_800_000))
  it('parses bare number as ms', () => expect(parseDurationMs('500')).toBe(500))
  it('returns 0 for empty / invalid', () => {
    expect(parseDurationMs('')).toBe(0)
    expect(parseDurationMs('abc')).toBe(0)
  })
})

// ─── buildGithubContext ───────────────────────────────────────────────────────

describe('buildGithubContext', () => {
  it('extracts PR fields', () => {
    const ctx = buildGithubContext('pull_request', prOpened)
    expect(ctx.repo).toBe('acme/myrepo')
    expect(ctx.number).toBe('42')
    expect(ctx.title).toBe('Add dark mode support')
    expect(ctx.html_url).toBe('https://github.com/acme/myrepo/pull/42')
    expect(ctx.author).toBe('alice')
    expect(ctx.labels).toBe('needs-review, enhancement')
    expect(ctx.action).toBe('opened')
    expect(ctx.event).toBe('pull_request')
  })

  it('extracts push fields', () => {
    const ctx = buildGithubContext('push', pushPayload)
    expect(ctx.repo).toBe('acme/myrepo')
    expect(ctx.action).toBe('')
    expect(ctx.event).toBe('push')
  })
})

// ─── renderTemplate ───────────────────────────────────────────────────────────

describe('renderTemplate', () => {
  const ctx: TemplateContext = {
    repo: 'acme/myrepo',
    number: '42',
    title: 'Add dark mode',
    html_url: 'https://github.com/acme/myrepo/pull/42',
    author: 'alice',
    labels: 'needs-review',
    action: 'opened',
    event: 'pull_request',
  }

  it('interpolates known fields', () => {
    const out = renderTemplate('PR {{repo}} #{{number}}: {{title}}', ctx)
    expect(out).toBe('PR acme/myrepo #42: Add dark mode')
  })

  it('replaces missing fields with empty string', () => {
    const out = renderTemplate('{{missing}}', ctx)
    expect(out).toBe('')
  })

  it('handles multi-line templates', () => {
    const tmpl = 'PR #{{number}}: {{title}}\n{{html_url}}'
    const out = renderTemplate(tmpl, ctx)
    expect(out).toBe('PR #42: Add dark mode\nhttps://github.com/acme/myrepo/pull/42')
  })
})

// ─── matchesRule ─────────────────────────────────────────────────────────────

describe('matchesRule', () => {
  const baseMatcher: DispatchMatcher = { event: 'pull_request' }

  it('matches on event alone', () => {
    expect(matchesRule('pull_request', prOpened, baseMatcher)).toBe(true)
  })

  it('rejects wrong event', () => {
    expect(matchesRule('push', prOpened, baseMatcher)).toBe(false)
  })

  it('matches when action is in list', () => {
    const m: DispatchMatcher = { event: 'pull_request', actions: ['opened', 'synchronize'] }
    expect(matchesRule('pull_request', prOpened, m)).toBe(true)
  })

  it('rejects when action not in list', () => {
    const m: DispatchMatcher = { event: 'pull_request', actions: ['closed'] }
    expect(matchesRule('pull_request', prOpened, m)).toBe(false)
  })

  it('matches labels_any when at least one label present', () => {
    const m: DispatchMatcher = { event: 'pull_request', labels_any: ['needs-review', 'bug'] }
    expect(matchesRule('pull_request', prOpened, m)).toBe(true)
  })

  it('rejects labels_any when none match', () => {
    const m: DispatchMatcher = { event: 'pull_request', labels_any: ['bug', 'wontfix'] }
    expect(matchesRule('pull_request', prOpened, m)).toBe(false)
  })

  it('matches labels_all when all labels present', () => {
    const m: DispatchMatcher = {
      event: 'pull_request',
      labels_all: ['needs-review', 'enhancement'],
    }
    expect(matchesRule('pull_request', prOpened, m)).toBe(true)
  })

  it('rejects labels_all when any label missing', () => {
    const m: DispatchMatcher = {
      event: 'pull_request',
      labels_all: ['needs-review', 'missing-label'],
    }
    expect(matchesRule('pull_request', prOpened, m)).toBe(false)
  })

  it('excludes dependabot author', () => {
    const m: DispatchMatcher = {
      event: 'pull_request',
      exclude_authors: ['dependabot[bot]'],
    }
    expect(matchesRule('pull_request', prDependabot, m)).toBe(false)
  })

  it('allows non-excluded author', () => {
    const m: DispatchMatcher = {
      event: 'pull_request',
      exclude_authors: ['dependabot[bot]'],
    }
    expect(matchesRule('pull_request', prOpened, m)).toBe(true)
  })

  it('full combined rule matches correctly', () => {
    const m: DispatchMatcher = {
      event: 'pull_request',
      actions: ['opened', 'synchronize', 'ready_for_review'],
      labels_any: ['needs-review'],
      exclude_authors: ['dependabot[bot]', 'coolify[bot]'],
    }
    expect(matchesRule('pull_request', prOpened, m)).toBe(true)
    expect(matchesRule('pull_request', prDependabot, m)).toBe(false)
    expect(matchesRule('push', pushPayload, m)).toBe(false)
  })
})

// ─── isQuietHour ─────────────────────────────────────────────────────────────

describe('isQuietHour', () => {
  it('returns false when outside quiet window (same-day range)', () => {
    const qh: QuietHours = { start: 9, end: 17, tz: 'UTC' }
    const morning = new Date('2026-05-06T08:00:00Z')
    const evening = new Date('2026-05-06T17:30:00Z')
    expect(isQuietHour(qh, morning)).toBe(false)
    expect(isQuietHour(qh, evening)).toBe(false)
  })

  it('returns true when inside quiet window (same-day range)', () => {
    const qh: QuietHours = { start: 9, end: 17, tz: 'UTC' }
    const noon = new Date('2026-05-06T12:00:00Z')
    expect(isQuietHour(qh, noon)).toBe(true)
  })

  it('handles wrap-midnight range (22-8)', () => {
    const qh: QuietHours = { start: 22, end: 8, tz: 'UTC' }
    const midnight = new Date('2026-05-06T00:30:00Z') // 00:30 UTC, inside 22-8
    const noon = new Date('2026-05-06T12:00:00Z')     // 12:00 UTC, outside
    const lateEvening = new Date('2026-05-06T22:30:00Z') // 22:30 UTC, inside
    expect(isQuietHour(qh, midnight)).toBe(true)
    expect(isQuietHour(qh, noon)).toBe(false)
    expect(isQuietHour(qh, lateEvening)).toBe(true)
  })
})

// ─── CooldownStore ────────────────────────────────────────────────────────────

describe('createFileCooldownStore', () => {
  function makeTmpDir(): { resolveAgentDir: (a: string) => string } {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-test-'))
    return {
      resolveAgentDir: (agent: string) => {
        const dir = join(root, agent)
        mkdirSync(join(dir, 'telegram'), { recursive: true })
        return dir
      },
    }
  }

  it('returns false on first call and records dispatch', () => {
    const { resolveAgentDir } = makeTmpDir()
    const store = createFileCooldownStore(resolveAgentDir)
    const result = store.isCoolingDown('agent1', 'key1', 300_000, 1_000_000)
    expect(result).toBe(false)
  })

  it('returns true on second call within cooldown window', () => {
    const { resolveAgentDir } = makeTmpDir()
    const store = createFileCooldownStore(resolveAgentDir)
    store.isCoolingDown('agent1', 'key1', 300_000, 1_000_000)
    const result = store.isCoolingDown('agent1', 'key1', 300_000, 1_100_000)
    expect(result).toBe(true)
  })

  it('returns false after cooldown expires', () => {
    const { resolveAgentDir } = makeTmpDir()
    const store = createFileCooldownStore(resolveAgentDir)
    store.isCoolingDown('agent1', 'key1', 300_000, 1_000_000)
    // Advance past cooldown window (5 min = 300_000ms)
    const result = store.isCoolingDown('agent1', 'key1', 300_000, 1_400_000)
    expect(result).toBe(false)
  })

  it('zero cooldown always returns false', () => {
    const { resolveAgentDir } = makeTmpDir()
    const store = createFileCooldownStore(resolveAgentDir)
    store.isCoolingDown('agent1', 'key1', 0, 1_000_000)
    expect(store.isCoolingDown('agent1', 'key1', 0, 1_000_001)).toBe(false)
  })
})

// ─── evaluateDispatch ─────────────────────────────────────────────────────────

describe('evaluateDispatch', () => {
  function makeTmpResolveAgentDir(): (a: string) => string {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-eval-'))
    return (agent: string) => {
      const dir = join(root, agent)
      mkdirSync(join(dir, 'telegram'), { recursive: true })
      return dir
    }
  }

  const baseRule: DispatchRule = {
    match: {
      event: 'pull_request',
      actions: ['opened'],
      labels_any: ['needs-review'],
      exclude_authors: ['dependabot[bot]'],
    },
    prompt: 'Review PR #{{number}}: {{title}}\n{{html_url}}',
    model: 'claude-sonnet-4-6',
  }

  it('fires spawn when rule matches', () => {
    const resolveAgentDir = makeTmpResolveAgentDir()
    const spawned: Array<{ cmd: string; args: string[] }> = []
    const config: WebhookDispatchConfig = { github: [baseRule] }

    const count = evaluateDispatch(
      {
        agent: 'reggie',
        source: 'github',
        eventType: 'pull_request',
        payload: prOpened,
        dispatchConfig: config,
      },
      {
        resolveAgentDir,
        now: () => 1_000_000,
        log: () => {},
        spawnFn: (cmd, args) => {
          spawned.push({ cmd, args })
          return { on: () => {}, pid: 9999 }
        },
      },
    )

    expect(count).toBe(1)
    expect(spawned).toHaveLength(1)
    expect(spawned[0].cmd).toBe('claude')
    expect(spawned[0].args[0]).toBe('-p')
    expect(spawned[0].args[1]).toContain('#42')
    expect(spawned[0].args[1]).toContain('Add dark mode support')
  })

  it('skips dependabot PR', () => {
    const resolveAgentDir = makeTmpResolveAgentDir()
    const spawned: Array<unknown> = []
    const config: WebhookDispatchConfig = { github: [baseRule] }

    const count = evaluateDispatch(
      {
        agent: 'reggie',
        source: 'github',
        eventType: 'pull_request',
        payload: prDependabot,
        dispatchConfig: config,
      },
      {
        resolveAgentDir,
        now: () => 1_000_000,
        log: () => {},
        spawnFn: (_, args) => { spawned.push(args); return { on: () => {} } },
      },
    )

    expect(count).toBe(0)
    expect(spawned).toHaveLength(0)
  })

  it('returns 0 for non-github source', () => {
    const resolveAgentDir = makeTmpResolveAgentDir()
    const config: WebhookDispatchConfig = { github: [baseRule] }
    const count = evaluateDispatch(
      {
        agent: 'reggie',
        source: 'generic',
        eventType: 'push',
        payload: pushPayload,
        dispatchConfig: config,
      },
      { resolveAgentDir, log: () => {} },
    )
    expect(count).toBe(0)
  })

  it('skips during quiet hours', () => {
    const resolveAgentDir = makeTmpResolveAgentDir()
    const spawned: Array<unknown> = []
    const ruleWithQH: DispatchRule = {
      ...baseRule,
      quiet_hours: { start: 0, end: 23, tz: 'UTC' }, // always quiet
    }
    const config: WebhookDispatchConfig = { github: [ruleWithQH] }

    const count = evaluateDispatch(
      {
        agent: 'reggie',
        source: 'github',
        eventType: 'pull_request',
        payload: prOpened,
        dispatchConfig: config,
      },
      {
        resolveAgentDir,
        nowDate: () => new Date('2026-05-06T10:00:00Z'),
        now: () => 1_000_000,
        log: () => {},
        spawnFn: (_, args) => { spawned.push(args); return { on: () => {} } },
      },
    )

    expect(count).toBe(0)
    expect(spawned).toHaveLength(0)
  })

  it('respects cooldown — second fire within window is skipped', () => {
    const resolveAgentDir = makeTmpResolveAgentDir()
    const spawned: Array<unknown> = []
    const ruleWithCooldown: DispatchRule = { ...baseRule, cooldown: '5m' }
    const config: WebhookDispatchConfig = { github: [ruleWithCooldown] }

    const deps = {
      resolveAgentDir,
      now: () => 1_000_000,
      log: () => {},
      spawnFn: (_cmd: string, args: string[]) => { spawned.push(args); return { on: () => {} } },
    }

    evaluateDispatch(
      { agent: 'reggie', source: 'github', eventType: 'pull_request', payload: prOpened, dispatchConfig: config },
      deps,
    )
    const count2 = evaluateDispatch(
      { agent: 'reggie', source: 'github', eventType: 'pull_request', payload: prOpened, dispatchConfig: config },
      { ...deps, now: () => 1_060_000 }, // 1 minute later, still in cooldown
    )

    expect(spawned).toHaveLength(1)
    expect(count2).toBe(0)
  })

  it('fires multiple matching rules', () => {
    const resolveAgentDir = makeTmpResolveAgentDir()
    const spawned: Array<unknown> = []
    const rule2: DispatchRule = {
      match: { event: 'pull_request', labels_any: ['enhancement'] },
      prompt: 'Enhancement PR opened: {{title}}',
    }
    const config: WebhookDispatchConfig = { github: [baseRule, rule2] }

    const count = evaluateDispatch(
      { agent: 'reggie', source: 'github', eventType: 'pull_request', payload: prOpened, dispatchConfig: config },
      {
        resolveAgentDir,
        now: () => 1_000_000,
        log: () => {},
        spawnFn: (_, args) => { spawned.push(args); return { on: () => {} } },
      },
    )

    expect(count).toBe(2)
    expect(spawned).toHaveLength(2)
  })
})
