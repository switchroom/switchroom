/**
 * Source-text pins for the missed-approvals re-offer wiring (#2862).
 *
 * gateway.ts has top-level side effects and isn't unit-importable; the store
 * and card logic are unit-tested in missed-approvals-store.test.ts /
 * missed-approvals-card.test.ts. These pins lock the gateway wiring so it can't
 * silently regress:
 *   - the store is constructed + kill switch defined;
 *   - the TTL auto-deny appends the miss (anchored to the card origin);
 *   - all three operator-activity paths trigger the digest;
 *   - the digest posts ONE card per surface then promotes (clears pending);
 *   - the callback dispatcher routes `missre:`;
 *   - retry rides deliverResumeSyntheticOrBuffer; dismiss removes + edits.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8')
const GATEWAY = read('gateway/gateway.ts')

function slice(src: string, header: string, span = 2000): string {
  const start = src.indexOf(header)
  expect(start, `expected to find ${header}`).toBeGreaterThan(-1)
  return src.slice(start, start + span)
}

describe('missed-approvals re-offer wiring (#2862)', () => {
  it('constructs the persisted store and defines the kill switch', () => {
    expect(GATEWAY).toContain('createMissedApprovalsStore(STATE_DIR)')
    expect(GATEWAY).toContain('SWITCHROOM_MISSED_APPROVAL_REOFFER')
    expect(GATEWAY).toMatch(/MISSED_APPROVAL_REOFFER_ENABLED\s*=\s*\n?\s*process\.env\.SWITCHROOM_MISSED_APPROVAL_REOFFER !== '0'/)
  })

  it('appends the miss at TTL auto-deny, anchored to the card origin, gated by the kill switch', () => {
    // Within the pending-permission TTL sweep block.
    const sweep = slice(GATEWAY, 'for (const [k, v] of pendingPermissions)', 3600)
    expect(sweep).toContain('if (MISSED_APPROVAL_REOFFER_ENABLED) {')
    expect(sweep).toContain('missedApprovalsStore.add({')
    expect(sweep).toContain('const origin = v.cards[0]')
    expect(sweep).toContain('action: naturalAction(v.tool_name, v.input_preview)')
  })

  it('all three operator-activity paths trigger the digest', () => {
    const calls = GATEWAY.match(/maybePostMissedApprovalDigest\(/g) ?? []
    // 1 definition + 3 activity callsites.
    expect(calls.length).toBeGreaterThanOrEqual(4)
    expect(GATEWAY).toContain("maybePostMissedApprovalDigest('operator inbound')")
    expect(GATEWAY).toContain("maybePostMissedApprovalDigest('operator answered via /approve|/deny')")
    expect(GATEWAY).toContain("maybePostMissedApprovalDigest('operator answered a permission card')")
  })

  it('the digest posts one card per surface, then promotes (clears pending → posts once)', () => {
    const fn = slice(GATEWAY, 'function maybePostMissedApprovalDigest(', 2400)
    expect(fn).toContain('if (!MISSED_APPROVAL_REOFFER_ENABLED) return')
    expect(fn).toContain('missedApprovalsStore.listPending()')
    // Groups by origin surface.
    expect(fn).toMatch(/const groups = new Map/)
    expect(fn).toContain('missedApprovalsKeyboard(digestId)')
    expect(fn).toContain('missedApprovalsStore.promoteToDigest({')
  })

  it('routes the missre: callback family', () => {
    expect(GATEWAY).toContain("data.startsWith('missre:')")
    expect(GATEWAY).toContain('handleMissedApprovalCallback(ctx, data)')
  })

  it('retry injects a synthetic inbound via the shared resume-or-buffer path', () => {
    const fn = slice(GATEWAY, 'async function handleMissedApprovalCallback(', 2600)
    // authorization gate first.
    expect(fn).toContain('access.allowFrom.includes(senderId)')
    // retry synthesizes + delivers via the cron/synthetic inbound primitive.
    expect(fn).toContain('buildMissedApprovalRetryInbound({')
    expect(fn).toContain('deliverResumeSyntheticOrBuffer(agent, synthetic)')
    // dismiss clears the record + edits the card closed.
    expect(fn).toContain('missedApprovalsStore.removeDigest(parsed.digestId)')
    expect(fn).toContain('Dismissed')
  })

  it('never synthesizes a verdict on retry (no-self-escalation)', () => {
    const fn = slice(GATEWAY, 'async function handleMissedApprovalCallback(', 2600)
    // The handler must not dispatch a permission verdict — retry is a question.
    expect(fn).not.toContain('dispatchPermissionVerdict')
    expect(fn).not.toContain("behavior: 'allow'")
  })
})
