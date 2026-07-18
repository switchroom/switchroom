import { describe, it, expect } from 'vitest'
import {
  renderSecretRequestCard,
  buildSecretRequestKeyboard,
} from './secret-request-card.js'

describe('secret-request-card (#2996 P5 extraction — verbatim from gateway.ts)', () => {
  describe('renderSecretRequestCard', () => {
    it('renders the title, key, reason, and the provide-securely instruction', () => {
      const out = renderSecretRequestCard({
        agent: 'worker',
        key: 'openai/api_key',
        reason: 'need it to call the API',
      })
      expect(out).toContain('🔒 **worker** needs a secret:')
      expect(out).toContain('`openai/api_key`')
      expect(out).toContain('_need it to call the API_')
      expect(out).toContain('Tap **Provide securely**')
    })

    it('omits the reason line when none is given', () => {
      const out = renderSecretRequestCard({ agent: 'worker', key: 'openai/api_key' })
      // The reason line is the only `_…_` emphasis block; absent when no reason.
      expect(out).not.toMatch(/\n_.*_$/m)
    })

    it('does NOT harden card breaks (prose body, preserved from the inline version)', () => {
      // The inline renderer joined lines plainly (no hardenCardBreaks); this
      // pins that difference from the vault-save card so the move stays verbatim.
      const out = renderSecretRequestCard({ agent: 'worker', key: 'k/v' })
      expect(out.split('\n')[0]).toBe('🔒 **worker** needs a secret:')
    })
  })

  describe('buildSecretRequestKeyboard', () => {
    it('carries the vsp:* callback_data contract', () => {
      const kb = buildSecretRequestKeyboard('abcd1234')
      const flat = kb.inline_keyboard.flat()
      expect(flat.map((b) => b.callback_data)).toEqual([
        'vsp:provide:abcd1234',
        'vsp:decline:abcd1234',
      ])
      expect(flat.map((b) => b.text)).toEqual(['🔐 Provide securely', '🚫 Decline'])
    })
  })
})
