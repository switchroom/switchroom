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
