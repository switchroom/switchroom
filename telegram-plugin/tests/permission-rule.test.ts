/**
 * Tests for the scoped always-allow rule resolver — pinned by the
 * Telegram "🔁 Always…" scope sub-menu (callback handler in gateway.ts).
 *
 * The shape we promise the gateway:
 *   - `null` ⇒ "don't show the Always button" (unknown tool, missing
 *     skill name, characters that could break Claude Code's
 *     permission-rule grammar).
 *   - `{ specific?, broad }` ⇒ one or two ScopeOptions. `specific` is the
 *     narrow grant (this file / this command / this MCP action); `broad`
 *     is the whole-category grant (any file / every server tool) and is
 *     always present when choices resolve at all.
 *
 * `matchesAllowRule` is the inverse — does a stored rule cover a fresh
 * request — used by the bridge's session-scoped allow cache (#1138).
 */

import { describe, it, expect } from 'vitest'
import {
  resolveScopedAllowChoices,
  matchesAllowRule,
  isRulePersisted,
  prettyMcpServer,
} from '../permission-rule.js'

describe('resolveScopedAllowChoices — Skill', () => {
  it('offers this-skill (specific) + any-skill (broad)', () => {
    const r = resolveScopedAllowChoices('Skill', JSON.stringify({ skill: 'mail' }))
    expect(r).toEqual({
      specific: { rule: 'Skill(mail)', buttonLabel: 'This skill', broad: false },
      broad: { rule: 'Skill', buttonLabel: 'Any skill', broad: true },
    })
  })

  it('follows the field fallback chain (skill_name / skillName / name / path)', () => {
    for (const input of [
      { skill_name: 'calendar' },
      { skillName: 'calendar' },
      { name: 'calendar' },
    ]) {
      expect(resolveScopedAllowChoices('Skill', JSON.stringify(input))?.specific?.rule).toBe(
        'Skill(calendar)',
      )
    }
    expect(
      resolveScopedAllowChoices('Skill', JSON.stringify({ path: 'skills/coolify/SKILL.md' }))
        ?.specific?.rule,
    ).toBe('Skill(coolify)')
  })

  it('returns null when no skill identifier is present', () => {
    expect(resolveScopedAllowChoices('Skill', JSON.stringify({ unrelated: 'x' }))).toBeNull()
    expect(resolveScopedAllowChoices('Skill', undefined)).toBeNull()
    expect(resolveScopedAllowChoices('Skill', 'not-json')).toBeNull()
  })

  it('refuses skill names with grammar-breaking characters', () => {
    expect(resolveScopedAllowChoices('Skill', JSON.stringify({ skill: 'mail(secret)' }))).toBeNull()
    expect(resolveScopedAllowChoices('Skill', JSON.stringify({ skill: 'mail/calendar' }))).toBeNull()
    expect(resolveScopedAllowChoices('Skill', JSON.stringify({ skill: 'mail calendar' }))).toBeNull()
  })

  it('accepts the safe alphanumeric + ._-+ alphabet', () => {
    for (const s of ['home-assistant', 'home_assistant', 'docs.v2', 'work+personal']) {
      expect(resolveScopedAllowChoices('Skill', JSON.stringify({ skill: s }))).not.toBeNull()
    }
  })
})

describe('resolveScopedAllowChoices — file tools', () => {
  it('offers this-file (specific) + any-file (broad) when a path is present', () => {
    const r = resolveScopedAllowChoices('Edit', JSON.stringify({ file_path: '/work/log.md' }))
    expect(r).toEqual({
      specific: { rule: 'Edit(/work/log.md)', buttonLabel: 'This file', broad: false },
      broad: { rule: 'Edit', buttonLabel: 'Any file', broad: true },
    })
  })

  it('falls back to broad-only when no path is present', () => {
    const r = resolveScopedAllowChoices('Write', JSON.stringify({ unrelated: 'x' }))
    expect(r).toEqual({ broad: { rule: 'Write', buttonLabel: 'Any file', broad: true } })
  })

  it('prefers notebook_path for NotebookEdit', () => {
    const r = resolveScopedAllowChoices(
      'NotebookEdit',
      JSON.stringify({ notebook_path: '/work/a.ipynb' }),
    )
    expect(r?.specific?.rule).toBe('NotebookEdit(/work/a.ipynb)')
  })

  it.each(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read'])(
    'treats %s as a file tool',
    (tool) => {
      const r = resolveScopedAllowChoices(tool, JSON.stringify({ file_path: '/x' }))
      expect(r?.broad.rule).toBe(tool)
    },
  )
})

describe('resolveScopedAllowChoices — Bash', () => {
  it('offers a command-family prefix (specific) + any-command (broad)', () => {
    const r = resolveScopedAllowChoices('Bash', JSON.stringify({ command: 'npm run build' }))
    expect(r).toEqual({
      specific: { rule: 'Bash(npm:*)', buttonLabel: 'npm commands', broad: false },
      broad: { rule: 'Bash', buttonLabel: 'Any command', broad: true },
    })
  })

  it('falls back to broad-only when the first token is unsafe', () => {
    const r = resolveScopedAllowChoices('Bash', JSON.stringify({ command: 'foo | bar' }))
    // "foo" is a clean token, so this resolves; use a metacharacter-led command:
    const r2 = resolveScopedAllowChoices('Bash', JSON.stringify({ command: '$(evil)' }))
    expect(r?.specific?.rule).toBe('Bash(foo:*)')
    expect(r2).toEqual({ broad: { rule: 'Bash', buttonLabel: 'Any command', broad: true } })
  })
})

describe('resolveScopedAllowChoices — broad-only built-ins', () => {
  it.each(['Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite', 'ExitPlanMode'])(
    'offers a single "Always allow" broad grant for %s',
    (tool) => {
      expect(resolveScopedAllowChoices(tool, undefined)).toEqual({
        broad: { rule: tool, buttonLabel: 'Always allow', broad: true },
      })
    },
  )
})

describe('resolveScopedAllowChoices — MCP tools', () => {
  it('offers this-action (specific) + all-server (broad)', () => {
    const r = resolveScopedAllowChoices('mcp__perplexity__search', undefined)
    expect(r).toEqual({
      specific: { rule: 'mcp__perplexity__search', buttonLabel: 'This action', broad: false },
      broad: { rule: 'mcp__perplexity__*', buttonLabel: 'All Perplexity', broad: true },
    })
  })

  it('prettifies multi-word server slugs in the broad label', () => {
    const r = resolveScopedAllowChoices('mcp__google-workspace__list_files', undefined)
    expect(r?.broad).toEqual({
      rule: 'mcp__google-workspace__*',
      buttonLabel: 'All Google Workspace',
      broad: true,
    })
  })

  it('offers a broad-only grant for a server-only namespace', () => {
    expect(resolveScopedAllowChoices('mcp__hindsight', undefined)).toEqual({
      broad: { rule: 'mcp__hindsight', buttonLabel: 'Always allow', broad: true },
    })
  })

  it('refuses malformed mcp shapes', () => {
    expect(resolveScopedAllowChoices('mcp_foo', undefined)).toBeNull()
    expect(resolveScopedAllowChoices('mcp__', undefined)).toBeNull()
  })
})

describe('resolveScopedAllowChoices — fallback', () => {
  it('returns null for unknown tools and empty input', () => {
    expect(resolveScopedAllowChoices('UnknownTool', undefined)).toBeNull()
    expect(resolveScopedAllowChoices('', undefined)).toBeNull()
  })
})

describe('prettyMcpServer', () => {
  it('title-cases and splits on - and _', () => {
    expect(prettyMcpServer('perplexity')).toBe('Perplexity')
    expect(prettyMcpServer('google-workspace')).toBe('Google Workspace')
    expect(prettyMcpServer('agent_config')).toBe('Agent Config')
  })
})

describe('matchesAllowRule — bare tool names', () => {
  it('matches any invocation of the same tool', () => {
    expect(matchesAllowRule('Edit', 'Edit', undefined)).toBe(true)
    expect(matchesAllowRule('Edit', 'Edit', JSON.stringify({ file_path: '/etc/passwd' }))).toBe(true)
  })

  it('does not bleed into other tools', () => {
    expect(matchesAllowRule('Edit', 'Write', undefined)).toBe(false)
    expect(matchesAllowRule('Bash', 'BashOutput', undefined)).toBe(false)
  })
})

describe('matchesAllowRule — scoped file/Bash/Skill rules', () => {
  it('matches a file rule only for that exact path', () => {
    expect(matchesAllowRule('Edit(/work/log.md)', 'Edit', JSON.stringify({ file_path: '/work/log.md' }))).toBe(true)
    expect(matchesAllowRule('Edit(/work/log.md)', 'Edit', JSON.stringify({ file_path: '/work/other.md' }))).toBe(false)
  })

  it('matches a Bash prefix rule by first command token', () => {
    expect(matchesAllowRule('Bash(npm:*)', 'Bash', JSON.stringify({ command: 'npm run build' }))).toBe(true)
    expect(matchesAllowRule('Bash(npm:*)', 'Bash', JSON.stringify({ command: 'git status' }))).toBe(false)
  })

  it('matches a Skill rule only for that skill', () => {
    expect(matchesAllowRule('Skill(mail)', 'Skill', JSON.stringify({ skill: 'mail' }))).toBe(true)
    expect(matchesAllowRule('Skill(mail)', 'Skill', JSON.stringify({ skill: 'calendar' }))).toBe(false)
  })

  it('does not match a different tool with the same arg', () => {
    expect(matchesAllowRule('Skill(mail)', 'Bash', JSON.stringify({ skill: 'mail' }))).toBe(false)
  })
})

describe('matchesAllowRule — MCP', () => {
  it('matches the exact namespaced tool', () => {
    expect(matchesAllowRule('mcp__perplexity__search', 'mcp__perplexity__search', undefined)).toBe(true)
  })

  it('a server wildcard covers every tool on that server', () => {
    expect(matchesAllowRule('mcp__perplexity__*', 'mcp__perplexity__search', undefined)).toBe(true)
    expect(matchesAllowRule('mcp__perplexity__*', 'mcp__perplexity__ask', undefined)).toBe(true)
    expect(matchesAllowRule('mcp__perplexity__*', 'mcp__other__search', undefined)).toBe(false)
  })

  it('an exact tool rule does not cover siblings on the same server', () => {
    expect(matchesAllowRule('mcp__perplexity__search', 'mcp__perplexity__ask', undefined)).toBe(false)
  })
})

describe('matchesAllowRule — defensive', () => {
  it('returns false for empty inputs', () => {
    expect(matchesAllowRule('', 'Edit', undefined)).toBe(false)
    expect(matchesAllowRule('Edit', '', undefined)).toBe(false)
  })
})

describe('resolve → match roundtrip', () => {
  it.each([
    ['Skill', JSON.stringify({ skill: 'mail' })],
    ['Edit', JSON.stringify({ file_path: '/work/log.md' })],
    ['Bash', JSON.stringify({ command: 'npm run build' })],
    ['mcp__perplexity__search', undefined],
  ] as const)('specific rule from %s matches the originating request', (tool, input) => {
    const choices = resolveScopedAllowChoices(tool, input)
    const rule = (choices?.specific ?? choices?.broad)!.rule
    expect(matchesAllowRule(rule, tool, input)).toBe(true)
  })

  it.each([
    ['Edit', JSON.stringify({ file_path: '/work/log.md' })],
    ['Bash', JSON.stringify({ command: 'npm run build' })],
    ['mcp__perplexity__search', undefined],
  ] as const)('broad rule from %s also matches the originating request', (tool, input) => {
    const broad = resolveScopedAllowChoices(tool, input)!.broad
    expect(matchesAllowRule(broad.rule, tool, input)).toBe(true)
  })
})

describe('isRulePersisted', () => {
  it('is a membership check against the resolved allow list', () => {
    expect(isRulePersisted(['Edit', 'mcp__perplexity__*'], 'mcp__perplexity__*')).toBe(true)
    expect(isRulePersisted(['Edit'], 'Write')).toBe(false)
  })
})
