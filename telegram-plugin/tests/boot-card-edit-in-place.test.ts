/**
 * Edit-in-place boot card (zero-notification reboots, operator request
 * 2026-06-03). A routine reboot must EDIT the prior boot card rather than
 * send a new one — a sent message bumps the unread badge even with
 * `disable_notification: true`; an edit never does.
 *
 * Pins the startBootCard contract:
 *   - first boot (no persisted id) → SEND + persist the id
 *   - next routine boot (persisted id exists) → EDIT in place, NO send
 *   - persisted id but message deleted ('gone') → fall back to SEND
 *   - Telegram-initiated /restart (ackMessageId set) → SEND fresh (replies to
 *     the operator's command; they asked and are watching)
 *   - no bootCardStatePath → always SEND (back-compat)
 *
 * State is an isolated mkdtemp file — NEVER ~/.switchroom (test discipline).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBootCard } from '../gateway/boot-card.js'
import type { BotApiForBootCard } from '../gateway/boot-card.js'

let dir: string
let statePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boot-card-eip-'))
  statePath = join(dir, '.boot-card-msgid.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Capturing bot with a configurable strict-edit outcome. */
function makeBot(strictOutcome: 'edited' | 'gone' | null) {
  const sends: Array<{ chatId: string; opts: Record<string, unknown> }> = []
  const strictEdits: Array<{ chatId: string; messageId: number }> = []
  let nextId = 1000
  const bot: BotApiForBootCard = {
    sendMessage: async (chatId, _text, opts) => {
      sends.push({ chatId, opts: opts ?? {} })
      return { message_id: ++nextId }
    },
    editMessageText: async () => ({}),
    ...(strictOutcome != null
      ? {
          editMessageTextStrict: async (chatId: string, messageId: number) => {
            strictEdits.push({ chatId, messageId })
            return strictOutcome
          },
        }
      : {}),
  }
  return { bot, sends, strictEdits }
}

function mkOpts(overrides: Record<string, unknown> = {}) {
  return {
    agentName: 'TestAgent',
    agentSlug: 'test-agent',
    version: 'v0.0.0-test',
    agentDir: dir,
    gatewayInfo: { pid: 1, startedAtMs: Date.now() },
    restartReason: 'graceful' as const,
    agentLiveWindowMs: 0, // disable the live loop — we assert the initial post/edit only
    settleWindowMs: 1_000_000,
    bootCardStatePath: statePath,
    ...overrides,
  }
}

describe('boot card — edit-in-place (zero-notification reboots)', () => {
  it('first boot with no persisted id → sends, and persists the id', async () => {
    const { bot, sends, strictEdits } = makeBot('edited')
    await startBootCard('chat1', undefined, bot, mkOpts())
    expect(sends).toHaveLength(1) // first boot must send (one badge, ever)
    expect(strictEdits).toHaveLength(0)
    expect(sends[0]!.opts.disable_notification).toBe(true) // still silent
  })

  it('second routine boot → edits the prior card in place, NO new send', async () => {
    // Boot 1 sends + persists.
    const first = makeBot('edited')
    await startBootCard('chat1', undefined, first.bot, mkOpts())
    expect(first.sends).toHaveLength(1)

    // Boot 2 (same state file) → reuse via strict edit, no send.
    const second = makeBot('edited')
    await startBootCard('chat1', undefined, second.bot, mkOpts())
    expect(second.sends).toHaveLength(0) // ← zero notification: no new message
    expect(second.strictEdits).toHaveLength(1)
    // Boot 1's send returned message_id 1001 (nextId starts at 1000, ++ first);
    // boot 2 must edit exactly that persisted id.
    expect(second.strictEdits[0]!.messageId).toBe(1001)
  })

  it('persisted id but message was deleted (gone) → falls back to a fresh send', async () => {
    const first = makeBot('edited')
    await startBootCard('chat1', undefined, first.bot, mkOpts())

    const second = makeBot('gone')
    await startBootCard('chat1', undefined, second.bot, mkOpts())
    expect(second.strictEdits).toHaveLength(1) // probed the old id
    expect(second.sends).toHaveLength(1) // and fell back to a fresh send
    expect(second.sends[0]!.opts.disable_notification).toBe(true)
  })

  it('Telegram-initiated /restart (ackMessageId set) → sends fresh, never edits', async () => {
    // Seed a persisted id from a routine boot.
    const seed = makeBot('edited')
    await startBootCard('chat1', undefined, seed.bot, mkOpts())

    // A /restart passes ackMessageId → must reply with a fresh card, not edit.
    const restart = makeBot('edited')
    await startBootCard('chat1', undefined, restart.bot, mkOpts(), 555)
    expect(restart.strictEdits).toHaveLength(0) // no reuse on user-initiated restart
    expect(restart.sends).toHaveLength(1)
    expect(restart.sends[0]!.opts.reply_parameters).toEqual({ message_id: 555 })
  })

  it('no bootCardStatePath → always sends (back-compat, unchanged)', async () => {
    const { bot, sends, strictEdits } = makeBot('edited')
    await startBootCard('chat1', undefined, bot, mkOpts({ bootCardStatePath: undefined }))
    expect(sends).toHaveLength(1)
    expect(strictEdits).toHaveLength(0)
  })

  it('bot without editMessageTextStrict → always sends (graceful degrade)', async () => {
    const { bot, sends } = makeBot(null) // no strict method
    await startBootCard('chat1', undefined, bot, mkOpts())
    const second = makeBot(null)
    await startBootCard('chat1', undefined, second.bot, mkOpts())
    // Both boots send — no strict method means no in-place reuse path.
    expect(sends).toHaveLength(1)
    expect(second.sends).toHaveLength(1)
  })
})
