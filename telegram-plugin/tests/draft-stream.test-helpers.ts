/**
 * Test helpers for code that *consumes* a `DraftStreamHandle`.
 *
 * Ported from openclaw's
 * `extensions/telegram/src/draft-stream.test-helpers.ts`.
 *
 * openclaw's handle has a richer surface (previewMode, previewRevision,
 * materialize, forceNewMessage, sendMayHaveLanded) than ours. This helper
 * conforms to our simpler `DraftStreamHandle` contract (update / finalize
 * / getMessageId / isFinal) and records calls so consumer tests can
 * assert on observed behaviour.
 *
 * Use in tests like:
 *   const fake = createTestDraftStream()
 *   myFunction(fake)               // code-under-test calls fake.update(...)
 *   expect(fake.update).toHaveBeenCalledWith('expected text')
 *   expect(fake.lastDeliveredText()).toBe('expected text')
 */

import { vi } from 'vitest'
import type { DraftStreamHandle } from '../draft-stream.js'

export interface TestDraftStream extends DraftStreamHandle {
  update: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>
  finalize: ReturnType<typeof vi.fn<() => Promise<void>>>
  getMessageId: ReturnType<typeof vi.fn<() => number | null>>
  isFinal: ReturnType<typeof vi.fn<() => boolean>>

  /** Last text passed to `update()`, with trailing whitespace trimmed. */
  lastDeliveredText(): string
  /** Monotonic counter of successful update() calls. */
  revision(): number
  /** Force the handle to claim a specific message_id. */
  setMessageId(id: number | null): void
}

export function createTestDraftStream(
  params?: { messageId?: number | null; onUpdate?: (text: string) => void },
): TestDraftStream {
  let messageId = params?.messageId ?? null
  let final = false
  let revision = 0
  let lastText = ''

  const handle: TestDraftStream = {
    update: vi.fn(async (text: string) => {
      revision += 1
      lastText = text.trimEnd()
      params?.onUpdate?.(text)
    }),
    finalize: vi.fn(async () => {
      final = true
    }),
    getMessageId: vi.fn(() => messageId),
    isFinal: vi.fn(() => final),
    lastDeliveredText: () => lastText,
    revision: () => revision,
    setMessageId: (id) => {
      messageId = id
    },
  }
  return handle
}

/**
 * Variant whose `update()` auto-assigns a fresh message_id on first call —
 * mirrors the real stream's behaviour where the first update() triggers
 * a sendMessage that captures the id.
 */
export function createSequencedTestDraftStream(startMessageId = 1001): TestDraftStream {
  let activeId: number | null = null
  let next = startMessageId
  let final = false
  let revision = 0
  let lastText = ''

  return {
    update: vi.fn(async (text: string) => {
      if (activeId == null) activeId = next++
      revision += 1
      lastText = text.trimEnd()
    }),
    finalize: vi.fn(async () => {
      final = true
    }),
    getMessageId: vi.fn(() => activeId),
    isFinal: vi.fn(() => final),
    lastDeliveredText: () => lastText,
    revision: () => revision,
    setMessageId: (id) => {
      activeId = id
    },
  }
}
