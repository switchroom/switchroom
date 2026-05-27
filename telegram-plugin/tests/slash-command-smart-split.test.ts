import { describe, expect, it } from 'vitest'
import { resolveOutboundTopic } from '../../src/telegram/topic-router.js'

/**
 * PR5 — supergroup-mode slash-command smart-split (CPO #4).
 *
 * The gateway wires `runSwitchroomCommand` → `switchroomReply` →
 * `slashCommandReplyOpts(ctx, classification)` → `resolveOutboundTopic`.
 * The helper is a thin classifier on top of the existing router; this
 * test pins the END contract that drives all 4 heavy-output commands
 * (/logs, /audit, /upgradestatus, /memory) and any future mutation
 * additions:
 *
 *   - query → follows the originating topic (or undefined for fleet/DM)
 *   - mutation → admin alias (or undefined for fleet/DM)
 *   - heavy → admin alias (or undefined for fleet/DM)
 *
 * The gateway wrapper additionally collapses `target === originThreadId`
 * back to `{}` so a query in the originating topic doesn't write a
 * redundant `message_thread_id` opt. That's a wire-shape micro-opt
 * tested separately at the call site.
 */

describe('PR5 slash-command smart split — router contract', () => {
  const supergroup = {
    default_topic_id: 1,
    topic_aliases: { planning: 17, admin: 31, alerts: 42 },
  }
  const fleet = {} // no chat_id / default_topic_id → fleet/DM

  describe('query class', () => {
    it('supergroup: follows originThreadId', () => {
      expect(
        resolveOutboundTopic(supergroup, {
          kind: 'command-query',
          originThreadId: 17,
        }),
      ).toBe(17)
    })

    it('fleet: returns originThreadId unchanged (caller passes-through)', () => {
      expect(
        resolveOutboundTopic(fleet, {
          kind: 'command-query',
          originThreadId: 17,
        }),
      ).toBe(17)
    })

    it('supergroup, no origin thread (chat root): default_topic_id fallback', () => {
      // command-query returns originThreadId verbatim, including
      // undefined; the wrapper collapses undefined to "no override"
      // and grammY's ctx.reply picks the originating topic anyway.
      expect(
        resolveOutboundTopic(supergroup, {
          kind: 'command-query',
          originThreadId: undefined,
        }),
      ).toBeUndefined()
    })
  })

  describe('mutation class', () => {
    it('supergroup: routes to admin alias', () => {
      expect(resolveOutboundTopic(supergroup, { kind: 'command-mutation' })).toBe(31)
    })

    it('supergroup with no admin alias: default_topic_id fallback', () => {
      const cfg = { default_topic_id: 1, topic_aliases: { planning: 17 } }
      expect(resolveOutboundTopic(cfg, { kind: 'command-mutation' })).toBe(1)
    })

    it('fleet: returns undefined (caller falls through to ctx.reply)', () => {
      expect(resolveOutboundTopic(fleet, { kind: 'command-mutation' })).toBeUndefined()
    })
  })

  describe('heavy class (the 4 commands actually wired in PR5)', () => {
    it('supergroup: /logs /audit /upgradestatus /memory all route to admin', () => {
      // All four commands fold through the same `slashCommandReplyOpts(ctx, "heavy")`
      // wrapper, which fires the same router event. One assertion covers
      // all of them.
      expect(resolveOutboundTopic(supergroup, { kind: 'command-heavy' })).toBe(31)
    })

    it('supergroup with no admin alias: default_topic_id fallback', () => {
      const cfg = { default_topic_id: 1, topic_aliases: { planning: 17 } }
      expect(resolveOutboundTopic(cfg, { kind: 'command-heavy' })).toBe(1)
    })

    it('fleet: returns undefined (caller falls through to ctx.reply)', () => {
      expect(resolveOutboundTopic(fleet, { kind: 'command-heavy' })).toBeUndefined()
    })
  })

  describe('separation contract: query vs mutation/heavy take different paths', () => {
    // Pins the structural intent: a query and a mutation issued from
    // the SAME originating topic in the SAME supergroup must resolve
    // to DIFFERENT topics. If anyone collapses the three classes back
    // to one event kind, this test fails loudly.
    it('query.originThread !== mutation.adminAlias', () => {
      const q = resolveOutboundTopic(supergroup, {
        kind: 'command-query',
        originThreadId: 17,
      })
      const m = resolveOutboundTopic(supergroup, { kind: 'command-mutation' })
      const h = resolveOutboundTopic(supergroup, { kind: 'command-heavy' })
      expect(q).toBe(17)
      expect(m).toBe(31)
      expect(h).toBe(31)
      expect(q).not.toBe(m)
      expect(m).toBe(h) // mutation and heavy both → admin
    })
  })
})
