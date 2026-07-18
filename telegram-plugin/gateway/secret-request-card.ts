/**
 * Pure renderer + inline-keyboard builder for the agent-initiated
 * `request_secret` card (#2045 — the agent does NOT have a value and asks the
 * operator to PROVIDE one securely). Callback prefix `vsp:`
 * (vault-secret-provide), handled by handleSecretRequestCallback in
 * callback-query-handlers.ts.
 *
 * Extracted verbatim from gateway.ts (#2996 P5); the render body is unchanged.
 * Unlike the vault-save card this renderer does NOT call hardenCardBreaks — the
 * body is a short prose block, not labelled field lines — so the move preserves
 * that difference exactly.
 */

import { escapeHtmlForTg } from '../shared/bot-runtime.js'

/** Minimal shape the card needs — a subset of PendingSecretRequest. */
export interface SecretRequestCardInput {
  agent: string
  key: string
  reason?: string
}

export function renderSecretRequestCard(req: SecretRequestCardInput): string {
  const lines: string[] = [
    `🔒 **${escapeHtmlForTg(req.agent)}** needs a secret:`,
    `\`${req.key}\``,
  ]
  if (req.reason) lines.push(`_${escapeHtmlForTg(req.reason)}_`)
  lines.push(
    '',
    'Tap **Provide securely**, then send the value as your next message. I’ll delete it instantly and store it in the vault — it is never shown in chat or to the agent.',
  )
  return lines.join('\n')
}

export function buildSecretRequestKeyboard(stageId: string): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return {
    inline_keyboard: [
      [
        { text: '🔐 Provide securely', callback_data: `vsp:provide:${stageId}` },
        { text: '🚫 Decline', callback_data: `vsp:decline:${stageId}` },
      ],
    ],
  }
}
