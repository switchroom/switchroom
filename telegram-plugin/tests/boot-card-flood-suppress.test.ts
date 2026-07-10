/**
 * #2923 — boot-card flood-wait suppression. When a Telegram per-bot flood ban
 * is active, a restart's boot card is a NON-ESSENTIAL send straight into the
 * open window that can reset/extend the ban. startBootCard must SKIP the send
 * (and log) while the flood-wait is active, and post normally once it lifts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBootCard } from '../gateway/boot-card.js'
import type { BotApiForBootCard } from '../gateway/boot-card.js'
import { computeFloodWait, writeFloodState, floodStatePath, makeFloodWaitRecorder } from '../flood-circuit-breaker.js'
import { createRetryApiCall } from '../retry-api-call.js'
import { errors } from './fake-bot-api.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boot-card-flood-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function makeBot() {
  const sends: string[] = []
  const bot: BotApiForBootCard = {
    sendMessage: async (chatId, _text, _opts) => {
      sends.push(chatId)
      return { message_id: 1001 }
    },
    editMessageText: async () => ({}),
  }
  return { bot, sends }
}

function mkOpts(floodPath: string, nowMs: number, overrides: Record<string, unknown> = {}) {
  return {
    agentName: 'TestAgent',
    agentSlug: 'test-agent',
    version: 'v0.0.0-test',
    agentDir: dir,
    gatewayInfo: { pid: 1, startedAtMs: nowMs },
    restartReason: 'graceful' as const,
    agentLiveWindowMs: 0,
    settleWindowMs: 1_000_000,
    floodStatePath: floodPath,
    nowMs: () => nowMs,
    ...overrides,
  } as unknown as Parameters<typeof startBootCard>[3]
}

it('SUPPRESSES the boot card while a flood-wait is active', async () => {
  const p = floodStatePath(dir)
  const now = 1_000_000
  writeFloodState(p, computeFloodWait(null, 68 * 60, now)) // ~68 min ban
  const logs: string[] = []
  const { bot, sends } = makeBot()
  const handle = await startBootCard('chat1', undefined, bot, mkOpts(p, now), undefined, (l) =>
    logs.push(l),
  )
  expect(sends).toEqual([]) // nothing sent into the open ban window
  expect(handle.messageId).toBe(-1)
  expect(logs.join('')).toMatch(/SUPPRESSED/)
})

it('POSTS the boot card once the flood-wait has lifted', async () => {
  const p = floodStatePath(dir)
  const banStart = 1_000_000
  writeFloodState(p, computeFloodWait(null, 60, banStart))
  const afterBan = banStart + 60_000 + 1
  const { bot, sends } = makeBot()
  await startBootCard('chat1', undefined, bot, mkOpts(p, afterBan), undefined, () => {})
  expect(sends).toEqual(['chat1'])
})

it('POSTS normally when no flood state file exists (back-compat)', async () => {
  const p = floodStatePath(dir) // never written
  const { bot, sends } = makeBot()
  await startBootCard('chat1', undefined, bot, mkOpts(p, 1_000_000), undefined, () => {})
  expect(sends).toEqual(['chat1'])
})

it('INTEGRATION: a 429 through the real retry path suppresses a later boot card', async () => {
  // Wire the two halves exactly as gateway.ts does: the retry wrapper's
  // onFloodWait recorder and the boot card BOTH point at the same file.
  const p = floodStatePath(dir)
  const now = 5_000_000
  const retry = createRetryApiCall({
    sleep: async () => {}, // don't actually wait out the flood
    onFloodWait: makeFloodWaitRecorder(p, () => now),
  })

  // Drive a real GrammyError 429 through the wrapper (first call floods, then
  // succeeds) — this is what records the window on disk.
  let n = 0
  await retry(async () => {
    if (n++ === 0) throw errors.floodWait(4116) // ~68 min ban
    return 'ok'
  })

  // Now a restart's boot card must be suppressed via the SAME file.
  const { bot, sends } = makeBot()
  const logs: string[] = []
  const handle = await startBootCard('chat1', undefined, bot, mkOpts(p, now), undefined, (l) =>
    logs.push(l),
  )
  expect(sends).toEqual([]) // not posted into the open ban window
  expect(handle.messageId).toBe(-1)
  expect(logs.join('')).toMatch(/SUPPRESSED/)
})
