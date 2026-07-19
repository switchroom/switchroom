/**
 * Adversarial-review F4 — `/usage` account-label masking policy.
 *
 * A group with an empty `allowFrom` authorizes every member, so the quota
 * card would leak per-account email labels to a broadly shared group unless
 * masked. `shouldMaskUsageLabels` (gateway/usage-mask.ts) is the pure
 * decision the gateway feeds into the existing demo-mask machinery.
 */

import { describe, it, expect } from 'vitest'
import { shouldMaskUsageLabels } from '../gateway/usage-mask.js'

describe('shouldMaskUsageLabels (F4)', () => {
  it('never masks in a private (operator DM) chat', () => {
    expect(shouldMaskUsageLabels('private', undefined)).toBe(false)
    expect(shouldMaskUsageLabels('private', [])).toBe(false)
    expect(shouldMaskUsageLabels('private', ['123'])).toBe(false)
  })

  it('masks in a group with an EMPTY allowFrom (open membership)', () => {
    expect(shouldMaskUsageLabels('group', [])).toBe(true)
    expect(shouldMaskUsageLabels('group', undefined)).toBe(true)
    expect(shouldMaskUsageLabels('supergroup', [])).toBe(true)
  })

  it('does NOT mask in a group with a curated non-empty allowFrom', () => {
    expect(shouldMaskUsageLabels('group', ['123'])).toBe(false)
    expect(shouldMaskUsageLabels('supergroup', ['123', '456'])).toBe(false)
  })

  it('masks defensively for any other chat type reaching a quota render', () => {
    expect(shouldMaskUsageLabels('channel', undefined)).toBe(true)
    expect(shouldMaskUsageLabels(undefined, undefined)).toBe(true)
  })
})
