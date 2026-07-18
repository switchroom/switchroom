import { describe, it, expect } from 'vitest'
import {
  renderVaultRequestSaveCard,
  buildVaultRequestSaveKeyboard,
} from './vault-request-save-card.js'

describe('vault-request-save-card (#2996 P5 extraction — verbatim from gateway.ts)', () => {
  describe('renderVaultRequestSaveCard', () => {
    it('renders the title, key field, why line, and footer', () => {
      const out = renderVaultRequestSaveCard(
        { key: 'openai/api_key', why: 'to call the API' },
        'worker',
      )
      expect(out).toContain('🔐 **worker** wants to save a secret')
      expect(out).toContain('key: `openai/api_key`')
      expect(out).toContain('why: _to call the API_')
      expect(out).toContain('Tap Save to write to the host vault')
    })

    it('omits the why line when no rationale is given', () => {
      const out = renderVaultRequestSaveCard({ key: 'openai/api_key' }, 'worker')
      expect(out).not.toContain('why:')
    })

    it('markdown-escapes the why text (not the code-span key)', () => {
      const out = renderVaultRequestSaveCard(
        { key: 'a/b_c', why: 'has_underscore' },
        'worker',
      )
      // escapeHtmlForTg backslash-escapes emphasis chars in the why line…
      expect(out).toContain('why: _has\\_underscore_')
      // …but the key rides in a code span verbatim (literal underscore kept).
      expect(out).toContain('key: `a/b_c`')
    })
  })

  describe('buildVaultRequestSaveKeyboard', () => {
    it('carries the vrs:* callback_data contract', () => {
      const kb = buildVaultRequestSaveKeyboard('abcd1234')
      const flat = kb.inline_keyboard.flat()
      expect(flat.map((b) => b.callback_data)).toEqual([
        'vrs:save:abcd1234',
        'vrs:discard:abcd1234',
        'vrs:rename:abcd1234',
      ])
      expect(flat.map((b) => b.text)).toEqual(['✅ Save once', '🚫 Discard', '✏️ Rename'])
    })
  })
})
