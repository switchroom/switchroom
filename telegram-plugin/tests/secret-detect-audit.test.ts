import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { emitAudit, setAuditSink } from '../secret-detect/audit.js'

describe('secret-detect audit log', () => {
  const captured: string[] = []
  beforeEach(() => {
    captured.length = 0
    setAuditSink((line) => captured.push(line))
  })
  afterEach(() => {
    setAuditSink(null)
  })

  it('emits a structured event with slug but never the raw value', () => {
    const raw = 'sk-ant-Apq13yqRnPzx4MxK0TfAbY98Qw22'
    emitAudit({
      chat_id: '-100',
      message_id: 5,
      rule_id: 'anthropic_api_key',
      slug: 'ANTHROPIC_API_KEY',
      action: 'stored',
      delete_ok: true,
    })
    expect(captured).toHaveLength(1)
    const line = captured[0]!
    expect(line).toContain('[secret-detect-audit]')
    expect(line).toContain('"rule_id":"anthropic_api_key"')
    expect(line).toContain('"slug":"ANTHROPIC_API_KEY"')
    expect(line).toContain('"action":"stored"')
    expect(line).toContain('"delete_ok":true')
    // Never the raw value.
    expect(line).not.toContain(raw)
    expect(line).not.toContain('Apq13yqRnPzx4MxK0TfAbY98Qw22')
  })

  it('serializes all required fields', () => {
    emitAudit({
      chat_id: '12345',
      message_id: 99,
      rule_id: 'openai_api_key',
      slug: 'OPENAI_KEY',
      action: 'ambiguous',
      delete_ok: false,
      ts: 1_700_000_000,
    })
    const parsed = JSON.parse(captured[0]!.replace('[secret-detect-audit] ', ''))
    expect(parsed).toEqual({
      event: 'secret-detected',
      chat_id: '12345',
      message_id: 99,
      rule_id: 'openai_api_key',
      slug: 'OPENAI_KEY',
      action: 'ambiguous',
      delete_ok: false,
      ts: 1_700_000_000,
    })
  })
})
