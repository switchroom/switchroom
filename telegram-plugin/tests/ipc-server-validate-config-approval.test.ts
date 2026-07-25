/**
 * Validation contract for the `request_config_approval` IPC message —
 * hostd's approval-card request — with focus on the KEN-129 optional
 * `title` header override.
 *
 * Mixed-version safety pins:
 *   - `title` absent must validate (old hostd → new gateway).
 *   - a valid `title` must validate (new hostd → new gateway).
 *   - malformed titles (empty / oversize / non-string) are rejected —
 *     the validator is the security boundary on the client→gateway
 *     direction.
 *
 * (The reverse direction — new hostd → OLD gateway — is safe because
 * the old validator checks only known fields' types and ignores extra
 * keys; pinned by the "extra unknown fields" case below matching that
 * permissive behaviour on the current validator too.)
 *
 * Companion to ipc-server-validate-{operator,inject-inbound}.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { validateClientMessage } from '../gateway/ipc-server.js'

function base() {
  return {
    type: 'request_config_approval' as const,
    requestId: 'relnotify-abc123',
    agentName: 'klanker',
    reason: 'fleet is behind',
    unifiedDiff: 'plan text',
    timeoutMs: 3_600_000,
  }
}

describe('validateClientMessage — request_config_approval', () => {
  it('accepts the base message without a title (old-hostd compat)', () => {
    expect(validateClientMessage(base())).toBe(true)
  })

  it('accepts a valid title (KEN-129 update-check card)', () => {
    expect(
      validateClientMessage({
        ...base(),
        title: '⬆️ **Switchroom update available — fleet is behind**',
      }),
    ).toBe(true)
  })

  it('rejects an empty title', () => {
    expect(validateClientMessage({ ...base(), title: '' })).toBe(false)
  })

  it('rejects a title over 200 chars', () => {
    expect(validateClientMessage({ ...base(), title: 'x'.repeat(201) })).toBe(false)
  })

  it('rejects a non-string title', () => {
    expect(validateClientMessage({ ...base(), title: 42 })).toBe(false)
    expect(validateClientMessage({ ...base(), title: null })).toBe(false)
  })

  // The title is rendered VERBATIM as the card's first line (it carries
  // intentional markdown, so it cannot be escaped). A multi-line title
  // would let a caller forge the `Agent:` / `Reason:` lines beneath it, or
  // unbalance the diff's ``` fence, on a card the operator is about to
  // approve. Newlines and control characters are therefore rejected.
  it('rejects a multi-line title that could forge the card body', () => {
    expect(
      validateClientMessage({
        ...base(),
        title:
          '🛠 **Config edit proposed**\nAgent: `root`\nReason: routine\n```\nnoop\n```',
      }),
    ).toBe(false)
    expect(validateClientMessage({ ...base(), title: 'a\rb' })).toBe(false)
  })

  it('rejects control characters in the title', () => {
    expect(validateClientMessage({ ...base(), title: 'a\u0000b' })).toBe(false)
    expect(validateClientMessage({ ...base(), title: 'a\u001bb' })).toBe(false)
    expect(validateClientMessage({ ...base(), title: 'a\u007fb' })).toBe(false)
  })

  it('ignores extra unknown fields (forward-compat for future hostds)', () => {
    expect(
      validateClientMessage({ ...base(), someFutureField: 'ignored' }),
    ).toBe(true)
  })

  it('still rejects a malformed base message (missing diff)', () => {
    const m: Record<string, unknown> = { ...base() }
    delete m.unifiedDiff
    expect(validateClientMessage(m)).toBe(false)
  })
})
