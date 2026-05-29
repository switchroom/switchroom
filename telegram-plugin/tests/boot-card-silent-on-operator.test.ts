/**
 * Pin the contract: the boot card ALWAYS silences its Telegram
 * notification (passes `disable_notification: true` to `sendMessage`),
 * regardless of what triggered the restart.
 *
 * Background: every agent in the fleet posts a boot card after a
 * restart. A boot card is a status RECORD ("✅ <agent> back up ·
 * vX.Y.Z") that lands in the chat for scroll-back — it is never
 * something that should buzz a phone. A fleet redeploy of N agents
 * would otherwise produce N push notifications; even a single user
 * `/restart` or a crash-recovery is a record, not an alert.
 *
 * History: this used to be keyed on the `operator:` reason-detail
 * prefix — only routine `switchroom update` was silent, while user
 * `/restart`, `cli: switchroom restart` rollouts, crashes, and fresh
 * boots all still notified. Operator decision (2026-05-29): silence
 * them all, unconditionally. These cases now assert the inverse of
 * what they originally pinned, across every reason path, so a future
 * regression that re-introduces a notifying boot card is caught.
 */

import { describe, it, expect } from 'vitest'
import { startBootCard } from '../gateway/boot-card.js'
import type { BotApiForBootCard } from '../gateway/boot-card.js'

/** Capture sendMessage opts for assertion. editMessageText is a no-op. */
function makeCapturingBot(): {
  bot: BotApiForBootCard
  sends: Array<{ chatId: string; text: string; opts: Record<string, unknown> }>
} {
  const sends: Array<{ chatId: string; text: string; opts: Record<string, unknown> }> = []
  const bot: BotApiForBootCard = {
    sendMessage: async (chatId, text, opts) => {
      sends.push({ chatId, text, opts: opts ?? {} })
      return { message_id: 42 }
    },
    editMessageText: async () => ({}),
  }
  return { bot, sends }
}

/** Common opts — only the reason-detail varies per test. */
function mkOpts(overrides: { restartReasonDetail?: string; restartReason?: 'planned' | 'graceful' | 'crash' | 'fresh' } = {}) {
  return {
    agentName: 'TestAgent',
    agentSlug: 'test-agent',
    version: 'v0.0.0-test',
    agentDir: '/tmp/test-agent',
    gatewayInfo: { pid: 1, startedAtMs: Date.now() },
    restartReason: overrides.restartReason ?? 'graceful' as const,
    restartReasonDetail: overrides.restartReasonDetail,
    // Disable the live loop + probes — we only want the initial sendMessage.
    agentLiveWindowMs: 0,
    settleWindowMs: 1_000_000,
  }
}

describe('boot card — always silent (no Telegram notification)', () => {
  it('silences operator-initiated redeploys (operator: switchroom update)', async () => {
    const { bot, sends } = makeCapturingBot()
    await startBootCard('chat1', undefined, bot, mkOpts({ restartReasonDetail: 'operator: switchroom update' }))
    expect(sends).toHaveLength(1)
    expect(sends[0]!.opts.disable_notification).toBe(true)
  })

  it('silences user-initiated restarts (user: /restart from chat)', async () => {
    const { bot, sends } = makeCapturingBot()
    await startBootCard('chat1', undefined, bot, mkOpts({ restartReasonDetail: 'user: /restart from chat' }))
    expect(sends).toHaveLength(1)
    expect(sends[0]!.opts.disable_notification).toBe(true)
  })

  it('silences cli rollouts (cli: switchroom restart)', async () => {
    const { bot, sends } = makeCapturingBot()
    await startBootCard('chat1', undefined, bot, mkOpts({ restartReasonDetail: 'cli: switchroom restart' }))
    expect(sends).toHaveLength(1)
    expect(sends[0]!.opts.disable_notification).toBe(true)
  })

  it('silences crash / fresh boots (restartReasonDetail undefined)', async () => {
    const { bot, sends } = makeCapturingBot()
    await startBootCard('chat1', undefined, bot, mkOpts({ restartReason: 'crash' }))
    expect(sends).toHaveLength(1)
    expect(sends[0]!.opts.disable_notification).toBe(true)
  })

  it('silences when restartReasonDetail is empty string', async () => {
    const { bot, sends } = makeCapturingBot()
    await startBootCard('chat1', undefined, bot, mkOpts({ restartReasonDetail: '' }))
    expect(sends).toHaveLength(1)
    expect(sends[0]!.opts.disable_notification).toBe(true)
  })

  it('silences any other reason shape too (no notifying path remains)', async () => {
    const { bot, sends } = makeCapturingBot()
    await startBootCard('chat1', undefined, bot, mkOpts({ restartReasonDetail: 'operator-ish: rolled over' }))
    expect(sends).toHaveLength(1)
    expect(sends[0]!.opts.disable_notification).toBe(true)
  })
})
