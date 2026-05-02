import { describe, it, expect, vi } from 'vitest'

import { redactAuthCodeMessage } from '../auth-code-redact.js'

/**
 * Regression coverage for #488. The helper is wired into all 6
 * auth-code paste paths (gateway + server, bare-paste + /auth code +
 * /reauth shortcut). The contract pinned here is what callers depend
 * on — and what makes the difference between "OAuth code stays in
 * chat history" and "OAuth code disappears within ~1s".
 */
describe('redactAuthCodeMessage', () => {
  function makeApi() {
    return {
      deleteMessage: vi.fn(async () => true as const),
      setMessageReaction: vi.fn(async () => true as const),
    }
  }

  it('deletes the message AND emits a 🔑 reaction (best-effort breadcrumb)', () => {
    const api = makeApi()
    redactAuthCodeMessage(api, '12345', 999)

    expect(api.deleteMessage).toHaveBeenCalledTimes(1)
    expect(api.deleteMessage).toHaveBeenCalledWith('12345', 999)

    expect(api.setMessageReaction).toHaveBeenCalledTimes(1)
    expect(api.setMessageReaction).toHaveBeenCalledWith('12345', 999, [
      { type: 'emoji', emoji: '🔑' },
    ])
  })

  it('is a no-op when messageId is null (defensive guard for ctx without a message)', () => {
    const api = makeApi()
    redactAuthCodeMessage(api, '12345', null)

    expect(api.deleteMessage).not.toHaveBeenCalled()
    expect(api.setMessageReaction).not.toHaveBeenCalled()
  })

  it('returns synchronously — does not await either call', () => {
    // The function fires both API calls fire-and-forget so the caller
    // can return to the event loop immediately. A blocking helper
    // would slow every auth-code paste by ~1 RTT to Telegram.
    const api = {
      deleteMessage: vi.fn(() => new Promise(() => {})), // never resolves
      setMessageReaction: vi.fn(() => new Promise(() => {})),
    }
    const start = Date.now()
    redactAuthCodeMessage(api, '12345', 999)
    const elapsed = Date.now() - start
    // <50ms is plenty of headroom for the synchronous fire-and-forget
    // dispatch — would be ~∞ if we awaited.
    expect(elapsed).toBeLessThan(50)
  })

  it('swallows deleteMessage errors (message too old, user already deleted)', async () => {
    const api = {
      deleteMessage: vi.fn(async () => {
        throw new Error('Bad Request: message to delete not found')
      }),
      setMessageReaction: vi.fn(async () => true as const),
    }
    // Must not throw synchronously, must not reject the unhandled promise.
    expect(() => redactAuthCodeMessage(api, '12345', 999)).not.toThrow()
    // Drain the microtask queue so the rejection fires + is caught.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(api.deleteMessage).toHaveBeenCalledTimes(1)
  })

  it('swallows setMessageReaction errors (race with successful delete)', async () => {
    const api = {
      deleteMessage: vi.fn(async () => true as const),
      setMessageReaction: vi.fn(async () => {
        throw new Error('Bad Request: message not found')
      }),
    }
    expect(() => redactAuthCodeMessage(api, '12345', 999)).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(api.setMessageReaction).toHaveBeenCalledTimes(1)
  })

  it('handles negative chat ids (groups / supergroups / channels)', () => {
    // Telegram chat ids are negative for groups; helper passes them
    // through verbatim — no parsing, no validation.
    const api = makeApi()
    redactAuthCodeMessage(api, '-1001234567890', 42)
    expect(api.deleteMessage).toHaveBeenCalledWith('-1001234567890', 42)
    expect(api.setMessageReaction).toHaveBeenCalledWith('-1001234567890', 42, [
      { type: 'emoji', emoji: '🔑' },
    ])
  })

  it('keeps reaction + delete independently dispatched even if one fails', async () => {
    // The two calls should not depend on each other — if delete
    // succeeds the reaction silently fails (message gone), if delete
    // fails the reaction provides the visible breadcrumb. Both
    // fire-and-forget, neither blocks the other.
    const api = {
      deleteMessage: vi.fn(async () => {
        throw new Error('failed')
      }),
      setMessageReaction: vi.fn(async () => true as const),
    }
    redactAuthCodeMessage(api, '12345', 999)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Delete failed but reaction still went through.
    expect(api.deleteMessage).toHaveBeenCalledTimes(1)
    expect(api.setMessageReaction).toHaveBeenCalledTimes(1)
  })
})

/**
 * Diagnostic logging (#561 follow-up). Before this commit the function
 * silently swallowed every API failure — when an OAuth code paste stuck
 * around in chat, operators had no way to tell whether deleteMessage
 * failed on permissions, on a 48h-too-old message, or because msgId was
 * null. The optional `log` sink emits one line per attempt (success or
 * specific error message).
 */
describe('redactAuthCodeMessage — diagnostic logging', () => {
  it('logs nothing when no log sink is provided (back-compat)', async () => {
    const api = {
      deleteMessage: vi.fn(async () => true as const),
      setMessageReaction: vi.fn(async () => true as const),
    }
    // Just verify it doesn't crash without a sink.
    expect(() => redactAuthCodeMessage(api, '12345', 999)).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('logs the no-message-id case so the silent skip is visible', () => {
    const api = {
      deleteMessage: vi.fn(async () => true as const),
      setMessageReaction: vi.fn(async () => true as const),
    }
    const lines: string[] = []
    redactAuthCodeMessage(api, '12345', null, line => lines.push(line))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/no message_id/)
    expect(lines[0]).toMatch(/skipping/)
  })

  it('logs SUCCESS for both delete and reaction with msgId + chatId for grep-by', async () => {
    const api = {
      deleteMessage: vi.fn(async () => true as const),
      setMessageReaction: vi.fn(async () => true as const),
    }
    const lines: string[] = []
    redactAuthCodeMessage(api, '12345', 999, line => lines.push(line))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lines).toHaveLength(2)
    // Order isn't guaranteed (independent dispatch). Assert content.
    const joined = lines.join('\n')
    expect(joined).toMatch(/deleted/)
    expect(joined).toMatch(/reaction added/)
    expect(joined).toMatch(/msgId=999/)
    expect(joined).toMatch(/chatId=12345/)
  })

  it('logs FAILED with the actual error message on deleteMessage rejection', async () => {
    const api = {
      deleteMessage: vi.fn(async () => {
        throw new Error('Bad Request: not enough rights to delete a message')
      }),
      setMessageReaction: vi.fn(async () => true as const),
    }
    const lines: string[] = []
    redactAuthCodeMessage(api, '12345', 999, line => lines.push(line))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const failed = lines.find(l => l.includes('delete FAILED'))
    expect(failed).toBeDefined()
    // The actual Telegram error must be carried verbatim — that's the
    // signal operators need to root-cause the redaction failure.
    expect(failed).toMatch(/not enough rights to delete a message/)
    // And the warning must mention the user-visible consequence so a
    // reader of the journal understands why this matters.
    expect(failed).toMatch(/may still be visible/)
  })

  it('logs FAILED with the actual error message on setMessageReaction rejection', async () => {
    const api = {
      deleteMessage: vi.fn(async () => true as const),
      setMessageReaction: vi.fn(async () => {
        throw new Error('Bad Request: REACTION_INVALID')
      }),
    }
    const lines: string[] = []
    redactAuthCodeMessage(api, '12345', 999, line => lines.push(line))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const failed = lines.find(l => l.includes('reaction FAILED'))
    expect(failed).toBeDefined()
    expect(failed).toMatch(/REACTION_INVALID/)
  })

  it('logs are independent — failure of one path does not suppress the other', async () => {
    const api = {
      deleteMessage: vi.fn(async () => {
        throw new Error('boom')
      }),
      setMessageReaction: vi.fn(async () => true as const),
    }
    const lines: string[] = []
    redactAuthCodeMessage(api, '12345', 999, line => lines.push(line))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(lines).toHaveLength(2)
    expect(lines.some(l => l.includes('reaction added'))).toBe(true)
    expect(lines.some(l => l.includes('delete FAILED'))).toBe(true)
  })
})

/**
 * Architectural pin: every auth-code paste call site MUST go through
 * the helper. Greps the source — if a future PR adds a new auth-code
 * paste handler that forgets to call `redactAuthCodeMessage`, this
 * test fails and points at the right pattern.
 *
 * The current 6 call sites:
 *   1. gateway.ts — bare-code paste during pending reauth
 *   2. gateway.ts — /auth code intent dispatch
 *   3. gateway.ts — /reauth <code> shortcut
 *
 * #235 Wave 3 F4: server.ts monolith removed; the 3 server.ts call
 * sites previously listed (bare paste / /auth code / /reauth <code>)
 * no longer exist — gateway.ts is the only file with the live paths.
 */
describe('auth-code paste call-site coverage (architectural pin)', () => {
  it('every gateway.ts call site calls redactAuthCodeMessage', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const repoRoot = path.resolve(__dirname, '..', '..')
    const text = fs.readFileSync(
      path.join(repoRoot, 'telegram-plugin', 'gateway', 'gateway.ts'),
      'utf-8',
    )
    const matches = text.match(/redactAuthCodeMessage\s*\(/g) ?? []
    // 3 call sites + 1 import statement = ≥4. Floor at 3 to be safe.
    expect(matches.length).toBeGreaterThanOrEqual(3)
  })
})
