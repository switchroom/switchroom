import { describe, it, expect } from 'vitest'
import { buildVaultRequestAccessKeyboard } from './vault-request-access-card.js'
import { buildMentalModelProposeKeyboard } from './mental-model-propose-card.js'

// The approve/deny keyboards for the vault-access (vra:) and mental-model
// proposal (mmp:) cards moved out of gateway.ts in #2996 P5. Their callback_data
// prefixes are the contract the callback dispatch table in gateway.ts + the
// handlers in callback-query-handlers.ts route on — pin them so a rename here
// can't silently break the tap routing.
describe('approval-card keyboards (#2996 P5 extraction)', () => {
  it('buildVaultRequestAccessKeyboard carries the vra:* contract', () => {
    const flat = buildVaultRequestAccessKeyboard('abcd1234').inline_keyboard.flat()
    expect(flat.map((b) => b.callback_data)).toEqual([
      'vra:approve:abcd1234',
      'vra:deny:abcd1234',
    ])
    expect(flat.map((b) => b.text)).toEqual(['✅ Approve', '🚫 Deny'])
  })

  it('buildMentalModelProposeKeyboard carries the mmp:* contract', () => {
    const flat = buildMentalModelProposeKeyboard('abcd1234').inline_keyboard.flat()
    expect(flat.map((b) => b.callback_data)).toEqual([
      'mmp:approve:abcd1234',
      'mmp:deny:abcd1234',
    ])
    expect(flat.map((b) => b.text)).toEqual(['✅ Approve', '🚫 Deny'])
  })
})
