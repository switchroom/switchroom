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
import {
  computeFloodWait,
  writeFloodState,
  floodStatePath,
  makeFloodWaitRecorder,
  suppressNonEssentialSendMs,
} from '../flood-circuit-breaker.js'
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

it('INTEGRATION: a SHORT 429 through the real retry path suppresses a later boot card', async () => {
  // Wire the two halves exactly as gateway.ts does: the retry wrapper's
  // onFloodWait recorder and the boot card BOTH point at the same file.
  //
  // This is the UNDER-ceiling path (#3084): retryApiCall sleeps the wait and
  // retries, exactly as it always has. The window must still be recorded, and
  // a restart's boot card must still be suppressed.
  const p = floodStatePath(dir)
  const now = 5_000_000
  const retry = createRetryApiCall({
    sleep: async () => {}, // don't actually wait out the flood
    onFloodWait: makeFloodWaitRecorder(p, () => now),
  })

  let n = 0
  const out = await retry(async () => {
    if (n++ === 0) throw errors.floodWait(75) // the historic real-world wait
    return 'ok'
  })
  expect(out).toBe('ok') // slept and retried — call still succeeded

  const { bot, sends } = makeBot()
  const logs: string[] = []
  const handle = await startBootCard('chat1', undefined, bot, mkOpts(p, now), undefined, (l) =>
    logs.push(l),
  )
  expect(sends).toEqual([]) // not posted into the open ban window
  expect(handle.messageId).toBe(-1)
  expect(logs.join('')).toMatch(/SUPPRESSED/)
})

it('INTEGRATION: a LONG 429 that FAILS FAST still suppresses a later boot card', async () => {
  // #3084 changed this path: a ~68min ban is over the in-process sleep ceiling,
  // so retryApiCall no longer sleeps it — it records the window and THROWS
  // FLOOD_WAIT_ACTIVE. The behaviour that matters to #2923 is unchanged and is
  // what this test pins: the window is recorded BEFORE the throw, so a restart
  // during the ban still suppresses its boot card instead of sending into the
  // open window and extending the ban.
  //
  // If the recording were ever moved below the throw (or skipped on this path),
  // `sends` would become ['chat1'] and this test goes red — which is exactly
  // the #2923 regression it exists to catch.
  const p = floodStatePath(dir)
  const now = 5_000_000
  const retry = createRetryApiCall({
    sleep: async () => {},
    onFloodWait: makeFloodWaitRecorder(p, () => now),
  })

  await expect(
    retry(async () => {
      throw errors.floodWait(4116) // ~68 min ban — over the ceiling
    }),
  ).rejects.toThrow('FLOOD_WAIT_ACTIVE')

  // The window landed on disk despite the throw…
  expect(suppressNonEssentialSendMs(p, now)).toBe(4116 * 1000)

  // …so the boot card is still suppressed through the SAME file.
  const { bot, sends } = makeBot()
  const logs: string[] = []
  const handle = await startBootCard('chat1', undefined, bot, mkOpts(p, now), undefined, (l) =>
    logs.push(l),
  )
  expect(sends).toEqual([]) // not posted into the open ban window
  expect(handle.messageId).toBe(-1)
  expect(logs.join('')).toMatch(/SUPPRESSED/)
})
