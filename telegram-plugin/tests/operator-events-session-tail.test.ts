/**
 * Tests for session-tail ↔ operator-events integration:
 *   - detectErrorInTranscriptLine (exported from session-tail)
 *   - onOperatorEvent callback wiring in startSessionTail
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { detectErrorInTranscriptLine, startSessionTail } from '../session-tail.js'
import { resetAllCooldowns } from '../operator-events.js'

// ─── detectErrorInTranscriptLine unit tests ───────────────────────────────────

describe('detectErrorInTranscriptLine — error detection', () => {
  it('returns null for non-error lines', () => {
    expect(detectErrorInTranscriptLine('')).toBeNull()
    expect(detectErrorInTranscriptLine('not json')).toBeNull()
    expect(
      detectErrorInTranscriptLine(JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1000 }))
    ).toBeNull()
    expect(
      detectErrorInTranscriptLine(JSON.stringify({ type: 'assistant', message: { content: [] } }))
    ).toBeNull()
  })

  it('detects type=api_error lines', () => {
    const line = JSON.stringify({
      type: 'api_error',
      error: { type: 'authentication_error', message: 'Invalid API key' },
    })
    const result = detectErrorInTranscriptLine(line)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('credentials-invalid')
    expect(result!.detail).toContain('Invalid API key')
  })

  it('detects type=error lines', () => {
    const line = JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Rate limit exceeded' },
    })
    const result = detectErrorInTranscriptLine(line)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('rate-limited')
  })

  it('detects lines with embedded error object (no explicit error type)', () => {
    const line = JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      error: { type: 'credit_balance_too_low', message: 'Credit balance too low' },
    })
    const result = detectErrorInTranscriptLine(line)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('credit-exhausted')
  })

  it('classifies overloaded_error as rate-limited (transient), NOT quota-exhausted', () => {
    // A 529 "overloaded" is transient Anthropic server-capacity
    // pressure — orthogonal to account quota. Classifying it
    // quota-exhausted fired a false "Model unavailable" card + a
    // self-cancelling fleet auto-fallback on every 529.
    const line = JSON.stringify({
      type: 'api_error',
      error: { type: 'overloaded_error', message: 'Overloaded' },
    })
    const result = detectErrorInTranscriptLine(line)
    expect(result!.kind).toBe('rate-limited')
    expect(result!.transient).toBe(true)
    // An explicit `type:"api_error"` line (no retry state) = Claude
    // surfaced the failure → terminal.
    expect(result!.terminal).toBe(true)
  })

  it('marks an in-flight 529 retry transient + NOT terminal (suppressed)', () => {
    // Real on-disk shape: a 529 Claude Code is internally retrying,
    // annotated with retryAttempt < maxRetries.
    const line = JSON.stringify({
      type: 'system',
      subtype: 'api_error',
      error: { status: 529, type: 'overloaded_error', message: 'Overloaded' },
      retryAttempt: 9,
      maxRetries: 10,
      retryInMs: 34479,
    })
    const result = detectErrorInTranscriptLine(line)
    expect(result!.kind).toBe('rate-limited')
    expect(result!.transient).toBe(true)
    // 9 < 10 — still retrying → in-flight → the caller suppresses it.
    expect(result!.terminal).toBe(false)
  })

  it('marks an exhausted 529 retry terminal (escalates)', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'api_error',
      error: { status: 529, type: 'overloaded_error', message: 'Overloaded' },
      retryAttempt: 10,
      maxRetries: 10,
    })
    const result = detectErrorInTranscriptLine(line)
    expect(result!.kind).toBe('rate-limited')
    expect(result!.transient).toBe(true)
    // retries exhausted → terminal → escalates.
    expect(result!.terminal).toBe(true)
  })

  it('marks non-transient errors terminal (always escalate)', () => {
    const line = JSON.stringify({
      type: 'api_error',
      error: { type: 'authentication_error', message: 'expired' },
    })
    const result = detectErrorInTranscriptLine(line)
    expect(result!.transient).toBe(false)
    expect(result!.terminal).toBe(true)
  })

  it('returns null for lines without error field', () => {
    const line = JSON.stringify({ type: 'user', message: { content: [] } })
    expect(detectErrorInTranscriptLine(line)).toBeNull()
  })

  // Regression — the fleet-auto-failover dead-zone. Claude Code v2.1.x
  // records a usage-limit hit as a synthetic assistant message with
  // isApiErrorMessage:true (no api_error type, no nested error OBJECT).
  // Pre-fix, detectErrorInTranscriptLine missed it entirely → the
  // operator-event path never ran → fleet auto-fallback never fired.
  it('detects the v2.1.x synthetic-assistant-message usage-limit shape', () => {
    // The exact on-disk line shape, verbatim from a real quota hit.
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: '<synthetic>',
        content: [
          {
            type: 'text',
            text: "You've hit your limit · resets 8:50am (Australia/Melbourne)",
          },
        ],
      },
      error: 'rate_limit',
      isApiErrorMessage: true,
      apiErrorStatus: 429,
    })
    const result = detectErrorInTranscriptLine(line)
    expect(result).not.toBeNull()
    // A 429 in this shape is a subscription usage-limit hit → must
    // classify quota-exhausted so the operator event resolves to an
    // auto-fallback-eligible kind.
    expect(result!.kind).toBe('quota-exhausted')
    // The user-facing text must survive into `detail` (the model-
    // unavailable card + the text-pattern path both rely on it).
    expect(result!.detail).toContain('hit your limit')
  })

  it('still returns null for a normal (non-error) assistant message', () => {
    // No isApiErrorMessage flag → must NOT be treated as an error.
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
    })
    expect(detectErrorInTranscriptLine(line)).toBeNull()
  })

  it('returns null for lines with null error field', () => {
    const line = JSON.stringify({ type: 'assistant', error: null })
    expect(detectErrorInTranscriptLine(line)).toBeNull()
  })

  it('never throws on malformed input', () => {
    const badInputs = [
      '',
      'x'.repeat(3 * 1024 * 1024), // over size limit
      '{"type":',
      JSON.stringify({ type: 'api_error', error: 42 }),
      JSON.stringify({ type: 'error', error: null }),
    ]
    for (const input of badInputs) {
      expect(() => detectErrorInTranscriptLine(input)).not.toThrow()
    }
  })

  it('credentials-expired classified from expired-hint message', () => {
    const line = JSON.stringify({
      type: 'api_error',
      error: { type: 'authentication_error', message: 'OAuth token expired' },
    })
    const result = detectErrorInTranscriptLine(line)
    expect(result!.kind).toBe('credentials-expired')
  })

  it('agent-crashed classified from synthetic error code', () => {
    const line = JSON.stringify({
      type: 'api_error',
      error: { type: 'agent-crashed', message: 'Process exit code 1' },
    })
    const result = detectErrorInTranscriptLine(line)
    expect(result!.kind).toBe('agent-crashed')
  })
})

// ─── startSessionTail onOperatorEvent integration ─────────────────────────────

describe('startSessionTail — onOperatorEvent callback', () => {
  it('fires onOperatorEvent when session file contains an api_error line', async () => {
    resetAllCooldowns()
    const tmpDir = mkdtempSync(join(tmpdir(), 'op-ev-test-'))
    try {
      const claudeHome = join(tmpDir, '.claude')
      const projectsDir = join(claudeHome, 'projects', '-tmp-test-agent')
      mkdirSync(projectsDir, { recursive: true })
      const sessionFile = join(projectsDir, 'test-session.jsonl')
      // Write a non-error line first so the tail has a file to attach to
      writeFileSync(sessionFile, JSON.stringify({ type: 'system', subtype: 'init' }) + '\n')

      const operatorEvents: Array<{ kind: string; detail: string }> = []
      const tail = startSessionTail({
        cwd: '/tmp/test-agent',
        claudeHome,
        rescanIntervalMs: 50,
        onEvent: () => {},
        onOperatorEvent: (ev) => {
          operatorEvents.push({ kind: ev.kind, detail: ev.detail })
        },
      })

      // Wait for initial attach
      await new Promise(r => setTimeout(r, 150))

      // Append an error line
      appendFileSync(
        sessionFile,
        JSON.stringify({
          type: 'api_error',
          error: { type: 'rate_limit_error', message: 'Too many requests' },
        }) + '\n',
      )

      // Wait for the tail to pick it up
      await new Promise(r => setTimeout(r, 300))
      tail.stop()

      expect(operatorEvents.length).toBeGreaterThanOrEqual(1)
      expect(operatorEvents[0].kind).toBe('rate-limited')
      expect(operatorEvents[0].detail).toContain('Too many requests')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('does not fire onOperatorEvent for routine lines', async () => {
    resetAllCooldowns()
    const tmpDir = mkdtempSync(join(tmpdir(), 'op-ev-test-noroutine-'))
    try {
      const claudeHome = join(tmpDir, '.claude')
      const projectsDir = join(claudeHome, 'projects', '-tmp-test-noroutine')
      mkdirSync(projectsDir, { recursive: true })
      const sessionFile = join(projectsDir, 'test-session.jsonl')
      writeFileSync(sessionFile, JSON.stringify({ type: 'system', subtype: 'init' }) + '\n')

      const operatorEvents: unknown[] = []
      const tail = startSessionTail({
        cwd: '/tmp/test-noroutine',
        claudeHome,
        rescanIntervalMs: 50,
        onEvent: () => {},
        onOperatorEvent: (ev) => operatorEvents.push(ev),
      })

      await new Promise(r => setTimeout(r, 150))

      // Only routine lines
      appendFileSync(sessionFile, JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 500 }) + '\n')
      appendFileSync(sessionFile, JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\n')

      await new Promise(r => setTimeout(r, 300))
      tail.stop()

      expect(operatorEvents).toHaveLength(0)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
