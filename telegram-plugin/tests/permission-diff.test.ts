/**
 * Tests for the pure diff synthesizer that powers the durable
 * "🔁 Always allow" flow (#1977).
 *
 * Two layers:
 *   1. Unit — synthesizeAllowRuleDiff covers the three structural
 *      cases (flow list, block sequence, absent tools.allow), only
 *      touches the target agent in a multi-agent file, and returns
 *      null when the agent is absent. extractAddedAllowRule round-trips.
 *   2. End-to-end — feed each synthesized diff + a realistic, fully
 *      schema-valid fixture switchroom.yaml through `validateConfigEdit`
 *      (the real hostd validation pipeline, which runs
 *      `git apply --recount` then zod) and assert ok===true and the
 *      rule lands under the right agent. This is the load-bearing proof
 *      that the synthesizer emits git-apply-compatible diffs with
 *      byte-matching context lines AND that the post-apply yaml still
 *      validates. Requires `git` on PATH.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  synthesizeAllowRuleDiff,
  extractAddedAllowRule,
} from '../permission-diff.js'
import { validateConfigEdit } from '../../src/host-control/config-edit-validator.js'

const TARGET = '/state/config/switchroom.yaml'

/**
 * A schema-valid switchroom.yaml header. The validator runs the post-
 * apply content through the real SwitchroomConfigSchema (zod), so the
 * fixtures must be complete configs, not just `agents:` fragments.
 */
const HEADER = [
  'switchroom:',
  '  version: 1',
  'telegram:',
  "  bot_token: vault:telegram-bot-token",
  "  forum_chat_id: '-1001234567890'",
].join('\n')

/** Build a complete config from an `agents:` body. */
function cfgWith(agentsBody: string): string {
  return `${HEADER}\nagents:\n${agentsBody}\n`
}

/** Run the synthesized diff through the real hostd validator + apply. */
function applyViaValidator(configText: string, unifiedDiff: string) {
  const dir = mkdtempSync(join(tmpdir(), 'perm-diff-'))
  const cfgPath = join(dir, 'switchroom.yaml')
  try {
    writeFileSync(cfgPath, configText)
    return validateConfigEdit({
      configPath: cfgPath,
      targetPath: TARGET,
      unifiedDiff,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function allowListFor(yamlText: string, agent: string): string[] {
  const data = parseYaml(yamlText) as {
    agents?: Record<string, { tools?: { allow?: string[] } }>
  }
  return data.agents?.[agent]?.tools?.allow ?? []
}

describe('synthesizeAllowRuleDiff — structural cases', () => {
  it('(a) flow list with elements: appends before the closing ]', () => {
    const cfg = cfgWith(
      [
        '  clerk:',
        '    topic_name: clerk',
        '    purpose: clerk',
        '    tools:',
        '      allow: [Read, Grep]',
        '    model: opus',
      ].join('\n'),
    )
    const diff = synthesizeAllowRuleDiff({ agentName: 'clerk', rule: 'Bash', configText: cfg })
    expect(diff).not.toBeNull()
    expect(diff).toContain('--- a/switchroom.yaml')
    expect(diff).toContain('+++ b/switchroom.yaml')
    const res = applyViaValidator(cfg, diff!)
    expect(res).toMatchObject({ ok: true })
    if (res.ok) {
      expect(allowListFor(res.postApplyContent, 'clerk')).toEqual(['Read', 'Grep', 'Bash'])
    }
  })

  it('(a) flow list "[ all ]": appends, all preserved', () => {
    const cfg = cfgWith(
      [
        '  ziggy:',
        '    topic_name: ziggy',
        '    purpose: ziggy',
        '    tools:',
        '      allow: [ all ]',
        '    model: opus',
      ].join('\n'),
    )
    const diff = synthesizeAllowRuleDiff({ agentName: 'ziggy', rule: 'Skill(mail)', configText: cfg })
    expect(diff).not.toBeNull()
    const res = applyViaValidator(cfg, diff!)
    expect(res).toMatchObject({ ok: true })
    if (res.ok) {
      const allow = allowListFor(res.postApplyContent, 'ziggy')
      expect(allow).toContain('all')
      expect(allow).toContain('Skill(mail)')
    }
  })

  it('(b) block sequence: inserts after the last - entry', () => {
    const cfg = cfgWith(
      [
        '  klanker:',
        '    topic_name: klanker',
        '    purpose: klanker',
        '    tools:',
        '      allow:',
        '        - Bash',
        '        - Read',
        '    model: opus',
      ].join('\n'),
    )
    const diff = synthesizeAllowRuleDiff({ agentName: 'klanker', rule: 'mcp__notion__search', configText: cfg })
    expect(diff).not.toBeNull()
    const res = applyViaValidator(cfg, diff!)
    expect(res).toMatchObject({ ok: true })
    if (res.ok) {
      expect(allowListFor(res.postApplyContent, 'klanker')).toEqual(['Bash', 'Read', 'mcp__notion__search'])
    }
  })

  it('(c) tools.allow absent: inserts tools/allow/rule under the agent', () => {
    const cfg = cfgWith(
      [
        '  carrie:',
        '    topic_name: carrie',
        '    purpose: carrie',
        '    model: sonnet',
        '    role: assistant',
      ].join('\n'),
    )
    const diff = synthesizeAllowRuleDiff({ agentName: 'carrie', rule: 'WebFetch', configText: cfg })
    expect(diff).not.toBeNull()
    const res = applyViaValidator(cfg, diff!)
    expect(res).toMatchObject({ ok: true })
    if (res.ok) {
      expect(allowListFor(res.postApplyContent, 'carrie')).toEqual(['WebFetch'])
    }
  })

  it('(c) tools present but no allow: key: inserts allow block under tools', () => {
    const cfg = cfgWith(
      [
        '  finn:',
        '    topic_name: finn',
        '    purpose: finn',
        '    tools:',
        '      deny:',
        '        - Bash',
        '    model: opus',
      ].join('\n'),
    )
    const diff = synthesizeAllowRuleDiff({ agentName: 'finn', rule: 'Read', configText: cfg })
    expect(diff).not.toBeNull()
    const res = applyViaValidator(cfg, diff!)
    expect(res).toMatchObject({ ok: true })
    if (res.ok) {
      expect(allowListFor(res.postApplyContent, 'finn')).toEqual(['Read'])
    }
  })

  it('multi-agent: only the target agent is touched', () => {
    const cfg = cfgWith(
      [
        '  clerk:',
        '    topic_name: clerk',
        '    purpose: clerk',
        '    tools:',
        '      allow:',
        '        - Read',
        '  ziggy:',
        '    topic_name: ziggy',
        '    purpose: ziggy',
        '    tools:',
        '      allow:',
        '        - Bash',
        '  reggie:',
        '    topic_name: reggie',
        '    purpose: reggie',
        '    tools:',
        '      allow: [Grep]',
      ].join('\n'),
    )
    const diff = synthesizeAllowRuleDiff({ agentName: 'ziggy', rule: 'Write', configText: cfg })
    expect(diff).not.toBeNull()
    const res = applyViaValidator(cfg, diff!)
    expect(res).toMatchObject({ ok: true })
    if (res.ok) {
      expect(allowListFor(res.postApplyContent, 'clerk')).toEqual(['Read'])
      expect(allowListFor(res.postApplyContent, 'ziggy')).toEqual(['Bash', 'Write'])
      expect(allowListFor(res.postApplyContent, 'reggie')).toEqual(['Grep'])
    }
  })

  it('returns null when the agent is absent', () => {
    const cfg = cfgWith(
      ['  clerk:', '    topic_name: clerk',
        '    purpose: clerk', '    tools:', '      allow: [Read]'].join('\n'),
    )
    expect(synthesizeAllowRuleDiff({ agentName: 'nope', rule: 'Bash', configText: cfg })).toBeNull()
  })

  it('returns null when there is no agents block at all', () => {
    expect(
      synthesizeAllowRuleDiff({ agentName: 'clerk', rule: 'Bash', configText: 'defaults:\n  model: opus\n' }),
    ).toBeNull()
  })
})

describe('extractAddedAllowRule — round-trips the synthesized diff', () => {
  it('block-sequence add', () => {
    const cfg = cfgWith(
      ['  clerk:', '    topic_name: clerk',
        '    purpose: clerk', '    tools:', '      allow:', '        - Bash', '        - Read'].join('\n'),
    )
    const diff = synthesizeAllowRuleDiff({ agentName: 'clerk', rule: 'mcp__x__y', configText: cfg })!
    expect(extractAddedAllowRule(diff)).toBe('mcp__x__y')
  })

  it('flow-list append', () => {
    const cfg = cfgWith(['  clerk:', '    topic_name: clerk',
        '    purpose: clerk', '    tools:', '      allow: [Read, Grep]', '    model: opus'].join('\n'))
    const diff = synthesizeAllowRuleDiff({ agentName: 'clerk', rule: 'Bash', configText: cfg })!
    expect(extractAddedAllowRule(diff)).toBe('Bash')
  })

  it('flow-list append into [ all ]', () => {
    const cfg = cfgWith(['  clerk:', '    topic_name: clerk',
        '    purpose: clerk', '    tools:', '      allow: [ all ]', '    model: opus'].join('\n'))
    const diff = synthesizeAllowRuleDiff({ agentName: 'clerk', rule: 'Skill(mail)', configText: cfg })!
    expect(extractAddedAllowRule(diff)).toBe('Skill(mail)')
  })

  it('absent tools.allow (case c) — extracts the single added rule', () => {
    const cfg = cfgWith(['  carrie:', '    topic_name: carrie',
        '    purpose: carrie', '    model: sonnet', '    role: assistant'].join('\n'))
    const diff = synthesizeAllowRuleDiff({ agentName: 'carrie', rule: 'WebFetch', configText: cfg })!
    expect(extractAddedAllowRule(diff)).toBe('WebFetch')
  })

  it('returns null for a diff that adds something other than a tools.allow rule', () => {
    // A hand-built diff that changes a `model:` field — must NOT be
    // mistaken for an allow-rule add (forge-resistance).
    const forged = [
      '--- a/switchroom.yaml',
      '+++ b/switchroom.yaml',
      '@@ -1,3 +1,3 @@',
      ' agents:',
      '   clerk:',
      '-    model: sonnet',
      '+    model: opus',
      '',
    ].join('\n')
    expect(extractAddedAllowRule(forged)).toBeNull()
  })

  it('returns null for a multi-rule diff (strict single-add only)', () => {
    const forged = [
      '--- a/switchroom.yaml',
      '+++ b/switchroom.yaml',
      '@@ -1,2 +1,4 @@',
      ' agents:',
      '   clerk:',
      '+        - Bash',
      '+        - Read',
      '',
    ].join('\n')
    expect(extractAddedAllowRule(forged)).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(extractAddedAllowRule('')).toBeNull()
  })
})
