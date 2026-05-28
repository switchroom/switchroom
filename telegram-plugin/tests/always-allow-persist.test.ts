/**
 * Behavioral tests for the always-allow grant verification helper
 * (`isRulePersisted` in `permission-rule.ts`).
 *
 * The `perm:always:*` handler in gateway.ts calls `isRulePersisted` after
 * `switchroom agent grant` returns to confirm the rule actually landed in
 * `tools.allow`. These tests drive the invariants that the structural test
 * in `always-allow-grant.test.ts` can only pin by text-slicing:
 *
 *   1. exec "succeeds" but the reloaded allow-list does NOT contain the
 *      rule  →  isRulePersisted returns false  (loud-failure path).
 *   2. reloaded allow-list DOES contain the rule  →  returns true
 *      (success path).
 *   3. Realistic rule values (`Skill(garmin)`, `Bash`, `mcp__x__y`) round-
 *      trip correctly — guards against normalization divergence where the
 *      value written by `agent grant` and the value read back from yaml
 *      diverge in shape.
 *
 * Because `isRulePersisted` is a pure function (takes the already-resolved
 * allow-list directly), no mocking of `loadSwitchroomConfig` /
 * `resolveAgentConfig` is required here.  The handler's interaction with
 * those config loaders is covered by the structural test.
 */

import { describe, it, expect } from 'vitest'
import { isRulePersisted, resolveAlwaysAllowRule } from '../permission-rule.js'

// ---------------------------------------------------------------------------
// Core behavioral invariants
// ---------------------------------------------------------------------------

describe('isRulePersisted — failure path', () => {
  it('returns false when the allow-list is empty (exec succeeded but nothing was written)', () => {
    expect(isRulePersisted([], 'Bash')).toBe(false)
  })

  it('returns false when the rule is absent from a non-empty allow-list', () => {
    expect(isRulePersisted(['Read', 'Write', 'Edit'], 'Bash')).toBe(false)
  })

  it('returns false for a Skill rule when the list only contains the bare tool name', () => {
    // `agent grant` for Skill(garmin) should write `Skill(garmin)`, not
    // `Skill`. If the yaml ended up with the wrong shape, the verification
    // must catch it.
    expect(isRulePersisted(['Skill'], 'Skill(garmin)')).toBe(false)
  })

  it('returns false for a bare tool name when only the parameterized form is present', () => {
    expect(isRulePersisted(['Skill(garmin)'], 'Bash')).toBe(false)
  })

  it('returns false when a similar-looking rule is present but not an exact match', () => {
    expect(isRulePersisted(['mcp__garmin__read_activity'], 'mcp__garmin__list_activities')).toBe(false)
  })
})

describe('isRulePersisted — success path', () => {
  it('returns true when the exact rule is present', () => {
    expect(isRulePersisted(['Read', 'Bash', 'Write'], 'Bash')).toBe(true)
  })

  it('returns true when the rule is the only entry', () => {
    expect(isRulePersisted(['Skill(garmin)'], 'Skill(garmin)')).toBe(true)
  })

  it('returns true for a namespaced MCP tool rule', () => {
    expect(isRulePersisted(['mcp__garmin__list_activities', 'Bash'], 'mcp__garmin__list_activities')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Round-trip: resolveAlwaysAllowRule → isRulePersisted
// Simulates the full handler flow: resolve the rule from a permission_request,
// "grant" it (allow-list contains the resolved rule.rule), then verify.
// Guards against normalization divergence between the value the handler
// resolves and the value `agent grant` writes + the config reader returns.
// ---------------------------------------------------------------------------

describe('rule round-trip through isRulePersisted', () => {
  it('Skill tool: resolved rule persists correctly', () => {
    const rule = resolveAlwaysAllowRule('Skill', JSON.stringify({ skill: 'garmin' }))
    expect(rule).not.toBeNull()
    // Simulate: allow-list now contains the rule that `agent grant` wrote.
    expect(isRulePersisted([rule!.rule], rule!.rule)).toBe(true)
    // Confirm the written form is `Skill(garmin)` — not a bare `Skill`.
    expect(rule!.rule).toBe('Skill(garmin)')
  })

  it('Skill tool: absent rule is detected', () => {
    const rule = resolveAlwaysAllowRule('Skill', JSON.stringify({ skill: 'garmin' }))
    expect(rule).not.toBeNull()
    // allow-list was not updated (silent grant failure).
    expect(isRulePersisted([], rule!.rule)).toBe(false)
    expect(isRulePersisted(['Skill'], rule!.rule)).toBe(false)
  })

  it('Bash tool: round-trips correctly', () => {
    const rule = resolveAlwaysAllowRule('Bash', undefined)
    expect(rule).not.toBeNull()
    expect(rule!.rule).toBe('Bash')
    expect(isRulePersisted(['Bash', 'Read'], rule!.rule)).toBe(true)
    expect(isRulePersisted(['Read'], rule!.rule)).toBe(false)
  })

  it('MCP tool: round-trips with exact namespaced form', () => {
    const toolName = 'mcp__garmin__list_activities'
    const rule = resolveAlwaysAllowRule(toolName, undefined)
    expect(rule).not.toBeNull()
    expect(rule!.rule).toBe(toolName)
    expect(isRulePersisted([toolName], rule!.rule)).toBe(true)
    expect(isRulePersisted(['mcp__garmin__read_activity'], rule!.rule)).toBe(false)
  })

  it('multiple Skill tools do not cross-contaminate', () => {
    const garmin = resolveAlwaysAllowRule('Skill', JSON.stringify({ skill: 'garmin' }))
    const mail = resolveAlwaysAllowRule('Skill', JSON.stringify({ skill: 'mail' }))
    expect(garmin).not.toBeNull()
    expect(mail).not.toBeNull()
    // Allow-list only has garmin's rule.
    const allowList = [garmin!.rule]
    expect(isRulePersisted(allowList, garmin!.rule)).toBe(true)
    expect(isRulePersisted(allowList, mail!.rule)).toBe(false)
  })
})
