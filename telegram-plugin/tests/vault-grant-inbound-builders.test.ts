/**
 * Pin the InboundMessage shapes the gateway synthesizes when the
 * operator taps Approve / Deny on a `vault_request_access` card
 * (#1052 / #1150). A regression that drops a `meta.source` field, or
 * changes the source string, would silently break the agent's wake-
 * up — the bridge wouldn't recognize the source, the message would
 * render as a generic channel event, and the model wouldn't know it
 * was an approval response.
 *
 * These tests are the cheap regression guard. The wire shape is
 * load-bearing — downstream filters / dashboards / future replay
 * tooling may anchor on individual meta fields.
 */

import { describe, it, expect } from 'vitest'
import {
  buildVaultGrantApprovedInbound,
  buildVaultGrantApprovedCardText,
  buildVaultGrantDeniedInbound,
  buildVaultSaveCompletedInbound,
  buildVaultSaveFailedInbound,
  buildVaultSaveDiscardedInbound,
  type VaultGrantInboundContext,
  type VaultSaveInboundContext,
} from '../gateway/vault-grant-inbound-builders.js'
import { richMessage } from '../rich-send.js'

const FIXED_NOW = 1_700_000_000_000

const CTX_READ: VaultGrantInboundContext = {
  agent: 'gymbro',
  key: 'fatsecret/credentials',
  scope: 'read',
  chat_id: '12345',
  ttl_seconds: 30 * 86400,
}

const CTX_WRITE: VaultGrantInboundContext = {
  ...CTX_READ,
  key: 'analytics/api-token',
  scope: 'write',
  ttl_seconds: 7 * 86400,
}

describe('buildVaultGrantApprovedCardText — the [object Object] regression guard', () => {
  const BASE = {
    agentEscaped: 'gymbro',
    scope: 'read' as const,
    key: 'fatsecret/credentials',
    days: 30,
    grantId: 'vg_a1b2c3',
  }

  it('renders the full confirmation as ONE markdown string wrapped once — no [object Object]', () => {
    // This is the whole point of the helper: the card text is built as a
    // single string and passed to a single richMessage(...) call. The bug
    // (fixed here) was `"prefix " + richMessage("suffix")`, which coerces
    // the {markdown} object and prints "[object Object]".
    const text = buildVaultGrantApprovedCardText(BASE)
    const rich = richMessage(text)
    expect(rich.markdown).toBe(text)
    expect(rich.markdown).not.toContain('[object Object]')
    expect(rich.markdown).toContain('vg_a1b2c3') // grant id present
  })

  it('includes agent, scope, key, days, and the grant id', () => {
    const text = buildVaultGrantApprovedCardText(BASE)
    expect(text).toContain('**gymbro**')
    expect(text).toContain('read access')
    expect(text).toContain('`fatsecret/credentials`')
    expect(text).toContain('for 30d')
    expect(text).toContain('(grant `vg_a1b2c3`)')
  })

  it('appends the footer when provided, omits it otherwise', () => {
    const withFooter = buildVaultGrantApprovedCardText({
      ...BASE,
      footer: '\n_Approver verified by Telegram identity._',
    })
    expect(withFooter).toContain('_Approver verified by Telegram identity._')
    // still one clean string
    expect(withFooter).not.toContain('[object Object]')

    const noFooter = buildVaultGrantApprovedCardText(BASE)
    expect(noFooter.endsWith('(grant `vg_a1b2c3`)')).toBe(true)
  })

  it('DOCUMENTS the original bug: bare-string + richMessage() coerces to [object Object]', () => {
    // Demonstrates why the fix matters — if a future edit reintroduces the
    // "concatenate a string onto the richMessage object" pattern, the result
    // contains the literal "[object Object]". The helper above avoids it.
    const buggy = '✅ Granted access. ' + (richMessage('(grant `vg_x`)') as unknown as string)
    expect(buggy).toContain('[object Object]')
  })
})

describe('buildVaultGrantApprovedInbound', () => {
  it('emits the canonical envelope (type, chat_id, user, userId, ts, messageId)', () => {
    const msg = buildVaultGrantApprovedInbound({
      ctx: CTX_READ,
      grantId: 'vg_a1b2c3',
      stageId: 'stage-001',
      operatorId: '12345',
      nowMs: FIXED_NOW,
    })
    expect(msg.type).toBe('inbound')
    expect(msg.chatId).toBe('12345')
    expect(msg.user).toBe('vault-broker')
    expect(msg.userId).toBe(0)
    expect(msg.ts).toBe(FIXED_NOW)
    // messageId is synthetic — pin that it equals ts so the gateway
    // can produce a stable id under fake-clock tests without colliding
    // with real Telegram messageIds.
    expect(msg.messageId).toBe(FIXED_NOW)
  })

  it('pins meta.source = "vault_grant_approved" — load-bearing for the bridge', () => {
    const msg = buildVaultGrantApprovedInbound({
      ctx: CTX_READ,
      grantId: 'vg_x',
      stageId: 's',
      operatorId: '1',
    })
    expect(msg.meta?.source).toBe('vault_grant_approved')
  })

  it('carries all forensic fields in meta', () => {
    const msg = buildVaultGrantApprovedInbound({
      ctx: CTX_READ,
      grantId: 'vg_a1b2c3',
      stageId: 'stage-001',
      operatorId: '12345',
    })
    expect(msg.meta).toEqual({
      source: 'vault_grant_approved',
      agent: 'gymbro',
      key: 'fatsecret/credentials',
      scope: 'read',
      grant_id: 'vg_a1b2c3',
      stage_id: 'stage-001',
      operator_id: '12345',
    })
  })

  it('text names the key, scope, ttl-in-days, and grant id', () => {
    const msg = buildVaultGrantApprovedInbound({
      ctx: CTX_READ,
      grantId: 'vg_a1b2c3',
      stageId: 's',
      operatorId: '1',
    })
    expect(msg.text).toContain('approved')
    expect(msg.text).toContain('`fatsecret/credentials`')
    expect(msg.text).toContain('scope=read')
    expect(msg.text).toContain('30d')
    expect(msg.text).toContain('grant=vg_a1b2c3')
    // Instructional: tells the agent how to recover the value.
    expect(msg.text).toContain('switchroom vault get')
  })

  it('rounds ttl_seconds to days', () => {
    const ctx7d: VaultGrantInboundContext = { ...CTX_READ, ttl_seconds: 7 * 86400 }
    const msg = buildVaultGrantApprovedInbound({
      ctx: ctx7d,
      grantId: 'vg_x',
      stageId: 's',
      operatorId: '1',
    })
    expect(msg.text).toContain('7d')
  })

  it('honors write scope in text + meta', () => {
    const msg = buildVaultGrantApprovedInbound({
      ctx: CTX_WRITE,
      grantId: 'vg_x',
      stageId: 's',
      operatorId: '1',
    })
    expect(msg.text).toContain('scope=write')
    expect(msg.meta?.scope).toBe('write')
  })

  it('defaults nowMs to Date.now() when omitted', () => {
    const before = Date.now()
    const msg = buildVaultGrantApprovedInbound({
      ctx: CTX_READ,
      grantId: 'vg_x',
      stageId: 's',
      operatorId: '1',
    })
    const after = Date.now()
    expect(msg.ts).toBeGreaterThanOrEqual(before)
    expect(msg.ts).toBeLessThanOrEqual(after)
    expect(msg.messageId).toBe(msg.ts)
  })
})

describe('buildVaultGrantDeniedInbound', () => {
  it('pins meta.source = "vault_grant_denied" — the deny-side wake-up was added in #1156', () => {
    const msg = buildVaultGrantDeniedInbound({
      ctx: CTX_READ,
      stageId: 's',
      operatorId: '1',
    })
    expect(msg.meta?.source).toBe('vault_grant_denied')
  })

  it('omits grant_id (denial never mints a grant)', () => {
    const msg = buildVaultGrantDeniedInbound({
      ctx: CTX_READ,
      stageId: 'stage-001',
      operatorId: '12345',
    })
    expect(msg.meta).toEqual({
      source: 'vault_grant_denied',
      agent: 'gymbro',
      key: 'fatsecret/credentials',
      scope: 'read',
      stage_id: 'stage-001',
      operator_id: '12345',
    })
    expect((msg.meta as { grant_id?: string }).grant_id).toBeUndefined()
  })

  it('text steers toward a fallback path', () => {
    const msg = buildVaultGrantDeniedInbound({
      ctx: CTX_READ,
      stageId: 's',
      operatorId: '1',
    })
    expect(msg.text).toContain('denied')
    expect(msg.text).toContain('`fatsecret/credentials`')
    expect(msg.text).toContain('fallback')
    // The "DO NOT re-request" line is load-bearing UX — prevents the
    // model from spam-tapping a fresh request immediately after a
    // deny. Pin it.
    expect(msg.text).toMatch(/Do NOT re-request/)
  })

  it('shares envelope shape with the approve builder (type, user, chat)', () => {
    const denied = buildVaultGrantDeniedInbound({
      ctx: CTX_READ,
      stageId: 's',
      operatorId: '1',
      nowMs: FIXED_NOW,
    })
    expect(denied.type).toBe('inbound')
    expect(denied.user).toBe('vault-broker')
    expect(denied.userId).toBe(0)
    expect(denied.chatId).toBe('12345')
    expect(denied.ts).toBe(FIXED_NOW)
    expect(denied.messageId).toBe(FIXED_NOW)
  })
})

describe('approve vs deny shape invariants', () => {
  it('both emit type=inbound, user=vault-broker — bridge anchors on these', () => {
    const approve = buildVaultGrantApprovedInbound({
      ctx: CTX_READ, grantId: 'g', stageId: 's', operatorId: '1',
    })
    const deny = buildVaultGrantDeniedInbound({
      ctx: CTX_READ, stageId: 's', operatorId: '1',
    })
    for (const m of [approve, deny]) {
      expect(m.type).toBe('inbound')
      expect(m.user).toBe('vault-broker')
      expect(m.userId).toBe(0)
    }
  })

  it('source strings are disjoint — no shared substring that could route both to the same handler', () => {
    const approve = buildVaultGrantApprovedInbound({
      ctx: CTX_READ, grantId: 'g', stageId: 's', operatorId: '1',
    })
    const deny = buildVaultGrantDeniedInbound({
      ctx: CTX_READ, stageId: 's', operatorId: '1',
    })
    expect(approve.meta?.source).not.toBe(deny.meta?.source)
    // Defensive: a fuzzy match like `meta.source.includes('approve')`
    // shouldn't accidentally fire on the deny side. Pin the prefixes.
    expect(String(approve.meta?.source)).toMatch(/^vault_grant_approved$/)
    expect(String(deny.meta?.source)).toMatch(/^vault_grant_denied$/)
  })
})

// ── Supergroup topic routing (gap #2) ──────────────────────────────────────
//
// When the agent requested the credential from inside a forum topic, the
// grant/save-outcome inbound must carry that topic so the resumed turn's
// reply lands back in it — not General. The carrier is two-fold and BOTH
// halves are load-bearing:
//   - top-level `threadId` → the gateway's per-topic busy-key / deliver-
//     until-acked keying (markClaudeBusyForInbound reads it).
//   - `meta.message_thread_id` (stringified) → rendered into the
//     `<channel message_thread_id="…">` XML, which session-tail's
//     parseChannelMeta re-extracts to set currentTurn.sessionThreadId, which
//     the reply tool defaults to. Drop either and the reply mis-routes.
//
// DM / non-topic requests must leave BOTH absent (an empty-string or 0
// thread is a Telegram 400 "message thread not found").
describe('grant/save outcome topic routing', () => {
  const SAVE_CTX: VaultSaveInboundContext = {
    agent: 'marko',
    key: 'brevo/api-key',
    chat_id: '-1001234567890',
  }
  const THREAD = 4242

  const grantBuilders = [
    {
      name: 'approved',
      build: (ctx: VaultGrantInboundContext) =>
        buildVaultGrantApprovedInbound({ ctx, grantId: 'vg_x', stageId: 's', operatorId: '1' }),
    },
    {
      name: 'denied',
      build: (ctx: VaultGrantInboundContext) =>
        buildVaultGrantDeniedInbound({ ctx, stageId: 's', operatorId: '1' }),
    },
  ]
  const saveBuilders = [
    {
      name: 'save-completed',
      build: (ctx: VaultSaveInboundContext) =>
        buildVaultSaveCompletedInbound({ ctx, stageId: 's', operatorId: '1' }),
    },
    {
      name: 'save-failed',
      build: (ctx: VaultSaveInboundContext) =>
        buildVaultSaveFailedInbound({ ctx, stageId: 's', operatorId: '1', reason: 'disk full' }),
    },
    {
      name: 'save-discarded',
      build: (ctx: VaultSaveInboundContext) =>
        buildVaultSaveDiscardedInbound({ ctx, stageId: 's', operatorId: '1' }),
    },
  ]

  for (const { name, build } of grantBuilders) {
    it(`${name}: threadId set → top-level threadId + meta.message_thread_id (stringified)`, () => {
      const msg = build({ ...CTX_READ, threadId: THREAD })
      expect(msg.threadId).toBe(THREAD)
      expect(msg.meta?.message_thread_id).toBe(String(THREAD))
    })
    it(`${name}: threadId absent → both omitted (DM stays thread-less)`, () => {
      const msg = build(CTX_READ)
      expect(msg.threadId).toBeUndefined()
      expect(msg.meta?.message_thread_id).toBeUndefined()
    })
  }

  for (const { name, build } of saveBuilders) {
    it(`${name}: threadId set → top-level threadId + meta.message_thread_id (stringified)`, () => {
      const msg = build({ ...SAVE_CTX, threadId: THREAD })
      expect(msg.threadId).toBe(THREAD)
      expect(msg.meta?.message_thread_id).toBe(String(THREAD))
    })
    it(`${name}: threadId absent → both omitted (DM stays thread-less)`, () => {
      const msg = build(SAVE_CTX)
      expect(msg.threadId).toBeUndefined()
      expect(msg.meta?.message_thread_id).toBeUndefined()
    })
  }
})
