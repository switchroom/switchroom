/**
 * Pure renderer + inline-keyboard builder for the agent-initiated vault-SAVE
 * approval card (#969 P1a — the agent HAS a value and asks the operator to
 * confirm writing it to the host vault). Callback prefix `vrs:`
 * (vault-request-save), handled by handleVaultRequestSaveCallback in
 * callback-query-handlers.ts.
 *
 * Extracted verbatim from gateway.ts (#2996 P5); the render body is unchanged.
 * The card is sent via the rich-message (GFM markdown) path, so field lines are
 * hardened against soft-collapse via hardenCardBreaks (see renderer footer).
 *
 * Buttons must fit Telegram's 64-byte callback_data limit. Stage IDs are 8 hex
 * chars (32 bits), so each callback comfortably fits.
 */

import { escapeHtmlForTg } from '../shared/bot-runtime.js'
import { hardenCardBreaks } from '../format.js'

/** Minimal shape the card needs — a subset of PendingVaultRequestSave. */
export interface VaultRequestSaveCardInput {
  key: string
  why?: string
}

export function renderVaultRequestSaveCard(req: VaultRequestSaveCardInput, agentSlug: string): string {
  const lines: string[] = []
  lines.push(`🔐 **${escapeHtmlForTg(agentSlug)}** wants to save a secret`)
  lines.push(`key: \`${req.key}\``)
  if (req.why && req.why.length > 0) {
    lines.push(`why: _${escapeHtmlForTg(req.why)}_`)
  }
  lines.push('')
  lines.push(`_Tap Save to write to the host vault, Rename to change the key name, or Discard to drop it. The value is held in this chat's gateway memory until you decide._`)
  // hardenCardBreaks: labelled field lines (key: / why:) would soft-collapse
  // into one blob under the GFM rich renderer; this card is sent direct via
  // richMessage, bypassing the switchroomReply chokepoint.
  return hardenCardBreaks(lines.join('\n'))
}

export function buildVaultRequestSaveKeyboard(stageId: string): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return {
    inline_keyboard: [
      [
        { text: '✅ Save once', callback_data: `vrs:save:${stageId}` },
        { text: '🚫 Discard', callback_data: `vrs:discard:${stageId}` },
      ],
      [
        { text: '✏️ Rename', callback_data: `vrs:rename:${stageId}` },
      ],
    ],
  }
}
