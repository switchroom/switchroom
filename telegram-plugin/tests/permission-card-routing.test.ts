/**
 * Structural pin for permission-card topic routing.
 *
 * The bug (marko, 2026-06-03): the INITIAL Approve/Deny card emitter
 * (`onPermissionRequest`) iterated `access.allowFrom` unconditionally as its
 * recipient set. For a supergroup-owned agent, `allowFrom` holds only the
 * operator DM user-ids — the supergroup chat id is never in it — so a
 * permission card raised from a forum topic could ONLY ever land in the
 * operator's DM, never in the topic the operator asked from. The
 * post-verdict resume message already routed correctly (to the turn's
 * originating chat+thread); the card did not.
 *
 * The fix routes BOTH the card and the resume through one shared helper,
 * `resolvePermissionCardTargets()`, so they can't drift: turn-initiated →
 * the originating chat+topic; no active turn → operator DMs, thread-stripped
 * via topicForRecipient (the DM-thread 400 / auto-deny guard, #2096).
 *
 * gateway.ts is not unit-importable (top-level side effects), so this is a
 * source-text pin in the same style as permission-verdict-resume-guard.ts.
 * The routing *logic* (topicForRecipient / resolveAgentOutboundTopic) is
 * unit-tested in src/telegram/topic-router.test.ts; the end-to-end
 * "card lands in the topic" is covered by the supergroup UAT. This guards
 * the wiring: that the card uses the shared helper and never reverts to the
 * raw allowFrom fan-out.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GATEWAY_SRC = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf8',
)

/** Slice the body of the `onPermissionRequest` IPC handler — from its header
 *  to the next handler method (`onHeartbeat`). */
function onPermissionRequestBody(): string {
  const start = GATEWAY_SRC.indexOf('onPermissionRequest(')
  expect(start).toBeGreaterThan(-1)
  const rest = GATEWAY_SRC.slice(start)
  const end = rest.indexOf('onHeartbeat(')
  expect(end).toBeGreaterThan(-1)
  return rest.slice(0, end)
}

describe('permission card routing', () => {
  it('the shared target helper exists', () => {
    expect(
      /function\s+resolvePermissionCardTargets\s*\(/.test(GATEWAY_SRC),
    ).toBe(true)
  })

  it('the initial card emitter routes via resolvePermissionCardTargets()', () => {
    expect(onPermissionRequestBody()).toContain('resolvePermissionCardTargets()')
  })

  it('the initial card emitter no longer iterates access.allowFrom directly (the bug shape)', () => {
    // The raw fan-out loop is what sent supergroup cards to operator DMs.
    expect(onPermissionRequestBody()).not.toMatch(
      /for\s*\(\s*const\s+chat_id\s+of\s+access\.allowFrom\s*\)/,
    )
  })

  it('the card send is wrapped in retryWithThreadFallback (stale-topic → thread-less, not a silent drop)', () => {
    expect(onPermissionRequestBody()).toContain('retryWithThreadFallback')
  })

  it('the resume message uses the SAME helper, so card + resume cannot drift', () => {
    const start = GATEWAY_SRC.indexOf('function postPermissionResumeMessage(')
    expect(start).toBeGreaterThan(-1)
    const body = GATEWAY_SRC.slice(start, start + 1400)
    expect(body).toContain('resolvePermissionCardTargets()')
  })
})
