/**
 * Outcome pins for checklist graceful degradation
 * (gateway/checklist-fallback.ts).
 *
 * The bug this guards: `send_checklist` built a FLAT
 * `{ chat_id, title, tasks: [{ text, is_completed }] }` payload for
 * Telegram's `sendChecklist`, which requires (a) `title`/`tasks` nested
 * inside a single `checklist` object, (b) a REQUIRED integer `id` per task,
 * (c) NO completion flag, and (d) a `business_connection_id` — native
 * checklists are Business-account-only, so every ordinary bot chat got a raw
 * `400: Bad Request: parameter "checklist" is required`.
 *
 * Pinned outcomes: the normal (no business connection) path sends a
 * formatted ✅/⬜ text message and reports `degraded: "text"`; the native
 * payload, when built, is CORRECT per Bot API 9.1; and no native failure
 * escapes as a raw error — it falls back to text.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  buildChecklistTasks,
  renderChecklistText,
  applyChecklistPatch,
  buildNativeChecklistPayload,
  buildNativeEditChecklistPayload,
  createChecklistStore,
  checklistStoreKey,
  performSendChecklist,
  performUpdateChecklist,
  sendChecklistToolText,
  updateChecklistToolText,
  CHECKLIST_MAX_TASKS,
  type ChecklistState,
  type SendChecklistDeps,
  type UpdateChecklistDeps,
} from '../gateway/checklist-fallback.js'

function sendDeps(over: Partial<SendChecklistDeps> = {}) {
  const sendNative = vi.fn(async () => ({ message_id: 100 }))
  const sendText = vi.fn(async () => ({ message_id: 200 }))
  const log = vi.fn()
  const deps: SendChecklistDeps = {
    businessConnectionId: undefined,
    nativeAvailable: true,
    sendNative,
    sendText,
    literalText: false,
    log,
    ...over,
  }
  return { deps, sendNative, sendText, log }
}

function updateDeps(over: Partial<UpdateChecklistDeps> = {}) {
  const editNative = vi.fn(async () => {})
  const editText = vi.fn(async () => {})
  const log = vi.fn()
  const deps: UpdateChecklistDeps = {
    state: undefined,
    businessConnectionId: undefined,
    nativeAvailable: true,
    editNative,
    editText,
    literalText: false,
    log,
    chatId: 42,
    messageId: 7,
    ...over,
  }
  return { deps, editNative, editText, log }
}

const textState = (over: Partial<ChecklistState> = {}): ChecklistState => ({
  title: 'Trip prep',
  tasks: [
    { id: 1, text: 'book flights', done: false },
    { id: 2, text: 'renew passport', done: true },
  ],
  mode: 'text',
  ...over,
})

describe('buildChecklistTasks', () => {
  it('assigns sequential 1-based ids and normalizes done', () => {
    expect(buildChecklistTasks([{ text: 'a' }, { text: 'b', done: true }])).toEqual([
      { id: 1, text: 'a', done: false },
      { id: 2, text: 'b', done: true },
    ])
  })

  it('rejects more than the 30-task API limit', () => {
    const tasks = Array.from({ length: CHECKLIST_MAX_TASKS + 1 }, (_, i) => ({ text: `t${i}` }))
    expect(() => buildChecklistTasks(tasks)).toThrow(/30-task limit/)
  })
})

describe('renderChecklistText', () => {
  it('renders bold title + ✅/⬜ lines honoring done', () => {
    expect(renderChecklistText(textState())).toBe('**Trip prep**\n⬜ book flights\n✅ renew passport')
  })

  it('literal mode drops the markdown bold (parseMode: text sends are not parsed)', () => {
    expect(renderChecklistText(textState(), { literal: true })).toBe('Trip prep\n⬜ book flights\n✅ renew passport')
  })
})

describe('applyChecklistPatch', () => {
  it('updates by id, appends without id, replaces title; input untouched', () => {
    const base = textState()
    const next = applyChecklistPatch(base, {
      title: 'Trip prep v2',
      tasks: [{ id: '1', done: true }, { text: 'pack bags' }],
    })
    expect(next).toEqual({
      title: 'Trip prep v2',
      tasks: [
        { id: 1, text: 'book flights', done: true },
        { id: 2, text: 'renew passport', done: true },
        { id: 3, text: 'pack bags', done: false },
      ],
    })
    expect(base.tasks[0].done).toBe(false) // pure — no mutation
  })

  it('appends a task with an unknown id, preserving that id', () => {
    const next = applyChecklistPatch(textState(), { tasks: [{ id: 9, text: 'buy sim', done: false }] })
    expect(next.tasks[2]).toEqual({ id: 9, text: 'buy sim', done: false })
  })
})

describe('native payloads — correct Bot API 9.1 shape', () => {
  it('sendChecklist nests title/tasks inside `checklist`, carries ids, has NO is_completed', () => {
    const payload = buildNativeChecklistPayload({
      businessConnectionId: 'bc1',
      chatId: 42,
      title: 'T',
      tasks: buildChecklistTasks([{ text: 'a', done: true }, { text: 'b' }]),
      replyToMessageId: 5,
    })
    expect(payload).toEqual({
      business_connection_id: 'bc1',
      chat_id: 42,
      checklist: { title: 'T', tasks: [{ id: 1, text: 'a' }, { id: 2, text: 'b' }] },
      reply_parameters: { message_id: 5 },
    })
    expect(JSON.stringify(payload)).not.toContain('is_completed')
  })

  // #4368 — a fabricated reply anchor (a synthetic boot-resume/handback/cron
  // inbound id at `Date.now()` scale) is out of the signed-int32 range Telegram
  // accepts for `reply_parameters.message_id`. The builder must DROP it so the
  // native checklist sends UNANCHORED rather than 400ing the whole send. Before
  // the fix the builder emitted `reply_parameters.message_id` verbatim.
  it('drops an out-of-int32 replyToMessageId — no reply_parameters (#4368)', () => {
    const payload = buildNativeChecklistPayload({
      businessConnectionId: 'bc1',
      chatId: 42,
      title: 'T',
      tasks: buildChecklistTasks([{ text: 'a' }]),
      replyToMessageId: 1_785_000_000_000,
    })
    expect(payload.reply_parameters).toBeUndefined()
    expect(payload).toEqual({
      business_connection_id: 'bc1',
      chat_id: 42,
      checklist: { title: 'T', tasks: [{ id: 1, text: 'a' }] },
    })
  })

  it('editMessageChecklist sends the FULL checklist (native edits replace it)', () => {
    const payload = buildNativeEditChecklistPayload({
      businessConnectionId: 'bc1',
      chatId: 42,
      messageId: 7,
      title: 'T',
      tasks: [{ id: 3, text: 'kept', done: false }],
    })
    expect(payload).toEqual({
      business_connection_id: 'bc1',
      chat_id: 42,
      message_id: 7,
      checklist: { title: 'T', tasks: [{ id: 3, text: 'kept' }] },
    })
  })
})

describe('performSendChecklist — degradation outcomes', () => {
  it('no business connection (the fleet norm) → sends the ✅/⬜ text render, never native', async () => {
    const { deps, sendNative, sendText } = sendDeps()
    const r = await performSendChecklist(deps, {
      title: 'Trip prep',
      tasks: [{ text: 'book flights' }, { text: 'renew passport', done: true }],
      chatId: 42,
    })
    expect(sendNative).not.toHaveBeenCalled()
    expect(sendText).toHaveBeenCalledWith('**Trip prep**\n⬜ book flights\n✅ renew passport')
    expect(r).toMatchObject({ message_id: 200, mode: 'text' })
    expect(r.state).toEqual({
      title: 'Trip prep',
      tasks: [
        { id: 1, text: 'book flights', done: false },
        { id: 2, text: 'renew passport', done: true },
      ],
      mode: 'text',
    })
  })

  it('business connection configured → sends the correct nested native payload', async () => {
    const { deps, sendNative, sendText } = sendDeps({ businessConnectionId: 'bc1' })
    const r = await performSendChecklist(deps, { title: 'T', tasks: [{ text: 'a' }], chatId: 42 })
    expect(sendText).not.toHaveBeenCalled()
    expect(sendNative).toHaveBeenCalledWith({
      business_connection_id: 'bc1',
      chat_id: 42,
      checklist: { title: 'T', tasks: [{ id: 1, text: 'a' }] },
    })
    expect(r).toMatchObject({ message_id: 100, mode: 'native' })
  })

  it('native failure does NOT escape — falls back to the text render', async () => {
    const { deps, sendText, log } = sendDeps({
      businessConnectionId: 'bc1',
      sendNative: vi.fn(async () => { throw new Error('400: Bad Request: parameter "checklist" is required') }),
    })
    const r = await performSendChecklist(deps, { title: 'T', tasks: [{ text: 'a' }], chatId: 42 })
    expect(r).toMatchObject({ message_id: 200, mode: 'text' })
    expect(sendText).toHaveBeenCalledWith('**T**\n⬜ a')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('falling back to text'))
  })

  it('checklist API not available in this grammY version → text render, no native attempt', async () => {
    const { deps, sendNative } = sendDeps({ businessConnectionId: 'bc1', nativeAvailable: false })
    const r = await performSendChecklist(deps, { title: 'T', tasks: [{ text: 'a' }], chatId: 42 })
    expect(sendNative).not.toHaveBeenCalled()
    expect(r.mode).toBe('text')
  })
})

describe('performUpdateChecklist — degradation outcomes', () => {
  it('text-mode: patch applies to stored state and re-renders the ✅/⬜ text', async () => {
    const { deps, editText, editNative } = updateDeps({ state: textState() })
    const r = await performUpdateChecklist(deps, { tasks: [{ id: 1, done: true }] })
    expect(editNative).not.toHaveBeenCalled()
    expect(editText).toHaveBeenCalledWith('**Trip prep**\n✅ book flights\n✅ renew passport')
    expect(r).toMatchObject({ ok: true, mode: 'text' })
  })

  it('no stored state + partial patch → structured unknown_checklist, no edit attempted', async () => {
    const { deps, editText, editNative } = updateDeps()
    const r = await performUpdateChecklist(deps, { tasks: [{ id: 1, done: true }] })
    expect(r).toMatchObject({ ok: false, reason: 'unknown_checklist' })
    expect(editText).not.toHaveBeenCalled()
    expect(editNative).not.toHaveBeenCalled()
  })

  it('no stored state + full replacement (title + all task texts) → rebuilds and edits as text', async () => {
    const { deps, editText } = updateDeps()
    const r = await performUpdateChecklist(deps, {
      title: 'Rebuilt',
      tasks: [{ text: 'a', done: true }, { text: 'b' }],
    })
    expect(r).toMatchObject({ ok: true, mode: 'text' })
    expect(editText).toHaveBeenCalledWith('**Rebuilt**\n✅ a\n⬜ b')
  })

  it('native-mode: edits with the FULL post-patch checklist payload', async () => {
    const { deps, editNative } = updateDeps({
      state: textState({ mode: 'native' }),
      businessConnectionId: 'bc1',
    })
    const r = await performUpdateChecklist(deps, { tasks: [{ text: 'new task' }] })
    expect(r).toMatchObject({ ok: true, mode: 'native' })
    expect(editNative).toHaveBeenCalledWith({
      business_connection_id: 'bc1',
      chat_id: 42,
      message_id: 7,
      checklist: {
        title: 'Trip prep',
        tasks: [
          { id: 1, text: 'book flights' },
          { id: 2, text: 'renew passport' },
          { id: 3, text: 'new task' },
        ],
      },
    })
  })

  it('a failed edit never throws a raw Telegram error — structured edit_failed instead', async () => {
    const { deps } = updateDeps({
      state: textState(),
      editText: vi.fn(async () => { throw new Error('400: Bad Request: message to edit not found') }),
    })
    const r = await performUpdateChecklist(deps, { tasks: [{ id: 1, done: true }] })
    expect(r).toMatchObject({ ok: false, reason: 'edit_failed' })
    expect((r as { hint: string }).hint).toContain('message to edit not found')
  })

  it('native-mode checklist with the business connection gone → structured edit_failed', async () => {
    const { deps, editNative } = updateDeps({ state: textState({ mode: 'native' }) })
    const r = await performUpdateChecklist(deps, { tasks: [{ id: 1, done: true }] })
    expect(r).toMatchObject({ ok: false, reason: 'edit_failed' })
    expect(editNative).not.toHaveBeenCalled()
  })
})

describe('tool-result text', () => {
  it('send: degraded text result carries degraded:"text" so the agent knows', () => {
    const parsed = JSON.parse(sendChecklistToolText({
      message_id: 200, mode: 'text', state: textState(),
    }))
    expect(parsed).toMatchObject({ ok: true, message_id: 200, mode: 'text', degraded: 'text' })
    expect(parsed.note).toContain('Business connection')
  })

  it('send: native result has no degraded marker', () => {
    expect(JSON.parse(sendChecklistToolText({
      message_id: 100, mode: 'native', state: textState({ mode: 'native' }),
    }))).toEqual({ ok: true, message_id: 100, mode: 'native' })
  })

  it('update: structured failure round-trips reason + hint', () => {
    expect(JSON.parse(updateChecklistToolText(
      { ok: false, reason: 'unknown_checklist', hint: 'resend it' }, 7,
    ))).toEqual({ ok: false, reason: 'unknown_checklist', hint: 'resend it' })
  })
})

describe('createChecklistStore', () => {
  it('evicts oldest entries past the cap', () => {
    const store = createChecklistStore(2)
    store.set(checklistStoreKey('1', 1), textState())
    store.set(checklistStoreKey('1', 2), textState())
    store.set(checklistStoreKey('1', 3), textState())
    expect(store.get('1:1')).toBeUndefined()
    expect(store.get('1:2')).toBeDefined()
    expect(store.get('1:3')).toBeDefined()
  })
})
