/**
 * Pin the three-invariant contract for `finalizeCallback`. Every other
 * inline-keyboard callback handler in the gateway routes through this
 * helper, so a regression here breaks the audit-wide button UX
 * (#1150 + follow-ups).
 *
 *   1. Visible press feedback (answerCallbackQuery with text).
 *   2. Keyboard collapses + status line appended (one atomic edit).
 *   3. synthInbound fires AFTER the message edit lands, errors
 *      swallowed but logged.
 */

import { describe, it, expect } from 'vitest'
import { finalizeCallback, type FinalizeCallbackContext } from '../inline-keyboard-callbacks.js'

interface Capture {
  acks: Array<{ text?: string; show_alert?: boolean }>
  edits: Array<{ text: string | { markdown: string }; opts: Record<string, unknown> }>
  ackThrows?: Error
  editThrows?: Error
}

function mkCtx(cap: Capture): FinalizeCallbackContext {
  return {
    answerCallbackQuery: async (opts) => {
      cap.acks.push(opts ?? {})
      if (cap.ackThrows) throw cap.ackThrows
      return true
    },
    editMessageText: async (text, opts) => {
      cap.edits.push({ text, opts: opts ?? {} })
      if (cap.editThrows) throw cap.editThrows
      return { message_id: 1 }
    },
  }
}

describe('finalizeCallback — three-invariant contract', () => {
  it('invariant 1: acks the callback with the supplied toast text', async () => {
    const cap: Capture = { acks: [], edits: [] }
    await finalizeCallback(mkCtx(cap), {
      ackText: 'Approved',
      newText: 'Original prompt\n\n✓ Approved by @op',
    })
    expect(cap.acks).toHaveLength(1)
    expect(cap.acks[0]?.text).toBe('Approved')
    expect(cap.acks[0]?.show_alert).toBeUndefined()
  })

  it('invariant 1: alert=true renders as full modal (show_alert: true)', async () => {
    const cap: Capture = { acks: [], edits: [] }
    await finalizeCallback(mkCtx(cap), {
      ackText: 'Vault grant revoked',
      alert: true,
      newText: '...',
    })
    expect(cap.acks[0]?.show_alert).toBe(true)
  })

  it('invariant 2: strips reply_markup AND rich-edits the body in one atomic call', async () => {
    const cap: Capture = { acks: [], edits: [] }
    await finalizeCallback(mkCtx(cap), {
      ackText: 'Approved',
      newText: '**✓ Approved**\n\nGrant minted at 22:38 UTC',
    })
    expect(cap.edits).toHaveLength(1)
    // Default (non-literal) path wraps the body in the rich-message
    // { markdown } object — raw GFM markdown, no parse_mode (#2669).
    expect(cap.edits[0]?.text).toEqual({ markdown: '**✓ Approved**\n\nGrant minted at 22:38 UTC' })
    expect(cap.edits[0]?.opts.reply_markup).toEqual({ inline_keyboard: [] })
    expect(cap.edits[0]?.opts.parse_mode).toBeUndefined()
    // link_preview_options disabled by default — keeps the edited
    // status line from rendering a stale preview card.
    expect(cap.edits[0]?.opts.link_preview_options).toEqual({ is_disabled: true })
  })

  it('invariant 2: literalText edits a plain string (no rich wrapper, no parse_mode)', async () => {
    const cap: Capture = { acks: [], edits: [] }
    await finalizeCallback(mkCtx(cap), { ackText: 'ok', newText: 'plain', literalText: true })
    expect(cap.edits[0]?.text).toBe('plain')
    expect(cap.edits[0]?.opts.parse_mode).toBeUndefined()
  })

  it('invariant 3: synthInbound fires AFTER editMessageText resolves', async () => {
    const order: string[] = []
    const ctx: FinalizeCallbackContext = {
      answerCallbackQuery: async () => { order.push('ack'); return true },
      editMessageText: async () => {
        order.push('edit-start')
        await new Promise((r) => setTimeout(r, 5))
        order.push('edit-end')
        return { message_id: 1 }
      },
    }
    await finalizeCallback(ctx, {
      ackText: 'ok',
      newText: '...',
      synthInbound: () => { order.push('synth') },
    })
    // ack is fire-and-forget so its position is "no later than edit-start"
    // but we don't pin its exact position. Pin that synth comes AFTER
    // edit-end — that's the guarantee callers need.
    const editEndIdx = order.indexOf('edit-end')
    const synthIdx = order.indexOf('synth')
    expect(editEndIdx).toBeGreaterThanOrEqual(0)
    expect(synthIdx).toBeGreaterThan(editEndIdx)
  })

  it('invariant 3: async synthInbound is awaited', async () => {
    let synthResolved = false
    const cap: Capture = { acks: [], edits: [] }
    await finalizeCallback(mkCtx(cap), {
      ackText: 'ok',
      newText: '...',
      synthInbound: async () => {
        await new Promise((r) => setTimeout(r, 5))
        synthResolved = true
      },
    })
    expect(synthResolved).toBe(true)
  })

  it('invariant 3: synthInbound errors are caught + logged, never propagated', async () => {
    const logs: string[] = []
    const cap: Capture = { acks: [], edits: [] }
    await expect(
      finalizeCallback(mkCtx(cap), {
        ackText: 'ok',
        newText: '...',
        synthInbound: () => { throw new Error('inject_inbound IPC closed') },
        log: (l) => logs.push(l),
      }),
    ).resolves.toBeUndefined()
    expect(logs.some((l) => l.includes('inject_inbound IPC closed'))).toBe(true)
  })

  it('robustness: editMessageText failure does NOT block synthInbound', async () => {
    // Operator deleted the card between tap and our edit — Telegram
    // returns MESSAGE_TO_EDIT_NOT_FOUND. The model still needs to wake
    // up: a stale/missing card is preferred to a stuck conversation.
    const logs: string[] = []
    let synthFired = false
    const cap: Capture = {
      acks: [],
      edits: [],
      editThrows: new Error('Bad Request: message to edit not found'),
    }
    await finalizeCallback(mkCtx(cap), {
      ackText: 'Approved',
      newText: '...',
      synthInbound: () => { synthFired = true },
      log: (l) => logs.push(l),
    })
    expect(synthFired).toBe(true)
    expect(logs.some((l) => l.includes('message to edit not found'))).toBe(true)
  })

  it('robustness: answerCallbackQuery failure does NOT block edit or synth', async () => {
    // Telegram rejects the ack (e.g. the callback_query is already
    // older than the 60s timeout). The edit + synth still must proceed.
    const logs: string[] = []
    let synthFired = false
    const cap: Capture = {
      acks: [],
      edits: [],
      ackThrows: new Error('query is too old'),
    }
    await finalizeCallback(mkCtx(cap), {
      ackText: 'Approved',
      newText: 'edited body',
      synthInbound: () => { synthFired = true },
      log: (l) => logs.push(l),
    })
    expect(cap.edits).toHaveLength(1)
    expect(cap.edits[0]?.text).toEqual({ markdown: 'edited body' })
    expect(synthFired).toBe(true)
    // ack fire-and-forget — its catch fires asynchronously; give it a tick
    // so the log assertion is stable across runs.
    await new Promise((r) => setTimeout(r, 0))
    expect(logs.some((l) => l.includes('query is too old'))).toBe(true)
  })

  it('synthInbound is optional — surfaces with no model in the loop just ack + edit', async () => {
    const cap: Capture = { acks: [], edits: [] }
    await finalizeCallback(mkCtx(cap), {
      ackText: 'Dismissed',
      newText: '✗ Dismissed',
    })
    expect(cap.acks).toHaveLength(1)
    expect(cap.edits).toHaveLength(1)
  })
})
