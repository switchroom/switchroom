/**
 * Pin the contract for #273's granular `send_typing` action param.
 *
 * Two regressions this guards against:
 *   1. The MCP tool schema in bridge.ts losing the `action` enum (an
 *      agent emits `action='upload_document'`, the bridge silently
 *      drops it because the schema doesn't advertise it, the gateway
 *      sees no action and falls back to 'typing').
 *   2. The whitelist drifting from Telegram's set — Telegram added
 *      `record_video_note` and `upload_video_note` after the original
 *      typing tool shipped; if those drop off the schema enum, agents
 *      lose access to them.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const bridgeSrc = readFileSync(
  resolve(__dirname, '..', 'bridge', 'bridge.ts'),
  'utf-8',
)

describe('send_typing action enum (#273)', () => {
  // Exhaustive list per Telegram Bot API 7.11 / sendChatAction.
  const TELEGRAM_CHAT_ACTIONS = [
    'typing',
    'upload_photo',
    'record_video',
    'upload_video',
    'record_voice',
    'upload_voice',
    'upload_document',
    'choose_sticker',
    'find_location',
    'record_video_note',
    'upload_video_note',
  ] as const

  it('MCP tool schema for send_typing advertises every Telegram chat-action', () => {
    // Quick pin: each enum value must appear inside the bridge.ts source.
    // Catches "schema drifted from runtime whitelist" regressions cheaply
    // without parsing TypeScript — a missing literal is a missing enum entry.
    for (const action of TELEGRAM_CHAT_ACTIONS) {
      expect(
        bridgeSrc.includes(`'${action}'`),
        `bridge.ts schema should advertise chat-action "${action}"`,
      ).toBe(true)
    }
  })

  it('send_typing schema description mentions the granular use cases', () => {
    // The agent's view of the tool is only the description string; if
    // it doesn't tell the model that a richer action set exists, agents
    // won't think to use it. Call out at least one non-typing variant
    // so the MCP description carries weight.
    const sendTypingBlock = bridgeSrc.split("name: 'send_typing'")[1]?.split("name: '")[0] ?? ''
    expect(sendTypingBlock).toMatch(/upload_document|record_voice/)
    expect(sendTypingBlock).toMatch(/action/)
  })
})
