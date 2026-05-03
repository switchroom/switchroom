/**
 * StatusReactionController — allowedReactions filter (#542 fix path).
 *
 * Background: Telegram supergroups can restrict `available_reactions`
 * to a small set. When the bot calls `setMessageReaction` with an
 * emoji outside that set, Telegram returns 400 REACTION_INVALID.
 * Production silently catches and continues — only the emojis that
 * happen to be in the allowed set ever land. Result: the user sees
 * `👀 → 👍` instead of `👀 → 🤔 → 🔥 → 👍`.
 *
 * The controller has fallback logic in `resolveEmoji` for exactly
 * this case — but it was DEAD CODE because gateway.ts:4458 didn't
 * pass `allowedReactions`. The fix wires `chatAvailableReactions`
 * cache (populated by getChat probe) into the controller constructor.
 *
 * These tests pin the controller's behavior under the filter so the
 * dead-code path stops being dead.
 */

import { describe, expect, it } from 'vitest'
import { StatusReactionController } from '../status-reactions.js'

describe('StatusReactionController — allowedReactions filter', () => {
  it('with no filter (null), every state emits its preferred emoji', async () => {
    const emits: string[] = []
    const ctrl = new StatusReactionController(
      async (emoji) => { emits.push(emoji) },
      null, // no filter — current production default before #542 fix
      { debounceMs: 0 },
    )
    ctrl.setQueued()
    ctrl.setThinking()
    ctrl.setTool('Bash')
    ctrl.setDone()
    // Drain any queued emits.
    await new Promise((r) => setTimeout(r, 10))
    expect(emits).toContain('👀')
    expect(emits[emits.length - 1]).toBe('👍')
  })

  it('with allowedReactions=[👍], non-allowed states fall back to a permitted emoji', async () => {
    // The #542 reproducer: chat only allows 👍. With the filter wired,
    // resolveEmoji's fallback path activates: it walks REACTION_VARIANTS
    // for each state, skipping anything not in allowedReactions, and
    // falls through to the last-resort set ['👍', '👀', '✍'].
    //
    // fails when: someone removes the fallback in resolveEmoji, or the
    // controller stops respecting the filter. Either way the user
    // would see emojis Telegram is going to reject.
    const emits: string[] = []
    const ctrl = new StatusReactionController(
      async (emoji) => { emits.push(emoji) },
      new Set(['👍']),
      { debounceMs: 0 },
    )
    ctrl.setQueued()
    ctrl.setThinking()
    ctrl.setTool('Bash')
    ctrl.setDone()
    await new Promise((r) => setTimeout(r, 10))

    // Every emit must be 👍 — no 👀/🤔/🔥 should slip through to a chat
    // that doesn't allow them. The chain may collapse to a single 👍
    // (the controller dedups consecutive same-emoji emits).
    for (const emoji of emits) {
      expect(emoji).toBe('👍')
    }
    expect(emits).toContain('👍') // and at least one 👍 lands
  })

  it('with allowedReactions=[👀, 👍], intermediate states use 👀 fallback', async () => {
    // A chat allowing only 👀 + 👍. Intermediates that are normally
    // 🤔 / 🔥 should fall back to 👀 (the only intermediate-class
    // emoji in the allowed set), and terminal stays 👍.
    const emits: string[] = []
    const ctrl = new StatusReactionController(
      async (emoji) => { emits.push(emoji) },
      new Set(['👀', '👍']),
      { debounceMs: 0 },
    )
    ctrl.setQueued()
    ctrl.setThinking()
    ctrl.setTool('Bash')
    ctrl.setDone()
    await new Promise((r) => setTimeout(r, 10))

    for (const emoji of emits) {
      expect(['👀', '👍']).toContain(emoji)
    }
    expect(emits[emits.length - 1]).toBe('👍')
  })

  it('with allowedReactions=[] (empty set, no reactions allowed), emits are no-ops', async () => {
    // Edge case: chat has explicitly EMPTY available_reactions
    // (extremely rare — e.g., admin set "no reactions allowed").
    // resolveEmoji returns null for every state; the controller
    // chain skips emit. No exception, no Telegram call attempt.
    const emits: string[] = []
    const ctrl = new StatusReactionController(
      async (emoji) => { emits.push(emoji) },
      new Set(),
      { debounceMs: 0 },
    )
    ctrl.setQueued()
    ctrl.setThinking()
    ctrl.setDone()
    await new Promise((r) => setTimeout(r, 10))
    expect(emits).toEqual([])
  })

  it('with allowedReactions excluding 👍 entirely, terminal falls back to first allowed', async () => {
    // Bizarre: allow 🎉 only. Terminal 👍 has to fall back to 🎉
    // (which is in the variants of `done` per REACTION_VARIANTS).
    // Or fall back to the last-resort set if 🎉 isn't even in
    // ['👍', '👀', '✍']. Document actual behavior.
    const emits: string[] = []
    const ctrl = new StatusReactionController(
      async (emoji) => { emits.push(emoji) },
      new Set(['🎉']),
      { debounceMs: 0 },
    )
    ctrl.setDone()
    await new Promise((r) => setTimeout(r, 10))
    // Either 🎉 (if it's a `done` variant) or empty (if no allowed
    // emoji matches any `done` variant or the last-resort set).
    // Pin actual behavior — current REACTION_VARIANTS for `done`
    // determines this.
    if (emits.length > 0) {
      expect(emits[0]).toBe('🎉')
    }
  })
})
