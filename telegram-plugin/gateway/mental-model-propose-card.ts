/**
 * Pure renderer for the agent-initiated mental-model PROPOSAL approval card
 * (hindsight Phase 5, stacked on #2874).
 *
 * Mirrors `vault-request-access-card.ts` exactly — same rich-message (GFM
 * markdown) escaping discipline:
 *   - Non-code-span interpolations (`**agent**`, `_reason_`, `_source_query_`)
 *     are markdown-escaped via `escapeHtmlForTg` so a stray `*`/`_`/`[` can't
 *     break the surrounding emphasis.
 *   - Code-span interpolations (`name`) are LITERAL inside the span, so they
 *     must NOT be markdown-escaped; only the backtick is defused via
 *     `codeSpanSafe`.
 *
 * The card asks the OPERATOR to approve turning a proposed model into a
 * first-class DECLARED model (`memory.mental_models[]`). The agent can only
 * PROPOSE — the [Approve]/[Deny] tap is operator-gated in the gateway, exactly
 * like the vault flow, so an agent can never self-approve.
 */

import { escapeHtmlForTg } from "../shared/bot-runtime.js";
import { codeSpanSafe } from "./approval-card.js";
import { hardenCardBreaks } from "../format.js";

/** Minimal shape the card needs — a subset of the pending proposal. */
export interface MentalModelProposeCardInput {
  agent: string;
  name: string;
  source_query: string;
  reason?: string;
  refresh_after_consolidation?: boolean;
}

export function renderMentalModelProposeCard(
  req: MentalModelProposeCardInput,
): string {
  const lines: string[] = [];
  lines.push(`🧠 **${escapeHtmlForTg(req.agent)}** proposes a mental model`);
  // Code-span content is literal — defuse only the backtick, never
  // markdown-escape (see file header).
  lines.push(`name: \`${codeSpanSafe(req.name)}\``);
  lines.push(`source query: _${escapeHtmlForTg(req.source_query)}_`);
  const refreshLabel = req.refresh_after_consolidation ? "on" : "off";
  lines.push(`refresh after consolidation: \`${codeSpanSafe(refreshLabel)}\``);
  // Always render the why-line, even when omitted — a missing rationale is
  // then visibly an agent-side failure, not a card-template choice (mirrors
  // the vault card's #1790 behaviour).
  if (req.reason && req.reason.length > 0) {
    lines.push(`why: _${escapeHtmlForTg(req.reason)}_`);
  } else {
    lines.push(`why: _not provided_`);
  }
  lines.push("");
  lines.push(
    `_Tap Approve to DECLARE this model — it is appended to ${escapeHtmlForTg(req.agent)}'s ` +
      `\`memory.mental_models[]\` (operator-approved config edit) and ensured in the bank. ` +
      `Tap Deny to drop it — nothing is written._`,
  );
  // hardenCardBreaks: the labelled field lines would soft-collapse into one
  // blob under the GFM rich renderer; this card is sent direct via
  // richMessage, bypassing the switchroomReply chokepoint.
  return hardenCardBreaks(lines.join("\n"));
}
