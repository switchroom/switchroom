/**
 * Self-test the fake bot API: verify fault injection produces real
 * GrammyError shapes, chat-model tracking is consistent, reset works.
 *
 * Meta-test — if this ever fails, every test that depends on fake-bot-api
 * is suspect. Keep the coverage minimal and exact.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { GrammyError } from 'grammy'
import { createFakeBotApi, errors, makeGrammyError, type FakeBot } from './fake-bot-api.js'

describe('fake-bot-api', () => {
  let bot: FakeBot

  beforeEach(() => {
    bot = createFakeBotApi({ startMessageId: 100 })
  })

  describe('chat model', () => {
    it('tracks sent messages in order with stable ids', async () => {
      const r1 = await bot.api.sendMessage('chat-A', 'hello')
      const r2 = await bot.api.sendMessage('chat-A', 'world')
      const r3 = await bot.api.sendMessage('chat-B', 'other')
      expect(r1.message_id).toBe(100)
      expect(r2.message_id).toBe(101)
      expect(r3.message_id).toBe(102)
      expect(bot.messagesIn('chat-A').map((m) => m.text)).toEqual(['hello', 'world'])
      expect(bot.messagesIn('chat-B')).toHaveLength(1)
    })

    it('edit updates currentText without growing sent[]', async () => {
      const r = await bot.api.sendMessage('c', 'v1')
      await bot.api.editMessageText('c', r.message_id, 'v2')
      expect(bot.textOf(r.message_id)).toBe('v2')
      expect(bot.state.sent).toHaveLength(1)
    })

    it('edit on non-existent message throws messageToEditNotFound', async () => {
      await expect(bot.api.editMessageText('c', 999, 'x')).rejects.toBeInstanceOf(GrammyError)
      try {
        await bot.api.editMessageText('c', 999, 'x')
      } catch (e) {
        expect((e as GrammyError).error_code).toBe(400)
        expect((e as GrammyError).description).toMatch(/message to edit not found/)
      }
    })

    it('editing to same text throws "not modified"', async () => {
      const r = await bot.api.sendMessage('c', 'same')
      await expect(bot.api.editMessageText('c', r.message_id, 'same')).rejects.toMatchObject({
        error_code: 400,
        description: expect.stringContaining('not modified'),
      })
    })

    it('deleteMessage drops from currentText and pins', async () => {
      const r = await bot.api.sendMessage('c', 'pinnable')
      await bot.api.pinChatMessage('c', r.message_id)
      expect(bot.isPinned('c', r.message_id)).toBe(true)
      await bot.api.deleteMessage('c', r.message_id)
      expect(bot.textOf(r.message_id)).toBe(null)
      expect(bot.isPinned('c', r.message_id)).toBe(false)
      expect(bot.state.deleted.has(r.message_id)).toBe(true)
    })

    it('setMessageReaction overwrites prior reaction on same message', async () => {
      const r = await bot.api.sendMessage('c', 'x')
      await bot.api.setMessageReaction('c', r.message_id, [{ emoji: '👍' }])
      await bot.api.setMessageReaction('c', r.message_id, [{ emoji: '🔥' }])
      const entries = bot.state.reactions.filter(
        (rx) => rx.chat_id === 'c' && rx.message_id === r.message_id,
      )
      expect(entries).toHaveLength(1)
      expect(entries[0].reactions).toEqual([{ emoji: '🔥' }])
    })

    it('unpin removes from pinned list', async () => {
      const r = await bot.api.sendMessage('c', 'pin')
      await bot.api.pinChatMessage('c', r.message_id)
      await bot.api.unpinChatMessage('c', r.message_id)
      expect(bot.isPinned('c', r.message_id)).toBe(false)
    })
  })

  describe('fault injection', () => {
    it('next() throws exactly one queued error then clears', async () => {
      bot.faults.next('sendMessage', errors.floodWait(3))
      await expect(bot.api.sendMessage('c', 'x')).rejects.toBeInstanceOf(GrammyError)
      // Second call is fine
      await expect(bot.api.sendMessage('c', 'x')).resolves.toBeDefined()
    })

    it('chat-scoped faults only fire for that chat', async () => {
      bot.faults.next('sendMessage', errors.forbidden(), 'chat-A')
      await expect(bot.api.sendMessage('chat-B', 'x')).resolves.toBeDefined()
      await expect(bot.api.sendMessage('chat-A', 'x')).rejects.toMatchObject({ error_code: 403 })
    })

    it('FIFO across multiple queued faults', async () => {
      bot.faults.next('sendMessage', errors.floodWait(1))
      bot.faults.next('sendMessage', errors.forbidden())
      try { await bot.api.sendMessage('c', 'x') } catch (e) {
        expect((e as GrammyError).error_code).toBe(429)
      }
      try { await bot.api.sendMessage('c', 'x') } catch (e) {
        expect((e as GrammyError).error_code).toBe(403)
      }
      await expect(bot.api.sendMessage('c', 'x')).resolves.toBeDefined()
    })

    it('reset clears queued faults', async () => {
      bot.faults.next('sendMessage', errors.floodWait(1))
      bot.faults.reset()
      await expect(bot.api.sendMessage('c', 'x')).resolves.toBeDefined()
    })
  })

  describe('error factories produce grammy-shaped errors', () => {
    it('floodWait has parameters.retry_after', () => {
      const e = errors.floodWait(7)
      expect(e).toBeInstanceOf(GrammyError)
      expect(e.error_code).toBe(429)
      expect(e.parameters.retry_after).toBe(7)
    })

    it('notModified matches robustApiCall detector', () => {
      const e = errors.notModified()
      expect(e.description.includes('not modified')).toBe(true)
      expect(e.error_code).toBe(400)
    })

    it('messageToEditNotFound matches detector', () => {
      const e = errors.messageToEditNotFound()
      expect(e.description.includes('message to edit not found')).toBe(true)
    })

    it('threadNotFound matches detector', () => {
      const e = errors.threadNotFound()
      expect(e.description.includes('thread not found')).toBe(true)
    })

    it('custom builder', () => {
      const e = makeGrammyError({
        error_code: 400,
        description: 'Bad Request: whatever',
        method: 'sendMessage',
      })
      expect(e).toBeInstanceOf(GrammyError)
    })
  })

  describe('reset', () => {
    it('wipes all state and counters', async () => {
      await bot.api.sendMessage('c', 'a')
      await bot.api.pinChatMessage('c', 100)
      bot.faults.next('sendMessage', errors.forbidden())
      bot.reset()
      expect(bot.state.sent).toHaveLength(0)
      expect(bot.state.pinned).toHaveLength(0)
      const r = await bot.api.sendMessage('c', 'fresh')
      expect(r.message_id).toBe(100) // counter reset to startMessageId
    })
  })

  describe('holdNext', () => {
    it('parks a call until release()', async () => {
      const r = await bot.api.sendMessage('c', 'long enough seed text x')
      const hold = bot.holdNext('editMessageText', 'c')
      const editPromise = bot.api.editMessageText('c', r.message_id, 'updated text long')
      await Promise.resolve()
      expect(hold.triggered()).toBe(true)
      // Edit hasn't landed yet.
      expect(bot.textOf(r.message_id)).toBe('long enough seed text x')
      hold.release()
      await editPromise
      expect(bot.textOf(r.message_id)).toBe('updated text long')
    })

    it('fail() rejects the held call without applying the mutation', async () => {
      const r = await bot.api.sendMessage('c', 'long enough seed text y')
      const hold = bot.holdNext('editMessageText', 'c')
      const editPromise = bot.api.editMessageText('c', r.message_id, 'never lands here')
      await Promise.resolve()
      hold.fail(new Error('synthetic in-flight failure'))
      await expect(editPromise).rejects.toThrow('synthetic in-flight failure')
      // Original text intact.
      expect(bot.textOf(r.message_id)).toBe('long enough seed text y')
    })

    it('fault wins over hold when both queued for same method (fault is checked first)', async () => {
      // Pin the precedence rule documented in fake-bot-api.ts: fault
      // checks happen synchronously before the hold gate is awaited.
      // This matters because production code often combines retry-on-
      // fault logic with timing tests — picking one or the other is
      // the documented contract.
      bot.faults.next('sendMessage', errors.floodWait(3))
      const hold = bot.holdNext('sendMessage')
      await expect(bot.api.sendMessage('c', 'will fail synchronously')).rejects.toBeInstanceOf(GrammyError)
      // Hold was never entered — the fault threw before the await.
      expect(hold.triggered()).toBe(false)
    })

    it('reset() rejects unreleased holds so a leaked hold cannot hang the next test', async () => {
      const r = await bot.api.sendMessage('c', 'long enough seed text z')
      bot.holdNext('editMessageText', 'c')
      const editPromise = bot.api.editMessageText('c', r.message_id, 'parked then reset')
      // Don't release — simulate a test that forgets cleanup.
      bot.reset()
      await expect(editPromise).rejects.toThrow(/reset/)
    })
  })
})
