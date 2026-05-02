/**
 * Self-tests for the new update-factory builders:
 *   - makeEditedMessageUpdate (Telegram `edited_message`)
 *   - makeMessageReactionUpdate (Telegram `message_reaction`)
 *
 * These factories let tests inject inbound Telegram updates that the
 * old harness couldn't express. Without them, code paths that
 * subscribe to `bot.on('edited_message', ...)` or
 * `bot.on('message_reaction', ...)` had no test surface at all.
 *
 * The shape contracts pinned here:
 *   - shape matches https://core.telegram.org/bots/api#editedmessage
 *     and #messagereactionupdated
 *   - sensible defaults so tests only specify what they care about
 *   - `update_id` and timestamps are deterministic-ish (counter + nowSec)
 */

import { describe, expect, it } from 'vitest'
import {
  makeEditedMessageUpdate,
  makeMessageReactionUpdate,
  resetUpdateCounters,
} from './update-factory.js'

describe('makeEditedMessageUpdate', () => {
  it('produces a top-level edited_message Update', () => {
    resetUpdateCounters()
    const update = makeEditedMessageUpdate({ message_id: 42, text: 'edited text' }) as Record<
      string,
      unknown
    >
    expect(update.edited_message).toBeDefined()
    expect(update.message).toBeUndefined()
    const edited = update.edited_message as Record<string, unknown>
    expect(edited.message_id).toBe(42)
    expect(edited.text).toBe('edited text')
    // edit_date should be >= date (post-edit timestamp)
    expect(edited.edit_date as number).toBeGreaterThanOrEqual(edited.date as number)
  })

  it('respects forum thread context', () => {
    const update = makeEditedMessageUpdate({
      message_id: 100,
      text: 'topic edit',
      message_thread_id: 7,
    }) as Record<string, unknown>
    const edited = update.edited_message as Record<string, unknown>
    expect(edited.message_thread_id).toBe(7)
  })

  it('allows custom date / edit_date for replay scenarios', () => {
    const update = makeEditedMessageUpdate({
      message_id: 1,
      text: 'x',
      date: 1_000_000,
      edit_date: 1_000_500,
    }) as Record<string, unknown>
    const edited = update.edited_message as Record<string, unknown>
    expect(edited.date).toBe(1_000_000)
    expect(edited.edit_date).toBe(1_000_500)
  })
})

describe('makeMessageReactionUpdate', () => {
  it('default shape: user reacts with 👍 (no prior reaction)', () => {
    const update = makeMessageReactionUpdate({ message_id: 50 }) as Record<string, unknown>
    expect(update.message_reaction).toBeDefined()
    const r = update.message_reaction as Record<string, unknown>
    expect(r.message_id).toBe(50)
    const oldReaction = r.old_reaction as Array<{ emoji?: string }>
    const newReaction = r.new_reaction as Array<{ emoji?: string }>
    expect(oldReaction).toEqual([])
    expect(newReaction).toEqual([{ type: 'emoji', emoji: '👍' }])
  })

  it('reaction removal: old 👍, new []', () => {
    const update = makeMessageReactionUpdate({
      message_id: 60,
      oldEmoji: '👍',
      newEmoji: null,
    }) as Record<string, unknown>
    const r = update.message_reaction as Record<string, unknown>
    expect(r.old_reaction).toEqual([{ type: 'emoji', emoji: '👍' }])
    expect(r.new_reaction).toEqual([])
  })

  it('reaction swap: old 👍, new 🎉', () => {
    const update = makeMessageReactionUpdate({
      message_id: 70,
      oldEmoji: '👍',
      newEmoji: '🎉',
    }) as Record<string, unknown>
    const r = update.message_reaction as Record<string, unknown>
    expect(r.old_reaction).toEqual([{ type: 'emoji', emoji: '👍' }])
    expect(r.new_reaction).toEqual([{ type: 'emoji', emoji: '🎉' }])
  })

  it('respects custom user', () => {
    const update = makeMessageReactionUpdate({
      message_id: 80,
      user: { id: 12345, username: 'reactor' },
    }) as Record<string, unknown>
    const r = update.message_reaction as Record<string, unknown>
    const user = r.user as Record<string, unknown>
    expect(user.id).toBe(12345)
    expect(user.username).toBe('reactor')
  })
})
